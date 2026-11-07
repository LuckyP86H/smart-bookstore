// Write-RPC parity suite (Route B P3). Drives the real Connect app
// (interceptor + services + query layer) against an in-memory fake that
// implements exactly the statements the write queries issue, with
// transaction semantics modelled on Postgres: BEGIN blocks are
// serialised (as the row locks in PurchaseBook / CheckoutCart serialise
// contenders), a throw restores the pre-transaction snapshot, and reads
// outside a transaction see committed state only.
//
// The fake is deliberately faithful about the things parity depends on —
// statement outcomes, row shapes, stock arithmetic — and silent about
// the rest. The same scenarios against a real Postgres (and the Go
// backend) are the parity harness's job on the owner's machine.

import { describe, expect, it } from "vitest";

import { createTestDoubleCredentialChecker } from "./auth/test-double";
import { serveConnectRequest } from "./connect-app";
import type {
  QueryRow,
  QueryRunner,
  QueryValue,
  TransactionRunner,
} from "./db/client";
import type { Env } from "./env";

const ENV = { GOOGLE_BOOKS_API_KEY: undefined } as unknown as Env;

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

interface BookRow {
  id: bigint;
  store_id: bigint;
  isbn: string;
  title: string;
  author: string;
  genre: string;
  publisher: string;
  publication_year: number;
  page_count: number;
  language: string;
  cover_image_url: string;
  description: string;
  price: number;
  stock_quantity: number;
  total_sold: number;
  average_rating: number;
  created_at: Date;
}

interface SaleRow {
  id: bigint;
  book_id: bigint;
  customer_id: bigint;
  quantity: number;
  price_at_purchase: number;
  purchased_at: Date;
}

interface ReviewRow {
  id: bigint;
  book_id: bigint;
  customer_id: bigint;
  rating: number;
  review_text: string;
  created_at: Date;
}

interface FakeState {
  stores: Map<bigint, string>;
  books: Map<bigint, BookRow>;
  sales: SaleRow[];
  reviews: Map<string, ReviewRow>;
  nextBookId: bigint;
  nextSaleId: bigint;
  nextReviewId: bigint;
}

const FIXED_NOW = new Date("2026-11-05T12:00:00Z");

function seedState(): FakeState {
  const state: FakeState = {
    stores: new Map([
      [1n, "merchant1"],
      [2n, "merchant2"],
      [3n, "customer"],
    ]),
    books: new Map(),
    sales: [],
    reviews: new Map(),
    nextBookId: 100n,
    nextSaleId: 1n,
    nextReviewId: 1n,
  };
  const book = (partial: Partial<BookRow> & { id: bigint }): void => {
    state.books.set(partial.id, {
      store_id: 1n,
      isbn: "",
      title: "",
      author: "",
      genre: "GENRE_UNSPECIFIED",
      publisher: "",
      publication_year: 0,
      page_count: 0,
      language: "",
      cover_image_url: "",
      description: "",
      price: 0,
      stock_quantity: 0,
      total_sold: 0,
      average_rating: 0,
      created_at: FIXED_NOW,
      ...partial,
    });
  };
  book({
    id: 1n,
    isbn: "9780441172719",
    title: "Dune",
    author: "Frank Herbert",
    genre: "SCIENCE_FICTION",
    price: 10.5,
    stock_quantity: 2,
  });
  book({
    id: 2n,
    store_id: 2n,
    isbn: "9780000000002",
    title: "Other Store Book",
    price: 20,
    stock_quantity: 5,
  });
  book({
    id: 3n,
    isbn: "9780000000003",
    title: "Rare Book",
    price: 99,
    stock_quantity: 1,
  });
  return state;
}

