// Data-access plumbing for the Worker: a postgres.js client built from the
// Hyperdrive binding, exposed to the query layer as a minimal runner so the
// queries can be unit-tested with a stub.
//
// Hyperdrive pools connections on its side, so a fresh client per request is
// the documented pattern (same as the P0 proof route in dev/hyperdrive-proof).

import postgres from "postgres";

import type { Env } from "../env";

/** A single SQL parameter value. */
// P4: string[]/bigint[] added for the identity store's array columns
// (listing_facets.author_keys, identity_events.evidence_ids) —
// postgres.js binds JS arrays to Postgres arrays natively. Plain
// objects added for jsonb columns (ai_runs input/output, evidence
// bands, identity_events states/manifest): postgres.js serialises an
// object parameter to JSON itself, while a pre-stringified JSON
// string is encoded AGAIN and lands as a JSON string scalar — the
// double-encoding the P4 gate work caught in ai_runs payloads and
// the PR 3 gate caught in evidence (see PR3-BUILD-LOG D3-18). Pass
// objects, never strings, for jsonb parameters through this seam.
// (Rebase 2026-11-15: the merged base and PR 3 each widened this type
// with Record<string, unknown> for the same reason; converged here
// to exactly one copy, keeping PR 3's array members.)
export type QueryValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | string[]
  | bigint[]
  | Record<string, unknown>;

/** One result row, keyed by column name (aliases in queries.ts apply). */
export type QueryRow = Record<string, unknown>;

/**
 * Runs one parameterised statement ($1, $2, … placeholders, exactly the SQL
 * shape the Go backend uses) and resolves with its rows.
 */
export type QueryRunner = (text: string, values: QueryValue[]) => Promise<QueryRow[]>;

/**
 * Runs `fn` inside a real database transaction (postgres.js `sql.begin`):
 * the transaction commits when `fn` resolves and rolls back when it
 * throws. The runner handed to `fn` is bound to the transaction's
 * connection, so every statement it issues joins the transaction. P0
 * proved BEGIN…COMMIT behaves through Hyperdrive + the session pooler;
 * PurchaseBook / CheckoutCart (P3) are the consumers, mirroring the `tx`
 * blocks in backend/db/database.go.
 */
export type TransactionRunner = <T>(
  fn: (txRun: QueryRunner) => Promise<T>,
) => Promise<T>;

export interface Db {
  run: QueryRunner;
  begin: TransactionRunner;
  close: () => Promise<void>;
}

export function createDb(env: Env): Db {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
  });
  return {
    run: async (text, values) =>
      (await sql.unsafe(text, [...values])) as QueryRow[],
    begin: async (fn) =>
      sql.begin(async (tx) =>
        fn(
          async (text, values) =>
            (await tx.unsafe(text, [...values])) as QueryRow[],
        ),
      ),
    close: () => sql.end({ timeout: 5 }),
  };
}
