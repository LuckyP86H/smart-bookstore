"""Measure the two §9 Step 1 baselines and render BASELINES.md.

Implements P4-BOOKS-FINAL-PLAN.md §9 Step 1: before any identity-engine
code exists, two baselines are measured against the §3.4 suites so every
later number has something honest to beat. All numbers are computed from
the Parquet inputs at run time; none are hard-coded.

Reference catalogue (what "the reference" means in PR 1):
``slice_works.parquet`` + ``slice_editions.parquet`` under
``$DATA_DIR/parquet/``.

Inputs:

* ``$DATA_DIR/parquet/slice_works.parquet`` / ``slice_editions.parquet``
* ``$DATA_DIR/parquet/benchmarks/b_mask.parquet`` (5,000 cases),
  ``b_open.parquet`` (2,000 cases), ``b_pairs.parquet`` (40,000 pairs)
* ``$DATA_DIR/parquet/editions.parquet`` + ``isbn_map.parquet`` (for the
  Path A control and B-pairs titles)
* ``$DATA_DIR/out/slice_manifest.json`` + ``benchmarks_manifest.json``
  (render step only)

Outputs:

* ``$DATA_DIR/out/baseline_results.json`` -- every measured number.
* ``scripts/catalogue/BASELINES.md`` -- rewritten in place by the render
  step (see below).

Baseline 1 -- isbn_only. In B-mask / B-open the ISBN is masked by
construction, so an ISBN-only resolver can produce no link at all:
``auto_links = 0`` and ``candidate_recall = 0.0`` are reported with that
explanation, not as a measurement failure. As a control, the same
B-mask cases are then taken UNMASKED -- each case's true edition's
ISBN-13s are looked up in ``isbn_map`` -- and the join hit-rate (the
fraction resolving to the true work) is reported as the Path A control:
what the ISBN join alone would have scored had the ISBN been present.

Baseline 2 -- naive trigram title match.

* Similarity is pg_trgm-style, implemented in pure Python: the text is
  split into words (runs of letters/digits, lower-cased; CJK runs stay
  whole), each word is padded with two spaces before and one space after
  (the pg_trgm padding), trigram sets are extracted, and similarity is
  the Dice coefficient ``2*|A and B| / (|A| + |B|)`` over the two sets,
  exactly as pg_trgm computes ``similarity()``.
* Candidate generation (naive blocking): reference works sharing >= 1
  author key with the case, plus reference works whose (work) title
  shares >= 1 token with the case title. A token is a whitespace /
  punctuation split, lower-cased; for titles containing CJK characters,
  character bigrams of each CJK run are tokens as well. Candidates are
  capped at 200 per case to keep the naive scorer's runtime sane:
  author-sharing works first, then by shared-token count descending,
  then work key ascending.
* A candidate work's score is the maximum trigram similarity between the
  case title and any of the work's titles (its work title plus its slice
  editions' titles). The case is predicted to link to the argmax work
  (ties broken by work key ascending) iff the score reaches the
  threshold.

The threshold is 0.5 -- stated plainly as the naive choice (the round
number a first implementation reaches for), not a tuned value; tuning
thresholds from measured precision is Step 5's job, gated by §3.4.

Reported per suite (B-mask, B-open): candidate_recall (true work in the
capped candidate set; for B-open this is 0 by construction because the
true works are excluded from the slice), n_cases, n_predicted,
auto_link_precision (correct / predicted; for B-open every prediction is
false by construction), and for B-open the false_link_rate
(predicted / cases). B-pairs is scored with title similarity alone --
the fraction of positive pairs and of hard-negative pairs reaching the
threshold is a separability snapshot for the scorer's hardest input.

Render step: after scoring (or standalone with ``--render-only``, from
an existing baseline_results.json), BASELINES.md's
``<!--TOK:NAME-->...<!--/TOK-->`` cells are refilled from the manifests
and the results. A value that is unavailable renders as ``PENDING``.
The markers survive rendering, so re-running the render updates the
document instead of consuming it.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import duckdb

THRESHOLD = 0.5
CANDIDATE_CAP = 200

WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")

TOKEN_VALUE_RE = re.compile(
    r"(<!--TOK:([A-Z0-9_]+)-->).*?(<!--/TOK-->)", re.DOTALL
)
PLAIN_TOKEN_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def default_data_dir() -> Path:
    env = os.environ.get("DATA_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / "workspace" / "review-scratch" / "smart-bookstore-p4-data"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_progress(data_dir: Path, message: str) -> None:
    line = f"[{utc_now()}] baselines: {message}"
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


def parquet(data_dir: Path, *parts: str) -> str:
    return f"read_parquet({sql_literal(data_dir.joinpath('parquet', *parts))})"


# ---------------------------------------------------------------------------
# pg_trgm-style trigram similarity (pure Python)
# ---------------------------------------------------------------------------

def trigram_set(text) -> frozenset:
    """pg_trgm trigram set: two spaces before, one after, per word."""
    if not text:
        return frozenset()
    trigrams = set()
    for word in WORD_RE.findall(text.lower()):
        padded = "  " + word + " "
        for i in range(len(padded) - 2):
            trigrams.add(padded[i : i + 3])
    return frozenset(trigrams)


def trigram_similarity(set_a: frozenset, set_b: frozenset) -> float:
    """Dice coefficient over trigram sets, as pg_trgm's similarity()."""
    if not set_a or not set_b:
        return 0.0
    return 2.0 * len(set_a & set_b) / (len(set_a) + len(set_b))


