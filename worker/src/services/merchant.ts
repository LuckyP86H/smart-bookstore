// MerchantService implementation (reads: Route B P1; writes: P3).
// Port of backend/services/merchant_service.go.

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";

import { requireIdentity } from "../auth/basic";
import type { QueryRunner, TransactionRunner } from "../db/client";
import { linkListingPathA, lookupLocalPrefill } from "../db/identity";
import {
  createBook,
  deleteBook,
  getLowStockBooks,
  getMerchantBooks,
  getSoldBooks,
  updateStock,
} from "../db/queries";
import {
  BookNotFoundError,
  lookupBookByISBN,
} from "../external/google-books";
import { InvalidISBNError, normalizeISBN } from "../external/isbn";
import {
  lookupOlBookInfo,
  type OlBookInfo,
  type OlEditionInfo,
} from "../external/open-library";
import { canonicalISBN13 } from "../identity/isbn13";
import {
  AddBookResponseSchema,
  Genre,
  GetLowStockBooksResponseSchema,
  GetMerchantBooksResponseSchema,
  GetSoldBooksResponseSchema,
  LookupBookByISBNResponseSchema,
  MerchantService,
  RemoveBookResponseSchema,
  UpdateStockResponseSchema,
} from "../gen/bookstore_pb";

/** Enum value → proto name ("FICTION"), as Go's Enum.String() produces. */
function enumName(table: Record<number, string>, value: number): string {
  return table[value] ?? "";
}

/** Mirrors Go's db-error mapping in the merchant service: CodeInternal. */
function internal(err: unknown): ConnectError {
  return new ConnectError(
    err instanceof Error ? err.message : String(err),
    Code.Internal,
  );
}

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an RFC 3339 timestamp filter, mirroring Go's parseOptionalTime.
 * Proto3 has no null for strings, so an empty value means the bound is
 * unset (returns null). The parsed instant is returned as an ISO string
 * for the query layer's ::timestamp parameters.
 */
export function parseOptionalTime(field: string, value: string): string | null {
  if (value === "") {
    return null;
  }
  const match = RFC3339_PATTERN.exec(value);
  const instant = match ? new Date(value) : new Date(Number.NaN);
  // Reject the strings Date would silently normalise (e.g. Feb 30) by
  // round-tripping the calendar fields for UTC ("Z") inputs.
  const fieldsValid =
    match !== null &&
    (match[8] !== "Z" ||
      (instant.getUTCFullYear() === Number(match[1]) &&
        instant.getUTCMonth() + 1 === Number(match[2]) &&
        instant.getUTCDate() === Number(match[3]) &&
        instant.getUTCHours() === Number(match[4]) &&
        instant.getUTCMinutes() === Number(match[5]) &&
        instant.getUTCSeconds() === Number(match[6])));
  if (match === null || Number.isNaN(instant.getTime()) || !fieldsValid) {
    throw new ConnectError(
      `invalid ${field}: expected RFC 3339, e.g. 2026-01-02T15:04:05Z`,
      Code.InvalidArgument,
    );
  }
  return instant.toISOString();
}

/**
 * Optional P4 wiring. When `identity` is present, AddBook runs one
 * Path A pass over the new listing after the (P3-parity) upsert. When
 * it is absent (unit tests, tooling), AddBook behaves exactly as it
 * did at P3. `fetchFn` injects the HTTP implementation for the
 * prefill lookups, as in the external clients' own options.
 */
export interface MerchantServiceDeps {
  identity?: {
    begin: TransactionRunner;
    lookupEdition?: (isbn13: string) => Promise<OlEditionInfo | null>;
  };
  /**
   * The throttled + memoised Open Library prefill lookup
   * (createOpenLibraryBookInfoLookup: ≤3 req/s, 10-minute cache,
   * negatives included). Production wiring (connect-app.ts) always
   * supplies the shared per-isolate instance — LookupBookByISBN is a
   * PUBLIC endpoint, and calling the raw lookupOlBookInfo from it
   * would let a burst get the Worker's egress IP rate-limited by OL
   * and break the Path A fallback too (PR #67 fix round item 2). When
   * absent (unit seams), the raw lookup is used with `fetchFn`.
   */
  lookupBookInfo?: (isbn13: string) => Promise<OlBookInfo | null>;
  fetchFn?: typeof fetch;
}

