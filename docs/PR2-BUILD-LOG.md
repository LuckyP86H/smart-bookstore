# PR 2 build log — smart-bookstore P4 Step 2 (thin platform + schema)

Branch: `feat/p4-pr2-schema-platform` off `feat/worker-native-route-b`
@ `5d0e5eab92c01d9b20e89093a5b7c0bb823c05cb` (verified before branching).
Baseline in this tree before any change: `npm test` = **123/123** (2026-11-11).
Governing spec: `P4-BOOKS-FINAL-PLAN.md` §2, §3.6, §6, §9 Step 2, §12, §15 PR 2.

## Decisions (delegated judgment; plan-level scope untouched)

- **D-R1 — `ai_runs` is a CREATE, not an ALTER.** The plan calls Step 2's
  ai_runs work an "upgrade" (D6), but no `ai_runs` table exists anywhere in
  this repo (grep over ts/sql/go/py: only BASELINES.md mentions it). PR 2
  creates it directly in the upgraded shape (§3.6: `parent_run_id`, full
  input/output). Flagged as plan-vs-repo discrepancy in the PR report.
- **D-R2 — The "384-dim assertion" is the column type.** In this codebase the
  dimension assertion is `books.embedding extensions.vector(384)` itself
  (plus its HNSW index). PR 2 replaces it with `vector(1024)`; the gate
  proves a 384-dim insert now fails loud and a 1024-dim insert succeeds.
  The Python ai-service (`settings.py` EMBEDDING_DIM=384) and the Go backend
  (`database.go` ALTER … vector(384)) still say 384 — they are the container
  stack that stays until P5 (decision 12) and the Go parity surface frozen
  at P3 (§12 item 8), so PR 2 does not touch them. Flagged in the report.
- **D-R3 — Scratch Postgres = local apt PostgreSQL 16 + pgvector**, one
  instance, shut down after the gate. No Docker exists in the VM; the repo's
  vitest suite is stub-based and never opens a DB, so the gate harness is
  bash + psql under `scripts/schema/`. If the distro pgvector is < 0.7
  (no `halfvec`), build pgvector 0.8.x from source against the distro
  server-dev headers. (Outcome recorded below.)
- **D-R4 — Supabase scaffolding for rehearsal.** Vanilla Postgres lacks two
  things Supabase pre-provides and the existing migrations assume: the
  `extensions` schema (migration 1 does `create extension … with schema
  extensions`) and `public.rls_auto_enable()` (migrations 2–3 revoke
  execute on it). The harness creates both as *environment scaffolding*
  before applying any repo migration, and says so in its output. This
  replicates Supabase, it is not part of any migration file.
- **D-R5 — Migration tracking mirrors Supabase.** The harness keeps a
  `p4_gate.applied_migrations` table and applies each file exactly once;
  a second harness run is a no-op (that is the idempotency the repo's
  forward-only, no-down-file convention supports — there are no down
  migrations anywhere in this repo to test).
- **D-R6 — FK delete behaviour.** Derived-from-listing rows
  (`listing_facets`, `listing_links`) are `ON DELETE CASCADE` — facets and
  links are rebuildable derivations, and `RemoveBook` (P3 parity) must keep
  working on listings that have them. `evidence` also cascades: a rejected
  pair whose listing is deleted is moot, and blocking P3 deletes would
  break parity; "kept forever" (§3.6) governs live listings. `tasks` use
  `ON DELETE SET NULL` (a sweep row may outlive its listing; the payload
  carries the context). `identity_events` is an append-only receipt log:
  `listing_id` is a plain nullable column, no FK, so receipts survive.
  Assertions never reference listings (work/edition-level stable ids only,
  §3.6), so they never conflict with listing deletion.
- **D-R7 — `isbn_index` is slice-scoped and snapshot-carrying.** PR 1
  measured 34,612,211 distinct ISBN-13s in the full map; §4.2 step 3 keeps
  the full map off-database, so the loadable index covers the slice's
  editions (~20k) plus headroom, keyed by `(snapshot_id, isbn13)`. An
  ISBN-13 can name more than one edition record (PR 1: 37.17M map rows vs
  34.61M distinct), so the index is not unique on isbn13 alone.
- **D-R8 — `pg_trgm` joins `vector` in the `extensions` schema**, qualified
  the same way migration 1 qualifies `extensions.vector_cosine_ops`
  (`extensions.gin_trgm_ops`). §4.3 puts a trigram index on the reference
  records; §3.7's `show_trgm` probe is part of the gate.
