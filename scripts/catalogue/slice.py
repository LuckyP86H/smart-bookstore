"""Select the adversarial Postgres slice from the full Open Library Parquet.

Implements P4-BOOKS-FINAL-PLAN.md §4.3 (slice composition) and §9 Step 1.

Inputs (all under ``$DATA_DIR/parquet/``, produced by the dump -> Parquet
pipeline; ``DATA_DIR`` defaults to
``~/workspace/review-scratch/smart-bookstore-p4-data``):

* ``authors.parquet``   -- key, name, personal_name, birth_date, death_date,
  alternate_names, wikidata_id
* ``works.parquet``     -- key, title, subtitle, first_publish_date,
  first_publish_year, subjects, author_keys
* ``editions.parquet``  -- key, work_key, title, subtitle, isbn_10, isbn_13,
  languages, publish_date, publish_year, publishers, number_of_pages,
  oclc_numbers, lccn, edition_name, series
* ``isbn_map.parquet``  -- isbn13, isbn_raw, edition_key, work_key
  (read only for the ISBN-index statistics recorded in the manifest)
* ``$DATA_DIR/out/shelf_work_keys.txt`` -- optional, one work key per line
  (the owner's shelf, stratum ``shelf``); absence is fine.

Outputs:

* ``$DATA_DIR/parquet/slice_works.parquet``   -- work columns + ``strata``
  (``list<string>`` naming every stratum the work was selected under)
* ``$DATA_DIR/parquet/slice_editions.parquet`` -- edition columns, slice works
* ``$DATA_DIR/parquet/slice_authors.parquet``  -- author columns for every
  author key referenced by a slice work
* ``$DATA_DIR/out/slice_manifest.json`` -- snapshot-independent counts:
  per-stratum work counts (pre- and post-trim), total works / editions /
  authors, Parquet bytes per output, ISBN-index statistics, ``generated_at``.

Selection (plan §4.3; target ~5,000 works / ~20,000 editions):

* ``many_editions``        -- top 1,500 works by edition count.
* ``collisions``           -- normalised titles (lower-cased, punctuation
  folded to spaces, whitespace collapsed) shared by >= 3 distinct works;
  all works in those title groups, capped at ~800 works, preferring the
  largest title groups first.
* ``en_zh``                -- works with >= 1 ``eng`` edition and >= 1
  ``chi``/``zho`` edition; capped at ~1,200 (weighted up per the plan),
  preferring higher edition counts.
* ``reprint_chains``       -- works with >= 8 editions spanning >= 20 years
  of ``publish_year``; capped at ~600, preferring longer spans.
* ``null_isbn_pre1987_zh`` -- works with >= 1 edition carrying no ISBN at
  all (both ISBN lists empty), language ``chi``/``zho`` and
  ``publish_year < 1987``; capped at ~800.
* ``canon``                -- works whose first-listed author has a death
  year <= 1928 (first 4-digit year parsed from ``authors.death_date``)
  and edition count >= 5; capped at ~600.
* ``shelf``                -- every key in ``shelf_work_keys.txt`` if present.

Trim rule (documented choice where the plan gives a target, not an
algorithm): strata are unioned and de-duplicated. If the union exceeds
5,500 works it is trimmed to 5,000 by keeping, in order: (1) all ``shelf``
works -- B-shelf is hand-checked ground truth and is never trimmed away;
(2) works belonging to more strata first; (3) higher edition counts;
(4) work key ascending as the deterministic tie-break.

Edition cap rule: all editions of slice works are kept unless the total
exceeds 20,000. ISBN-bearing-first ordering is deliberately NOT used (the
plan warns it would destroy exactly the ISBN-less strata this slice
exists to exercise). Instead each work gets a quota proportional to its
edition count (minimum 1), and within a work editions are sorted by
``(publish_year, key)`` and an evenly-spaced subset is taken, so reprint
chains keep their early, middle and late editions.

Determinism: every ranking ends in a unique key tie-break and every
Parquet COPY is ``ORDER BY``-ed, so the same inputs reproduce the same
slice. DuckDB is capped per the VM stability rules (threads=2,
memory_limit='3GB', temp_directory=$DATA_DIR).
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb

TARGET_WORKS = 5000
TRIM_TRIGGER = 5500
TARGET_EDITIONS = 20000

CAP_MANY_EDITIONS = 1500
CAP_COLLISIONS = 800
CAP_EN_ZH = 1200
CAP_REPRINT_CHAINS = 600
CAP_NULL_ISBN = 800
CAP_CANON = 600

STRATA = (
    "many_editions",
    "collisions",
    "en_zh",
    "reprint_chains",
    "null_isbn_pre1987_zh",
    "canon",
    "shelf",
)


def default_data_dir() -> Path:
    """Return $DATA_DIR, defaulting to the P4 data directory."""
    env = os.environ.get("DATA_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / "workspace" / "review-scratch" / "smart-bookstore-p4-data"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_progress(data_dir: Path, message: str) -> None:
    """Append one timestamped line to progress.log and echo it."""
    line = f"[{utc_now()}] slice: {message}"
    print(line, flush=True)
    with open(data_dir / "progress.log", "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def sql_literal(path: Path) -> str:
    """Quote a filesystem path as a SQL string literal."""
    return "'" + str(path).replace("'", "''") + "'"


def connect(data_dir: Path) -> duckdb.DuckDBPyConnection:
    """Open DuckDB with the VM stability caps from the plan (§15, PR 1)."""
    con = duckdb.connect()
    con.execute("SET threads=2")
    con.execute("SET memory_limit='3GB'")
    con.execute(f"SET temp_directory={sql_literal(data_dir)}")
    return con


def parquet(data_dir: Path, name: str) -> str:
    return f"read_parquet({sql_literal(data_dir / 'parquet' / name)})"


def build_edition_stats(con: duckdb.DuckDBPyConnection, data_dir: Path) -> int:
    """Aggregate per-work edition statistics used by several strata.

    The result stays in DuckDB as the temp table ``edition_stats``
    (work_key, edition_count, min_year, max_year, has_eng, has_zh) and
    selectors query it with capped SQL. Returns the number of works
    with at least one edition.

    (Build fix, 2026-11-11: the first version materialised this as a
    Python dict of ~40M entries and was OOM-killed at ~6 GB RSS. The
    aggregation itself is DuckDB-side and spills under the memory cap;
    only the Python materialisation was unbounded.)
    """
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE edition_stats AS
        SELECT
            work_key,
            count(*) AS edition_count,
            min(publish_year) AS min_year,
            max(publish_year) AS max_year,
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
        """
    )
    return con.execute("SELECT count(*) FROM edition_stats").fetchone()[0]


