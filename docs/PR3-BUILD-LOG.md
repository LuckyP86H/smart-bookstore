# PR 3 build log — smart-bookstore P4 Steps 3 + 4 (seed load + Path A + first work page)

Branch: `feat/p4-pr3-seed-patha`, originally built on PR 2's
pre-review local head `9e41ce2` and rebased in the 2026-11-15
push pass onto the merged PR 2 base `2555ff8b` (PR #63 merge).
Baseline in the final tree before PR 3's changes: `npm test` =
**140/140** (merged PR 2 record).
Governing spec: `P4-BOOKS-FINAL-PLAN.md` §3.1–3.2, §4.2–4.6, §8, §9
Steps 3–4, §10, §15 PR 3. Zero remote writes: the live Supabase load is
the owner's step (§10 item 3); everything here runs against a local
scratch Postgres only.

## Environment (rebuilt 2026-11-12, this VM's OS layer had been reset)

- apt PostgreSQL **16.15** + server-dev headers installed fresh;
  **pgvector 0.8.0 built from source** (same as PR 2: distro candidate
  0.6.0 has no `halfvec`). Scratch cluster at `/tmp/pg2-scratch`
  (initdb as the `postgres` user — the server refuses root), unix
  socket `/tmp/pg2-scratch/run`, loopback TCP 127.0.0.1:**54329**,
  trust auth, locale C.UTF-8 (same caveat as PR 2 vs Supabase's
  en_US.UTF-8). Verified: `create extension vector` → 0.8.0,
  `'[1,2,3]'::halfvec(3)` works.
- Data venv (PR 1): `~/workspace/review-scratch/smart-bookstore-p4-data/venv`
  — duckdb 2.0.0 + pyarrow 26.
- Slice (PR 1 manifest `out/slice_manifest.json`): works **4,993**,
  editions **20,000**, authors **5,070** — slice parquet row counts
  re-verified equal before building anything.

## Decisions (delegated judgment; plan-level scope untouched)

- **D3-1 — Snapshot id derived from the slice manifest.** PR 1's
  `slice_manifest.json` carries no explicit `snapshot_id` field. The
  loader derives it deterministically from the manifest's
  `generated_at` date: `ol-2026-11-13` (overridable via `SNAPSHOT_ID`
  env; the manifest was regenerated 2026-11-13 in PR 1's Phase B
  re-run — the original build derived `ol-2026-11-11` from the
  earlier manifest). The derived value is printed in the loader's
  count report, so the owner's run records exactly what was stamped
  on every reference row. (PR 2's gate fixtures used their own `fixture-2026-11-11`
  namespace; the real slice gets the `ol-` prefix to keep the two
  visibly distinct.)
- **D3-2 — Loader idempotency = insert-if-absent (verified no-op).**
  Reference rows are keyed unique on `(source, source_key,
  snapshot_id)`; the loader inserts with conflict-do-nothing semantics
  and reports inserted vs already-present counts. A re-run against the
  same snapshot must insert 0 rows and leave every count unchanged —
  that is the gate's idempotency proof. Clean-replace (delete +
  reinsert) was rejected: `listing_links` / `evidence` reference
  editions and works with NO ACTION deletes, so a replace after links
  exist would fail; snapshot rows are immutable reference data, so
  insert-if-absent is also the semantically right rule.
- **D3-3 — Loader runtime = Python + pyarrow + psycopg** (amended in
  rehearsal). The first cut used DuckDB's postgres extension (the PR 1
  toolchain), but its write path COPYs into the target table's full
  column list: inserts that omit the `identity` id column are written
  as explicit NULL ids and fail, and `postgres_execute`'s statement
  visibility across its pooled connections proved unreliable
  (a table created by one call was invisible to the next). Rather
  than fight the extension, the loader reads Parquet with pyarrow
  alone and writes with psycopg 3 (`pip install "psycopg[binary]"`
  into the data venv — the one package the owner's PR 1 venv needs
  added). The connection string comes from the `DATABASE_URL` env var
  only, so the owner runs the identical script against Supabase. Node
  has no Parquet reader in this repo's dependency set, and §4.2's
  pipeline is Python-shaped.
  **Loader rehearsal result (scratch DB):** run 1 — authors 5,070,
  aliases 21,597, works 4,993, editions 20,000, isbn_index 13,940,
  projection 4,993, all matching expectations; 29 slice ISBNs rejected
  by checksum and skipped (the count is reported, not hidden). The
  isbn_index total cross-checks exactly against PR 1's independent
  full-map artifact (`isbn_map.parquet` rows for slice editions =
  13,940). Run 2 — inserted=0 on every table: D3-2's verified no-op.
- **D3-4 — `source_key` = the Open Library key verbatim**
  (`/works/OL…W`, `/books/OL…M`, `/authors/OL…A`) — the natural unique
  key from the dumps, and the form the single-lookup fallback gets back
  from the OL API, so fallback resolution by source_key lines up.
- **D3-5 — The `works` display projection is seeded by the loader**
  (one row per reference work: title, author_display from the slice's
  author names, categories = the work's OL subjects). The projection
  is derived, rebuildable data (§3.6) and `GetWork`'s contract (§8)
  reads it; without seeded rows the first work page would have nothing
  to read. Its row count (4,993) is manifest-checkable like the rest.
  §4.5's listing-union category derivation stays a read-time concern
  of GetWork (it unions projection + member-listing categories).
- **D3-6 — Aliases load from both PR 1 sources.** `ref_author_aliases`
  gets the OL authors dump's `alternate_names` (source `openlibrary`)
  and the wikidata dump's labels/aliases (source `wikidata`, script
  `en`/`zh`), restricted to authors in the slice. Step 8 enriches ZH
  matching on top of this; loading what PR 1 already parsed is Step
  3's "loads the slice into the schema" completeness, not Step 8
  scope.
- **D3-7 — `ref_editions.language` stores the OL code verbatim**
  (`eng`, `chi`, `fre`, … — the loader stores the edition's first
  listed language; measured on the stored values: 13,850 eng / 830
  chi / 625 fre of 20,000, with 2,713 editions carrying no language
  (NULL)). PR 2's fixtures used app-style `en`/`zh` because they are
  invented data; for real dump data the §4.1 rule (persist from dumps)
  wins over a lossy 639-2→639-1 rewrite nobody specified. Display
  mapping is a UI concern, not a seed concern.
