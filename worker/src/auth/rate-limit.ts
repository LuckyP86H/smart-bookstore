// Login rate limiting via the Workers rate-limiting binding
// (PBKDF2-DESIGN.md §2/§5: with the iteration count capped below OWASP,
// this is a load-bearing compensating control alongside the pepper).
//
// The binding is Free-plan available and GA; availability on this account
// was verified live at P2 implementation time by deploying the binding to
// a staging Worker and observing throttling (see DEPLOY.md). Counters are
// per Cloudflare location and eventually consistent — this is an abuse
// brake against credential stuffing, not an exact lockout counter.
//
// Applied to the login-bearing routes: every Connect RPC carries Basic
// auth (there is no separate login call), plus /api/ai/chat. The check
// runs before any credential work, so a throttled request also costs no
// PBKDF2 time. Keyed by client IP; the limit itself (60 per 60 s) lives
// in the binding configuration (wrangler.jsonc "ratelimits").

import type { Env } from "../env";

function isLoginBearingPath(pathname: string): boolean {
  return pathname.startsWith("/bookstore.v1.") || pathname === "/api/ai/chat";
}

/**
 * Returns a 429 response when the caller is over the limit, or null to
 * let the request through. A missing binding (local dev, tests) disables
 * the check rather than failing requests.
 */
export async function checkLoginRateLimit(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const limiter = env.LOGIN_RATE_LIMITER;
  if (limiter === undefined) {
    return null;
  }
  const { pathname } = new URL(request.url);
  if (!isLoginBearingPath(pathname)) {
    return null;
  }
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key });
  if (success) {
    return null;
  }
  return new Response("too many requests", {
    status: 429,
    headers: { "Retry-After": "60" },
  });
}
