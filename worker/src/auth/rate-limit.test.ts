import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { checkLoginRateLimit } from "./rate-limit";

function envWithLimiter(success: boolean): { env: Env; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  const env = { LOGIN_RATE_LIMITER: { limit } } as unknown as Env;
  return { env, limit };
}

function request(path: string): Request {
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.7" },
  });
}

describe("checkLoginRateLimit", () => {
  it("passes requests through when no binding is configured", async () => {
    const env = {} as Env;
    expect(
      await checkLoginRateLimit(
        request("/bookstore.v1.CustomerService/GetAvailableBooks"),
        env,
      ),
    ).toBeNull();
  });

  it("keys the limiter by client IP on login-bearing routes", async () => {
    const { env, limit } = envWithLimiter(true);
    const response = await checkLoginRateLimit(
      request("/bookstore.v1.MerchantService/GetMerchantBooks"),
      env,
    );
    expect(response).toBeNull();
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });

  it("answers 429 with Retry-After when the limiter denies", async () => {
    const { env } = envWithLimiter(false);
    const response = await checkLoginRateLimit(
      request("/api/ai/chat"),
      env,
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
  });

  it("does not consult the limiter for other paths", async () => {
    const { env, limit } = envWithLimiter(false);
    expect(await checkLoginRateLimit(request("/index.html"), env)).toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });
});
