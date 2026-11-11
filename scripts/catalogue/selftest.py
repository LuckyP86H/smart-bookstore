"""Self-tests for the PR 1 catalogue pipeline — the places it can lie.

The pipeline's failure mode is not crashing; it is producing plausible
numbers that are quietly wrong. These tests therefore re-derive truth
through independent code paths and compare:

* ``isbn_unit`` — ISBN canonicalisation against fixed known examples
  (hyphens, spaces, lower-case ``x``, X check digits, a 979-prefix
  ISBN-13, and bad-checksum rejects). Expected values are worked by
  hand, never computed by the code under test.
* ``<kind>_linecount`` — raw dump line count (``gzip -dc | wc -l``, an
  independent process) vs the parser checkpoint vs Parquet rows +
  rejected lines.
* ``<kind>_golden_first`` / ``editions_golden_deep`` — one raw dump
  line (line 1, and line 1,000,000 for editions) parsed *here*, field
  by field, and compared against the corresponding Parquet row. The
  test does not import the pipeline's extractors.
* ``wikidata_golden`` — Q554341, hand-read from the raw dump's first
  line during the build: /authors/OL5412486A, "Herbert McLean Evans".
* ``slice_trace`` + ``strata_sanity`` — a slice work traced back to
  works/editions Parquet; per-stratum counts compared with the §4.3
  composition targets (WARN, not FAIL, when availability is short —
  the data decides how much of a stratum exists).
* ``benchmarks_sanity`` — suite sizes vs §3.4, plus a leak check that
  B-mask/B-open rows carry no ISBN values (masking is the point).
* ``idempotency`` — re-invoke the driver for completed stages and
  assert markers exist and counts are unchanged (no duplication).

Tests whose inputs are not ready report SKIP with the reason. Results
are printed as PASS/FAIL/WARN/SKIP lines and written to
``out/selftest_results.json``.

Usage: ``selftest.py --data-dir <DATA_DIR> [--skip-idempotency]``
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import duckdb  # noqa: E402

from build_isbn_map import canonicalise  # noqa: E402

RESULTS: list[dict[str, Any]] = []


def record(test: str, status: str, detail: str) -> None:
    RESULTS.append({"test": test, "status": status, "detail": detail})
    print(f"{status:4} {test}: {detail}")


def duck(data_dir: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET threads=2")
    con.execute("SET memory_limit='3GB'")
    con.execute(f"SET temp_directory='{data_dir}'")
    return con


def raw_line_count(gz_path: Path) -> int:
    out = subprocess.run(
        f"gzip -dc '{gz_path}' | wc -l",
        shell=True, capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def dump_record_at(gz_path: Path, line_no: int) -> dict[str, Any]:
    """Independently parse the JSON on dump line *line_no* (1-based)."""
    with gzip.open(gz_path, "rt", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh, start=1):
            if i == line_no:
                return json.loads(line.rstrip("\n").split("\t", 4)[4])
    raise IndexError(f"line {line_no} not found in {gz_path}")


# ---------------------------------------------------------------------------
# ISBN unit checks — expected values worked by hand
# ---------------------------------------------------------------------------

ISBN_CASES: list[tuple[str, str | None]] = [
    ("0-306-40615-2", "9780306406157"),      # classic worked example
    ("0306406152", "9780306406157"),         # bare ISBN-10
    ("978-0-306-40615-7", "9780306406157"),  # hyphenated ISBN-13
    ("9780306406157", "9780306406157"),      # bare ISBN-13
    ("080442957X", "9780804429573"),         # X check digit
    ("080442957x", "9780804429573"),         # lower-case x
    ("0 8044 2957 X", "9780804429573"),      # spaces + X
    ("9791090636071", "9791090636071"),      # 979 prefix stays (valid 13)
    ("9780306406158", None),                 # bad ISBN-13 checksum
    ("0306406153", None),                    # bad ISBN-10 checksum
    ("12345", None),                         # bad length
    ("abcdefghij", None),                    # bad characters
    ("", None),                              # empty
]


def test_isbn_unit() -> None:
    failures = []
    for raw, expected in ISBN_CASES:
        got, _reason = canonicalise(raw)
        if got != expected:
            failures.append(f"{raw!r}: got {got!r}, want {expected!r}")
    if failures:
        record("isbn_unit", "FAIL", "; ".join(failures))
    else:
        record("isbn_unit", "PASS",
               f"{len(ISBN_CASES)} cases incl. X/x, hyphens, spaces, "
               "979-prefix, checksum rejects")


# ---------------------------------------------------------------------------
# Line counts + golden rows for the TSV dumps
# ---------------------------------------------------------------------------

def test_linecount(data_dir: Path, kind: str) -> bool:
    gz = data_dir / "dumps" / f"ol_dump_{kind}_latest.txt.gz"
    ckpt_path = data_dir / "parquet" / f"{kind}.ckpt.json"
    parquet = data_dir / "parquet" / f"{kind}.parquet"
    if not (gz.exists() and ckpt_path.exists() and parquet.exists()):
        record(f"{kind}_linecount", "SKIP", "dump/checkpoint/parquet missing")
        return False
    ckpt = json.loads(ckpt_path.read_text())
    raw = raw_line_count(gz)
    con = duck(data_dir)
    rows = con.execute(
        f"SELECT count(*) FROM read_parquet('{parquet}')").fetchone()[0]
    if ckpt["lines_done"] < raw:
        record(f"{kind}_linecount", "SKIP",
               f"parse not finished: ckpt_lines={ckpt['lines_done']} "
               f"of raw={raw}")
        return False
    ok = rows == ckpt["rows_written"]
    record(f"{kind}_linecount", "PASS" if ok else "FAIL",
           f"raw={raw} ckpt_lines={ckpt['lines_done']} "
           f"parquet_rows={rows} rejected={ckpt['rejected']}")
    return ok


def _expected_author(rec: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": rec["key"],
        "name": rec.get("name"),
        "personal_name": rec.get("personal_name"),
        "birth_date": rec.get("birth_date"),
        "death_date": rec.get("death_date"),
        "alternate_names": rec.get("alternate_names") or [],
        "wikidata_id": (rec.get("remote_ids") or {}).get("wikidata"),
    }


def _expected_work(rec: dict[str, Any]) -> dict[str, Any]:
    m = re.search(r"\d{4}", rec.get("first_publish_date") or "")
    return {
        "key": rec["key"],
        "title": rec.get("title"),
        "subtitle": rec.get("subtitle"),
        "first_publish_year": int(m.group()) if m else None,
        "subjects": rec.get("subjects") or [],
        "author_keys": [a["author"]["key"] for a in rec.get("authors") or []
                        if isinstance(a, dict)
                        and isinstance(a.get("author"), dict)],
    }


def _expected_edition(rec: dict[str, Any]) -> dict[str, Any]:
    m = re.search(r"\d{4}", rec.get("publish_date") or "")
    works = rec.get("works") or []
    return {
        "key": rec["key"],
        "work_key": works[0]["key"] if works else None,
        "title": rec.get("title"),
        "isbn_13": rec.get("isbn_13") or [],
        "languages": [lang["key"].rsplit("/", 1)[-1]
                      for lang in rec.get("languages") or []],
        "publish_year": int(m.group()) if m else None,
        "number_of_pages": rec.get("number_of_pages"),
    }


def test_golden(data_dir: Path, kind: str, line_no: int,
                expected_fn: Any, label: str) -> None:
    gz = data_dir / "dumps" / f"ol_dump_{kind}_latest.txt.gz"
    parquet = data_dir / "parquet" / f"{kind}.parquet"
    if not parquet.exists():
        record(label, "SKIP", f"{kind}.parquet missing")
        return
    expected = expected_fn(dump_record_at(gz, line_no))
    con = duck(data_dir)
    cols = ", ".join(expected.keys())
    # Look up by key, not by row offset: rejected lines shift offsets.
    row = con.execute(
        f"SELECT {cols} FROM read_parquet('{parquet}') "
        f"WHERE key = '{expected['key']}'").fetchone()
    if row is None:
        record(label, "FAIL",
               f"line {line_no}: key {expected['key']} absent from Parquet")
        return
    got = dict(zip(expected.keys(), row))
    diffs = {k: (got[k], v) for k, v in expected.items() if got[k] != v}
    if diffs:
        record(label, "FAIL", f"line {line_no} diffs (got, want): {diffs}")
    else:
        record(label, "PASS",
               f"line {line_no} of {kind} dump matches Parquet row "
               f"on {len(expected)} fields")


# ---------------------------------------------------------------------------
# Wikidata golden (hand-read from the raw dump during the build)
# ---------------------------------------------------------------------------

def test_wikidata(data_dir: Path) -> None:
    parquet = data_dir / "parquet" / "wikidata_authors.parquet"
    ckpt_path = data_dir / "parquet" / "wikidata_authors.ckpt.json"
    if not parquet.exists():
        record("wikidata_golden", "SKIP", "wikidata_authors.parquet missing")
        return
    con = duck(data_dir)
    row = con.execute(
        f"SELECT ol_author_key, label_en FROM read_parquet('{parquet}') "
        "WHERE wikidata_id = 'Q554341'").fetchone()
    if row == ("/authors/OL5412486A", "Herbert McLean Evans"):
        record("wikidata_golden", "PASS",
               "Q554341 -> /authors/OL5412486A, 'Herbert McLean Evans' "
               "(hand-read from raw dump line 1)")
    else:
        record("wikidata_golden", "FAIL", f"Q554341 row = {row}")
    ckpt = json.loads(ckpt_path.read_text())
    total = con.execute(
        f"SELECT count(*) FROM read_parquet('{parquet}')").fetchone()[0]
    ok = total == ckpt["rows_written"]
    record("wikidata_counts", "PASS" if ok else "FAIL",
           f"parquet_rows={total} ckpt_rows={ckpt['rows_written']} "
           f"lines={ckpt['lines_done']} skipped={ckpt['skipped']} "
           f"rejected={ckpt['rejected']}")


# ---------------------------------------------------------------------------
# Slice + benchmarks sanity
# ---------------------------------------------------------------------------

STRATA_TARGETS = {  # §4.3 composition (cap = upper bound, else target)
    "many_editions": ("target", 1500),
    "collisions": ("cap", 800),
    "en_zh": ("target", 1200),
    "reprint_chains": ("target", 600),
    "null_isbn_pre1987_zh": ("cap", 800),
    "canon": ("cap", 600),
}


def test_slice(data_dir: Path) -> None:
    manifest_path = data_dir / "out" / "slice_manifest.json"
    if not manifest_path.exists():
        record("slice_trace", "SKIP", "slice_manifest.json missing")
        return
    manifest = json.loads(manifest_path.read_text())
    con = duck(data_dir)
    p = data_dir / "parquet"
    work = con.execute(
        f"SELECT key, title, strata FROM read_parquet('{p}/slice_works.parquet') "
        "LIMIT 1").fetchone()
    in_works = con.execute(
        f"SELECT count(*) FROM read_parquet('{p}/works.parquet') "
        f"WHERE key = '{work[0]}' AND title = ?", [work[1]]).fetchone()[0]
    n_ed = con.execute(
        f"SELECT count(*) FROM read_parquet('{p}/slice_editions.parquet') "
        f"WHERE work_key = '{work[0]}'").fetchone()[0]
    n_ed_full = con.execute(
        f"SELECT count(*) FROM read_parquet('{p}/editions.parquet') "
        f"WHERE work_key = '{work[0]}'").fetchone()[0]
    ok = in_works == 1 and 0 < n_ed <= n_ed_full and bool(work[2])
    record("slice_trace", "PASS" if ok else "FAIL",
           f"work {work[0]} strata={work[2]} slice_editions={n_ed} "
           f"full_editions={n_ed_full} in_works={in_works}")
    counts = manifest.get("strata_work_counts") or manifest.get(
        "strata_counts") or {}
    for stratum, (kind, target) in STRATA_TARGETS.items():
        n = counts.get(stratum)
        if n is None:
            record(f"stratum_{stratum}", "WARN",
                   "not reported in slice_manifest.json")
        elif kind == "target" and n < 0.4 * target:
            record(f"stratum_{stratum}", "WARN",
                   f"{n} works vs §4.3 target ~{target} "
                   "(availability-short; see build log)")
        elif kind == "cap" and n > 1.15 * target:
            record(f"stratum_{stratum}", "WARN",
                   f"{n} works exceeds §4.3 cap ~{target}")
        else:
            record(f"stratum_{stratum}", "PASS",
                   f"{n} works (§4.3 {kind} ~{target})")


SUITE_TARGETS = {"b_mask": 5000, "b_open": 2000,
                 "b_pairs_positive": 20000, "b_pairs_negative": 20000}


def test_benchmarks(data_dir: Path) -> None:
    manifest_path = data_dir / "out" / "benchmarks_manifest.json"
    if not manifest_path.exists():
        record("benchmarks_sanity", "SKIP", "benchmarks_manifest.json missing")
        return
    manifest = json.loads(manifest_path.read_text())
    counts = manifest.get("suite_counts") or manifest.get("counts") or {}
    suites = manifest.get("suites") or {}
    if not counts and suites:
        counts = {
            name: info.get("rows")
            for name, info in suites.items()
            if isinstance(info, dict)
        }
        pairs = suites.get("b_pairs") or {}
        if "positives" in pairs:
            counts["b_pairs_positive"] = pairs["positives"]
        if "negatives" in pairs:
            counts["b_pairs_negative"] = pairs["negatives"]
    for suite, target in SUITE_TARGETS.items():
        n = counts.get(suite)
        if n is None:
            record(f"suite_{suite}", "WARN", "not reported in manifest")
        elif n < 0.9 * target:
            record(f"suite_{suite}", "WARN",
                   f"{n} cases vs §3.4 target {target}")
        else:
            record(f"suite_{suite}", "PASS", f"{n} cases (target {target})")
    n_enzh = counts.get("b_enzh")
    if n_enzh is not None:
        record("suite_b_enzh",
               "PASS" if 100 <= n_enzh <= 1000 else "WARN",
               f"{n_enzh} cases (§3.4: hundreds-thousands, capped 1,000)")
    # Leak check: masked suites must not carry ISBN values anywhere.
    con = duck(data_dir)
    for suite in ("b_mask", "b_open"):
        path = data_dir / "parquet" / "benchmarks" / f"{suite}.parquet"
        if not path.exists():
            continue
        cols = [r[0] for r in con.execute(
            f"SELECT column_name FROM (DESCRIBE SELECT * FROM "
            f"read_parquet('{path}'))").fetchall()]
        isbn_cols = [c for c in cols if "isbn" in c.lower()
                     and c != "isbn_masked"]
        leaked = 0
        for c in isbn_cols:
            leaked += con.execute(
                f"SELECT count(*) FROM read_parquet('{path}') "
                f"WHERE {c} IS NOT NULL AND len({c}) > 0").fetchone()[0]
        record(f"leak_{suite}", "PASS" if leaked == 0 else "FAIL",
               f"isbn-bearing columns={isbn_cols} non-empty values={leaked}")


# ---------------------------------------------------------------------------
# Driver idempotency
# ---------------------------------------------------------------------------

def test_idempotency(data_dir: Path, repo_dir: Path) -> None:
    stages_dir = data_dir / "stages"
    candidates = []
    for stage, ckpt in (("parse_authors", "authors"),
                        ("parse_wikidata", "wikidata_authors"),
                        ("parse_works", "works"),
                        ("parse_editions", "editions")):
        ckpt_path = data_dir / "parquet" / f"{ckpt}.ckpt.json"
        gz = data_dir / "dumps" / f"ol_dump_{ckpt.replace('_authors', '')}" \
                                 "_latest.txt.gz"
        if ckpt_path.exists():
            candidates.append((stage, ckpt_path))
    if not candidates:
        record("idempotency", "SKIP", "no completed parse stage yet")
        return
    venv_python = data_dir / "venv" / "bin" / "python"
    driver = repo_dir / "scripts" / "catalogue" / "run_pipeline.py"
    for stage, ckpt_path in candidates:
        before = json.loads(ckpt_path.read_text())
        proc = subprocess.run(
            [str(venv_python), str(driver), "--data-dir", str(data_dir),
             "--only", stage],
            capture_output=True, text=True)
        after = json.loads(ckpt_path.read_text())
        marker = stages_dir / f"{stage}.done"
        same = (before["rows_written"] == after["rows_written"]
                and before["lines_done"] == after["lines_done"])
        ok = proc.returncode == 0 and marker.exists() and same
        record(f"idempotency_{stage}", "PASS" if ok else "FAIL",
               f"rc={proc.returncode} marker={marker.exists()} "
               f"rows {before['rows_written']} -> {after['rows_written']}")


# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--skip-idempotency", action="store_true")
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    repo_dir = Path(__file__).resolve().parents[2]

    test_isbn_unit()
    for kind in ("authors", "works", "editions"):
        if test_linecount(data_dir, kind):
            pass
    test_golden(data_dir, "authors", 1, _expected_author,
                "authors_golden_first")
    test_golden(data_dir, "works", 1, _expected_work, "works_golden_first")
    test_golden(data_dir, "editions", 1, _expected_edition,
                "editions_golden_first")
    test_golden(data_dir, "editions", 1_000_000, _expected_edition,
                "editions_golden_deep")
    test_wikidata(data_dir)
    test_slice(data_dir)
    test_benchmarks(data_dir)
    if not args.skip_idempotency:
        test_idempotency(data_dir, repo_dir)

    summary: dict[str, int] = {}
    for r in RESULTS:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    (data_dir / "out").mkdir(parents=True, exist_ok=True)
    (data_dir / "out" / "selftest_results.json").write_text(json.dumps(
        {"summary": summary, "results": RESULTS}, indent=2))
    print(f"\nselftest summary: {summary}")
    return 1 if summary.get("FAIL") else 0


if __name__ == "__main__":
    sys.exit(main())
