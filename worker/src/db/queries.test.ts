import { describe, expect, it } from "vitest";

import { Genre } from "../gen/bookstore_pb";
import { parseOptionalTime } from "../services/merchant";
import {
  bookFromRow,
  buildAvailableBooksQueries,
  formatTimestamp,
  genreFromName,
  type AvailableBooksFilter,
} from "./queries";

const BASE_FILTER: AvailableBooksFilter = {
  searchQuery: "",
  genreFilter: "",
  authorFilter: "",
  minPrice: 0,
  maxPrice: 0,
  sortOrder: "",
  page: 1,
  pageSize: 20,
};

describe("buildAvailableBooksQueries", () => {
  it("builds the unfiltered page + count pair with default order", () => {
    const { countText, countValues, pageText, pageValues } =
      buildAvailableBooksQueries(BASE_FILTER);
    expect(countValues).toEqual([]);
    expect(pageValues).toEqual([20, 0]);
    expect(countText).toContain("SELECT COUNT(*) AS total FROM (");
    expect(countText).toContain("b.stock_quantity > 0");
    expect(countText).not.toContain("ORDER BY");
    expect(pageText).toContain("ORDER BY b.created_at DESC");
    expect(pageText).toContain("LIMIT $1 OFFSET $2");
  });

  it("reuses one placeholder for the title/author search pair", () => {
    const { pageText, pageValues } = buildAvailableBooksQueries({
      ...BASE_FILTER,
      searchQuery: "dune",
    });
    expect(pageText).toContain(
      "(LOWER(b.title) LIKE $1 OR LOWER(b.author) LIKE $1)",
    );
    expect(pageValues).toEqual(["%dune%", 20, 0]);
    expect(pageText).toContain("LIMIT $2 OFFSET $3");
  });

  it("numbers every filter placeholder in Go's order", () => {
    const { countValues, pageText, pageValues } = buildAvailableBooksQueries({
      searchQuery: "dune",
      genreFilter: "FICTION",
      authorFilter: "herbert",
      minPrice: 10,
      maxPrice: 50,
      sortOrder: "PRICE_ASC",
      page: 2,
      pageSize: 10,
    });
    expect(countValues).toEqual(["%dune%", "FICTION", "%herbert%", 10, 50]);
    expect(pageValues).toEqual(["%dune%", "FICTION", "%herbert%", 10, 50, 10, 10]);
    expect(pageText).toContain("b.genre = $2");
    expect(pageText).toContain("LOWER(b.author) LIKE $3");
    expect(pageText).toContain("b.price >= $4");
    expect(pageText).toContain("b.price <= $5");
    expect(pageText).toContain("ORDER BY b.price ASC");
    expect(pageText).toContain("LIMIT $6 OFFSET $7");
  });

  it("skips the genre filter for GENRE_UNSPECIFIED and empty", () => {
    for (const genreFilter of ["", "GENRE_UNSPECIFIED"]) {
      const { pageText, pageValues } = buildAvailableBooksQueries({
        ...BASE_FILTER,
        genreFilter,
      });
      expect(pageText).not.toContain("b.genre =");
      expect(pageValues).toEqual([20, 0]);
    }
  });

  it("skips zero price bounds", () => {
    const { pageText } = buildAvailableBooksQueries(BASE_FILTER);
    expect(pageText).not.toContain("b.price >=");
    expect(pageText).not.toContain("b.price <=");
  });

  it("maps every documented sort order, defaulting unknown values", () => {
    const expectations: Record<string, string> = {
      PRICE_ASC: "ORDER BY b.price ASC",
      PRICE_DESC: "ORDER BY b.price DESC",
      TITLE_ASC: "ORDER BY b.title ASC",
      TITLE_DESC: "ORDER BY b.title DESC",
      RATING_DESC: "ORDER BY b.average_rating DESC",
      PUBLICATION_YEAR_DESC: "ORDER BY b.publication_year DESC",
      SORT_ORDER_UNSPECIFIED: "ORDER BY b.created_at DESC",
      WHATEVER: "ORDER BY b.created_at DESC",
    };
    for (const [sortOrder, fragment] of Object.entries(expectations)) {
      const { pageText } = buildAvailableBooksQueries({
        ...BASE_FILTER,
        sortOrder,
      });
      expect(pageText).toContain(fragment);
    }
  });

  it("applies Go's pagination defaults (page 1, size 20)", () => {
    const { pageValues } = buildAvailableBooksQueries({
      ...BASE_FILTER,
      page: 0,
      pageSize: 0,
    });
    expect(pageValues).toEqual([20, 0]);
  });

  it("computes offsets from page and page size", () => {
    const { pageValues } = buildAvailableBooksQueries({
      ...BASE_FILTER,
      page: 3,
      pageSize: 10,
    });
    expect(pageValues).toEqual([10, 20]);
  });
});

