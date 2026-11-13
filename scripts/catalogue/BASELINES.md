# PR 1 — Catalogue slice, benchmarks, and baselines

The Step 1 report for the smart-bookstore P4 build
(`P4-BOOKS-FINAL-PLAN.md` §9 Step 1): the offline Open Library slice, the
§3.4 benchmark suites built from it, and the two baselines every later
identity-engine number must beat — exact-ISBN-only and naive trigram
title match.

**This file is a template plus a rendered report.** Every measured cell
is a token cell that `baselines.py` refills in place from
`slice_manifest.json`, `benchmarks_manifest.json`, and
`baseline_results.json` under `$DATA_DIR/out/`:

```bash
$DATA_DIR/venv/bin/python scripts/catalogue/baselines.py            # score + render
$DATA_DIR/venv/bin/python scripts/catalogue/baselines.py --render-only
```

A cell whose value is unavailable renders as `PENDING` — a `PENDING`
cell means "not measured yet", never zero. Do not edit token cells by
hand; the `<!--TOK:...-->` markers must survive for re-rendering.

<!--
TOKENS (filled by baselines.py; names listed without braces on purpose):
SLICE_MANIFEST_GENERATED_AT, BENCHMARKS_MANIFEST_GENERATED_AT,
BASELINE_RESULTS_GENERATED_AT,
SLICE_WORKS_FILE, SLICE_WORKS_BYTES, SLICE_WORKS_SHA256_16, SLICE_WORKS_ROWS,
SLICE_EDITIONS_FILE, SLICE_EDITIONS_BYTES, SLICE_EDITIONS_SHA256_16,
SLICE_EDITIONS_ROWS,
SLICE_AUTHORS_FILE, SLICE_AUTHORS_BYTES, SLICE_AUTHORS_SHA256_16,
SLICE_AUTHORS_ROWS,
STRATUM_MANY_EDITIONS_WORKS, STRATUM_COLLISIONS_WORKS, STRATUM_EN_ZH_WORKS,
STRATUM_REPRINT_CHAINS_WORKS, STRATUM_NULL_ISBN_PRE1987_ZH_WORKS,
STRATUM_CANON_WORKS, STRATUM_SHELF_WORKS,
ISBN_MAP_ROWS, ISBN_MAP_DISTINCT_ISBN13,
B_MASK_ROWS, B_OPEN_ROWS, B_PAIRS_ROWS, B_ENZH_ROWS,
ISBN_ONLY_MASK_AUTO_LINKS, ISBN_ONLY_MASK_CANDIDATE_RECALL,
ISBN_ONLY_OPEN_AUTO_LINKS, ISBN_ONLY_OPEN_CANDIDATE_RECALL,
PATH_A_CONTROL_CASES, PATH_A_CONTROL_HITS, PATH_A_CONTROL_HIT_RATE,
TRGM_THRESHOLD,
TRGM_BMASK_CASES, TRGM_BMASK_CANDIDATE_RECALL, TRGM_BMASK_N_PREDICTED,
TRGM_BMASK_CORRECT, TRGM_BMASK_PRECISION,
TRGM_BOPEN_CASES, TRGM_BOPEN_CANDIDATE_RECALL, TRGM_BOPEN_N_PREDICTED,
TRGM_BOPEN_PRECISION, TRGM_BOPEN_FALSE_LINK_RATE,
BPAIRS_POS_N, BPAIRS_POS_FRAC_GE, BPAIRS_NEG_N, BPAIRS_NEG_FRAC_GE
-->

## 1. Snapshot

