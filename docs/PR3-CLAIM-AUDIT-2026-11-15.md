# PR 3 claim audit — smart-bookstore P4 (2026-11-15)

Auditor role: independent, read-only. No document or code was edited,
nothing was pushed, no GitHub API was used. This file is the only
output written.

## Materials and verification basis

- Document 1: `PR3-BUILD-LOG.md` in this directory (including its
  "Push pass 2026-11-15" section).
- Document 2: `scripts/seed/README.md` in the clone
  `~/workspace/review-scratch/smart-bookstore-p4-repo/`.
- Clone head verified: `git rev-parse HEAD` =
  `efdec56aa3b18b92abdb84a9075cae7ed15f8c72` on branch
  `feat/p4-pr3-seed-patha` — exactly the final head named in the
  assignment. Its first PR 3 commit `9fd4aae` has parent
  `2555ff8bb2a1d16f09af2afabc1d8fed52e45181` (the PR #63 merge on
  `feat/worker-native-route-b`).
- Run logs: `gate-logs-seed/` (original build),
  `gate-logs-seed-pushpass/` (at `dc0f0db`) and
  `gate-logs-seed-pushpass-final/` (full re-run at `efdec56`).
- Merged PR 2 baseline given in the assignment (140) and confirmed
  in the merged tree: `docs/PR2-BUILD-LOG.md` at `2555ff8b` records
  the correction "the suite is now 140/140 — round 1 added 5 tests
  for the ai_runs lifecycle and the payload pass-through", with
  per-file ai/ counts runs 10 / prompts 3 / ai/ total 17.

---

## Verdicts on the four suspected-stale items

### 1. Build-log header baseline "135/135" — CONFIRMED stale

- As written (Document 1, header): "Baseline in this tree before
  any change: `npm test` = **135/135** (PR 2 record)."
- Evidence: 135 was PR 2's *pre-review* total (123 baseline + 12 new,
  per the original PR 2 commit `53924b6`). PR #63's review rounds
  raised it to **140/140** before merge (PR2 build log correction,
  quoted above; final per-file counts in both push-pass
  `npm-test.log` files: runs 10 not 6, prompts 3 not 2). The build
  log's own push-pass section already uses the correct arithmetic:
  "140 merged baseline + 49 PR 3 tests = the expected 189, + 2 new
  F3-C tests = 191".
- Corrected statement: baseline in the final (rebased) tree before
  PR 3's changes is **140/140**.

### 2. Build-log header branch line "off PR 2's local head 9e41ce2" — CONFIRMED stale

- As written (Document 1, header): "Branch: `feat/p4-pr3-seed-patha`
  off PR 2's local head `9e41ce2` (= remote `53924b6e` content)."
