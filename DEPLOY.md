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
