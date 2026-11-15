import { describe, expect, it } from "vitest";

import type {
  QueryRow,
  QueryRunner,
  QueryValue,
  TransactionRunner,
} from "./client";
import { linkListingPathA, lookupLocalPrefill } from "./identity";

// ---------------------------------------------------------------------------
// A recording stub runner in the ai/*.test.ts style: canned rows per
// statement family, every call logged for lineage assertions.
// ---------------------------------------------------------------------------

interface CandidateRow {
  edition_id: bigint;
  edition_title: string | null;
  work_ref_id: bigint | null;
  work_title: string | null;
  author_display: string | null;
}

const EJ_EDITION: CandidateRow = {
  edition_id: 11n,
  edition_title: "Effective Java",
  work_ref_id: 21n,
  work_title: "Effective Java",
  author_display: "Joshua Bloch",
};

interface StubConfig {
  candidates?: CandidateRow[];
  fallbackCandidate?: CandidateRow | null;
  existingLink?: {
    edition_ref_id: bigint | null;
    work_ref_id: bigint | null;
    local_work_id: bigint | null;
  } | null;
}

function makeStub(config: StubConfig) {
  const calls: { text: string; values: QueryValue[] }[] = [];
  const run: QueryRunner = async (text, values) => {
    calls.push({ text, values });
    const rows = (value: unknown): QueryRow[] => value as QueryRow[];
    if (text.includes("FROM isbn_index i")) {
      return rows(config.candidates ?? []);
    }
    if (text.includes("e.source_key = $1")) {
      return rows(config.fallbackCandidate ? [config.fallbackCandidate] : []);
    }
    if (text.includes("FROM listing_links WHERE")) {
      return rows(config.existingLink ? [config.existingLink] : []);
    }
    if (text.includes("INSERT INTO ai_runs")) {
      return [{ id: 42 }];
    }
    if (text.includes("UPDATE ai_runs")) {
      return [{ id: 42 }];
    }
    if (text.includes("INSERT INTO evidence")) {
      return [{ id: 7n }];
    }
    return [];
  };
  const begin: TransactionRunner = async (fn) => fn(run);
  return { run, begin, calls };
}

function callsTo(
  calls: { text: string; values: QueryValue[] }[],
  needle: string,
) {
  return calls.filter((c) => c.text.includes(needle));
}

const HONEST = {
  id: 55n,
  isbn: "9780134685991",
  title: "Effective Java",
  author: "Joshua Bloch",
};
const LYING = {
  id: 56n,
  isbn: "9780134685991",
  title: "Design Patterns",
  author: "Erich Gamma",
};

