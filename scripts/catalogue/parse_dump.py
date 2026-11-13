"""Streaming parser for Open Library dumps.

Inputs:
    A gzipped OL dump file (``--input``). One record per line, tab-separated
    with exactly five fields::

        type \\t key \\t revision \\t last_modified \\t JSON

    ``--kind`` selects which dump (authors / works / editions) and therefore
    which schema/extractor is used.

Outputs (all under ``--data-dir`` unless ``--output`` says otherwise):
    * ``parquet/<kind>.partNNNN.parquet`` -- chunk files of 100,000 rows,
      written with pyarrow ``ParquetWriter`` (memory bounded: never more
      than one chunk is held at a time).
    * ``parquet/<kind>.parquet`` -- the final merged file (``--output``),
      produced by the finalize step, which streams each part's row groups
      through a single ``ParquetWriter`` so editions-scale data (multiple
      GB of parts) is never loaded into memory at once.
    * ``parquet/<kind>.ckpt.json`` -- checkpoint
      ``{lines_done, rows_written, rejected}``; written after every chunk
      flush. On restart, if a checkpoint exists, ``lines_done`` lines are
      skipped (counted, not parsed) and writing resumes at the next part
      number.
    * ``out/rejected_<kind>.jsonl`` -- one JSON object per rejected line:
      ``{"line_no": ..., "reason": ..., "sample": <first 200 chars>}``.
    * ``progress.log`` -- an appended progress line every 200,000 lines:
      ``[<UTC ISO ts>] parse_<kind> lines=<n> rows_written=<n>
      rejected=<n> rate=<lines/s>``.

Null-safety convention (applies to every schema below):
    Missing / wrongly-typed scalar fields become ``null``; missing /
    wrongly-typed list fields become an empty list. A record whose JSON
    has no usable ``key`` is rejected, not emitted.

Usage:
    parse_dump.py --kind authors --input ol_dump_authors_latest.txt.gz \
        --output $DATA_DIR/parquet/authors.parquet --data-dir $DATA_DIR
    parse_dump.py --kind authors --data-dir $DATA_DIR --finalize
        # merge existing parts into the final file without parsing
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

CHUNK_ROWS = 100_000
PROGRESS_EVERY = 200_000

_YEAR_RE = re.compile(r"\d{4}")
_PART_RE = re.compile(r"\.part(\d+)\.parquet$")


# ---------------------------------------------------------------------------
# Small shared helpers (also imported by parse_wikidata.py)
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    """Current UTC time as an ISO-8601 string with a trailing ``Z``."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_progress(data_dir: Path, tag: str, **fields: Any) -> None:
    """Append one ``[<ts>] <tag> k=v ...`` line to ``data_dir/progress.log``."""
    rendered = " ".join(f"{k}={v}" for k, v in fields.items())
    line = f"[{utc_now_iso()}] {tag} {rendered}\n"
    with open(data_dir / "progress.log", "a", encoding="utf-8") as fh:
        fh.write(line)


def load_checkpoint(path: Path) -> dict[str, int]:
    """Read a checkpoint file, returning zeroed counters if absent/bad."""
    default = {"lines_done": 0, "rows_written": 0, "rejected": 0}
    if not path.exists():
        return dict(default)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(default)
    for key_name in default:
        value = data.get(key_name)
        default[key_name] = int(value) if isinstance(value, int) else 0
    # Preserve any extra counters a sibling parser stored (e.g. "skipped").
    for key_name, value in data.items():
        if key_name not in default and isinstance(value, int):
            default[key_name] = value
    return default


