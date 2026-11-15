import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  embedTexts,
  type EmbeddingEnv,
} from "./embeddings";

const MODEL = "@cf/baai/bge-m3";

function vector(length: number, fill = 0.5): number[] {
  return Array.from({ length }, () => fill);
}

interface AiCall {
  model: string;
  inputs: unknown;
}

/**
 * Stub Workers AI binding in the documented text-embeddings shape:
 * `{ shape: [n, dims], data: [...] }` for the canned vectors.
 */
function stubEnv(
  data: number[][],
  model: string | undefined,
): { env: EmbeddingEnv; calls: AiCall[] } {
  const calls: AiCall[] = [];
  const env = {
    AI: {
      run: async (m: string, inputs: unknown) => {
        calls.push({ model: m, inputs });
        return { shape: [data.length, data[0]?.length ?? 0], data };
      },
    },
    EMBEDDING_MODEL: model,
  } as unknown as EmbeddingEnv;
  return { env, calls };
}

describe("embedTexts", () => {
  it("embeds 2 texts into 2×1024 vectors and echoes the configured model", async () => {
    const data = [vector(1024, 0.1), vector(1024, 0.2)];
    const { env, calls } = stubEnv(data, MODEL);

    const result = await embedTexts(env, ["Dune", "Foundation"]);

    expect(result.model).toBe(MODEL);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.vectors[1]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.vectors).toEqual(data);
    expect(calls).toEqual([
      { model: MODEL, inputs: { text: ["Dune", "Foundation"] } },
    ]);
  });

  it("rejects a 384-length vector, failing loud about 1024", async () => {
    const { env } = stubEnv([vector(384)], MODEL);

    await expect(embedTexts(env, ["Dune"])).rejects.toThrow(/1024/);
  });

  it("rejects a vector-count mismatch", async () => {
    const { env } = stubEnv([vector(1024)], MODEL);

    await expect(embedTexts(env, ["Dune", "Foundation"])).rejects.toThrow(
      /1 vectors for 2 input texts/,
    );
  });

  it("throws when EMBEDDING_MODEL is unset or empty, without calling AI", async () => {
    for (const model of [undefined, "", "   "]) {
      const { env, calls } = stubEnv([vector(1024)], model);
      await expect(embedTexts(env, ["Dune"])).rejects.toThrow(
        /EMBEDDING_MODEL is not configured/,
      );
      expect(calls).toHaveLength(0);
    }
  });
});