- **D3-8 — The honest/lying ISBN pair is NOT built on 9780134685991.**
  Measured: no slice edition carries it (Effective Java is not in the
  slice), so there is no honest anchor for it in the seeded reference.
  The generator builds the same archetype on a real slice ISBN (the
  hub work's edition): honest listings carry that edition's true
  metadata at two stores; the lying listing carries the same ISBN-13
  with a different work's title/author. 9780134685991 itself remains
  covered by PR 2's fixture harness and by PR 3's vitest fixtures.
- **D3-9 — Synthetic listings get `genre = 'FICTION'`** (a valid proto
  enum name) unless an archetype says otherwise. OL subjects do not
  map onto the app's genre enum, and inventing a mapping is the
  GENRE_PSYCHOLOGY bug class (§4.5); subjects themselves land in
  `books.categories` / `works.categories` verbatim instead.
- **D3-10 — Seed listings are linked by the Worker's own Path A
  linker**, driven over the seeded listings by `scripts/seed/
  link_seed.ts` (Node, esbuild bundle — the `seed:cloud` pattern).
  The generator inserts `books` rows directly (fixtures, like PR 2's),
  which bypasses `AddBook`; running the shipped linking code over them
  is both the honest staging behaviour and the gate's end-to-end proof
  that every ISBN'd seed listing resolves by the join. No second
  linking implementation exists anywhere (no SQL re-implementation).
- **D3-11 — DuckDB extension loading chain (superseded by D3-3's
  amendment).** In this VM, DuckDB's `INSTALL postgres` cannot work
  (its downloader cannot parse the sandbox's proxy env, and direct
  egress is blocked); a local-file install + ATTACH + simple INSERT +
  `ON CONFLICT DO NOTHING` pass-through were verified before the
  identity-column write failure (D3-3) retired the whole approach.
  The downloaded extension file stays in the data dir as a record of
  the attempt; DuckDB is still used by the gate's read-only
  cross-checks, where it works fine.
- **D3-12 — B-mask spot joins are exactly 12 cases.** PR 1's B-mask
  sampled editions from the full catalogue; only 12 of its 5,000 true
  editions are inside the slice's 20,000-edition cap (all 12 carry an
  ISBN-13). Those 12 are the gate's hand-checked spot joins: each must
  resolve through the loaded `isbn_index` to its true work.
- **D3-13 — The OL fallback cache is per-isolate memory, 10-minute
  TTL, negatives included** (`createOpenLibraryEditionLookup` in
  `worker/src/external/open-library.ts`; one shared instance per
  isolate in connect-app). §3.1 says the single lookup's result is
  "cached" without naming a store. Persisting API responses would
  violate the §4.1 data rule's spirit (reference data grows from
  dumps, not API dribble), and a KV/D1 cache is infrastructure the
  plan doesn't budget for Act 1. In-isolate memoisation + the ≤3 req/s
  spacing (334 ms chain) bounds the cost: an ISBN costs at most one
  lookup per isolate per 10 minutes, and the answer is only ever used
  when the edition it names is ALREADY in the reference tables.
- **D3-14 — Proto3 JSON omits `false`, and the UI/tests read it that
  way.** The new `description_transient` / `cover_transient` /
  `is_synthetic` flags serialize only when true. That is proto3
  default-value elision, not a bug: consumers must treat absence as
  false (the frontend badge does; the vitest assertions were fixed to
  match after the first run made the behaviour visible).
- **D3-15 — Path A writes `listing_facets.language` as NULL.** The
  facet parser is PR 4 work (§3.2); Path A records only the join
  inputs it actually used (isbn13, title_key, author_keys). The
  listing's own language string is app-shaped (`en`) while the facet
  column's eventual semantics are the parser's to define; stamping a
  guessed value now would be exactly the kind of unverified metadata
  §4.4 warns about.
- **D3-16 — §4.6's "form" fix lands at the RPC layer, because this
  branch's SPA has no add-book form.** The frontend ships a customer
  grid plus an unused public merchant client — there is no merchant
  form component to edit. What §4.6 actually requires is that the
  prefill stop treating Google as the source and that Google content
  never be persisted; both are enforced where the data flows:
  `LookupBookByISBN` now orders local index → Open Library → Google
  and marks Google's description/cover with the additive proto fields
  `description_transient` / `cover_transient` (+ `source` /
  `attribution`), which is the contract any form must honour. The
  README states this plainly rather than pretending a form changed.
  (AddBook itself stays at P3 parity precisely because it cannot know
  a field's provenance — the plan's own reasoning.)
- **D3-17 — Gate rehearsal catch: evidence column is `total_score`,
  and an evidence row names exactly ONE candidate.** The first full
  gate run failed at link_seed with `column "score" of relation
  "evidence" does not exist`: `worker/src/db/identity.ts` had been
  written against the plan-summary's column list. The real PR 2
  schema names it `total_score`, and its exactly-one-candidate CHECK
  forbids setting both `candidate_edition_id` and `candidate_work_id`
  — Path A now names the edition alone (the work is reached through
  the edition). Fixed in identity.ts; the vitest stubs could not
  catch this (they model rows, not DDL), which is precisely what the
  scratch-DB gate exists for. (Same restart also wiped /tmp and the
  source-built pgvector: cluster + pgvector 0.8.0 rebuilt from the
  recipe in the Environment section and re-verified before the gate
  re-ran.)
