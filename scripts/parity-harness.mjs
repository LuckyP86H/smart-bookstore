#!/usr/bin/env node
// Parity harness (ROUTE-B-PLAN §6): fires identical Connect-protocol JSON
// requests at one or two base URLs and reports how the responses compare.
//
//   node scripts/parity-harness.mjs --a https://worker.example
//       Expectation mode: checks each case against the response shape the
//       Go backend produces for the same request (status + Connect code).
//
//   node scripts/parity-harness.mjs --a https://go-stack.example --b https://worker.example
//       Diff mode: the same requests go to both base URLs and the
//       status + JSON bodies are deep-compared. Run this with the Go stack
//       (docker compose) as --a and a Worker preview as --b, with the SAME
//       seed dataset loaded into both databases.
//
// Credentials are the documented seed accounts (merchant1 / customer).
// Exit code is non-zero when any expectation fails or any diff mismatches.
//
// Known environmental caveat for the isbn/* cases: without a
// GOOGLE_BOOKS_API_KEY, Google Books attributes requests to a shared
// consumer project whose daily quota is frequently exhausted; the API then
// answers HTTP 429 and BOTH implementations surface that as
// 503/unavailable "book lookup service unavailable" (verified live
// 2026-11-05). Treat isbn 503s as an upstream-quota signal, not a parity
// signal, unless one side has a key configured and the other does not.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const AUTH = {
  merchant: ["merchant1", "password1"],
  customer: ["customer", "password"],
  wrong: ["customer", "not-the-password"],
  unknown: ["no-such-user", "password"],
};

