// Production credential checking (Route B P2): PBKDF2 verification against
// the `stores` table, per PBKDF2-DESIGN.md. Ports the semantics of the Go
// backend's AuthenticateStore (backend/db/database.go):
//
//   - exactly one verifyPassword call per attempt, on every path — the
//     user's record when the row exists, the dummy record (§7) when not;
//   - unknown user and wrong password are indistinguishable (both null,
//     which the interceptor maps to one generic failure);
//   - a database error propagates (the interceptor maps it to Internal) —
//     an outage must not masquerade as wrong credentials (design §9);
//   - on success with an outdated record, a lazy rehash (§8) rewrites the
//     row at current parameters via ctx.waitUntil; a rehash failure is an
//     error-level log event and never fails the login.

import type { QueryRunner } from "../db/client";
import type { AuthIdentity, CredentialChecker } from "./basic";
import { PEPPER_VERSION, resolveIterations } from "./constants";
import {
  dummyRecord,
  hashPassword,
  verifyPassword,
  type PasswordPolicy,
} from "./password";

export interface StoreCredentialCheckerDeps {
  run: QueryRunner;
  policy: PasswordPolicy;
  /** ctx.waitUntil in the Worker; omit in tests (the rehash still runs). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Structured internal event sink; defaults to console logging. */
  log?: (event: Record<string, unknown>) => void;
  // Injectable for tests; default to the real implementations.
  verify?: typeof verifyPassword;
  hash?: typeof hashPassword;
}

const LOOKUP_SQL =
  "SELECT id, password, is_customer FROM stores WHERE username = $1";
const REHASH_SQL = "UPDATE stores SET password = $1 WHERE id = $2";

export function createStoreCredentialChecker(
  deps: StoreCredentialCheckerDeps,
): CredentialChecker {
  const verify = deps.verify ?? verifyPassword;
  const hash = deps.hash ?? hashPassword;
  const log =
    deps.log ??
    ((event: Record<string, unknown>) => {
      const line = JSON.stringify(event);
      if (event.event === "auth_rehash_failed") {
        console.error(line);
      } else {
        console.warn(line);
      }
    });

  return {
    async authenticate(username, password) {
      const rows = await deps.run(LOOKUP_SQL, [username]);
      const row = rows[0];
      const record =
        row !== undefined
          ? String(row.password)
          : dummyRecord(deps.policy.iterations, deps.policy.currentPepperVersion);

      const result = await verify(password, record, deps.policy);
      if (result.alert !== undefined) {
        // Internal only: the client response stays the generic failure.
        // Never log the password or the record itself.
        log({ event: result.alert, username });
      }
      if (row === undefined || !result.ok) {
        return null;
      }

      const identity: AuthIdentity = {
        storeId: BigInt(row.id as string | number | bigint),
        isCustomer: Boolean(row.is_customer),
        username,
      };

      if (result.needsRehash) {
        const rehash = (async () => {
          const fresh = await hash(password, deps.policy);
          await deps.run(REHASH_SQL, [
            fresh,
            row.id as string | number | bigint,
          ]);
        })().catch((err: unknown) => {
          // A lost rehash is harmless (the next login retries it) but must
          // be visible: a globally broken hashPassword hid behind swallowed
          // warnings in one of the incidents behind design §1.3.
          log({
            event: "auth_rehash_failed",
            username,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        if (deps.waitUntil !== undefined) {
          deps.waitUntil(rehash);
        }
      }

      return identity;
    },
  };
}

/**
 * Builds the password policy from the Worker's environment: the iteration
 * target from PBKDF2_ITERATIONS (resolved + clamped by constants.ts) and
 * the pepper secrets — PASSWORD_PEPPER for the current version, plus any
 * PASSWORD_PEPPER_V<n> entries kept for a rotation window (design §6).
 */
export function passwordPolicyFromEnv(env: {
  PBKDF2_ITERATIONS?: string;
  PASSWORD_PEPPER?: string;
}): PasswordPolicy {
  const pepperSecrets = new Map<number, string>();
  const all = env as Record<string, unknown>;
  for (const [key, value] of Object.entries(all)) {
    if (typeof value !== "string" || value === "") continue;
    const match = /^PASSWORD_PEPPER_V([0-9]+)$/.exec(key);
    if (match !== null) {
      pepperSecrets.set(Number.parseInt(match[1], 10), value);
    }
  }
  if (env.PASSWORD_PEPPER !== undefined && env.PASSWORD_PEPPER !== "") {
    pepperSecrets.set(PEPPER_VERSION, env.PASSWORD_PEPPER);
  }
  return {
    iterations: resolveIterations(env.PBKDF2_ITERATIONS),
    currentPepperVersion: PEPPER_VERSION,
    pepperSecrets,
  };
}
