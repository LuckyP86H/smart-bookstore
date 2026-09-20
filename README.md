# 📚 Smart Bookstore

A fullstack bookstore with an AI assistant: a **Go** backend serving type-safe **ConnectRPC** APIs, a **React** frontend, a **Python** AI service for chat and semantic search, and **PostgreSQL + pgvector** for storage.

The AI assistant answers natural-language questions ("recommend books about entrepreneurship") by combining vector similarity search over the catalog with an LLM — and the LLM provider is swappable by configuration alone.

---

## 🏗️ Architecture

```
   React Frontend
        │
        │  ConnectRPC (catalog, cart, reviews)
        │  REST        (AI chat)
        ▼
   Go Backend ──────────────────▶ PostgreSQL + pgvector
        │                              ▲
        │  REST                        │  vector + SQL queries
        ▼                              │
   Python AI Service ──────────────────┘
        │
        │  LiteLLM
        ▼
   LLM provider (local Ollama, or a hosted API)
```

The Go backend owns all business logic and is the only service the browser talks to. The AI service is internal: it generates embeddings, runs similarity search, and calls the LLM.

### Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React, TypeScript, Vite, Tailwind, ConnectRPC client |
| **Backend** | Go, ConnectRPC, Protocol Buffers |
| **AI Service** | Python, FastAPI, LiteLLM, sentence-transformers |
| **Database** | PostgreSQL with the pgvector extension |
| **Infrastructure** | Docker Compose, GitHub Actions |

---

## 🚀 Quick Start

