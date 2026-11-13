// Workers AI text embeddings for Route B P4 (PR 2, plan §6 / D-R10).
//
// The embedding model id is configuration, never code: it is read from
// the EMBEDDING_MODEL var (wrangler.jsonc) on every call, and this module
// throws loud when it is missing instead of falling back to a hardcoded
// model. What code *does* pin is the dimension: the P4 reference
// columns this module feeds store halfvec(1024) (PR 2 migrations), so
// every vector the model returns is asserted to be exactly
// EMBEDDING_DIMENSIONS long, and a model whose output disagrees fails
// here, at the boundary, rather than at insert time deep inside a job.
// Scope note: the legacy books.embedding column is NOT one of those
// columns — it stays vector(384), is owned by the Python ai-service,
// and this module never writes it; its switch to 1024 is deferred to
// the P5 ai-service migration (see 20261111130400's header).

import type { Env } from "../env";

/**
 * The embedding dimension of the P4 reference schema (ref_works stores
 * halfvec(1024)). A returned vector of any other length is a
 * configuration error (wrong EMBEDDING_MODEL). The legacy
 * books.embedding column stays at 384 under the Python ai-service and
 * is out of this module's scope — see the file header.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** The slice of the Worker environment embedTexts needs. */
export type EmbeddingEnv = Pick<Env, "AI" | "EMBEDDING_MODEL">;

export interface EmbedTextsResult {
  /** The model id the vectors came from (the configured EMBEDDING_MODEL). */
  model: string;
  /** One vector per input text, in input order; each is 1024 numbers. */
  vectors: number[][];
}

/**
 * Embeds `texts` with the configured Workers AI model and returns the
 * vectors. Throws loud when EMBEDDING_MODEL is unset/empty, when the
 * response is not the documented `{ shape, data }` text-embeddings
 * shape, when the vector count differs from the input count, or when any
 * vector is not exactly EMBEDDING_DIMENSIONS long.
 */
export async function embedTexts(
  env: EmbeddingEnv,
  texts: string[],
): Promise<EmbedTextsResult> {
  const model = env.EMBEDDING_MODEL?.trim();
  if (!model) {
    throw new Error(
      "EMBEDDING_MODEL is not configured: the Workers AI embedding model " +
        "id must be set via the EMBEDDING_MODEL var (wrangler.jsonc); " +
        "it is configuration, not code, so there is no fallback model",
    );
  }

  // Workers AI text-embeddings call. `model` is a runtime string (it
  // comes from configuration), so Ai.run resolves through its
  // unknown-model overload and the result is validated defensively
  // below rather than trusted from the type.
  const raw: unknown = await env.AI.run(model, { text: texts });

  if (raw === null || typeof raw !== "object") {
    throw new Error(
      `Workers AI embedding response from model "${model}" is malformed: ` +
        `expected an object with { shape, data }, got ${
          raw === null ? "null" : typeof raw
        }`,
    );
  }
  const { data, shape } = raw as { data?: unknown; shape?: unknown };
  if (!Array.isArray(data)) {
    throw new Error(
      `Workers AI embedding response from model "${model}" is malformed: ` +
        `"data" is not an array of vectors`,
    );
  }
  if (data.length !== texts.length) {
    throw new Error(
      `Workers AI embedding response from model "${model}" returned ` +
        `${data.length} vectors for ${texts.length} input texts`,
    );
  }

  const vectors: number[][] = data.map((vector, index) => {
    if (!Array.isArray(vector)) {
      throw new Error(
        `Workers AI embedding response from model "${model}" is ` +
          `malformed: vector ${index} is not an array`,
      );
    }
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Workers AI embedding response from model "${model}": vector ` +
          `${index} has length ${vector.length}, expected ` +
          `${EMBEDDING_DIMENSIONS} (EMBEDDING_DIMENSIONS) — the ` +
          `configured model does not match the vector(1024) schema`,
      );
    }
    for (const component of vector) {
      if (typeof component !== "number" || !Number.isFinite(component)) {
        throw new Error(
          `Workers AI embedding response from model "${model}" is ` +
            `malformed: vector ${index} contains a non-numeric component`,
        );
      }
    }
    return vector as number[];
  });

  // Cross-check the documented `shape` when the response carries one:
  // it must agree with the data actually returned.
  if (Array.isArray(shape) && shape.length >= 2) {
    const [rows, dims] = shape as [unknown, unknown];
    if (rows !== texts.length || dims !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Workers AI embedding response from model "${model}" reports ` +
          `shape [${String(rows)}, ${String(dims)}], expected ` +
          `[${texts.length}, ${EMBEDDING_DIMENSIONS}]`,
      );
    }
  }

  return { model, vectors };
}