- **D-R9 — `is_synthetic` on `books` and on `stores`.** §4.4's rule is
  about listings; fixture stores are equally synthetic, and the Step 3 UI
  disclosure reads listings through their store. Both flags
  `boolean not null default false`.
- **D-R10 — Model id is config (§6).** `EMBEDDING_MODEL` becomes a
  wrangler var (`@cf/baai/bge-m3`); `worker/src/ai/embeddings.ts` reads it
  from env and validates the returned dimension against 1024, throwing
  loud on mismatch. The `AI` binding is added to wrangler.jsonc; the
  container declarations are NOT touched (decision 12).

## Schema contract (what the migration files must implement)

All new tables in `public`, `bigint generated always as identity` PKs,
`enable row level security` with no policies (repo convention — the app
connects as owner and bypasses RLS). Timestamps `timestamptz not null
default now()` unless noted. Reference rows carry `source text not null
default 'openlibrary'`, `source_key text not null`, `snapshot_id text not
null`, unique `(source, source_key, snapshot_id)`.

Migration files (forward-only, repo naming convention, ordered):

1. `20261111130000_p4_reference_catalogue.sql`
   - `create extension if not exists pg_trgm with schema extensions;`
   - `ref_works`: title text not null, title_key text, first_publish_year
     int, subjects text[] not null default '{}', embedding
     extensions.halfvec(1024), embedding_model/recipe/text_hash text,
     embedded_at timestamptz. Indexes: gin (title_key
     extensions.gin_trgm_ops); hnsw (embedding
     extensions.halfvec_cosine_ops).
   - `ref_editions`: work_ref_id bigint → ref_works (nullable — PR 1 found
     7 edition→work keys with no works row), isbn13 char(13), title text
     not null, title_key text, publisher text, publish_year int, language
     text, page_count int. Index: (isbn13); gin title_key trgm.
   - `ref_authors`: name text not null, name_key text, pinyin_key text,
     birth_year int, death_year int.
   - `ref_author_aliases`: author_ref_id → ref_authors cascade, alias text
     not null, alias_key text, script text, source text not null default
     'wikidata'; unique (author_ref_id, alias_key, source).
   - `isbn_index`: isbn13 char(13) not null, edition_ref_id → ref_editions
     cascade, snapshot_id text not null; unique (snapshot_id, isbn13,
     edition_ref_id); index (isbn13).
2. `20261111130100_p4_listing_facets.sql`
   - `books`: add `categories text[] not null default '{}'`,
     `is_synthetic boolean not null default false`.
   - `stores`: add `is_synthetic boolean not null default false`.
   - `listing_facets`: listing_id → books cascade, PK (listing_id);
     isbn13 char(13); title_key text; author_keys text[] not null default
     '{}'; part text; edition_statement text; format text;
     companion_marker boolean not null default false; language
     varchar(50); unified_book_number text (§3.1 witness identifier);
     updated_at.
3. `20261111130200_p4_identity_store.sql`
   - `model_versions`: name text unique not null, weights jsonb,
     thresholds jsonb, comparison_defs jsonb, benchmark_results jsonb.
   - `evidence`: listing_id → books cascade; candidate columns
     candidate_edition_id → ref_editions, candidate_work_id → ref_works,
     candidate_local_work_id → local_works (defined below — order the
     file so local_works comes first or add FK after), candidate_listing_id
     → books; CHECK exactly one candidate column non-null; bands jsonb not
     null; weights jsonb; total_score numeric; model_version_id →
     model_versions; outcome text CHECK in
     ('auto_linked','proposed','rejected'); created_at.
   - `assertions`: left_kind/right_kind text CHECK in
     ('ref_work','ref_edition','local_work'), left_id/right_id bigint not
     null, relation text CHECK in ('same','not_same'), level text CHECK
     in ('work','edition'), asserted_by text not null, reason text,
     created_at. Index on (left_kind, left_id, right_kind, right_id).
   - `local_works`: title text, created_from text not null default
     'residue', variant_of_ref_work_id → ref_works (the §3.3 abridgement
     variant-under-same-reference-work mechanism).
   - `listing_links`: listing_id → books cascade, unique (listing_id);
     edition_ref_id → ref_editions, work_ref_id → ref_works,
     local_work_id → local_works; CHECK exactly one target shape:
     local alone, edition+work, or work alone; status text CHECK in
     ('automatic','confirmed','proposed'); derivation_run_id → ai_runs
     (added by FK in the ai_platform migration, since ai_runs is created
     there — or create ai_runs first in file order; see file 5 note);
     created_at/updated_at.
   - `identity_events`: listing_id bigint (no FK, D-R6), local_work_id →
     local_works (nullable, set null), event_type text CHECK in
     ('link','unlink','relink','group_merge','group_split'), from_state
     jsonb, to_state jsonb, evidence_ids bigint[] not null default '{}',
     manifest jsonb, model_version_id → model_versions, actor text not
     null, created_at.
   - `tasks`: kind text not null, listing_id → books set null, payload
     jsonb not null default '{}', status text CHECK in
     ('pending','claimed','done','failed','dead') default 'pending',
     attempts int not null default 0, claimed_by text, claimed_at
     timestamptz, run_after timestamptz not null default now(),
     last_error text, created_at/updated_at. Index (status, run_after).
     NO Queue objects anywhere — this table is the Act 1 job mechanism.
