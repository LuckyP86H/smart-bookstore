# Frontend

React + TypeScript + Vite client for the bookstore. See the [root README](../README.md) for the full stack and setup.

## Commands

```bash
npm install
npm run generate # regenerate src/gen from backend/proto (needs protoc)
npm run dev      # Vite dev server (default http://localhost:5173)
npm run build    # type check + production build
npm run lint     # ESLint
```

## Generated client

`src/gen/` is generated from `backend/proto/bookstore.proto` by `npm run generate` and is not committed. The Docker build and CI run the same script, so codegen is defined in exactly one place. It uses protobuf-es v2, which emits messages and service descriptors into a single `bookstore_pb.ts`.

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
