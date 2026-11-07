// CustomerService implementation (reads: Route B P1; writes: P3).
// Port of backend/services/customer_service.go.

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";

import { requireIdentity } from "../auth/basic";
import type { QueryRunner, TransactionRunner } from "../db/client";
import {
  addReview,
  checkoutCart,
  getAvailableBooks,
  getBookById,
  getBookReviews,
  getPurchaseHistory,
  purchaseBook,
} from "../db/queries";
import {
  AddReviewResponseSchema,
  CheckoutCartResponseSchema,
  CustomerService,
  Genre,
  GetAvailableBooksResponseSchema,
  GetBookDetailsResponseSchema,
  GetBookReviewsResponseSchema,
  GetPurchaseHistoryResponseSchema,
  PurchaseBookResponseSchema,
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
  begin: TransactionRunner,
): Partial<ServiceImpl<typeof CustomerService>> {
  return {
    async purchaseBook(req, ctx) {
      const identity = requireIdentity(ctx);
      // Go normalises a non-positive quantity to 1 rather than erroring.
      const quantity = req.quantity <= 0 ? 1 : req.quantity;
      try {
        const sale = await purchaseBook(
          run,
          begin,
          req.bookId,
          identity.storeId,
          quantity,
        );
        return create(PurchaseBookResponseSchema, {
          message: `Successfully purchased ${quantity} copy(ies)`,
          sale,
        });
      } catch (err) {
        throw internal(err);
      }
    },

    async checkoutCart(req, ctx) {
      const identity = requireIdentity(ctx);
      if (req.items.length === 0) {
        throw new ConnectError("cart is empty", Code.InvalidArgument);
      }
      // Same per-item quantity normalisation as PurchaseBook (Go).
      const items = req.items.map((item) => ({
        bookId: item.bookId,
        quantity: item.quantity <= 0 ? 1 : item.quantity,
      }));
      try {
        const sales = await checkoutCart(begin, identity.storeId, items);
        return create(CheckoutCartResponseSchema, {
          message: `Successfully checked out ${sales.length} item(s)`,
          sales,
        });
      } catch (err) {
        throw internal(err);
      }
    },

    async addReview(req, ctx) {
      const identity = requireIdentity(ctx);
      // Go validates the rating before touching the database.
      if (req.rating < 1 || req.rating > 5) {
        throw new ConnectError(
          "rating must be between 1 and 5",
          Code.InvalidArgument,
        );
      }
      try {
        const review = await addReview(
          run,
          req.bookId,
          identity.storeId,
          req.rating,
          req.reviewText,
        );
        return create(AddReviewResponseSchema, { review });
      } catch (err) {
        throw internal(err);
      }
    },

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