function createFakeDb(): {
  run: QueryRunner;
  begin: TransactionRunner;
  state: FakeState;
  statements: string[];
} {
  let state = seedState();
  const statements: string[] = [];

  function bookReadRow(b: BookRow): QueryRow {
    return {
      ...b,
      store_name: state.stores.get(b.store_id) ?? "",
    };
  }

  function execute(text: string, values: QueryValue[]): QueryRow[] {
    statements.push(text);
    const v = values as unknown[];

    if (text.includes("INSERT INTO books")) {
      const [
        storeId, isbn, title, author, genre, publisher, year, pages,
        language, cover, description, price, stock,
      ] = v;
      for (const existing of state.books.values()) {
        if (
          String(existing.store_id) === String(storeId) &&
          existing.isbn === String(isbn)
        ) {
          Object.assign(existing, {
            title: String(title),
            author: String(author),
            genre: String(genre),
            publisher: String(publisher),
            publication_year: Number(year),
            page_count: Number(pages),
            language: String(language),
            cover_image_url: String(cover),
            description: String(description),
            price: Number(price),
            stock_quantity: Number(stock),
          });
          return [{ ...existing }];
        }
      }
      const row: BookRow = {
        id: state.nextBookId++,
        store_id: BigInt(String(storeId)),
        isbn: String(isbn),
        title: String(title),
        author: String(author),
        genre: String(genre),
        publisher: String(publisher),
        publication_year: Number(year),
        page_count: Number(pages),
        language: String(language),
        cover_image_url: String(cover),
        description: String(description),
        price: Number(price),
        stock_quantity: Number(stock),
        total_sold: 0,
        average_rating: 0,
        created_at: FIXED_NOW,
      };
      state.books.set(row.id, row);
      return [{ ...row }];
    }

    if (text.includes("FROM stores WHERE id")) {
      const username = state.stores.get(BigInt(String(v[0])));
      return username === undefined ? [] : [{ username }];
    }

    if (text.includes("SELECT EXISTS(SELECT 1 FROM sales")) {
      if (text.includes("customer_id=$2")) {
        const found = state.sales.some(
          (s) =>
            String(s.book_id) === String(v[0]) &&
            String(s.customer_id) === String(v[1]),
        );
        return [{ has_purchased: found }];
      }
      const found = state.sales.some((s) => String(s.book_id) === String(v[0]));
      return [{ has_sales: found }];
    }

    if (text.includes("DELETE FROM books")) {
      const book = state.books.get(BigInt(String(v[0])));
      if (book !== undefined && String(book.store_id) === String(v[1])) {
        state.books.delete(book.id);
        return [{ id: book.id }];
      }
      return [];
    }

    if (
      text.includes("UPDATE books") &&
      text.includes("stock_quantity = stock_quantity + $1")
    ) {
      const book = state.books.get(BigInt(String(v[1])));
      if (book === undefined || String(book.store_id) !== String(v[2])) {
        return [];
      }
      book.stock_quantity += Number(v[0]);
      return [{ ...book }];
    }

    if (text.includes("FOR UPDATE")) {
      const book = state.books.get(BigInt(String(v[0])));
      if (book === undefined) return [];
      return [
        {
          stock_quantity: book.stock_quantity,
          price: book.price,
          title: book.title,
        },
      ];
    }

    if (text.includes("stock_quantity = stock_quantity - $1")) {
      const book = state.books.get(BigInt(String(v[1])));
      if (book !== undefined) {
        book.stock_quantity -= Number(v[0]);
        book.total_sold += Number(v[0]);
      }
      return [];
    }

    if (text.includes("INSERT INTO sales")) {
      const row: SaleRow = {
        id: state.nextSaleId++,
        book_id: BigInt(String(v[0])),
        customer_id: BigInt(String(v[1])),
        quantity: Number(v[2]),
        price_at_purchase: Number(v[3]),
        purchased_at: FIXED_NOW,
      };
      state.sales.push(row);
      return [{ id: row.id, purchased_at: row.purchased_at }];
    }

    if (text.includes("INSERT INTO reviews")) {
      const key = `${String(v[0])}:${String(v[1])}`;
      const existing = state.reviews.get(key);
      if (existing !== undefined) {
        existing.rating = Number(v[2]);
        existing.review_text = String(v[3]);
        existing.created_at = FIXED_NOW;
        return [{ ...existing }];
      }
      const row: ReviewRow = {
        id: state.nextReviewId++,
        book_id: BigInt(String(v[0])),
        customer_id: BigInt(String(v[1])),
        rating: Number(v[2]),
        review_text: String(v[3]),
        created_at: FIXED_NOW,
      };
      state.reviews.set(key, row);
      return [{ ...row }];
    }

    if (text.includes("UPDATE books") && text.includes("average_rating")) {
      const book = state.books.get(BigInt(String(v[0])));
      if (book !== undefined) {
        const ratings = [...state.reviews.values()]
          .filter((r) => String(r.book_id) === String(v[0]))
          .map((r) => r.rating);
        book.average_rating =
          ratings.length === 0
            ? 0
            : ratings.reduce((a, b) => a + b, 0) / ratings.length;
      }
      return [];
    }

    if (text.includes("FROM books b")) {
      let books = [...state.books.values()];
      if (text.includes("WHERE b.id = $1")) {
        books = books.filter((b) => String(b.id) === String(v[0]));
      } else if (text.includes("WHERE b.store_id = $1")) {
        books = books.filter((b) => String(b.store_id) === String(v[0]));
        if (text.includes("stock_quantity <= $2")) {
          books = books.filter(
            (b) => b.stock_quantity <= Number(v[1]) && b.stock_quantity > 0,
          );
          books.sort((a, b2) => a.stock_quantity - b2.stock_quantity);
        } else {
          if (text.includes("AND b.stock_quantity > 0")) {
            books = books.filter((b) => b.stock_quantity > 0);
          }
          books.sort(
            (a, b2) => b2.created_at.getTime() - a.created_at.getTime(),
          );
        }
      }
      return books.map(bookReadRow);
    }

    if (text.includes("FROM reviews r")) {
      return [...state.reviews.values()]
        .filter((r) => String(r.book_id) === String(v[0]))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map((r) => ({
          ...r,
          customer_name: state.stores.get(r.customer_id) ?? "",
        }));
    }

    if (text.includes("FROM sales s")) {
      return state.sales
        .filter((s) => String(s.customer_id) === String(v[0]))
        .map((s) => ({
          id: s.id,
          book_id: s.book_id,
          book_title: state.books.get(s.book_id)?.title ?? "",
          customer_id: s.customer_id,
          customer_name: state.stores.get(s.customer_id) ?? "",
          quantity: s.quantity,
          price_at_purchase: s.price_at_purchase,
          purchased_at: s.purchased_at,
        }));
    }

    throw new Error(`fake db: unhandled statement: ${text.slice(0, 120)}`);
  }

  const run: QueryRunner = async (text, values) => execute(text, values);

  // Serialised transactions over a snapshot: a throw restores the
  // snapshot (rollback); queued transactions wait (the row-lock effect).
  let tail: Promise<unknown> = Promise.resolve();
  const begin: TransactionRunner = (fn) => {
    const result = tail.then(async () => {
      const snapshot = structuredClone(state);
      try {
        return await fn(run);
      } catch (err) {
        state = snapshot;
        throw err;
      }
    });
    tail = result.catch(() => undefined);
    return result;
  };

  return {
    run,
    begin,
    get state() {
      return state;
    },
    statements,
  };
}

