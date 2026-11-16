// GetWork — the identity layer's first read surface (plan §8).
//
// Worker-only RPC (plan §12 decision 8): Go parity is frozen at the P3
// surface, so nothing here mirrors a Go query. The read model:
//
//   works (projection)  — canonical display fields, seeded from the
//                         reference catalogue and maintained by the
//                         identity write paths (§3.6: the projection is
//                         a cache; the joins below are the truth).
//   listing_links       — which listings belong to the work, and each
//                         listing's linked edition.
//   ref_editions        — the work's published forms.
//   reviews             — rolled up through CURRENT membership (§8):
//                         a review belongs to the work its listing is
//                         linked to now, and carries the listing's
//                         store + edition so "great translation" and
//                         "bad printing" stay distinguishable.
//
// §4.5 category rule: categories are computed at READ time as the
// projection's (spine) categories unioned with the union over member
// listings of books.categories — never persisted onto books, never
// forced into the genre enum. Aggregates carry exact denominators.

import { create } from "@bufbuild/protobuf";

import {
  GetWorkResponseSchema,
  WorkEditionSchema,
  WorkOfferSchema,
  WorkReviewSchema,
  type GetWorkResponse,
} from "../gen/bookstore_pb";
import type { QueryRunner } from "./client";
import { reviewFromRow } from "./queries";

export interface WorkSelector {
  bookId?: bigint;
  workId?: bigint;
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }
  return BigInt(String(value));
}

function toBigInt(value: unknown): bigint {
  return toBigIntOrNull(value) ?? 0n;
}

