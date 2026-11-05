// Port of backend/external/isbn.go.

/** Input that is not a well-formed ISBN-10 or ISBN-13. */
export class InvalidISBNError extends Error {
  constructor() {
    super(
      "invalid ISBN: expected 10 or 13 digits with a valid check digit",
    );
    this.name = "InvalidISBNError";
  }
}

/**
 * Strips hyphens and spaces and verifies the check digit, returning the
 * bare ISBN. The result is safe to embed in a search query: it contains
 * only digits (plus a trailing X for ISBN-10), so it can never smuggle
 * extra search operators into the upstream request.
 */
export function normalizeISBN(raw: string): string {
  const s = raw.replace(/[- ]/g, "").toUpperCase();

  switch (s.length) {
    case 10: {
      // Weights 10..1; the final character may be X (= 10).
      let sum = 0;
      for (let i = 0; i < s.length; i++) {
        const r = s[i];
        let d: number;
        if (r >= "0" && r <= "9") {
          d = r.charCodeAt(0) - "0".charCodeAt(0);
        } else if (r === "X" && i === 9) {
          d = 10;
        } else {
          throw new InvalidISBNError();
        }
        sum += d * (10 - i);
      }
      if (sum % 11 !== 0) throw new InvalidISBNError();
      return s;
    }
    case 13: {
      // Weights alternate 1, 3.
      let sum = 0;
      for (let i = 0; i < s.length; i++) {
        const r = s[i];
        if (r < "0" || r > "9") throw new InvalidISBNError();
        let d = r.charCodeAt(0) - "0".charCodeAt(0);
        if (i % 2 === 1) d *= 3;
        sum += d;
      }
      if (sum % 10 !== 0) throw new InvalidISBNError();
      return s;
    }
    default:
      throw new InvalidISBNError();
  }
}
