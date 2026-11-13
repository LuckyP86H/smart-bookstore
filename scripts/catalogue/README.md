# scripts/catalogue — PR 1: offline catalogue, benchmarks, baselines

PR 1 of the smart-bookstore P4 build (`feat/p4-pr1-catalogue-benchmarks`,
plan §15) implements **Step 1** of `P4-BOOKS-FINAL-PLAN.md` (§9): build
the Open Library reference slice offline, build the §3.4 benchmark
suites, and measure the two baselines (exact-ISBN-only, naive trigram)
that every later identity-engine number is judged against.

Scripts and research outputs only — no Worker code, no migrations.
**Pause point for the PR series:** the data verdict. Everything after
PR 1 is sized by the numbers in `BASELINES.md`.

## The one data rule

**Dumps and Parquet never enter the repo.** All data lives outside it,
under `DATA_DIR`:

```text
DATA_DIR = ~/workspace/review-scratch/smart-bookstore-p4-data/
├── dumps/     # raw OL dump .txt.gz files + per-file *.manifest.json + .done markers
├── parquet/   # full-catalogue Parquet + slice_*.parquet + benchmarks/
├── out/       # manifests, baseline_results.json, excluded-key lists
├── venv/      # Python venv; pinned deps in requirements.txt (this dir)
└── progress.log
```

Every script reads `DATA_DIR` from the environment (default above) and
appends timestamped progress lines to `$DATA_DIR/progress.log`. Nothing
in this directory reads or writes inside the repo except `baselines.py`,
which rewrites `BASELINES.md` in place (its render step).

## Inputs (Parquet contract — produced by the pipeline, do not change)

| File | Columns |
|---|---|
| `parquet/authors.parquet` | key, name, personal_name, birth_date, death_date, alternate_names[], wikidata_id |
| `parquet/works.parquet` | key, title, subtitle, first_publish_date, first_publish_year, subjects[], author_keys[] |
| `parquet/editions.parquet` | key, work_key, title, subtitle, isbn_10[], isbn_13[], languages[], publish_date, publish_year, publishers[], number_of_pages, oclc_numbers[], lccn[], edition_name, series |
| `parquet/isbn_map.parquet` | isbn13, isbn_raw, edition_key, work_key |
| `parquet/wikidata_authors.parquet` | wikidata_id, ol_author_key, label_en, label_zh, aliases_en[], aliases_zh[] |

## Stage order and how to re-run (the driver)

`run_pipeline.py` is the stage driver for all nine stages below
(fetch → parse_authors → parse_wikidata → parse_works →
parse_editions → isbn_map → slice → benchmarks → baselines), with
done-markers under `$DATA_DIR/stages/`; a bare invocation runs
whatever is incomplete, and `--only <stage>` runs a single stage.
Every stage is idempotent, all run with the data venv's Python
(create it with `python3 -m venv $DATA_DIR/venv` and
`$DATA_DIR/venv/bin/pip install -r scripts/catalogue/requirements.txt`;
Pillow in that file is only needed by `make_gifs.py`).
DuckDB is capped in every script (`threads=2`, `memory_limit='3GB'`,
`temp_directory=$DATA_DIR`) per the VM stability rules — one heavy job
at a time.