export function createMerchantService(
  run: QueryRunner,
  googleBooksApiKey: string | undefined,
  deps: MerchantServiceDeps = {},
): Partial<ServiceImpl<typeof MerchantService>> {
  return {
    async addBook(req, ctx) {
      const identity = requireIdentity(ctx);
      try {
        const book = await createBook(run, identity.storeId, {
          isbn: req.isbn,
          title: req.title,
          author: req.author,
          genre: enumName(Genre, req.genre),
          publisher: req.publisher,
          publicationYear: req.publicationYear,
          pageCount: req.pageCount,
          language: req.language,
          coverImageUrl: req.coverImageUrl,
          description: req.description,
          price: req.price,
          stockQuantity: req.stockQuantity,
        });
        // Path A (§3.1): link the listing to its work, join-only, AFTER
        // the upsert. Linking is derived data — a failure here must
        // never fail the AddBook the merchant already succeeded at.
        if (deps.identity !== undefined && book !== undefined) {
          try {
            await linkListingPathA(
              {
                run,
                begin: deps.identity.begin,
                lookupEdition: deps.identity.lookupEdition,
              },
              {
                id: book.id,
                isbn: req.isbn,
                title: req.title,
                author: req.author,
              },
            );
          } catch (err) {
            console.log(
              `Path A linking failed for listing ${book.id}:`,
              err,
            );
          }
        }
        return create(AddBookResponseSchema, { book });
      } catch (err) {
        throw internal(err);
      }
    },

    async removeBook(req, ctx) {
      const identity = requireIdentity(ctx);
      try {
        await deleteBook(run, req.bookId, identity.storeId);
        return create(RemoveBookResponseSchema, {
          message: "Book successfully removed",
        });
      } catch (err) {
        throw internal(err);
      }
    },

    async updateStock(req, ctx) {
      const identity = requireIdentity(ctx);
      try {
        const book = await updateStock(
          run,
          req.bookId,
          identity.storeId,
          req.quantityToAdd,
        );
        return create(UpdateStockResponseSchema, { book });
      } catch (err) {
        throw internal(err);
      }
    },

    async getMerchantBooks(req, ctx) {
      const identity = requireIdentity(ctx);
      try {
        const books = await getMerchantBooks(run, identity.storeId, req.includeSoldOut);
        return create(GetMerchantBooksResponseSchema, { books });
      } catch (err) {
        throw internal(err);
      }
    },

    async getSoldBooks(req, ctx) {
      const identity = requireIdentity(ctx);
      const startDate = parseOptionalTime("start_date", req.startDate);
      const endDate = parseOptionalTime("end_date", req.endDate);
      if (startDate !== null && endDate !== null && startDate > endDate) {
        throw new ConnectError(
          "start_date must not be after end_date",
          Code.InvalidArgument,
        );
      }
      try {
        const sales = await getSoldBooks(run, identity.storeId, startDate, endDate);
        return create(GetSoldBooksResponseSchema, { sales });
      } catch (err) {
        throw internal(err);
      }
    },

    async getLowStockBooks(req, ctx) {
      const identity = requireIdentity(ctx);
      const threshold = req.threshold === 0 ? 5 : req.threshold;
      try {
        const books = await getLowStockBooks(run, identity.storeId, threshold);
        return create(GetLowStockBooksResponseSchema, { books });
      } catch (err) {
        throw internal(err);
      }
    },

    // Public endpoint (see auth/basic.ts PUBLIC_PROCEDURES): validate
    // strictly, since the ISBN is embedded in an upstream search query,
    // and never echo upstream errors to unauthenticated callers.
    // The §4.6 prefill, in the data rule's order (§4.1): the local
    // ISBN index first, then one Open Library lookup, then live Google
    // Books. Google is a transient display source only — its
    // description and cover are flagged *_transient so the form shows
    // them with attribution but never submits them (its Terms §5(e)
    // forbids persisting them), and it is never an identity source.
    // The endpoint stays public, exactly as at P1.
    async lookupBookByISBN(req) {
      let isbn: string;
      try {
        isbn = normalizeISBN(req.isbn);
      } catch (err) {
        if (err instanceof InvalidISBNError) {
          throw new ConnectError(err.message, Code.InvalidArgument);
        }
        throw err;
      }
      const isbn13 = canonicalISBN13(isbn) ?? isbn;

      // 1. Local ISBN index — the seeded catalogue already knows it.
      try {
        const local = await lookupLocalPrefill(run, isbn13);
        if (local !== null) {
          return create(LookupBookByISBNResponseSchema, {
            title: local.title,
            author: local.author,
            publisher: local.publisher,
            publicationYear: local.publicationYear,
            pageCount: local.pageCount,
            description: "",
            // §4.5: OL covers are linked, never stored or proxied.
            coverImageUrl: `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`,
            categories: local.categories,
            source: "local_index",
            attribution: "",
            descriptionTransient: false,
            coverTransient: false,
          });
        }
      } catch (err) {
        console.log(`Local ISBN prefill for ${isbn13} failed:`, err);
      }

      // 2. Open Library — open data, attributed, submittable. Routed
      // through the shared throttled + memoised lookup when wired
      // (production always wires it; see MerchantServiceDeps).
      try {
        const ol =
          deps.lookupBookInfo !== undefined
            ? await deps.lookupBookInfo(isbn13)
            : await lookupOlBookInfo(isbn13, { fetchFn: deps.fetchFn });
        if (ol !== null) {
          return create(LookupBookByISBNResponseSchema, {
            title: ol.title,
            author: ol.author,
            publisher: ol.publisher,
            publicationYear: ol.publicationYear,
            pageCount: ol.pageCount,
            description: ol.description,
            coverImageUrl: ol.coverImageUrl,
            categories: ol.categories,
            source: "open_library",
            attribution: "Open Library",
            descriptionTransient: false,
            coverTransient: false,
          });
        }
      } catch (err) {
        console.log(`Open Library prefill for ${isbn13} failed:`, err);
      }

      // 3. Google Books — transient display only (see header comment).
      try {
        const info = await lookupBookByISBN(isbn, {
          apiKey: googleBooksApiKey,
          fetchFn: deps.fetchFn,
        });
        return create(LookupBookByISBNResponseSchema, {
          title: info.title,
          author: info.author,
          publisher: info.publisher,
          publicationYear: info.publicationYear,
          pageCount: info.pageCount,
          description: info.description,
          coverImageUrl: info.coverImageUrl,
          categories: info.categories,
          source: "google_books",
          attribution:
            "Data from Google Books — for reference only; the description and cover are not saved with the book.",
          descriptionTransient: true,
          coverTransient: true,
        });
      } catch (err) {
        if (err instanceof BookNotFoundError) {
          throw new ConnectError(err.message, Code.NotFound);
        }
        console.log(`ISBN lookup for ${isbn} failed:`, err);
        throw new ConnectError(
          "book lookup service unavailable",
          Code.Unavailable,
        );
      }
    },
  };
}