def save_checkpoint(path: Path, data: dict[str, int]) -> None:
    """Write a checkpoint atomically (tmp file + rename)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def part_paths(directory: Path, stem: str) -> list[Path]:
    """All ``<stem>.partNNNN.parquet`` files in *directory*, in order."""
    found = []
    for candidate in directory.glob(f"{stem}.part*.parquet"):
        match = _PART_RE.search(candidate.name)
        if match:
            found.append((int(match.group(1)), candidate))
    return [path for _, path in sorted(found)]


def next_part_index(directory: Path, stem: str) -> int:
    """Index for the next part file (max existing index + 1, else 0)."""
    parts = part_paths(directory, stem)
    if not parts:
        return 0
    match = _PART_RE.search(parts[-1].name)
    return int(match.group(1)) + 1 if match else len(parts)


def part_path(directory: Path, stem: str, index: int) -> Path:
    return directory / f"{stem}.part{index:04d}.parquet"


def write_part(rows: list[dict[str, Any]], schema: pa.Schema, path: Path) -> None:
    """Write one chunk of rows to *path* as its own Parquet file.

    Atomic (tmp file + rename, the save_checkpoint pattern): a crash
    mid-write leaves a stray ``.tmp`` that part_paths never matches,
    instead of a truncated part file that next_part_index would keep
    and finalize_parts would fail reading — potentially hours in.
    """
    table = pa.Table.from_pylist(rows, schema=schema)
    tmp = path.with_name(path.name + ".tmp")
    with pq.ParquetWriter(tmp, schema) as writer:
        writer.write_table(table)
    tmp.replace(path)


def finalize_parts(output_path: Path, schema: pa.Schema, stem: str) -> int:
    """Merge all part files for *stem* into *output_path*.

    Streams row group by row group through one ``ParquetWriter`` so the
    merged file is built without ever holding the full dataset in memory.
    Parts and the checkpoint are left in place so the merge is idempotent
    and a later parse run can still resume. Returns total rows merged.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    parts = part_paths(output_path.parent, stem)
    total = 0
    with pq.ParquetWriter(output_path, schema) as writer:
        if not parts:
            writer.write_table(pa.Table.from_pylist([], schema=schema))
        for part in parts:
            parquet_file = pq.ParquetFile(part)
            for group_idx in range(parquet_file.num_row_groups):
                table = parquet_file.read_row_group(group_idx)
                if table.schema != schema:
                    table = table.cast(schema)
                writer.write_table(table)
                total += table.num_rows
    return total


# ---------------------------------------------------------------------------
# Field coercion helpers (null-safe; see module docstring convention)
# ---------------------------------------------------------------------------

def _s(value: Any) -> str | None:
    """Coerce a scalar to ``str`` or ``None``."""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _str_list(value: Any) -> list[str]:
    """Coerce a value to ``list[str]`` (empty list when unusable)."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _int(value: Any) -> int | None:
    """Coerce a value to ``int`` or ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _year(text: str | None) -> int | None:
    """First 4-digit year found in *text*, else ``None``."""
    if not text:
        return None
    match = _YEAR_RE.search(text)
    return int(match.group(0)) if match else None


def _key_of(item: Any) -> str | None:
    """Extract ``.key`` from an OL sub-object given as dict or bare string."""
    if isinstance(item, dict):
        return _s(item.get("key"))
    if isinstance(item, str):
        return item
    return None


# ---------------------------------------------------------------------------
# Schemas and per-kind extractors
# ---------------------------------------------------------------------------

AUTHORS_SCHEMA = pa.schema([
    ("key", pa.string()),
    ("name", pa.string()),
    ("personal_name", pa.string()),
    ("birth_date", pa.string()),
    ("death_date", pa.string()),
    ("alternate_names", pa.list_(pa.string())),
    ("wikidata_id", pa.string()),
])

WORKS_SCHEMA = pa.schema([
    ("key", pa.string()),
    ("title", pa.string()),
    ("subtitle", pa.string()),
    ("first_publish_date", pa.string()),
    ("first_publish_year", pa.int32()),
    ("subjects", pa.list_(pa.string())),
    ("author_keys", pa.list_(pa.string())),
])

