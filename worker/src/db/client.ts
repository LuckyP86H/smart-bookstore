// Data-access plumbing for the Worker: a postgres.js client built from the
// Hyperdrive binding, exposed to the query layer as a minimal runner so the
// queries can be unit-tested with a stub.
//
// Hyperdrive pools connections on its side, so a fresh client per request is
// the documented pattern (same as the P0 proof route in dev/hyperdrive-proof).

import postgres from "postgres";

import type { Env } from "../env";

/** A single SQL parameter value. */
export type QueryValue = string | number | bigint | boolean | Date | null;

/** One result row, keyed by column name (aliases in queries.ts apply). */
export type QueryRow = Record<string, unknown>;

/**
 * Runs one parameterised statement ($1, $2, … placeholders, exactly the SQL
 * shape the Go backend uses) and resolves with its rows.
 */
export type QueryRunner = (text: string, values: QueryValue[]) => Promise<QueryRow[]>;

export interface Db {
  run: QueryRunner;
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
    close: () => sql.end({ timeout: 5 }),
  };
}
