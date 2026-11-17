import { describe, expect, it } from "vitest";

import {
  agreementBands,
  bandsPass,
  normalizeForAgreement,
} from "./agreement";

const EFFECTIVE_JAVA = {
  editionTitle: "Effective Java",
  workTitle: "Effective Java",
  authorDisplay: "Joshua Bloch",
};

describe("normalizeForAgreement", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeForAgreement("  Effective Java: Third Edition! ")).toBe(
      "effective java third edition",
    );
  });

  it("leaves CJK text intact apart from punctuation", () => {
    expect(normalizeForAgreement("红楼梦")).toBe("红楼梦");
    expect(normalizeForAgreement("红楼梦（校注本）")).toBe("红楼梦 校注本");
  });
});

describe("agreementBands / bandsPass — the lying-ISBN guard", () => {
  it("passes an honest listing (exact title, exact author)", () => {
    const bands = agreementBands(
      { title: "Effective Java", author: "Joshua Bloch" },
      EFFECTIVE_JAVA,
    );
    expect(bands).toEqual({ title: "exact", author: "exact" });
    expect(bandsPass(bands)).toBe(true);
  });

  it("demotes the PR 2 lying fixture: Design Patterns under EJ's ISBN", () => {
    const bands = agreementBands(
      { title: "Design Patterns", author: "Erich Gamma" },
      EFFECTIVE_JAVA,
    );
    expect(bands.title).toBe("mismatch");
    expect(bands.author).toBe("mismatch");
    expect(bandsPass(bands)).toBe(false);
  });

  it("treats a subtitle-extended title as partial agreement", () => {
    const bands = agreementBands(
      { title: "Effective Java", author: "Joshua Bloch" },
      {
        editionTitle: "Effective Java: Third Edition",
        workTitle: "Effective Java",
        authorDisplay: "Joshua Bloch",
      },
    );
    expect(bands.title).toBe("exact"); // the work title matches exactly
    expect(bandsPass(bands)).toBe(true);
  });

  it("passes on title alone when the reference has no author", () => {
    const bands = agreementBands(
      { title: "Effective Java", author: "Whoever" },
      { ...EFFECTIVE_JAVA, authorDisplay: null },
    );
    expect(bands.author).toBe("unknown");
    expect(bandsPass(bands)).toBe(true);
  });

  it("still demotes on title mismatch when the author is unknown", () => {
    const bands = agreementBands(
      { title: "Design Patterns", author: "Erich Gamma" },
      { ...EFFECTIVE_JAVA, authorDisplay: null },
    );
    expect(bandsPass(bands)).toBe(false);
  });

  it("accepts a surname-only author overlap as partial", () => {
    const bands = agreementBands(
      { title: "Effective Java", author: "Bloch" },
      EFFECTIVE_JAVA,
    );
    expect(bands.author).toBe("partial");
    expect(bandsPass(bands)).toBe(true);
  });

  it("handles the CJK case: 红楼梦 by 曹雪芹", () => {
    const bands = agreementBands(
      { title: "红楼梦", author: "曹雪芹" },
      {
        editionTitle: "红楼梦",
        workTitle: "红楼梦",
        authorDisplay: "曹雪芹",
      },
    );
    expect(bands).toEqual({ title: "exact", author: "exact" });
    expect(bandsPass(bands)).toBe(true);
  });

  it("demotes a ZH listing whose title names a different classic", () => {
    const bands = agreementBands(
      { title: "西游记", author: "吴承恩" },
      {
        editionTitle: "红楼梦",
        workTitle: "红楼梦",
        authorDisplay: "曹雪芹",
      },
    );
    expect(bandsPass(bands)).toBe(false);
  });
});
