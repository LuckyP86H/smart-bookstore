// PBKDF2 suite per PBKDF2-DESIGN.md §10: RFC known-answer vectors,
// malformed-record classes, the production-cap guard, timing structure,
// and rehash semantics. (The §10.3 source-scan guard lives in
// scripts/check-iteration-literals.mjs — it needs the filesystem, which
// this suite deliberately avoids.)

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PBKDF2_ITERATIONS,
  MAX_RUNTIME_ITERATIONS,
  resolveIterations,
} from "./constants";
import {
  b64urlDecodeStrict,
  deriveBits,
  dummyRecord,
  hashPassword,
  parseRecord,
  verifyPassword,
  type PasswordPolicy,
} from "./password";

const enc = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DUMMY_SALT = "lgXXgyyLhdSUMfvO0pl7DQ"; // 16 bytes, base64url
const DUMMY_HASH = "WNmZL5fF17PlF18hgssqNUO-4zw6McpjokQM6zwfBfU"; // 32 bytes

const PEPPER = "password-test-pepper";
const peppered = (iterations: number): PasswordPolicy => ({
  iterations,
  currentPepperVersion: 1,
  pepperSecrets: new Map([[1, PEPPER]]),
});
const pepperless = (iterations: number): PasswordPolicy => ({
  iterations,
  currentPepperVersion: 0,
  pepperSecrets: new Map(),
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (crypto.subtle as unknown as Record<string, unknown>)[
    "timingSafeEqual"
  ];
});

describe("RFC 7914 §11 known-answer vectors (PBKDF2-HMAC-SHA-256)", () => {
  // Copied verbatim from RFC 7914 §11. Both vectors use dkLen=64; our
  // deriveBits(..., 256) must equal the first 32 bytes (PBKDF2's prefix
  // property), per design §10.1.
  it('P="passwd", S="salt", c=1', async () => {
    const out = await deriveBits(enc.encode("passwd"), enc.encode("salt"), 1);
    expect(hex(out)).toBe(
      "55ac046e56e3089fec1691c22544b605" +
        "f94185216dde0465e68b9d57c20dacbc",
    );
  });

  it('P="Password", S="NaCl", c=80000', async () => {
    const out = await deriveBits(
      enc.encode("Password"),
      enc.encode("NaCl"),
      80000,
    );
    expect(hex(out)).toBe(
      "4ddcd8f60b98be21830cee5ef22701f9" +
        "641a4418d04c0414aeff08876b34ab56",
    );
  });
});

describe("RFC 6070 cross-check (PBKDF2-HMAC-SHA-1)", () => {
  // A second hash through the same harness (design §10.1). The RFC
  // vectors use dkLen 20/25; we derive 32 bytes and compare the prefix
  // (PBKDF2's prefix property).
  const vectors: [string, string, number, string][] = [
    ["password", "salt", 1, "0c60c80f961f0e71f3a9b524af6012062fe037a6"],
    ["password", "salt", 2, "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957"],
    ["password", "salt", 4096, "4b007901b765489abead49d926f721d065a429c1"],
    [
      "passwordPASSWORDpassword",
      "saltSALTsaltSALTsaltSALTsaltSALTsalt",
      4096,
      "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038",
    ],
  ];
  for (const [password, salt, iterations, expectedHex] of vectors) {
    it(`c=${iterations}, P=${password.slice(0, 8)}…`, async () => {
      const out = await deriveBits(
        enc.encode(password),
        enc.encode(salt),
        iterations,
        "SHA-1",
      );
      expect(hex(out).startsWith(expectedHex)).toBe(true);
    });
  }
});

describe("record format and round-trip", () => {
  it("hash → parse → verify, with pepper", async () => {
    const record = await hashPassword("correct horse", peppered(1000));
    expect(record).toMatch(
      /^\$pbkdf2-sha256\$i=1000,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    );
    const parsed = parseRecord(record);
    expect(parsed.kind).toBe("ok");
    const good = await verifyPassword("correct horse", record, peppered(1000));
    expect(good).toEqual({ ok: true, needsRehash: false });
    const bad = await verifyPassword("wrong horse", record, peppered(1000));
    expect(bad.ok).toBe(false);
    expect(bad.needsRehash).toBe(false);
  });

  it("pepperless records omit the p= segment and verify", async () => {
    const record = await hashPassword("pw", pepperless(1000));
    expect(record).toMatch(/^\$pbkdf2-sha256\$i=1000\$/);
    expect((await verifyPassword("pw", record, pepperless(1000))).ok).toBe(
      true,
    );
  });

  it("a different pepper secret fails; a missing one fails closed with an alert", async () => {
    const record = await hashPassword("pw", peppered(1000));
    const wrongPepper: PasswordPolicy = {
      iterations: 1000,
      currentPepperVersion: 1,
      pepperSecrets: new Map([[1, "some-other-pepper"]]),
    };
    expect((await verifyPassword("pw", record, wrongPepper)).ok).toBe(false);

    const noPepper: PasswordPolicy = {
      iterations: 1000,
      currentPepperVersion: 1,
      pepperSecrets: new Map(),
    };
    const missing = await verifyPassword("pw", record, noPepper);
    expect(missing.ok).toBe(false);
    expect(missing.alert).toBe("auth_pepper_secret_missing");
    await expect(hashPassword("pw", noPepper)).rejects.toThrow();
  });

  it("salts differ between hashes of the same password", async () => {
    const a = await hashPassword("pw", peppered(1000));
    const b = await hashPassword("pw", peppered(1000));
    expect(a).not.toBe(b);
  });
});

