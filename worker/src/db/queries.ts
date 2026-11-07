// Port of the queries in backend/db/database.go (the Go backend stays
// the local runtime; this file is its query-for-query TypeScript mirror —
// see ROUTE-B-PLAN §7). Reads landed in P1, writes in P3. The Worker only
// ever runs DML, never DDL.
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
import type {
  QueryRow,
  QueryRunner,
  QueryValue,
  TransactionRunner,
} from "./client";

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

// ---------------------------------------------------------------------------
// Merchant writes (database.go: CreateBook, DeleteBook, UpdateStock)
//
// Go fills Book.store_name with a follow-up `SELECT username FROM stores`
// whose error it deliberately ignores (the Scan result is unchecked), so
// the helpers below do the same: a failed lookup leaves store_name "".
// ---------------------------------------------------------------------------

/** Column list shared by CreateBook's and UpdateStock's RETURNING clauses. */
const BOOK_RETURNING = `
		RETURNING id, store_id, isbn, title, author, genre, publisher, publication_year,
			page_count, language, cover_image_url, description, price, stock_quantity,
			total_sold, average_rating, created_at`;

/**
 * Looks up a store's username (the value every Book.store_name carries),
 * swallowing any error exactly as the Go write paths do.
 */
async function storeNameLookup(
  run: QueryRunner,
  storeId: unknown,
): Promise<string> {
  try {
    const rows = await run("SELECT username FROM stores WHERE id = $1", [
      storeId as QueryValue,
    ]);
    return rows.length > 0 ? toText(rows[0].username) : "";
  } catch {
    return "";
  }
}

export interface CreateBookInput {
  isbn: string;
  title: string;
  author: string;
  /** Proto enum name ("FICTION", …), as Go's Genre.String() produces. */
  genre: string;
  publisher: string;
  publicationYear: number;
  pageCount: number;
  language: string;
  coverImageUrl: string;
  description: string;
  price: number;
  stockQuantity: number;
}

/**
 * Upsert on (store_id, isbn): re-adding an ISBN the store already carries
 * updates the row in place, preserving id, total_sold, average_rating and
 * created_at (database.go CreateBook).
 */
export async function createBook(
  run: QueryRunner,
  storeId: bigint,
  input: CreateBookInput,
): Promise<Book> {
  const rows = await run(
    `
		INSERT INTO books (store_id, isbn, title, author, genre, publisher, publication_year,
			page_count, language, cover_image_url, description, price, stock_quantity)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (store_id, isbn) DO UPDATE SET
			title = EXCLUDED.title,
			author = EXCLUDED.author,
			genre = EXCLUDED.genre,
			publisher = EXCLUDED.publisher,
			publication_year = EXCLUDED.publication_year,
			page_count = EXCLUDED.page_count,
			language = EXCLUDED.language,
			cover_image_url = EXCLUDED.cover_image_url,
			description = EXCLUDED.description,
			price = EXCLUDED.price,
			stock_quantity = EXCLUDED.stock_quantity${BOOK_RETURNING}`,
    [
      storeId,
      input.isbn,
      input.title,
      input.author,
      input.genre,
      input.publisher,
      input.publicationYear,
      input.pageCount,
      input.language,
      input.coverImageUrl,
      input.description,
      input.price,
      input.stockQuantity,
    ],
  );
  const row = rows[0];
  const storeName = await storeNameLookup(run, row.store_id);
  return bookFromRow({ ...row, store_name: storeName });
}

/**
 * Deletes one of the caller's own books. A book with any sales history is
 * undeletable, and the ownership predicate sits in the DELETE itself:
 * another store's id deletes nothing and reports the same error as a
 * missing book (database.go DeleteBook). Go reads RowsAffected from its
 * Exec; the RETURNING id list gives the same count signal here.
 */
export async function deleteBook(
  run: QueryRunner,
  bookId: bigint,
  storeId: bigint,
): Promise<void> {
  const existsRows = await run(
    "SELECT EXISTS(SELECT 1 FROM sales WHERE book_id=$1) AS has_sales",
    [bookId],
  );
  if (existsRows.length > 0 && existsRows[0].has_sales === true) {
    throw new Error("cannot delete book with sales history");
  }

  const deleted = await run(
    "DELETE FROM books WHERE id = $1 AND store_id = $2 RETURNING id",
    [bookId, storeId],
  );
  if (deleted.length === 0) {
    throw new Error("book not found or unauthorized");
  }
}

/**
 * Applies a signed stock delta to one of the caller's own books and
 * returns the updated row (database.go UpdateStock). A book the caller
 * does not own is indistinguishable from a missing one.
 */
export async function updateStock(
  run: QueryRunner,
  bookId: bigint,
  storeId: bigint,
  quantityToAdd: number,
): Promise<Book> {
  const rows = await run(
    `
		UPDATE books
		SET stock_quantity = stock_quantity + $1
		WHERE id = $2 AND store_id = $3${BOOK_RETURNING}`,
    [quantityToAdd, bookId, storeId],
  );
  if (rows.length === 0) {
    throw new Error("book not found or unauthorized");
  }
  const row = rows[0];
  const storeName = await storeNameLookup(run, row.store_id);
  return bookFromRow({ ...row, store_name: storeName });
}

// ---------------------------------------------------------------------------
// Customer writes (database.go: PurchaseBook, CheckoutCart, AddReview)
// ---------------------------------------------------------------------------

/** The columns PurchaseBook / CheckoutCart lock and read per item. */
const BOOK_FOR_UPDATE =
  "SELECT stock_quantity, price, title FROM books WHERE id = $1 FOR UPDATE";

