// PBKDF2 password records for the Worker (PBKDF2-DESIGN.md §3, §4, §6–§8).
//
// Record format (PHC-shaped, base64url without padding):
//   $pbkdf2-sha256$i=<iterations>,p=<pepperVersion>$<salt>$<hash>
// The `,p=…` segment is omitted for pre-pepper (version 0) records.
//
// This module is the only place the WebCrypto KDF calls appear. It is kept
// free of Worker-only APIs so the seed script (scripts/seed-cloud-accounts.ts)
// can reuse it under plain Node.

import { MAX_RUNTIME_ITERATIONS } from "./constants";

const enc = new TextEncoder();

export const SALT_BYTES = 16;
export const HASH_BYTES = 32;
/** Passwords whose UTF-8 encoding exceeds this are rejected (design §8). */
export const MAX_PASSWORD_BYTES = 256;

/**
 * Internal alert events (design §3, §6, §9). These are how record/pepper
 * problems get found operationally; they are logged by the caller and must
 * never carry the password, the stored record, or derived bytes.
 */
export type AuthAlertEvent =
  | "auth_legacy_bcrypt_record"
  | "auth_malformed_record"
  | "auth_record_iterations_above_cap"
  | "auth_pepper_secret_missing"
  | "auth_derive_failed";

/**
 * The parameters verification and hashing run under. `iterations` is the
 * current target (already resolved/clamped via constants.ts);
 * `pepperSecrets` maps pepper version → secret for every version this
 * deployment can verify (the current version plus any rotation window).
 */
export interface PasswordPolicy {
  iterations: number;
  currentPepperVersion: number;
  pepperSecrets: ReadonlyMap<number, string>;
}

export interface VerifyResult {
  ok: boolean;
  needsRehash: boolean;
  alert?: AuthAlertEvent;
}

// ---------------------------------------------------------------------------
// Derivation (design §4). The digest parameter exists only so the test suite
// can cross-check the harness against the RFC 6070 SHA-1 vectors (§10.1);
// production callers always use the SHA-256 default.
// ---------------------------------------------------------------------------

export async function deriveBits(
  passwordBytes: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  digest: "SHA-256" | "SHA-1" = "SHA-256",
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: digest,
      salt: salt as BufferSource,
      iterations,
    },
    baseKey,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Pepper preparation (design §6): PBKDF2's input is
// HMAC-SHA-256(pepperKey, utf8(password)) for peppered records, the raw
// UTF-8 password for version-0 records. The HMAC key is imported once per
// secret per isolate and cached; the cache key is the secret itself, held
// only in memory and never logged.
// ---------------------------------------------------------------------------

const pepperKeyCache = new Map<string, Promise<CryptoKey>>();

function pepperKey(secret: string): Promise<CryptoKey> {
  let key = pepperKeyCache.get(secret);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      "raw",
      enc.encode(secret) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    pepperKeyCache.set(secret, key);
  }
  return key;
}

/**
 * Returns the bytes to feed PBKDF2, or null when the record's pepper
 * version has no configured secret (fail closed, design §6).
 */
async function preparePasswordBytes(
  passwordBytes: Uint8Array,
  pepperVersion: number,
  policy: PasswordPolicy,
): Promise<Uint8Array | null> {
  if (pepperVersion === 0) {
    return passwordBytes;
  }
  const found = policy.pepperSecrets.get(pepperVersion);
  if (found === undefined) {
    return null;
  }
  const key = await pepperKey(found);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    passwordBytes as BufferSource,
  );
  return new Uint8Array(signature);
}

// ---------------------------------------------------------------------------
// Constant-time compare (design §1.4, §4). workerd provides
// crypto.subtle.timingSafeEqual; other runtimes (Node, for tests and the
// seed script) fall back to a fixed-length XOR loop. Both digests are 32
// bytes by construction; the length guard follows Cloudflare's own example
// (compare the candidate against itself) instead of throwing.
// ---------------------------------------------------------------------------

