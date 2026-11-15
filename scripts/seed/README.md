# scripts/seed — P4 Step 3 seed load + Step 4 Path A gate

What lives here:

| File | What it does |
| --- | --- |
| `load_slice.py` | Loads the PR 1 Open Library slice into PR 2's reference schema: `ref_authors`, `ref_author_aliases`, `ref_works`, `ref_editions`, the slice-scoped `isbn_index`, and the `works` display projection. |
| `generate_synthetic.py` | Creates the synthetic demo stores/listings on top of the loaded slice (every row `is_synthetic = true`). |
| `link_seed.ts` | Runs the Worker's own Path A linker over the seed listings (they were inserted directly, bypassing `AddBook`). |
| `run_gate.sh` | The full local gate: fresh scratch DB → 8 migrations → loader ×2 → generator → linker → assertions → spot joins → the real `GetWork` RPC. |
| `assertions.sql` | SQL gate assertions (counts, link lineage, lying-ISBN demotion, archetypes). |
| `spot_joins.py` | Independent recomputation from PR 1's artifacts (B-mask spot joins, isbn_index total, synthetic ISBN resolution). |
| `verify_workpage.ts` | Drives the production `GetWork` RPC against the seeded DB and checks the merged shape. |
| `make_gifs.py` + `gifs/` | Terminal-replay GIFs rendered from the real gate logs (footer-labelled as replays, not live captures). |

Gate replays (rendered from the real run logs — not live captures):

- [01 — loader counts, run 1 + the inserted=0 re-run](gifs/01-loader-counts.gif)
- [02 — synthetic seed + Path A linking outcomes](gifs/02-seed-and-link.gif)
- [03 — assertions, spot joins, GetWork RPC, gate verdict](gifs/03-gate-verdicts.gif)
- [04 — the vitest suite](gifs/04-test-suite.gif)

## The owner's live seed procedure (Supabase)

This is plan §10 item 3: Pawlie built and gated everything locally;
the live load is yours, with your credentials, when you choose to run
it. **Nothing here has touched the live database.**

1. **Apply PR 2's five migrations first**, in the Supabase dashboard
   SQL editor, **one file at a time, in filename order**:
   `20261111130000_p4_reference_catalogue.sql`,
   `20261111130100_p4_listing_facets.sql`,
   `20261111130200_p4_identity_store.sql`,
   `20261111130300_p4_works_projection.sql`,
   `20261111130400_p4_ai_platform.sql`
   (the repo's `supabase/migrations/` directory; the three older files
   are already live). The dashboard route is deliberate — it is the
   credential-free path this project has used throughout; do not paste
   the database password anywhere else.
2. **Check the `review_aspects_queue` view's PostgREST exposure
   before seeding.** After applying the migrations, check the
   `review_aspects_queue` view's PostgREST exposure / grants on
   the live Supabase project (the migration creates the view in
   `public` with no grant/revoke statement of its own; confirm it
   is not readable via the public API keys beyond what the
   RLS-enabled underlying tables intend). If it is readable via
   PostgREST, a corrective step (e.g. recreating the view
   `WITH (security_invoker = true)` or revoking grants) must
   precede the seed load.
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
   0 rows and reports the same totals, so a interrupted run is safe
   to repeat.
5. **Optionally** seed the synthetic demo listings (staging flavour
   only — they are fixtures with a shared password, `seed-password`,
   and are disclosed as demo data everywhere they surface):

   ```sh
   DATA_DIR=<same> DATABASE_URL=<same> \
       <data-dir>/venv/bin/python scripts/seed/generate_synthetic.py
   # then link them with the shipped Path A code:
   npx esbuild scripts/seed/link_seed.ts --bundle --platform=node \
     --format=esm --outfile=scripts/seed/.link_seed.bundle.mjs
   DATABASE_URL=<same> node scripts/seed/.link_seed.bundle.mjs
   ```

   The generator picks its anchors from the loaded slice (the work
   with the most editions becomes the multi-store hub), so the exact
   titles differ from any fixture you have seen — its report prints
   every pick. Re-running it without `--reset` is a no-op.

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
  still load, just without index rows.
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

## Gate results (local, final run 2026-11-15 at `efdec56`; originally run 2026-11-12 with identical seed-gate numbers)

`scripts/seed/run_gate.sh` against scratch PostgreSQL 16.15 +
pgvector 0.8.0: **10 passed, 0 failed** — loader counts = manifest,
loader re-run inserted 0, generator + linker produced 6 links / 1
demotion / 1 no-ISBN-skip over the 8 archetype listings,
`assertions.sql` 8/8 groups, B-mask spot joins 12/12, and the real
`GetWork` RPC returned the hub work merged across stores with the
sold listing's review attributed. Repo gates alongside: vitest
191/191, typecheck clean, frontend production build green (zero
`localhost` strings in the output).

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
