# Deploying to Supabase + Cloudflare

| Piece | Where it runs | Why |
|-------|---------------|-----|
| Postgres + pgvector (catalog, accounts, sales, embeddings) | **Supabase** | Managed Postgres with pgvector; schema lives in `supabase/migrations/` |
| React frontend (static) | **Cloudflare Workers Static Assets** | Served from the edge, no server |
| Go backend (ConnectRPC + `/api/ai/*`) | **Cloudflare Container** | Keeps the Go code as is |
| Python AI service (embeddings + LLM calls) | **Cloudflare Container** (private) | Reachable only from the Go backend, never from the internet |
| LLM | **Ollama Cloud** | Chosen by `LLM_MODEL`; any LiteLLM provider works with a one-line change |

One Worker (`worker/src/index.ts`, configured by `wrangler.jsonc`) fronts everything: it answers `/bookstore.v1.*` and `/api/*` by forwarding to the Go container, and every other path is served from the static build. Because the site and API share one hostname, there is no CORS setup and no hard-coded API URL (`VITE_API_URL=same-origin` at build time).

## One-time setup

1. **Supabase connection.** In the Supabase dashboard open **Connect → Session pooler** and confirm the host and user match `DB_HOST` and `DB_USER` in `wrangler.jsonc` (user looks like `postgres.<project-ref>`). Use the pooler, not the direct host: the direct host is IPv6-only. Edit the two values in `wrangler.jsonc` if they differ.
2. **Database password.** Set or reset it under **Project Settings → Database**. Use a strong one. Do not put it in the repository.
3. **Cloudflare Worker `smart-bookstore` → Settings → Build:**
   - Root directory: `/`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy` (**`npx`**, not `npm`; `npm wrangler deploy` is not a command)
   - Version command: `npx wrangler versions upload`. This is the command for builds of non-production branches. It uploads a preview version of the Worker without making it live. It does **not** build or roll out the container images, so a feature branch will not get working containers from it.
   - Production branch (Settings → Build → Branch control): the branch you want live. To deploy from `feat/supabase-and-cloudflare`, either set it as the production branch temporarily or merge to `main`.

   **Why one Root directory, not one per service:** a Worker has exactly one build, and Root directory is a single path (semicolons are not supported). This repo is one Worker that owns all three parts, so `/` is right. The build command only builds the frontend; Wrangler builds the Go and AI images itself from `backend/Dockerfile` and `ai-service/Dockerfile` during `npx wrangler deploy`. Separate Workers (each with its own root directory) would only be needed if you wanted to deploy the services independently.
4. **Cloudflare Worker → Settings → Variables and Secrets.** Add these as type **Secret**:
   - `DB_PASSWORD`: the Supabase database password
   - `OLLAMA_API_KEY`: your Ollama API key
   - `GOOGLE_BOOKS_API_KEY` (optional): enables ISBN lookup quota
5. Push to the production branch. The first deploy builds both container images, so it takes a while, and the containers can need several more minutes after the Worker URL goes live.

Containers require the **Workers Paid** plan (the Cloudflare dashboard asks for the upgrade). Without it the first deploy cannot create the container applications.

**Do the setup above before the first deploy.** A build that runs with the placeholder settings fails immediately (for example, the default `*` deploy command dies with `LICENSE: not found`), and one without the secrets deploys but cannot reach the database. Watch the first deploy: the pieces that can only be proven live are Cloudflare's image builds, the TLS handshake to the Supabase pooler, the private Go-to-AI hop, and the AI model's load time against the 180 s port-ready timeout.

## Check it works

Replace the host with your Worker URL.

```bash
# Frontend (HTML)
curl -sI https://smart-bookstore.<subdomain>.workers.dev/ | head -1

# Backend + database: expect 200 (the first request wakes the container)
curl -s -X POST https://smart-bookstore.<subdomain>.workers.dev/bookstore.v1.CustomerService/GetAvailableBooks \
  -H "Content-Type: application/json" -u customer:password -d '{"page":1,"pageSize":10}'

