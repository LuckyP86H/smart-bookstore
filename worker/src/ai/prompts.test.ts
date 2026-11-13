import { describe, expect, it } from "vitest";

import type {
  Db,
  QueryRow,
  QueryRunner,
  QueryValue,
} from "../db/client";
import { loadPrompt } from "./prompts";

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

describe("loadPrompt", () => {
  it("returns the highest-version row for the key", async () => {
    // The stub returns the row the ORDER BY … LIMIT 1 query would pick:
    // version 3 of the key, above the seeded versions 1 and 2.
    const { db, calls } = stubDb([
      { id: 5n, key: "summarise_listing", version: 3, body: "Summarise: {title}" },
    ]);

    const prompt = await loadPrompt(db, "summarise_listing");

    expect(prompt).toEqual({
      id: 5,
      key: "summarise_listing",
      version: 3,
      body: "Summarise: {title}",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("FROM prompts");
    expect(calls[0].text).toContain("ORDER BY version DESC");
    expect(calls[0].text).toContain("LIMIT 1");
    expect(calls[0].values).toEqual(["summarise_listing"]);
  });

  it("throws loud on a missing key", async () => {
    const { db } = stubDb([]);

    await expect(loadPrompt(db, "no_such_prompt")).rejects.toThrow(
      /no prompt found for key "no_such_prompt"/,
    );
  });

  it("throws loud on a non-integer id instead of silently using 0", async () => {
    // toInt previously returned 0 for unexpected types, which would
    // hand back a prompt whose id names no row.
    const { db } = stubDb([
      { id: { bogus: true }, key: "summarise_listing", version: 3, body: "x" },
    ]);

    await expect(loadPrompt(db, "summarise_listing")).rejects.toThrow(
      /unexpected integer value/,
    );
  });
});
