import { describe, expect, it } from "vitest";

import { createTestDoubleCredentialChecker } from "../auth/test-double";
import { serveConnectRequest } from "../connect-app";
import type { QueryRunner, QueryValue } from "../db/client";
import type { Env } from "../env";

// Router-level P4 coverage: the §4.6 prefill source order and AddBook's
// Path A pass, driven through serveConnectRequest with stub runners
// and a stub fetch (the same seams the P1–P3 suites use).

const ENV = { GOOGLE_BOOKS_API_KEY: undefined } as unknown as Env;

const MERCHANT = ["merchant1", "password1"] as const;
const CUSTOMER = ["customer", "password"] as const;

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

// ---------------------------------------------------------------------------
// Prefill (LookupBookByISBN)
// ---------------------------------------------------------------------------

const PREFILL_ROW = {
  title: "Effective Java",
  publisher: "Addison-Wesley",
  publish_year: 2018,
  page_count: 412,
  author_display: "Joshua Bloch",
  categories: ["Computers"],
};

const OL_EDITION = {
  key: "/books/OL7356322M",
  title: "Effective Java",
  publishers: ["Addison-Wesley Professional"],
  publish_date: "January 6, 2018",
  number_of_pages: 412,
  languages: [{ key: "/languages/eng" }],
  works: [{ key: "/works/OL45883W" }],
  authors: [{ key: "/authors/OL34184A" }],
};