function toInt(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function toTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

interface ProjectionRow {
  id: bigint;
  workRefId: bigint | null;
  localWorkId: bigint | null;
  title: string;
  authorDisplay: string | null;
  categories: string[];
  summaryEn: string | null;
  summaryZh: string | null;
}

const PROJECTION_COLUMNS = `
  wk.id AS id, wk.work_ref_id AS work_ref_id,
  wk.local_work_id AS local_work_id, wk.title AS title,
  wk.author_display AS author_display, wk.categories AS categories,
  wk.summary_en AS summary_en, wk.summary_zh AS summary_zh`;

function projectionFromRow(row: Record<string, unknown>): ProjectionRow {
  return {
    id: toBigInt(row["id"]),
    workRefId: toBigIntOrNull(row["work_ref_id"]),
    localWorkId: toBigIntOrNull(row["local_work_id"]),
    title: toTextOrNull(row["title"]) ?? "",
    authorDisplay: toTextOrNull(row["author_display"]),
    categories: toTextList(row["categories"]),
    summaryEn: toTextOrNull(row["summary_en"]),
    summaryZh: toTextOrNull(row["summary_zh"]),
  };
}

async function resolveProjection(
  run: QueryRunner,
  selector: WorkSelector,
): Promise<ProjectionRow | null> {
  // Precedence (fix round 2026-11-16, item 3): work_id WINS when both
  // are set — stated identically in backend/proto/bookstore.proto's
  // GetWorkRequest comment and pinned by a works.test.ts case. (The
  // proto previously claimed book_id wins; the code has always checked
  // workId first, and the frontend only ever passes one.)
  if (selector.workId !== undefined && selector.workId !== 0n) {
    const rows = await run(
      `SELECT ${PROJECTION_COLUMNS} FROM works wk WHERE wk.id = $1`,
      [selector.workId],
    );
    return rows.length === 0 ? null : projectionFromRow(rows[0]);
  }
  if (selector.bookId !== undefined && selector.bookId !== 0n) {
    const rows = await run(
      `SELECT ${PROJECTION_COLUMNS}
       FROM listing_links ll
       JOIN works wk
         ON wk.work_ref_id IS NOT DISTINCT FROM ll.work_ref_id
        AND wk.local_work_id IS NOT DISTINCT FROM ll.local_work_id
       WHERE ll.listing_id = $1`,
      [selector.bookId],
    );
    return rows.length === 0 ? null : projectionFromRow(rows[0]);
  }
  return null;
}

/**
 * The merged work view, or null when the selector names nothing the
 * identity layer knows (no such projection row / the listing is not
 * linked to any work).
 */
export async function getWork(
  run: QueryRunner,
  selector: WorkSelector,
): Promise<GetWorkResponse | null> {
  const projection = await resolveProjection(run, selector);
  if (projection === null) {
    // Known gap (noted in PR #67 review, non-blocking): a listing can
    // be linked (listing_links row exists) while its work has NO
    // projection row in `works` — resolveProjection then finds nothing
    // and GetWork 404s, even though a link exists. The projection is
    // seeded for every reference work (D3-5), so this needs a work
    // linked outside the seeded catalogue; building the projection on
    // demand is later work, not a silent fix here.
    return null;
  }
  const { workRefId, localWorkId } = projection;
  const memberWhere = `
    ll.work_ref_id IS NOT DISTINCT FROM $1
    AND ll.local_work_id IS NOT DISTINCT FROM $2`;

  const offerRows = await run(
    `SELECT b.id AS listing_id, b.store_id AS store_id,
            s.username AS store_name, b.isbn AS isbn,
            b.price AS price, b.stock_quantity AS stock_quantity,
            b.average_rating AS average_rating,
            b.total_sold AS total_sold, b.is_synthetic AS is_synthetic,
            b.categories AS categories, ll.edition_ref_id AS edition_ref_id
     FROM listing_links ll
     JOIN books b ON b.id = ll.listing_id
     JOIN stores s ON s.id = b.store_id
     WHERE ${memberWhere}
     ORDER BY b.price ASC, b.id ASC`,
    [workRefId, localWorkId],
  );
  const offers = offerRows.map((row) =>
    create(WorkOfferSchema, {
      listingId: toBigInt(row["listing_id"]),
      storeId: toBigInt(row["store_id"]),
      storeName: toTextOrNull(row["store_name"]) ?? "",
      isbn: toTextOrNull(row["isbn"]) ?? "",
      price: toNumber(row["price"]),
      stockQuantity: toInt(row["stock_quantity"]),
      averageRating: toNumber(row["average_rating"]),
      totalSold: toInt(row["total_sold"]),
      editionId: toBigInt(row["edition_ref_id"]),
      isSynthetic: row["is_synthetic"] === true,
    }),
  );

  // §4.5 read-time category union: spine categories first, then the
  // member listings' categories in offer order, duplicates removed.
  const categories: string[] = [];
  const seenCategories = new Set<string>();
  const addCategories = (values: string[]) => {
    for (const value of values) {
      if (!seenCategories.has(value)) {
        seenCategories.add(value);
        categories.push(value);
      }
    }
  };
  addCategories(projection.categories);
  for (const row of offerRows) {
    addCategories(toTextList(row["categories"]));
  }

  let editions: GetWorkResponse["editions"] = [];
  if (workRefId !== null) {
    const editionRows = await run(
      `SELECT id, title, publisher, publish_year, language, page_count,
              isbn13
       FROM ref_editions
       WHERE work_ref_id = $1
       ORDER BY publish_year ASC NULLS LAST, id ASC`,
      [workRefId],
    );
    editions = editionRows.map((row) =>
      create(WorkEditionSchema, {
        editionId: toBigInt(row["id"]),
        title: toTextOrNull(row["title"]) ?? "",
        publisher: toTextOrNull(row["publisher"]) ?? "",
        publishYear: toInt(row["publish_year"]),
        language: toTextOrNull(row["language"]) ?? "",
        pageCount: toInt(row["page_count"]),
        isbn13: toTextOrNull(row["isbn13"]) ?? "",
      }),
    );
  }

  const reviewRows = await run(
    `SELECT r.id AS id, r.book_id AS book_id,
            r.customer_id AS customer_id,
            cs.username AS customer_name, r.rating AS rating,
            r.review_text AS review_text, r.created_at AS created_at,
            b.id AS listing_id, s.username AS store_name,
            b.is_synthetic AS is_synthetic,
            ll.edition_ref_id AS edition_ref_id
     FROM reviews r
     JOIN books b ON b.id = r.book_id
     JOIN listing_links ll ON ll.listing_id = b.id
     JOIN stores s ON s.id = b.store_id
     JOIN stores cs ON cs.id = r.customer_id
     WHERE ${memberWhere}
     ORDER BY r.created_at DESC, r.id DESC`,
    [workRefId, localWorkId],
  );
  const reviews = reviewRows.map((row) =>
    create(WorkReviewSchema, {
      review: reviewFromRow(row),
      listingId: toBigInt(row["listing_id"]),
      storeName: toTextOrNull(row["store_name"]) ?? "",
      editionId: toBigInt(row["edition_ref_id"]),
      // §4.4 disclosure at review granularity: a review of a synthetic
      // listing is demo data, and the page badges it + labels the
      // aggregate as including demo reviews (fix round item 12).
      isSynthetic: row["is_synthetic"] === true,
    }),
  );

  const prices = offers.map((o) => o.price);
  return create(GetWorkResponseSchema, {
    workId: projection.id,
    workRefId: workRefId ?? 0n,
    localWorkId: localWorkId ?? 0n,
    title: projection.title,
    authorDisplay: projection.authorDisplay ?? "",
    categories,
    summaryEn: projection.summaryEn ?? "",
    summaryZh: projection.summaryZh ?? "",
    offers,
    editions,
    reviews,
    reviewCount: reviews.length,
    meanRating:
      reviews.length === 0
        ? 0
        : reviews.reduce((sum, r) => sum + (r.review?.rating ?? 0), 0) /
          reviews.length,
    minPrice: prices.length === 0 ? 0 : Math.min(...prices),
    maxPrice: prices.length === 0 ? 0 : Math.max(...prices),
    hasSyntheticListings: offers.some((o) => o.isSynthetic),
  });
}
