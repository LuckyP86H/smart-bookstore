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

  // Route B P2: login rate limiting binding (wrangler.jsonc "ratelimits").
  // Optional so local tests without the binding still typecheck and run.
  LOGIN_RATE_LIMITER?: RateLimit;

  // Plain settings (wrangler.jsonc "vars")
  DB_HOST: string;
  DB_PORT: string;
  DB_USER: string;
  DB_NAME: string;
  DB_SSLMODE: string;
  DB_INIT_SCHEMA: string;
  LLM_MODEL: string;
  LLM_API_BASE: string;

  // Optional plain setting (wrangler.jsonc "vars"): PBKDF2 iteration target.
  // Resolved and clamped by auth/constants.ts; unset means the default there.
  PBKDF2_ITERATIONS?: string;

  // Secrets (Cloudflare dashboard → Settings → Variables and Secrets). Never commit these.
  DB_PASSWORD: string;
  OLLAMA_API_KEY: string;
  GOOGLE_BOOKS_API_KEY?: string;
  // Route B P2: password pepper (PBKDF2-DESIGN.md §6), current version.
  // Previous versions stay available as PASSWORD_PEPPER_V<n> during a
  // rotation window; auth/store-checker.ts picks both forms up.
  PASSWORD_PEPPER?: string;
}