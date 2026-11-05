// Store credential checker (P2): one verification per attempt on every
// path, indistinguishable failures, lazy rehash via waitUntil
// (PBKDF2-DESIGN.md §7, §8, §10.4/§10.7).

import { describe, expect, it, vi } from "vitest";

import type { QueryRunner, QueryRow } from "../db/client";
import { hashPassword, parseRecord, verifyPassword } from "./password";
import { createStoreCredentialChecker } from "./store-checker";

const PEPPER = "store-checker-test-pepper";
const policy = (iterations: number) => ({
  iterations,
  currentPepperVersion: 1,
  pepperSecrets: new Map([[1, PEPPER]]),
});

interface FixtureStore {
  run: QueryRunner;
  rows: Map<string, QueryRow>;
  updates: { record: string; id: unknown }[];
  failUpdate: boolean;
}

/** In-memory stand-in for the stores table, keyed by username. */
function fixtureStore(seed: QueryRow[] = []): FixtureStore {
  const store: FixtureStore = {
    rows: new Map(seed.map((row) => [String(row.username), row])),
    updates: [],
    failUpdate: false,
    run: async (text, values) => {
      if (text.includes("FROM stores WHERE username")) {
        const row = store.rows.get(String(values[0]));
        return row === undefined ? [] : [row];
      }
      if (text.startsWith("UPDATE stores SET password")) {
        if (store.failUpdate) throw new Error("update blew up");
        store.updates.push({ record: String(values[0]), id: values[1] });
        for (const row of store.rows.values()) {
          if (row.id === values[1]) row["password"] = String(values[0]);
        }
        return [];
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return store;
}

async function merchantRow(iterations = 1000): Promise<QueryRow> {
  return {
    id: 1n,
    username: "merchant1",
    password: await hashPassword("password1", policy(iterations)),
    is_customer: false,
  };
}

function countingVerify() {
  const calls: { password: string; record: string }[] = [];
  const verify = async (
    password: string,
    record: string,
    pol: Parameters<typeof verifyPassword>[2],
  ) => {
    calls.push({ password, record });
    return verifyPassword(password, record, pol);
  };
  return { verify, calls };
}

describe("createStoreCredentialChecker", () => {
  it("unknown user: one verify against the dummy record, then null", async () => {
    const store = fixtureStore();
    const { verify, calls } = countingVerify();
    const checker = createStoreCredentialChecker({
      run: store.run,
      policy: policy(1000),
      verify,
      log: () => undefined,
    });
    expect(await checker.authenticate("ghost", "password")).toBeNull();
    expect(calls).toHaveLength(1);
    // The dummy tracks the live target iterations (design §7).
    expect(calls[0].record).toContain("$pbkdf2-sha256$i=1000,p=1$");
  });

  it("wrong password: one verify against the stored record, then null", async () => {
    const store = fixtureStore([await merchantRow()]);
    const { verify, calls } = countingVerify();
    const checker = createStoreCredentialChecker({
      run: store.run,
      policy: policy(1000),
      verify,
      log: () => undefined,
    });
    expect(await checker.authenticate("merchant1", "nope")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].record).toBe(store.rows.get("merchant1")?.password);
  });

  it("correct password returns the identity (bigint id, role flag)", async () => {
    const store = fixtureStore([await merchantRow()]);
    const checker = createStoreCredentialChecker({
      run: store.run,
      policy: policy(1000),
      log: () => undefined,
    });
    expect(await checker.authenticate("merchant1", "password1")).toEqual({
      storeId: 1n,
      isCustomer: false,
      username: "merchant1",
    });
  });

  it("a bcrypt row fails closed, logs the alert, and still runs exactly one verify", async () => {
    const store = fixtureStore([
      {
        id: 7n,
        username: "legacy",
        password:
          "$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
        is_customer: false,
      },
    ]);
    const { verify, calls } = countingVerify();
    const events: Record<string, unknown>[] = [];
    const checker = createStoreCredentialChecker({
      run: store.run,
      policy: policy(1000),
      verify,
      log: (e) => events.push(e),
    });
    expect(await checker.authenticate("legacy", "password1")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(events).toEqual([
      { event: "auth_legacy_bcrypt_record", username: "legacy" },
    ]);
  });

  it("a database error propagates instead of masquerading as bad credentials", async () => {
    const checker = createStoreCredentialChecker({
      run: async () => {
        throw new Error("connection reset");
      },
      policy: policy(1000),
      log: () => undefined,
    });
    await expect(checker.authenticate("merchant1", "password1")).rejects.toThrow(
      "connection reset",
    );
  });

  it("rehashes an outdated record upward via waitUntil, exactly once", async () => {
    const store = fixtureStore([await merchantRow(500)]);
    const pending: Promise<unknown>[] = [];
    const checker = createStoreCredentialChecker({
      run: store.run,
      policy: policy(2000),
      waitUntil: (p) => pending.push(p),
      log: () => undefined,
    });
    const identity = await checker.authenticate("merchant1", "password1");
    expect(identity?.username).toBe("merchant1");
    await Promise.all(pending);
    expect(store.updates).toHaveLength(1);
    const parsed = parseRecord(store.updates[0].record);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.iterations).toBe(2000);

    // Second login against the rewritten record: no further rehash.
    const again = await checker.authenticate("merchant1", "password1");
    expect(again?.username).toBe("merchant1");
    await Promise.all(pending);
    expect(store.updates).toHaveLength(1);
  });

  it("a failing rehash update never fails the login, and is error-logged", async () => {
    const store = fixtureStore([await merchantRow(500)]);
    store.failUpdate = true;
    const pending: Promise<unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const checker = createStoreCredentialChecker({
      run: store.run,
      policy: policy(2000),
      waitUntil: (p) => pending.push(p),
      log: (e) => events.push(e),
    });
    const identity = await checker.authenticate("merchant1", "password1");
    expect(identity?.username).toBe("merchant1");
    await Promise.all(pending);
    expect(events.map((e) => e.event)).toContain("auth_rehash_failed");
  });
});