type TimingSafeEqualFn = (a: BufferSource, b: BufferSource) => boolean;
type SubtleWithTimingSafeEqual = SubtleCrypto & {
  timingSafeEqual: TimingSafeEqualFn;
};

function subtleWithTimingSafeEqual(): SubtleWithTimingSafeEqual | undefined {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: TimingSafeEqualFn;
  };
  return typeof subtle.timingSafeEqual === "function"
    ? (subtle as SubtleWithTimingSafeEqual)
    : undefined;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // The native function must be invoked as a method on the subtle object:
  // workerd's SubtleCrypto methods throw "Illegal invocation" when called
  // unbound (caught by the P2 staging probe on the real runtime; Node
  // tolerates the unbound call, so unit tests alone could not see it).
  const subtle = subtleWithTimingSafeEqual();
  if (a.length !== b.length) {
    if (subtle !== undefined) {
      subtle.timingSafeEqual(a as BufferSource, a as BufferSource);
    } else {
      let acc = 0;
      for (let i = 0; i < a.length; i++) acc |= a[i] ^ a[i];
      void acc;
    }
    return false;
  }
  if (subtle !== undefined) {
    return subtle.timingSafeEqual(a as BufferSource, b as BufferSource);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// base64url (RFC 4648 §5), no padding. Decoding is strict: only the URL-safe
// alphabet, no padding characters, exact expected lengths enforced by the
// parser, not here.
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function b64urlDecodeStrict(text: string): Uint8Array | null {
  if (!B64URL_ALPHABET.test(text) || text.length % 4 === 1) {
    return null;
  }
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Record parsing (design §3). Strict: exact prefix, integer parameters,
// salt exactly 16 bytes, hash exactly 32 bytes. A record naming more than
// MAX_RUNTIME_ITERATIONS is classified before any derivation — it can
// never be verified on this runtime and must not reach deriveBits.
// ---------------------------------------------------------------------------

export type ParsedRecord =
  | {
      kind: "ok";
      iterations: number;
      pepperVersion: number;
      salt: Uint8Array;
      hash: Uint8Array;
    }
  | { kind: "above-cap"; iterations: number }
  | { kind: "legacy-bcrypt" }
  | { kind: "malformed" };

const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"] as const;

export function parseRecord(record: string): ParsedRecord {
  for (const prefix of BCRYPT_PREFIXES) {
    if (record.startsWith(prefix)) {
      return { kind: "legacy-bcrypt" };
    }
  }
  // "$pbkdf2-sha256$params$salt$hash".split("$") ===
  // ["", "pbkdf2-sha256", params, salt, hash]
  const parts = record.split("$");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "pbkdf2-sha256") {
    return { kind: "malformed" };
  }
  let iterations: number | undefined;
  let pepperVersion = 0;
  const seen = new Set<string>();
  for (const pair of parts[2].split(",")) {
    const match = /^([ip])=([0-9]+)$/.exec(pair);
    if (match === null || seen.has(match[1])) {
      return { kind: "malformed" };
    }
    seen.add(match[1]);
    const value = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(value)) {
      return { kind: "malformed" };
    }
    if (match[1] === "i") {
      iterations = value;
    } else {
      pepperVersion = value;
    }
  }
  if (iterations === undefined || iterations < 1) {
    return { kind: "malformed" };
  }
  if (seen.has("p") && pepperVersion < 1) {
    return { kind: "malformed" };
  }
  if (iterations > MAX_RUNTIME_ITERATIONS) {
    return { kind: "above-cap", iterations };
  }
  const salt = b64urlDecodeStrict(parts[3]);
  const hash = b64urlDecodeStrict(parts[4]);
  if (
    salt === null ||
    salt.length !== SALT_BYTES ||
    hash === null ||
    hash.length !== HASH_BYTES
  ) {
    return { kind: "malformed" };
  }
  return { kind: "ok", iterations, pepperVersion, salt, hash };
}