describe("row mapping", () => {
  it("coerces postgres.js numerics and timestamps into proto types", () => {
    const book = bookFromRow({
      id: "7",
      store_id: 1,
      isbn: "9780441172719",
      title: "Dune",
      author: "Frank Herbert",
      genre: "FICTION",
      publisher: "Ace",
      publication_year: 1990,
      page_count: 688,
      language: "en",
      cover_image_url: "",
      description: "",
      price: "19.99",
      stock_quantity: 4,
      total_sold: 12,
      average_rating: "4.50",
      created_at: new Date("2026-11-01T09:30:49.000Z"),
      store_name: "merchant1",
    });
    expect(book.id).toBe(7n);
    expect(book.genre).toBe(Genre.FICTION);
    expect(book.price).toBe(19.99);
    expect(book.averageRating).toBe(4.5);
    expect(book.createdAt).toBe("2026-11-01T09:30:49Z");
    expect(book.storeName).toBe("merchant1");
  });

  it("maps unknown stored genre strings to GENRE_UNSPECIFIED", () => {
    expect(genreFromName("GENRE_PSYCHOLOGY")).toBe(Genre.GENRE_UNSPECIFIED);
    expect(genreFromName(null)).toBe(Genre.GENRE_UNSPECIFIED);
    expect(genreFromName("SCIENCE_FICTION")).toBe(Genre.SCIENCE_FICTION);
  });

  it("formats timestamps like Go's time.RFC3339", () => {
    expect(formatTimestamp(new Date("2026-11-01T09:30:49.000Z"))).toBe(
      "2026-11-01T09:30:49Z",
    );
    expect(formatTimestamp(new Date("2026-11-01T09:30:49.123Z"))).toBe(
      "2026-11-01T09:30:49.123Z",
    );
    expect(formatTimestamp(new Date("2026-11-01T09:30:49.120Z"))).toBe(
      "2026-11-01T09:30:49.12Z",
    );
    expect(formatTimestamp(null)).toBe("");
  });
});

describe("parseOptionalTime", () => {
  it("treats empty as unset", () => {
    expect(parseOptionalTime("start_date", "")).toBeNull();
  });

  it("normalises a valid RFC 3339 bound", () => {
    expect(parseOptionalTime("start_date", "2026-01-02T15:04:05Z")).toBe(
      "2026-01-02T15:04:05.000Z",
    );
  });

  it("rejects garbage and impossible dates with InvalidArgument shape", () => {
    for (const bad of [
      "yesterday",
      "2026-01-02",
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-02 15:04:05",
    ]) {
      try {
        parseOptionalTime("start_date", bad);
        expect.unreachable(`expected throw for ${bad}`);
      } catch (err) {
        expect(err).toMatchObject({
          code: 3, // Code.InvalidArgument
          rawMessage:
            "invalid start_date: expected RFC 3339, e.g. 2026-01-02T15:04:05Z",
        });
      }
    }
  });
});
