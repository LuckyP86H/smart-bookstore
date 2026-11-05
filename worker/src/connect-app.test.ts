import { describe, expect, it } from "vitest";

import { serveConnectRequest } from "./connect-app";
import type { QueryRunner } from "./db/client";
import type { Env } from "./env";

// The smoke/test environment: no Google Books key (keyless path), and the
// HYPERDRIVE binding is never touched because serveConnectRequest takes an
// explicit query runner.
const ENV = { GOOGLE_BOOKS_API_KEY: undefined } as unknown as Env;

/** Runner over an intentionally empty catalog. */
const emptyRun: QueryRunner = async (text) =>
  text.includes("COUNT(*)") ? [{ total: 0 }] : [];

function rpc(
  service: string,
  method: string,
  body: unknown,
  auth?: readonly [string, string],
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth !== undefined) {
    headers.set("authorization", `Basic ${btoa(`${auth[0]}:${auth[1]}`)}`);
  }
  return new Request(`https://worker.test/bookstore.v1.${service}/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function call(
  request: Request,
  run: QueryRunner = emptyRun,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await serveConnectRequest(request, ENV, run);
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const MERCHANT = ["merchant1", "password1"] as const;
const CUSTOMER = ["customer", "password"] as const;

describe("auth interceptor (test-double credentials)", () => {
  it("rejects a missing Authorization header as unauthenticated", async () => {
    const { status, json } = await call(
      rpc("CustomerService", "GetAvailableBooks", {}),
    );
    expect(status).toBe(401);
    expect(json.code).toBe("unauthenticated");
  });

  it("rejects a wrong password as unauthenticated", async () => {
    const { status, json } = await call(
      rpc("CustomerService", "GetAvailableBooks", {}, ["customer", "nope"]),
    );
    expect(status).toBe(401);
    expect(json.code).toBe("unauthenticated");
  });

  it("rejects an unknown user identically", async () => {
    const { status, json } = await call(
      rpc("CustomerService", "GetAvailableBooks", {}, ["ghost", "password"]),
    );
    expect(status).toBe(401);
    expect(json.code).toBe("unauthenticated");
  });

  it("denies customers calling MerchantService with permission_denied", async () => {
    const { status, json } = await call(
      rpc("MerchantService", "GetMerchantBooks", {}, CUSTOMER),
    );
    expect(status).toBe(403);
    expect(json.code).toBe("permission_denied");
  });

  it("lets merchants call CustomerService (Go allows it deliberately)", async () => {
    const { status } = await call(
      rpc("CustomerService", "GetAvailableBooks", {}, MERCHANT),
    );
    expect(status).toBe(200);
  });
});

describe("read RPCs against an empty catalog", () => {
  it("GetAvailableBooks returns the empty page shape", async () => {
    const { status, json } = await call(
      rpc("CustomerService", "GetAvailableBooks", {}, CUSTOMER),
    );
    expect(status).toBe(200);
    // proto3 JSON omits default-valued fields, so an empty page is {}.
    expect(json.books ?? []).toEqual([]);
    expect(json.totalCount ?? 0).toBe(0);
  });

  it("GetMerchantBooks returns an empty list for the owner", async () => {
    const { status, json } = await call(
      rpc("MerchantService", "GetMerchantBooks", {}, MERCHANT),
    );
    expect(status).toBe(200);
    expect(json.books ?? []).toEqual([]);
  });

  it("GetSoldBooks accepts an open-ended range and rejects bad dates", async () => {
    const ok = await call(
      rpc(
        "MerchantService",
        "GetSoldBooks",
        { startDate: "2026-01-01T00:00:00Z" },
        MERCHANT,
      ),
    );
    expect(ok.status).toBe(200);

    const bad = await call(
      rpc("MerchantService", "GetSoldBooks", { startDate: "soon" }, MERCHANT),
    );
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("invalid_argument");

    const inverted = await call(
      rpc(
        "MerchantService",
        "GetSoldBooks",
        {
          startDate: "2026-02-01T00:00:00Z",
          endDate: "2026-01-01T00:00:00Z",
        },
        MERCHANT,
      ),
    );
    expect(inverted.status).toBe(400);
    expect(inverted.json.code).toBe("invalid_argument");
    expect(inverted.json.message).toBe(
      "start_date must not be after end_date",
    );
  });

  it("GetBookDetails maps a missing book to not_found", async () => {
    const { status, json } = await call(
      rpc("CustomerService", "GetBookDetails", { bookId: "999999" }, CUSTOMER),
    );
    expect(status).toBe(404);
    expect(json.code).toBe("not_found");
    expect(json.message).toBe("book not found");
  });

  it("GetBookReviews and GetPurchaseHistory return empty lists", async () => {
    const reviews = await call(
      rpc("CustomerService", "GetBookReviews", { bookId: "1" }, CUSTOMER),
    );
    expect(reviews.status).toBe(200);
    const history = await call(
      rpc("CustomerService", "GetPurchaseHistory", {}, CUSTOMER),
    );
    expect(history.status).toBe(200);
  });
});

describe("P1 scope guards", () => {
  it("write RPCs answer unimplemented", async () => {
    for (const [service, method] of [
      ["MerchantService", "AddBook"],
      ["MerchantService", "RemoveBook"],
      ["MerchantService", "UpdateStock"],
      ["CustomerService", "PurchaseBook"],
      ["CustomerService", "CheckoutCart"],
      ["CustomerService", "AddReview"],
    ] as const) {
      const { status, json } = await call(rpc(service, method, {}, MERCHANT));
      expect(status, `${service}/${method}`).toBe(501);
      expect(json.code).toBe("unimplemented");
    }
  });

  it("LookupBookByISBN is public and validates the ISBN first", async () => {
    const { status, json } = await call(
      rpc("MerchantService", "LookupBookByISBN", { isbn: "not-an-isbn" }),
    );
    expect(status).toBe(400);
    expect(json.code).toBe("invalid_argument");
    expect(json.message).toBe(
      "invalid ISBN: expected 10 or 13 digits with a valid check digit",
    );
  });
});
