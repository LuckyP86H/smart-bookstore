import { describe, expect, it } from "vitest";

import { canonicalISBN13 } from "./isbn13";

describe("canonicalISBN13", () => {
  it("passes a valid ISBN-13 through unchanged", () => {
    expect(canonicalISBN13("9780134685991")).toBe("9780134685991");
  });

  it("strips hyphens and spaces before validating", () => {
    expect(canonicalISBN13("978-0-13-468599-1")).toBe("9780134685991");
    expect(canonicalISBN13("978 0 13 468599 1")).toBe("9780134685991");
  });

  it("converts ISBN-10 with the 978 prefix and a recomputed check digit", () => {
    // Effective Java's ISBN-10 -> its ISBN-13 (PR 2 fixture pair).
    expect(canonicalISBN13("0134685997")).toBe("9780134685991");
    expect(canonicalISBN13("0-13-468599-7")).toBe("9780134685991");
  });

  it("converts ISBN-10s ending in X, upper- or lowercase", () => {
    expect(canonicalISBN13("080442957X")).toBe("9780804429573");
    expect(canonicalISBN13("080442957x")).toBe("9780804429573");
  });

  it("returns null for bad checksums — no link attempt, not an error", () => {
    expect(canonicalISBN13("9780134685992")).toBeNull(); // 13, digit off
    expect(canonicalISBN13("0134685998")).toBeNull(); // 10, digit off
    expect(canonicalISBN13("0804429571")).toBeNull(); // X replaced by 1
  });

  it("rejects full-width ISBN input (pinned divergence from the loader, #72 R1)", () => {
    // Full-width digits: the seed loader's canonicalise accepts these
    // (they canonicalise to themselves), the Worker rejects them —
    // safe direction (no link attempt), root fix is NFKC in #72 R1.
    expect(canonicalISBN13("９７８０１３４６８５９９１")).toBeNull();
    expect(canonicalISBN13("０１３４６８５９９７")).toBeNull();
  });

  it("returns null for garbage and empties", () => {
    expect(canonicalISBN13("not-an-isbn")).toBeNull();
    expect(canonicalISBN13("123")).toBeNull();
    expect(canonicalISBN13("")).toBeNull();
    expect(canonicalISBN13("   ")).toBeNull();
    expect(canonicalISBN13(null)).toBeNull();
    expect(canonicalISBN13(undefined)).toBeNull();
  });
});
