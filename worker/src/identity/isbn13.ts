// Canonical ISBN-13 derivation for Path A (plan §3.1).
//
// A listing's stored ISBN is marketplace-shaped data: hyphenated,
// ISBN-10, sometimes plain garbage (P3 parity froze how it is stored —
// the upsert conflict key is (store_id, isbn) verbatim). Identity never
// joins on the stored form. It joins on the canonical ISBN-13 derived
// here: strip hyphens/spaces, uppercase, validate the check digit, and
// convert ISBN-10 as 978 + first nine digits + recomputed ISBN-13 check
// digit — the same rules as PR 1's isbn_map builder, so the Worker's
// derivation and the seeded isbn_index agree for every input both
// sides accept in the same way. ONE known divergence (verified on both
// sides in PR #67 review, item 9): FULL-WIDTH input (e.g. '９７８…').
// The loader's canonicalise accepts a full-width ISBN-13 (it
// canonicalises to itself, producing index rows no listing can ever
// join to), while this Worker's canonicalISBN13 REJECTS it (null —
// normalizeISBN admits only ASCII digits/X). The divergence is
// safe-direction: full-width ISBN listings simply never link, and the
// loader's full-width index rows are dead weight, not wrong links.
// The root fix (NFKC in the loader's clean_isbn) is #72 R1, not this
// file; a test in isbn13.test.ts pins the Worker's rejection so the
// behaviour is explicit rather than accidental.
//
// An ISBN that cannot be canonicalised (bad length, bad characters,
// bad checksum) yields null: no link attempt is made, and that is NOT
// an error — the listing simply has no usable ISBN evidence.

import { InvalidISBNError, normalizeISBN } from "../external/isbn";

function isbn13CheckDigit(firstTwelve: string): number {
  let total = 0;
  for (let i = 0; i < 12; i += 1) {
    total += Number(firstTwelve[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (total % 10)) % 10;
}

/**
 * The canonical ISBN-13 for a raw ISBN string, or null when the input
 * is empty, missing, or not a valid ISBN-10/ISBN-13.
 */
export function canonicalISBN13(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return null;
  }
  let normalized: string;
  try {
    normalized = normalizeISBN(raw);
  } catch (err) {
    if (err instanceof InvalidISBNError) {
      return null;
    }
    throw err;
  }
  if (normalized.length === 13) {
    return normalized;
  }
  // ISBN-10 -> ISBN-13: 978 prefix + first nine digits + new check digit.
  const core = `978${normalized.slice(0, 9)}`;
  return core + String(isbn13CheckDigit(core));
}
