// Canonical ISBN-13 derivation for Path A (plan §3.1).
//
// A listing's stored ISBN is marketplace-shaped data: hyphenated,
// ISBN-10, sometimes plain garbage (P3 parity froze how it is stored —
// the upsert conflict key is (store_id, isbn) verbatim). Identity never
// joins on the stored form. It joins on the canonical ISBN-13 derived
// here: strip hyphens/spaces, uppercase, validate the check digit, and
// convert ISBN-10 as 978 + first nine digits + recomputed ISBN-13 check
// digit — the same rules as PR 1's isbn_map builder, so the Worker's
// derivation and the seeded isbn_index agree by construction.
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
