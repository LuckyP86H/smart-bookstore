// Edge entry point for the Cloudflare deployment.
//
//   browser ──▶ this Worker ──┬─▶ static assets (the React build)      [Workers Static Assets]
//                             └─▶ Go backend container (ConnectRPC + /api/ai/*)
//                                      │  http://AI_SERVICE_HOST  (intercepted below)
//                                      ▼
//                                 AI service container (FastAPI)       [never has a public URL]
//
// Postgres + pgvector lives in Supabase; both containers connect to it directly.
// Responsibilities stay separate: Supabase = data, Cloudflare = hosting and routing.

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

// Required export: it runs the outbound-interception handlers defined below.
export { ContainerProxy };

export interface Env {
  BACKEND: DurableObjectNamespace<BackendContainer>;
  AI_SERVICE: DurableObjectNamespace<AiServiceContainer>;
  ASSETS: Fetcher;

  // Plain settings (wrangler.jsonc "vars")
  DB_HOST: string;
  DB_PORT: string;
  DB_USER: string;
  DB_NAME: string;
  DB_SSLMODE: string;
  LLM_MODEL: string;
  LLM_API_BASE: string;

  // Secrets (Cloudflare dashboard → Settings → Variables and Secrets). Never commit these.
  DB_PASSWORD: string;
  OLLAMA_API_KEY: string;
  GOOGLE_BOOKS_API_KEY?: string;
}

// The Go backend calls the AI service at this address. It is not a real host:
// the backend container's outbound traffic to it is intercepted and handed to
// the AI container, so the (unauthenticated) AI service is reachable from the
// backend only. An IP is used so no DNS lookup is involved.
const AI_SERVICE_HOST = "10.255.0.2";

/** Copy the named variables out of env, skipping any that are unset. */
function pick(env: Env, keys: (keyof Env)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

export class BackendContainer extends Container<Env> {
  defaultPort = 8082;
  sleepAfter = "15m";
  enableInternet = true; // needs to reach Supabase

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...pick(env, [
        "DB_HOST",
        "DB_PORT",
        "DB_USER",
        "DB_NAME",
        "DB_SSLMODE",
        "DB_PASSWORD",
        "GOOGLE_BOOKS_API_KEY",
      ]),
      PORT: "8082",
      AI_SERVICE_URL: `http://${AI_SERVICE_HOST}`,
    };
  }

  // Requests the backend makes to AI_SERVICE_HOST run this handler instead of
  // leaving the container, and are forwarded to the AI service container.
  static outboundByHost = {
    [AI_SERVICE_HOST]: (request: Request, env: Env) =>
      getContainer(env.AI_SERVICE).fetch(request),
  };
}

export class AiServiceContainer extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "15m";
  enableInternet = true; // needs Supabase and Ollama Cloud

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...pick(env, [
        "DB_HOST",
        "DB_PORT",
        "DB_USER",
        "DB_NAME",
        "DB_SSLMODE",
        "DB_PASSWORD",
        "LLM_MODEL",
        "LLM_API_BASE",
        "OLLAMA_API_KEY",
      ]),
      PORT: "8000",
    };
  }

  // The AI service loads an embedding model on startup, which takes longer than
  // the default 20 s port-ready timeout, so wait explicitly before forwarding.
  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      ports: 8000,
      cancellationOptions: { portReadyTimeoutMS: 180_000 },
    });
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // wrangler.jsonc only runs this Worker first for these paths; everything
    // else is served straight from the static assets.
    if (pathname.startsWith("/bookstore.v1.") || pathname.startsWith("/api/")) {
      return getContainer(env.BACKEND).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
