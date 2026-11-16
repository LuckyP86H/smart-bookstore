# scripts/seed — P4 Step 3 seed load + Step 4 Path A gate

What lives here:

| File | What it does |
| --- | --- |
| `load_slice.py` | Loads the PR 1 Open Library slice into PR 2's reference schema: `ref_authors`, `ref_author_aliases`, `ref_works`, `ref_editions`, the slice-scoped `isbn_index`, and the `works` display projection. |
| `generate_synthetic.py` | Creates the synthetic demo stores/listings on top of the loaded slice (every row `is_synthetic = true`). |
| `link_seed.ts` | Runs the Worker's own Path A linker over the seed listings (they were inserted directly, bypassing `AddBook`). Safe to re-run: listings that already have evidence for their ISBN are skipped (see below). |
| `run_gate.sh` | The full local gate: fresh scratch DB → 9 migrations → loader ×2 → generator → linker → assertions → spot joins → the real `GetWork` RPC → the real-DB F3 rollback check. |
| `assertions.sql` | SQL gate assertions (counts, link lineage, lying-ISBN demotion, archetypes, `ai_runs` jsonb-object checks, the F1 security-invoker probe). |
| `spot_joins.py` | Independent recomputation from PR 1's artifacts (B-mask spot joins, isbn_index total, synthetic ISBN resolution, rejected-ISBN count). |
| `verify_workpage.ts` | Drives the production `GetWork` RPC against the seeded DB and checks the merged shape. |
| `verify_f3_rollback.ts` | Proves F3 option C against the real DB: a forced link failure inside the shipped linker leaves exactly one finished `error` ai_run and zero links. |
| `make_gifs.py` + `gifs/` | Terminal-replay GIFs rendered from the real gate logs (footer-labelled as replays, not live captures). |

Gate replays (rendered from the real run logs — not live captures):

- [01 — loader counts, run 1 + the inserted=0 re-run](gifs/01-loader-counts.gif)
- [02 — synthetic seed + Path A linking outcomes](gifs/02-seed-and-link.gif)
- [03 — assertions, spot joins, GetWork RPC, gate verdict](gifs/03-gate-verdicts.gif)
- [04 — the vitest suite](gifs/04-test-suite.gif)

And one real screen capture (NOT a terminal replay):

