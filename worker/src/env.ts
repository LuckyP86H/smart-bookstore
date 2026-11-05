// Worker bindings and settings (see wrangler.jsonc). Kept in one module so
// every part of the Worker agrees on the shape of the environment.

// The container classes are declared in index.ts; env.ts only needs them as
// types for the Durable Object namespaces below.
import type { AiServiceContainer, BackendContainer } from "./index";

export interface Env {
  BACKEND: DurableObjectNamespace<BackendContainer>;
  AI_SERVICE: DurableObjectNamespace<AiServiceContainer>;
  ASSETS: Fetcher;

  // Route B: connection-pooled access to Supabase Postgres (wrangler.jsonc).
  HYPERDRIVE: Hyperdrive;

  // Plain settings (wrangler.jsonc "vars")
  DB_HOST: string;
  DB_PORT: string;
  DB_USER: string;
  DB_NAME: string;
  DB_SSLMODE: string;
  DB_INIT_SCHEMA: string;
  LLM_MODEL: string;
  LLM_API_BASE: string;

  // Secrets (Cloudflare dashboard → Settings → Variables and Secrets). Never commit these.
  DB_PASSWORD: string;
  OLLAMA_API_KEY: string;
  GOOGLE_BOOKS_API_KEY?: string;
}