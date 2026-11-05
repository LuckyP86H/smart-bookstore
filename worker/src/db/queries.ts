// Port of the read queries in backend/db/database.go (the Go backend stays
// the local runtime; this file is its query-for-query TypeScript mirror —
// see ROUTE-B-PLAN §7). The Worker only ever runs DML, never DDL.
//
// SQL text, joins, filters, sort orders and pagination deliberately match
// the Go originals, including their quirks (documented where they bite).

import { create } from "@bufbuild/protobuf";

import {
  BookSchema,
  Genre,
  ReviewSchema,
  SaleSchema,
  type Book,
  type Review,
  type Sale,
} from "../gen/bookstore_pb";
import type { QueryRow, QueryRunner, QueryValue } from "./client";

// ---------------------------------------------------------------------------
// Row mapping helpers
//
// postgres.js returns int8 as number|string|bigint depending on magnitude,
// `numeric` columns (price, average_rating) as strings, and timestamps as
// Date objects. The mappers normalise defensively so the proto messages
// always carry the types the contract declares.
// ---------------------------------------------------------------------------

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  return 0n;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function toInt(value: unknown): number {
  return Math.trunc(toNumber(value));
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Format a timestamp the way Go's time.Time.Format(time.RFC3339) renders the
 * UTC values lib/pq returns: no fractional part when it is zero, otherwise
 * the fraction with trailing zeros trimmed.
 */
export function formatTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().replace(/\.(\d{3})Z$/, (_m, frac: string) => {
      const trimmed = frac.replace(/0+$/, "");
      return trimmed === "" ? "Z" : `.${trimmed}Z`;
    });
  }
  return toText(value);
}

/** Stored genre strings are proto enum names (Go stores Genre.String()). */
export function genreFromName(name: unknown): Genre {
  if (typeof name === "string") {
    const value = (Genre as unknown as Record<string, unknown>)[name];
    if (typeof value === "number") return value as Genre;
  }
  return Genre.GENRE_UNSPECIFIED;
}

const BOOK_COLUMNS = `
		SELECT b.id, b.store_id, b.isbn, b.title, b.author, b.genre, b.publisher,
			b.publication_year, b.page_count, b.language, b.cover_image_url,
			b.description, b.price, b.stock_quantity, b.total_sold, b.average_rating,
			b.created_at, s.username AS store_name
		FROM books b
		JOIN stores s ON b.store_id = s.id`;

export function bookFromRow(row: QueryRow): Book {
  return create(BookSchema, {
    id: toBigInt(row.id),
    storeId: toBigInt(row.store_id),
    isbn: toText(row.isbn),
    title: toText(row.title),
    author: toText(row.author),
    genre: genreFromName(row.genre),
    publisher: toText(row.publisher),
    publicationYear: toInt(row.publication_year),
    pageCount: toInt(row.page_count),
    language: toText(row.language),
    coverImageUrl: toText(row.cover_image_url),
    description: toText(row.description),
    price: toNumber(row.price),
    stockQuantity: toInt(row.stock_quantity),
    totalSold: toInt(row.total_sold),
    averageRating: toNumber(row.average_rating),
    createdAt: formatTimestamp(row.created_at),
    storeName: toText(row.store_name),
  });
}

export function saleFromRow(row: QueryRow): Sale {
  return create(SaleSchema, {
    id: toBigInt(row.id),
    bookId: toBigInt(row.book_id),
    bookTitle: toText(row.book_title),
    customerId: toBigInt(row.customer_id),
    customerName: toText(row.customer_name),
    quantity: toInt(row.quantity),
    priceAtPurchase: toNumber(row.price_at_purchase),
    purchasedAt: formatTimestamp(row.purchased_at),
  });
}

export function reviewFromRow(row: QueryRow): Review {
  return create(ReviewSchema, {
    id: toBigInt(row.id),
    bookId: toBigInt(row.book_id),
    customerId: toBigInt(row.customer_id),
    customerName: toText(row.customer_name),
    rating: toInt(row.rating),
    reviewText: toText(row.review_text),
    createdAt: formatTimestamp(row.created_at),
  });
}

// ---------------------------------------------------------------------------
// Merchant reads (database.go: GetMerchantBooks, GetSoldBooks, GetLowStockBooks)
// ---------------------------------------------------------------------------

export async function getMerchantBooks(
  run: QueryRunner,
  storeId: bigint,
  includeSoldOut: boolean,
): Promise<Book[]> {
  let query = `${BOOK_COLUMNS}
		WHERE b.store_id = $1`;
  if (!includeSoldOut) {
    query += " AND b.stock_quantity > 0";
  }
  query += " ORDER BY b.created_at DESC";

  const rows = await run(query, [storeId]);
  return rows.map(bookFromRow);
}

export async function getLowStockBooks(
  run: QueryRunner,
  storeId: bigint,
  threshold: number,
): Promise<Book[]> {
  const rows = await run(
    `${BOOK_COLUMNS}
		WHERE b.store_id = $1 AND b.stock_quantity <= $2 AND b.stock_quantity > 0
		ORDER BY b.stock_quantity ASC`,
    [storeId, threshold],
  );
  return rows.map(bookFromRow);
}

const SALE_COLUMNS = `
		SELECT s.id, s.book_id, b.title AS book_title, s.customer_id, st.username AS customer_name,
			s.quantity, s.price_at_purchase, s.purchased_at
		FROM sales s
		JOIN books b ON s.book_id = b.id
		JOIN stores st ON s.customer_id = st.id`;

/**
 * The store's sales, newest first. A null bound leaves that side of the date
 * range open (the $n::timestamp casts type the parameters even when NULL,
 * exactly as in database.go).
 */