describe("linkListingPathA", () => {
  it("links an honest listing and writes the full lineage", async () => {
    const stub = makeStub({ candidates: [EJ_EDITION] });
    const outcome = await linkListingPathA(stub, HONEST);
    expect(outcome.status).toBe("linked");
    if (outcome.status === "linked") {
      expect(outcome.editionId).toBe(11n);
      expect(outcome.workRefId).toBe(21n);
      expect(outcome.source).toBe("isbn_index");
    }
    expect(callsTo(stub.calls, "INSERT INTO listing_links")).toHaveLength(1);
    expect(callsTo(stub.calls, "INSERT INTO listing_facets")).toHaveLength(1);
    const events = callsTo(stub.calls, "INSERT INTO identity_events");
    expect(events).toHaveLength(1);
    expect(events[0].values).toContain("link");
    const evidence = callsTo(stub.calls, "INSERT INTO evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].values).toContain("auto_linked");
    // The ai_runs pair brackets the derivation (startRun + finishRun).
    expect(callsTo(stub.calls, "INSERT INTO ai_runs")).toHaveLength(1);
    expect(callsTo(stub.calls, "UPDATE ai_runs")).toHaveLength(1);
  });

  it("demotes the lying-ISBN listing: rejected evidence, zero links", async () => {
    const stub = makeStub({ candidates: [EJ_EDITION] });
    const outcome = await linkListingPathA(stub, LYING);
    expect(outcome.status).toBe("demoted");
    if (outcome.status === "demoted") {
      expect(outcome.bands.title).toBe("mismatch");
    }
    expect(callsTo(stub.calls, "INSERT INTO listing_links")).toHaveLength(0);
    const evidence = callsTo(stub.calls, "INSERT INTO evidence");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].values).toContain("rejected");
  });

  it("unlinks a pre-existing link that stops agreeing", async () => {
    const stub = makeStub({
      candidates: [EJ_EDITION],
      existingLink: {
        edition_ref_id: 11n,
        work_ref_id: 21n,
        local_work_id: null,
      },
    });
    const outcome = await linkListingPathA(stub, LYING);
    expect(outcome.status).toBe("demoted");
    expect(callsTo(stub.calls, "DELETE FROM listing_links")).toHaveLength(1);
    const events = callsTo(stub.calls, "INSERT INTO identity_events");
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain("'unlink'");
  });

  it("reports already_linked and writes nothing on an unchanged re-add", async () => {
    const stub = makeStub({
      candidates: [EJ_EDITION],
      existingLink: {
        edition_ref_id: 11n,
        work_ref_id: 21n,
        local_work_id: null,
      },
    });
    const outcome = await linkListingPathA(stub, HONEST);
    expect(outcome.status).toBe("already_linked");
    expect(callsTo(stub.calls, "INSERT INTO listing_links")).toHaveLength(0);
    expect(callsTo(stub.calls, "INSERT INTO evidence")).toHaveLength(0);
  });

  it("makes no attempt for missing or invalid ISBNs", async () => {
    const stub = makeStub({ candidates: [EJ_EDITION] });
    expect(
      (await linkListingPathA(stub, { ...HONEST, isbn: "" })).status,
    ).toBe("no_isbn");
    expect(
      (await linkListingPathA(stub, { ...HONEST, isbn: "9780134685992" }))
        .status,
    ).toBe("invalid_isbn");
    expect(stub.calls).toHaveLength(0);
  });

  it("canonicalises a hyphenated ISBN-13 before joining", async () => {
    const stub = makeStub({ candidates: [EJ_EDITION] });
    const outcome = await linkListingPathA(stub, {
      ...HONEST,
      isbn: "978-0-13-468599-1",
    });
    expect(outcome.status).toBe("linked");
    const join = callsTo(stub.calls, "FROM isbn_index i");
    expect(join[0].values).toContain("9780134685991");
  });

  it("canonicalises a lowercase-x ISBN-10 before joining", async () => {
    const stub = makeStub({
      candidates: [
        {
          edition_id: 12n,
          edition_title: "The Design of Everyday Things",
          work_ref_id: 22n,
          work_title: "The Design of Everyday Things",
          author_display: "Don Norman",
        },
      ],
    });
    const outcome = await linkListingPathA(stub, {
      id: 57n,
      isbn: "080442957x",
      title: "The Design of Everyday Things",
      author: "Don Norman",
    });
    expect(outcome.status).toBe("linked");
    const join = callsTo(stub.calls, "FROM isbn_index i");
    expect(join[0].values).toContain("9780804429573");
  });

  it("falls back to one OL lookup on an index miss and links by source_key", async () => {
    const stub = makeStub({ candidates: [], fallbackCandidate: EJ_EDITION });
    const seen: string[] = [];
    const outcome = await linkListingPathA(
      {
        ...stub,
        lookupEdition: async (isbn13) => {
          seen.push(isbn13);
          return {
            editionKey: "/books/OL7356322M",
            workKey: "/works/OL45883W",
            title: "Effective Java",
            publisher: "Addison-Wesley",
            publicationYear: 2018,
            pageCount: 412,
            language: "eng",
          };
        },
      },
      HONEST,
    );
    expect(seen).toEqual(["9780134685991"]);
    expect(outcome.status).toBe("linked");
    if (outcome.status === "linked") {
      expect(outcome.source).toBe("open_library");
    }
    const runInsert = callsTo(stub.calls, "INSERT INTO ai_runs");
    const serialised = JSON.stringify(runInsert[0].values, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialised).toContain("open_library");
  });

  it("reports no_candidate when the fallback finds nothing usable", async () => {
    const stub = makeStub({ candidates: [], fallbackCandidate: null });
    const outcome = await linkListingPathA(
      { ...stub, lookupEdition: async () => null },
      HONEST,
    );
    expect(outcome.status).toBe("no_candidate");
    expect(callsTo(stub.calls, "INSERT INTO listing_links")).toHaveLength(0);
  });

  it("survives a throwing fallback (treated as a miss)", async () => {
    const stub = makeStub({ candidates: [] });
    const outcome = await linkListingPathA(
      {
        ...stub,
        lookupEdition: async () => {
          throw new Error("network down");
        },
      },
      HONEST,
    );
    expect(outcome.status).toBe("no_candidate");
  });

  it("proposes instead of linking when two candidates both pass", async () => {
    const secondPrinting: CandidateRow = {
      ...EJ_EDITION,
      edition_id: 12n,
      edition_title: "Effective Java (3rd Edition)",
    };
    const stub = makeStub({ candidates: [EJ_EDITION, secondPrinting] });
    const outcome = await linkListingPathA(stub, HONEST);
    expect(outcome.status).toBe("ambiguous");
    expect(callsTo(stub.calls, "INSERT INTO listing_links")).toHaveLength(0);
    const evidence = callsTo(stub.calls, "INSERT INTO evidence");
    expect(evidence).toHaveLength(2);
    expect(evidence[0].values).toContain("proposed");
  });

  it("ignores editions whose work is unknown (not linkable targets)", async () => {
    const stub = makeStub({
      candidates: [{ ...EJ_EDITION, work_ref_id: null, work_title: null }],
    });
    const outcome = await linkListingPathA(stub, HONEST);
    expect(outcome.status).toBe("no_candidate");
  });
});