function olFetch(capture: string[]) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    capture.push(url);
    if (url.includes("googleapis.com")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              volumeInfo: {
                title: "Effective Java",
                authors: ["Joshua Bloch"],
                publisher: "Addison-Wesley",
                publishedDate: "2018-01-06",
                description: "Google's description.",
                pageCount: 412,
                categories: ["Computers"],
                imageLinks: { thumbnail: "https://example.test/ej.jpg" },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/isbn/")) {
      return new Response(JSON.stringify(OL_EDITION), { status: 200 });
    }
    if (url.includes("/works/")) {
      return new Response(
        JSON.stringify({ subjects: ["Java"], description: "OL description." }),
        { status: 200 },
      );
    }
    if (url.includes("/authors/")) {
      return new Response(JSON.stringify({ name: "Joshua Bloch" }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
}

async function callLookup(run: QueryRunner, fetchFn: typeof fetch) {
  const response = await serveConnectRequest(
    rpc("MerchantService", "LookupBookByISBN", { isbn: "9780134685991" }),
    ENV,
    run,
    { checker: createTestDoubleCredentialChecker(), fetchFn },
  );
  return {
    status: response.status,
    json: (await response.json()) as { [key: string]: any },
  };
}

describe("LookupBookByISBN prefill order (§4.6)", () => {
  it("answers from the local index without any API call", async () => {
    const capture: string[] = [];
    const run: QueryRunner = async (text) =>
      text.includes("LEFT JOIN works wk") ? [PREFILL_ROW] : [];
    const { status, json } = await callLookup(
      run,
      olFetch(capture) as typeof fetch,
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      title: "Effective Java",
      author: "Joshua Bloch",
      source: "local_index",
    });
    // proto3 JSON omits false booleans: absence IS the false value.
    expect(json.descriptionTransient ?? false).toBe(false);
    expect(json.coverTransient ?? false).toBe(false);
    expect(capture).toHaveLength(0);
  });

  it("falls through to Open Library (attributed, submittable)", async () => {
    const capture: string[] = [];
    const run: QueryRunner = async () => [];
    const { status, json } = await callLookup(
      run,
      olFetch(capture) as typeof fetch,
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      source: "open_library",
      attribution: "Open Library",
      description: "OL description.",
    });
    expect(json.descriptionTransient ?? false).toBe(false);
    expect(json.coverTransient ?? false).toBe(false);
    expect(capture.some((u) => u.includes("googleapis.com"))).toBe(false);
  });

  it("uses Google last, with description/cover flagged transient", async () => {
    const run: QueryRunner = async () => [];
    const googleOnly = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("googleapis.com")) {
        return olFetch([])(input);
      }
      return new Response("not found", { status: 404 });
    };
    const { status, json } = await callLookup(
      run,
      googleOnly as typeof fetch,
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      source: "google_books",
      description: "Google's description.",
      descriptionTransient: true,
      coverTransient: true,
    });
    expect(String(json.attribution)).toContain("Google Books");
  });

  it("is still NotFound when no source knows the ISBN", async () => {
    const run: QueryRunner = async () => [];
    const nothing = async (input: RequestInfo | URL) => {
      if (String(input).includes("googleapis.com")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const { status, json } = await callLookup(run, nothing as typeof fetch);
    expect(status).toBe(404);
    expect(json).toMatchObject({ code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// AddBook + Path A, and GetWork, through the router
// ---------------------------------------------------------------------------

const BOOK_ROW = {
  id: 55n,
  store_id: 1n,
  isbn: "9780134685991",
  title: "Effective Java",
  author: "Joshua Bloch",
  genre: "FICTION",
  publisher: "Addison-Wesley",
  publication_year: 2018,
  page_count: 412,
  language: "en",
  cover_image_url: "",
  description: "",
  price: "54.99",
  stock_quantity: 3,
  total_sold: 0,
  average_rating: "0",
  created_at: new Date("2026-11-12T00:00:00Z"),
  is_synthetic: false,
};

const CANDIDATE_ROW = {
  edition_id: 11n,
  edition_title: "Effective Java",
  work_ref_id: 21n,
  work_title: "Effective Java",
  author_display: "Joshua Bloch",
};

function addBookRun(calls: { text: string; values: QueryValue[] }[]) {
  const run: QueryRunner = async (text, values) => {
    calls.push({ text, values });
    if (text.includes("INSERT INTO books")) return [BOOK_ROW];
    if (text.includes("SELECT username FROM stores")) {
      return [{ username: "merchant1" }];
    }
    if (text.includes("FROM isbn_index i")) return [CANDIDATE_ROW];
    if (text.includes("FROM listing_links WHERE")) return [];
    if (text.includes("INSERT INTO ai_runs")) return [{ id: 42 }];
    if (text.includes("UPDATE ai_runs")) return [{ id: 42 }];
    if (text.includes("INSERT INTO evidence")) return [{ id: 7n }];
    return [];
  };
  return run;
}

const ADD_BOOK_BODY = {
  isbn: "9780134685991",
  title: "Effective Java",
  author: "Joshua Bloch",
  genre: "FICTION",
  publisher: "Addison-Wesley",
  publicationYear: 2018,
  pageCount: 412,
  language: "en",
  price: 54.99,
  stockQuantity: 3,
};

describe("AddBook Path A wiring", () => {
  it("links the new listing when Path A is wired", async () => {
    const calls: { text: string; values: QueryValue[] }[] = [];
    const run = addBookRun(calls);
    const response = await serveConnectRequest(
      rpc("MerchantService", "AddBook", ADD_BOOK_BODY, MERCHANT),
      ENV,
      run,
      {
        checker: createTestDoubleCredentialChecker(),
        begin: async (fn) => fn(run),
        pathA: {},
      },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      book: { id: string };
    };
    expect(json.book.id).toBe("55");
    expect(
      calls.some((c) => c.text.includes("INSERT INTO listing_links")),
    ).toBe(true);
  });

  it("demotes instead of linking a lying listing, AddBook still succeeds", async () => {
    const calls: { text: string; values: QueryValue[] }[] = [];
    const run = addBookRun(calls);
    const response = await serveConnectRequest(
      rpc(
        "MerchantService",
        "AddBook",
        { ...ADD_BOOK_BODY, title: "Design Patterns", author: "Erich Gamma" },
        MERCHANT,
      ),
      ENV,
      run,
      {
        checker: createTestDoubleCredentialChecker(),
        begin: async (fn) => fn(run),
        pathA: {},
      },
    );
    expect(response.status).toBe(200);
    expect(
      calls.some((c) => c.text.includes("INSERT INTO listing_links")),
    ).toBe(false);
    const evidence = calls.filter((c) =>
      c.text.includes("INSERT INTO evidence"),
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0].values).toContain("rejected");
  });

  it("does no identity work at all when Path A is not wired (P3 behaviour)", async () => {
    const calls: { text: string; values: QueryValue[] }[] = [];
    const run = addBookRun(calls);
    const response = await serveConnectRequest(
      rpc("MerchantService", "AddBook", ADD_BOOK_BODY, MERCHANT),
      ENV,
      run,
      { checker: createTestDoubleCredentialChecker() },
    );
    expect(response.status).toBe(200);
    expect(
      calls.some(
        (c) =>
          c.text.includes("listing_links") || c.text.includes("isbn_index"),
      ),
    ).toBe(false);
  });
});

describe("GetWork through the router", () => {
  it("serves the merged work to an authenticated caller", async () => {
    const run: QueryRunner = async (text) => {
      if (text.includes("IS NOT DISTINCT FROM ll.work_ref_id")) {
        return [
          {
            id: 7n,
            work_ref_id: 21n,
            local_work_id: null,
            title: "Effective Java",
            author_display: "Joshua Bloch",
            categories: ["Computers"],
            summary_en: "",
            summary_zh: "",
          },
        ];
      }
      if (text.includes("b.is_synthetic")) {
        return [
          {
            listing_id: 55n,
            store_id: 1n,
            store_name: "merchant1",
            isbn: "9780134685991",
            price: "54.99",
            stock_quantity: 3,
            average_rating: "5.00",
            total_sold: 1,
            is_synthetic: true,
            categories: [],
            edition_ref_id: 11n,
          },
        ];
      }
      return [];
    };
    const response = await serveConnectRequest(
      rpc("CustomerService", "GetWork", { bookId: "55" }, CUSTOMER),
      ENV,
      run,
      { checker: createTestDoubleCredentialChecker() },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { [key: string]: any };
    expect(json).toMatchObject({
      workId: "7",
      title: "Effective Java",
      hasSyntheticListings: true,
    });
    expect(json.offers).toHaveLength(1);
    expect(
      (json.offers as { isSynthetic?: boolean }[])[0].isSynthetic,
    ).toBe(true);
  });

  it("rejects anonymous callers and empty selectors", async () => {
    const run: QueryRunner = async () => [];
    const anon = await serveConnectRequest(
      rpc("CustomerService", "GetWork", { bookId: "55" }),
      ENV,
      run,
      { checker: createTestDoubleCredentialChecker() },
    );
    expect(anon.status).toBe(401);
    const empty = await serveConnectRequest(
      rpc("CustomerService", "GetWork", {}, CUSTOMER),
      ENV,
      run,
      { checker: createTestDoubleCredentialChecker() },
    );
    expect(empty.status).toBe(400);
  });
});