4. `20261111130300_p4_works_projection.sql`
   - `works`: work_ref_id → ref_works unique nullable, local_work_id →
     local_works unique nullable, CHECK exactly one non-null; title text
     not null, author_display text, categories text[] not null default
     '{}', summary_en text, summary_zh text, created_at/updated_at.
     (Rollups are computed at read time per §3.6 — not stored.)
5. `20261111130400_p4_ai_platform.sql`
   - `prompts`: key text not null, version int not null, body text not
     null, description text, created_at; unique (key, version).
   - `ai_runs`: parent_run_id → ai_runs, kind text not null, provider
     text, model text, prompt_id → prompts, prompt_version int, input
     jsonb, output jsonb, input_tokens int, output_tokens int, neurons
     numeric, status text not null default 'ok' CHECK in ('ok','error'),
     error text, listing_id → books set null, created_at. Comment in SQL:
     payload retention is a job (prune payloads after 90 days, §4.3), not
     a schema property. (D6: this table is the only observability record —
     no Langfuse columns, no dual-write hooks.)
   - FK from file 3: `alter table listing_links add constraint …
     foreign key (derivation_run_id) references ai_runs(id) on delete
     set null` (column itself declared in file 3 without the FK).
   - `books` embedding switch: drop index `idx_books_embedding`; alter
     column `embedding` type `extensions.vector(1024)`; add provenance
     columns embedding_model/recipe/text_hash text, embedded_at
     timestamptz; recreate `idx_books_embedding` hnsw
     (embedding extensions.vector_cosine_ops).
   - `review_aspects`: review_id → reviews cascade, unique (review_id);
     aspects jsonb; status text not null default 'pending' CHECK in
     ('pending','extracted','failed'); model text; created_at/updated_at.
     Plus view `review_aspects_queue` joining reviews + books (the Act 3
     extraction job's input — substrate only, D5: NO job in this PR).

## Worker contract (`worker/src/ai/`)

- `embeddings.ts`: `embedTexts(env, texts)` → reads model id from
  `env.EMBEDDING_MODEL` (falls back to throwing if unset — config, not
  code, per §6/D-R10); calls `env.AI.run(model, { text: texts })`;
  validates every returned vector has length 1024, throws loud otherwise;
  returns `{ model, vectors }`.
- `runs.ts`: `startRun(db, {kind, provider, model, promptId?,
  promptVersion?, parentRunId?, listingId?, input?})` → inserts an
  ai_runs row, returns its id; `finishRun(db, id, {output?, inputTokens?,
  outputTokens?, neurons?, status?, error?})` → updates it. Uses the
  `Db`/`QueryRunner` shape from `worker/src/db/client.ts` so it is
  stub-testable like queries.ts.
- `prompts.ts`: `loadPrompt(db, key)` → latest version row from
  `prompts`; throws loud when the key is absent (a missing prompt is a
  programming error, never a silent empty string).
- `env.ts`: add `AI: Ai;` and `EMBEDDING_MODEL?: string;`.
  wrangler.jsonc: add `"ai": { "binding": "AI" }` and var
  `"EMBEDDING_MODEL": "@cf/baai/bge-m3"`. Containers untouched.
- Unit tests in the repo's vitest style for all three modules (stub
  runner / stub AI), including the 384-length rejection case.