def select_many_editions(con: duckdb.DuckDBPyConnection) -> list:
    rows = con.execute(
        f"""
        SELECT work_key FROM edition_stats
        ORDER BY edition_count DESC, work_key ASC
        LIMIT {CAP_MANY_EDITIONS}
        """
    ).fetchall()
    return [row[0] for row in rows]


def select_collisions(con: duckdb.DuckDBPyConnection, data_dir: Path) -> list:
    """Works whose normalised title is shared by >= 3 distinct works.

    Normalisation: lower-case, every run of non-letter/non-digit characters
    folded to a single space, whitespace collapsed, trimmed. Groups are
    taken largest-first until the ~800-work cap is reached; a group is
    never split, so the cap may be exceeded by one group's size.
    """
    cursor = con.execute(
        f"""
        WITH normalised AS (
            SELECT
                key,
                trim(
                    regexp_replace(
                        regexp_replace(
                            lower(coalesce(title, '')),
                            '[^\\p{{L}}\\p{{N}}]+', ' ', 'g'
                        ),
                        '\\s+', ' ', 'g'
                    )
                ) AS norm_title
            FROM {parquet(data_dir, 'works.parquet')}
        )
        SELECT norm_title, list(key ORDER BY key) AS work_keys, count(*) AS n
        FROM normalised
        WHERE norm_title <> ''
        GROUP BY norm_title
        HAVING count(*) >= 3
        ORDER BY n DESC, norm_title ASC
        """
    )
    # Stream the groups: the full group list can be ~1M rows, and only
    # the largest groups up to the cap are needed.
    selected: list = []
    while len(selected) < CAP_COLLISIONS:
        batch = cursor.fetchmany(5000)
        if not batch:
            break
        for _norm_title, work_keys, _n in batch:
            if len(selected) >= CAP_COLLISIONS:
                break
            selected.extend(work_keys)
    return selected


def select_en_zh(con: duckdb.DuckDBPyConnection) -> list:
    rows = con.execute(
        f"""
        SELECT work_key FROM edition_stats
        WHERE has_eng AND has_zh
        ORDER BY edition_count DESC, work_key ASC
        LIMIT {CAP_EN_ZH}
        """
    ).fetchall()
    return [row[0] for row in rows]


