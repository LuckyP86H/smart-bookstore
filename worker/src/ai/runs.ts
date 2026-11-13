// ai_runs observability writes for Route B P4 (PR 2, plan §3.6 / D6).
//
// ai_runs is the only observability record for AI work in P4: every job
// opens a row with startRun when it begins and closes it with finishRun
// when it ends, chaining child work to its parent via parent_run_id.
// Lifecycle: a row starts in the schema-default 'running' state and
// finishRun moves it to exactly one terminal state ('ok' / 'error'),
// stamping finished_at; a job that dies mid-run leaves a visibly
// unfinished 'running' row behind instead of a false 'ok'.
// The functions take the Db shape from db/client.ts so they are
// stub-testable exactly like the queries in db/queries.ts. Column names
// match the ai_runs table in migration 20261111130400_p4_ai_platform.sql:
// id, parent_run_id, kind, provider, model, prompt_id, prompt_version,
// input, output, input_tokens, output_tokens, neurons, status, error,
// listing_id, created_at, finished_at.

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
   * The run's input payload for the jsonb `input` column. Objects are
   * passed to postgres.js as values and stored as jsonb objects —
   * never pre-stringified (see sanitizeJsonValue). Absent or null
   * stores SQL NULL.
   */
  input?: unknown;
}

export interface FinishRunOutcome {
  /**
   * The run's output payload for the jsonb `output` column, passed
   * through like startRun's input. Absent or null stores SQL NULL.
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

/** Placeholder stored where a payload references one of its ancestors. */
const CIRCULAR_PLACEHOLDER = "[Circular]";

/**
 * Prepares a payload for a jsonb column. The value passes through as a
 * VALUE — postgres.js serialises object parameters to JSON itself.
 * (The previous implementation pre-stringified with JSON.stringify;
 * the driver then encoded that string a second time and the column
 * landed as a JSON string scalar wrapping the payload text — the
 * double-encoding the P4 gate work caught in ai_runs rows.)
 *
 * The deep walk exists for the two shapes the driver's own JSON
 * serialisation throws on: BigInt values become their decimal string,
 * and circular references become CIRCULAR_PLACEHOLDER, so recording a
 * run can never throw because of what it is trying to record. Absent
 * or null becomes SQL NULL. A top-level array is rejected: through
 * this seam postgres.js would bind it as a Postgres array, not as
 * jsonb — wrap list payloads in an object instead.
 */
function sanitizeJsonValue(value: unknown, ancestors: Set<object>): QueryValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    // JSON has no NaN/Infinity; the driver would store NULL for them.
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR_PLACEHOLDER;
    ancestors.add(value);
    const items = value.map((item) => sanitizeJsonValue(item, ancestors));
    ancestors.delete(value);
    return items as unknown as QueryValue;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) return CIRCULAR_PLACEHOLDER;
    ancestors.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        continue; // JSON object semantics: such properties are dropped
      }
      out[key] = sanitizeJsonValue(item, ancestors);
    }
    ancestors.delete(value);
    return out;
  }
  // Top-level function/symbol payloads carry no JSON meaning.
  return null;
}

function toJsonParam(value: unknown, field: string): QueryValue {
  const sanitised = sanitizeJsonValue(value, new Set());
  if (Array.isArray(sanitised)) {
    throw new Error(
      `ai_runs: ${field} payload must not be a top-level array — ` +
        `wrap it in an object (postgres.js binds bare arrays as ` +
        `Postgres arrays, not as jsonb)`,
    );
  }
  return sanitised;
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
 * finishRun, and `status` starts at the schema default ('running').
 * The kind is stored as given, but an empty or whitespace-only kind is
 * rejected — a run nobody can name is an observability hole.
 */
export async function startRun(
  db: Db,
  init: StartRunInit,
): Promise<number> {
  if (!init.kind || init.kind.trim().length === 0) {
    throw new Error("startRun: kind is required (a non-empty string)");
  }
  const values: QueryValue[] = [
    init.parentRunId ?? null,
    init.kind,
    init.provider ?? null,
    init.model ?? null,
    init.promptId ?? null,
    init.promptVersion ?? null,
    toJsonParam(init.input, "input"),
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
 * counts, neuron cost, status and error, and stamps finished_at.
 * Unspecified payload/count fields are written as NULL. Only a row
 * still in 'running' state can be finished: a second finishRun throws
 * instead of silently overwriting the recorded outcome (with NULLs,
 * for any field the second call omits), and finishing a run that was
 * never started is likewise a programming error — both surface as the
 * same loud failure, since the UPDATE matches no row either way.
 */
export async function finishRun(
  db: Db,
  id: number,
  outcome: FinishRunOutcome,
): Promise<void> {
  const status: AiRunStatus =
    outcome.status ?? (outcome.error ? "error" : "ok");
  const values: QueryValue[] = [
    toJsonParam(outcome.output, "output"),
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
		SET output = $1, input_tokens = $2, output_tokens = $3, neurons = $4, status = $5, error = $6, finished_at = now()
		WHERE id = $7 AND status = 'running'
		RETURNING id`,
    values,
  );
  if (rows.length === 0) {
    throw new Error(
      `finishRun: no running ai_runs row with id ${id} ` +
        `(the row does not exist or was already finished)`,
    );
  }
}