## Gate (executed by the coordinator after integration)

1. Fresh DB: scaffolding (D-R4) → all 8 migrations (3 existing + 5 new)
   in filename order → gate assertions SQL.
2. Live-equivalent DB: scaffolding → the 3 existing migrations (= the
   live schema; live tables hold 0 rows, owner recheck 2026-11-10, so
   schema-equivalence is the honest rehearsal) → the 5 new migrations →
   fixtures → assertions, including: Path A control join resolves;
   1024-dim insert succeeds; **384-dim insert fails** (script asserts
   the failure).
3. Harness re-run is a no-op (D-R5).
4. `npm test` (full suite) + `npm run typecheck` green; new total
   reported against the 123 baseline.

## Run record

- **Scratch Postgres (D-R3 outcome).** Distro candidate for
  `postgresql-16-pgvector` is **0.6.0** — no `halfvec` (needs ≥ 0.7), so
  per D-R3's fallback, pgvector **v0.8.0 was built from source** against
  `postgresql-server-dev-16` (16.15) and `make install`ed. Scratch cluster
  in `/tmp/pg2-scratch` (the workspace mount refuses chown, so the
  throwaway cluster lives outside `~/workspace`; the gate logs still land
  in the data dir), unix socket `/tmp/pg2-scratch/run`, port 54329,
  locale C.utf8 (vs Supabase's en_US.UTF-8 — pg_trgm probe results are
  read with that caveat, §3.7). `create extension vector` → 0.8.0;
  `'[1,2,3]'::halfvec(3)` works. This also matches the live DB's pgvector
  major line (0.8.x; Supabase reports 0.8.2 per plan §4.3).
- **Child B (Worker) complete:** `worker/src/ai/{embeddings,runs,prompts}.ts`
  + 12 tests (full suite sanity 135/135, typecheck green); `env.ts` gained
  `AI` + `EMBEDDING_MODEL`; wrangler.jsonc gained the `ai` binding + var,
  containers verified untouched.
- **Child A (SQL) complete:** 5 migrations (17 new tables), harness +
  fixtures + assertions under `scripts/schema/`. Its flagged catch: the
  contract said "13 new tables" in one sentence but listed 17 — the 17
  govern. Its D-R4 extension: scaffolding also creates the `anon` /
  `authenticated` roles (migrations 2–3 revoke from them; vanilla PG
  lacks them) — same Supabase-replication category, accepted.
- **GATE — PASS (coordinator-run, twice).** `run_gate.sh` against the
  scratch cluster: 7/7 steps, 24 individual PASS lines per run, and a
  second cold invocation reproduced 7/7 with the apply step a no-op
  (D-R5). Highlights: all 17 tables + RLS on both DBs; `books.embedding`
  atttypmod = 1024; Path A control join resolves store A's Effective
  Java → Effective Java work; the lying-ISBN fixture joins to the
  Effective Java edition (mismatch is the data, as designed); evidence
  and listing_links CHECKs reject bad inserts inside DO blocks; the
  `resolve_path_b` task is claimable; **384-dim insert fails with
  `ERROR: expected 1024 dimensions, not 384`, 1024-dim insert
  succeeds.**
- **§3.7 probe, measured:** `extensions.show_trgm('红楼梦')` returns
  exactly **4 trigrams** — the plan's quantitative claim ("a 3-character
  title yields ~4 trigrams") confirmed on the rehearsal DB (locale
  C.utf8 caveat noted above).
- **Full suite (coordinator-run): `npm test` 135/135** (123 baseline +
  12 new ai/ tests), iteration-literal guard clean; `npm run typecheck`
  green. wrangler.jsonc diff is +9/−1 (ai binding + EMBEDDING_MODEL var
  + comments); containers/durable_objects/exports byte-identical.
- **GIFs:** `scripts/schema/gifs/01…04` (0.09–0.20 MB), PIL-rendered
  from the real gate/test logs by `scripts/schema/make_gifs.py`,
  disclosure footer on every frame, linked from `scripts/schema/README.md`
  ("Watch it run (replays)"). Final frames visually QC'd (CJK renders via
  Noto Sans CJK).
- Scratch cluster shut down after the gate (D-R3).

## Child B — Worker half (`worker/src/ai/` + env/wrangler wiring)

Files produced:

- `worker/src/ai/embeddings.ts` — `embedTexts(env, texts)` per the Worker
  contract: model id read from `env.EMBEDDING_MODEL` (throws loud naming
  the missing config when unset/empty/whitespace), calls
  `env.AI.run(model, { text: texts })`, validates the `{ shape, data }`
  response (count === input count, every vector exactly
  `EMBEDDING_DIMENSIONS = 1024`, numeric components, `shape` cross-check
  when present), returns `{ model, vectors }`.
- `worker/src/ai/runs.ts` — `startRun(db, init)` (INSERT … `RETURNING id`,
  `$n` placeholders, input serialised to JSON) and `finishRun(db, id,
  outcome)` (UPDATE of output/input_tokens/output_tokens/neurons/status/
  error by id; status defaults `ok`, flips to `error` when an error is
  given without an explicit status). Column names match the SQL contract
  exactly.
- `worker/src/ai/prompts.ts` — `loadPrompt(db, key)`: highest-version row
  (`ORDER BY version DESC LIMIT 1`), throws loud naming the key when absent.
- Tests: `embeddings.test.ts` (4), `runs.test.ts` (6), `prompts.test.ts`
  (2) — repo stub style (stub Db capturing `(text, values)`, stub AI in
  the documented `{ shape, data }` shape), including the 384-length
  rejection, count-mismatch, and unset-`EMBEDDING_MODEL` cases.
- `worker/src/env.ts` — added `AI: Ai;` (Route B P4 comment) and
  `EMBEDDING_MODEL?: string;` among the plain settings; no other lines
  touched (the two unindented secret lines left exactly as they were).
- `wrangler.jsonc` — added `"ai": { "binding": "AI" }` and var
  `"EMBEDDING_MODEL": "@cf/baai/bge-m3"`; containers, durable_objects and
  exports sections untouched (verified by parse + diff).

Results: `npm run typecheck` green; `npx vitest run worker/src/ai` =
12/12; full `npm test` also run as a sanity check = 135/135 (123 baseline
+ 12 new), iteration-literal guard clean.

Judgment calls (with reasons):

- `embedTexts` accepts `Pick<Env, "AI" | "EMBEDDING_MODEL">` (exported as
  `EmbeddingEnv`), not the whole `Env` — the same stub-testability move
  as `Db`/`QueryRunner` in db/client.ts; a real `Env` satisfies it
  structurally.
- `finishRun` adds `RETURNING id` and throws when no row carries the id.
  The contract says only "updates it"; this mirrors queries.ts
  (`updateStock`/`deleteBook` fail loud on a missing row) so finishing a
  run that was never started cannot fail silently. Covered by a test.
- jsonb payloads (`input`/`output`) are `JSON.stringify`-serialised and
  absent/null stores SQL NULL; Postgres casts the text parameter to
  jsonb from context, consistent with the repo's `$n` style.
- Id-shaped fields (`promptId`, `parentRunId`, `listingId`) accept
  `number | bigint` (listing ids are bigint elsewhere in the codebase);
  `startRun` returns `number`, normalising postgres.js's
  number|string|bigint id.
- No cast was needed at the `Ai.run` call site: a runtime-string model
  routes TypeScript to `Ai.run`'s unknown-model overload, whose
  `Record<string, unknown>` result is then validated defensively as
  `unknown` — looser typing contained by validation, not by an `any`.
- One self-inflicted test bug found and fixed during the run: the stub
  helper's default parameter swallowed an explicit `undefined` model,
  masking the unset-config case; the helper now takes the model
  explicitly at every call site.

## Child A — SQL half (migrations + gate harness)

Files produced (branch `feat/p4-pr2-schema-platform`, uncommitted —
the coordinator runs the gate and commits):

Migrations in `supabase/migrations/`:
- `20261111130000_p4_reference_catalogue.sql` — pg_trgm extension;
  ref_works / ref_editions / ref_authors / ref_author_aliases /
  isbn_index, with the contracted indexes (gin trgm on title_key,
  hnsw halfvec_cosine on ref_works.embedding).
- `20261111130100_p4_listing_facets.sql` — books.categories +
  books.is_synthetic + stores.is_synthetic; listing_facets (PK =
  listing_id).
- `20261111130200_p4_identity_store.sql` — model_versions, local_works
  (created before its dependents), evidence (exactly-one-candidate
  CHECK), assertions, listing_links (one-target-shape CHECK,
  derivation_run_id declared without FK), identity_events, tasks.