- Evidence: that was the *starting* state of the push pass, not the
  final tree. The push pass rebased the branch
  `--onto origin/feat/worker-native-route-b 9e41ce2`; at the final
  head the PR 3 stack (`9fd4aae` → `666ad9c` → `2932c9f` →
  `7515153` → `dc0f0db` → `efdec56`) sits directly on the merged
  PR 2 base `2555ff8b` (PR #63 merge; PR 2 final `27a4eddb`).
  Verified with `git show -s` parentage: `9fd4aae^` = `2555ff8b…`.
- Corrected statement: branch is based on `2555ff8b`, the merged
  PR 2 head on `feat/worker-native-route-b`.

### 3. Decision D3-18: `worker/src/ai/runs.ts` double-encoding "flagged, not fixed here" — CONFIRMED stale

- As written (Document 1, D3-18): "**Not fixed:
  `worker/src/ai/runs.ts` (PR 2)** — its `toJsonValue` stringifies,
  so `ai_runs.input` / `output` written through the real driver are
  double-encoded strings (visible in the gate DB). PR 2's own tests
  assert the stringified contract at the stub level, and PR #63 is
  the owner's to review; changing the module's semantics is a
  separate fix… Impact until then: … only the input/output payloads
  are string-wrapped. PR 3's gate asserts ai_runs on kind/status/
  non-null output only."
- Evidence at the final head: `worker/src/ai/runs.ts` contains **no
  `toJsonValue` and no `JSON.stringify`**; payloads pass through
  `sanitizeJsonValue` / `toJsonParam` as objects, and the file's own
  comment records that the previous pre-stringifying implementation
  was the double-encoding bug. The fix arrived with the merged PR 2
  (commit `3cf903d` "fix(worker/ai): jsonb payloads pass through as
  values…", PR #63 review) and the rebase took the merged module
  verbatim (push-pass seam (b)). The push-pass gate DB check found
  6/6 `ai_runs` rows with `jsonb_typeof(input) = 'object'` and
  `jsonb_typeof(output) = 'object'`, all status `ok`,
  `finished_at` stamped, 0 rows left `running`. PR #63 is merged
  (`2555ff8b`), so "PR #63 is the owner's to review" is also past.
- What remains accurate in D3-18: the driver-probe mechanism, the
  fix in PR 3's own `identity.ts` code, and the last sentence — the
  seed gate's `assertions.sql` still checks only
  `kind = 'derive_listing_links'`, `status = 'ok'` and
  `output is not null` (assertions.sql lines 94–99); the object-type
  proof was a separate push-pass query, not a gate assertion.
- Corrected statement: the flagged PR 2 bug is **fixed in the final
  tree** (via merged PR 2 + rebase); no follow-up fix is outstanding
  for `runs.ts` payload encoding.

### 4. Build-log "Gate results (final run, 2026-11-12…)" numbers — CONFIRMED stale / superseded

- As written (Document 1, that section): "vitest **184/184** (135
  baseline + 49 new), typecheck clean, iteration-literal guard
  clean, frontend production build green…", with logs cited as
  `gate-logs-seed/`.
- Evidence: those numbers were true of the *original* 2026-11-12
  run (`gate-logs-seed/npm-test.log`: 184 passed, identity 14,
  runs 6, prompts 2) but they are not the final tree's results.
  Both push-pass runs (`gate-logs-seed-pushpass/` at `dc0f0db` and
  `gate-logs-seed-pushpass-final/` at `efdec56`) record:
  **vitest 191/191, 18 files** (identity 16, runs 10, prompts 3),
  typecheck clean, frontend build green, proto regen
  byte-identical, seed gate **10 passed, 0 failed**. The seed-gate
  sub-numbers in the 2026-11-12 section (loader counts, 6 linked /
  1 demoted / 1 no_isbn, 8 assertion groups, B-mask 12/12) *did*
  reproduce identically in the final runs — only the date, the
  "final run" framing, the log directory, and the vitest
  total/arithmetic are superseded.
- Corrected statement: final run is the 2026-11-15 push pass at
  `efdec56`, logs in `gate-logs-seed-pushpass-final/`, vitest
  **191/191** (140 merged baseline + 49 PR 3 + 2 F3-C).

---

## Additional findings

### A1. Snapshot id `ol-2026-11-11` is stale in both documents — now `ol-2026-11-13`

- Document 1, D3-1: "The loader derives it deterministically from
  the manifest's `generated_at` date: `ol-2026-11-11`".
- Document 2, owner step 3: "Expected report (snapshot
  `ol-2026-11-11`, derived from the slice manifest)"; and
  "What the loader guarantees": "**Every reference row carries the
  snapshot id** (`ol-2026-11-11`, derived deterministically from
  the manifest's `generated_at`…)".
- Evidence: the data dir's current `out/slice_manifest.json`
  carries `"generated_at": "2026-11-13T05:39:32Z"` (the slice was
  regenerated in PR 1's Phase B determinism re-run). Both push-pass
  gate runs print `snapshot_id: ol-2026-11-13` in every loader /
  generator log; the original `gate-logs-seed/` run printed
  `ol-2026-11-11`. The build log's own push-pass "Finding for the
  Claim Auditor" section already flags exactly this and leaves the
  doc strings unfixed. All other loader counts are unchanged
  (authors 5,070 / aliases 21,597 / works 4,993 / editions 20,000 /
  isbn_index 13,940 / projection 4,993; 29 checksum-rejected ISBNs).
- Corrected statement: derived snapshot id is **`ol-2026-11-13`**
  for the current manifest. (D3-1's separate remark that PR 2's
  fixtures used a `fixture-2026-11-11` namespace is still true —
  `scripts/schema/fixtures.sql` — and is not part of this finding.)

### A2. Document 2 names a migration file that does not exist

- As written (Document 2, owner step 1):
  `20261111130100_p4_listing_facets_categories.sql`.
- Evidence: the tree's `supabase/migrations/` contains
  `20261111130100_p4_listing_facets.sql` (no `_categories`), and
  the final gate's `01-migrations.log` applies it under that name.
  The other four filenames in the list, the count of five PR 2
  migrations, and "the three older files are already live"
  (8 migrations total) are all correct.
- Corrected statement: `20261111130100_p4_listing_facets.sql`.
  An owner following step 1 verbatim would look for a file that
  is not in the repo.

### A3. Document 2's "Gate results (local, 2026-11-12)" section is superseded on vitest

- As written (Document 2, final gate paragraph): "Repo gates
  alongside: vitest 184/184, typecheck clean, frontend production
  build green (zero `localhost` strings in the output)", under a
  2026-11-12 heading.
- Evidence: same as verdict 4 — the final head's logs
  (`gate-logs-seed-pushpass-final/npm-test.log`) show **191/191**;
  the seed-gate numbers in the same paragraph (10 passed / 0
  failed, 6 links / 1 demotion / 1 no-ISBN skip, assertions 8/8,
  B-mask 12/12, GetWork hub merged) all reproduced identically on
  2026-11-15 at `efdec56`, against the merged/amended migrations.
  The committed GIF 04 in `scripts/seed/gifs/` already shows 191,
  so the README text now contradicts the repo's own replay GIF.
- Corrected statement: gate results at the final head are the
  2026-11-15 push-pass results; vitest **191/191**.

### A4. Document 2 repeats the stale `runs.ts` double-encoding claim

- As written (Document 2, closing paragraph): "The same
  stringification pattern exists in PR 2's `ai/runs.ts`
  (`ai_runs.input`/`output` land double-encoded through the real
  driver): flagged for a separate small fix, deliberately not
  folded into this PR."
- Evidence: same as verdict 3 — at `efdec56` the pattern no longer
  exists in `worker/src/ai/runs.ts`, and the gate DB's `ai_runs`
  payloads are real jsonb objects (6/6). The "separate small fix"
  already landed, via PR #63's review rounds and the rebase; it
  was not folded into PR 3, but it is no longer outstanding.
- Corrected statement: the pattern **existed** in PR 2's original
  `ai/runs.ts` and **is fixed in the merged base this branch now
  sits on**; no follow-up remains.

### A5. Document 1, D3-7: the language counts do not describe what `ref_editions.language` actually stores

- As written: "`ref_editions.language` stores the OL code verbatim
  (`eng`, `chi`, `fre`, … — measured: 13,868 eng / 838 chi / 647 fre
  of 20,000)."
- Evidence: those three numbers are exact — but for a different
  quantity. Counting *every* entry of the multi-valued
  `languages` list in `parquet/slice_editions.parquet` gives
  eng 13,868 / chi 838 / fre 647 (17,425 entries over 17,287 rows).
  The loader does not store that list: `load_slice.py` sets
  `"language": languages[0] if languages else None`, so the stored
  single-valued column's actual distribution is
  **eng 13,850 / chi 830 / fre 625, with 2,713 rows NULL**
  (no language). The verbatim-code claim itself is correct; only
  the parenthetical measurement is misattributed.
- Corrected statement: "measured on the stored first-language
  values: 13,850 eng / 830 chi / 625 fre of 20,000, with 2,713
  rows carrying no language (NULL)" (see recommended edit E9).

### Checked and found accurate (no finding)

For the record, the following verifiable claims were re-checked
against the final tree / final logs and hold: all loader and
manifest counts and the 29 rejected ISBNs; loader run-2
inserted=0 in all 6 tables; generator archetypes, hub
"Alice's Adventures in Wonderland" (50 editions, ISBN
9780460018364), donor "Edinburgh Gazette"; link_seed 6 linked /
1 demoted / 1 no_isbn; assertions.sql 8 groups; B-mask 12/12;
isbn_index 13,940 = PR 1 isbn_map slice cut; the "full 37M-row
ISBN map" (manifest: 37,168,957 rows); D3-12's 12 B-mask cases;
D3-13's 10-minute TTL / 334 ms spacing in
`worker/src/external/open-library.ts`; D3-15's
`listing_facets.language` written as NULL in `identity.ts`;
D3-17's `total_score` column and exactly-one-candidate rule;
the §4.6 prefill order (local → Open Library → Google) and the
transient proto fields; GetWork's Worker-only status and its
recording in `DEPLOY.md`; the push-pass section's own numbers
(191/191, GIF byte sizes 160,308 / 189,193 / 301,227 / 137,940 —
verified against the committed GIF files — and the F3-C test
description, identity.test.ts = 16 tests).

---

## F1 presence check — `review_aspects_queue` owner-gate item in Document 2

**Result: ABSENT.**

Document 2's owner-gate list is the numbered "owner's live seed
procedure (Supabase)" (§10 item 3), steps 1–4. In full, it
currently contains only:

1. "Apply PR 2's five migrations first, in the Supabase dashboard
   SQL editor, one file at a time, in filename order" (the five
   filenames, one of which is wrong — see A2).
2. "One new Python package in the PR 1 data venv":
   `pip install "psycopg[binary]"`.
3. "Run the loader with your own connection string" (with the
   expected report — snapshot id stale, see A1).
4. "Optionally seed the synthetic demo listings" (generator +
   `link_seed.ts` bundle/run commands).

There is **no item — in that list or anywhere else in Document 2 —
about checking the `review_aspects_queue` view's PostgREST
exposure / grants on the real Supabase project**. The string
`review_aspects_queue` does not occur in `scripts/seed/README.md`
at all (nor do "PostgREST" or "grant"). For context: the view is
created by `supabase/migrations/20261111130400_p4_ai_platform.sql`
(`create view public.review_aspects_queue …` joining
`review_aspects` + `reviews` + `books` where status = 'pending');
that migration enables RLS on the underlying tables but contains
no grant/revoke statement for the view, and the local seed gate
asserts only that the view *exists* (in the schema gate's
assertions, not the seed gate's). Nothing in either audited
document tells the owner to verify its exposure on the live
project before/after applying the migrations.

---

## Recommended exact doc edits

Document 1 = `PR3-BUILD-LOG.md` (data dir). Document 2 =
`scripts/seed/README.md` (repo). Replacement text only; no edits
were made by this audit.

- **E1 (Doc 1, header, verdict 1+2).** Replace:
  "Branch: `feat/p4-pr3-seed-patha` off PR 2's local head `9e41ce2`
  (= remote `53924b6e` content). Baseline in this tree before any
  change: `npm test` = **135/135** (PR 2 record)."
  with:
  "Branch: `feat/p4-pr3-seed-patha`, originally built on PR 2's
  pre-review local head `9e41ce2` and rebased in the 2026-11-15
  push pass onto the merged PR 2 base `2555ff8b` (PR #63 merge).
  Baseline in the final tree before PR 3's changes: `npm test` =
  **140/140** (merged PR 2 record)."

- **E2 (Doc 1, D3-1, finding A1).** Replace "`ol-2026-11-11`
  (overridable via `SNAPSHOT_ID` env)" with "`ol-2026-11-13`
  (overridable via `SNAPSHOT_ID` env; the manifest was regenerated
  2026-11-13 in PR 1's Phase B re-run — the original build derived
  `ol-2026-11-11` from the earlier manifest)".

- **E3 (Doc 1, D3-18, verdict 3).** Replace the paragraph beginning
  "**Not fixed: `worker/src/ai/runs.ts` (PR 2)**" through
  "…string-wrapped." with:
  "**Fixed in the final tree: `worker/src/ai/runs.ts` (PR 2)** —
  its original `toJsonValue` stringified, so `ai_runs.input` /
  `output` written through the real driver were double-encoded
  strings. PR #63's review rounds fixed the module to pass
  payloads as objects (`sanitizeJsonValue`/`toJsonParam`), PR #63
  merged as `2555ff8b`, and this branch's rebase took the merged
  module verbatim; the push-pass gate DB verifies 6/6 `ai_runs`
  rows with `jsonb_typeof(input) = 'object'` and
  `jsonb_typeof(output) = 'object'`. No follow-up is outstanding."
  (Keep the following sentence about the gate asserting
  kind/status/non-null output only — it is still accurate.)

- **E4 (Doc 1, "Gate results (final run, 2026-11-12…)", verdict 4).**
  Retitle the section "Gate results (original run, 2026-11-12 —
  superseded; see Push pass 2026-11-15 for the final run)" and
  replace "vitest **184/184** (135 baseline + 49 new)" with
  "vitest **184/184** at the time (135 pre-review baseline + 49
  new; final tree: 191/191 — see push pass)".

- **E5 (Doc 2, owner step 1, finding A2).** Replace
  "`20261111130100_p4_listing_facets_categories.sql`" with
  "`20261111130100_p4_listing_facets.sql`".

- **E6 (Doc 2, owner step 3, finding A1).** Replace "Expected
  report (snapshot `ol-2026-11-11`, derived from the slice
  manifest)" with "Expected report (snapshot `ol-2026-11-13`,
  derived from the slice manifest)".

- **E7 (Doc 2, "What the loader guarantees", finding A1).**
  Replace "**Every reference row carries the snapshot id**
  (`ol-2026-11-11`, derived deterministically from the manifest's
  `generated_at`; override with `SNAPSHOT_ID`)" with "**Every
  reference row carries the snapshot id** (`ol-2026-11-13`,
  derived deterministically from the manifest's `generated_at`;
  override with `SNAPSHOT_ID`)".

- **E8 (Doc 2, "Gate results (local, 2026-11-12)", findings A3+A4).**
  Replace the heading with "Gate results (local, final run
  2026-11-15 at `efdec56`; originally run 2026-11-12 with
  identical seed-gate numbers)"; replace "vitest 184/184" with
  "vitest 191/191"; and replace the closing sentences "The same
  stringification pattern exists in PR 2's `ai/runs.ts`
  (`ai_runs.input`/`output` land double-encoded through the real
  driver): flagged for a separate small fix, deliberately not
  folded into this PR." with "The same stringification pattern
  existed in PR 2's original `ai/runs.ts` (`ai_runs.input`/`output`
  landed double-encoded through the real driver); it was fixed in
  PR #63's review rounds and this branch inherited the fix via
  rebase onto the merged PR 2 — the gate DB's `ai_runs` payloads
  are verified jsonb objects, and no follow-up remains."

- **E9 (Doc 1, D3-7, finding A5).** Replace "— measured: 13,868
  eng / 838 chi / 647 fre of 20,000" with "— the loader stores the
  edition's first listed language; measured on the stored values:
  13,850 eng / 830 chi / 625 fre of 20,000, with 2,713 editions
  carrying no language (NULL)".

- **E10 (Doc 2, owner procedure, F1 gap — addition, for the
  owner's decision).** Add a new step 2 (renumbering the rest) or
  a sub-bullet under step 1:
  "After applying the migrations, check the
  `review_aspects_queue` view's PostgREST exposure / grants on
  the live Supabase project (the migration creates the view in
  `public` with no grant/revoke statement of its own; confirm it
  is not readable via the public API keys beyond what the
  RLS-enabled underlying tables intend)."
  This audit only records the gap; whether and how to add the
  check is the fixer's/owner's call.