const CASES = [
  { name: "available-books/customer", service: "CustomerService", method: "GetAvailableBooks", auth: "customer", body: {}, expect: { status: 200 } },
  { name: "available-books/merchant", service: "CustomerService", method: "GetAvailableBooks", auth: "merchant", body: {}, expect: { status: 200 } },
  { name: "available-books/no-auth", service: "CustomerService", method: "GetAvailableBooks", body: {}, expect: { status: 401, code: "unauthenticated" } },
  { name: "available-books/wrong-password", service: "CustomerService", method: "GetAvailableBooks", auth: "wrong", body: {}, expect: { status: 401, code: "unauthenticated" } },
  { name: "available-books/unknown-user", service: "CustomerService", method: "GetAvailableBooks", auth: "unknown", body: {}, expect: { status: 401, code: "unauthenticated" } },
  { name: "available-books/filters+page2", service: "CustomerService", method: "GetAvailableBooks", auth: "customer", body: { searchQuery: "dune", genreFilter: "FICTION", authorFilter: "herbert", minPrice: 5, maxPrice: 100, sortOrder: "PRICE_ASC", page: 2, pageSize: 5 }, expect: { status: 200 } },
  ...["PRICE_ASC", "PRICE_DESC", "TITLE_ASC", "TITLE_DESC", "RATING_DESC", "PUBLICATION_YEAR_DESC"].map((sortOrder) => ({
    name: `available-books/sort-${sortOrder}`,
    service: "CustomerService",
    method: "GetAvailableBooks",
    auth: "customer",
    body: { sortOrder },
    expect: { status: 200 },
  })),
  { name: "merchant-books/merchant", service: "MerchantService", method: "GetMerchantBooks", auth: "merchant", body: { includeSoldOut: true }, expect: { status: 200 } },
  { name: "merchant-books/customer-denied", service: "MerchantService", method: "GetMerchantBooks", auth: "customer", body: {}, expect: { status: 403, code: "permission_denied" } },
  { name: "sold-books/all", service: "MerchantService", method: "GetSoldBooks", auth: "merchant", body: {}, expect: { status: 200 } },
  { name: "sold-books/start-only", service: "MerchantService", method: "GetSoldBooks", auth: "merchant", body: { startDate: "2026-01-01T00:00:00Z" }, expect: { status: 200 } },
  { name: "sold-books/range", service: "MerchantService", method: "GetSoldBooks", auth: "merchant", body: { startDate: "2026-01-01T00:00:00Z", endDate: "2027-01-01T00:00:00Z" }, expect: { status: 200 } },
  { name: "sold-books/bad-date", service: "MerchantService", method: "GetSoldBooks", auth: "merchant", body: { startDate: "soon" }, expect: { status: 400, code: "invalid_argument" } },
  { name: "sold-books/inverted-range", service: "MerchantService", method: "GetSoldBooks", auth: "merchant", body: { startDate: "2026-02-01T00:00:00Z", endDate: "2026-01-01T00:00:00Z" }, expect: { status: 400, code: "invalid_argument" } },
  { name: "low-stock/default", service: "MerchantService", method: "GetLowStockBooks", auth: "merchant", body: {}, expect: { status: 200 } },
  { name: "low-stock/threshold-2", service: "MerchantService", method: "GetLowStockBooks", auth: "merchant", body: { threshold: 2 }, expect: { status: 200 } },
  { name: "book-details/missing", service: "CustomerService", method: "GetBookDetails", auth: "customer", body: { bookId: "999999" }, expect: { status: 404, code: "not_found" } },
  { name: "book-reviews/missing-book", service: "CustomerService", method: "GetBookReviews", auth: "customer", body: { bookId: "999999" }, expect: { status: 200 } },
  { name: "purchase-history/customer", service: "CustomerService", method: "GetPurchaseHistory", auth: "customer", body: {}, expect: { status: 200 } },
  { name: "purchase-history/merchant", service: "CustomerService", method: "GetPurchaseHistory", auth: "merchant", body: {}, expect: { status: 200 } },
  { name: "isbn/dune-13", service: "MerchantService", method: "LookupBookByISBN", body: { isbn: "9780441172719" }, expect: { status: 200, jsonCheck: (j) => typeof j.title === "string" && j.title.toLowerCase().includes("dune") } },
  { name: "isbn/dune-10", service: "MerchantService", method: "LookupBookByISBN", body: { isbn: "0441172717" }, expect: { status: 200 } },
  { name: "isbn/hyphenated", service: "MerchantService", method: "LookupBookByISBN", body: { isbn: "978-0-441-17271-9" }, expect: { status: 200 } },
  { name: "isbn/bad-check-digit", service: "MerchantService", method: "LookupBookByISBN", body: { isbn: "9780441172718" }, expect: { status: 400, code: "invalid_argument" } },
  { name: "isbn/valid-but-nonexistent", service: "MerchantService", method: "LookupBookByISBN", body: { isbn: "9780000000002" }, expect: { status: 404, code: "not_found" } },
  { name: "writes/add-book-unimplemented", service: "MerchantService", method: "AddBook", auth: "merchant", body: {}, expect: { status: 501, code: "unimplemented" } },
  { name: "writes/purchase-unimplemented", service: "CustomerService", method: "PurchaseBook", auth: "customer", body: { bookId: "1", quantity: 1 }, expect: { status: 501, code: "unimplemented" } },
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fire(base, testCase) {
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  };
  if (testCase.auth) {
    const [user, pass] = AUTH[testCase.auth];
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  const response = await fetch(
    `${base}/bookstore.v1.${testCase.service}/${testCase.method}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(testCase.body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  let json = null;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    json = { __unparsed: text };
  }
  return { status: response.status, json };
}

async function main() {
  const args = process.argv.slice(2);
  const baseA = args[args.indexOf("--a") + 1];
  const baseB = args.includes("--b") ? args[args.indexOf("--b") + 1] : null;
  if (!baseA) {
    console.error("usage: parity-harness.mjs --a <base-url> [--b <base-url>]");
    process.exit(2);
  }

  let failures = 0;
  for (const testCase of CASES) {
    const a = await fire(baseA.replace(/\/$/, ""), testCase);
    if (baseB) {
      const b = await fire(baseB.replace(/\/$/, ""), testCase);
      const same =
        a.status === b.status && canonical(a.json) === canonical(b.json);
      if (same) {
        console.log(`MATCH  ${testCase.name} (${a.status})`);
      } else {
        failures++;
        console.log(`DIFF   ${testCase.name}`);
        console.log(`  --a: ${a.status} ${canonical(a.json)}`);
        console.log(`  --b: ${b.status} ${canonical(b.json)}`);
      }
    } else {
      const problems = [];
      if (a.status !== testCase.expect.status) {
        problems.push(`status ${a.status}, expected ${testCase.expect.status}`);
      }
      if (testCase.expect.code && a.json?.code !== testCase.expect.code) {
        problems.push(`code ${a.json?.code}, expected ${testCase.expect.code}`);
      }
      if (testCase.expect.jsonCheck && !testCase.expect.jsonCheck(a.json ?? {})) {
        problems.push(`json check failed: ${canonical(a.json)}`);
      }
      if (problems.length === 0) {
        console.log(`PASS   ${testCase.name} (${a.status})`);
      } else {
        failures++;
        console.log(`FAIL   ${testCase.name}: ${problems.join("; ")}`);
      }
    }
  }

  console.log(
    `\n${CASES.length} cases, ${failures} failure${failures === 1 ? "" : "s"}${baseB ? " (diff mode)" : " (expectation mode)"}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