describe("malformed records: generic failure, no derivation", () => {
  const cases: [string, string][] = [
    ["empty string", ""],
    ["plaintext", "hunter2"],
    ["bcrypt $2a$", "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"],
    ["bcrypt $2b$", "$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"],
    ["bcrypt $2y$", "$2y$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"],
    ["zero iterations", `$pbkdf2-sha256$i=0$${DUMMY_SALT}$${DUMMY_HASH}`],
    ["non-numeric iterations", `$pbkdf2-sha256$i=abc$${DUMMY_SALT}$${DUMMY_HASH}`],
    ["duplicate parameter", `$pbkdf2-sha256$i=1000,i=2000$${DUMMY_SALT}$${DUMMY_HASH}`],
    ["unknown parameter", `$pbkdf2-sha256$i=1000,x=1$${DUMMY_SALT}$${DUMMY_HASH}`],
    ["pepper version zero", `$pbkdf2-sha256$i=1000,p=0$${DUMMY_SALT}$${DUMMY_HASH}`],
    ["wrong algorithm", `$pbkdf2-sha512$i=1000$${DUMMY_SALT}$${DUMMY_HASH}`],
    ["short salt", `$pbkdf2-sha256$i=1000$AAAA$${DUMMY_HASH}`],
    ["short hash", `$pbkdf2-sha256$i=1000$${DUMMY_SALT}$AAAA`],
    ["non-base64url salt", `$pbkdf2-sha256$i=1000$lgXXgyyLhdSUMfvO0pl7D+$${DUMMY_HASH}`],
    ["extra segment", `$pbkdf2-sha256$i=1000$${DUMMY_SALT}$${DUMMY_HASH}$extra`],
    ["missing hash", `$pbkdf2-sha256$i=1000$${DUMMY_SALT}`],
  ];
  for (const [name, record] of cases) {
    it(name, async () => {
      const deriveSpy = vi.spyOn(crypto.subtle, "deriveBits");
      const result = await verifyPassword("pw", record, peppered(1000));
      expect(result.ok).toBe(false);
      expect(result.needsRehash).toBe(false);
      expect(result.alert).toBe(
        name.startsWith("bcrypt")
          ? "auth_legacy_bcrypt_record"
          : "auth_malformed_record",
      );
      expect(deriveSpy).not.toHaveBeenCalled();
    });
  }

  it("iterations above the runtime cap: above-cap alert, no derivation", async () => {
    const deriveSpy = vi.spyOn(crypto.subtle, "deriveBits");
    const record = `$pbkdf2-sha256$i=100001$${DUMMY_SALT}$${DUMMY_HASH}`;
    const result = await verifyPassword("pw", record, peppered(1000));
    expect(result).toEqual({
      ok: false,
      needsRehash: false,
      alert: "auth_record_iterations_above_cap",
    });
    expect(deriveSpy).not.toHaveBeenCalled();
  });
});

describe("production-cap guard (design §10.3)", () => {
  it("the parser pre-check is what stands between a bad record and the runtime refusal", async () => {
    // Local runtimes do NOT enforce the 100k cap, so emulate production:
    // deriveBits throws the real workerd error above the cap.
    const realDerive = crypto.subtle.deriveBits.bind(crypto.subtle);
    type DeriveBitsFn = typeof crypto.subtle.deriveBits;
    const impl = (async (...args: Parameters<DeriveBitsFn>) => {
      const params = args[0] as { iterations: number };
      if (params.iterations > MAX_RUNTIME_ITERATIONS) {
        throw new Error(
          "NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported",
        );
      }
      return realDerive(...args);
    }) as DeriveBitsFn;
    const stub = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(impl);

    const aboveCap = `$pbkdf2-sha256$i=100001$${DUMMY_SALT}$${DUMMY_HASH}`;
    const result = await verifyPassword("pw", aboveCap, peppered(1000));
    expect(result.ok).toBe(false);
    expect(result.alert).toBe("auth_record_iterations_above_cap");
    expect(stub).not.toHaveBeenCalled();

    // A record at exactly the cap still verifies through the stubbed path.
    const atCap = await hashPassword("pw", pepperless(MAX_RUNTIME_ITERATIONS));
    expect(
      (await verifyPassword("pw", atCap, pepperless(MAX_RUNTIME_ITERATIONS)))
        .ok,
    ).toBe(true);
  });

  it("resolveIterations clamps to the cap and logs loudly", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveIterations("100001", warn)).toBe(MAX_RUNTIME_ITERATIONS);
    expect(resolveIterations("0", warn)).toBe(1);
    expect(resolveIterations("25000", warn)).toBe(25000);
    expect(resolveIterations("abc", warn)).toBe(DEFAULT_PBKDF2_ITERATIONS);
    expect(resolveIterations(undefined, warn)).toBe(
      DEFAULT_PBKDF2_ITERATIONS,
    );
    expect(warnings.length).toBe(3); // two clamps + one unparsable
  });

});

