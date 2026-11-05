import { describe, expect, it } from "vitest";

import { BookNotFoundError, lookupBookByISBN } from "./google-books";

function stubFetch(status: number, payload: unknown, capture?: { url?: string; key?: string | null }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = String(input);
      capture.key = new Headers(init?.headers).get("x-goog-api-key");
    }
    return new Response(JSON.stringify(payload), { status });
  };
}

const DUNE_PAYLOAD = {
  items: [
    {
      volumeInfo: {
        title: "Dune",
        authors: ["Frank Herbert", "Someone Else"],
        publisher: "Ace Books",
        publishedDate: "1990-08-02",
        description: "Set on Arrakis.",
        pageCount: 688,
        categories: ["Fiction"],
        imageLinks: { thumbnail: "https://example.test/dune.jpg" },
      },
    },
  ],
};

describe("lookupBookByISBN", () => {
  it("maps the first volume the way the Go client does", async () => {
    const capture: { url?: string; key?: string | null } = {};
    const info = await lookupBookByISBN("9780441172719", {
      fetchFn: stubFetch(200, DUNE_PAYLOAD, capture) as typeof fetch,
    });
    expect(info).toEqual({
      title: "Dune",
      author: "Frank Herbert, Someone Else",
      publisher: "Ace Books",
      publicationYear: 1990,
      pageCount: 688,
      description: "Set on Arrakis.",
      coverImageUrl: "https://example.test/dune.jpg",
      categories: ["Fiction"],
    });
    expect(capture.url).toContain("q=isbn%3A9780441172719");
    // Keyless by default: no API-key header is sent.
    expect(capture.key).toBeNull();
  });

  it("sends the API key as a header, never in the URL", async () => {
    const capture: { url?: string; key?: string | null } = {};
    await lookupBookByISBN("9780441172719", {
      apiKey: "test-key",
      fetchFn: stubFetch(200, DUNE_PAYLOAD, capture) as typeof fetch,
    });
    expect(capture.key).toBe("test-key");
    expect(capture.url).not.toContain("test-key");
  });

  it("reports an empty result set as BookNotFoundError", async () => {
    await expect(
      lookupBookByISBN("9780000000002", {
        fetchFn: stubFetch(200, { items: [] }) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(BookNotFoundError);
  });

  it("surfaces non-200 statuses as errors naming the status", async () => {
    await expect(
      lookupBookByISBN("9780441172719", {
        fetchFn: stubFetch(429, { error: { code: 429 } }) as typeof fetch,
      }),
    ).rejects.toThrowError("Google Books API returned status 429");
  });

  it("leaves publicationYear 0 when publishedDate has no year", async () => {
    const info = await lookupBookByISBN("9780441172719", {
      fetchFn: stubFetch(200, {
        items: [{ volumeInfo: { title: "X", publishedDate: "" } }],
      }) as typeof fetch,
    });
    expect(info.publicationYear).toBe(0);
    expect(info.author).toBe("");
    expect(info.categories).toEqual([]);
  });
});
