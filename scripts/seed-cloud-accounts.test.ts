// Seed script unit tests. The script itself is never run against a real
// database here (owner-run only); these tests pin the env contract, the
// refusal behaviour, and the idempotent upsert shape.

import { describe, expect, it, vi } from "vitest";

import { parseRecord, verifyPassword } from "../worker/src/auth/password";
import {
  parseSeedEnv,
  runSeed,
  SEED_ACCOUNTS,
  UPSERT_SQL,
  type SeedClient,
} from "./seed-cloud-accounts";

const FULL_ENV = {
  DATABASE_URL: "postgres://user:secret@example.invalid:5432/postgres",
  PASSWORD_PEPPER: "seed-test-pepper",
  PBKDF2_ITERATIONS: "1000",
};

describe("parseSeedEnv", () => {
  it("refuses when both required variables are missing", () => {
    const result = parseSeedEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["DATABASE_URL", "PASSWORD_PEPPER"]);
    }
  });

  it("refuses when only the pepper is missing", () => {
    const result = parseSeedEnv({ DATABASE_URL: FULL_ENV.DATABASE_URL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["PASSWORD_PEPPER"]);
  });

  it("accepts a complete environment and resolves iterations", () => {
    const result = parseSeedEnv(FULL_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.iterations).toBe(1000);
      expect(result.config.pepper).toBe("seed-test-pepper");
    }
  });
});

describe("runSeed", () => {
  function fakeClient() {
    const statements: { text: string; values: (string | boolean)[] }[] = [];
    const client: SeedClient = {
      execute: async (text, values) => {
        statements.push({ text, values });
      },
      close: vi.fn(async () => undefined),
    };
    return { client, statements };
  }

  it("refuses before connecting when the env is incomplete", async () => {
    const connect = vi.fn(() => fakeClient().client);
    await expect(runSeed({ env: {}, connect })).rejects.toThrow(
      /missing required env: DATABASE_URL, PASSWORD_PEPPER/,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("upserts the three Go seed accounts with verifiable PBKDF2 records", async () => {
    const { client, statements } = fakeClient();
    const connect = vi.fn(() => client);
    const seeded = await runSeed({ env: FULL_ENV, connect });
    expect(seeded).toEqual(["merchant1", "merchant2", "customer"]);
    expect(connect).toHaveBeenCalledWith(FULL_ENV.DATABASE_URL);
    expect(client.close).toHaveBeenCalled();
    expect(statements).toHaveLength(3);

    const policy = {
      iterations: 1000,
      currentPepperVersion: 1,
      pepperSecrets: new Map([[1, "seed-test-pepper"]]),
    };
    for (const [index, account] of SEED_ACCOUNTS.entries()) {
      const { text, values } = statements[index];
      expect(text).toBe(UPSERT_SQL);
      expect(values[0]).toBe(account.username);
      expect(values[2]).toBe(account.isCustomer);
      const record = String(values[1]);
      const parsed = parseRecord(record);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind === "ok") {
        expect(parsed.iterations).toBe(1000);
        expect(parsed.pepperVersion).toBe(1);
      }
      expect(
        (await verifyPassword(account.password, record, policy)).ok,
      ).toBe(true);
    }
  });

  it("is idempotent at the statement level: a second run issues the same upserts", async () => {
    const { client, statements } = fakeClient();
    await runSeed({ env: FULL_ENV, connect: () => client });
    await runSeed({ env: FULL_ENV, connect: () => client });
    expect(statements).toHaveLength(6);
    for (const { text } of statements) {
      expect(text).toContain("ON CONFLICT (username) DO UPDATE");
      expect(text).toContain("SET password = EXCLUDED.password");
    }
  });
});