Data lives outside the repo under `$DATA_DIR`
(`~/workspace/review-scratch/smart-bookstore-p4-data/`). The slice is
reproducible from the dump snapshot recorded by the fetch manifest
(see `manifest.example.json` for that manifest's shape): same inputs →
same slice, byte-for-byte.

| Artifact | Generated at | Rows |
|---|---|---|
| Slice (`slice_manifest.json`) | <!--TOK:SLICE_MANIFEST_GENERATED_AT-->2026-11-11T11:27:24Z<!--/TOK--> | — |
| Benchmarks (`benchmarks_manifest.json`) | <!--TOK:BENCHMARKS_MANIFEST_GENERATED_AT-->2026-11-11T12:21:01Z<!--/TOK--> | — |
| Baselines (`baseline_results.json`) | <!--TOK:BASELINE_RESULTS_GENERATED_AT-->2026-11-11T12:23:04Z<!--/TOK--> | — |

| Slice output | Rows | Parquet bytes | sha256 (first 16) |
|---|---|---|---|
| <!--TOK:SLICE_WORKS_FILE-->slice_works.parquet<!--/TOK--> | <!--TOK:SLICE_WORKS_ROWS-->4993<!--/TOK--> | <!--TOK:SLICE_WORKS_BYTES-->920561<!--/TOK--> | <!--TOK:SLICE_WORKS_SHA256_16-->05ab34b3c07733aa<!--/TOK--> |
| <!--TOK:SLICE_EDITIONS_FILE-->slice_editions.parquet<!--/TOK--> | <!--TOK:SLICE_EDITIONS_ROWS-->20000<!--/TOK--> | <!--TOK:SLICE_EDITIONS_BYTES-->1143732<!--/TOK--> | <!--TOK:SLICE_EDITIONS_SHA256_16-->ea1ac82dbbd9c3b9<!--/TOK--> |
| <!--TOK:SLICE_AUTHORS_FILE-->slice_authors.parquet<!--/TOK--> | <!--TOK:SLICE_AUTHORS_ROWS-->5070<!--/TOK--> | <!--TOK:SLICE_AUTHORS_BYTES-->401980<!--/TOK--> | <!--TOK:SLICE_AUTHORS_SHA256_16-->4246d453cad2cb7f<!--/TOK--> |

Full-catalogue ISBN map (stays on the laptop / VM, feeds Path A):
<!--TOK:ISBN_MAP_ROWS-->37168957<!--/TOK--> rows,
<!--TOK:ISBN_MAP_DISTINCT_ISBN13-->34612211<!--/TOK-->
distinct ISBN-13s.

## 2. The slice (§4.3) — estimates replaced by measurements

Selection is adversarial by construction (§4.3): each selected work is
tagged with every stratum it belongs to (post-trim counts; a work in two
strata counts in both).

| Stratum | Rule (short) | Works measured |
|---|---|---|
| many_editions | Top works by edition count (~1,500) | <!--TOK:STRATUM_MANY_EDITIONS_WORKS-->1500<!--/TOK--> |
| collisions | Normalised title shared by ≥ 3 distinct works (cap ~800) | <!--TOK:STRATUM_COLLISIONS_WORKS-->1448<!--/TOK--> |
| en_zh | ≥ 1 `eng` edition and ≥ 1 `chi`/`zho` edition (~1,200, weighted up) | <!--TOK:STRATUM_EN_ZH_WORKS-->1200<!--/TOK--> |
| reprint_chains | ≥ 8 editions spanning ≥ 20 years (~600) | <!--TOK:STRATUM_REPRINT_CHAINS_WORKS-->600<!--/TOK--> |
| null_isbn_pre1987_zh | ≥ 1 edition with no ISBN, `chi`/`zho`, year < 1987 (cap ~800) | <!--TOK:STRATUM_NULL_ISBN_PRE1987_ZH_WORKS-->800<!--/TOK--> |
| canon | First-listed author's death year ≤ 1928 and ≥ 5 editions (cap ~600) | <!--TOK:STRATUM_CANON_WORKS-->600<!--/TOK--> |
| shelf | Owner's shelf work keys, if the file exists | <!--TOK:STRATUM_SHELF_WORKS-->0<!--/TOK--> |
| **Total (union, de-duplicated)** | Trim rule and edition-cap rule are recorded in `slice_manifest.json` | **<!--TOK:SLICE_WORKS_ROWS-->4993<!--/TOK--> works / <!--TOK:SLICE_EDITIONS_ROWS-->20000<!--/TOK--> editions / <!--TOK:SLICE_AUTHORS_ROWS-->5070<!--/TOK--> authors** |

Why collisions measured 1,448 against its ~800 cap: the cap is a
target, not a hard limit. Collisions works are selected and trimmed in
whole normalised-title groups — the never-split-a-group rule — and a
few normalised titles are shared by thousands of distinct works, so
keeping groups whole let the stratum overrun to 1,448 rather than
splitting a group to hit the number exactly.

The plan's §4.3 size table, with the estimate column reproduced and a
measured column filled from `slice_manifest.json` + ISBN statistics.
PR 1 measures the Parquet artefacts; the loaded Postgres footprint is
projected from them and confirmed at the Step 3 seed load — the Step 1
gate is a projection of ≤ ~250 MB loaded.

| Item | Basis (plan) | Estimate (plan) | Measured (PR 1) |
|---|---|---|---|
| ISBN index, ~1M ISBNs | 70–90 B/row incl. index | 70–90 MB | <!--TOK:ISBN_MAP_DISTINCT_ISBN13-->34612211<!--/TOK--> distinct ISBN-13s in the full map; index keeps ~1M of them (selection at load, Step 3) |
| Full reference records: ~5k works + ~20k editions + authors/aliases, with trigram index | — | 15–25 MB | <!--TOK:SLICE_WORKS_ROWS-->4993<!--/TOK--> works (<!--TOK:SLICE_WORKS_BYTES-->920561<!--/TOK--> B Parquet), <!--TOK:SLICE_EDITIONS_ROWS-->20000<!--/TOK--> editions (<!--TOK:SLICE_EDITIONS_BYTES-->1143732<!--/TOK--> B), <!--TOK:SLICE_AUTHORS_ROWS-->5070<!--/TOK--> authors (<!--TOK:SLICE_AUTHORS_BYTES-->401980<!--/TOK--> B); Postgres + trigram index overhead lands at load |
| Reference-work embeddings: 5,000 × bge-m3 1,024-dim `halfvec` + HNSW | ~2 KB/vector, as much again for the index | 20–25 MB | PENDING — embeddings are built in §4.2 step 6 / PR 2, not PR 1 |
| Listing embeddings (seed-scale listings) | ~2 KB/vector + index | 10–15 MB | PENDING — no listings exist until the Step 3 seed |
| Evidence + assertions + events + tasks | — | 10–20 MB | PENDING — schema is PR 2 |
| `ai_runs` with full input/output | ~4 KB/run | ~20 MB per 5,000 runs — retention rule required | PENDING — schema is PR 2 |
| Born-identified creations + lineage edges | — | < 5 MB | PENDING — schema is PR 2 |
| Marketplace tables at seed scale | — | Negligible | Negligible (live tables hold 0 rows) |
| **Total** | — | **≈ 150–200 MB of 500 MB (~2.5× headroom)** | Projection re-checked at Step 3 load against the ≤ ~250 MB Step 1 gate |

## 3. Benchmark suites (§3.4)

Built by `benchmarks.py` with seed 20261111 (deterministic). ISBN values
never appear in B-mask / B-open / B-enzh rows — the ISBN is the thing
being masked. Sampling notes per suite are in `benchmarks_manifest.json`.

| Suite | Tests | Rows measured |
|---|---|---|
| B-mask | Path B end-to-end (candidate recall, auto-link precision) on reference editions with the ISBN hidden | <!--TOK:B_MASK_ROWS-->5000<!--/TOK--> |
| B-open | Declining to link when the true work is absent from the reference | <!--TOK:B_OPEN_ROWS-->2000<!--/TOK--> |
| B-pairs | The scorer on hard negatives (positives inside one work vs different works by one author; strata: volumes, translations, companions, plain) | <!--TOK:B_PAIRS_ROWS-->40000<!--/TOK--> |
| B-enzh | The cross-language stratum (Chinese edition's fields, ISBN masked) | <!--TOK:B_ENZH_ROWS-->1000<!--/TOK--> |
| B-shelf | Reality check on the owner's own shelf (~150, hand-checked) | PENDING — owner's shelf entry is an owner step (§10) |

## 4. Baseline results

Reference for all scoring: the slice
(<!--TOK:SLICE_WORKS_ROWS-->4993<!--/TOK--> works /
<!--TOK:SLICE_EDITIONS_ROWS-->20000<!--/TOK-->
editions). Full machine-readable numbers: `baseline_results.json`.

### 4.1 Baseline 1 — exact-ISBN-only

On masked input this baseline can produce no link at all, by
construction: the ISBN it would join on is the field that was hidden.

| Suite | Cases | Auto-links | Candidate recall |
|---|---|---|---|
| B-mask | <!--TOK:B_MASK_ROWS-->5000<!--/TOK--> | <!--TOK:ISBN_ONLY_MASK_AUTO_LINKS-->0<!--/TOK--> | <!--TOK:ISBN_ONLY_MASK_CANDIDATE_RECALL-->0.0000<!--/TOK--> |
| B-open | <!--TOK:B_OPEN_ROWS-->2000<!--/TOK--> | <!--TOK:ISBN_ONLY_OPEN_AUTO_LINKS-->0<!--/TOK--> | <!--TOK:ISBN_ONLY_OPEN_CANDIDATE_RECALL-->0.0000<!--/TOK--> |

**Path A control** (the same B-mask cases taken *unmasked* — each true
edition's ISBN-13s joined through `isbn_map` to a work):

| Cases | Resolved to the true work | Join hit-rate |
|---|---|---|
| <!--TOK:PATH_A_CONTROL_CASES-->5000<!--/TOK--> | <!--TOK:PATH_A_CONTROL_HITS-->4998<!--/TOK--> | <!--TOK:PATH_A_CONTROL_HIT_RATE-->0.9996<!--/TOK--> |

The gap between the control and the masked rows *is* the case for the
identity engine: everything the ISBN join scores for free, Path B must
earn from evidence when the ISBN is absent, omitted, or lying.

### 4.2 Baseline 2 — naive trigram title match

Method (deliberately naive; see `baselines.py` for the full spec):
pg_trgm-style trigram Dice similarity in pure Python; blocking by shared
author key or shared title token (CJK character bigrams included);
candidates capped at 200 per case; score = best title similarity over
the candidate work's titles; predict the argmax work iff score ≥
threshold <!--TOK:TRGM_THRESHOLD-->0.5000<!--/TOK--> (the
naive round-number choice — thresholds are tuned from measured precision
in Step 5, not here).

**B-mask** (answer present in the reference):

| Cases | Candidate recall | Predicted | Correct | Auto-link precision |
|---|---|---|---|---|
| <!--TOK:TRGM_BMASK_CASES-->5000<!--/TOK--> | <!--TOK:TRGM_BMASK_CANDIDATE_RECALL-->0.0462<!--/TOK--> | <!--TOK:TRGM_BMASK_N_PREDICTED-->1314<!--/TOK--> | <!--TOK:TRGM_BMASK_CORRECT-->199<!--/TOK--> | <!--TOK:TRGM_BMASK_PRECISION-->0.1514<!--/TOK--> |

**B-open** (answer absent — every prediction is a false link):

| Cases | Candidate recall | Predicted | Auto-link precision | False-link rate |
|---|---|---|---|---|
| <!--TOK:TRGM_BOPEN_CASES-->2000<!--/TOK--> | <!--TOK:TRGM_BOPEN_CANDIDATE_RECALL-->0.0000<!--/TOK--> | <!--TOK:TRGM_BOPEN_N_PREDICTED-->454<!--/TOK--> | <!--TOK:TRGM_BOPEN_PRECISION-->0.0000<!--/TOK--> | <!--TOK:TRGM_BOPEN_FALSE_LINK_RATE-->0.2270<!--/TOK--> |

Candidate recall on B-open is 0 by construction (the true works are not
in the slice); the load-bearing number in this table is the false-link
rate — how often a title-only matcher confidently links a book to a work
it is not an edition of.

**B-pairs separability** (title similarity alone, no blocking):

| Pairs | n | Fraction with similarity ≥ threshold |
|---|---|---|
| Positives (same work) | <!--TOK:BPAIRS_POS_N-->20000<!--/TOK--> | <!--TOK:BPAIRS_POS_FRAC_GE-->0.9768<!--/TOK--> |
| Hard negatives (same first author, different works) | <!--TOK:BPAIRS_NEG_N-->20000<!--/TOK--> | <!--TOK:BPAIRS_NEG_FRAC_GE-->0.1596<!--/TOK--> |

### 4.3 The gates these baselines are read against (§3.4)

| Measure | Gate |
|---|---|
| Candidate recall | ≥ 0.98 |
| Automatic-link precision | ≥ 0.99 observed on ≥ 1,000 automatic links |
| False-link rate when the answer is absent (B-open) | ≤ 1% |
| Share of Path B items left for a person | ≤ 10% |

The baselines are not expected to meet these gates — that is their
purpose. They fix the floor: Step 5's fitted scorer is judged by how far
above this table it lands, and the propose-only fallback (§3.4) triggers
off the same numbers.

## 5. Plan vs measured — notes

- **Slice size.** Plan target ~5,000 works / ~20,000 editions. Measured:
  <!--TOK:SLICE_WORKS_ROWS-->4993<!--/TOK--> works /
  <!--TOK:SLICE_EDITIONS_ROWS-->20000<!--/TOK-->
  editions / <!--TOK:SLICE_AUTHORS_ROWS-->5070<!--/TOK-->
  authors. Where the union overshot, the trim rule in
  `slice_manifest.json` (shelf pinned; then more strata, then more
  editions) was applied; where a stratum undershot its nominal size, the
  stratum table in §2 is the record — strata are capped, not padded.
- **ISBN index.** The full map holds
  <!--TOK:ISBN_MAP_ROWS-->37168957<!--/TOK--> rows /
  <!--TOK:ISBN_MAP_DISTINCT_ISBN13-->34612211<!--/TOK-->
  distinct ISBN-13s against the plan's ~1M-index assumption; the index
  itself is identifiers-only and is cut to ~1M at load time (Step 3).
- **Masked-sample bias (§3.4 hazard).** B-mask / B-open overweight
  pre-1990 and Chinese-language editions ×3 per trait (×9 combined) via
  bucket quotas, because a uniform masked sample would be younger and
  more English than the real ISBN-less population. B-shelf remains the
  reality check and is still PENDING (owner step).
- **What the trigram baseline cannot see.** It has no author-alias,
  year, publisher, language, or embedding evidence, and its blocking
  never fetches a candidate whose title shares no token and no author
  key with the case — its candidate recall is therefore a floor for
  §3.2's blocking, not an estimate of it. The B-pairs separability rows
  show the same limit from the other side: title similarity alone
  cannot separate volumes, translations, and companions from plain
  reprints, which is why §3.2 scores evidence bands and applies vetoes
  instead of thresholding one similarity.
- **Reproducibility.** Re-running `slice.py` on the same dump snapshot
  must reproduce the slice byte-for-byte (check the sha256 prefixes in
  §1 against a re-run before trusting any later number in this file).