- [05 — WorkPage demo](gifs/05-workpage-demo.gif) — frames captured
  by Playwright/Chromium from a real local run (production frontend
  build + production Connect router + the seeded gate DB, fixture
  credential double for login): grid → click a linked title → work
  page with demo badges. Only linked titles render as buttons
  (6 of the 8 seed listings); cover images are blank in the capture
  because the sandbox proxy blocks `covers.openlibrary.org` from
  Chromium — the flow, badges and edition attribution are the
  evidence. (PR #67 fix round item 10, 2026-11-16.)

## The owner's live seed procedure (Supabase)

This is plan §10 item 3: Pawlie built and gated everything locally;
the live load is yours, with your credentials, when you choose to run
it. **Nothing here has touched the live database.**

1. **Apply the six P4 migrations first**, in the Supabase dashboard
   SQL editor, **one file at a time, in filename order**:
   `20261111130000_p4_reference_catalogue.sql`,
   `20261111130100_p4_listing_facets.sql`,
   `20261111130200_p4_identity_store.sql`,
   `20261111130300_p4_works_projection.sql`,
   `20261111130400_p4_ai_platform.sql`,
   `20261111130500_p4_review_aspects_queue_security_invoker.sql`
   (the repo's `supabase/migrations/` directory; the three older files
   are already live). The dashboard route is deliberate — it is the
   credential-free path this project has used throughout; do not paste
   the database password anywhere else.
2. **The `review_aspects_queue` fix (F1) ships as the sixth
   migration — there is no separate manual step.** The view created
   by `20261111130400` runs with the view OWNER's rights by default,
   which would bypass the RLS-enabled underlying tables for anyone
   who can read the view via PostgREST. That exposure exists **from
   the moment PR 2's migrations are applied, whether or not anyone
   ever seeds** (an earlier version of this README framed it as a
   pre-seed check — that understated it). Migration
   `20261111130500` recreates the view
   `WITH (security_invoker = true)`, so it runs with the caller's
   rights; applying the six files in order in step 1 is the whole
   fix. The seed gate proves the semantics locally (assertions §9:
   catalog check + a probe role that is refused through the view
   while an owner-semantics control view answers it).
3. **One new Python package** in the PR 1 data venv (the loader's
   only dependency beyond what PR 1 already installed):
   `pip install "psycopg[binary]"`
4. **Run the loader** with your own connection string (the
   session-pooler or direct connection string from the Supabase
   dashboard — it never goes through chat or any file):

   ```sh
   DATA_DIR=<dir holding parquet/ + out/> \
   DATABASE_URL=<your Supabase connection string> \
       <data-dir>/venv/bin/python scripts/seed/load_slice.py
   ```

   Expected report (snapshot `ol-2026-11-13`, derived from the slice
   manifest): `ref_authors` 5,070 · `ref_author_aliases` 21,597 ·
   `ref_works` 4,993 · `ref_editions` 20,000 · `isbn_index` 13,940 ·
   `works` projection 4,993, ending in `RESULT: PASS`. The loader is
   insert-if-absent: re-running it against the same snapshot inserts
   0 rows and reports the same totals, so an interrupted run is safe
   to repeat.
5. **Optionally** seed the synthetic demo listings (staging only).
   Two corrections to what this README used to say (PR #67 fix round
   item 6): the seed accounts are **data fixtures that CANNOT log
   in** — the generator stores the plaintext string `seed-password`
   as the password record, and production `verifyPassword` parses
   stored records as PHC strings, so plaintext parses as malformed
   and authentication always fails. They exist so listings have
   stores, not as credentials. And because the generator writes to
   whatever `DATABASE_URL` names, it now **refuses to run without an
   explicit staging confirmation**: pass `--staging` (or set
   `SEED_STAGING_CONFIRM=staging`).

   ```sh
   DATA_DIR=<same> DATABASE_URL=<same> \
       <data-dir>/venv/bin/python scripts/seed/generate_synthetic.py --staging
   # then link them with the shipped Path A code:
   npx esbuild scripts/seed/link_seed.ts --bundle --platform=node \
     --format=esm --outfile=scripts/seed/.link_seed.bundle.mjs
   DATABASE_URL=<same> node scripts/seed/.link_seed.bundle.mjs
   ```

   The generator picks its anchors from the loaded slice (the work
   with the most editions becomes the multi-store hub), so the exact
   titles differ from any fixture you have seen — its report prints
   every pick. Re-running it without `--reset` is a no-op.
   **Linker re-run behaviour** (fix round item 7): `link_seed.ts` is
   safe to re-run — an interrupted owner run can simply be repeated.
   Listings with a link are skipped, and listings that already have
   evidence for their ISBN (the demoted and ambiguous ones, which
   have no link row) are skipped too, so re-runs never duplicate
   rejected/proposed evidence rows; the linker prints how many it
   skipped. Listings whose previous attempt wrote nothing
   (no-candidate / no-ISBN) are retried harmlessly.

## What the loader guarantees

- **Counts equal the manifest exactly** — works 4,993, editions
  20,000, authors 5,070 — or the script exits non-zero. The
  `isbn_index` cut (13,940 rows) is slice-scoped per plan §4.2 step 3
  (the full 37M-row ISBN map stays off-database) and cross-checks
  exactly against PR 1's independent `isbn_map.parquet`.
- **Every reference row carries the snapshot id** (`ol-2026-11-13`,
  derived deterministically from the manifest's `generated_at`;
  override with `SNAPSHOT_ID`).
- **29 slice ISBNs fail checksum validation and are skipped** — the
  loader reports the count rather than hiding it; their editions
  still load, just without index rows. (Fix round: the count is now
  also asserted — `spot_joins.py` recomputes it from the slice and
  the gate fails if it is not exactly 29; likewise the alias total
  21,597 is asserted in `assertions.sql` §1 and the B-mask spot-join
  count is asserted to be exactly 12.)
- **Idempotent**: insert-if-absent on the schema's own unique keys.
  Clean-replace was rejected on purpose: after listings link,
  `listing_links`/`evidence` reference editions and works with
  NO ACTION deletes, so a replace would fail; snapshot rows are
  immutable reference data anyway.

## Path A, the prefill, and GetWork (Step 4, in the Worker)

- `AddBook` links each new listing after its P3-parity upsert:
  canonical ISBN-13 → `isbn_index` → edition → work, gated by the
  lying-ISBN agreement guard (title/author must agree with the
  edition the ISBN names; disagreement records rejected evidence and
  never auto-links; multiple agreeing candidates are proposed, never
  linked). A local-index miss falls back to **one** Open Library
  lookup (identified User-Agent, ≤3 req/s, per-isolate memoised) —
  Google Books is never an identity source.
- `LookupBookByISBN` (§4.6) now answers in the order **local index →
  Open Library → Google Books**, and returns `source` + `attribution`
  + `description_transient` / `cover_transient`. One honesty note:
  this branch's SPA has **no add-book form component**, so the
  §4.6 fix is enforced at the RPC layer — the response marks
  Google-sourced description/cover as transient (display with
  attribution, never submit/persist), which is the contract any form
  must honour; `AddBook` stays at P3 parity because it cannot know a
  field's provenance.
- `GetWork` is a **Worker-only RPC** (plan §12 decision 8: Go parity
  is frozen at P3). It reads the `works` projection + `listing_links`
  + ref tables; the frontend's minimal WorkPage (title click-through
  from the book grid) renders the work, its editions, and its offers
  across stores, with synthetic listings badged as demo data. The
  divergence is also recorded in `DEPLOY.md`.

