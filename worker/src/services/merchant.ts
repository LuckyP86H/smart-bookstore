// MerchantService implementation (Route B P1: reads only).
// Port of backend/services/merchant_service.go. The write RPCs
// (AddBook, RemoveBook, UpdateStock) are P3 scope; they are intentionally
// omitted here, and the Connect router answers them with
// CodeUnimplemented, as ROUTE-B-PLAN §5 P1 specifies.

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";

import { requireIdentity } from "../auth/basic";
import type { QueryRunner } from "../db/client";
import {
  getLowStockBooks,
  getMerchantBooks,
  getSoldBooks,
} from "../db/queries";
import {
  BookNotFoundError,
  lookupBookByISBN,
} from "../external/google-books";
import { InvalidISBNError, normalizeISBN } from "../external/isbn";
import {
  GetLowStockBooksResponseSchema,
  GetMerchantBooksResponseSchema,
  GetSoldBooksResponseSchema,
  LookupBookByISBNResponseSchema,
  MerchantService,
} from "../gen/bookstore_pb";

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

export function createMerchantService(
  run: QueryRunner,
  googleBooksApiKey: string | undefined,
): Partial<ServiceImpl<typeof MerchantService>> {
  return {
    // addBook, removeBook, updateStock: P3 (router answers Unimplemented).

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

      try {
        const info = await lookupBookByISBN(isbn, { apiKey: googleBooksApiKey });
        return create(LookupBookByISBNResponseSchema, {
          title: info.title,
          author: info.author,
          publisher: info.publisher,
          publicationYear: info.publicationYear,
          pageCount: info.pageCount,
          description: info.description,
          coverImageUrl: info.coverImageUrl,
          categories: info.categories,
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
