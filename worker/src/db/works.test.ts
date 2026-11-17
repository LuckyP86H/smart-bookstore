import { describe, expect, it } from "vitest";

import type { QueryRow, QueryRunner } from "./client";
import { getWork } from "./works";

// A multi-store work: Effective Java listed by two stores (one of them
// synthetic), two editions on record, two reviews — one per listing —
// so every merge rule in §8 has something to bite on.
const PROJECTION = {
  id: 7n,
  work_ref_id: 21n,
  local_work_id: null,
  title: "Effective Java",
  author_display: "Joshua Bloch",
  categories: ["Computers"],
  summary_en: "The classic Java best-practices book.",
  summary_zh: "Java 最佳实践经典。",
};

const OFFERS = [
  {
    listing_id: 55n,
    store_id: 1n,
    store_name: "merchant1",
    isbn: "9780134685991",
    price: "54.99",
    stock_quantity: 3,
    average_rating: "5.00",
    total_sold: 1,
    is_synthetic: false,
    categories: ["Programming"],
    edition_ref_id: 11n,
  },
  {
    listing_id: 56n,
    store_id: 2n,
    store_name: "seed-merchant-b",
    isbn: "9780134685991",
    price: "39.50",
    stock_quantity: 7,
    average_rating: "3.00",
    total_sold: 0,
    is_synthetic: true,
    categories: [],
    edition_ref_id: 11n,
  },
];

const EDITIONS = [
  {
    id: 11n,
    title: "Effective Java",
    publisher: "Addison-Wesley",
    publish_year: 2018,
    language: "eng",
    page_count: 412,
    isbn13: "9780134685991",
  },
  {
    id: 12n,
    title: "Effective Java",
    publisher: "Addison-Wesley",
    publish_year: 2008,
    language: "eng",
    page_count: 346,
    isbn13: "9780321356680",
  },
];

const REVIEWS = [
  {
    id: 91n,
    book_id: 55n,
    customer_id: 3n,
    customer_name: "customer",
    rating: 5,
    review_text: "Essential.",
    created_at: new Date("2026-11-01T00:00:00Z"),
    listing_id: 55n,
    store_name: "merchant1",
    is_synthetic: false,
    edition_ref_id: 11n,
  },
  {
    id: 92n,
    book_id: 56n,
    customer_id: 3n,
    customer_name: "customer",
    rating: 3,
    review_text: "Demo copy was fine.",
    created_at: new Date("2026-11-02T00:00:00Z"),
    listing_id: 56n,
    store_name: "seed-merchant-b",
    is_synthetic: true,
    edition_ref_id: 11n,
  },
];

function fixtureRun(overrides: Partial<Record<string, QueryRow[]>> = {}) {
  const run: QueryRunner = async (text) => {
    if (text.includes("IS NOT DISTINCT FROM ll.work_ref_id")) {
      return overrides["projection"] ?? [PROJECTION];
    }
    if (text.includes("FROM works wk WHERE")) {
      return overrides["projection"] ?? [PROJECTION];
    }
    if (text.includes("FROM reviews r")) {
      return overrides["reviews"] ?? REVIEWS;
    }
    if (text.includes("b.is_synthetic")) {
      return overrides["offers"] ?? OFFERS;
    }
    if (text.includes("FROM ref_editions")) {
      return overrides["editions"] ?? EDITIONS;
    }
    return [];
  };
  return run;
}

describe("getWork", () => {
  it("merges a multi-store work: offers, editions, reviews, aggregates", async () => {
    const work = await getWork(fixtureRun(), { bookId: 55n });
    expect(work).not.toBeNull();
    if (work === null) return;
    expect(work.workId).toBe(7n);
    expect(work.workRefId).toBe(21n);
    expect(work.title).toBe("Effective Java");
    expect(work.authorDisplay).toBe("Joshua Bloch");
    expect(work.summaryZh).toBe("Java 最佳实践经典。");

    expect(work.offers).toHaveLength(2);
    expect(work.offers[0].storeName).toBe("merchant1");
    expect(work.offers[1].isSynthetic).toBe(true);
    expect(work.hasSyntheticListings).toBe(true);

    expect(work.editions).toHaveLength(2);
    expect(work.editions[1].publishYear).toBe(2008);

    // Reviews roll up across listings, keeping store attribution.
    expect(work.reviews).toHaveLength(2);
    expect(work.reviews[0].storeName).toBe("merchant1");
    expect(work.reviews[0].review?.rating).toBe(5);
    expect(work.reviews[1].listingId).toBe(56n);
    // §4.4 at review granularity: the synthetic listing's review is
    // flagged, the real one is not (fix round item 12).
    expect(work.reviews[0].isSynthetic).toBe(false);
    expect(work.reviews[1].isSynthetic).toBe(true);

    // Aggregates with exact denominators.
    expect(work.reviewCount).toBe(2);
    expect(work.meanRating).toBe(4);
    expect(work.minPrice).toBe(39.5);
    expect(work.maxPrice).toBe(54.99);

    // §4.5 read-time union: spine categories + listing categories.
    expect(work.categories).toEqual(["Computers", "Programming"]);
  });

  it("resolves by projection work id as well as by listing id", async () => {
    const work = await getWork(fixtureRun(), { workId: 7n });
    expect(work?.title).toBe("Effective Java");
  });

  it("work_id wins when both selectors are set (fix round item 3)", async () => {
    // The proto comment and resolveProjection agree: workId is checked
    // first. The two selectors name DIFFERENT projections here, so the
    // winner is observable.
    const run: QueryRunner = async (text) => {
      if (text.includes("FROM works wk WHERE")) {
        return [{ ...PROJECTION, id: 7n, title: "Resolved By Work Id" }];
      }
      if (text.includes("IS NOT DISTINCT FROM ll.work_ref_id")) {
        return [{ ...PROJECTION, id: 8n, title: "Resolved By Book Id" }];
      }
      return [];
    };
    const work = await getWork(run, { bookId: 55n, workId: 7n });
    expect(work?.title).toBe("Resolved By Work Id");
    expect(work?.workId).toBe(7n);
  });

  it("returns null for an unlinked listing / unknown work", async () => {
    const run = fixtureRun({ projection: [] });
    expect(await getWork(run, { bookId: 999n })).toBeNull();
    expect(await getWork(run, { workId: 999n })).toBeNull();
    expect(await getWork(run, {})).toBeNull();
  });

  it("handles a local work (no ref editions, no summaries)", async () => {
    const run = fixtureRun({
      projection: [
        {
          ...PROJECTION,
          work_ref_id: null,
          local_work_id: 5n,
          title: "红楼梦",
          author_display: "曹雪芹",
          summary_en: null,
          summary_zh: null,
        },
      ],
      editions: [],
    });
    const work = await getWork(run, { bookId: 55n });
    expect(work?.localWorkId).toBe(5n);
    expect(work?.editions).toHaveLength(0);
    expect(work?.summaryEn).toBe("");
  });
});