describe("timing structure (design §10.4)", () => {
  it("unknown user, wrong password, correct password: identical crypto work", async () => {
    const policy = peppered(2000);
    const record = await hashPassword("the-password", policy);
    const dummy = dummyRecord(policy.iterations, policy.currentPepperVersion);

    // Warm the pepper-key cache (imported once per isolate by design),
    // then install counters.
    await verifyPassword("warmup", record, policy);
    const importSpy = vi.spyOn(crypto.subtle, "importKey");
    const deriveSpy = vi.spyOn(crypto.subtle, "deriveBits");
    let compareCalls = 0;
    (
      crypto.subtle as unknown as Record<string, unknown>
    )["timingSafeEqual"] = (a: Uint8Array, b: Uint8Array) => {
      compareCalls++;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      return diff === 0;
    };

    const attempts: [string, string][] = [
      ["any-password", dummy], // unknown user → dummy record
      ["wrong-password", record],
      ["the-password", record],
    ];
    for (const [password, rec] of attempts) {
      importSpy.mockClear();
      deriveSpy.mockClear();
      compareCalls = 0;
      await verifyPassword(password, rec, policy);
      const pbkdf2Imports = importSpy.mock.calls.filter(
        (call) => call[2] === "PBKDF2",
      );
      expect(pbkdf2Imports.length).toBe(1);
      expect(deriveSpy).toHaveBeenCalledTimes(1);
      expect(
        (deriveSpy.mock.calls[0][0] as { iterations: number }).iterations,
      ).toBe(2000);
      expect(compareCalls).toBe(1);
    }
  });
});

describe("dummy record (design §7)", () => {
  it("is well-formed, tracks the live parameters, and never verifies", async () => {
    const dummy = dummyRecord(12345, 1);
    const parsed = parseRecord(dummy);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.iterations).toBe(12345);
      expect(parsed.pepperVersion).toBe(1);
      expect(parsed.salt.length).toBe(16);
      expect(parsed.hash.length).toBe(32);
    }
    expect((await verifyPassword("anything", dummy, peppered(12345))).ok).toBe(
      false,
    );
    expect(
      (await verifyPassword("anything", dummyRecord(999, 0), pepperless(999)))
        .ok,
    ).toBe(false);
  });
});

describe("input hygiene (design §8)", () => {
  it("hash rejects empty and over-long passwords; verify fails generically", async () => {
    await expect(hashPassword("", peppered(1000))).rejects.toThrow();
    await expect(
      hashPassword("a".repeat(257), peppered(1000)),
    ).rejects.toThrow();
    const record = await hashPassword("pw", peppered(1000));
    expect((await verifyPassword("", record, peppered(1000))).ok).toBe(false);
    expect(
      (await verifyPassword("a".repeat(257), record, peppered(1000))).ok,
    ).toBe(false);
    // Exactly 256 bytes is accepted.
    const maxPassword = "a".repeat(256);
    const maxRecord = await hashPassword(maxPassword, peppered(1000));
    expect(
      (await verifyPassword(maxPassword, maxRecord, peppered(1000))).ok,
    ).toBe(true);
  });
});

describe("lazy rehash semantics (design §8, §10.7)", () => {
  it("an older-iteration record verifies and is flagged; the rewrite verifies clean", async () => {
    const old = await hashPassword("pw", peppered(500));
    const result = await verifyPassword("pw", old, peppered(2000));
    expect(result).toEqual({ ok: true, needsRehash: true });

    const fresh = await hashPassword("pw", peppered(2000));
    expect(fresh).not.toBe(old);
    expect(await verifyPassword("pw", fresh, peppered(2000))).toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it("a stale pepper version is flagged for rehash", async () => {
    const v1 = await hashPassword("pw", peppered(1000));
    const both: PasswordPolicy = {
      iterations: 1000,
      currentPepperVersion: 2,
      pepperSecrets: new Map([
        [1, PEPPER],
        [2, "the-next-pepper"],
      ]),
    };
    const result = await verifyPassword("pw", v1, both);
    expect(result).toEqual({ ok: true, needsRehash: true });
  });

  it("base64url decoding rejects padding and foreign alphabets", () => {
    expect(b64urlDecodeStrict("AAAA")).toEqual(new Uint8Array([0, 0, 0]));
    expect(b64urlDecodeStrict("AAA=")).toBeNull();
    expect(b64urlDecodeStrict("AAA+")).toBeNull();
    expect(b64urlDecodeStrict("A")).toBeNull();
  });
});
