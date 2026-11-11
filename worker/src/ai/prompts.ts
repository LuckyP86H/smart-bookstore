// Prompt loading for Route B P4 (PR 2). Prompts live in the `prompts`
// table (migration 20261111130400_p4_ai_platform.sql: id, key, version,
// body, description, created_at; unique (key, version)) so they can be
// revised without a deploy; a run records which prompt id + version it
// used in ai_runs (see runs.ts). Takes the Db shape from db/client.ts
// so it is stub-testable exactly like the queries in db/queries.ts.

import type { Db } from "../db/client";

/** The highest-version prompt row for a key. */
export interface LoadedPrompt {
  id: number;
  key: string;
  version: number;
  body: string;
}

/** postgres.js returns ints as number|string|bigint; normalise. */
function toInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Math.trunc(Number(value));
  return 0;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Loads the highest-version row from `prompts` for `key`. Throws loud
 * when the key is absent: a missing prompt is a programming error,
 * never a silent empty string.
 */
export async function loadPrompt(db: Db, key: string): Promise<LoadedPrompt> {
  const rows = await db.run(
    `
		SELECT id, key, version, body
		FROM prompts
		WHERE key = $1
		ORDER BY version DESC
		LIMIT 1`,
    [key],
  );
  if (rows.length === 0) {
    throw new Error(
      `loadPrompt: no prompt found for key "${key}" — the prompts ` +
        `table has no row with that key`,
    );
  }
  const row = rows[0];
  return {
    id: toInt(row.id),
    key: toText(row.key),
    version: toInt(row.version),
    body: toText(row.body),
  };
}
