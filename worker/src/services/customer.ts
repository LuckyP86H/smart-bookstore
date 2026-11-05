// CustomerService implementation (Route B P1: reads only).
// Port of backend/services/customer_service.go. The write RPCs
// (PurchaseBook, CheckoutCart, AddReview) are P3 scope; they are
// intentionally omitted here, and the Connect router answers them with
// CodeUnimplemented, as ROUTE-B-PLAN §5 P1 specifies.

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";

import { requireIdentity } from "../auth/basic";
import type { QueryRunner } from "../db/client";
import {
  getAvailableBooks,
  getBookById,
  getBookReviews,
  getPurchaseHistory,
} from "../db/queries";
import {
  CustomerService,
  Genre,
  GetAvailableBooksResponseSchema,
  GetBookDetailsResponseSchema,
  GetBookReviewsResponseSchema,
  GetPurchaseHistoryResponseSchema,
  SortOrder,
} from "../gen/bookstore_pb";

/** Mirrors Go's db-error mapping in the customer service: CodeInternal. */
function internal(err: unknown): ConnectError {
  return new ConnectError(
    err instanceof Error ? err.message : String(err),
    Code.Internal,
  );
}

/** Enum value → proto name ("FICTION"), as Go's Enum.String() produces. */
function enumName(table: Record<number, string>, value: number): string {
  return table[value] ?? "";
}

export function createCustomerService(
  run: QueryRunner,
): Partial<ServiceImpl<typeof CustomerService>> {
  return {
    // purchaseBook, checkoutCart, addReview: P3 (router answers Unimplemented).

    async getAvailableBooks(req) {
      // The Go service lowercases the free-text filters before the query
      // layer wraps them in %…% and matches them against LOWER() columns.
      const filter = {
        searchQuery: req.searchQuery.toLowerCase(),
        genreFilter: enumName(Genre, req.genreFilter),
        authorFilter: req.authorFilter.toLowerCase(),
        minPrice: req.minPrice,
        maxPrice: req.maxPrice,
        sortOrder: enumName(SortOrder, req.sortOrder),
        page: req.page,
        pageSize: req.pageSize,
      };
      try {
        const { books, totalCount } = await getAvailableBooks(run, filter);
        return create(GetAvailableBooksResponseSchema, {
          books,
          totalCount,
          // Go echoes the request's raw page/page_size, even when the
          // query layer applied its defaults (page 1 / size 20) — a quirk
          // preserved deliberately for parity.
          page: req.page,
          pageSize: req.pageSize,
        });
      } catch (err) {
        throw internal(err);
      }
    },

    async getBookDetails(req) {
      // The Go service maps every failure of this lookup — missing book or
      // database error alike — to CodeNotFound.
      try {
        const book = await getBookById(run, req.bookId);
        if (book === null) {
          throw new Error("book not found");
        }
        return create(GetBookDetailsResponseSchema, { book });
      } catch (err) {
        throw new ConnectError(
          err instanceof Error ? err.message : String(err),
          Code.NotFound,
        );
      }
    },

    async getBookReviews(req) {
      try {
        const reviews = await getBookReviews(run, req.bookId);
        return create(GetBookReviewsResponseSchema, { reviews });
      } catch (err) {
        throw internal(err);
      }
    },

    async getPurchaseHistory(_req, ctx) {
      const identity = requireIdentity(ctx);
      try {
        const purchases = await getPurchaseHistory(run, identity.storeId);
        return create(GetPurchaseHistoryResponseSchema, { purchases });
      } catch (err) {
        throw internal(err);
      }
    },
  };
}
