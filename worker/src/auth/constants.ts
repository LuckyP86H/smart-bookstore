// Single source of truth for the PBKDF2 parameters (PBKDF2-DESIGN.md §1.3
// and §5). The production workerd runtime refuses deriveBits above
// MAX_RUNTIME_ITERATIONS, and local runtimes (Node, Miniflare) do NOT
// enforce that cap — so every iteration count used anywhere (hash, verify,
// dummy record, seed script, benchmark) must come from this module, never
// from a literal at a call site. A second hand-typed number is exactly how
// the incident in design §1.3 happened.

/** Hard runtime cap: workerd refuses PBKDF2 iterations above this (§1.3). */
export const MAX_RUNTIME_ITERATIONS = 100_000;

/** Pepper version written into new records (the `p=` segment, design §6). */
export const PEPPER_VERSION = 1;

/**
 * Fallback iteration count when the PBKDF2_ITERATIONS env var is unset.
 *
 * SETTLED 2026-11-05 — the owner decided (option B: stay on Workers
 * Free); 10,000 is the final count on Free. The staging benchmarks
 * (design §5) behind the decision are in DEPLOY.md ("Route B P2"
 * section). Their result was §5.4's stop-and-escalate outcome: on this
 * Free account the login path's metered CPU p95 exceeded the 7 ms
 * planning budget at EVERY tested count — 1k ≈ 20.6 ms; 5k ≈ 21.7 ms;
 * 10k ≈ 19.9 ms; 25k ≈ 29.1 ms; 50k ≈ 38.7 ms; 100k ≈ 50–53 ms — with
 * zero exceededCpu and zero errors anywhere, so the documented 10 ms
 * Free CPU limit was not observed to be enforced. The p95 is flat at
 * the low end because the tail is fixed Worker/Connect overhead, not
 * the derivation, so lowering the count buys ~0 ms at p95 and only
 * weakens the hash: 10,000 — the design's minimum defensible count —
 * stands, and the unmet 7 ms gate is an accepted, documented
 * trade-off with the pepper and the login rate limiter as the
 * compensating controls. On Workers Paid (30 s CPU) the count should
 * go straight to 100,000 via the PBKDF2_ITERATIONS var, no code change
 * needed. Do not raise this default on Free without re-running the
 * benchmark.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 10_000;

/**
 * Parses the PBKDF2_ITERATIONS env value and clamps it to
 * [1, MAX_RUNTIME_ITERATIONS] (design §5). Any adjustment — unparsable
 * input, clamping — is logged loudly: a silently-wrong iteration count is
 * either a production outage (above the cap) or a silent security
 * downgrade (below the intended value).
 */
export function resolveIterations(
  raw: string | undefined,
  warn: (message: string) => void = (message) => console.error(message),
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PBKDF2_ITERATIONS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    warn(
      JSON.stringify({
        event: "auth_iterations_unparsable",
        value: raw,
        fallback: DEFAULT_PBKDF2_ITERATIONS,
      }),
    );
    return DEFAULT_PBKDF2_ITERATIONS;
  }
  if (parsed < 1 || parsed > MAX_RUNTIME_ITERATIONS) {
    const clamped = Math.min(Math.max(parsed, 1), MAX_RUNTIME_ITERATIONS);
    warn(
      JSON.stringify({
        event: "auth_iterations_clamped",
        value: parsed,
        clamped,
      }),
    );
    return clamped;
  }
  return parsed;
}
