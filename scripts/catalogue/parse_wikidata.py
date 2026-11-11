"""Streaming parser for the Open Library wikidata dump.

Inputs:
    A gzipped OL wikidata dump file (``--input``). Format (verified
    against the 2026-11-02 snapshot): each line is three tab-separated
    fields, ``QID \t <JSON> \t last_modified``, where the JSON field is
    CSV-quoted -- wrapped in double quotes with inner quotes doubled.
    The parser takes the first field after the QID that starts with
    '"' or '{' and unwraps that quoting before ``json.loads``; plain
    unquoted JSON lines are also accepted.

Outputs (all under ``--data-dir`` unless ``--output`` says otherwise):
    * ``parquet/wikidata_authors.partNNNN.parquet`` -- 100,000-row chunks.
    * ``parquet/wikidata_authors.parquet`` -- final merged file
      (``--output``), built by streaming part row groups through one
      ``ParquetWriter`` (see ``parse_dump.finalize_parts``).
    * ``parquet/wikidata_authors.ckpt.json`` -- checkpoint
      ``{lines_done, rows_written, rejected, skipped}`` with the same
      resume semantics as ``parse_dump.py``.
    * ``out/rejected_wikidata.jsonl`` -- rejected lines, same shape as
      ``parse_dump.py``.
    * ``progress.log`` -- progress line every 200,000 lines:
      ``[<UTC ISO ts>] parse_wikidata lines=<n> rows_written=<n>
      rejected=<n> skipped=<n> rate=<lines/s>``.

Only entities carrying an Open Library author claim (Wikidata property
P648) are OL authors; entities without P648 are skipped (counted in
``skipped``, not written, not rejected).

Schema (exact):
    wikidata_id   string       -- the entity ``id`` (e.g. ``Q12345``)
    ol_author_key string       -- P648 value prefixed with ``/authors/``,
                                  null when the claim value is unusable
    label_en      string       -- English label, null if absent
    label_zh      string       -- Chinese label: ``zh`` preferred, then
                                  ``zh-hans``, then ``zh-hant``
    aliases_en    list<string> -- English aliases (empty list if none)
    aliases_zh    list<string> -- aliases from ``zh`` / ``zh-hans`` /
                                  ``zh-hant`` combined, de-duplicated

Null-safety follows the convention documented in ``parse_dump.py``:
missing scalars are null, missing lists are empty lists.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path
from typing import Any

import pyarrow as pa

from parse_dump import (
    CHUNK_ROWS,
    PROGRESS_EVERY,
    finalize_parts,
    load_checkpoint,
    log_progress,
    next_part_index,
    part_path,
    save_checkpoint,
    write_part,
)

STEM = "wikidata_authors"

WIKIDATA_SCHEMA = pa.schema([
    ("wikidata_id", pa.string()),
    ("ol_author_key", pa.string()),
    ("label_en", pa.string()),
    ("label_zh", pa.string()),
    ("aliases_en", pa.list_(pa.string())),
    ("aliases_zh", pa.list_(pa.string())),
])

_ZH_FALLBACK_ORDER = ("zh", "zh-hans", "zh-hant")


# ---------------------------------------------------------------------------
# Wikidata entity extraction helpers
# ---------------------------------------------------------------------------

def _term_value(term: Any) -> str | None:
    """A label/alias entry is ``{"value": str}`` or occasionally a bare str."""
    if isinstance(term, dict):
        value = term.get("value")
        return value if isinstance(value, str) else None
    if isinstance(term, str):
        return term
    return None


def _label(entity: dict[str, Any], lang: str) -> str | None:
    labels = entity.get("labels")
    if isinstance(labels, dict):
        return _term_value(labels.get(lang))
    return None


def _label_zh(entity: dict[str, Any]) -> str | None:
    for lang in _ZH_FALLBACK_ORDER:
        value = _label(entity, lang)
        if value is not None:
            return value
    return None


def _aliases(entity: dict[str, Any], langs: tuple[str, ...]) -> list[str]:
    aliases = entity.get("aliases")
    out: list[str] = []
    if not isinstance(aliases, dict):
        return out
    for lang in langs:
        entries = aliases.get(lang)
        if isinstance(entries, list):
            for entry in entries:
                value = _term_value(entry)
                if value is not None and value not in out:
                    out.append(value)
    return out


def _claim_string(entity: dict[str, Any], prop: str) -> str | None:
    """First string value of statement *prop*, tolerating dump shapes.

    The shape this dump actually uses (verified against the 2026-11-02
    snapshot): statements live under ``statements`` (not ``claims``) and
    each entry is ``{property: {id: "P648"}, value: {type: "value",
    content: "OL123A"}}`` -- the string is at ``value.content``.

    Also accepted: the canonical Wikidata ``claims`` shape
    ``{mainsnak: {datavalue: {value: "OL123A"}}}``, ``{value: "OL123A"}``
    entries, and bare string entries.
    """
    container = None
    for key in ("statements", "claims"):
        candidate = entity.get(key)
        if isinstance(candidate, dict):
            container = candidate
            break
    if container is None:
        return None
    entries = container.get(prop)
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if isinstance(entry, str):
            return entry
        if isinstance(entry, dict):
            mainsnak = entry.get("mainsnak")
            if isinstance(mainsnak, dict):
                datavalue = mainsnak.get("datavalue")
                if isinstance(datavalue, dict):
                    value = datavalue.get("value")
                    if isinstance(value, str):
                        return value
            value = entry.get("value")
            if isinstance(value, str):
                return value
            if isinstance(value, dict):
                content = value.get("content")
                if isinstance(content, str):
                    return content
    return None


def _ol_author_key(raw_value: str | None) -> str | None:
    """Normalise a P648 value to ``/authors/OL...A`` form."""
    if not raw_value:
        return None
    value = raw_value.strip()
    if not value:
        return None
    if value.startswith("/authors/"):
        return value
    if value.startswith("authors/"):
        return "/" + value
    return "/authors/" + value.lstrip("/")


def extract_entity(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "wikidata_id": entity.get("id"),
        "ol_author_key": _ol_author_key(_claim_string(entity, "P648")),
        "label_en": _label(entity, "en"),
        "label_zh": _label_zh(entity),
        "aliases_en": _aliases(entity, ("en",)),
        "aliases_zh": _aliases(entity, _ZH_FALLBACK_ORDER),
    }


# ---------------------------------------------------------------------------
# Driver (same streaming / checkpoint / progress discipline as parse_dump)
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", default=None,
                        help="gzipped wikidata dump (required unless "
                             "--finalize)")
    parser.add_argument("--output", default=None,
                        help="final parquet path (default: "
                             "<data-dir>/parquet/wikidata_authors.parquet)")
    parser.add_argument("--data-dir", required=True,
                        help="DATA_DIR holding parquet/, out/, progress.log")
    parser.add_argument("--finalize", action="store_true",
                        help="merge part files into the final parquet; "
                             "with no --input, only finalize and exit")
    args = parser.parse_args(argv)
    if not args.finalize and not args.input:
        parser.error("--input is required unless --finalize is given")
    return args


def run(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir)
    output_path = (Path(args.output) if args.output
                   else data_dir / "parquet" / f"{STEM}.parquet")
    parts_dir = output_path.parent
    parts_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "out").mkdir(parents=True, exist_ok=True)
    ckpt_path = parts_dir / f"{STEM}.ckpt.json"
    rejected_path = data_dir / "out" / "rejected_wikidata.jsonl"

    if args.finalize and not args.input:
        merged = finalize_parts(output_path, WIKIDATA_SCHEMA, STEM)
        print(f"finalize wikidata: merged rows={merged} -> {output_path}")
        return 0

    checkpoint = load_checkpoint(ckpt_path)
    lines_done = checkpoint["lines_done"]
    rows_written = checkpoint["rows_written"]
    rejected = checkpoint["rejected"]
    skipped = checkpoint.get("skipped", 0)
    part_idx = next_part_index(parts_dir, STEM)

    buffer: list[dict[str, Any]] = []
    started = time.monotonic()
    processed_this_run = 0
    total_lines = lines_done

    def flush_buffer(at_line: int) -> None:
        nonlocal buffer, part_idx, rows_written
        if not buffer:
            return
        write_part(buffer, WIKIDATA_SCHEMA, part_path(parts_dir, STEM, part_idx))
        part_idx += 1
        rows_written += len(buffer)
        buffer = []
        save_checkpoint(ckpt_path, {
            "lines_done": at_line,
            "rows_written": rows_written,
            "rejected": rejected,
            "skipped": skipped,
        })

    with open(rejected_path, "a", encoding="utf-8") as rejected_fh, \
            gzip.open(args.input, "rt", encoding="utf-8",
                      errors="replace") as fh:
        for line_no, raw_line in enumerate(fh, start=1):
            if line_no <= lines_done:
                continue  # checkpoint resume: count only, do not parse
            total_lines = line_no
            processed_this_run += 1
            line = raw_line.rstrip("\n")
            if not line.strip():
                continue

            # The real dump line has three tab-separated fields:
            # QID \t <JSON> \t last_modified, with the JSON field
            # CSV-quoted (wrapped in double quotes, inner quotes doubled).
            # Verified against the 2026-11-02 snapshot's first line.
            # The JSON field is the first field after the QID that starts
            # with '"' or '{'; plain unquoted JSON lines also work.
            json_text = line
            if "\t" in line:
                for field in line.split("\t")[1:]:
                    if field.startswith(('"', "{")):
                        json_text = field
                        break
            if len(json_text) >= 2 and json_text.startswith('"') \
                    and json_text.endswith('"'):
                json_text = json_text[1:-1].replace('""', '"')
            try:
                entity = json.loads(json_text)
            except json.JSONDecodeError as exc:
                rejected += 1
                rejected_fh.write(json.dumps({
                    "line_no": line_no,
                    "reason": f"json_error: {exc}",
                    "sample": line[:200],
                }) + "\n")
            else:
                if not isinstance(entity, dict):
                    rejected += 1
                    rejected_fh.write(json.dumps({
                        "line_no": line_no,
                        "reason": "not_an_entity: JSON value is not an object",
                        "sample": line[:200],
                    }) + "\n")
                elif not isinstance(entity.get("id"), str) or not entity["id"]:
                    rejected += 1
                    rejected_fh.write(json.dumps({
                        "line_no": line_no,
                        "reason": "missing_id",
                        "sample": line[:200],
                    }) + "\n")
                elif _claim_string(entity, "P648") is None:
                    skipped += 1  # not an OL author; counted, not written
                else:
                    try:
                        buffer.append(extract_entity(entity))
                    except Exception as exc:  # noqa: BLE001 - reject, don't die
                        rejected += 1
                        rejected_fh.write(json.dumps({
                            "line_no": line_no,
                            "reason": f"extract_error: {exc}",
                            "sample": line[:200],
                        }) + "\n")

            if len(buffer) >= CHUNK_ROWS:
                flush_buffer(total_lines)

            if total_lines % PROGRESS_EVERY == 0:
                elapsed = max(time.monotonic() - started, 1e-9)
                log_progress(
                    data_dir, "parse_wikidata",
                    lines=total_lines,
                    rows_written=rows_written + len(buffer),
                    rejected=rejected,
                    skipped=skipped,
                    rate=f"{processed_this_run / elapsed:.1f}",
                )

    flush_buffer(total_lines)
    # flush_buffer skips the checkpoint save when the buffer is empty
    # (e.g. a long run of skipped entities); persist the final position
    # unconditionally so a resume never rescans a completed file.
    save_checkpoint(ckpt_path, {
        "lines_done": total_lines,
        "rows_written": rows_written,
        "rejected": rejected,
        "skipped": skipped,
    })

    merged = finalize_parts(output_path, WIKIDATA_SCHEMA, STEM)
    elapsed = max(time.monotonic() - started, 1e-9)
    log_progress(
        data_dir, "parse_wikidata",
        lines=total_lines,
        rows_written=rows_written,
        rejected=rejected,
        skipped=skipped,
        rate=f"{processed_this_run / elapsed:.1f}",
    )
    print(f"parse_wikidata: lines={total_lines} rows_written={rows_written} "
          f"rejected={rejected} skipped={skipped} merged_rows={merged} "
          f"-> {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
