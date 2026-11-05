// Seeds the cloud (Supabase) stores table with the three documented seed
// accounts, using PBKDF2 password records (Route B P2, PBKDF2-DESIGN.md).
//
// OWNER-RUN ONLY: this script needs the Supabase database password (inside
// DATABASE_URL) and the production PASSWORD_PEPPER — credentials the
// implementer never handles. Run it from the repo root:
//
//   DATABASE_URL="postgres://…" PASSWORD_PEPPER="…" npm run seed:cloud
//
// (npm run seed:cloud bundles this file with esbuild and runs it under
// Node; PBKDF2_ITERATIONS may be set to override the default target.)
//
// The local Go runtime keeps bcrypt records for the same usernames and
// passwords — the stored format is per-database by design; see DEPLOY.md.
//
// Idempotent: re-running refreshes only the password column of the three
// seed rows (ON CONFLICT (username) DO UPDATE), so it doubles as the
// recovery path for a stale or wrong-format record.

import { pathToFileURL } from "node:url";

import postgres from "postgres";

import {
  PEPPER_VERSION,
  resolveIterations,
} from "../worker/src/auth/constants";
import {
  hashPassword,
  type PasswordPolicy,
} from "../worker/src/auth/password";

/** Mirrors backend/db/database.go seedAccounts — same users, same order. */
export const SEED_ACCOUNTS: readonly {
  username: string;
  password: string;
  isCustomer: boolean;
}[] = [
  { username: "merchant1", password: "password1", isCustomer: false },
  { username: "merchant2", password: "password2", isCustomer: false },
  { username: "customer", password: "password", isCustomer: true },
];

export const UPSERT_SQL =
  "INSERT INTO stores (username, password, is_customer) VALUES ($1, $2, $3) " +
  "ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password";

export interface SeedConfig {
  databaseUrl: string;
  pepper: string;
  iterations: number;
}

export type ParseSeedEnvResult =
  | { ok: true; config: SeedConfig }
  | { ok: false; missing: string[] };

/**
 * Both DATABASE_URL (carries the DB password) and PASSWORD_PEPPER are
 * mandatory: seeding without the pepper would write records production
 * cannot verify, and guessing a connection string is worse than stopping.
 */
export function parseSeedEnv(
  env: Record<string, string | undefined>,
): ParseSeedEnvResult {
  const missing: string[] = [];
  const databaseUrl = env.DATABASE_URL;
  const pepper = env.PASSWORD_PEPPER;
  if (databaseUrl === undefined || databaseUrl === "") missing.push("DATABASE_URL");
  if (pepper === undefined || pepper === "") missing.push("PASSWORD_PEPPER");
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    config: {
      databaseUrl: databaseUrl as string,
      pepper: pepper as string,
      iterations: resolveIterations(env.PBKDF2_ITERATIONS),
    },
  };
}

export type SqlExecutor = (
  text: string,
  values: (string | boolean)[],
) => Promise<void>;

export interface SeedClient {
  execute: SqlExecutor;
  close: () => Promise<void>;
}

export interface RunSeedDeps {
  env: Record<string, string | undefined>;
  connect: (databaseUrl: string) => SeedClient;
  hash?: typeof hashPassword;
}

/**
 * Validates the environment BEFORE connecting anywhere, then upserts the
 * three seed accounts with fresh PBKDF2 records. Returns the seeded
 * usernames (never passwords or records).
 */
export async function runSeed(deps: RunSeedDeps): Promise<string[]> {
  const parsed = parseSeedEnv(deps.env);
  if (!parsed.ok) {
    throw new Error(
      `seed-cloud-accounts: refusing to run; missing required env: ${parsed.missing.join(", ")}`,
    );
  }
  const { config } = parsed;
  const policy: PasswordPolicy = {
    iterations: config.iterations,
    currentPepperVersion: PEPPER_VERSION,
    pepperSecrets: new Map([[PEPPER_VERSION, config.pepper]]),
  };
  const hash = deps.hash ?? hashPassword;
  const client = deps.connect(config.databaseUrl);
  try {
    for (const account of SEED_ACCOUNTS) {
      const record = await hash(account.password, policy);
      await client.execute(UPSERT_SQL, [
        account.username,
        record,
        account.isCustomer,
      ]);
    }
  } finally {
    await client.close();
  }
  return SEED_ACCOUNTS.map((account) => account.username);
}

async function main(): Promise<void> {
  const usernames = await runSeed({
    env: process.env,
    connect: (databaseUrl) => {
      const sql = postgres(databaseUrl, { max: 1 });
      return {
        execute: async (text, values) => {
          await sql.unsafe(text, [...values]);
        },
        close: () => sql.end({ timeout: 5 }),
      };
    },
  });
  console.log(`seeded accounts: ${usernames.join(", ")}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
