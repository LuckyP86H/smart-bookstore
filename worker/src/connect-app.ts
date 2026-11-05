// ConnectRPC serving for the Worker: builds the Connect-ES router for both
// bookstore services and adapts between the Worker's fetch API and the
// Connect universal handlers. index.ts routes /bookstore.v1.* here.
//
// A fresh router (and a fresh Hyperdrive client) is built per request: the
// service implementations close over the request's query runner, and
// Hyperdrive's documented pattern is one client per request.

import {
  createConnectRouter,
  createContextValues,
} from "@connectrpc/connect";
import type {
  UniversalServerRequest,
  UniversalServerResponse,
} from "@connectrpc/connect/protocol";

import {
  createAuthInterceptor,
  type CredentialChecker,
} from "./auth/basic";
import {
  createStoreCredentialChecker,
  passwordPolicyFromEnv,
} from "./auth/store-checker";
import { createDb, type QueryRunner } from "./db/client";
import type { Env } from "./env";
import { CustomerService, MerchantService } from "./gen/bookstore_pb";
import { createCustomerService } from "./services/customer";
import { createMerchantService } from "./services/merchant";

export interface ServeConnectOptions {
  /**
   * Credential checker to authenticate with. Defaults to the production
   * PBKDF2 checker (auth/store-checker.ts) over the given query runner;
   * tests inject the fixture double or a fixture-backed real checker.
   */
  checker?: CredentialChecker;
  /** ctx.waitUntil, forwarded to the default checker for lazy rehash. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Serves one Connect request against an explicit query runner (the seam
 * the unit tests use; handleConnectRequest supplies the real one).
 */
export async function serveConnectRequest(
  request: Request,
  env: Env,
  run: QueryRunner,
  options: ServeConnectOptions = {},
): Promise<Response> {
  const checker =
    options.checker ??
    createStoreCredentialChecker({
      run,
      policy: passwordPolicyFromEnv(env),
      waitUntil: options.waitUntil,
    });
  const router = createConnectRouter({
    interceptors: [createAuthInterceptor(checker)],
  });
  router.service(
    MerchantService,
    createMerchantService(run, env.GOOGLE_BOOKS_API_KEY),
  );
  router.service(CustomerService, createCustomerService(run));

  const { pathname } = new URL(request.url);
  const handler = router.handlers.find((h) => h.requestPath === pathname);
  if (handler === undefined) {
    return new Response("not found", { status: 404 });
  }

  const universalResponse = await handler({
    httpVersion: "1.1",
    method: request.method,
    url: request.url,
    header: request.headers,
    body: requestBodyBytes(request),
    signal: request.signal,
    contextValues: createContextValues(),
  } satisfies UniversalServerRequest);
  return toFetchResponse(universalResponse);
}

/** Worker entry point: one Hyperdrive-backed client per request. */
export async function handleConnectRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const db = createDb(env);
  try {
    return await serveConnectRequest(request, env, db.run, {
      waitUntil:
        ctx !== undefined ? (promise) => ctx.waitUntil(promise) : undefined,
    });
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function* requestBodyBytes(
  request: Request,
): AsyncIterable<Uint8Array> {
  if (request.body === null) return;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Buffers the universal response into a fetch Response. Unary payloads are
 * small JSON documents, and buffering lets the caller close the database
 * client as soon as this returns.
 */
async function toFetchResponse(
  universal: UniversalServerResponse,
): Promise<Response> {
  const headers = new Headers(universal.header);
  if (universal.trailer !== undefined) {
    for (const [name, value] of universal.trailer) {
      headers.append(name, value);
    }
  }
  if (universal.body === undefined) {
    return new Response(null, { status: universal.status, headers });
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of universal.body) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: universal.status, headers });
}
