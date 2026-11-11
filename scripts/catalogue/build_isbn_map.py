"""Build the canonical ISBN -> edition/work map from parsed editions.

Inputs:
    ``<data-dir>/parquet/editions.parquet`` (produced by ``parse_dump.py
    --kind editions``), read through duckdb with deliberately small
    resource limits (``threads=2``, ``memory_limit='3GB'``,
    ``temp_directory=<data-dir>``) and streamed to Python in bounded
    batches -- the editions table is never loaded whole.

Outputs:
    * ``parquet/isbn_map.parquet`` with schema:
          isbn13      string  -- canonical ISBN-13 (see rules below)
          isbn_raw    string  -- the ISBN exactly as stored in the edition
          edition_key string  -- the edition's OL key
          work_key    string  -- the edition's work key (null if none)
      One row per (isbn, edition): if an edition carries the same book
      as both an ISBN-10 and an ISBN-13 (the common case) they collapse
      to a single row, preferring the ISBN-13 raw form.
    * ``out/rejected_isbn.jsonl`` -- one object per invalid ISBN:
      ``{"edition_key": ..., "work_key": ..., "isbn_raw": ...,
      "reason": ...}``.
    * ``out/isbn_map_stats.json`` --
      ``{"rows": ..., "distinct_isbn13": ..., "editions_covered": ...}``,
      computed with a duckdb aggregation over the finished map (no giant
      in-memory set of ISBNs).

Canonicalisation rules:
    * Cleaning: hyphens and whitespace removed, letters upper-cased.
    * A valid ISBN-13 (13 digits, mod-10 check digit with 1/3 weights)
      is its own canonical form.
    * A valid ISBN-10 (9 digits + digit-or-X check, mod-11 checksum) is
      converted to ISBN-13 as ``978`` + the ISBN-10's first nine digits
      + a recomputed ISBN-13 check digit.
    * Anything else (bad length, bad characters, bad checksum) is
      rejected to ``rejected_isbn.jsonl`` with the specific reason.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

CHUNK_ROWS = 100_000
FETCH_BATCH = 50_000
PROGRESS_EVERY = 200_000

ISBN_MAP_SCHEMA = pa.schema([
    ("isbn13", pa.string()),
    ("isbn_raw", pa.string()),
    ("edition_key", pa.string()),
    ("work_key", pa.string()),
])

_CLEAN_RE = re.compile(r"[\s\-]+")


# ---------------------------------------------------------------------------
# ISBN validation / canonicalisation
# ---------------------------------------------------------------------------

def clean_isbn(raw: str) -> str:
    """Strip hyphens/whitespace and upper-case."""
    return _CLEAN_RE.sub("", raw).upper()


def _isbn13_check_digit(first_twelve: str) -> int:
    total = sum(int(d) * (1 if i % 2 == 0 else 3)
                for i, d in enumerate(first_twelve))
    return (10 - (total % 10)) % 10


def is_valid_isbn13(cleaned: str) -> bool:
    return (len(cleaned) == 13 and cleaned.isdigit()
            and _isbn13_check_digit(cleaned[:12]) == int(cleaned[12]))


def is_valid_isbn10(cleaned: str) -> bool:
    if len(cleaned) != 10 or not cleaned[:9].isdigit():
        return False
    last = cleaned[9]
    if not (last.isdigit() or last == "X"):
        return False
    total = 0
    for i, char in enumerate(cleaned):
        value = 10 if char == "X" else int(char)
        total += (10 - i) * value
    return total % 11 == 0


def isbn10_to_isbn13(cleaned: str) -> str:
    """978 prefix + first nine digits + recomputed ISBN-13 check digit."""
    core = "978" + cleaned[:9]
    return core + str(_isbn13_check_digit(core))


def canonicalise(raw: str) -> tuple[str | None, str | None]:
    """Return ``(canonical_isbn13, None)`` or ``(None, reason)``."""
    cleaned = clean_isbn(raw)
    if not cleaned:
        return None, "empty_after_cleaning"
    if len(cleaned) == 13:
        if not cleaned.isdigit():
            return None, "bad_characters: ISBN-13 must be all digits"
        if not is_valid_isbn13(cleaned):
            return None, "bad_checksum_isbn13"
        return cleaned, None
    if len(cleaned) == 10:
        if not cleaned[:9].isdigit() or not (
                cleaned[9].isdigit() or cleaned[9] == "X"):
            return None, "bad_characters: malformed ISBN-10"
        if not is_valid_isbn10(cleaned):
            return None, "bad_checksum_isbn10"
        return isbn10_to_isbn13(cleaned), None
    return None, f"bad_length: {len(cleaned)} after cleaning"


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", required=True,
                        help="DATA_DIR holding parquet/, out/, progress.log")
    parser.add_argument("--input", default=None,
                        help="editions parquet (default: "
                             "<data-dir>/parquet/editions.parquet)")
    parser.add_argument("--output", default=None,
                        help="isbn_map parquet (default: "
                             "<data-dir>/parquet/isbn_map.parquet)")
    return parser.parse_args(argv)


def _log_progress(data_dir: Path, **fields: Any) -> None:
    rendered = " ".join(f"{k}={v}" for k, v in fields.items())
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(data_dir / "progress.log", "a", encoding="utf-8") as fh:
        fh.write(f"[{ts}] build_isbn_map {rendered}\n")


def run(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir)
    input_path = (Path(args.input) if args.input
                  else data_dir / "parquet" / "editions.parquet")
    output_path = (Path(args.output) if args.output
                   else data_dir / "parquet" / "isbn_map.parquet")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    (data_dir / "out").mkdir(parents=True, exist_ok=True)
    rejected_path = data_dir / "out" / "rejected_isbn.jsonl"
    stats_path = data_dir / "out" / "isbn_map_stats.json"

    con = duckdb.connect()
    try:
        con.execute("SET threads=2")
        con.execute("SET memory_limit='3GB'")
        temp_dir = str(data_dir).replace("'", "''")
        con.execute(f"SET temp_directory='{temp_dir}'")

        cursor = con.execute(
            "SELECT key, work_key, isbn_10, isbn_13 "
            "FROM read_parquet(?)",
            [str(input_path)],
        )

        rows_written = 0
        rejected = 0
        editions_seen = 0
        started = time.monotonic()
        buffer: list[dict[str, Any]] = []

        with open(rejected_path, "w", encoding="utf-8") as rejected_fh, \
                pq.ParquetWriter(output_path, ISBN_MAP_SCHEMA) as writer:

            def flush_buffer() -> None:
                nonlocal buffer, rows_written
                if not buffer:
                    return
                table = pa.Table.from_pylist(buffer, schema=ISBN_MAP_SCHEMA)
                writer.write_table(table)
                rows_written += len(buffer)
                buffer = []

            while True:
                batch = cursor.fetchmany(FETCH_BATCH)
                if not batch:
                    break
                for edition_key, work_key, isbn_10_list, isbn_13_list in batch:
                    editions_seen += 1
                    # One row per (isbn, edition): collapse the ISBN-10
                    # and ISBN-13 forms of the same book within an edition,
                    # preferring the ISBN-13 raw form.
                    per_edition: dict[str, str] = {}
                    candidates: list[tuple[str, bool]] = []
                    for raw in isbn_13_list or []:
                        if isinstance(raw, str):
                            candidates.append((raw, True))
                    for raw in isbn_10_list or []:
                        if isinstance(raw, str):
                            candidates.append((raw, False))
                    for raw, is_13 in candidates:
                        canonical, reason = canonicalise(raw)
                        if canonical is None:
                            rejected += 1
                            rejected_fh.write(json.dumps({
                                "edition_key": edition_key,
                                "work_key": work_key,
                                "isbn_raw": raw,
                                "reason": reason,
                            }) + "\n")
                            continue
                        existing = per_edition.get(canonical)
                        if existing is None or (
                                is_13 and len(clean_isbn(existing)) != 13):
                            per_edition[canonical] = raw
                    for canonical, raw in per_edition.items():
                        buffer.append({
                            "isbn13": canonical,
                            "isbn_raw": raw,
                            "edition_key": edition_key,
                            "work_key": work_key,
                        })
                    if len(buffer) >= CHUNK_ROWS:
                        flush_buffer()
                    if editions_seen % PROGRESS_EVERY == 0:
                        elapsed = max(time.monotonic() - started, 1e-9)
                        _log_progress(
                            data_dir,
                            editions=editions_seen,
                            rows_written=rows_written + len(buffer),
                            rejected=rejected,
                            rate=f"{editions_seen / elapsed:.1f}",
                        )
            flush_buffer()

        # Stats via duckdb over the finished map (bounded memory).
        stats_row = con.execute(
            "SELECT count(*), count(DISTINCT isbn13), "
            "count(DISTINCT edition_key) FROM read_parquet(?)",
            [str(output_path)],
        ).fetchone()
    finally:
        con.close()

    stats = {
        "rows": int(stats_row[0]),
        "distinct_isbn13": int(stats_row[1]),
        "editions_covered": int(stats_row[2]),
    }
    stats_path.write_text(json.dumps(stats, indent=2) + "\n",
                          encoding="utf-8")
    elapsed = max(time.monotonic() - started, 1e-9)
    _log_progress(data_dir, editions=editions_seen,
                  rows_written=rows_written, rejected=rejected,
                  rate=f"{editions_seen / elapsed:.1f}")
    print(f"build_isbn_map: editions={editions_seen} "
          f"rows={stats['rows']} distinct_isbn13={stats['distinct_isbn13']} "
          f"editions_covered={stats['editions_covered']} "
          f"rejected={rejected} -> {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