def title_tokens(text) -> set:
    """Blocking tokens: split words, plus CJK character bigrams."""
    if not text:
        return set()
    lowered = text.lower()
    tokens = set(WORD_RE.findall(lowered))
    for run in CJK_RUN_RE.findall(lowered):
        if len(run) == 1:
            tokens.add(run)
        for i in range(len(run) - 1):
            tokens.add(run[i : i + 2])
    return tokens


# ---------------------------------------------------------------------------
# Reference + case loading
# ---------------------------------------------------------------------------

class Reference:
    """In-memory view of the slice reference catalogue for naive scoring."""

    def __init__(self, con: duckdb.DuckDBPyConnection, data_dir: Path):
        work_rows = con.execute(
            f"SELECT key, title, author_keys FROM {parquet(data_dir, 'slice_works.parquet')}"
        ).fetchall()
        edition_rows = con.execute(
            f"SELECT work_key, title FROM {parquet(data_dir, 'slice_editions.parquet')}"
        ).fetchall()
        self.work_keys = [row[0] for row in work_rows]
        self.author_index: dict = defaultdict(set)
        self.token_index: dict = defaultdict(set)
        titles_by_work: dict = defaultdict(set)
        for key, title, author_keys in work_rows:
            for author_key in author_keys or []:
                self.author_index[author_key].add(key)
            for token in title_tokens(title):
                self.token_index[token].add(key)
            if title:
                titles_by_work[key].add(title)
        for work_key, title in edition_rows:
            if title:
                titles_by_work[work_key].add(title)
        self.work_trigrams: dict = {
            key: [trigram_set(title) for title in titles_by_work.get(key, ())]
            for key in self.work_keys
        }
        self.n_works = len(self.work_keys)
        self.n_editions = len(edition_rows)