// ---------------------------------------------------------------------------
// F3 option C (LAYOUT-DECISION §3): a rolled-back link attempt must
// leave exactly one finished 'error' ai_run (the compensating record,
// written on the non-transactional handle after rollback) and no link;
// the success path must be unchanged — one 'ok' run committed
// atomically with the link. This stub models a REAL transaction:
// statements issued through the tx runner land in a pending buffer
// that is committed only when the callback resolves and discarded
// when it throws (rollback); the outer runner persists immediately.
// ---------------------------------------------------------------------------

function makeTransactionalStub(config: StubConfig & { failOn?: string }) {
  const persisted: { text: string; values: QueryValue[] }[] = [];
  const rolledBack: { text: string; values: QueryValue[] }[] = [];

  const serve = async (
    log: { text: string; values: QueryValue[] }[],
    text: string,
    values: QueryValue[],
  ): Promise<QueryRow[]> => {
    log.push({ text, values });
    const rows = (value: unknown): QueryRow[] => value as QueryRow[];
    if (text.includes("FROM isbn_index i")) {
      return rows(config.candidates ?? []);
    }
    if (text.includes("e.source_key = $1")) {
      return rows(config.fallbackCandidate ? [config.fallbackCandidate] : []);
    }
    if (text.includes("FROM listing_links WHERE")) {
      return rows(config.existingLink ? [config.existingLink] : []);
    }
    if (text.includes("INSERT INTO ai_runs")) {
      return [{ id: 42 }];
    }
    if (text.includes("UPDATE ai_runs")) {
      return [{ id: 42 }];
    }
    if (text.includes("INSERT INTO evidence")) {
      return [{ id: 7n }];
    }
    return [];
  };

  const run: QueryRunner = async (text, values) => serve(persisted, text, values);
  const begin: TransactionRunner = async (fn) => {
    const pending: { text: string; values: QueryValue[] }[] = [];
    const txRun: QueryRunner = async (text, values) => {
      if (config.failOn !== undefined && text.includes(config.failOn)) {
        pending.push({ text, values });
        throw new Error(`forced failure at ${config.failOn}`);
      }
      return serve(pending, text, values);
    };
    try {
      const result = await fn(txRun);
      persisted.push(...pending);
      return result;
    } catch (err) {
      rolledBack.push(...pending);
      throw err;
    }
  };
  return { run, begin, persisted, rolledBack };
}