```bash
export DATA_DIR=~/workspace/review-scratch/smart-bookstore-p4-data
PY=$DATA_DIR/venv/bin/python

# 0. Fetch the dumps (resume-able; skips files with a valid .done marker).
#    Records file/url/bytes/sha256/source_last_modified/fetched_at per dump
#    in dumps/<file>.manifest.json — one manifest file per dump;
#    manifest.example.json shows the shape of a single one.
$PY scripts/catalogue/run_pipeline.py --data-dir $DATA_DIR --only fetch
#    (equivalently: scripts/catalogue/fetch_dumps.sh)

# 1. Convert the gzipped TSV+JSON dumps to the Parquet contract above
#    and build isbn_map (run_pipeline.py stages parse_authors,
#    parse_wikidata, parse_works, parse_editions, isbn_map).
#    This first pass is the long pole: gzip reads are single-threaded.
$PY scripts/catalogue/run_pipeline.py --data-dir $DATA_DIR

# 2. Select the adversarial slice (§4.3): ~5,000 works / ~20,000 editions
#    across many_editions, collisions, en_zh, reprint_chains,
#    null_isbn_pre1987_zh, canon, and the owner's shelf
#    ($DATA_DIR/out/shelf_work_keys.txt, if present).
$PY scripts/catalogue/slice.py
#    -> parquet/slice_works.parquet (work columns + strata list)
#       parquet/slice_editions.parquet, parquet/slice_authors.parquet
#       out/slice_manifest.json

# 3. Build the benchmark suites (§3.4), seed 20261111, deterministic.
#    Requires the slice from stage 2 (B-open excludes slice works).
$PY scripts/catalogue/benchmarks.py
#    -> parquet/benchmarks/b_mask.parquet    (5,000 masked cases)
#       parquet/benchmarks/b_open.parquet    (2,000 absent-answer cases)
#       parquet/benchmarks/b_pairs.parquet   (20,000 + 20,000 pairs)
#       parquet/benchmarks/b_enzh.parquet    (<= 1,000 cases)
#       out/bopen_excluded_work_keys.txt, out/benchmarks_manifest.json

# 4. Measure the baselines and render the report.
$PY scripts/catalogue/baselines.py
#    -> out/baseline_results.json, and BASELINES.md refilled in place.
#    Re-render without re-scoring:  baselines.py --render-only
```

Optional: put the owner's shelf work keys (one per line) at
`$DATA_DIR/out/shelf_work_keys.txt` before stage 2 to include the
`shelf` stratum (B-shelf's source); the file's absence is fine.

## Outputs and where the verdict lives

- **`BASELINES.md`** (this directory) — the one-page Step 1 report:
  snapshot (files, bytes, sha256 prefixes, row counts), the §4.3
  estimate table with its measured column, per-suite baseline tables,
  and the plan-vs-measured notes. Token cells render as `PENDING` until
  the corresponding stage has run.
- **`out/slice_manifest.json`** — per-stratum work counts (pre- and
  post-trim), totals, Parquet bytes, the trim and edition-cap rules.
- **`out/benchmarks_manifest.json`** — per-suite row counts and the
  sampling notes (eligibility, weighting, strata rules).
- **`out/baseline_results.json`** — every baseline number, computed:
  isbn-only on masked suites (0 links by construction) + the unmasked
  Path A control join hit-rate; naive trigram per-suite candidate
  recall / precision, B-open false-link rate, B-pairs separability.

## Reproducibility

Same dump snapshot → same slice byte-for-byte, and same benchmark
suites: selection rankings end in unique key tie-breaks, Parquet writes
are `ORDER BY`-ed, and all sampling is seeded (hash ordering by
`hash(key, 20261111)` in DuckDB; `random.Random(20261111)` in Python).
Verify a re-run by comparing the sha256 prefixes printed in
`BASELINES.md` §1.

## Watch it run (replays)

Short terminal replays of the four parts of the pipeline, rendered by
`make_gifs.py` from the real run logs (progress log, dump manifests,
checkpoints and results JSONs of the 2026-11-11 build). They are
**scripted replays of the real commands and their real outputs — not
live screen captures**, and each GIF says so in its footer.

- [1/4 — fetch the dumps + manifests](gifs/01-fetch.gif)
- [2/4 — parse the dumps to Parquet](gifs/02-parse.gif)
- [3/4 — build the reference slice](gifs/03-slice.gif)
- [4/4 — benchmarks + baselines](gifs/04-benchmarks.gif)

Regenerate after a fresh build with:

```bash
python3 scripts/catalogue/make_gifs.py --data-dir $DATA_DIR \
    --out-dir scripts/catalogue/gifs
```