## Gate results (local, fix-round run 2026-11-16 at `HEAD_TO_FILL`; originally run 2026-11-12, push-pass run 2026-11-15)

> **Dated correction (2026-11-16, fix round item 4):** the previous
> version of this section cited commit `efdec56` as the executed
> head. That hash was a local pre-push hash from the 2026-11-15 push
> pass and does not exist in the pushed history — the head that was
> actually pushed for PR #67 was `d136ded4` (tree-identical to the
> local `c1e6d45`). The record below cites the fix round's own
> executed head, following the same dated-correction pattern.

`scripts/seed/run_gate.sh` against scratch PostgreSQL 16.15 +
pgvector 0.8.0: **11 passed, 0 failed** — scaffolding + 9 migrations
(the F1 migration included), loader counts = manifest, loader re-run
inserted 0, generator + linker produced 6 links / 1 demotion / 1
no-ISBN-skip over the 8 archetype listings, `assertions.sql` 9/9
groups (now including the `ai_runs` jsonb-object checks and the F1
security-invoker probe), B-mask spot joins 12/12, the real `GetWork`
RPC returned the hub work merged across stores with the sold
listing's review attributed (edition attribution + synthetic flag
checked), and the new real-DB F3 step proved the compensating
`error` ai_run behaviour against Postgres itself. Repo gates
alongside: vitest VITEST_TO_FILL, typecheck clean, frontend
production build green (zero `localhost` strings in the output),
proto regeneration byte-identical.

## Staging smoke (2026-11-16, read-only — fix round item 13)

Executed against the deployed staging Worker
(`https://smart-bookstore.paulxu155.workers.dev`, deployment of
`d136ded4` per the Cloudflare bot on PR #67), public GETs and
read-only RPC POSTs only, no remote writes:

- `GET /` → **200** — the app shell loads.
- **Every Connect RPC POST returns HTTP 500** with the plain-text
  body "Failed to start container: There is no container application
  assigned to this Durable Object namespace" — verified on
  `GetAvailableBooks`, `GetBookDetails`, `GetWork`, and the public
  `LookupBookByISBN`. Those include pre-existing P1–P3 RPCs, so this
  is a staging provisioning state (the container Durable Object
  namespace has no container application assigned — an owner /
  dashboard matter), **not a PR 3 code regression**.

The RPC-level smoke the plan asks for (GetWork not-found path,
LookupBookByISBN public path) therefore **cannot be completed
against staging until the container assignment is resolved**; it is
recorded here as an executed smoke with a blocked surface, not
skipped silently. The same paths are proven locally: the seed gate's
`verify_workpage.ts` drives the real GetWork RPC against the seeded
DB, and the vitest router suites cover LookupBookByISBN's source
order and the GetWork not-found path.

Two rehearsal catches worth knowing about (both fixed in this PR's
own code, details in the build log): the evidence table's score
column is `total_score` and an evidence row names exactly one
candidate; and jsonb parameters through the Worker DB seam must be
passed as objects — postgres.js re-encodes pre-stringified JSON.
The same stringification pattern existed in PR 2's original
`ai/runs.ts` (`ai_runs.input`/`output` landed double-encoded
through the real driver); it was fixed in PR #63's review rounds
and this branch inherited the fix via rebase onto the merged PR 2
— the gate DB's `ai_runs` payloads are verified jsonb objects, and
no follow-up remains.
