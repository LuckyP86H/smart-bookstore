// TEST DOUBLE — not production credential checking.
//
// Route B P1 exercised the auth interceptor's routing and role logic
// (public ISBN lookup, customer → MerchantService denial) with this double;
// P2 landed real PBKDF2 verification against the `stores` table in
// store-checker.ts, which is what connect-app.ts wires by default. This
// double remains for the interceptor routing tests only.
//
// It checks plaintext passwords against the three documented seed
// accounts only (backend/db/database.go seedAccounts). The store ids match
// the order the Go seeder inserts them. It must never learn any other
// credential.

import type { AuthIdentity, CredentialChecker } from "./basic";

export type { AuthIdentity, CredentialChecker };

const FIXTURE_ACCOUNTS: readonly {
  username: string;
  password: string;
  identity: AuthIdentity;
}[] = [
  {
    username: "merchant1",
    password: "password1",
    identity: { storeId: 1n, isCustomer: false, username: "merchant1" },
  },
  {
    username: "merchant2",
    password: "password2",
    identity: { storeId: 2n, isCustomer: false, username: "merchant2" },
  },
  {
    username: "customer",
    password: "password",
    identity: { storeId: 3n, isCustomer: true, username: "customer" },
  },
];

const DUMMY_PASSWORD = "timing-equalizer";

export function createTestDoubleCredentialChecker(): CredentialChecker {
  return {
    async authenticate(username, password) {
      const account = FIXTURE_ACCOUNTS.find((a) => a.username === username);
      if (account === undefined) {
        // Spend the same comparison as a wrong password so the two cases
        // stay indistinguishable (the Go backend does the equivalent with
        // a dummy bcrypt hash).
        void (password === DUMMY_PASSWORD);
        return null;
      }
      return password === account.password ? account.identity : null;
    },
  };
}