export function formatRecord(
  iterations: number,
  pepperVersion: number,
  salt: Uint8Array,
  hash: Uint8Array,
): string {
  const params =
    pepperVersion > 0 ? `i=${iterations},p=${pepperVersion}` : `i=${iterations}`;
  return `$pbkdf2-sha256$${params}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword (design §4)
// ---------------------------------------------------------------------------

export async function hashPassword(
  password: string,
  policy: PasswordPolicy,
): Promise<string> {
  const passwordBytes = enc.encode(password);
  if (passwordBytes.length === 0) {
    throw new Error("hashPassword: empty password");
  }
  if (passwordBytes.length > MAX_PASSWORD_BYTES) {
    throw new Error("hashPassword: password exceeds 256 UTF-8 bytes");
  }
  const prepared = await preparePasswordBytes(
    passwordBytes,
    policy.currentPepperVersion,
    policy,
  );
  if (prepared === null) {
    throw new Error(
      "hashPassword: no pepper secret configured for the current pepper version",
    );
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(prepared, salt, policy.iterations);
  return formatRecord(policy.iterations, policy.currentPepperVersion, salt, hash);
}

// Substituted for the password bytes when the presented password itself is
// invalid (empty / over-long): the derivation still runs exactly once at
// the record's cost, so the path's work profile does not change, and the
// comparison simply fails (design §8).
const INVALID_INPUT_STANDIN = enc.encode("pbkdf2/invalid-input");

export async function verifyPassword(
  password: string,
  record: string,
  policy: PasswordPolicy,
): Promise<VerifyResult> {
  const parsed = parseRecord(record);
  switch (parsed.kind) {
    case "legacy-bcrypt":
      return { ok: false, needsRehash: false, alert: "auth_legacy_bcrypt_record" };
    case "above-cap":
      return {
        ok: false,
        needsRehash: false,
        alert: "auth_record_iterations_above_cap",
      };
    case "malformed":
      return { ok: false, needsRehash: false, alert: "auth_malformed_record" };
    case "ok":
      break;
  }

  let passwordBytes = enc.encode(password);
  const inputValid =
    passwordBytes.length > 0 && passwordBytes.length <= MAX_PASSWORD_BYTES;
  if (!inputValid) {
    passwordBytes = INVALID_INPUT_STANDIN;
  }

  const prepared = await preparePasswordBytes(
    passwordBytes,
    parsed.pepperVersion,
    policy,
  );
  if (prepared === null) {
    return { ok: false, needsRehash: false, alert: "auth_pepper_secret_missing" };
  }

  let candidate: Uint8Array;
  try {
    candidate = await deriveBits(prepared, parsed.salt, parsed.iterations);
  } catch {
    // Unreachable by construction (the parser rejects iterations above the
    // runtime cap); if the platform ever surprises us, fail closed with an
    // alert instead of throwing into a 500 (design §9).
    return { ok: false, needsRehash: false, alert: "auth_derive_failed" };
  }

  const ok = inputValid && constantTimeEqual(candidate, parsed.hash);
  return {
    ok,
    needsRehash:
      ok &&
      (parsed.iterations < policy.iterations ||
        parsed.pepperVersion !== policy.currentPepperVersion),
  };
}

// ---------------------------------------------------------------------------
// Dummy record (design §7): a well-formed record corresponding to no
// account, so unknown-user logins run the identical verify work. The salt
// and hash bytes are fixed literals — the PBKDF2 output for a throwaway
// random password, generated once at implementation time (2026-11-05); the
// password was discarded and is used nowhere. The record string is
// assembled from the *live* iteration constant and pepper version so a
// future parameter bump cannot desynchronise the dummy from real records.
// ---------------------------------------------------------------------------

const DUMMY_SALT_B64URL = "lgXXgyyLhdSUMfvO0pl7DQ";
const DUMMY_HASH_B64URL = "WNmZL5fF17PlF18hgssqNUO-4zw6McpjokQM6zwfBfU";

export function dummyRecord(iterations: number, pepperVersion: number): string {
  const params =
    pepperVersion > 0 ? `i=${iterations},p=${pepperVersion}` : `i=${iterations}`;
  return `$pbkdf2-sha256$${params}$${DUMMY_SALT_B64URL}$${DUMMY_HASH_B64URL}`;
}