# Wrong password: expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://smart-bookstore.<subdomain>.workers.dev/bookstore.v1.CustomerService/GetAvailableBooks \
  -H "Content-Type: application/json" -u customer:wrong -d '{}'

# Backend → AI service (private hop) → expect a health response
curl -s https://smart-bookstore.<subdomain>.workers.dev/api/ai/health
```

The seeded accounts (`customer`, `merchant1`, `merchant2`) are created on first backend start with bcrypt-hashed passwords. Change those default passwords before sharing the site.

## Loading book data

The database starts empty. After deploy, add books as a merchant in the UI, or run `scripts/seed-data.sh` and `scripts/generate-embeddings.sh` against your Worker URL (they target `localhost` by default; point them at the Worker URL first).

## If something fails

- **Worker logs:** Cloudflare dashboard → Worker → **Logs** (observability is enabled).
- **Database errors in the backend log:** re-check the pooler host and user, the password secret, and `DB_SSLMODE=require`.
- **`/api/ai/health` fails but the backend works:** the AI container is probably still starting (it loads the embedding model); retry after a minute.
- **Build fails downloading `protoc`:** `frontend`'s `generate` script fetches `protoc` with `curl` and `unzip`; the build image needs both.

## Changing the LLM provider

Edit `LLM_MODEL` in `wrangler.jsonc` (for example `gpt-4o-mini`) and add that provider's key as a secret (`OPENAI_API_KEY`). The AI container only receives the variables listed in `worker/src/index.ts`, so add the new key name there too.

## Who owns the schema

In Supabase the tables come from `supabase/migrations/`, so the Worker sets `DB_INIT_SCHEMA=false` and the Go backend does not run its own `CREATE TABLE` / index DDL. The local compose database has no migrations, so it keeps the default (`true`) and the backend creates the tables on startup. Seeded accounts are created either way.

## Upgrading an existing local database

Passwords are now stored as bcrypt hashes. A `stores` row created before this change holds a plaintext password, so that account's logins fail with a server error (the backend log says `not a valid bcrypt hash`). Reseed it: run `docker compose down -v` for a fresh database, or delete the old seeded rows from `stores` and restart so they are recreated hashed. The fresh Supabase database is unaffected.

## Why not Hyperdrive?

Cloudflare Hyperdrive pools Postgres connections for code running in a Worker, through a binding. Here the database clients are the Go and AI containers, which connect straight to Supabase's session pooler, and that pooler already does the pooling. Hyperdrive was considered and not needed.

## Local development is unchanged

`docker compose up` still runs everything locally against a local Postgres. Compose sets `DB_SSLMODE=disable` for that database.

---

## Route B P2 — password hashing in the Worker (draft, 2026-11-05)

> Status: implemented on `feat/worker-native-route-b` (P2). The Worker now
> verifies store passwords itself (Connect interceptor → PBKDF2 checker);
> the Go container's bcrypt check is no longer on the cloud login path.
> Design: `PBKDF2-DESIGN.md` in the Route B working notes.

### What the owner must set before the first Route B deploy

- **Secret `PASSWORD_PEPPER`** on the Worker (Settings → Variables and
  Secrets → Secret). Invent a long random value; it is the pepper for
  password records (HMAC pre-hash, record version `p=1`). It is NOT the
  database password and must never be committed. If it is ever rotated,
  add the new value as `PASSWORD_PEPPER` and keep the old one as
  `PASSWORD_PEPPER_V1` so existing records still verify; new records are
  written with the new version and old ones rehash lazily on login.
- **`PBKDF2_ITERATIONS`** is set in `wrangler.jsonc` vars (see the
  benchmark below for the value and why). It can be lowered in an
  emergency without a code change; stored records keep their own count
  and rehash upward on the next successful login.

### Seed the cloud accounts (owner-run, one time)

The cloud database starts with no `stores` rows. Create the three seed
accounts with PBKDF2 records (the Worker cannot use the Go backend's
bcrypt records — bcrypt rows deliberately fail closed in the Worker):

```bash
DATABASE_URL='postgres://postgres.<project-ref>:<DB-PASSWORD>@aws-1-ca-central-1.pooler.supabase.com:5432/postgres' \
PASSWORD_PEPPER='<the same value as the Worker secret>' \
npm run seed:cloud
```

The script is idempotent: re-running only rewrites the three seed rows'
password records (`ON CONFLICT (username) DO UPDATE`). It refuses to run
if either variable is missing. Usernames/passwords match the local seed
accounts (`merchant1`/`password1`, `merchant2`/`password2`,
`customer`/`password`) — change them after first login, as before.

**Per-database by design (plan §4.5):** the local docker-compose
database keeps bcrypt records (created by the Go backend) and the cloud
database holds PBKDF2 records (created by the seed script). Same
usernames and passwords, different record formats — neither side is
"wrong"; do not try to sync the record formats between databases.

### Login rate limiting

The Workers **rate-limiting binding** is GA and available on the Free
plan (verified live on this account, 2026-11-05 — see the benchmark
notes). `wrangler.jsonc` declares `LOGIN_RATE_LIMITER` (60 attempts per
minute per client IP, namespace 1001); it is provisioned automatically
at deploy — no dashboard step and no WAF rule needed. The Worker applies
it to `/bookstore.v1.*` and `/api/ai/chat`; over-limit requests get
HTTP 429 with `Retry-After: 60`. No code path fails if the binding is
absent (local dev): the check is a no-op without it.

### PBKDF2 benchmark (design §5) — measured 2026-11-05

Method: staging versions of the real Worker code on the throwaway
script `smart-bookstore-hyperdrive-proof` (same account), login batches
of ≥100 unknown-user requests per iteration count (the dummy-record
path — the most expensive login shape), metered CPU from the Workers
GraphQL analytics API (`workersInvocationsAdaptive`, cpuTime quantiles
in microseconds), each window read at least twice after ingestion
settled. Zero `exceededCpu` outcomes at every count. Client-observed
wall times from the test VM are network-dominated (its egress rotates
IP/colo per request) and are not the gate metric.

| Iterations | Login CPU p50 | Login CPU p95 | Login CPU p99 | Pure derivation | Verdict vs p95 ≤ 7 ms |
|---|---|---|---|---|---|
| 100,000 | ≈25–29 ms | ≈50–53 ms | ≈77–86 ms | ≈25 ms (client-wall estimate) | fail |
| 50,000 | 18.9 ms | 38.7 ms | 44.5 ms | 12.7 ms (client wall) | fail |
| 25,000 | 12.4 ms | 29.1 ms | 34.8 ms | 6.2 ms (client wall) | fail |
| 10,000 | 7.17 ms | 19.9 ms | 30.3 ms | ≈2.0 ms (metered) | fail |

Decomposition controls (same staging bundle): a trivial no-auth
endpoint costs p50 1.40 ms / p95 2.82 ms CPU, so the fixed Worker
overhead is small; the login path's cost is dominated by the PBKDF2
derivation itself plus Connect routing. Full numbers, windows, and the
measurement caveats are in the P2 report in the Route B working notes.

**Outcome: design §5.4's third outcome — stop-and-escalate.** No tested
count meets the p95 ≤ 7 ms rule, so no count is certified for the Free
plan by the design's gate. `PBKDF2_ITERATIONS` is set to **10,000**
(the design's minimum defensible count) in `wrangler.jsonc` and in the
code default.

**Owner decision, 2026-11-05: 10,000 is final on Free (option B —
stay on Workers Free).** The owner declined both alternatives the
benchmark framed: Workers Paid ($5/mo), and running 100,000 on Free
while relying on the unenforced CPU limit documented below. A
same-day re-benchmark (same staging method, same account) closed the
remaining question — whether a *lower* count could meet the gate:

| Iterations | Login CPU p50 | Login CPU p95 | Login CPU p99 | Verdict vs p95 ≤ 7 ms |
|---|---|---|---|---|
| 1,000 | 4.78 ms | 20.6 ms | 26.0 ms | fail |
| 5,000 | 4.55 ms | 21.7 ms | 33.5 ms | fail |

The p95 is flat across the low end (1k / 5k / 10k ≈ 20.6 / 21.7 /
19.9 ms): the login path's tail cost is fixed Worker/Connect
overhead, not the derivation (pure derivation scales from ≈2.0 ms at
10,000 to ≈1.0 ms at 5,000 and ≈0.2 ms at 1,000). Lowering the count
therefore buys ~0 ms at p95 and only weakens the hash — so 10,000
stands. The ≤ 7 ms gate remains unmet on Free; that is an accepted,
documented trade-off, with the pepper and the 60/min/IP login rate
limiter as the compensating controls (design §5.4 outcome (b)), and
login-error rates need watching after deploy. If the project ever
moves to Workers Paid, the question disappears: the CPU limit becomes
30 s, and `PBKDF2_ITERATIONS` flips to `100000` with no code change.

Two measured facts frame that decision. First, the feared failure mode
did **not** occur: zero `exceededCpu` outcomes and zero errors at every
count — even 100k logins with CPU p99 ≈ 86 ms were served normally, so
the documented 10 ms Free CPU limit was not observed to be enforced on
this account on 2026-11-05. Second, that leniency is not a guarantee:
if Cloudflare enforces the documented limit, logins costing more than
~10 ms CPU would start failing, which is why the count stays at the
floor. Do not raise it on Free without re-running this benchmark. (The staging batches also confirmed
wrong-password and unknown-user responses are indistinguishable —
identical 401 status and body; the §10.5 statistical wall-time check
could not be resolved from the test VM because its egress rotates
IP/colo per request, so the one-derivation-per-attempt property is
carried by the unit tests instead.)

Also verified live during the benchmark: the 100,001-iteration cap —
`deriveBits` on workerd throws `NotSupportedError` ("iteration counts
above 100000 are not supported"), and the auth code refuses such records
before any derivation (`auth_record_iterations_above_cap`); and the
full login flow (correct/wrong/unknown + lazy rehash of a
1,000-iteration record up to the target) against a fixture checker on
the staging deploy. The owner-seeded live login remains a post-seed
check (run the seed script, then the "Check it works" curls above).

## Route B P3 — write endpoints + purchase/checkout parity (2026-11-05)

> Status: implemented on `feat/worker-native-route-b` (P3). All six write
> RPCs are now served by the Worker; nothing under `/bookstore.v1.*`
> answers Unimplemented any more. Behaviour mirrors the Go backend
> (`backend/db/database.go` + the two service files) statement for
> statement, including its quirks — the Go stack stays the local runtime,
> so anything the Worker "improved" silently would be a parity break.

### What was implemented, per RPC

| RPC | Parity notes |
|---|---|
| `AddBook` | Upsert on `(store_id, isbn)`: re-adding an ISBN updates the row in place (id, `total_sold`, `average_rating`, `created_at` preserved). `store_name` filled by the same follow-up username lookup Go runs, its error ignored exactly as in Go. |
| `RemoveBook` | Refuses books with any sales history (`cannot delete book with sales history`); ownership is a predicate in the DELETE itself, so a foreign or missing id both surface `book not found or unauthorized`. (TS reads the deleted ids via `RETURNING id` where Go reads `RowsAffected` — same count signal.) |
| `UpdateStock` | Signed delta in one guarded UPDATE scoped to the caller's store; missing/foreign book → `book not found or unauthorized`. |
| `PurchaseBook` | Real transaction (below): lock row `FOR UPDATE` → stock check → decrement + `total_sold` → sale insert. Quantity ≤ 0 normalises to 1 in the handler, as in Go. Errors: `book not found`, `insufficient stock: only N available`. |
| `CheckoutCart` | The whole cart in ONE transaction, items in request order; any failure rolls back every item — partial checkouts never happen. Empty cart → `invalid_argument` "cart is empty" before any SQL. Errors name the item: `book <id> not found`, `insufficient stock for book '<title>': only N available`. |
| `AddReview` | Rating validated (1–5) before any SQL (`invalid_argument`). Then the verified-purchase gate: no sale → `you can only review books you have purchased`. The insert is an **upsert** on `(book_id, customer_id)` — a second review updates the first (rating, text, `created_at`), it does not error. The book's `average_rating` refresh afterwards is fire-and-forget, its error discarded, exactly as in Go. No embedding is written on any write path (embeddings stay batch-only until P4, plan §2.3). |

Error mapping, all six: handler-level validation keeps its codes
(`invalid_argument`, plus the interceptor's `unauthenticated` /
`permission_denied`); every database-layer failure surfaces as
`internal` carrying the Go error message verbatim where Go constructs
the message. Where Go instead propagates a raw driver error (e.g. a
constraint failure inside `CreateBook`), the code still matches
(`internal`) but the message text is the postgres.js driver's, not
lib/pq's — driver text is not part of the contract the frontend uses.

### Transactions

`PurchaseBook` / `CheckoutCart` run in real postgres.js transactions
(`sql.begin`) over Hyperdrive — the shape P0 proved through the session
pooler, and the same shape as Go's `tx` blocks, `SELECT … FOR UPDATE`
included, so the oversell guard is the row lock itself. If a serving
context ever fails to wire the transaction runner, the purchase RPCs
fail loudly with `internal` ("database transactions are not available
in this serving context") instead of running non-atomically.

### Verification (2026-11-05)

- **Unit/integration (vitest, 123 tests, all green):** 23 new tests in
  `worker/src/writes.test.ts` drive the real interceptor + services +
  query layer against a stateful in-memory fake whose transactions are
  serialised snapshot/rollback blocks: happy paths for all six RPCs,
  Go's validation order (rating and empty-cart checks fire before any
  SQL), role denials, every error message above, checkout rollback
  (zero sales, stock untouched), the review upsert + average refresh,
  and 10 parallel purchases of a stock-1 book yielding exactly 1 sale
  and 9 clean `insufficient stock: only 0 available` failures.
  Typecheck, root build (both protobuf gens regenerate byte-identical)
  and frontend lint all exit 0; the iteration-literal guard is clean.
- **Staging smoke (throwaway `smart-bookstore-hyperdrive-proof`):** the
  real Worker code over the real Hyperdrive connection, with the
  fixture test-double checker (the cloud `stores` table is still
  unseeded, so the production checker has nothing to verify against).
  The parity harness's 14 non-mutating write cases — denials,
  validation, not-found, including the purchase/checkout paths opening
  real transactions that roll back on the missing book — plus 3 read
  cases: **all pass**. The proof endpoint read `books_count: 0` before
  and after: zero writes reached the remote database. The throwaway
  was restored to the P0 proof bundle afterwards (HTTP 200,
  `select1: 1`).
- **Not live-verified, deliberately:** every mutating happy path
  (create/purchase/checkout/review against real rows) — rehearsing
  writes on the live catalog is out of bounds, and the catalog is
  empty and unseeded besides. Those paths are covered by the unit
  suite above and by the harness's `writes-mutating/` case sequence,
  which runs against scratch databases only.

### Owner follow-ups

1. After seeding the cloud accounts (P2 section above) and loading a
   catalog, run the plan §6 smoke list items 6–8 (add → purchase →
   oversell, checkout-with-impossible-item) against the preview.
2. On a machine with Docker: load the same seed fixture into the
   compose Postgres and a scratch Supabase-side database, then run the
   parity harness in two-target diff mode with no `--only` filter —
   that is the run that exercises `writes-mutating/` against both
   implementations, including the P3 gate's real-Postgres concurrency
   check (the unit suite models it; only a real database proves it).
