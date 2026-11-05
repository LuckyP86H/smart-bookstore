import { describe, expect, it } from "vitest";

import { InvalidISBNError, normalizeISBN } from "./isbn";

// Cases ported from backend/external/isbn_test.go.
const CASES: readonly { input: string; want: string; ok: boolean }[] = [
  { input: "9780441172719", want: "9780441172719", ok: true }, // Dune, ISBN-13
  { input: "978-0-441-17271-9", want: "9780441172719", ok: true }, // hyphenated
  { input: " 978 0441172719 ", want: "9780441172719", ok: true }, // spaces
  { input: "0441172717", want: "0441172717", ok: true }, // Dune, ISBN-10
  { input: "080442957X", want: "080442957X", ok: true }, // ISBN-10 with X check digit
  { input: "080442957x", want: "080442957X", ok: true }, // lowercase x
  { input: "9780441172718", want: "", ok: false }, // wrong check digit
  { input: "0441172718", want: "", ok: false }, // wrong ISBN-10 check digit
  { input: "X804429570", want: "", ok: false }, // X only allowed last
  { input: "", want: "", ok: false },
  { input: "12345", want: "", ok: false },
  // Search operators must be rejected, not forwarded to Google
  { input: "9780441172719 OR intitle:x", want: "", ok: false },
  { input: "isbn:9780441172719", want: "", ok: false },
];

describe("normalizeISBN", () => {
  for (const { input, want, ok } of CASES) {
    it(`handles ${JSON.stringify(input)}`, () => {
      if (ok) {
        expect(normalizeISBN(input)).toBe(want);
      } else {
        expect(() => normalizeISBN(input)).toThrowError(InvalidISBNError);
      }
    });
  }

  it("rejects ISBN-13 with a letter in the check position", () => {
    expect(() => normalizeISBN("978044117271X")).toThrowError(InvalidISBNError);
  });

  it("rejects lengths just either side of valid", () => {
    expect(() => normalizeISBN("044117271")).toThrowError(InvalidISBNError); // 9
    expect(() => normalizeISBN("04411727170")).toThrowError(InvalidISBNError); // 11
    expect(() => normalizeISBN("978044117271")).toThrowError(InvalidISBNError); // 12
    expect(() => normalizeISBN("97804411727190")).toThrowError(InvalidISBNError); // 14
  });
});