**Prerequisites**: Docker and Docker Compose. For local (free) AI, also [Ollama](https://ollama.com) — otherwise set a hosted provider key, see [Switching LLM providers](#-switching-llm-providers).

```bash
# One-time: pull a local model
ollama serve &
ollama pull llama3.2

# Start everything, seed books, and generate embeddings
./scripts/setup-complete.sh
```

Then open <http://localhost:3000>, sign in, and click the assistant button in the bottom-right corner.

To start the stack without seeding, use `docker compose up -d`. The seeding and embedding steps are also available on their own as `./scripts/seed-data.sh` and `./scripts/generate-embeddings.sh`.

### Test accounts

The database seeds these on first start:

| Username | Password | Role |
|----------|----------|------|
| `customer` | `password` | Customer — browse, cart, purchase, review |
| `merchant1` | `password1` | Merchant — inventory and sales |
| `merchant2` | `password2` | Merchant — second account for testing |

---

## 🤖 AI Features

| Feature | How it works |
|---------|--------------|
| **Chat assistant** | Detects book-related questions, retrieves relevant titles, and asks the LLM to respond with them in context |
| **Semantic search** | Ranks books by embedding similarity, so "books about overcoming failure" matches on meaning rather than keywords |
| **Embeddings** | `sentence-transformers` produces 384-dimension vectors stored in a pgvector column |

A chat request flows: frontend → Go backend (`/api/ai/chat`, authenticated) → AI service → embedding + pgvector search, then LiteLLM → provider. The reply and the matched books come back together, and clicking a recommendation jumps to that book in the catalog.

### 🔌 Switching LLM providers

The AI service talks to every provider through [LiteLLM](https://docs.litellm.ai/), so the backend is chosen by configuration — no code changes. Set `LLM_MODEL` and the matching key in `ai-service/.env` (gitignored; copy `ai-service/.env.example` to start):

| Provider | `LLM_MODEL` | Credential |
|----------|-------------|------------|
| Ollama (local, default) | `ollama/llama3.2` | none; optional `LLM_API_BASE` |
| OpenAI | `gpt-4o-mini` | `OPENAI_API_KEY` |
| Anthropic | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| DeepSeek | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` |
| Gemini | `gemini/gemini-2.0-flash` | `GEMINI_API_KEY` |

Any other LiteLLM-supported model string works the same way. Never commit real keys — `.env` is gitignored and Compose loads it automatically.

---

## 📖 Why ConnectRPC?

Browsers can't speak native gRPC — it needs HTTP/2 binary framing that `fetch()` can't produce, which normally forces a translating proxy like Envoy in front of the server.

ConnectRPC serves the same Protocol Buffer contract over ordinary HTTP, so the browser calls the backend directly with no proxy, while keeping generated types on both ends. One `.proto` file is the single source of truth: `protoc` generates Go structs and handlers for the backend and TypeScript types and clients for the frontend, so a schema change that breaks the frontend fails at compile time rather than in production.

---

## 🗂️ Project Structure

```
backend/                 Go + ConnectRPC
├── proto/               Protocol Buffer schema (source of truth)
├── gen/                 Generated Go code (gitignored)
├── services/            Merchant and customer RPC implementations
├── handlers/            REST handlers proxying to the AI service
├── interceptors/        Authentication
├── db/                  PostgreSQL access and schema setup
└── external/            Google Books API client

ai-service/              Python + FastAPI
├── app/config/          Settings, provider resolution
├── app/services/        Chat, embeddings, vector search
├── app/models/          Request/response schemas
└── tests/               Unit tests (heavy deps stubbed)

frontend/                React + TypeScript
└── src/
    ├── gen/             Generated TypeScript client (gitignored)
    ├── api/             ConnectRPC client setup
    └── components/      Catalog, cart, filters, AI chat

scripts/                 Setup, seeding, embedding generation
.github/workflows/       CI and deployment pipelines
docker-compose.yml       Service orchestration
```

Generated code is not committed — Docker builds and CI run `protoc` themselves.

---

## 🛠️ Development

The containers are the quickest path, but each service runs standalone.

**Backend**
```bash
cd backend
protoc --proto_path=proto \
  --go_out=gen --go_opt=paths=source_relative \
  --connect-go_out=gen --connect-go_opt=paths=source_relative \
  proto/bookstore.proto
go run server.go
```

**Frontend**
```bash
cd frontend
npm install
npm run generate   # regenerate the TypeScript client from the .proto
npm run dev
```

**AI service**
```bash
cd ai-service
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Tests

```bash
cd backend    && go test ./...                      # Go
cd ai-service && pip install -r requirements-dev.txt && pytest
cd frontend   && npm run lint && npm run build      # lint + type check
```

The Python tests stub the ML, LLM, and database dependencies, so they run in under a second without a model download or a live database. CI runs all three suites, builds every image, and scans dependencies with Trivy.

---

## 📚 API Reference

**CustomerService** (ConnectRPC, authenticated): `GetAvailableBooks`, `GetBookDetails`, `PurchaseBook`, `CheckoutCart`, `AddReview`, `GetBookReviews`, `GetPurchaseHistory`

**MerchantService** (ConnectRPC, authenticated): `AddBook`, `RemoveBook`, `UpdateStock`, `GetMerchantBooks`, `GetSoldBooks`, `GetLowStockBooks`, `LookupBookByISBN`

**AI endpoints** (REST, on the Go backend):

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/ai/chat` | Yes | Chat with the assistant |
| `POST /api/ai/search/semantic` | No | Semantic catalog search |
| `GET /api/ai/health` | No | AI service health |

ConnectRPC methods are plain HTTP, so they work from `curl`:

```bash
curl -X POST http://localhost:8082/bookstore.v1.CustomerService/GetAvailableBooks \
  -H "Content-Type: application/json" \
  -u customer:password \
  -d '{"page": 1, "pageSize": 10}'
```

---

## 🔐 Security Notes

The stack runs as non-root containers, authenticates every RPC through an interceptor, keeps provider keys out of the repository, returns generic error messages to clients while logging details server-side, and binds the internal AI service to loopback so only the backend can reach it.

This is a demo, not a hardened deployment. Before exposing it publicly, replace Basic Auth with tokens and hashed passwords, enable TLS, restrict CORS to known origins, and move credentials into a secrets manager.

---

## 🗃️ Database Schema

`stores` holds both merchants and customers (`is_customer` distinguishes them). `books` carries catalog data plus an `embedding vector(384)` column for similarity search. `sales` records each purchase, and `reviews` holds one rating per customer per book.

Purchases run inside a transaction using `SELECT ... FOR UPDATE` so two customers buying the last copy can't both succeed. The schema is created automatically on backend startup — see `backend/db/database.go`.

---

## 🐛 Troubleshooting

**Port already in use** — change the host-side port mappings in `docker-compose.yml`.

**AI replies but recommends nothing** — embeddings are missing; run `./scripts/generate-embeddings.sh`.

**Assistant returns an error** — check the provider config with `docker compose logs ai-service`, and confirm Ollama is running (`ollama serve`) if you're using the local default.

**Frontend can't reach the backend** — verify it's up with `curl http://localhost:8082/api/ai/health`, check `VITE_API_URL` in `frontend/.env.*`, then rebuild with `docker compose build frontend`.

**General checks** — `docker compose ps` for service health, `docker compose logs <service>` for details.

---

## 📈 Possible Extensions

- Streaming chat responses, so replies render token by token
- Conversation memory persisted across sessions
- Hybrid search blending vector similarity with keyword matching
- Server streaming for live stock updates
- Redis caching and Prometheus metrics

---

## 📝 License

MIT — see [LICENSE](LICENSE).