def select_reprint_chains(con: duckdb.DuckDBPyConnection) -> list:
    rows = con.execute(
        f"""
        SELECT work_key FROM edition_stats
        WHERE edition_count >= 8
          AND min_year IS NOT NULL AND max_year IS NOT NULL
          AND max_year - min_year >= 20
        ORDER BY (max_year - min_year) DESC, edition_count DESC,
                 work_key ASC
        LIMIT {CAP_REPRINT_CHAINS}
        """
    ).fetchall()
    return [row[0] for row in rows]


def select_null_isbn(con: duckdb.DuckDBPyConnection, data_dir: Path) -> list:
    """Works with >= 1 ISBN-less chi/zho edition published before 1987."""
    rows = con.execute(
        f"""
        SELECT work_key, count(*) AS matching_editions
        FROM {parquet(data_dir, 'editions.parquet')}
        WHERE work_key IS NOT NULL
          AND (isbn_10 IS NULL OR len(isbn_10) = 0)
          AND (isbn_13 IS NULL OR len(isbn_13) = 0)
          AND (
              list_contains(languages, 'chi')
              OR list_contains(languages, 'zho')
          )
          AND publish_year IS NOT NULL
          AND publish_year < 1987
        GROUP BY work_key
        ORDER BY matching_editions DESC, work_key ASC
        LIMIT {CAP_NULL_ISBN}
        """
    ).fetchall()
    return [row[0] for row in rows]


def select_canon(con: duckdb.DuckDBPyConnection, data_dir: Path) -> list:
    """Works whose first-listed author died in or before 1928, >= 5 editions.

    The death year is the first 4-digit year found in ``authors.death_date``
    (the field mixes '1928', '1928-05-01' and '1 May 1928' shapes).
    All filtering happens in SQL (the first version fetched every
    death-dated work into Python and filtered there).
    """
    rows = con.execute(
        f"""
        SELECT w.key AS work_key
        FROM {parquet(data_dir, 'works.parquet')} w
        JOIN {parquet(data_dir, 'authors.parquet')} a
          ON a.key = list_extract(w.author_keys, 1)
        JOIN edition_stats s ON s.work_key = w.key
        WHERE w.author_keys IS NOT NULL
          AND len(w.author_keys) >= 1
          AND a.death_date IS NOT NULL
          AND try_cast(
                regexp_extract(a.death_date, '([0-9]{{4}})', 1) AS INTEGER
              ) <= 1928
          AND s.edition_count >= 5
        ORDER BY s.edition_count DESC, w.key ASC
        LIMIT {CAP_CANON}
        """
    ).fetchall()
    return [row[0] for row in rows]


def select_shelf(data_dir: Path) -> list:
    path = data_dir / "out" / "shelf_work_keys.txt"
    if not path.exists():
        return []
    keys = []
    for line in path.read_text(encoding="utf-8").splitlines():
        key = line.strip()
        if key and not key.startswith("#"):
            keys.append(key)
    return keys


def trim_union(tags: dict, counts: dict) -> dict:
    """Apply the documented trim rule if the union exceeds TRIM_TRIGGER.

    ``counts`` maps work_key -> edition_count for the union's keys only
    (fetched from edition_stats by the caller, and only when a trim is
    actually needed).
    """
    if len(tags) <= TRIM_TRIGGER:
        return tags
    shelf = {key for key, strata in tags.items() if "shelf" in strata}
    rest = [key for key in tags if key not in shelf]
    rest.sort(
        key=lambda key: (
            -len(tags[key]),
            -counts.get(key, 0),
            key,
        )
    )
    keep = set(shelf) | set(rest[: max(0, TARGET_WORKS - len(shelf))])
    return {key: tags[key] for key in keep}