// ---------------------------------------------------------------------------
// RPC driver
// ---------------------------------------------------------------------------

const MERCHANT = ["merchant1", "password1"] as const;
const MERCHANT2 = ["merchant2", "password2"] as const;
const CUSTOMER = ["customer", "password"] as const;

function rpc(
  service: string,
  method: string,
  body: unknown,
  auth?: readonly [string, string],
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (auth !== undefined) {
    headers.set("authorization", `Basic ${btoa(`${auth[0]}:${auth[1]}`)}`);
  }
  return new Request(`https://worker.test/bookstore.v1.${service}/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

type Fake = ReturnType<typeof createFakeDb>;

async function call(
  fake: Fake,
  request: Request,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await serveConnectRequest(request, ENV, fake.run, {
    checker: createTestDoubleCredentialChecker(),
    begin: fake.begin,
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, any>),
  };
}

// ---------------------------------------------------------------------------
// Merchant writes
// ---------------------------------------------------------------------------

describe("AddBook", () => {
  it("creates a book scoped to the caller's store, with store_name", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc(
        "MerchantService",
        "AddBook",
        {
          isbn: "9781234567897",
          title: "New Book",
          author: "An Author",
          genre: "FICTION",
          price: 15,
          stockQuantity: 4,
        },
        MERCHANT,
      ),
    );
    expect(status).toBe(200);
    expect(json.book.title).toBe("New Book");
    expect(json.book.storeName).toBe("merchant1");
    expect(json.book.storeId).toBe("1");
    expect(json.book.genre).toBe("FICTION");
    expect(json.book.stockQuantity).toBe(4);
    expect(fake.state.books.size).toBe(4);
  });

  it("upserts on (store, isbn): id and total_sold survive a re-add", async () => {
    const fake = createFakeDb();
    // Give book 1 a sale first so total_sold is non-zero.
    await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 1 }, CUSTOMER),
    );
    const before = fake.state.books.get(1n);
    expect(before?.total_sold).toBe(1);

    const { status, json } = await call(
      fake,
      rpc(
        "MerchantService",
        "AddBook",
        {
          isbn: "9780441172719",
          title: "Dune (Revised)",
          author: "Frank Herbert",
          genre: "SCIENCE_FICTION",
          price: 12,
          stockQuantity: 9,
        },
        MERCHANT,
      ),
    );
    expect(status).toBe(200);
    expect(json.book.id).toBe("1");
    expect(json.book.title).toBe("Dune (Revised)");
    expect(json.book.price).toBe(12);
    expect(json.book.stockQuantity).toBe(9);
    expect(json.book.totalSold).toBe(1);
    expect(fake.state.books.size).toBe(3);
  });

  it("denies customers (403) and anonymous callers (401) before any SQL", async () => {
    const fake = createFakeDb();
    const denied = await call(
      fake,
      rpc("MerchantService", "AddBook", { title: "X" }, CUSTOMER),
    );
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe("permission_denied");

    const anon = await call(fake, rpc("MerchantService", "AddBook", { title: "X" }));
    expect(anon.status).toBe(401);
    expect(anon.json.code).toBe("unauthenticated");
    expect(fake.statements).toHaveLength(0);
  });
});

describe("RemoveBook", () => {
  it("removes the caller's own unsold book", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("MerchantService", "RemoveBook", { bookId: "3" }, MERCHANT),
    );
    expect(status).toBe(200);
    expect(json.message).toBe("Book successfully removed");
    expect(fake.state.books.has(3n)).toBe(false);
  });

  it("refuses another store's book with Go's error", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("MerchantService", "RemoveBook", { bookId: "2" }, MERCHANT),
    );
    expect(status).toBe(500);
    expect(json.code).toBe("internal");
    expect(json.message).toBe("book not found or unauthorized");
    expect(fake.state.books.has(2n)).toBe(true);
  });

  it("refuses a book with sales history", async () => {
    const fake = createFakeDb();
    await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 1 }, CUSTOMER),
    );
    const { status, json } = await call(
      fake,
      rpc("MerchantService", "RemoveBook", { bookId: "1" }, MERCHANT),
    );
    expect(status).toBe(500);
    expect(json.message).toBe("cannot delete book with sales history");
    expect(fake.state.books.has(1n)).toBe(true);
  });
});

describe("UpdateStock", () => {
  it("applies positive and negative deltas and returns the book", async () => {
    const fake = createFakeDb();
    const up = await call(
      fake,
      rpc("MerchantService", "UpdateStock", { bookId: "1", quantityToAdd: 5 }, MERCHANT),
    );
    expect(up.status).toBe(200);
    expect(up.json.book.stockQuantity).toBe(7);
    expect(up.json.book.storeName).toBe("merchant1");

    const down = await call(
      fake,
      rpc("MerchantService", "UpdateStock", { bookId: "1", quantityToAdd: -2 }, MERCHANT),
    );
    expect(down.json.book.stockQuantity).toBe(5);
  });

  it("maps a missing or foreign book to Go's internal error", async () => {
    const fake = createFakeDb();
    for (const bookId of ["999999", "2"]) {
      const { status, json } = await call(
        fake,
        rpc("MerchantService", "UpdateStock", { bookId, quantityToAdd: 1 }, MERCHANT),
      );
      expect(status).toBe(500);
      expect(json.code).toBe("internal");
      expect(json.message).toBe("book not found or unauthorized");
    }
    // merchant2 CAN update its own book 2.
    const own = await call(
      fake,
      rpc("MerchantService", "UpdateStock", { bookId: "2", quantityToAdd: 1 }, MERCHANT2),
    );
    expect(own.status).toBe(200);
    expect(own.json.book.stockQuantity).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Customer writes
// ---------------------------------------------------------------------------

describe("PurchaseBook", () => {
  it("decrements stock, counts the sale, and returns the full Sale", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 2 }, CUSTOMER),
    );
    expect(status).toBe(200);
    expect(json.message).toBe("Successfully purchased 2 copy(ies)");
    expect(json.sale.bookTitle).toBe("Dune");
    expect(json.sale.customerName).toBe("customer");
    expect(json.sale.customerId).toBe("3");
    expect(json.sale.quantity).toBe(2);
    expect(json.sale.priceAtPurchase).toBe(10.5);
    const book = fake.state.books.get(1n);
    expect(book?.stock_quantity).toBe(0);
    expect(book?.total_sold).toBe(2);
    expect(fake.state.sales).toHaveLength(1);
  });

  it("normalises quantity 0 to 1, as Go does", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 0 }, CUSTOMER),
    );
    expect(status).toBe(200);
    expect(json.message).toBe("Successfully purchased 1 copy(ies)");
    expect(json.sale.quantity).toBe(1);
  });

  it("maps a missing book to internal 'book not found'", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "999999", quantity: 1 }, CUSTOMER),
    );
    expect(status).toBe(500);
    expect(json.code).toBe("internal");
    expect(json.message).toBe("book not found");
    expect(fake.state.sales).toHaveLength(0);
  });

  it("refuses oversell with Go's message and leaves no trace", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "3", quantity: 2 }, CUSTOMER),
    );
    expect(status).toBe(500);
    expect(json.message).toBe("insufficient stock: only 1 available");
    expect(fake.state.books.get(3n)?.stock_quantity).toBe(1);
    expect(fake.state.sales).toHaveLength(0);
  });

  it("lets merchants purchase too (Go's only gate is customers → MerchantService)", async () => {
    const fake = createFakeDb();
    const { status } = await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 1 }, MERCHANT),
    );
    expect(status).toBe(200);
  });

  it("10 parallel purchases of a stock-1 book yield exactly 1 sale", async () => {
    const fake = createFakeDb();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        call(
          fake,
          rpc("CustomerService", "PurchaseBook", { bookId: "3", quantity: 1 }, CUSTOMER),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status === 500);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const f of failed) {
      expect(f.json.message).toBe("insufficient stock: only 0 available");
    }
    expect(fake.state.books.get(3n)?.stock_quantity).toBe(0);
    expect(fake.state.sales).toHaveLength(1);
  });
});

describe("CheckoutCart", () => {
  it("checks out multiple items in one transaction", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc(
        "CustomerService",
        "CheckoutCart",
        { items: [{ bookId: "1", quantity: 1 }, { bookId: "3", quantity: 1 }] },
        CUSTOMER,
      ),
    );
    expect(status).toBe(200);
    expect(json.message).toBe("Successfully checked out 2 item(s)");
    expect(json.sales).toHaveLength(2);
    expect(json.sales[0].bookTitle).toBe("Dune");
    expect(json.sales[1].bookTitle).toBe("Rare Book");
    expect(fake.state.books.get(1n)?.stock_quantity).toBe(1);
    expect(fake.state.books.get(3n)?.stock_quantity).toBe(0);
    expect(fake.state.sales).toHaveLength(2);
  });

  it("rejects an empty cart as invalid_argument before any SQL", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc("CustomerService", "CheckoutCart", { items: [] }, CUSTOMER),
    );
    expect(status).toBe(400);
    expect(json.code).toBe("invalid_argument");
    expect(json.message).toBe("cart is empty");
    expect(fake.statements).toHaveLength(0);
  });

  it("rolls back EVERYTHING when a later item cannot be fulfilled", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc(
        "CustomerService",
        "CheckoutCart",
        { items: [{ bookId: "1", quantity: 1 }, { bookId: "3", quantity: 2 }] },
        CUSTOMER,
      ),
    );
    expect(status).toBe(500);
    expect(json.message).toBe(
      "insufficient stock for book 'Rare Book': only 1 available",
    );
    // The first item's decrement and sale were rolled back with the rest.
    expect(fake.state.books.get(1n)?.stock_quantity).toBe(2);
    expect(fake.state.books.get(1n)?.total_sold).toBe(0);
    expect(fake.state.sales).toHaveLength(0);
  });

  it("names a missing book by id and rolls back", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc(
        "CustomerService",
        "CheckoutCart",
        { items: [{ bookId: "1", quantity: 1 }, { bookId: "999999", quantity: 1 }] },
        CUSTOMER,
      ),
    );
    expect(status).toBe(500);
    expect(json.message).toBe("book 999999 not found");
    expect(fake.state.books.get(1n)?.stock_quantity).toBe(2);
    expect(fake.state.sales).toHaveLength(0);
  });

  it("normalises a zero-quantity item to 1", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc(
        "CustomerService",
        "CheckoutCart",
        { items: [{ bookId: "1", quantity: 0 }] },
        CUSTOMER,
      ),
    );
    expect(status).toBe(200);
    expect(json.sales[0].quantity).toBe(1);
  });
});

describe("AddReview", () => {
  it("rejects out-of-range ratings before any SQL (Go's order)", async () => {
    const fake = createFakeDb();
    for (const rating of [0, 6]) {
      const { status, json } = await call(
        fake,
        rpc(
          "CustomerService",
          "AddReview",
          { bookId: "1", rating, reviewText: "x" },
          CUSTOMER,
        ),
      );
      expect(status).toBe(400);
      expect(json.code).toBe("invalid_argument");
      expect(json.message).toBe("rating must be between 1 and 5");
    }
    expect(fake.statements).toHaveLength(0);
  });

  it("refuses a review for a book the caller has not purchased", async () => {
    const fake = createFakeDb();
    const { status, json } = await call(
      fake,
      rpc(
        "CustomerService",
        "AddReview",
        { bookId: "1", rating: 5, reviewText: "Great" },
        CUSTOMER,
      ),
    );
    expect(status).toBe(500);
    expect(json.code).toBe("internal");
    expect(json.message).toBe("you can only review books you have purchased");
  });

  it("accepts a verified purchase, refreshes the average, upserts on repeat", async () => {
    const fake = createFakeDb();
    await call(
      fake,
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 1 }, CUSTOMER),
    );
    const first = await call(
      fake,
      rpc(
        "CustomerService",
        "AddReview",
        { bookId: "1", rating: 4, reviewText: "Good" },
        CUSTOMER,
      ),
    );
    expect(first.status).toBe(200);
    expect(first.json.review.customerName).toBe("customer");
    expect(first.json.review.rating).toBe(4);
    expect(fake.state.books.get(1n)?.average_rating).toBe(4);

    const second = await call(
      fake,
      rpc(
        "CustomerService",
        "AddReview",
        { bookId: "1", rating: 2, reviewText: "Meh" },
        CUSTOMER,
      ),
    );
    expect(second.status).toBe(200);
    // Upsert: same review row, updated in place — still exactly one review.
    expect(second.json.review.id).toBe(first.json.review.id);
    expect(second.json.review.rating).toBe(2);
    expect(fake.state.reviews.size).toBe(1);
    expect(fake.state.books.get(1n)?.average_rating).toBe(2);
  });
});

describe("transaction wiring", () => {
  it("fails loudly (never silently non-atomically) when begin is not wired", async () => {
    const fake = createFakeDb();
    const response = await serveConnectRequest(
      rpc("CustomerService", "PurchaseBook", { bookId: "1", quantity: 1 }, CUSTOMER),
      ENV,
      fake.run,
      { checker: createTestDoubleCredentialChecker() },
    );
    expect(response.status).toBe(500);
    const json = (await response.json()) as Record<string, any>;
    expect(json.code).toBe("internal");
    expect(json.message).toContain("not available");
    expect(fake.state.sales).toHaveLength(0);
  });
});
