// The lying-ISBN agreement guard (plan §3.1, §4.4).
//
// An ISBN printed on a listing is a CLAIM, not a fact: the seller can
// type an honest book's ISBN onto a different book (PR 2's fixtures
// plant exactly that — "Design Patterns" carrying Effective Java's
// ISBN). So after the isbn_index join names the edition the ISBN
// belongs to, the listing's own title/author must AGREE with that
// edition's reference metadata before anything auto-links. Disagreement
// demotes the listing to Path B with the mismatch recorded as evidence.
//
// The comparison is deliberately cheap and conservative (this is a
// guard, not the matcher — Path B in PR 4 does the real scoring):
// normalised equality, then containment, then author token overlap.

// A type alias, not an interface: it is passed as a jsonb parameter
// through db/client's QueryValue, which requires an index signature
// (type aliases get one implicitly; interfaces do not).
export type AgreementBands = {
  title: "exact" | "partial" | "mismatch";
  author: "exact" | "partial" | "mismatch" | "unknown";
};

/**
 * Lowercase, punctuation to spaces, whitespace collapsed. CJK text has
 * no case or word spaces and passes through untouched apart from
 * punctuation, which is what the guard needs for equality checks.
 */
export function normalizeForAgreement(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleBand(
  listingTitle: string,
  candidateTitles: (string | null)[],
): AgreementBands["title"] {
  const listing = normalizeForAgreement(listingTitle);
  if (listing === "") {
    return "mismatch";
  }
  let partial = false;
  for (const candidate of candidateTitles) {
    if (candidate === null) {
      continue;
    }
    const ref = normalizeForAgreement(candidate);
    if (ref === "") {
      continue;
    }
    if (ref === listing) {
      return "exact";
    }
    // Containment either way ("Effective Java" vs "Effective Java:
    // Third Edition" once punctuation is stripped). The length floor
    // keeps a 2-letter title from "agreeing" with everything.
    if (
      listing.length >= 5 &&
      ref.length >= 5 &&
      (listing.includes(ref) || ref.includes(listing))
    ) {
      partial = true;
    }
  }
  return partial ? "partial" : "mismatch";
}

function authorTokens(text: string): Set<string> {
  return new Set(
    normalizeForAgreement(text)
      .split(" ")
      .filter((token) => token.length >= 2),
  );
}

function authorBand(
  listingAuthor: string,
  authorDisplay: string | null,
): AgreementBands["author"] {
  if (authorDisplay === null || authorDisplay.trim() === "") {
    return "unknown"; // the reference cannot confirm or deny
  }
  if (listingAuthor.trim() === "") {
    return "unknown";
  }
  if (
    normalizeForAgreement(listingAuthor) ===
    normalizeForAgreement(authorDisplay)
  ) {
    return "exact";
  }
  const listingTokens = authorTokens(listingAuthor);
  const displayTokens = authorTokens(authorDisplay);
  for (const token of listingTokens) {
    if (displayTokens.has(token)) {
      return "partial";
    }
  }
  return "mismatch";
}

export function agreementBands(
  listing: { title: string; author: string },
  candidate: {
    editionTitle: string | null;
    workTitle: string | null;
    authorDisplay: string | null;
  },
): AgreementBands {
  return {
    title: titleBand(listing.title, [
      candidate.editionTitle,
      candidate.workTitle,
    ]),
    author: authorBand(listing.author, candidate.authorDisplay),
  };
}

/** Auto-link only when neither signal contradicts the ISBN's claim. */
export function bandsPass(bands: AgreementBands): boolean {
  return bands.title !== "mismatch" && bands.author !== "mismatch";
}

/**
 * A bookkeeping score for the evidence row, derived deterministically
 * from the bands (Path A has no model; PR 2's fixture lineage used the
 * same idea — 0.98 for exact/exact). Never used as a gate.
 */
export function bandsScore(bands: AgreementBands): number {
  const titleScore =
    bands.title === "exact" ? 0.6 : bands.title === "partial" ? 0.45 : 0.1;
  const authorScore =
    bands.author === "exact"
      ? 0.38
      : bands.author === "partial"
        ? 0.3
        : bands.author === "unknown"
          ? 0.2
          : 0.02;
  return Math.round((titleScore + authorScore) * 100) / 100;
}
