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
plan by the design's gate. `PBKDF2_ITERATIONS` is provisionally set to
**10,000** (the design's minimum defensible count) in `wrangler.jsonc`
and in the code default, pending the owner's decision:

- **Workers Paid ($5/mo)** removes the question: the CPU limit becomes
  30 s, and `PBKDF2_ITERATIONS` should be raised to `100000`.
- **Staying on Free at 10,000** is the provisional posture: the pepper
  and the login rate limiter become the load-bearing controls (design
  §5.4 outcome (b)), and login-error rates need watching after deploy.

Two measured facts frame that decision. First, the feared failure mode
did **not** occur: zero `exceededCpu` outcomes and zero errors at every
count — even 100k logins with CPU p99 ≈ 86 ms were served normally, so
the documented 10 ms Free CPU limit was not observed to be enforced on
this account on 2026-11-05. Second, that leniency is not a guarantee:
if Cloudflare enforces the documented limit, logins costing more than
~10 ms CPU would start failing, which is why the count stays at the
floor until the owner decides. Do not raise it on Free without
re-running this benchmark. (The staging batches also confirmed
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