def evenly_spaced(sorted_keys: list, quota: int) -> list:
    """Take ``quota`` evenly spaced items from an already-sorted list."""
    n = len(sorted_keys)
    if quota >= n:
        return list(sorted_keys)
    if quota <= 1:
        return [sorted_keys[n // 2]]
    indices = sorted({round(i * (n - 1) / (quota - 1)) for i in range(quota)})
    return [sorted_keys[i] for i in indices]


def plan_edition_quotas(counts: dict, cap: int) -> dict:
    """Proportional per-work edition quotas (minimum 1) summing to <= cap.

    Each work starts at its floored fair share, clamped to its own
    edition count (a quota never exceeds the editions the work has);
    the remainder is then distributed one edition at a time to the
    work furthest below its fair share. Degenerate case: when
    cap < number of works, the minimum-1 rule wins and the sum is the
    work count — minimum 1 and sum <= cap cannot both hold there.
    """
    total = sum(counts.values())
    quotas = {
        key: min(n, max(1, (cap * n) // total)) for key, n in counts.items()
    }
    # Reduce from the largest quotas if the minimum-1 rule overshot the cap.
    while sum(quotas.values()) > cap:
        key = max(quotas, key=lambda k: (quotas[k], k))
        if quotas[key] <= 1:
            break
        quotas[key] -= 1
    # Distribute the remainder to the works furthest below their fair share.
    while sum(quotas.values()) < cap:
        candidates = [k for k in quotas if quotas[k] < counts[k]]
        if not candidates:
            break
        key = max(
            candidates,
            key=lambda k: (cap * counts[k] / total - quotas[k], k),
        )
        quotas[key] += 1
    return quotas


def select_edition_keys(
    con: duckdb.DuckDBPyConnection, data_dir: Path, work_keys: list
) -> list:
    """All editions of slice works, evenly-spaced thinned to the cap."""
    con.execute("CREATE OR REPLACE TEMP TABLE slice_work_keys (key VARCHAR)")
    con.executemany(
        "INSERT INTO slice_work_keys VALUES (?)", [(k,) for k in work_keys]
    )
    rows = con.execute(
        f"""
        SELECT e.key, e.work_key, e.publish_year
        FROM {parquet(data_dir, 'editions.parquet')} e
        JOIN slice_work_keys s ON s.key = e.work_key
        ORDER BY e.work_key, e.publish_year NULLS LAST, e.key
        """
    ).fetchall()
    if len(rows) <= TARGET_EDITIONS:
        return [row[0] for row in rows]
    by_work: dict = {}
    for edition_key, work_key, _year in rows:
        by_work.setdefault(work_key, []).append(edition_key)
    quotas = plan_edition_quotas(
        {key: len(keys) for key, keys in by_work.items()}, TARGET_EDITIONS
    )
    kept: list = []
    for work_key in sorted(by_work):
        kept.extend(evenly_spaced(by_work[work_key], quotas[work_key]))
    return kept


def write_outputs(
    con: duckdb.DuckDBPyConnection,
    data_dir: Path,
    tags: dict,
    edition_keys: list,
) -> dict:
    """Write the three slice Parquet files; return their byte sizes."""
    parquet_dir = data_dir / "parquet"
    con.execute(
        "CREATE OR REPLACE TEMP TABLE slice_final "
        "(key VARCHAR, strata VARCHAR[])"
    )
    con.executemany(
        "INSERT INTO slice_final VALUES (?, ?)",
        [(key, sorted(tags[key])) for key in sorted(tags)],
    )
    con.execute("CREATE OR REPLACE TEMP TABLE slice_edition_keys (key VARCHAR)")
    con.executemany(
        "INSERT INTO slice_edition_keys VALUES (?)",
        [(k,) for k in edition_keys],
    )
    works_out = parquet_dir / "slice_works.parquet"
    editions_out = parquet_dir / "slice_editions.parquet"
    authors_out = parquet_dir / "slice_authors.parquet"
    con.execute(
        f"""
        COPY (
            SELECT w.*, f.strata
            FROM {parquet(data_dir, 'works.parquet')} w
            JOIN slice_final f ON f.key = w.key
            ORDER BY w.key
        ) TO {sql_literal(works_out)} (FORMAT PARQUET)
        """
    )
    con.execute(
        f"""
        COPY (
            SELECT e.*
            FROM {parquet(data_dir, 'editions.parquet')} e
            JOIN slice_edition_keys k ON k.key = e.key
            ORDER BY e.work_key, e.publish_year NULLS LAST, e.key
        ) TO {sql_literal(editions_out)} (FORMAT PARQUET)
        """
    )
    con.execute(
        f"""
        COPY (
            SELECT a.*
            FROM {parquet(data_dir, 'authors.parquet')} a
            WHERE a.key IN (
                SELECT DISTINCT unnest(w.author_keys)
                FROM {parquet(data_dir, 'works.parquet')} w
                JOIN slice_final f ON f.key = w.key
                WHERE w.author_keys IS NOT NULL
            )
            ORDER BY a.key
        ) TO {sql_literal(authors_out)} (FORMAT PARQUET)
        """
    )
    return {
        "slice_works.parquet": works_out.stat().st_size,
        "slice_editions.parquet": editions_out.stat().st_size,
        "slice_authors.parquet": authors_out.stat().st_size,
    }


def count_rows(con: duckdb.DuckDBPyConnection, data_dir: Path, name: str) -> int:
    return con.execute(
        f"SELECT count(*) FROM {parquet(data_dir, name)}"
    ).fetchone()[0]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=None)
    args = parser.parse_args(argv)
    data_dir = (args.data_dir or default_data_dir()).expanduser()
    (data_dir / "out").mkdir(parents=True, exist_ok=True)
    (data_dir / "parquet").mkdir(parents=True, exist_ok=True)

    log_progress(data_dir, "start: building edition statistics")
    con = connect(data_dir)
    n_stats = build_edition_stats(con, data_dir)
    log_progress(data_dir, f"edition statistics: {n_stats} works with editions")

    selectors = [
        ("many_editions", lambda: select_many_editions(con)),
        ("collisions", lambda: select_collisions(con, data_dir)),
        ("en_zh", lambda: select_en_zh(con)),
        ("reprint_chains", lambda: select_reprint_chains(con)),
        ("null_isbn_pre1987_zh", lambda: select_null_isbn(con, data_dir)),
        ("canon", lambda: select_canon(con, data_dir)),
        ("shelf", lambda: select_shelf(data_dir)),
    ]
    tags: dict = {}
    pre_trim_counts: dict = {}
    for name, selector in selectors:
        keys = selector()
        pre_trim_counts[name] = len(set(keys))
        for key in keys:
            tags.setdefault(key, set()).add(name)
        log_progress(
            data_dir,
            f"stratum {name}: {pre_trim_counts[name]} works "
            f"(union so far {len(tags)})",
        )

    pre_trim_union = len(tags)
    counts: dict = {}
    if len(tags) > TRIM_TRIGGER:
        con.execute(
            "CREATE OR REPLACE TEMP TABLE union_keys (key VARCHAR)")
        con.executemany(
            "INSERT INTO union_keys VALUES (?)", [(k,) for k in tags])
        counts = dict(con.execute(
            """
            SELECT s.work_key, s.edition_count
            FROM edition_stats s
            JOIN union_keys u ON u.key = s.work_key
            """
        ).fetchall())
    tags = trim_union(tags, counts)
    post_trim_counts = {
        name: sum(1 for strata in tags.values() if name in strata)
        for name in STRATA
    }
    log_progress(
        data_dir,
        f"union after trim: {len(tags)} works "
        f"(pre-trim union {pre_trim_union}; "
        f"per-stratum post-trim {post_trim_counts})",
    )

    work_keys = sorted(tags)
    edition_keys = select_edition_keys(con, data_dir, work_keys)
    log_progress(
        data_dir,
        f"editions selected: {len(edition_keys)} "
        f"(cap {TARGET_EDITIONS}, evenly-spaced per work by publish_year)",
    )

    sizes = write_outputs(con, data_dir, tags, edition_keys)
    total_works = count_rows(con, data_dir, "slice_works.parquet")
    total_editions = count_rows(con, data_dir, "slice_editions.parquet")
    total_authors = count_rows(con, data_dir, "slice_authors.parquet")
    isbn_rows = count_rows(con, data_dir, "isbn_map.parquet")
    isbn_distinct = con.execute(
        f"SELECT count(DISTINCT isbn13) FROM {parquet(data_dir, 'isbn_map.parquet')}"
    ).fetchone()[0]
    log_progress(
        data_dir,
        f"wrote slice: works={total_works} editions={total_editions} "
        f"authors={total_authors}",
    )

    manifest = {
        "generated_at": utc_now(),
        "target_works": TARGET_WORKS,
        "target_editions": TARGET_EDITIONS,
        "trim_trigger": TRIM_TRIGGER,
        "trim_rule": (
            "If the strata union exceeds 5,500 works, keep all shelf works, "
            "then works in more strata, then higher edition counts, then "
            "work key ascending, down to 5,000 works."
        ),
        "edition_cap_rule": (
            "All editions of slice works unless the total exceeds 20,000; "
            "then per-work quotas proportional to edition count (minimum 1) "
            "with evenly-spaced picks over editions sorted by "
            "(publish_year, key). ISBN-bearing-first ordering is not used."
        ),
        "strata_counts_pre_trim": pre_trim_counts,
        "union_works_pre_trim": pre_trim_union,
        "strata_counts": post_trim_counts,
        "total_works": total_works,
        "total_editions": total_editions,
        "total_authors": total_authors,
        "parquet_bytes": sizes,
        "isbn_index": {
            "isbn_map_rows": isbn_rows,
            "distinct_isbn13": isbn_distinct,
        },
    }
    manifest_path = data_dir / "out" / "slice_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    log_progress(data_dir, f"manifest written: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
