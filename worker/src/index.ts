// Edge entry point for the Cloudflare deployment.
//
//   browser ──▶ this Worker ──┬─▶ static assets (the React build)      [Workers Static Assets]
//                             ├─▶ /bookstore.v1.*  ConnectRPC services, served by the
//                             │    Worker itself via Hyperdrive        [Route B, P1]
//                             └─▶ /api/* ──▶ Go backend container (AI routes until P4)
//                                      │  http://AI_SERVICE_HOST  (intercepted below)
//                                      ▼
//                                 AI service container (FastAPI)       [never has a public URL]
//
// Postgres + pgvector lives in Supabase; the Worker reaches it through
// Hyperdrive and the containers connect to it directly.
// Responsibilities stay separate: Supabase = data, Cloudflare = hosting and routing.

import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { handleConnectRequest } from "./connect-app";
import { hyperdriveProof } from "./dev/hyperdrive-proof";
import type { Env } from "./env";

// Required export: it runs the outbound-interception handlers defined below.
export { ContainerProxy };
export type { Env };

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
        "DB_INIT_SCHEMA",
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

    // DEV-ONLY (Route B P0): connectivity proof through the Hyperdrive
    // binding. Must be removed or gated before production — see
    // worker/src/dev/hyperdrive-proof.ts.
    if (pathname === "/api/dev/hyperdrive-proof") {
      return hyperdriveProof(env);
    }

    // Route B P1: the ConnectRPC services are served by the Worker itself
    // (connect-app.ts) against Hyperdrive. /api/* still goes to the backend
    // container until P4 ports the AI routes.
    if (pathname.startsWith("/bookstore.v1.")) {
      return handleConnectRequest(request, env);
    }
    if (pathname.startsWith("/api/")) {
      return getContainer(env.BACKEND).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