def load_cases(
    con: duckdb.DuckDBPyConnection, data_dir: Path, filename: str
) -> list:
    rows = con.execute(
        f"""
        SELECT case_id, title, author_keys, true_work_key
        FROM {parquet(data_dir, 'benchmarks', filename)}
        ORDER BY case_id
        """
    ).fetchall()
    return [
        {
            "case_id": row[0],
            "title": row[1],
            "author_keys": list(row[2]) if row[2] else [],
            "true_work_key": row[3],
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Baseline 1 -- isbn_only (+ Path A control)
# ---------------------------------------------------------------------------

def isbn_only_masked(n_cases: int) -> dict:
    return {
        "n_cases": n_cases,
        "auto_links": 0,
        "candidate_recall": 0.0,
        "note": (
            "The ISBN is masked in this suite by construction, so an "
            "ISBN-only resolver has nothing to join on: it can produce "
            "no candidate and no link. These zeros are the baseline's "
            "definition on masked input, not a measurement failure."
        ),
    }


def path_a_control(con: duckdb.DuckDBPyConnection, data_dir: Path, cases: list) -> dict:
    """Unmasked control: true edition's ISBN-13s -> isbn_map -> work."""
    con.execute("CREATE OR REPLACE TEMP TABLE control_cases (edition_key VARCHAR, work_key VARCHAR)")
    con.executemany(
        "INSERT INTO control_cases VALUES (?, ?)",
        [(case["true_edition_key"], case["true_work_key"]) for case in cases],
    )
    row = con.execute(
        f"""
        WITH edition_isbns AS (
            SELECT DISTINCT edition_key, isbn13
            FROM {parquet(data_dir, 'isbn_map.parquet')}
            WHERE edition_key IN (SELECT edition_key FROM control_cases)
        ),
        resolved AS (
            SELECT DISTINCT m.isbn13, m.work_key AS resolved_work
            FROM {parquet(data_dir, 'isbn_map.parquet')} m
            JOIN edition_isbns ei ON ei.isbn13 = m.isbn13
        ),
        per_case AS (
            SELECT
                c.edition_key,
                coalesce(bool_or(r.resolved_work IS NOT NULL), false) AS resolved_any,
                coalesce(bool_or(r.resolved_work = c.work_key), false) AS hit
            FROM control_cases c
            LEFT JOIN edition_isbns ei ON ei.edition_key = c.edition_key
            LEFT JOIN resolved r ON r.isbn13 = ei.isbn13
            GROUP BY c.edition_key, c.work_key
        )
        SELECT
            count(*) AS n_cases,
            sum(CASE WHEN resolved_any THEN 1 ELSE 0 END) AS n_resolved_any,
            sum(CASE WHEN hit THEN 1 ELSE 0 END) AS n_hits
        FROM per_case
        """
    ).fetchone()
    n_cases, n_resolved, n_hits = row[0], int(row[1] or 0), int(row[2] or 0)
    return {
        "n_cases": n_cases,
        "n_resolved_to_any_work": n_resolved,
        "n_hits": n_hits,
        "join_hit_rate": (n_hits / n_cases) if n_cases else 0.0,
        "note": (
            "Control (not a masked score): the same B-mask cases taken "
            "unmasked -- each case's true edition's ISBN-13s looked up in "
            "isbn_map. join_hit_rate is the fraction resolving to the "
            "true work, i.e. what Path A's join alone scores when the "
            "ISBN is present."
        ),
    }


def load_mask_cases_full(
    con: duckdb.DuckDBPyConnection, data_dir: Path
) -> list:
    rows = con.execute(
        f"""
        SELECT case_id, title, author_keys, true_work_key, true_edition_key
        FROM {parquet(data_dir, 'benchmarks', 'b_mask.parquet')}
        ORDER BY case_id
        """
    ).fetchall()
    return [
        {
            "case_id": row[0],
            "title": row[1],
            "author_keys": list(row[2]) if row[2] else [],
            "true_work_key": row[3],
            "true_edition_key": row[4],
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Baseline 2 -- naive trigram
# ---------------------------------------------------------------------------

def generate_candidates(case: dict, reference: Reference) -> list:
    """Naive blocking with the documented cap ordering."""
    author_hits = set()
    for author_key in case["author_keys"]:
        author_hits |= reference.author_index.get(author_key, set())
    token_counts: Counter = Counter()
    for token in title_tokens(case["title"]):
        for work_key in reference.token_index.get(token, ()):
            token_counts[work_key] += 1
    candidates = author_hits | set(token_counts)
    if len(candidates) > CANDIDATE_CAP:
        ordered = sorted(
            candidates,
            key=lambda key: (
                0 if key in author_hits else 1,
                -token_counts.get(key, 0),
                key,
            ),
        )
        candidates = set(ordered[:CANDIDATE_CAP])
    return candidates


def score_suite(cases: list, reference: Reference, data_dir: Path, name: str) -> dict:
    candidate_hits = 0
    n_predicted = 0
    n_correct = 0
    for index, case in enumerate(cases, start=1):
        candidates = generate_candidates(case, reference)
        if case["true_work_key"] in candidates:
            candidate_hits += 1
        case_trigrams = trigram_set(case["title"])
        best_work = None
        best_score = -1.0
        for work_key in candidates:
            score = 0.0
            for title_trigrams in reference.work_trigrams.get(work_key, ()):
                value = trigram_similarity(case_trigrams, title_trigrams)
                if value > score:
                    score = value
            if score > best_score or (score == best_score and (best_work is None or work_key < best_work)):
                best_score = score
                best_work = work_key
        if best_work is not None and best_score >= THRESHOLD:
            n_predicted += 1
            if best_work == case["true_work_key"]:
                n_correct += 1
        if index % 500 == 0:
            log_progress(data_dir, f"trigram {name}: {index}/{len(cases)} cases scored")
    n_cases = len(cases)
    return {
        "n_cases": n_cases,
        "candidate_recall": (candidate_hits / n_cases) if n_cases else 0.0,
        "n_predicted": n_predicted,
        "n_correct": n_correct,
        "auto_link_precision": (n_correct / n_predicted) if n_predicted else None,
        "false_link_rate": (n_predicted / n_cases) if n_cases else 0.0,
        "note_false_link_rate": (
            "predicted / cases. Meaningful for B-open, where every "
            "prediction is false by construction; reported for B-mask "
            "as well for symmetry."
        ),
    }


def score_pairs(con: duckdb.DuckDBPyConnection, data_dir: Path) -> dict:
    rows = con.execute(
        f"""
        SELECT case_id, edition_key_a, edition_key_b, label
        FROM {parquet(data_dir, 'benchmarks', 'b_pairs.parquet')}
        """
    ).fetchall()
    keys = {row[1] for row in rows} | {row[2] for row in rows}
    con.execute("CREATE OR REPLACE TEMP TABLE pair_title_keys (key VARCHAR)")
    con.executemany(
        "INSERT INTO pair_title_keys VALUES (?)", [(key,) for key in sorted(keys)]
    )
    title_rows = con.execute(
        f"""
        SELECT e.key, coalesce(e.title, w.title)
        FROM {parquet(data_dir, 'editions.parquet')} e
        LEFT JOIN {parquet(data_dir, 'works.parquet')} w ON w.key = e.work_key
        JOIN pair_title_keys k ON k.key = e.key
        """
    ).fetchall()
    trigram_by_key = {key: trigram_set(title) for key, title in title_rows}
    stats = {1: [0, 0], 0: [0, 0]}  # label -> [n, n_at_or_above_threshold]
    for _case_id, key_a, key_b, label in rows:
        similarity = trigram_similarity(
            trigram_by_key.get(key_a, frozenset()),
            trigram_by_key.get(key_b, frozenset()),
        )
        stats[label][0] += 1
        if similarity >= THRESHOLD:
            stats[label][1] += 1
    return {
        "threshold": THRESHOLD,
        "positives": {
            "n": stats[1][0],
            "n_at_or_above_threshold": stats[1][1],
            "fraction_at_or_above_threshold": (
                stats[1][1] / stats[1][0] if stats[1][0] else 0.0
            ),
        },
        "negatives": {
            "n": stats[0][0],
            "n_at_or_above_threshold": stats[0][1],
            "fraction_at_or_above_threshold": (
                stats[0][1] / stats[0][0] if stats[0][0] else 0.0
            ),
        },
        "note": (
            "Separability snapshot: title trigram similarity alone, no "
            "blocking, no other witnesses. Edition titles, falling back "
            "to the work title when an edition title is NULL."
        ),
    }


# ---------------------------------------------------------------------------
# BASELINES.md rendering
# ---------------------------------------------------------------------------

def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def sha256_prefix(path: Path):
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()[:16]
    except OSError:
        return None


def fmt_rate(value) -> str:
    return "PENDING" if value is None else f"{value:.4f}"


def fmt_int(value) -> str:
    return "PENDING" if value is None else str(int(value))


def build_tokens(data_dir: Path, results) -> dict:
    """Assemble every {{TOKEN}} value from manifests + results; None -> PENDING."""
    tokens: dict = {}
    slice_manifest = read_json(data_dir / "out" / "slice_manifest.json") or {}
    bench_manifest = read_json(data_dir / "out" / "benchmarks_manifest.json") or {}
    suites = bench_manifest.get("suites", {})
    strata = slice_manifest.get("strata_counts", {})
    sizes = slice_manifest.get("parquet_bytes", {})
    isbn_index = slice_manifest.get("isbn_index", {})

    tokens["SLICE_MANIFEST_GENERATED_AT"] = slice_manifest.get("generated_at")
    tokens["BENCHMARKS_MANIFEST_GENERATED_AT"] = bench_manifest.get("generated_at")
    tokens["BASELINE_RESULTS_GENERATED_AT"] = (results or {}).get("generated_at")
    for label, filename in (
        ("WORKS", "slice_works.parquet"),
        ("EDITIONS", "slice_editions.parquet"),
        ("AUTHORS", "slice_authors.parquet"),
    ):
        tokens[f"SLICE_{label}_FILE"] = filename
        tokens[f"SLICE_{label}_BYTES"] = fmt_int(sizes.get(filename))
        tokens[f"SLICE_{label}_SHA256_16"] = sha256_prefix(
            data_dir / "parquet" / filename
        )
    tokens["SLICE_WORKS_ROWS"] = fmt_int(slice_manifest.get("total_works"))
    tokens["SLICE_EDITIONS_ROWS"] = fmt_int(slice_manifest.get("total_editions"))
    tokens["SLICE_AUTHORS_ROWS"] = fmt_int(slice_manifest.get("total_authors"))
    tokens["STRATUM_MANY_EDITIONS_WORKS"] = fmt_int(strata.get("many_editions"))
    tokens["STRATUM_COLLISIONS_WORKS"] = fmt_int(strata.get("collisions"))
    tokens["STRATUM_EN_ZH_WORKS"] = fmt_int(strata.get("en_zh"))
    tokens["STRATUM_REPRINT_CHAINS_WORKS"] = fmt_int(strata.get("reprint_chains"))
    tokens["STRATUM_NULL_ISBN_PRE1987_ZH_WORKS"] = fmt_int(
        strata.get("null_isbn_pre1987_zh")
    )
    tokens["STRATUM_CANON_WORKS"] = fmt_int(strata.get("canon"))
    tokens["STRATUM_SHELF_WORKS"] = fmt_int(strata.get("shelf"))
    tokens["ISBN_MAP_ROWS"] = fmt_int(isbn_index.get("isbn_map_rows"))
    tokens["ISBN_MAP_DISTINCT_ISBN13"] = fmt_int(isbn_index.get("distinct_isbn13"))
    tokens["B_MASK_ROWS"] = fmt_int(suites.get("b_mask", {}).get("rows"))
    tokens["B_OPEN_ROWS"] = fmt_int(suites.get("b_open", {}).get("rows"))
    tokens["B_PAIRS_ROWS"] = fmt_int(suites.get("b_pairs", {}).get("rows"))
    tokens["B_ENZH_ROWS"] = fmt_int(suites.get("b_enzh", {}).get("rows"))

    isbn_only = (results or {}).get("isbn_only", {})
    control = isbn_only.get("path_a_control", {})
    trigram = (results or {}).get("trigram", {})
    b_mask = trigram.get("b_mask", {})
    b_open = trigram.get("b_open", {})
    pairs = trigram.get("b_pairs", {})
    tokens["ISBN_ONLY_MASK_AUTO_LINKS"] = fmt_int(
        isbn_only.get("b_mask", {}).get("auto_links")
    )
    tokens["ISBN_ONLY_MASK_CANDIDATE_RECALL"] = fmt_rate(
        isbn_only.get("b_mask", {}).get("candidate_recall")
    )
    tokens["ISBN_ONLY_OPEN_AUTO_LINKS"] = fmt_int(
        isbn_only.get("b_open", {}).get("auto_links")
    )
    tokens["ISBN_ONLY_OPEN_CANDIDATE_RECALL"] = fmt_rate(
        isbn_only.get("b_open", {}).get("candidate_recall")
    )
    tokens["PATH_A_CONTROL_CASES"] = fmt_int(control.get("n_cases"))
    tokens["PATH_A_CONTROL_HITS"] = fmt_int(control.get("n_hits"))
    tokens["PATH_A_CONTROL_HIT_RATE"] = fmt_rate(control.get("join_hit_rate"))
    tokens["TRGM_THRESHOLD"] = fmt_rate(trigram.get("threshold", THRESHOLD))
    tokens["TRGM_BMASK_CASES"] = fmt_int(b_mask.get("n_cases"))
    tokens["TRGM_BMASK_CANDIDATE_RECALL"] = fmt_rate(b_mask.get("candidate_recall"))
    tokens["TRGM_BMASK_N_PREDICTED"] = fmt_int(b_mask.get("n_predicted"))
    tokens["TRGM_BMASK_CORRECT"] = fmt_int(b_mask.get("n_correct"))
    tokens["TRGM_BMASK_PRECISION"] = fmt_rate(b_mask.get("auto_link_precision"))
    tokens["TRGM_BOPEN_CASES"] = fmt_int(b_open.get("n_cases"))
    tokens["TRGM_BOPEN_CANDIDATE_RECALL"] = fmt_rate(b_open.get("candidate_recall"))
    tokens["TRGM_BOPEN_N_PREDICTED"] = fmt_int(b_open.get("n_predicted"))
    tokens["TRGM_BOPEN_PRECISION"] = fmt_rate(b_open.get("auto_link_precision"))
    tokens["TRGM_BOPEN_FALSE_LINK_RATE"] = fmt_rate(b_open.get("false_link_rate"))
    tokens["BPAIRS_POS_N"] = fmt_int(pairs.get("positives", {}).get("n"))
    tokens["BPAIRS_POS_FRAC_GE"] = fmt_rate(
        pairs.get("positives", {}).get("fraction_at_or_above_threshold")
    )
    tokens["BPAIRS_NEG_N"] = fmt_int(pairs.get("negatives", {}).get("n"))
    tokens["BPAIRS_NEG_FRAC_GE"] = fmt_rate(
        pairs.get("negatives", {}).get("fraction_at_or_above_threshold")
    )
    return tokens


def render_baselines_md(data_dir: Path, results) -> Path:
    """Refill BASELINES.md's TOK cells in place; missing values -> PENDING."""
    md_path = Path(__file__).with_name("BASELINES.md")
    text = md_path.read_text(encoding="utf-8")
    tokens = build_tokens(data_dir, results)

    def value_for(name: str) -> str:
        value = tokens.get(name)
        return "PENDING" if value is None else str(value)

    text = TOKEN_VALUE_RE.sub(
        lambda match: match.group(1) + value_for(match.group(2)) + match.group(3),
        text,
    )
    text = PLAIN_TOKEN_RE.sub(lambda match: value_for(match.group(1)), text)
    md_path.write_text(text, encoding="utf-8")
    return md_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument(
        "--render-only",
        action="store_true",
        help="Only re-render BASELINES.md from an existing baseline_results.json.",
    )
    parser.add_argument(
        "--no-render",
        action="store_true",
        help="Score and write baseline_results.json without rendering BASELINES.md.",
    )
    args = parser.parse_args(argv)
    data_dir = (args.data_dir or default_data_dir()).expanduser()
    results_path = data_dir / "out" / "baseline_results.json"

    if args.render_only:
        results = read_json(results_path)
        rendered = render_baselines_md(data_dir, results)
        log_progress(data_dir, f"render-only: BASELINES.md refilled ({rendered})")
        return 0

    log_progress(data_dir, "start: loading reference slice")
    con = connect(data_dir)
    reference = Reference(con, data_dir)
    log_progress(
        data_dir,
        f"reference: {reference.n_works} works / {reference.n_editions} editions",
    )

    b_mask_cases = load_mask_cases_full(con, data_dir)
    b_open_cases = load_cases(con, data_dir, "b_open.parquet")
    log_progress(
        data_dir,
        f"cases: B-mask {len(b_mask_cases)} / B-open {len(b_open_cases)}",
    )

    control = path_a_control(con, data_dir, b_mask_cases)
    log_progress(
        data_dir,
        f"Path A control: hit rate {control['join_hit_rate']:.4f} "
        f"({control['n_hits']}/{control['n_cases']})",
    )

    trigram_mask = score_suite(b_mask_cases, reference, data_dir, "B-mask")
    log_progress(data_dir, f"trigram B-mask: {trigram_mask}")
    trigram_open = score_suite(b_open_cases, reference, data_dir, "B-open")
    log_progress(data_dir, f"trigram B-open: {trigram_open}")
    pairs = score_pairs(con, data_dir)
    log_progress(data_dir, f"B-pairs separability: {pairs}")

    results = {
        "generated_at": utc_now(),
        "reference": {
            "works": reference.n_works,
            "editions": reference.n_editions,
            "source": "parquet/slice_works.parquet + parquet/slice_editions.parquet",
        },
        "isbn_only": {
            "b_mask": isbn_only_masked(len(b_mask_cases)),
            "b_open": isbn_only_masked(len(b_open_cases)),
            "path_a_control": control,
        },
        "trigram": {
            "threshold": THRESHOLD,
            "candidate_cap": CANDIDATE_CAP,
            "method": (
                "pg_trgm-style trigram Dice similarity in pure Python; "
                "blocking = shared author key OR shared title token "
                "(CJK character bigrams included); score = max over the "
                "work's titles; predict argmax iff score >= threshold."
            ),
            "b_mask": trigram_mask,
            "b_open": trigram_open,
            "b_pairs": pairs,
        },
    }
    results_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    log_progress(data_dir, f"results written: {results_path}")

    if not args.no_render:
        rendered = render_baselines_md(data_dir, results)
        log_progress(data_dir, f"BASELINES.md rendered: {rendered}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
