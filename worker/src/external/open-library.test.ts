import { describe, expect, it } from "vitest";

import {
  createOpenLibraryEditionLookup,
  lookupEditionByISBN,
  lookupOlBookInfo,
} from "./open-library";

const EDITION_JSON = {
  key: "/books/OL7356322M",
  title: "Effective Java",
  publishers: ["Addison-Wesley Professional"],
  publish_date: "January 6, 2018",
  number_of_pages: 412,
  languages: [{ key: "/languages/eng" }],
  works: [{ key: "/works/OL45883W" }],
  authors: [{ key: "/authors/OL34184A" }],
};

const WORK_JSON = {
  subjects: ["Java (Computer program language)", "Object-oriented programming"],
  description: { value: "The definitive guide to Java best practices." },
  authors: [{ author: { key: "/authors/OL34184A" } }],
};

const AUTHOR_JSON = { name: "Joshua Bloch" };

function routerFetch(payloads: Record<string, unknown>, capture?: string[]) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    capture?.push(url);
    for (const [needle, payload] of Object.entries(payloads)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
}

describe("lookupEditionByISBN", () => {
  it("maps the edition JSON (year out of a prose date, language key)", async () => {
    const info = await lookupEditionByISBN("9780134685991", {
      fetchFn: routerFetch({ "/isbn/": EDITION_JSON }) as typeof fetch,
    });
    expect(info).toEqual({
      editionKey: "/books/OL7356322M",
      workKey: "/works/OL45883W",
      title: "Effective Java",
      publisher: "Addison-Wesley Professional",
      publicationYear: 2018,
      pageCount: 412,
      language: "eng",
    });
  });

  it("returns null on 404 and throws on other failures", async () => {
    const fetchFn = routerFetch({}) as typeof fetch;
    expect(await lookupEditionByISBN("9780000000002", { fetchFn })).toBeNull();
    const failing = (async () =>
      new Response("down", { status: 503 })) as typeof fetch;
    await expect(
      lookupEditionByISBN("9780134685991", { fetchFn: failing }),
    ).rejects.toThrow(/503/);
  });

  it("sends an identified User-Agent", async () => {
    let ua: string | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      ua = new Headers(init?.headers).get("user-agent");
      return new Response(JSON.stringify(EDITION_JSON), { status: 200 });
    };
    await lookupEditionByISBN("9780134685991", {
      fetchFn: fetchFn as typeof fetch,
    });
    expect(ua).toContain("smart-bookstore-worker");
  });
});

describe("lookupOlBookInfo", () => {
  it("assembles edition + work + author into the prefill shape", async () => {
    const info = await lookupOlBookInfo("9780134685991", {
      fetchFn: routerFetch({
        "/isbn/": EDITION_JSON,
        "/works/": WORK_JSON,
        "/authors/": AUTHOR_JSON,
      }) as typeof fetch,
    });
    expect(info).toEqual({
      title: "Effective Java",
      author: "Joshua Bloch",
      publisher: "Addison-Wesley Professional",
      publicationYear: 2018,
      pageCount: 412,
      description: "The definitive guide to Java best practices.",
      coverImageUrl:
        "https://covers.openlibrary.org/b/isbn/9780134685991-L.jpg",
      categories: [
        "Java (Computer program language)",
        "Object-oriented programming",
      ],
    });
  });

  it("returns null when the edition does not exist", async () => {
    expect(
      await lookupOlBookInfo("9780000000002", {
        fetchFn: routerFetch({}) as typeof fetch,
      }),
    ).toBeNull();
  });
});

describe("createOpenLibraryEditionLookup (rate limit + memoisation)", () => {
  it("memoises hits and misses; spaces network calls by >= 334ms", async () => {
    let fetches = 0;
    const fetchFn = async (input: RequestInfo | URL) => {
      fetches += 1;
      if (String(input).includes("9780134685991")) {
        return new Response(JSON.stringify(EDITION_JSON), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const lookup = createOpenLibraryEditionLookup({
      fetchFn: fetchFn as typeof fetch,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    const first = await lookup("9780134685991");
    expect(first?.editionKey).toBe("/books/OL7356322M");
    // Second call for the same ISBN: cache, no fetch, no sleep.
    expect(await lookup("9780134685991")).toEqual(first);
    expect(fetches).toBe(1);

    // A new ISBN pays the rate-limit spacing.
    expect(await lookup("9780000000002")).toBeNull();
    expect(fetches).toBe(2);
    expect(sleeps).toEqual([334]);

    // The miss is memoised too.
    expect(await lookup("9780000000002")).toBeNull();
    expect(fetches).toBe(2);
  });
});
