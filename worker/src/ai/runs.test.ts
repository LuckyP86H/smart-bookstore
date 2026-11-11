import { describe, expect, it } from "vitest";

import type {
  Db,
  QueryRow,
  QueryRunner,
  QueryValue,
} from "../db/client";
import { finishRun, startRun } from "./runs";

interface CapturedCall {
  text: string;
  values: QueryValue[];
}

/** Stub Db whose run() captures (text, values) and returns canned rows. */
function stubDb(rows: QueryRow[]): { db: Db; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const run: QueryRunner = async (text, values) => {
    calls.push({ text, values });
    return rows;
  };
  const db: Db = {
    run,
    begin: async (fn) => fn(run),
    close: async () => undefined,
  };
  return { db, calls };
}

describe("startRun", () => {
  it("inserts with parent_run_id + JSON input and returns the id", async () => {
    const { db, calls } = stubDb([{ id: 42 }]);

    const id = await startRun(db, {
      kind: "embed_listing",
      provider: "cloudflare",
      model: "@cf/baai/bge-m3",
      parentRunId: 7,
      listingId: 99n,
      input: { title: "Dune" },
    });

    expect(id).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO ai_runs");
    expect(calls[0].text).toContain("parent_run_id");
    expect(calls[0].text).toContain("RETURNING id");
    expect(calls[0].values[0]).toBe(7);
    expect(calls[0].values[1]).toBe("embed_listing");
    expect(calls[0].values).toContain(JSON.stringify({ title: "Dune" }));
    expect(calls[0].values).toContain(99n);
  });

  it("stores SQL NULL for every omitted optional field", async () => {
    const { db, calls } = stubDb([{ id: 43n }]);

    const id = await startRun(db, { kind: "summarise_review" });

    expect(id).toBe(43);
    expect(calls[0].values).toEqual([
      null,
      "summarise_review",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("finishRun", () => {
  it("writes output, tokens and neurons with status ok", async () => {
    const { db, calls } = stubDb([{ id: 7 }]);

    await finishRun(db, 7, {
      output: { summary: "A desert planet." },
      inputTokens: 120,
      outputTokens: 45,
      neurons: 3.5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("UPDATE ai_runs");
    expect(calls[0].values).toEqual([
      JSON.stringify({ summary: "A desert planet." }),
      120,
      45,
      3.5,
      "ok",
      null,
      7,
    ]);
  });

  it("flips to error status when an error is given without a status", async () => {
    const { db, calls } = stubDb([{ id: 7 }]);

    await finishRun(db, 7, { error: "upstream timeout" });

    expect(calls[0].values[4]).toBe("error");
    expect(calls[0].values[5]).toBe("upstream timeout");
  });

  it("respects an explicit status over the error-derived default", async () => {
    const { db, calls } = stubDb([{ id: 7 }]);

    await finishRun(db, 7, { status: "ok", error: "partial warning" });

    expect(calls[0].values[4]).toBe("ok");
    expect(calls[0].values[5]).toBe("partial warning");
  });

  it("throws loud when no ai_runs row carries the id", async () => {
    const { db } = stubDb([]);

    await expect(finishRun(db, 404, {})).rejects.toThrow(
      /no ai_runs row with id 404/,
    );
  });
});