describe("linkListingPathA — F3 compensating ai_runs (option C)", () => {
  it("(i) a forced link failure leaves exactly one finished 'error' ai_run and zero listing_links", async () => {
    const stub = makeTransactionalStub({
      candidates: [EJ_EDITION],
      failOn: "INSERT INTO listing_links",
    });
    await expect(linkListingPathA(stub, HONEST)).rejects.toThrow(
      "forced failure at INSERT INTO listing_links",
    );
    // Zero links persisted; the in-transaction attempt (including its
    // own ai_runs insert) rolled back with everything else.
    expect(callsTo(stub.persisted, "INSERT INTO listing_links")).toHaveLength(0);
    expect(callsTo(stub.rolledBack, "INSERT INTO ai_runs")).toHaveLength(1);
    expect(callsTo(stub.rolledBack, "INSERT INTO listing_links")).toHaveLength(1);
    // Exactly one ai_run persisted: the compensating record, started
    // AND finished on the outer handle — never left 'running'.
    const runInserts = callsTo(stub.persisted, "INSERT INTO ai_runs");
    expect(runInserts).toHaveLength(1);
    // startRun values: [parent, kind, provider, model, promptId,
    // promptVersion, input, listingId] — the attempt's inputs carried.
    expect(runInserts[0].values[1]).toBe("derive_listing_links");
    expect(runInserts[0].values[6]).toEqual({
      path: "a",
      isbn13: "9780134685991",
      source: "isbn_index",
    });
    const runFinishes = callsTo(stub.persisted, "UPDATE ai_runs");
    expect(runFinishes).toHaveLength(1);
    // finishRun values: [output, inTok, outTok, neurons, status, error, id]
    expect(runFinishes[0].values[4]).toBe("error");
    expect(runFinishes[0].values[5]).toBe(
      "forced failure at INSERT INTO listing_links",
    );
    const output = runFinishes[0].values[0] as Record<string, unknown>;
    expect(output["compensated"]).toBe(true);
    expect(output["edition_ref_id"]).toBe("11");
  });

  it("(ii) the success path is unchanged: one 'ok' run committed atomically with the link, no compensating run", async () => {
    const stub = makeTransactionalStub({ candidates: [EJ_EDITION] });
    const outcome = await linkListingPathA(stub, HONEST);
    expect(outcome.status).toBe("linked");
    expect(stub.rolledBack).toHaveLength(0);
    // One run, started and finished inside the same commit as the link.
    expect(callsTo(stub.persisted, "INSERT INTO ai_runs")).toHaveLength(1);
    const runFinishes = callsTo(stub.persisted, "UPDATE ai_runs");
    expect(runFinishes).toHaveLength(1);
    expect(runFinishes[0].values[4]).toBe("ok");
    expect(runFinishes[0].values[5]).toBeNull();
    expect(callsTo(stub.persisted, "INSERT INTO listing_links")).toHaveLength(1);
    // The link's derivation_run_id is the run the transaction opened.
    const link = callsTo(stub.persisted, "INSERT INTO listing_links")[0];
    expect(link.values).toContain(42);
  });
});

describe("lookupLocalPrefill", () => {
  it("maps the earliest edition for the ISBN", async () => {
    const run: QueryRunner = async () => [
      {
        title: "Effective Java",
        publisher: "Addison-Wesley",
        publish_year: 2018,
        page_count: 412,
        author_display: "Joshua Bloch",
        categories: ["Computers", "Programming"],
      },
    ];
    const prefill = await lookupLocalPrefill(run, "9780134685991");
    expect(prefill).toEqual({
      title: "Effective Java",
      author: "Joshua Bloch",
      publisher: "Addison-Wesley",
      publicationYear: 2018,
      pageCount: 412,
      categories: ["Computers", "Programming"],
    });
  });

  it("returns null on an index miss", async () => {
    const run: QueryRunner = async () => [];
    expect(await lookupLocalPrefill(run, "9780134685991")).toBeNull();
  });
});