EDITIONS_SCHEMA = pa.schema([
    ("key", pa.string()),
    ("work_key", pa.string()),
    ("title", pa.string()),
    ("subtitle", pa.string()),
    ("isbn_10", pa.list_(pa.string())),
    ("isbn_13", pa.list_(pa.string())),
    ("languages", pa.list_(pa.string())),
    ("publish_date", pa.string()),
    ("publish_year", pa.int32()),
    ("publishers", pa.list_(pa.string())),
    ("number_of_pages", pa.int32()),
    ("oclc_numbers", pa.list_(pa.string())),
    ("lccn", pa.list_(pa.string())),
    ("edition_name", pa.string()),
    ("series", pa.string()),
])

SCHEMAS: dict[str, pa.Schema] = {
    "authors": AUTHORS_SCHEMA,
    "works": WORKS_SCHEMA,
    "editions": EDITIONS_SCHEMA,
}


def extract_author(rec: dict[str, Any]) -> dict[str, Any]:
    remote_ids = rec.get("remote_ids")
    wikidata_id = None
    if isinstance(remote_ids, dict):
        wikidata_id = _s(remote_ids.get("wikidata"))
    return {
        "key": _s(rec.get("key")),
        "name": _s(rec.get("name")),
        "personal_name": _s(rec.get("personal_name")),
        "birth_date": _s(rec.get("birth_date")),
        "death_date": _s(rec.get("death_date")),
        "alternate_names": _str_list(rec.get("alternate_names")),
        "wikidata_id": wikidata_id,
    }


def extract_work(rec: dict[str, Any]) -> dict[str, Any]:
    author_keys: list[str] = []
    authors = rec.get("authors")
    if isinstance(authors, list):
        for entry in authors:
            if isinstance(entry, dict):
                key = _key_of(entry.get("author"))
                if key is None:
                    key = _key_of(entry)
                if key is not None:
                    author_keys.append(key)
            elif isinstance(entry, str):
                author_keys.append(entry)
    first_publish_date = _s(rec.get("first_publish_date"))
    return {
        "key": _s(rec.get("key")),
        "title": _s(rec.get("title")),
        "subtitle": _s(rec.get("subtitle")),
        "first_publish_date": first_publish_date,
        "first_publish_year": _year(first_publish_date),
        "subjects": _str_list(rec.get("subjects")),
        "author_keys": author_keys,
    }


def extract_edition(rec: dict[str, Any]) -> dict[str, Any]:
    work_key = None
    works = rec.get("works")
    if isinstance(works, list) and works:
        work_key = _key_of(works[0])

    languages: list[str] = []
    raw_languages = rec.get("languages")
    if isinstance(raw_languages, list):
        for item in raw_languages:
            code = _key_of(item)
            if code is None and isinstance(item, str):
                code = item
            if code is not None:
                if code.startswith("/languages/"):
                    code = code[len("/languages/"):]
                languages.append(code)

    publish_date = _s(rec.get("publish_date"))
    return {
        "key": _s(rec.get("key")),
        "work_key": work_key,
        "title": _s(rec.get("title")),
        "subtitle": _s(rec.get("subtitle")),
        "isbn_10": _str_list(rec.get("isbn_10")),
        "isbn_13": _str_list(rec.get("isbn_13")),
        "languages": languages,
        "publish_date": publish_date,
        "publish_year": _year(publish_date),
        "publishers": _str_list(rec.get("publishers")),
        "number_of_pages": _int(rec.get("number_of_pages")),
        "oclc_numbers": _str_list(rec.get("oclc_numbers")),
        "lccn": _str_list(rec.get("lccn")),
        "edition_name": _s(rec.get("edition_name")),
        "series": _s(rec.get("series")),
    }