- `20261111130300_p4_works_projection.sql` — works projection.
- `20261111130400_p4_ai_platform.sql` — prompts, ai_runs, the deferred
  listing_links.derivation_run_id FK, the books embedding switch to
  vector(1024) + 4 provenance columns, review_aspects +
  review_aspects_queue view.

Gate harness in `scripts/schema/`: `scaffolding.sql`,
`run_gate.sh` (executable), `fixtures.sql`, `assertions.sql`,
`fixture_assertions.sql`, `README.md` (with the
`## Watch it run (replays)` placeholder for the coordinator's GIFs).

Judgment calls beyond the contract, with reasons:
- **Table count is 17, not 13.** The task text said "all 13 new tables"
  but listed 17 names; assertions.sql asserts the 17 listed/created
  tables. Flagged, not silently redesigned.
- **Scaffolding also creates the `anon` / `authenticated` roles.**
  D-R4 names only the extensions schema and the rls_auto_enable()
  stub, but migrations 2–3 revoke execute from those roles, which do
  not exist on vanilla Postgres — the revokes would fail without
  them. Same D-R4 category: Supabase pre-provides them; clearly
  commented in scaffolding.sql.
- **Provenance column names** are `embedding_model`,
  `embedding_recipe`, `embedding_text_hash`, `embedded_at` on both
  books and ref_works (the contract's "embedding_model/recipe/
  text_hash" shorthand, expanded symmetrically; these are the "4
  provenance columns" assertions.sql checks on books).
- **All three fixture stores and all fixture listings are flagged
  is_synthetic.** The task phrase "one store flagged is_synthetic"
  was read against D-R9 ("fixture stores are equally synthetic"):
  flagging everything satisfies "at least one store flagged" and
  §4.4's disclosure rule.
- **The rejected evidence row is the lying listing's pair** (store B
  'Design Patterns' → Effective Java edition, isbn band exact,
  title/author mismatch, outcome 'rejected') — the "Effective Java
  listings" plural read as the two listings carrying that ISBN, and
  it is the negative-lineage case that matters.
- **The 'same'/'work' assertions fixture row pairs the Effective Java
  ref work with itself.** The fixture set contains exactly two
  distinct ref works, so no non-degenerate 'same' pair exists; the
  row exercises the assertion shape against real row ids and says so
  in fixtures.sql.
- **ISBN-10 → ISBN-13 facet conversion computed and verified:**
  '080442957x' → 9780804429573 (978 + first 9 digits + recomputed
  check digit 3). Both contracted ISBN-13s verified checksum-valid.
- **Harness DB lifecycle vs D-R5:** DB names are fixed
  (`sb_p4_fresh` / `sb_p4_live`) so a re-run can find the tracked
  state. A complete DB is left untouched and the re-run prints NO-OP
  (migrations/fixtures skipped; only read-only assertions re-run);
  an incomplete DB (interrupted run) is dropped+recreated for
  determinism, and `GATE_FRESH=1` forces drop+recreate. Each run
  also re-invokes the apply step internally to demonstrate the no-op.
- **NOT NULL discipline:** only where the contract marks it, plus
  FK columns a row is meaningless without (evidence.listing_id,
  listing_links.listing_id, isbn_index.edition_ref_id,
  ref_author_aliases.author_ref_id, review_aspects.review_id).
  tasks.status follows the contract literally (default + CHECK, no
  NOT NULL) where review_aspects/ai_runs status were contracted
  NOT NULL.
- **Extra columns the contract's general timestamp rule implies:**
  created_at on the reference tables, isbn_index, model_versions,
  local_works and listing_facets (the contract lists timestamps
  per-table only for some). Harmless supersets; no contracted column
  was omitted or renamed.
- **`review_aspects_queue`** is defined as pending review_aspects rows
  joined to reviews + books (the extraction job's input); the
  contract names the join and the purpose but not the column list.
- **Child ai_run kind** is 'derive_listing_links' (the contract fixes
  only that a child run exists with parent_run_id set); store A's
  Effective Java listing_links row points derivation_run_id at it.
- Not run by Child A (per instructions): no Postgres was started —
  this VM has no psql/postgres binaries at all; the coordinator runs
  the gate. SQL was syntax-reviewed by hand and run_gate.sh passes
  `bash -n`; the live gate is the real verification.
