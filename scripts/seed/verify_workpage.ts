// Verifies the real GetWork RPC against the seeded gate database
// (plan §8, PR 3 gate step 8).
//
// Drives CustomerService/GetWork through the production router
// (serveConnectRequest) with the fixture credential double — the same
// seam the vitest suites use — but against the REAL seeded Postgres:
// the hub work that the seed generator built must come back merged:
// offers from multiple synthetic stores, its catalogue editions, the
// sold listing's review rolled up with store attribution, exact
// aggregate denominators, and the synthetic disclosure flag set.
//
// Run it the way the gate does (from the repo root):
//   DATABASE_URL=postgres://… npx esbuild scripts/seed/verify_workpage.ts \
//     --bundle --platform=node --format=esm \
//     --outfile=scripts/seed/.verify_workpage.bundle.mjs \
//     && node scripts/seed/.verify_workpage.bundle.mjs

import { createTestDoubleCredentialChecker } from "../../worker/src/auth/test-double";
import { serveConnectRequest } from "../../worker/src/connect-app";
import { createDb, type Db } from "../../worker/src/db/client";
import type { Env } from "../../worker/src/env";

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) {
    throw new Error(`verify_workpage: ${label} — ${detail}`);
  }
  console.log(`PASS: ${label}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("ERROR: set DATABASE_URL");
    process.exit(2);
  }
  const env = {
    HYPERDRIVE: { connectionString: databaseUrl },
  } as unknown as Env;
  const db: Db = createDb(env);
  try {
    const sold = await db.run(
      `SELECT id, title FROM books
       WHERE is_synthetic = true AND total_sold = 1`,
      [],
    );
    if (sold.length !== 1) {
      throw new Error(
        `verify_workpage: expected exactly one sold seed listing, got ${sold.length}`,
      );
    }
    const bookId = String(sold[0].id);

    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "authorization",
      `Basic ${btoa("customer:password")}`,
    );
    const request = new Request(
      "https://worker.test/bookstore.v1.CustomerService/GetWork",
      { method: "POST", headers, body: JSON.stringify({ bookId }) },
    );
    const response = await serveConnectRequest(request, env, db.run, {
      checker: createTestDoubleCredentialChecker(),
      begin: db.begin,
    });
    check("GetWork responds 200", response.status === 200,
      `status ${response.status}`);
    const work = (await response.json()) as {
      [key: string]: any;
    };

    check("work is the hub work", work.title === String(sold[0].title),
      `title ${JSON.stringify(work.title)}`);
    const offers = work.offers as { [key: string]: any }[];
    check("offers merged across the hub's listings", offers.length >= 3,
      `${offers.length} offers`);
    const stores = new Set(offers.map((o) => o.storeName));
    check("offers span multiple stores", stores.size >= 2,
      [...stores].join(", "));
    check("every offer discloses synthetic",
      offers.every((o) => o.isSynthetic === true),
      JSON.stringify(offers.map((o) => o.isSynthetic)));
    check("hasSyntheticListings is set", work.hasSyntheticListings === true,
      String(work.hasSyntheticListings));

    const editions = work.editions as unknown[];
    check("editions present from the catalogue", editions.length >= 3,
      `${editions.length} editions`);

    const reviews = work.reviews as { [key: string]: any }[];
    check("review rolled up from the sold listing",
      reviews.length === 1 && work.reviewCount === 1,
      `reviews=${reviews.length} reviewCount=${work.reviewCount}`);
    check("review keeps its store attribution",
      reviews[0]?.storeName === "seed-merchant-a",
      String(reviews[0]?.storeName));
    check("mean rating has the exact denominator",
      work.meanRating === 5 && reviews[0]?.review?.rating === 5,
      `mean=${work.meanRating}`);

    const prices = offers.map((o) => Number(o.price));
    check("price spread matches the offers",
      work.minPrice === Math.min(...prices) &&
        work.maxPrice === Math.max(...prices),
      `min=${work.minPrice} max=${work.maxPrice}`);
    console.log("RESULT: PASS");
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