- **D3-18 — jsonb parameters through the Db seam must be objects,
  never pre-stringified strings (gate catch #2); PR 2's ai/runs has
  the latent form of the same bug — flagged, not fixed here.**
  postgres.js JSON-encodes a string parameter bound for a jsonb
  column, so `JSON.stringify(x)` + `::jsonb` stores x as a JSON
  *string scalar* (double-encoded; `bands ->> 'title'` is NULL).
  Passing the plain object stores the object. Proven by a driver
  probe and by the gate DB itself. Fixed in PR 3's own code
  (identity.ts passes objects; `QueryValue` widened with
  `Record<string, unknown>`). **Fixed in the final tree:
  `worker/src/ai/runs.ts` (PR 2)** — its original `toJsonValue`
  stringified, so `ai_runs.input` / `output` written through the
  real driver were double-encoded strings. PR #63's review rounds
  fixed the module to pass payloads as objects
  (`sanitizeJsonValue`/`toJsonParam`), PR #63 merged as `2555ff8b`,
  and this branch's rebase took the merged module verbatim; the
  push-pass gate DB verifies 6/6 `ai_runs` rows with
  `jsonb_typeof(input) = 'object'` and `jsonb_typeof(output) =
  'object'`. No follow-up is outstanding. PR 3's gate asserts
  ai_runs on kind/status/non-null output only.
  **Update (2026-11-16, fix rounds 1–2; review 5926758268 item 3):**
  the last sentence is superseded. Fix round 1 (item 15) extended
  assertions.sql §3 to assert both payloads are jsonb objects
  (`jsonb_typeof = 'object'`), and fix round 2 hardened the same
  check to `IS DISTINCT FROM 'object'` so a NULL payload fails it
  too (bite-proven against the gate DB; see the round-2 section).

## Gate results (original run, 2026-11-12 — superseded; see Push pass 2026-11-15 for the final run)

`scripts/seed/run_gate.sh` — **10 passed, 0 failed** (logs in
`gate-logs-seed/` beside this file):

- loader run 1: authors 5,070 / aliases 21,597 / works 4,993 /
  editions 20,000 / isbn_index 13,940 / projection 4,993 — all equal
  to the manifest (29 checksum-rejected ISBNs skipped, reported).
- loader run 2: inserted=0 in all 6 tables (D3-2 verified no-op).
- generator: 8 archetype listings on the real slice (hub = "Alice's
  Adventures in Wonderland", 50 editions); re-run is a no-op report.
- link_seed (shipped Path A over the seed listings): 6 linked /
  1 demoted (the lying listing) / 1 no_isbn.
- assertions.sql: 8 assertion groups PASS (counts, seed shape, link
  lineage ×6, lying demotion + rejected evidence with title
  mismatch, hub multi-store/multi-edition, hyphen + X canonical
  links, NULL-ISBN untouched, sold paper trail).
- spot_joins.py: B-mask 12/12 resolved to their true works;
  isbn_index total = PR 1 isbn_map slice cut (13,940); every ISBN'd
  synthetic listing resolves in the index and every honest link
  names an edition that ISBN actually resolves to.
- verify_workpage.ts: the real GetWork RPC over the seeded DB —
  hub work merged (≥3 offers, ≥2 stores, all synthetic-disclosed),
  ≥3 editions, the sold listing's 5★ review rolled up with
  seed-merchant-a attribution, exact denominators, price spread
  consistent.
- Repo gates: vitest **184/184** at the time (135 pre-review baseline + 49
  new; final tree: 191/191 — see push pass), typecheck
  clean, iteration-literal guard clean, frontend production build
  green with zero `localhost` strings in dist.

## Push pass 2026-11-15 — rebase + F3-C + gate re-run

Builder pass (Stage 1 of the push pipeline; Claim Auditor and push are
separate stages, NOT this pass). Starting state verified: branch
`feat/p4-pr3-seed-patha` clean at 179902e; 4 PR 3 commits c883a64
(proto) -> 7c6eb56 (worker) -> b26c175 (frontend) -> 179902e
(seed/docs) on 9e41ce2; `origin/feat/worker-native-route-b` at
2555ff8b (PR #63 merge; PR 2 final 27a4eddb). Scratch cluster
/tmp/pg2-scratch WIPED (dir absent); PG 16.15 binaries + server
headers present, pgvector extension files ABSENT — rebuild needed
per PR63-FIX-LOG recipe before the seed gate.

Checklist (tick as done; numbers copied from run logs only):
- [x] Rebase --onto origin/feat/worker-native-route-b 9e41ce2 (new SHAs recorded below)
- [x] Seam (a) client.ts converged to one copy (arrays + Record)
- [x] Seam (b) runs.ts final = merged behaviour (objects, lifecycle, running-guard); identity.ts call sites checked
- [x] F3-C implemented in identity.ts (success path untouched; compensating error run on failure) — commit dc0f0db
- [x] F3 vitest tests added: (i) failure -> exactly one finished error run, zero listing_links; (ii) success unchanged (one ok run, atomic) — both PASS
- [x] Scratch env rebuilt (PG 16.15 + pgvector 0.8.0, port 54329) — pgvector rebuilt from v0.8.0 source (make with_llvm=no), cluster re-initdb'd at /tmp/pg2-scratch, vector ext 0.8.0 + halfvec verified
- [x] Seed gate re-run on merged/amended migrations: 10/10 (run twice: at dc0f0db and at final head efdec56; logs gate-logs-seed-pushpass/ and gate-logs-seed-pushpass-final/)
- [x] Gate DB ai_runs payloads verified as real objects: 6/6 rows jsonb_typeof(input)=object AND jsonb_typeof(output)=object, all status ok, finished_at stamped, 0 rows left running
- [x] npm ci + full vitest: 191/191 (18 files) at final head
- [x] Typecheck: clean (exit 0)
- [x] Frontend production build: green (exit 0); zero localhost strings in frontend/dist
- [x] Proto regen byte-identical: npm run generate exit 0, git tree clean afterwards (worker + frontend generated files unchanged)
- [x] GIF disposition: regenerated from the final run's logs (commit efdec56) — 01 and 04 changed, 02 and 03 re-rendered byte-identical and untouched

### Rebase log
Executed: `git rebase --onto origin/feat/worker-native-route-b 9e41ce2 feat/p4-pr3-seed-patha`.
New SHAs: proto c883a64 -> 9fd4aae; worker 7c6eb56 -> 666ad9c;
frontend b26c175 -> 2932c9f; seed/docs 179902e -> 7515153.
Conflicts: exactly ONE — worker/src/db/client.ts in the worker commit
(2/4). Proto, frontend and seed commits applied clean.
- Seam (a) client.ts: both sides had widened QueryValue with
  Record<string, unknown> (merged base for ai_runs jsonb; PR 3 for
  evidence/identity jsonb, D3-18). Resolution: exactly one
  Record<string, unknown> member; PR 3's string[]/bigint[] members
  (array columns, absent from the merged base) kept; comments merged
  into one block citing both provenances + a dated rebase note.
- Seam (b) runs.ts: NO conflict — no PR 3 commit touches runs.ts, so
  the rebase takes the merged module verbatim. Verified by reading
  the final file: payloads pass through sanitizeJsonValue/toJsonParam
  as OBJECTS (no toJsonValue/JSON.stringify double-encoding);
  startRun relies on the schema-default 'running' status and rejects
  whitespace-only kinds; finishRun sets finished_at and guards
  `WHERE id = $7 AND status = 'running'`.
- identity.ts call sites vs merged signatures: startRun(db, {kind,
  provider, listingId, input}) and finishRun(db, id, {output}) —
  parameter shapes UNCHANGED by the review rounds, payloads already
  passed as objects by PR 3 — no adaptation needed. The merged
  finishRun running-guard is satisfied: the row is started inside
  the same transaction immediately before.

### F3-C notes
Implemented as designed (option C, NOT the A fallback) in commit
dc0f0db, confined to worker/src/db/identity.ts + its tests:
- writeLink's success path is behaviourally untouched: startRun /
  finishRun still run inside the link transaction on the tx handle;
  every SQL template literal in the function is byte-identical to
  the pre-F3 file (verified programmatically). The only structural
  change is a try/catch around deps.begin plus hoisting the run
  input object so the catch block can reuse the exact attempt
  payload — the caught error DOES carry all needed context (isbn13,
  source, candidate ids and bands are in scope), so C was fully
  implementable.
- On failure (deps.begin rejects = rollback complete), the new
  writeCompensatingErrorRun writes ONE ai_runs row via deps.run
  (non-transactional): startRun with the attempt's kind/provider/
  listingId/input, immediately finishRun with status 'error', the
  caught error's message, and an output carrying the candidate ids,
  bands and compensated: true. The row is born terminal — no
  'running' state is ever committed by this path, so no orphaned
  running rows are possible from it. The ORIGINAL error is then
  rethrown unchanged (merchant.ts's catch-and-log and link_seed's
  abort see exactly the failure they saw before). If the
  compensating write itself fails, that failure is swallowed so the
  ledger never masks the real link failure.
- Scope note: writeDemotion's transaction contains no ai_runs
  calls, so a rollback there erases no run record; F3 does not
  apply to it and it is untouched.
- Tests (identity.test.ts, +2 = 16 in file): a transactional stub
  modelling commit/rollback (tx statements buffer, discarded on
  throw). (i) Forced failure at INSERT INTO listing_links: the call
  rejects with the original error; persisted listing_links = 0; the
  in-tx ai_runs insert is in the rolled-back set; exactly ONE
  ai_runs insert + ONE finish persist, the finish carrying status
  'error', the forced-failure message, compensated: true, and the
  attempt's input object. (ii) Success: one 'ok' run start+finish
  persisted in the same commit as the one listing_links insert
  (whose derivation_run_id is the run id), zero rolled back, no
  compensating run.

### Gate results (this pass) — all at final head efdec56 unless noted
Logs: gate-logs-seed-pushpass/ (first full pass, at dc0f0db — the
run the committed GIFs were rendered from) and
gate-logs-seed-pushpass-final/ (full re-run at efdec56; the delta
between the two heads is GIF binaries only, and every number below
reproduced identically).
- Seed gate (scripts/seed/run_gate.sh, scratch DB built from the
  MERGED amended migrations): **10 passed, 0 failed** — loader run 1
  counts = manifest (authors 5,070 / aliases 21,597 / works 4,993 /
  editions 20,000 / isbn_index 13,940 / projection 4,993; 29
  checksum-rejected ISBNs skipped); loader run 2 inserted=0 in all
  6 tables; link_seed 6 linked / 1 demoted / 1 no_isbn;
  assertions.sql PASS; spot joins B-mask 12/12, isbn_index 13,940;
  verify_workpage PASS.
- ai_runs in the gate DB (post-round-1 runs.ts, verified by query):
  6 rows (one per linked listing), ALL with jsonb_typeof(input) =
  'object' and jsonb_typeof(output) = 'object' — real objects, no
  double-encoding (D3-18's flagged PR 2 bug is gone via the rebase);
  all status 'ok', finished_at NOT NULL, 0 rows in 'running'.
- vitest: **191/191, 18 files** (npm test, incl. the
  iteration-literal guard). Arithmetic: 140 merged baseline + 49
  PR 3 tests = the expected 189, + 2 new F3-C tests = 191.
  Per-file: identity 16, runs 10, prompts 3, embeddings 4 (the
  merged ai/ counts from the round-3 audit hold).
- Typecheck (tsc --noEmit): clean, exit 0.
- Frontend production build (npm run build): exit 0; grep for
  'localhost' over frontend/dist = 0 hits.
- Proto: npm run generate exit 0; git status clean afterwards —
  generated files byte-identical.
- GIFs: displayed-lines comparison old-vs-final run — GIF 01 lines
  differ (snapshot_id line, see finding below), GIF 04 lines differ
  (184 -> 191 and per-file counts); GIF 02/03 picked lines
  identical. Regenerated all four with scripts/seed/make_gifs.py
  from gate-logs-seed-pushpass/: 01 (160,308 B) and 04 (137,940 B)
  changed and were committed (efdec56); 02 (189,193 B) and 03
  (301,227 B) re-rendered byte-identical, untouched. Picked lines
  from the efdec56 re-run match the GIF source run (sans timings),
  so the committed GIFs depict the final head's run.
- Toolchain floor record (standing rule): the seed gate ran on the
  data venv (pip 26.3 — above the 26.2.2 floor; psycopg 3.3.9,
  pyarrow 26.0.1, duckdb 2.0.0 pre-existing, nothing pip-installed
  this pass); node v24.22.1 / npm 10.9.4 for npm ci. No uv on this
  VM image (not used by this pass).

### Finding for the Claim Auditor (not fixed here — docs are Stage 2)
The loader's derived snapshot_id in BOTH push-pass gate runs is
**ol-2026-11-13**, not the ol-2026-11-11 that scripts/seed/README.md
and this log's D3-1 record: the data dir's slice manifest
(out/slice_manifest.json) now carries generated_at
2026-11-13T05:39:32Z — the slice was regenerated in PR 1's Phase B
determinism re-run (byte-identical slice, per the data dir's
INDEX.md) and D3-1 derives the id from generated_at. The gate
asserts one consistent snapshot + manifest counts, both of which
hold, so the gate legitimately passes 10/10; the stale strings live
in docs (README's expected-report line and D3-1's parenthetical),
which are the Claim Auditor's pass, not the Builder's.

### Claim-audit fix pass (2026-11-15)
Applied all of the independent claim audit's recommended edits
E1–E10 (`PR3-CLAIM-AUDIT-2026-11-15.md` in this directory):
E1 (header branch/baseline 140/140), E2 (D3-1 snapshot
`ol-2026-11-13`), E3 (D3-18 `runs.ts` resolution note — fixed in
the final tree), E4 (2026-11-12 gate section retitled as the
original/superseded run), E9 (D3-7 stored first-language counts)
in this log; E5 (migration filename
`20261111130100_p4_listing_facets.sql`), E6 + E7 (README snapshot
`ol-2026-11-13`), E8 (README gate results 191/191 at `efdec56` +
`runs.ts` fixed wording), and E10 (F1 owner-gate check, below) in
`scripts/seed/README.md`. Audit headline results: 4/4 suspected
items confirmed stale, 5 additional findings A1–A5, and F1 — the
`review_aspects_queue` PostgREST-exposure check — was absent from
the README's owner-gate procedure and is now added as its step 2
(with the pre-seed corrective step if the view is readable via
PostgREST). README changes committed as one docs commit; new
branch head: `c1e6d454bff3aeed4b03081472408483e27b875e`
(`c1e6d45`, "P4 PR 3 (seed/docs): claim-audit corrections + F1
owner-gate check") on `feat/p4-pr3-seed-patha`. This log lives
outside the repo, so its edits create no commit. Nothing was
pushed.

## PUSH PASS 2026-11-15

Coordinator record (push + PR; build-side detail in the "Push pass
2026-11-15" section above and the claim-audit fix pass note inside it).

- **Rebase:** `git rebase --onto origin/feat/worker-native-route-b
  9e41ce2` replayed only the four PR 3 commits (proto `9fd4aae`,
  worker `666ad9c`, frontend `2932c9f`, seed/docs `7515153`) onto the
  merged PR 2 base `2555ff8b`. Exactly one conflict:
  `worker/src/db/client.ts` — both sides had widened `QueryValue`
  with `Record<string, unknown>`; converged to one copy, keeping
  PR 3's array members. No PR 3 commit touches `worker/src/ai/runs.ts`,
  so the merged (round-1-fixed) module came in verbatim — D3-18's flag is
  retired by the rebase. Three pass commits followed: F3-C
  (`dc0f0db`), GIF regeneration (`efdec56`), claim-audit doc fixes
  (`c1e6d45`).
- **F3 — option C as designed (no fallback):** success path untouched
  (startRun/finishRun stay inside the link transaction); on rollback,
  `writeCompensatingErrorRun` writes one finished `error` ai_runs row
  on the non-transactional handle, carrying the attempt's inputs and
  the caught error. Two new unit tests pin both directions.
- **Gates at the final head (executed, scratch PG 16.15 + pgvector
  0.8.0, amended migrations):** seed gate **10/10** (loader counts ==
  manifest; run-2 inserted=0 ×6; links 6/1/1; B-mask spot joins
  12/12; gate DB ai_runs payloads verified as JSON objects); vitest
  **191/191** (140 merged baseline + 49 PR 3 + 2 F3); typecheck
  clean; frontend build green, 0 `localhost` in dist; proto generated
  files byte-identical. GIFs 01 + 04 regenerated from the final run;
  02 + 03 re-rendered byte-identical.
- **Claim audit (independent, clean context):** seeded stale-item
  recall **4/4** (header 135/135 baseline; pre-review branch-base
  line; D3-18's runs.ts flag; the 2026-11-12 gate numbers) plus 5
  additional findings (A1 snapshot id `ol-2026-11-13` in both docs;
  A2 a non-existent migration filename in the seed README; A3 the
  README's superseded gate numbers; A4 the README's repeated runs.ts
  claim; A5 D3-7's language-count basis). All fixed pre-push
  (edits E1–E10). The F1 `review_aspects_queue` PostgREST check was
  ABSENT from the seed README's owner-gate list and is now step 2
  (E10). Full audit: `PR3-CLAIM-AUDIT-2026-11-15.md` in this dir.
- **Push:** via the PAT Git Data API as **LuckyP86H** (GET /user
  verified, id 46582797), per-commit blobs→tree with tree-SHA
  assertions (all 7 matched) and a single ref creation. Local head
  `c1e6d454bff3aeed4b03081472408483e27b875e` → remote head
  `d136ded43d351d6cb0187eb3231a8975534581df` (tree-identical,
  tree `9e6301a6`).
- **PR #67:** https://github.com/LuckyP86H/smart-bookstore/pull/67 —
  base `feat/worker-native-route-b`, mergeable clean (read back),
  Workers Builds **success** on the head (read back via check-runs).
  Owner pause-point steps are unchanged: apply the five amended
  migrations in the dashboard, run the new F1 check, then the seed
  loader with his own credentials.

## FIX ROUND 2026-11-16 — Lily's review of PR #67 (CHANGES_REQUESTED, review 5922392173 on d136ded4)

Builder pass (sole code writer; coordinator pushes after an independent
claim audit). Starting state verified: branch `feat/p4-pr3-seed-patha`
clean at local head `c1e6d45` (remote `d136ded4` tree-identical).
Specification: Lily's review body + 16 inline comments (saved in full
at /tmp/sb67_review.txt, read completely before starting).

Environment truth at round start (checked, not assumed):
- Scratch cluster /tmp/pg2-scratch WIPED and NO PostgreSQL binaries on
  the VM at all — rebuild per the PR63-FIX-LOG recipe (apt PG 16.15,
  server-dev, pgvector 0.8.0 from source `make with_llvm=no`, cluster
  /tmp/pg2-scratch port 54329) started in background at round start.
- Staging Worker https://smart-bookstore.paulxu155.workers.dev
  responds HTTP 200 (curl HEAD, 2026-11-16) — item 13 smoke feasible.
- Playwright chromium present in the VM (~/.cache/ms-playwright
  chromium-1248; @playwright/test installs exist in sibling review
  clones) — item 10 recording attempt is feasible in principle.

Checklist (tick as done; gate numbers copied from run logs only):
- [x] Item 1: docs/PR3-BUILD-LOG.md committed (this log, repo copy)
- [x] Item 2: prefill routed through throttled+memoised OL lookup + test
- [x] Item 3: GetWork workId-wins in proto + code + test
- [x] Item 4: seed README gate record -> real head, dated correction
- [x] Item 5: F1 as migration 20261111130500 + gate assertions/probe; README six migrations + exposure framing
- [x] Item 6: seed accounts README correction + --staging guard in generate_synthetic.py
- [x] Item 7: link_seed.ts idempotency guard + README re-run behaviour
- [x] Item 8: load_slice.py OL alias guard (mirror Wikidata)
- [x] Item 9: isbn13.ts header correction + full-width rejection test
- [x] Item 10: WorkPage recording (real / replay-labelled / deferred+blocker)
- [x] Item 11: WorkPage edition attribution (title/publisher/year) + verify_workpage pin
- [x] Item 12: WorkReview.is_synthetic proto + GetWork + WorkPage badge + aggregate wording
- [x] Item 13: staging smoke (read-only) recorded in seed README, or explicit deferral
- [x] Item 14: gate real-Postgres F3 rollback step
- [x] Item 15: assertions.sql §3 jsonb_typeof object checks
- [x] Item 16: Book linked flag through list query (proto + RPC + frontend)
- [x] Scope question: D3-16 reading recorded as dated annotation at plan §4.6/§9 in BOTH plan copies; §15 PR 3 branch name fixed in both
- [x] Nits: F3-C comment 'in the normal case'; works.ts no-projection comment; generate_synthetic donor check + e3 loud warning + --reset docstring; pin aliases 21,597 / B-mask 12 / rejected 29; .gitignore seed bundles; .synthetic-badge dedupe; load_slice docstring path placeholder; DEPLOY.md P3 update; README typo 'an interrupted run'
- [x] Parked (reasoning recorded, no behaviour change): agreement.ts NFKC; merchant.ts AddBook synchronous Path A latency; identity.ts ambiguous-path partial evidence — EVALUATE transactional wrap
- [x] Gates at final head: seed gate (rebuilt scratch PG, amended migrations), vitest, typecheck, frontend build (0 localhost), proto regen byte-identical; gate GIFs regenerated if displayed output changed; logs in gate-logs-seed-fixround/

### Progress checkpoint 1 (2026-11-16, builder)
Scratch env REBUILT and verified: apt PostgreSQL 16.15, pgvector
0.8.0 built from source (make with_llvm=no), cluster /tmp/pg2-scratch
port 54329, `create extension vector` -> 0.8.0, halfvec works.
Committed so far (local, on c1e6d45):
- fd84c6c proto (items 3/12/16 contracts)
- 99212b6 worker prefill throttle (item 2; OL tests 8, merchant-p4 10 PASS)
- 0735030 worker works/queries/isbn13/identity (items 3/9/12/16 + F3-C
  comment nit + works no-projection comment nit; ambiguous-path
  evidence wrap EVALUATED = DONE — one transaction on the tx handle,
  fits the existing writeLink/writeDemotion structure)
- cc8339b frontend (items 11/12/16 UI + badge dedupe)
- d4de093 schema F1 migration 20261111130500 (item 5)
- 0cf8b45 seed gate hardening (items 5-gate/6/7/8/14/15 + pinned numbers) [amend mapping: `0cf8b45` -> `9bb5f60` — `0cf8b45` was amended away (§9 fixture fix) and does not exist in the final history; the amended commit is `9bb5f60` (dated correction, 2026-11-16 claim-audit fix)]
F1 probe design PROVEN on the scratch cluster before writing §9:
probe role + SET ROLE inside a DO block — invoker view refuses,
owner-semantics control view returns the planted row.

### Progress checkpoint 2 (2026-11-16, builder)
Seed gate at the fix-round head (0cf8b45 + §9 fixture fix, amended) [amend mapping: `0cf8b45` -> `9bb5f60` — the amended commit in the final history is `9bb5f60` (dated correction, 2026-11-16 claim-audit fix)]:
**11 passed, 0 failed** — scaffolding + 9 migrations; loader x2
(inserted=0 x6); generator (--staging); link_seed 6/1/1;
assertions.sql 9/9 groups (new: §1 aliases 21,597 pin, §3
jsonb_typeof object checks, §9 F1 invoker catalog + functional
probe); spot_joins (B-mask 12 pin + rejected-ISBN 29 recomputation
pin PASS); verify_workpage (incl. new edition-attribution +
review-isSynthetic checks); verify_f3_rollback (real-DB F3: forced
listing_links failure -> 1 finished error ai_run, 0 links).
First §9 attempt failed on the reviews (book_id, customer_id) unique
key — probe now plants its review on a reviewless synthetic listing.
Item 7 proven separately: link_seed re-run against the gate DB
prints the skip line for the demoted listing, processes only the
no-ISBN listing, evidence counts unchanged (6 auto_linked/1 rejected).
Logs: gate-logs-seed-fixround/.

### FIX ROUND RESULTS (2026-11-16, all executed at head d753dbc — local hash; pushed equivalent `42aee8b`, tree-identical — unless noted)

Local commits on c1e6d45 (coordinator pushes; pushed-head mapping is
the coordinator's record):
- fd84c6c proto — WorkReview.is_synthetic, Book.has_work, GetWork
  work_id-wins comment (items 3/12/16 contracts)
- 99212b6 worker — prefill throttled+memoised lookup (item 2)
- 0735030 worker — works/queries/isbn13/identity (items 3/9/12/16,
  F3-C comment nit, works no-projection comment nit, ambiguous-path
  transactional wrap)
- cc8339b frontend — edition attribution, demo badges, linked-only
  titles, shared badge CSS (items 11/12/16 + badge nit)
- d4de093 schema — F1 migration 20261111130500 (item 5)
- 9bb5f60 seed — gate hardening (items 5-gate/6/7/8/14/15 + pins; amended from `0cf8b45` — amend mapping `0cf8b45` -> `9bb5f60`, see progress checkpoints)
- d753dbc docs (pushed as `42aee8b`) — plan annotations, DEPLOY
  update, seed README, WorkPage GIF (scope question, items 10/13
  records)
- (final docs commit on top: this log's repo copy + README gate-head
  fill + regenerated GIFs 03/04 — docs-only, the c1e6d45 precedent)

Per-item disposition:
1. FIXED — docs/PR3-BUILD-LOG.md committed in this round's final
   docs commit (repo copy of this log, PR2 precedent).
2. FIXED — createOpenLibraryBookInfoLookup: every underlying OL
   request serialised + spaced >=334ms, 10-min memoisation incl.
   negatives, errors not cached; connect-app wires one shared
   instance into the merchant service. Tests: open-library.test.ts
   (+2: spacing across ALL sub-requests, negatives, error-no-cache),
   merchant-p4.test.ts (+1: the OL step goes through the injected
   lookup, raw fetch untouched).
3. FIXED — workId-wins stated identically in proto + resolveProjection
   comment; works.test.ts pins it with distinguishable projections.
4. FIXED — seed README gate section carries a dated correction:
   efdec56 was a local pre-push hash; the pushed head was d136ded4;
   the fix-round record cites the executed head d753dbc.
   **Round-2 completion (2026-11-16, review 5926758268 item 1):**
   d753dbc is itself a local hash; its pushed equivalent `42aee8b`
   (tree-identical, verified by tree SHA) is now named in the seed
   README, in this log, and in the PR description, and the full
   local→pushed mapping for the branch is tabulated in the
   round-2 section below.
5. FIXED — migration 20261111130500 recreates the view WITH
   (security_invoker = true); gate assertions §9 proves catalog
   (reloptions) AND function (probe role refused through the invoker
   view, answered by an owner-semantics control view, planted
   pending row, all artifacts cleaned up); README owner procedure is
   SIX migrations and states the exposure exists from the moment
   PR 2's migrations land.
6. FIXED — README corrected (seed accounts are non-login fixtures:
   plaintext record parses as malformed PHC -> ok:false);
   generate_synthetic.py refuses to run without --staging or
   SEED_STAGING_CONFIRM=staging (exit 2, message names the risk);
   the gate passes --staging.
7. FIXED — link_seed.ts skips unlinked listings that already have
   evidence (prints the skip count); README documents re-run
   behaviour. Proven live against the gate DB: re-run skipped the
   demoted listing, processed only the no-ISBN listing, evidence
   counts unchanged (6 auto_linked / 1 rejected).
8. FIXED — load_slice.py OL alias loop guards on
   author_name_by_key, mirroring the Wikidata loop; counted ==
   inserted by construction (gate §1 now also asserts the alias
   total 21,597 independently).
9. FIXED — isbn13.ts header documents the full-width divergence
   (loader accepts, Worker rejects -> null, safe direction, root fix
   #72 R1); isbn13.test.ts pins the Worker's rejection (full-width
   13 and 10).
10. FIXED (real capture) — scripts/seed/gifs/05-workpage-demo.gif:
    frames captured by Playwright/Chromium from a REAL local run —
    production frontend build served locally, production Connect
    router (serveConnectRequest) against the seeded gate DB, fixture
    credential double for login (seed accounts cannot log in, item
    6). The capture log shows: grid 8 cards / 6 clickable titles
    (item 16 visible), work page banner present, aggregate reads
    "1 review (including demo reviews)", review meta names the
    edition "(Dutton Adult, 1972)", 1 demo badge on the review.
    Caption in the GIF + README states the provenance honestly;
    cover images are blank because the sandbox proxy blocks
    covers.openlibrary.org from Chromium. Harness lived in /tmp
    (scratch, not shipped); the GIF is the deliverable.
11. FIXED — WorkPage renders edition title/publisher/year from the
    page's editions list; verify_workpage.ts pins that the review's
    edition attribution resolves to a catalogue edition with a title.
12. FIXED — WorkReview.is_synthetic (proto field 5) carried from
    books.is_synthetic through GetWork; WorkPage badges demo reviews
    and the aggregate reads "(including demo reviews)" when any
    review is synthetic; verify_workpage pins the flag.
13. EXECUTED, SURFACE BLOCKED (recorded, not deferred silently) —
    staging smoke 2026-11-16, read-only: GET / -> 200 (app shell
    loads); every Connect RPC POST tried — the four RPCs tried
    (GetAvailableBooks, GetWork, GetBookDetails,
    MerchantService/LookupBookByISBN) -> HTTP 500 "Failed to start
    container: There is no container application assigned to this
    Durable Object namespace". Pre-existing P1-P3 RPCs fail
    identically, so this is the staging deployment's container
    provisioning state (owner/dashboard), not a PR 3 regression.
    RPC-level smoke (GetWork not-found, Lookup public path) cannot
    complete until the owner resolves the container assignment;
    those paths are proven locally (gate + vitest). Full record:
    gate-logs-seed-fixround/staging-smoke.log + seed README.
    TOOLING NOTE: two backgrounded curl batches in this session
    delivered inconsistent transcripts (one showed detailed
    200/400/404 RPC bodies that no direct run reproduces). Every
    staging result recorded here was re-verified by direct
    foreground curl (verbose, real CF-RAY); the 500s reproduce
    100%, the detailed bodies 0%. Only directly observed results
    are recorded.
14. FIXED (preferred route) — verify_f3_rollback.ts is a real gate
    step: forced INSERT INTO listing_links failure inside the
    shipped linker against real Postgres -> call rejects with the
    forced error, 0 listing_links, exactly 1 ai_runs row (status
    error, finished_at stamped, jsonb_typeof input/output = object,
    output.compensated = true). DEPLOY.md records it as a NEW
    real-DB gate step; the P3 parity harness's real-Postgres
    concurrency check remains open (not satisfied by this step).
15. FIXED — assertions.sql §3 asserts jsonb_typeof(input)='object'
    AND jsonb_typeof(output)='object' for derivation runs.
16. FIXED — Book.has_work (proto field 20) from an EXISTS
    (listing_links) in the list/detail query; BookCard renders the
    title as a button only when has_work (unlinked = plain text);
    the friendly GetWork 404 stays for direct/deep links. Grid
    capture (item 10) shows 6 of 8 titles clickable.

Scope question: ANSWERED YES — RPC-layer marking is the intended
P3 reading of §4.6 (D3-16). Recorded as a dated (2026-11-16)
annotation at §4.6 AND §9 in BOTH plan copies (repo
docs/P4-BOOKS-FINAL-PLAN.md and
~/workspace/review-scratch/smart-bookstore-pr51/P4-BOOKS-FINAL-PLAN.md;
the two copies still differ only by the repo copy's pre-existing
header line). §15 PR 3 branch name fixed to feat/p4-pr3-seed-patha
in both copies.

Nits: F3-C comment qualified 'in the normal case' (identity.ts);
works.ts no-projection 404 comment (the linked-but-no-projection
gap is future work); generate_synthetic donor-agreement check at
generation time (mirrors bandsPass; fails fast), e3 fallback prints
a loud WARNING, --reset docstring/help notes ai_runs survive with
listing_id NULL; three numbers pinned (aliases 21,597 in
assertions §1; spot_joins asserts len(cases)==12; rejected ISBNs
29 recomputed + asserted in spot_joins); .gitignore covers
.link_seed/.verify_workpage/.verify_f3_rollback bundles;
.synthetic-badge deduped into frontend/src/components/
synthetic-badge.css (one definition, imported by both components);
load_slice.py docstring DATA_DIR is a placeholder; DEPLOY.md P4 PR 3
section updated for the 2026-11-15 push pass + this round; seed
README typo 'a interrupted' -> 'an interrupted'.

PARKED (no behaviour change, reasoning):
- agreement.ts NFKC: root fix is #72 R1 / PR 4 engine work; changing
  agreement normalisation now would move the gate's link numbers.
- merchant.ts AddBook synchronous Path A latency: known follow-up —
  a slow OL fallback (10s timeout) delays the merchant response;
  failures are swallowed but latency is not; the async redesign is
  out of PR 3 scope.
- identity.ts ambiguous-path partial evidence: EVALUATED AND DONE
  (not parked) — the proposed-evidence inserts now run in ONE
  transaction on the tx handle; the wrap was small and fits the
  existing writeLink/writeDemotion structure, and the transactional
  stub tests still pass.

Gates at d753dbc (pushed as `42aee8b`; numbers copied from run
logs; gate-logs-seed-fixround/):
- Seed gate: 11 passed, 0 failed (fresh DB; scaffolding + 9
  migrations; loader run 1 counts = manifest 5070/21597/4993/20000/
  13940/4993 with 29 rejected ISBNs; run 2 inserted=0 x6; generator;
  link_seed 6 linked / 1 demoted / 1 no_isbn; assertions.sql 9/9
  PASS groups; spot_joins B-mask 12/12 + isbn_index 13,940 +
  rejected recomputed 29; verify_workpage PASS incl. new checks;
  verify_f3_rollback PASS).
- vitest: 197/197, 18 files (191 at PR head + 6 new: OL BookInfo
  lookup x2, merchant prefill routing x1, works precedence x1,
  queries has_work x1, isbn13 full-width x1).
- Typecheck: clean (exit 0).
- Frontend production build: green; grep 'localhost' over
  frontend/dist = 0 hits.
- Proto: npm run generate exit 0; git status clean afterwards —
  generated files byte-identical.
- GIFs: 03 (412,993 B) and 04 (137,554 B) regenerated from this
  run's logs (assertions 9 groups / summary 11 / vitest 197 changed
  their content) and final frames QC'd; 01 (160,308 B) and 02
  (189,193 B) re-rendered byte-identical, untouched. New:
  05-workpage-demo.gif (408,081 B, real capture, item 10).
- Toolchain floor record: data venv pip 26.3 (above the 26.2.2
  floor); node v24.22.1; PostgreSQL 16.15 + pgvector 0.8.0 rebuilt
  this round per the standing recipe (the VM had neither).
- One operational note: the first final gate attempt failed at
  'fresh scratch database' because the item-10 recording server
  still held connections to sb_p4_seed; it was stopped and the
  gate re-ran clean — recorded here so the failed attempt is not
  mistaken for a code failure.

Checklist: all items ticked, including item 1 — completed by
the final docs commit carrying this log's repo copy (`0b4ea90`).

FIX ROUND CLOSED 2026-11-16: item 1 completed by this round's
final docs commit (docs/PR3-BUILD-LOG.md in-repo; this data-dir log
and the repo copy are byte-identical). Branch NOT pushed —
coordinator pushes after the independent claim audit.

## FIX ROUND 2 (2026-11-16, review 5926758268 — 6 items)

Lily verified 15 of the 16 round-1 items fixed and raised 6 small
doc/cosmetic residuals ("Once these are in, I'll approve"). All 6
are addressed here. Commits this round (local -> pushed,
tree-identical; push via the PAT Git Data API as LuckyP86H,
GET /user verified id 46582797, per-commit tree-SHA assertions all
matched):

- 7e8619c -> b44b9ee seed — assertions §3 NULL closure (item 5) +
  load_slice ref_authors derivation (item 6)
- 5353f2c -> 82155f9 frontend — WorkPage review spacing (item 2);
  **the round-2 gate was executed at this head**
- f22df64 -> 922843b seed — GIF 05 regenerated (item 2)
- (final docs commit on top: this section, the README round-2
  notes, and docs/PR3-CLAIM-AUDIT-2026-11-15.md — its pushed hash
  is recorded in the round-2 summary comment on the PR, since a
  commit cannot cite itself)

Per-item disposition:

1. FIXED — the gate record's executed head `d753dbc` did not
   resolve in the pushed history (same defect class as the
   `efdec56` it replaced). Facts re-verified this round, not taken
   on trust: `42aee8b` exists in the pushed history
   (42aee8bbb947be772cb8f9b027d8efac88ce7acc); its tree
   5b5c834bf5882d2c9f0d9fed92978148307550ca equals the executed
   local head d753dbc's tree exactly; `d136ded4`'s tree
   (9e6301a6b77744739b2d640f9735625b193cc50f) equals local
   c1e6d45's; and the two commits above `42aee8b` change only
   docs, GIFs, and one shell comment (the run_gate.sh hunk in the
   top commit is comment-only — verified in the diff). The record
   stays honest: the gate WAS executed at the local head; all
   three places (seed README gate section, this log's fix-round
   header / commit list / item-4 disposition / gates line, and the
   PR description's Verification section) now name `42aee8b` as
   the pushed equivalent.
2. FIXED — `.work-review-rating` now has a CSS rule
   (font-weight 600, margin-right 0.5rem) in WorkPage.css; the
   rating and review text no longer run together. GIF 05
   regenerated from a fresh REAL Playwright/Chromium capture
   (production frontend build with the fix + production Connect
   router + seeded gate DB, fixture credential double; harness in
   /tmp, scratch as in round 1). Frame 3 shows "★ 5 Seed fixture
   review: exactly as described." with the rating spaced and
   bold. New GIF: 412,361 B, 3 frames, 1000x791, durations
   1700/1700/2600 (same geometry as round 1); GIFs 01-04
   byte-identical, untouched. Capture notes: the first attempt at
   a 1000px viewport rendered the stacked sub-`lg` layout and a
   1280px attempt picked up the `xl` cart column; the final
   capture used 1200x873 (downscaled to 1000x727), matching round
   1's composition. Chromium's cover loads failed with
   ERR_TUNNEL_CONNECTION_FAILED — the known sandbox-proxy
   blanking, disclosed in the GIF footer and the seed README.
3. FIXED — D3-18 now carries a dated update line (2026-11-16)
   recording that its closing sentence ("gate asserts ai_runs on
   kind/status/non-null output only") is superseded: §3 asserts
   the payloads are jsonb objects (round 1, item 15), hardened to
   IS DISTINCT FROM in this round (item 5).
4. FIXED (commit route) — `PR3-CLAIM-AUDIT-2026-11-15.md` is now
   committed at `docs/PR3-CLAIM-AUDIT-2026-11-15.md`, byte-identical
   to the data-dir original (sha256
   4646b958abc75313b0f8539c3a83d412431a035c7c65ecdf083118e7fa076446),
   so both citations in this log ("in this directory" / "in this
   dir") resolve truthfully. Contents checked before committing:
   no secrets; the single machine-local path it contains (the
   auditor's scratch-clone path, in its Materials section) is
   self-describing provenance — where the audit ran — not a
   repo-location claim, so the commit route stands over rewording.
5. FIXED + BITE-PROVEN — assertions.sql §3 now uses
   `jsonb_typeof(...) IS DISTINCT FROM 'object'` for both input
   and output. Proof against the gate DB (log:
   gate-logs-seed-fixround2/bite-proof-item5.log): inside one
   transaction, a derivation ai_run's `input` was set to NULL;
   the OLD `<>` predicate did NOT fire (the row slipped through,
   reproducing the gap), the NEW predicate fired, and the full
   assertions.sql then raised exactly the §3 exception
   ("a derivation ai_run payload is not a jsonb object") at §3.
   The transaction never committed; a follow-up read shows the
   row's payloads are jsonb objects again — the gate DB was left
   untouched, and the clean gate run (below) passed with the new
   check in place.
6. FIXED — load_slice.py `expected['ref_authors']` is now
   `len(rows['authors'])` (counted == inserted by construction,
   the alias-loop treatment from round 1 item 8): build_rows
   skips nameless authors at insertion, so the manifest's
   total_authors would over-count on any future slice containing
   one. This slice unchanged: gate loader line reads
   "ref_authors: before=0 inserted=5070 total=5070 expected=5070
   OK".

Citation sweep (standing proactive-review rule, same class as
item 1): every SHA-like token in scripts/seed/README.md,
docs/PR3-BUILD-LOG.md, scripts/schema/README.md, and the PR
description was extracted (28 unique candidates) and tested
against the pushed repo via GET /commits/<sha>. 4 unique commits
resolve directly (2555ff8b, 27a4eddb, 42aee8b, d136ded4 — the
last also cited in full form); 1 token (9e6301a6) is a TREE hash
and resolves via GET /git/trees (it is d136ded4's tree, cited as
a tree). The other 22 tokens are local pre-push hashes from the
coordinator's clone; each is mapped below by tree SHA, so every
citation in the record now resolves or is explained:

  local     pushed    what it is
  9fd4aae   65954b8   PR 3 proto commit (post-rebase)
  666ad9c   cd4980c   PR 3 worker commit (post-rebase)
  2932c9f   2550b81   PR 3 frontend commit (post-rebase)
  7515153   d94f169   PR 3 seed commit (post-rebase)
  dc0f0db   ba3c7b6   F3 option C
  efdec56   3e9e84e   push-pass GIF regeneration
  c1e6d45   d136ded4  push-pass head (PR as opened)
  fd84c6c   7a1ff27   fix round 1: proto contracts
  99212b6   a686df4   fix round 1: prefill throttle
  0735030   cf762c1   fix round 1: worker items
  cc8339b   277fbd4   fix round 1: frontend items
  d4de093   48bad07   fix round 1: F1 migration
  9bb5f60   0bc9f2d   fix round 1: gate hardening
  d753dbc   42aee8b   fix round 1: docs (gate executed head)
  0b4ea90   1d7aabf   fix round 1: build log committed
  a9c0f88   a13646b9  fix round 1: claim-audit corrections (head
                      Lily reviewed in round 2)
  9e41ce2   53924b6e  PR 2 pre-review head — the original PR 3
                      base (tree-paired; 53924b6e was PR #63's
                      round-1 reviewed head)
  0cf8b45   (none)    amended away before pushing; the log's
                      inline amend mapping (0cf8b45 -> 9bb5f60)
                      already says so, and 9bb5f60 -> 0bc9f2d
                      above completes the chain
  c883a64 / 7c6eb56 / b26c175 / 179902e
            (none)    the four ORIGINAL pre-rebase build commits;
                      never pushed in this form — the rebase
                      replayed their changes as
                      9fd4aae / 666ad9c / 2932c9f / 7515153
                      (mapped above), exactly as the rebase
                      record in this log already states

All-digit lookalikes in the corpus are not commits (migration
ids 20261111130400 / 20261111130500, the reviewer id 46582797,
review id 5922392173, ISBN 9780134685991) and were excluded.

Gates at 5353f2c (pushed as `82155f9`; numbers copied from run
logs; gate-logs-seed-fixround2/):

- Seed gate: 11 passed, 0 failed (fresh DB; scaffolding + 9
  migrations; loader run 1 counts = manifest 5070/21597/4993/
  20000/13940/4993 — ref_authors expected now derived from the
  inserted row set, still 5070; run 2 inserted=0 x6; generator;
  link_seed 6 linked / 1 demoted / 1 no_isbn; assertions.sql 9/9
  PASS groups incl. the hardened §3; spot_joins B-mask 12/12 +
  isbn_index 13,940 + rejected recomputed 29; verify_workpage
  PASS; verify_f3_rollback PASS).
- vitest: 197/197, 18 files (unchanged; no test added — the
  item-6 derivation is exercised end-to-end by the loader's own
  gate report, and a unit test would have to import the loader's
  main() against a fabricated manifest, which does not fit the
  existing test layout; noted rather than forced).
- Typecheck: clean (exit 0). Frontend production build: green;
  grep 'localhost' over frontend/dist = 0 hits. Proto:
  `npm run build` ran the full generate step; git status clean
  afterwards — generated files byte-identical.
- Scratch env rebuilt again this round (VM restart had wiped
  it): pgvector v0.8.0 built from source (make with_llvm=no),
  cluster /tmp/pg2-scratch port 54329, `create extension vector`
  -> 0.8.0, halfvec verified — the standing recipe.

FIX ROUND 2 CLOSED 2026-11-16: all 6 items fixed and replied on
the PR; branch pushed (docs commit on top of 922843b); this
data-dir log and the repo copy are byte-identical. NOT merged —
Lily re-reviews and approves.