export async function getSoldBooks(
  run: QueryRunner,
  storeId: bigint,
  startDate: string | null,
  endDate: string | null,
): Promise<Sale[]> {
  const rows = await run(
    `${SALE_COLUMNS}
		WHERE b.store_id = $1
			AND ($2::timestamp IS NULL OR s.purchased_at >= $2::timestamp)
			AND ($3::timestamp IS NULL OR s.purchased_at <= $3::timestamp)
		ORDER BY s.purchased_at DESC`,
    [storeId, startDate, endDate],
  );
  return rows.map(saleFromRow);
}

// ---------------------------------------------------------------------------
// Customer reads (database.go: GetAvailableBooks, GetBookByID, GetBookReviews,
// GetPurchaseHistory)
// ---------------------------------------------------------------------------

export interface AvailableBooksFilter {
  /** Lowercased by the service layer before it gets here (as in Go). */
  searchQuery: string;
  /** Proto enum name ("FICTION", …); "" or "GENRE_UNSPECIFIED" disables it. */
  genreFilter: string;
  /** Lowercased by the service layer before it gets here (as in Go). */
  authorFilter: string;
  minPrice: number;
  maxPrice: number;
  /** Proto enum name ("PRICE_ASC", …); anything else is the default order. */
  sortOrder: string;
  page: number;
  pageSize: number;
}

export interface AvailableBooksQueries {
  countText: string;
  countValues: QueryValue[];
  pageText: string;
  pageValues: QueryValue[];
}

/**
 * Builds the two statements GetAvailableBooks runs, mirroring database.go's
 * construction step for step: one filtered base query, a COUNT(*) over it as
 * a subquery, then ORDER BY + LIMIT/OFFSET appended for the page query.
 * Pagination defaults match Go: pageSize 0 → 20, page < 1 → 1.
 */
export function buildAvailableBooksQueries(
  filter: AvailableBooksFilter,
): AvailableBooksQueries {
  let query = `${BOOK_COLUMNS}
		WHERE b.stock_quantity > 0`;

  const args: QueryValue[] = [];

  if (filter.searchQuery !== "") {
    args.push(`%${filter.searchQuery}%`);
    query += ` AND (LOWER(b.title) LIKE $${args.length} OR LOWER(b.author) LIKE $${args.length})`;
  }

  if (filter.genreFilter !== "" && filter.genreFilter !== "GENRE_UNSPECIFIED") {
    args.push(filter.genreFilter);
    query += ` AND b.genre = $${args.length}`;
  }

  if (filter.authorFilter !== "") {
    args.push(`%${filter.authorFilter}%`);
    query += ` AND LOWER(b.author) LIKE $${args.length}`;
  }

  if (filter.minPrice > 0) {
    args.push(filter.minPrice);
    query += ` AND b.price >= $${args.length}`;
  }

  if (filter.maxPrice > 0) {
    args.push(filter.maxPrice);
    query += ` AND b.price <= $${args.length}`;
  }

  const countText = `SELECT COUNT(*) AS total FROM (${query}) AS filtered`;

  switch (filter.sortOrder) {
    case "PRICE_ASC":
      query += " ORDER BY b.price ASC";
      break;
    case "PRICE_DESC":
      query += " ORDER BY b.price DESC";
      break;
    case "TITLE_ASC":
      query += " ORDER BY b.title ASC";
      break;
    case "TITLE_DESC":
      query += " ORDER BY b.title DESC";
      break;
    case "RATING_DESC":
      query += " ORDER BY b.average_rating DESC";
      break;
    case "PUBLICATION_YEAR_DESC":
      query += " ORDER BY b.publication_year DESC";
      break;
    default:
      query += " ORDER BY b.created_at DESC";
      break;
  }

  const pageSize = filter.pageSize === 0 ? 20 : filter.pageSize;
  const page = filter.page < 1 ? 1 : filter.page;
  const offset = (page - 1) * pageSize;

  const pageValues: QueryValue[] = [...args, pageSize, offset];
  query += ` LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`;

  return { countText, countValues: args, pageText: query, pageValues };
}

export async function getAvailableBooks(
  run: QueryRunner,
  filter: AvailableBooksFilter,
): Promise<{ books: Book[]; totalCount: number }> {
  const { countText, countValues, pageText, pageValues } =
    buildAvailableBooksQueries(filter);

  const countRows = await run(countText, countValues);
  const totalCount = countRows.length > 0 ? toInt(countRows[0].total) : 0;

  const rows = await run(pageText, pageValues);
  return { books: rows.map(bookFromRow), totalCount };
}

export async function getBookById(
  run: QueryRunner,
  bookId: bigint,
): Promise<Book | null> {
  const rows = await run(
    `${BOOK_COLUMNS}
		WHERE b.id = $1`,
    [bookId],
  );
  return rows.length > 0 ? bookFromRow(rows[0]) : null;
}

export async function getBookReviews(
  run: QueryRunner,
  bookId: bigint,
): Promise<Review[]> {
  const rows = await run(
    `
		SELECT r.id, r.book_id, r.customer_id, s.username AS customer_name, r.rating,
			r.review_text, r.created_at
		FROM reviews r
		JOIN stores s ON r.customer_id = s.id
		WHERE r.book_id = $1
		ORDER BY r.created_at DESC`,
    [bookId],
  );
  return rows.map(reviewFromRow);
}

export async function getPurchaseHistory(
  run: QueryRunner,
  customerId: bigint,
): Promise<Sale[]> {
  const rows = await run(
    `${SALE_COLUMNS}
		WHERE s.customer_id = $1
		ORDER BY s.purchased_at DESC`,
    [customerId],
  );
  return rows.map(saleFromRow);
}
