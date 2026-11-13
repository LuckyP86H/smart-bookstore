"""Build the §3.4 benchmark suites from the full Parquet catalogue.

Implements P4-BOOKS-FINAL-PLAN.md §3.4 and §9 Step 1. The ISBN'd half
grades the ISBN-less half: every case in B-mask / B-open / B-enzh carries
the metadata a Path B listing would carry, with the ISBN removed -- ISBN
values never appear in those suites' rows (that is the point of masking).

Inputs (under ``$DATA_DIR/parquet/``; see slice.py for the full contract):

* ``editions.parquet``, ``works.parquet`` -- the FULL catalogue, not the
  slice (B-open's answers must be absent from the slice by construction).
* ``slice_works.parquet`` -- defines which works count as "in the slice"
  for B-open's exclusion.

Outputs:

* ``$DATA_DIR/parquet/benchmarks/b_mask.parquet``  (5,000 cases)
* ``$DATA_DIR/parquet/benchmarks/b_open.parquet``  (2,000 cases)
* ``$DATA_DIR/parquet/benchmarks/b_pairs.parquet`` (20,000 positive +
  20,000 hard-negative pairs)
* ``$DATA_DIR/parquet/benchmarks/b_enzh.parquet``  (<= 1,000 cases)
* ``$DATA_DIR/out/bopen_excluded_work_keys.txt`` -- B-open's true work
  keys, one per line, so scorers can exclude them from any reference.
* ``$DATA_DIR/out/benchmarks_manifest.json`` -- per-suite row counts and
  the sampling notes below.

Determinism: seed = 20261111 everywhere. DuckDB-side sampling orders by
``hash(key, seed)`` -- a deterministic seeded shuffle that never loads
the full eligible set into memory; Python-side choices use
``random.Random(20261111)``. Same inputs -> same suites.

B-mask / B-open sampling (weighted to the real ISBN-less profile, §3.4's
hazard note: masked books are otherwise younger / more-English /
metadata-richer than real ISBN-less books):

* Eligible editions: >= 1 ISBN-13, and their work has >= 2 editions.
* Each eligible edition falls in one bucket, weighted x3 for each of the
  two ISBN-less traits (multiplicative, so both traits = x9):

  ============ ====== ==========================
  bucket       weight definition
  ============ ====== ==========================
  pre1990_zh   9      publish_year < 1990 and chi/zho
  pre1990      3      publish_year < 1990
  zh           3      chi/zho (year >= 1990 or NULL)
  modern       1      everything else
  ============ ====== ==========================

  A NULL publish_year counts as not-pre-1990. Quotas are proportional to
  weight x bucket population, capped at the population, with any
  remainder redistributed to buckets with spare capacity (same weights).
* B-open uses the identical recipe over works NOT in the slice, and --
  where the pool allows -- works disjoint from B-mask's, so no work is
  simultaneously a present-answer and an absent-answer case.
* Columns (both suites): case_id, title, subtitle, author_keys (via the
  work), publish_year, publishers, number_of_pages, languages,
  true_edition_key, true_work_key, isbn_masked (= true). Title etc. are
  the EDITION's fields -- what a merchant listing would show.

B-pairs strata (first matching rule wins, in this order):
``volumes`` if either title matches
``vol\\.|volume|part|上|下|第.+卷|册``; else ``translations`` if the two
editions' language sets differ; else ``companions`` if either title
matches ``导读|解读|study guide|summary|workbook|companion`` (Latin
markers case-insensitive); else ``plain``. Positives are sampled as
random distinct edition pairs inside one work; hard negatives as random
edition pairs from two different works sharing the same first-listed
author key. Pair member order is normalised (key ascending) so pairs
de-duplicate as unordered pairs.

B-enzh: one case per work that has both an ``eng`` and a ``chi``/``zho``
edition (cap 1,000 works, hash-seeded selection); the case carries the
work's Chinese edition's fields with the ISBN masked, plus
``stratum = 'enzh'``. Columns are B-mask's plus ``stratum``.
"""

