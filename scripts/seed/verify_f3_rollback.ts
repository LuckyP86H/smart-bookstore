// Verifies the F3 compensating-run behaviour against the REAL
// database (PR #67 fix round item 14 — the step DEPLOY.md's P3 section
// anticipated: "the unit suite models it; only a real database proves
// it").
//
// The vitest suite proves F3 option C against a transactional STUB.
// This gate step proves it against real Postgres, through the shipped
// linker (worker/src/db/identity.ts, decision D3-10 — no second
// implementation):
//
//   1. Insert a probe listing (a copy of the sold seed listing's
//      honest ISBN/title/author, on the same store) directly, the way
//      the generator inserts fixtures.
//   2. Run linkListingPathA with a transaction runner that FORCES a
//      failure at the listing_links insert — inside the real linker
//      path, after startRun/evidence have already run in-transaction.
//      The transaction therefore genuinely rolls back in Postgres.
//   3. Assert the observable end state in the real tables:
//        - the call rejected with the forced error;
//        - ZERO listing_links rows for the probe listing;
//        - exactly ONE ai_runs row for the probe listing, status
//          'error', finished_at stamped, input/output jsonb OBJECTS
//          (jsonb_typeof), output.compensated = true.
//   4. Delete the probe listing (its ai_runs row survives with
//      listing_id NULL per ON DELETE SET NULL — the ledger record of
//      the attempt, as designed).
//
// Run it the way the gate does (from the repo root):
//   DATABASE_URL=postgres://… npx esbuild scripts/seed/verify_f3_rollback.ts \
//     --bundle --platform=node --format=esm \
//     --outfile=scripts/seed/.verify_f3_rollback.bundle.mjs \
//     && node scripts/seed/.verify_f3_rollback.bundle.mjs

import { createDb, type Db } from "../../worker/src/db/client";
import { linkListingPathA } from "../../worker/src/db/identity";
import type { TransactionRunner } from "../../worker/src/db/client";
import type { Env } from "../../worker/src/env";

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) {
    throw new Error(`verify_f3_rollback: ${label} — ${detail}`);
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
    // Template: an HONEST ISBN'd seed listing (never seed-merchant-c's
    // — its only listing is the lying archetype, whose metadata would
    // demote instead of reaching writeLink) paired with a synthetic
    // store that does not already carry that ISBN (books is unique on
    // (store_id, isbn), and every seed store already carries the hub
    // edition-1 ISBN).
    const sold = await db.run(
      `SELECT src.isbn AS isbn, src.title AS title, src.author AS author,
              s.id AS store_id
       FROM books src
       JOIN stores src_store ON src_store.id = src.store_id
       JOIN stores s ON s.is_synthetic = true
       WHERE src.is_synthetic = true AND src.isbn IS NOT NULL
         AND src_store.username <> 'seed-merchant-c'
         AND NOT EXISTS (
           SELECT 1 FROM books x WHERE x.store_id = s.id AND x.isbn = src.isbn
         )
       ORDER BY src.id, s.id
       LIMIT 1`,
      [],
    );
    if (sold.length !== 1 || typeof sold[0].isbn !== "string") {
      throw new Error(
        "verify_f3_rollback: no honest (isbn, store) template pair found",
      );
    }
    const template = sold[0];
    const inserted = await db.run(
      `INSERT INTO books (store_id, isbn, title, author, genre, publisher,
                          publication_year, page_count, language,
                          cover_image_url, description, price,
                          stock_quantity, is_synthetic)
       VALUES ($1, $2, $3, $4, 'FICTION', '', 0, 0, 'en', '', '', 9.99, 1, true)
       RETURNING id`,
      [template.store_id, template.isbn, template.title, template.author],
    );
    const listingId = BigInt(String(inserted[0].id));
    console.log(`probe listing: ${listingId} (isbn ${String(template.isbn)})`);

    // Force the failure INSIDE the link transaction, at the
    // listing_links insert — the same failure point the unit test
    // forces against its stub.
    const forcingBegin: TransactionRunner = (fn) =>
      db.begin((tx) =>
        fn(async (text, values) => {
          if (text.includes("INSERT INTO listing_links")) {
            throw new Error("gate-forced link failure");
          }
          return tx(text, values);
        }),
      );

    let caught: unknown = null;
    try {
      await linkListingPathA(
        { run: db.run, begin: forcingBegin },
        {
          id: listingId,
          isbn: String(template.isbn),
          title: String(template.title),
          author: String(template.author),
        },
      );
    } catch (err) {
      caught = err;
    }
    check(
      "the linker rejects with the forced error",
      caught instanceof Error && caught.message === "gate-forced link failure",
      String(caught),
    );

    const links = await db.run(
      `SELECT count(*) AS n FROM listing_links WHERE listing_id = $1`,
      [listingId],
    );
    check(
      "zero listing_links persisted after rollback",
      Number(links[0].n) === 0,
      `count=${String(links[0].n)}`,
    );

    const runs = await db.run(
      `SELECT status, finished_at IS NOT NULL AS finished,
              jsonb_typeof(input) AS input_type,
              jsonb_typeof(output) AS output_type,
              output ->> 'compensated' AS compensated
       FROM ai_runs WHERE listing_id = $1`,
      [listingId],
    );
    check(
      "exactly one ai_runs row for the rolled-back attempt",
      runs.length === 1,
      `rows=${runs.length}`,
    );
    const run = runs[0] ?? {};
    check(
      "the compensating run is a finished 'error' run with jsonb-object payloads",
      run.status === "error" &&
        run.finished === true &&
        run.input_type === "object" &&
        run.output_type === "object" &&
        run.compensated === "true",
      JSON.stringify(run),
    );

    await db.run(`DELETE FROM books WHERE id = $1`, [listingId]);
    console.log("RESULT: PASS");
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