EXTRACTORS = {
    "authors": extract_author,
    "works": extract_work,
    "editions": extract_edition,
}


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--kind", required=True,
                        choices=sorted(SCHEMAS), help="dump kind")
    parser.add_argument("--input", default=None,
                        help="gzipped dump file (required unless --finalize)")
    parser.add_argument("--output", default=None,
                        help="final parquet path "
                             "(default: <data-dir>/parquet/<kind>.parquet)")
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
    kind: str = args.kind
    schema = SCHEMAS[kind]
    extractor = EXTRACTORS[kind]
    data_dir = Path(args.data_dir)
    output_path = (Path(args.output) if args.output
                   else data_dir / "parquet" / f"{kind}.parquet")
    parts_dir = output_path.parent
    parts_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "out").mkdir(parents=True, exist_ok=True)
    ckpt_path = parts_dir / f"{kind}.ckpt.json"
    rejected_path = data_dir / "out" / f"rejected_{kind}.jsonl"

    # --finalize with no input: merge-only mode.
    if args.finalize and not args.input:
        merged = finalize_parts(output_path, schema, kind)
        print(f"finalize {kind}: merged rows={merged} -> {output_path}")
        return 0

    checkpoint = load_checkpoint(ckpt_path)
    lines_done = checkpoint["lines_done"]
    rows_written = checkpoint["rows_written"]
    rejected = checkpoint["rejected"]
    part_idx = next_part_index(parts_dir, kind)

    buffer: list[dict[str, Any]] = []
    started = time.monotonic()
    processed_this_run = 0
    total_lines = lines_done

    def flush_buffer(at_line: int) -> None:
        nonlocal buffer, part_idx, rows_written
        if not buffer:
            return
        write_part(buffer, schema, part_path(parts_dir, kind, part_idx))
        part_idx += 1
        rows_written += len(buffer)
        buffer = []
        save_checkpoint(ckpt_path, {
            "lines_done": at_line,
            "rows_written": rows_written,
            "rejected": rejected,
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

            fields = line.split("\t", 4)
            if len(fields) < 5:
                rejected += 1
                rejected_fh.write(json.dumps({
                    "line_no": line_no,
                    "reason": f"field_count: expected 5, got {len(fields)}",
                    "sample": line[:200],
                }) + "\n")
            else:
                try:
                    record = json.loads(fields[4])
                except json.JSONDecodeError as exc:
                    rejected += 1
                    rejected_fh.write(json.dumps({
                        "line_no": line_no,
                        "reason": f"json_error: {exc}",
                        "sample": line[:200],
                    }) + "\n")
                else:
                    if not isinstance(record, dict):
                        rejected += 1
                        rejected_fh.write(json.dumps({
                            "line_no": line_no,
                            "reason": "not_a_record: JSON value is not an object",
                            "sample": line[:200],
                        }) + "\n")
                    elif not _s(record.get("key")):
                        rejected += 1
                        rejected_fh.write(json.dumps({
                            "line_no": line_no,
                            "reason": "missing_key",
                            "sample": line[:200],
                        }) + "\n")
                    else:
                        try:
                            buffer.append(extractor(record))
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
                    data_dir, f"parse_{kind}",
                    lines=total_lines,
                    rows_written=rows_written + len(buffer),
                    rejected=rejected,
                    rate=f"{processed_this_run / elapsed:.1f}",
                )

    flush_buffer(total_lines)
    # flush_buffer skips the checkpoint save when the buffer is empty
    # (e.g. a long run of rejected lines at EOF); persist the final
    # position unconditionally so a resume never rescans a completed
    # file. (Mirrors parse_wikidata.py.)
    save_checkpoint(ckpt_path, {
        "lines_done": total_lines,
        "rows_written": rows_written,
        "rejected": rejected,
    })

    merged = finalize_parts(output_path, schema, kind)
    elapsed = max(time.monotonic() - started, 1e-9)
    log_progress(
        data_dir, f"parse_{kind}",
        lines=total_lines,
        rows_written=rows_written,
        rejected=rejected,
        rate=f"{processed_this_run / elapsed:.1f}",
    )
    print(f"parse_{kind}: lines={total_lines} rows_written={rows_written} "
          f"rejected={rejected} merged_rows={merged} -> {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