import argparse
import json
import os
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

SEED = 20261111

B_MASK_CASES = 5000
B_OPEN_CASES = 2000
B_PAIRS_PER_LABEL = 20000
B_ENZH_CASES = 1000

BUCKETS = ("pre1990_zh", "pre1990", "zh", "modern")
BUCKET_WEIGHTS = {"pre1990_zh": 9, "pre1990": 3, "zh": 3, "modern": 1}

# Volume markers for the B-pairs `volumes` stratum. Latin markers must
# be whole words ("part" inside "Departure"/"Party" is not a volume);
# CJK markers must be volume-specific contexts (bare 上/下 also fire on
# 上海, 上下五千年, ...). 册 alone stays: it is the volume counter and
# covers 上册/中册/下册 alike.
VOLUME_RE = re.compile(
    r"\bvol\.|\bvolumes?\b|\bparts?\b|上册|下册|上卷|下卷|上篇|下篇|第.+卷|册",
    re.IGNORECASE,
)
COMPANION_RE = re.compile(
    r"导读|解读|study guide|summary|workbook|companion", re.IGNORECASE
)

CASE_SCHEMA = pa.schema(
    [
        ("case_id", pa.string()),
        ("title", pa.string()),
        ("subtitle", pa.string()),
        ("author_keys", pa.list_(pa.string())),
        ("publish_year", pa.int64()),
        ("publishers", pa.list_(pa.string())),
        ("number_of_pages", pa.int64()),
        ("languages", pa.list_(pa.string())),
        ("true_edition_key", pa.string()),
        ("true_work_key", pa.string()),
        ("isbn_masked", pa.bool_()),
    ]
)
ENZH_SCHEMA = pa.schema(
    list(CASE_SCHEMA) + [("stratum", pa.string())]
)
PAIRS_SCHEMA = pa.schema(
    [
        ("case_id", pa.string()),
        ("edition_key_a", pa.string()),
        ("edition_key_b", pa.string()),
        ("label", pa.int64()),
        ("stratum", pa.string()),
    ]
)

BUCKET_CASE_SQL = """
    CASE
        WHEN e.publish_year IS NOT NULL AND e.publish_year < 1990
             AND (list_contains(e.languages, 'chi')
                  OR list_contains(e.languages, 'zho'))
            THEN 'pre1990_zh'
        WHEN e.publish_year IS NOT NULL AND e.publish_year < 1990
            THEN 'pre1990'
        WHEN list_contains(e.languages, 'chi')
             OR list_contains(e.languages, 'zho')
            THEN 'zh'
        ELSE 'modern'
    END
"""