const SALE_INSERT = `
		INSERT INTO sales (book_id, customer_id, quantity, price_at_purchase)
		VALUES ($1, $2, $3, $4)
		RETURNING id, purchased_at`;

/** Builds a Sale message from parts, the way database.go assembles db.Sale. */
function saleFromParts(parts: {
  id: unknown;
  bookId: bigint;
  bookTitle: string;
  customerId: bigint;
  customerName: string;
  quantity: number;
  priceAtPurchase: number;
  purchasedAt: unknown;
}): Sale {
  return create(SaleSchema, {
    id: toBigInt(parts.id),
    bookId: parts.bookId,
    bookTitle: parts.bookTitle,
    customerId: parts.customerId,
    customerName: parts.customerName,
    quantity: parts.quantity,
    priceAtPurchase: parts.priceAtPurchase,
    purchasedAt: formatTimestamp(parts.purchasedAt),
  });
}

/**
 * Buys `quantity` copies of one book in a single transaction: lock the
 * row (SELECT … FOR UPDATE), check stock, decrement + count the sale,
 * insert the sale row — any failure rolls the whole thing back
 * (database.go PurchaseBook). Mirroring Go, the customer-name lookup runs
 * after the commit, on the caller's connection, with its error ignored.
 */
export async function purchaseBook(
  run: QueryRunner,
  begin: TransactionRunner,
  bookId: bigint,
  customerId: bigint,
  quantity: number,
): Promise<Sale> {
  const bought = await begin(async (tx) => {
    const rows = await tx(BOOK_FOR_UPDATE, [bookId]);
    if (rows.length === 0) {
      throw new Error("book not found");
    }
    const stock = toInt(rows[0].stock_quantity);
    const price = toNumber(rows[0].price);
    const title = toText(rows[0].title);
    if (stock < quantity) {
      throw new Error(`insufficient stock: only ${stock} available`);
    }

    await tx(
      "UPDATE books SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2",
      [quantity, bookId],
    );
    const saleRows = await tx(SALE_INSERT, [bookId, customerId, quantity, price]);
    return { saleRow: saleRows[0], price, title };
  });

  const customerName = await storeNameLookup(run, customerId);
  return saleFromParts({
    id: bought.saleRow.id,
    bookId,
    bookTitle: bought.title,
    customerId,
    customerName,
    quantity,
    priceAtPurchase: bought.price,
    purchasedAt: bought.saleRow.purchased_at,
  });
}

export interface CartItemInput {
  bookId: bigint;
  quantity: number;
}

/**
 * The multi-item purchase, in ONE transaction: each item is locked,
 * checked, decremented and recorded in request order, and any item
 * failing rolls back every earlier item — partial checkouts never happen
 * (database.go CheckoutCart). Mirroring Go, the customer-name lookup runs
 * per item, inside the transaction, with its error ignored.
 */
export async function checkoutCart(
  begin: TransactionRunner,
  customerId: bigint,
  items: CartItemInput[],
): Promise<Sale[]> {
  return begin(async (tx) => {
    const sales: Sale[] = [];
    for (const item of items) {
      const rows = await tx(BOOK_FOR_UPDATE, [item.bookId]);
      if (rows.length === 0) {
        throw new Error(`book ${item.bookId} not found`);
      }
      const stock = toInt(rows[0].stock_quantity);
      const price = toNumber(rows[0].price);
      const title = toText(rows[0].title);
      if (stock < item.quantity) {
        throw new Error(
          `insufficient stock for book '${title}': only ${stock} available`,
        );
      }

      await tx(
        "UPDATE books SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2",
        [item.quantity, item.bookId],
      );
      const saleRows = await tx(SALE_INSERT, [
        item.bookId,
        customerId,
        item.quantity,
        price,
      ]);
      const customerName = await storeNameLookup(tx, customerId);
      sales.push(
        saleFromParts({
          id: saleRows[0].id,
          bookId: item.bookId,
          bookTitle: title,
          customerId,
          customerName,
          quantity: item.quantity,
          priceAtPurchase: price,
          purchasedAt: saleRows[0].purchased_at,
        }),
      );
    }
    return sales;
  });
}

/**
 * Adds (or, on the (book_id, customer_id) conflict, updates) the caller's
 * review of a book they have purchased, then refreshes the book's average
 * rating (database.go AddReview). Not transactional in Go and not here:
 * the rating refresh and the name lookup deliberately ignore their
 * errors, exactly as the Go code discards them.
 */
export async function addReview(
  run: QueryRunner,
  bookId: bigint,
  customerId: bigint,
  rating: number,
  reviewText: string,
): Promise<Review> {
  const purchasedRows = await run(
    "SELECT EXISTS(SELECT 1 FROM sales WHERE book_id=$1 AND customer_id=$2) AS has_purchased",
    [bookId, customerId],
  );
  if (purchasedRows.length === 0 || purchasedRows[0].has_purchased !== true) {
    throw new Error("you can only review books you have purchased");
  }

  const rows = await run(
    `
		INSERT INTO reviews (book_id, customer_id, rating, review_text)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (book_id, customer_id)
		DO UPDATE SET rating = $3, review_text = $4, created_at = NOW()
		RETURNING id, book_id, customer_id, rating, review_text, created_at`,
    [bookId, customerId, rating, reviewText],
  );

  // Fire-and-forget in Go (the Exec error is discarded); a failed refresh
  // must not fail the review.
  try {
    await run(
      `
		UPDATE books
		SET average_rating = (SELECT AVG(rating) FROM reviews WHERE book_id = $1)
		WHERE id = $1`,
      [bookId],
    );
  } catch {
    // ignored, as in Go
  }

  const row = rows[0];
  const customerName = await storeNameLookup(run, customerId);
  return reviewFromRow({ ...row, customer_name: customerName });
}
