// Links the synthetic seed listings with the Worker's own Path A code
// (plan Step 3/4, decision D3-10).
//
// The seed generator inserts books rows directly (fixtures, like PR
// 2's SQL), which bypasses AddBook — so nothing has linked them. This
// script runs the shipped linker (worker/src/db/identity.ts) over
// every synthetic listing that has no link yet, exactly as AddBook
// would have at add time. There is deliberately no second linking
// implementation: what the gate proves here is the production code
// path, end to end, against a real database.
//
// The Open Library fallback is NOT wired here (no lookupEdition):
// every seed ISBN is in the loaded index by construction, and a seed
// run must be deterministic and offline.
//
// Re-run behaviour (PR #67 fix round item 7): the linker is safe to
// re-run. Listings that already have a listing_links row are skipped
// by the selection, and — the guard this round adds — so are listings
// that already have EVIDENCE for their current ISBN: a demoted
// (rejected) or ambiguous (proposed) listing has no link row, so the
// old selection re-ran Path A over it and inserted a FRESH evidence
// row every time. A listing's stored ISBN never changes in the seed
// flow, so "already has evidence" means "Path A already attempted
// this exact ISBN" and re-running must not duplicate the lineage.
// Listings whose previous attempt produced no evidence at all
// (no_candidate / invalid / no ISBN) wrote nothing and are harmless
// to retry, so they stay in the selection.
//
// Run it the way the gate does (from the repo root):
//   DATABASE_URL=postgres://… npx esbuild scripts/seed/link_seed.ts \
//     --bundle --platform=node --format=esm \
//     --outfile=scripts/seed/.link_seed.bundle.mjs \
//     && node scripts/seed/.link_seed.bundle.mjs

import { createDb, type Db } from "../../worker/src/db/client";
import { linkListingPathA } from "../../worker/src/db/identity";
import type { Env } from "../../worker/src/env";

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
    const skipped = await db.run(
      `SELECT count(*) AS n
       FROM books b
       LEFT JOIN listing_links ll ON ll.listing_id = b.id
       WHERE b.is_synthetic = true AND ll.listing_id IS NULL
         AND EXISTS (SELECT 1 FROM evidence e WHERE e.listing_id = b.id)`,
      [],
    );
    const skippedCount = Number(skipped[0]?.n ?? 0);
    if (skippedCount > 0) {
      console.log(
        `link_seed: skipping ${skippedCount} unlinked listing(s) that already have evidence (re-run guard)`,
      );
    }
    const rows = await db.run(
      `SELECT b.id, b.isbn, b.title, b.author
       FROM books b
       LEFT JOIN listing_links ll ON ll.listing_id = b.id
       WHERE b.is_synthetic = true AND ll.listing_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.listing_id = b.id)
       ORDER BY b.id`,
      [],
    );
    let linked = 0;
    let demoted = 0;
    let other = 0;
    for (const row of rows) {
      const listing = {
        id: BigInt(String(row.id)),
        isbn: typeof row.isbn === "string" ? row.isbn : "",
        title: String(row.title ?? ""),
        author: String(row.author ?? ""),
      };
      const outcome = await linkListingPathA(
        { run: db.run, begin: db.begin },
        listing,
      );
      if (outcome.status === "linked") linked += 1;
      else if (outcome.status === "demoted") demoted += 1;
      else other += 1;
      console.log(
        `listing ${listing.id}: isbn=${listing.isbn || "(none)"} -> ${outcome.status}`,
      );
    }
    console.log(
      `link_seed: processed=${rows.length} linked=${linked} demoted=${demoted} other=${other}`,
    );
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