def default_data_dir() -> Path:
    env = os.environ.get("DATA_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / "workspace" / "review-scratch" / "smart-bookstore-p4-data"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_progress(data_dir: Path, message: str) -> None:
    line = f"[{utc_now()}] benchmarks: {message}"
    print(line, flush=True)
    with open(data_dir / "progress.log", "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def sql_literal(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def connect(data_dir: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET threads=2")
    con.execute("SET memory_limit='3GB'")
    con.execute(f"SET temp_directory={sql_literal(data_dir)}")
    return con


def parquet(data_dir: Path, name: str) -> str:
    return f"read_parquet({sql_literal(data_dir / 'parquet' / name)})"


def allocate_quotas(counts: dict, target: int) -> dict:
    """Proportional quotas by weight x population, capped at population."""
    quotas = {bucket: 0 for bucket in BUCKETS}
    remaining = min(target, sum(counts.values()))
    active = [b for b in BUCKETS if counts.get(b, 0) > 0]
    while remaining > 0 and active:
        total_weight = sum(BUCKET_WEIGHTS[b] * counts[b] for b in active)
        progressed = False
        for bucket in list(active):
            share = remaining * BUCKET_WEIGHTS[bucket] * counts[bucket] / total_weight
            take = min(int(share), counts[bucket] - quotas[bucket])
            if take > 0:
                quotas[bucket] += take
                remaining -= take
                progressed = True
            if quotas[bucket] >= counts[bucket]:
                active.remove(bucket)
        if not progressed:
            # Fractional leftovers: hand them out one by one, heaviest first.
            for bucket in sorted(active, key=lambda b: -BUCKET_WEIGHTS[b]):
                if remaining <= 0:
                    break
                if quotas[bucket] < counts[bucket]:
                    quotas[bucket] += 1
                    remaining -= 1
                    progressed = True
            if not progressed:
                break
    return quotas


def eligible_bucket_counts(
    con: duckdb.DuckDBPyConnection, data_dir: Path, extra_where: str
) -> dict:
    """Bucket populations for the ISBN-13 / >= 2-edition eligibility pool."""
    rows = con.execute(
        f"""
        WITH work_edition_counts AS (
            SELECT work_key, count(*) AS n
            FROM {parquet(data_dir, 'editions.parquet')}
            WHERE work_key IS NOT NULL
            GROUP BY work_key
        )
        SELECT {BUCKET_CASE_SQL} AS bucket, count(*) AS n
        FROM {parquet(data_dir, 'editions.parquet')} e
        JOIN work_edition_counts c ON c.work_key = e.work_key
        WHERE e.isbn_13 IS NOT NULL
          AND len(e.isbn_13) >= 1
          AND c.n >= 2
          {extra_where}
        GROUP BY bucket
        """
    ).fetchall()
    counts = {bucket: 0 for bucket in BUCKETS}
    for bucket, n in rows:
        counts[bucket] = n
    return counts


def sample_masked_cases(
    con: duckdb.DuckDBPyConnection,
    data_dir: Path,
    target: int,
    extra_where: str,
    case_prefix: str,
    exclude_edition_keys_table: str | None,
) -> list:
    """Run the weighted bucket sampling; return case rows as dicts.

    ``extra_where`` is appended to both the bucket-count and the sampling
    queries (it may reference temp tables such as ``slice_keys`` /
    ``bmask_works`` registered by the caller). ``exclude_edition_keys_table``
    optionally names a temp table of edition keys to exclude.
    """
    counts = eligible_bucket_counts(con, data_dir, extra_where)
    quotas = allocate_quotas(counts, target)
    exclusion = ""
    if exclude_edition_keys_table:
        exclusion = f"AND e.key NOT IN (SELECT key FROM {exclude_edition_keys_table})"
    cases: list = []
    for bucket in BUCKETS:
        quota = quotas[bucket]
        if quota <= 0:
            continue
        rows = con.execute(
            f"""
            SELECT
                e.title, e.subtitle, w.author_keys, e.publish_year,
                e.publishers, e.number_of_pages, e.languages,
                e.key, e.work_key
            FROM {parquet(data_dir, 'editions.parquet')} e
            JOIN {parquet(data_dir, 'works.parquet')} w ON w.key = e.work_key
            JOIN (
                SELECT work_key, count(*) AS n
                FROM {parquet(data_dir, 'editions.parquet')}
                WHERE work_key IS NOT NULL
                GROUP BY work_key
            ) c ON c.work_key = e.work_key
            WHERE e.isbn_13 IS NOT NULL
              AND len(e.isbn_13) >= 1
              AND c.n >= 2
              AND ({BUCKET_CASE_SQL}) = '{bucket}'
              {extra_where}
              {exclusion}
            ORDER BY hash(e.key, {SEED})
            LIMIT {quota}
            """
        ).fetchall()
        for row in rows:
            cases.append(
                {
                    "title": row[0],
                    "subtitle": row[1],
                    "author_keys": list(row[2]) if row[2] else [],
                    "publish_year": row[3],
                    "publishers": list(row[4]) if row[4] else [],
                    "number_of_pages": row[5],
                    "languages": list(row[6]) if row[6] else [],
                    "true_edition_key": row[7],
                    "true_work_key": row[8],
                    "isbn_masked": True,
                }
            )
    # The hash ordering interleaves buckets deterministically; re-sort by
    # edition key so case_id assignment is stable and auditable.
    cases.sort(key=lambda case: case["true_edition_key"])
    for index, case in enumerate(cases, start=1):
        case["case_id"] = f"{case_prefix}-{index:06d}"
    return cases


def write_cases(cases: list, schema: pa.Schema, path: Path) -> None:
    columns = {
        field.name: pa.array(
            [case.get(field.name) for case in cases], type=field.type
        )
        for field in schema
    }
    pq.write_table(pa.table(columns, schema=schema), path)


def pair_stratum(title_a, title_b, languages_a, languages_b) -> str:
    """First matching stratum rule wins: volumes, translations, companions."""
    titles = [t or "" for t in (title_a, title_b)]
    if any(VOLUME_RE.search(t) for t in titles):
        return "volumes"
    if set(languages_a or []) != set(languages_b or []):
        return "translations"
    if any(COMPANION_RE.search(t) for t in titles):
        return "companions"
    return "plain"


def build_pairs(
    con: duckdb.DuckDBPyConnection, data_dir: Path, rng: random.Random
) -> list:
    """Sample positive and hard-negative edition pairs (see module docstring)."""
    # Bounded, hash-ordered pools keep memory sane on the full catalogue:
    # up to 40k multi-edition works for positives, and up to 20 editions
    # per first-author (over a bounded author pool) for negatives, are
    # more than enough raw material.
    # (Build fix, 2026-11-11: the first version fetched a list() per
    # work group for the whole catalogue and an unbounded per-author
    # edition pool — tens of millions of rows — and was OOM-killed.
    # Both pools are now selected by key in SQL first, then expanded.)
    candidate_works = con.execute(
        f"""
        SELECT work_key
        FROM {parquet(data_dir, 'editions.parquet')}
        WHERE work_key IS NOT NULL
        GROUP BY work_key
        HAVING count(*) >= 2
        ORDER BY hash(work_key, {SEED})
        LIMIT 40000
        """
    ).fetchall()
    con.execute("CREATE OR REPLACE TEMP TABLE pair_work_keys (key VARCHAR)")
    con.executemany(
        "INSERT INTO pair_work_keys VALUES (?)",
        [(row[0],) for row in candidate_works],
    )
    edition_rows = con.execute(
        f"""
        SELECT e.work_key, e.key
        FROM {parquet(data_dir, 'editions.parquet')} e
        JOIN pair_work_keys k ON k.key = e.work_key
        ORDER BY e.work_key, e.key
        """
    ).fetchall()
    editions_by_work: dict = {}
    for work_key, edition_key in edition_rows:
        editions_by_work.setdefault(work_key, []).append(edition_key)
    work_rows = [
        (work_key, keys)
        for work_key, keys in sorted(editions_by_work.items())
        if len(keys) >= 2
    ]

    positives: set = set()
    attempts = 0
    while len(positives) < B_PAIRS_PER_LABEL and attempts < B_PAIRS_PER_LABEL * 20:
        attempts += 1
        _work_key, edition_keys = work_rows[rng.randrange(len(work_rows))]
        key_a, key_b = rng.sample(list(edition_keys), 2)
        positives.add(tuple(sorted((key_a, key_b))))

    author_rows = con.execute(
        f"""
        WITH edition_authors AS (
            SELECT
                e.key AS edition_key,
                e.work_key,
                list_extract(w.author_keys, 1) AS first_author,
                row_number() OVER (
                    PARTITION BY list_extract(w.author_keys, 1)
                    ORDER BY hash(e.key, {SEED})
                ) AS rn
            FROM {parquet(data_dir, 'editions.parquet')} e
            JOIN {parquet(data_dir, 'works.parquet')} w ON w.key = e.work_key
            WHERE w.author_keys IS NOT NULL AND len(w.author_keys) >= 1
        ),
        author_work_counts AS (
            SELECT first_author, count(DISTINCT work_key) AS n_works
            FROM edition_authors
            GROUP BY first_author
        ),
        candidate_authors AS (
            SELECT first_author
            FROM author_work_counts
            WHERE n_works >= 2
            ORDER BY hash(first_author, {SEED})
            LIMIT 30000
        )
        SELECT a.first_author, a.edition_key, a.work_key
        FROM edition_authors a
        JOIN candidate_authors c ON c.first_author = a.first_author
        WHERE a.rn <= 20
        """
    ).fetchall()
    by_author: dict = {}
    for first_author, edition_key, work_key in author_rows:
        by_author.setdefault(first_author, []).append((edition_key, work_key))
    authors = [a for a, rows in by_author.items() if len({w for _, w in rows}) >= 2]

    negatives: set = set()
    attempts = 0
    while len(negatives) < B_PAIRS_PER_LABEL and attempts < B_PAIRS_PER_LABEL * 20:
        attempts += 1
        rows = by_author[authors[rng.randrange(len(authors))]]
        (key_a, work_a), (key_b, work_b) = rng.sample(rows, 2)
        if work_a == work_b or key_a == key_b:
            continue
        pair = tuple(sorted((key_a, key_b)))
        if pair not in positives:
            negatives.add(pair)

    needed_keys = {key for pair in positives | negatives for key in pair}
    edition_info = fetch_edition_info(con, data_dir, needed_keys)

    pairs: list = []
    for label, pool in ((1, sorted(positives)), (0, sorted(negatives))):
        for key_a, key_b in pool:
            info_a = edition_info.get(key_a, {})
            info_b = edition_info.get(key_b, {})
            pairs.append(
                {
                    "edition_key_a": key_a,
                    "edition_key_b": key_b,
                    "label": label,
                    "stratum": pair_stratum(
                        info_a.get("title"),
                        info_b.get("title"),
                        info_a.get("languages"),
                        info_b.get("languages"),
                    ),
                }
            )
    rng.shuffle(pairs)
    for index, pair in enumerate(pairs, start=1):
        pair["case_id"] = f"bpairs-{index:06d}"
    return pairs


def fetch_edition_info(
    con: duckdb.DuckDBPyConnection, data_dir: Path, keys: set
) -> dict:
    """Titles/languages for exactly ``keys`` (the B-pairs union, <= 80k)."""
    if not keys:
        return {}
    con.execute("CREATE OR REPLACE TEMP TABLE pair_keys (key VARCHAR)")
    con.executemany(
        "INSERT INTO pair_keys VALUES (?)", [(key,) for key in sorted(keys)]
    )
    rows = con.execute(
        f"""
        SELECT e.key, e.title, e.languages
        FROM {parquet(data_dir, 'editions.parquet')} e
        JOIN pair_keys k ON k.key = e.key
        """
    ).fetchall()
    return {
        key: {"title": title, "languages": list(languages) if languages else []}
        for key, title, languages in rows
    }


def build_enzh(con: duckdb.DuckDBPyConnection, data_dir: Path) -> list:
    """One masked Chinese-edition case per EN+ZH work (cap 1,000)."""
    rows = con.execute(
        f"""
        WITH work_languages AS (
            SELECT
                work_key,
                coalesce(bool_or(list_contains(languages, 'eng')), false) AS has_eng,
                coalesce(
                    bool_or(
                        list_contains(languages, 'chi')
                        OR list_contains(languages, 'zho')
                    ),
                    false
                ) AS has_zh
            FROM {parquet(data_dir, 'editions.parquet')}
            WHERE work_key IS NOT NULL
            GROUP BY work_key
        ),
        eligible AS (
            SELECT work_key FROM work_languages
            WHERE has_eng AND has_zh
            ORDER BY hash(work_key, {SEED})
            LIMIT {B_ENZH_CASES}
        ),
        zh_editions AS (
            SELECT
                e.*,
                row_number() OVER (
                    PARTITION BY e.work_key ORDER BY hash(e.key, {SEED})
                ) AS rn
            FROM {parquet(data_dir, 'editions.parquet')} e
            JOIN eligible el ON el.work_key = e.work_key
            WHERE list_contains(e.languages, 'chi')
               OR list_contains(e.languages, 'zho')
        )
        SELECT
            z.title, z.subtitle, w.author_keys, z.publish_year,
            z.publishers, z.number_of_pages, z.languages,
            z.key, z.work_key
        FROM zh_editions z
        JOIN {parquet(data_dir, 'works.parquet')} w ON w.key = z.work_key
        WHERE z.rn = 1
        ORDER BY z.work_key
        """
    ).fetchall()
    cases = []
    for index, row in enumerate(rows, start=1):
        cases.append(
            {
                "case_id": f"benzh-{index:06d}",
                "title": row[0],
                "subtitle": row[1],
                "author_keys": list(row[2]) if row[2] else [],
                "publish_year": row[3],
                "publishers": list(row[4]) if row[4] else [],
                "number_of_pages": row[5],
                "languages": list(row[6]) if row[6] else [],
                "true_edition_key": row[7],
                "true_work_key": row[8],
                "isbn_masked": True,
                "stratum": "enzh",
            }
        )
    return cases


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=None)
    args = parser.parse_args(argv)
    data_dir = (args.data_dir or default_data_dir()).expanduser()
    bench_dir = data_dir / "parquet" / "benchmarks"
    bench_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "out").mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)

    log_progress(data_dir, f"start: seed={SEED}")
    con = connect(data_dir)

    # --- B-mask: from the full catalogue (slice membership irrelevant). ---
    b_mask = sample_masked_cases(
        con, data_dir, B_MASK_CASES, "", "bmask", None
    )
    write_cases(b_mask, CASE_SCHEMA, bench_dir / "b_mask.parquet")
    log_progress(data_dir, f"B-mask: {len(b_mask)} cases written")
    b_mask_works = {case["true_work_key"] for case in b_mask}

    # Register exclusion temp tables for B-open: B-mask's editions may
    # not be reused, and its works are excluded by preference (below).
    con.execute("CREATE OR REPLACE TEMP TABLE excluded_editions (key VARCHAR)")
    con.executemany(
        "INSERT INTO excluded_editions VALUES (?)",
        [(case["true_edition_key"],) for case in b_mask],
    )
    con.execute("CREATE OR REPLACE TEMP TABLE bmask_works (key VARCHAR)")
    con.executemany(
        "INSERT INTO bmask_works VALUES (?)",
        [(key,) for key in sorted(b_mask_works)],
    )

    # --- B-open: true works outside the slice (and, where possible,
    # disjoint from B-mask's works). Both exclusions are temp-table
    # anti-joins referenced from the sampling queries. ---
    con.execute("CREATE OR REPLACE TEMP TABLE slice_keys (key VARCHAR)")
    slice_rows = con.execute(
        f"SELECT key FROM {parquet(data_dir, 'slice_works.parquet')}"
    ).fetchall()
    con.executemany(
        "INSERT INTO slice_keys VALUES (?)", [(row[0],) for row in slice_rows]
    )
    open_where = (
        "AND e.work_key NOT IN (SELECT key FROM slice_keys) "
        "AND e.work_key NOT IN (SELECT key FROM bmask_works)"
    )
    b_open = sample_masked_cases(
        con, data_dir, B_OPEN_CASES, open_where, "bopen", "excluded_editions"
    )
    if len(b_open) < B_OPEN_CASES:
        # Pool exhausted under the disjointness preference: top up with
        # works that are merely outside the slice (still a valid absent
        # answer) rather than shipping a short suite silently. B-open's
        # own editions join the exclusion table first so the top-up
        # cannot re-sample them.
        log_progress(
            data_dir,
            f"B-open: disjoint pool gave {len(b_open)}; topping up from "
            "non-slice works only",
        )
        con.executemany(
            "INSERT INTO excluded_editions VALUES (?)",
            [(case["true_edition_key"],) for case in b_open],
        )
        top_up = sample_masked_cases(
            con,
            data_dir,
            B_OPEN_CASES - len(b_open),
            "AND e.work_key NOT IN (SELECT key FROM slice_keys)",
            "bopen",
            "excluded_editions",
        )
        seen = {case["true_edition_key"] for case in b_open}
        for case in top_up:
            if case["true_edition_key"] not in seen:
                b_open.append(case)
        b_open.sort(key=lambda case: case["true_edition_key"])
        for index, case in enumerate(b_open, start=1):
            case["case_id"] = f"bopen-{index:06d}"
    write_cases(b_open, CASE_SCHEMA, bench_dir / "b_open.parquet")
    excluded_path = data_dir / "out" / "bopen_excluded_work_keys.txt"
    excluded_path.write_text(
        "".join(
            key + "\n"
            for key in sorted({case["true_work_key"] for case in b_open})
        ),
        encoding="utf-8",
    )
    log_progress(
        data_dir,
        f"B-open: {len(b_open)} cases written; "
        f"excluded work keys -> {excluded_path.name}",
    )

    # --- B-pairs and B-enzh. ---
    pairs = build_pairs(con, data_dir, rng)
    write_cases(pairs, PAIRS_SCHEMA, bench_dir / "b_pairs.parquet")
    n_positive = sum(1 for pair in pairs if pair["label"] == 1)
    log_progress(
        data_dir,
        f"B-pairs: {len(pairs)} pairs written "
        f"({n_positive} positive / {len(pairs) - n_positive} negative)",
    )

    b_enzh = build_enzh(con, data_dir)
    write_cases(b_enzh, ENZH_SCHEMA, bench_dir / "b_enzh.parquet")
    log_progress(data_dir, f"B-enzh: {len(b_enzh)} cases written")

    manifest = {
        "generated_at": utc_now(),
        "seed": SEED,
        "suites": {
            "b_mask": {
                "rows": len(b_mask),
                "file": "parquet/benchmarks/b_mask.parquet",
                "notes": (
                    "Editions with >= 1 ISBN-13 whose work has >= 2 editions; "
                    "ISBN values withheld (isbn_masked=true). Weighted bucket "
                    "sampling toward the real ISBN-less profile: buckets "
                    "pre1990_zh x9, pre1990 x3, zh x3, modern x1 "
                    "(weight x population quotas, hash(key, seed) ordering)."
                ),
            },
            "b_open": {
                "rows": len(b_open),
                "file": "parquet/benchmarks/b_open.parquet",
                "notes": (
                    "Same recipe and weighting as B-mask, restricted to works "
                    "NOT in slice_works (answer absent from the reference "
                    "slice); works disjoint from B-mask's where the pool "
                    "allows. True work keys listed in "
                    "out/bopen_excluded_work_keys.txt."
                ),
            },
            "b_pairs": {
                "rows": len(pairs),
                "positives": n_positive,
                "negatives": len(pairs) - n_positive,
                "file": "parquet/benchmarks/b_pairs.parquet",
                "notes": (
                    "Positives: distinct edition pairs sharing a work_key. "
                    "Hard negatives: edition pairs from different works "
                    "sharing the same first-listed author_key. Stratum by "
                    "first matching rule: volumes -> translations -> "
                    "companions -> plain (see module docstring)."
                ),
            },
            "b_enzh": {
                "rows": len(b_enzh),
                "file": "parquet/benchmarks/b_enzh.parquet",
                "notes": (
                    "One case per work (cap 1,000, hash-seeded work "
                    "selection) having both eng and chi/zho editions; the "
                    "case carries a Chinese edition's fields, ISBN masked, "
                    "stratum='enzh'."
                ),
            },
        },
    }
    manifest_path = data_dir / "out" / "benchmarks_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    log_progress(data_dir, f"manifest written: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
