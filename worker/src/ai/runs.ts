// ai_runs observability writes for Route B P4 (PR 2, plan §3.6 / D6).
//
// ai_runs is the only observability record for AI work in P4: every job
// opens a row with startRun when it begins and closes it with finishRun
// when it ends, chaining child work to its parent via parent_run_id.
// The functions take the Db shape from db/client.ts so they are
// stub-testable exactly like the queries in db/queries.ts. Column names
// match the ai_runs table in migration 20261111130400_p4_ai_platform.sql:
// id, parent_run_id, kind, provider, model, prompt_id, prompt_version,
// input, output, input_tokens, output_tokens, neurons, status, error,
// listing_id, created_at.

import type { Db, QueryValue } from "../db/client";

/** The only two terminal states an ai_runs row can be finished into. */
export type AiRunStatus = "ok" | "error";

export interface StartRunInit {
  /** What kind of AI work this run is (required; e.g. "embed_listing"). */
  kind: string;
  provider?: string | null;
  model?: string | null;
  /** prompts.id of the prompt this run used, when it used one. */
  promptId?: number | bigint | null;
  promptVersion?: number | null;
  /** ai_runs.id of the enclosing run, for chained/child work. */
  parentRunId?: number | bigint | null;
  /** books.id (the listing) this run is about, when it is about one. */
  listingId?: number | bigint | null;
  /**
   * The run's input payload, stored in the jsonb `input` column
   * serialised to JSON. Absent or null stores SQL NULL.
   */
  input?: unknown;
}

export interface FinishRunOutcome {
  /**
   * The run's output payload, stored in the jsonb `output` column
   * serialised to JSON. Absent or null stores SQL NULL.
   */
  output?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Workers AI neuron cost of the run, when the provider reports it. */
  neurons?: number | null;
  /**
   * Terminal status. Defaults to "ok", or to "error" when `error` is
   * given and no explicit status is.
   */
  status?: AiRunStatus;
  error?: string | null;
}

/** Serialises a jsonb payload; absent/null becomes SQL NULL. */
function toJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const serialised = JSON.stringify(value);
  return serialised === undefined ? null : serialised;
}

/** postgres.js returns int8 ids as number|string|bigint; normalise. */
function toId(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  throw new Error(`ai_runs: unexpected id value ${String(value)}`);
}

/**
 * Inserts a new ai_runs row and returns its id. Only the identifying
 * columns are written; output, token counts and neurons land later via
 * finishRun, and `status` starts at the schema default ('ok').
 */
export async function startRun(
  db: Db,
  init: StartRunInit,
): Promise<number> {
  if (!init.kind) {
    throw new Error("startRun: kind is required");
  }
  const values: QueryValue[] = [
    init.parentRunId ?? null,
    init.kind,
    init.provider ?? null,
    init.model ?? null,
    init.promptId ?? null,
    init.promptVersion ?? null,
    toJsonValue(init.input),
    init.listingId ?? null,
  ];
  const rows = await db.run(
    `
		INSERT INTO ai_runs (parent_run_id, kind, provider, model, prompt_id, prompt_version, input, listing_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id`,
    values,
  );
  if (rows.length === 0) {
    throw new Error("startRun: INSERT INTO ai_runs returned no id");
  }
  return toId(rows[0].id);
}

/**
 * Closes the ai_runs row `id` with its outcome: output payload, token
 * counts, neuron cost, status and error. Unspecified payload/count
 * fields are written as NULL. Throws loud when no row carries `id` —
 * finishing a run that was never started is a programming error.
 */
export async function finishRun(
  db: Db,
  id: number,
  outcome: FinishRunOutcome,
): Promise<void> {
  const status: AiRunStatus =
    outcome.status ?? (outcome.error ? "error" : "ok");
  const values: QueryValue[] = [
    toJsonValue(outcome.output),
    outcome.inputTokens ?? null,
    outcome.outputTokens ?? null,
    outcome.neurons ?? null,
    status,
    outcome.error ?? null,
    id,
  ];
  const rows = await db.run(
    `
		UPDATE ai_runs
		SET output = $1, input_tokens = $2, output_tokens = $3, neurons = $4, status = $5, error = $6
		WHERE id = $7
		RETURNING id`,
    values,
  );
  if (rows.length === 0) {
    throw new Error(`finishRun: no ai_runs row with id ${id}`);
  }
}
