# Frontend

React + TypeScript + Vite client for the bookstore. See the [root README](../README.md) for the full stack and setup.

## Commands

```bash
npm install
npm run dev      # Vite dev server (default http://localhost:5173)
npm run build    # type check + production build
npm run lint     # ESLint
```

## Generated client

`src/gen/` is generated from `backend/proto/bookstore.proto` and is not committed. The Docker build and CI run `protoc` themselves; to generate it locally, use the command in the root README's Development section.

## Layout

```
src/
├── api/client.ts     ConnectRPC transport and typed clients
├── components/       Catalog, cart, filters, theme toggle, AI chat
├── types/            Shared view models
└── App.tsx           Auth, catalog state, and layout
```

## Configuration

`VITE_API_URL` points at the Go backend and is read from `.env.development` / `.env.production`, defaulting to `http://localhost:8082`.
