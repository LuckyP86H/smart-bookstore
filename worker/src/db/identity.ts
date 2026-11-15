// Path A — ISBN identity resolution (plan §3.1, Step 4).
//
// A listing arrives with marketplace-shaped data and (sometimes) an
// ISBN. Path A derives the canonical ISBN-13, joins the slice-scoped
// isbn_index to the edition that ISBN names, checks the listing's own
// title/author against that edition (the lying-ISBN guard), and only
// then writes the listing_links row — with its full lineage: an
// ai_runs pair, an evidence row, a listing_facets row, and an
// identity_events row, per the PR 2 schema's semantics.
//
// Properties the plan demands and this module keeps:
//   * Join-only. The listing's stored ISBN and the books upsert are
//     untouched (P3 parity); linking runs after the upsert.
//   * An invalid ISBN is not an error — it is no evidence. No attempt.
//   * Guard disagreement NEVER auto-links: the candidate is recorded
//     as rejected evidence (negative lineage, the §12 item-1 pattern),
//     and a pre-existing auto-link that stops agreeing is removed.
//   * Multiple guard-passing candidates NEVER auto-link either: each
//     is recorded as proposed evidence for the review band (Step 6).
//   * Google Books is never consulted here. The only fallback for an
//     index miss is ONE Open Library ISBN lookup (injected, rate-
//     limited + memoised by the caller); its result only counts when
//     the edition it names is already in the reference tables — the
//     API response itself is never persisted (§4.1).
//
// A listing added through AddBook gets exactly one Path A pass, at add
// time. Re-derivation over existing listings is a later step's batch
// job (the tasks table), not something AddBook retries silently.

import { finishRun, startRun } from "../ai/runs";
import {
  agreementBands,
  bandsPass,
  bandsScore,
  normalizeForAgreement,
  type AgreementBands,
} from "../identity/agreement";
import { canonicalISBN13 } from "../identity/isbn13";
import type { OlEditionInfo } from "../external/open-library";
import type { Db, QueryRunner, TransactionRunner } from "./client";

export interface PathADeps {
  run: QueryRunner;
  begin: TransactionRunner;
  /** Single-lookup fallback for index misses (Open Library). */
  lookupEdition?: (isbn13: string) => Promise<OlEditionInfo | null>;
}

export interface ListingForLinking {
  id: bigint;
  isbn: string;
  title: string;
  author: string;
}

export type LinkOutcome =
  | { status: "no_isbn" }
  | { status: "invalid_isbn" }
  | { status: "no_candidate"; isbn13: string }
  | { status: "ambiguous"; isbn13: string; candidateCount: number }
  | { status: "demoted"; isbn13: string; bands: AgreementBands }
  | {
      status: "linked" | "already_linked";
      isbn13: string;
      editionId: bigint;
      workRefId: bigint;
      source: "isbn_index" | "open_library";
      bands: AgreementBands;
    };

interface Candidate {
  editionId: bigint;
  editionTitle: string | null;
  workRefId: bigint | null;
  workTitle: string | null;
  authorDisplay: string | null;
}

interface ExistingLink {
  editionRefId: bigint | null;
  workRefId: bigint | null;
  localWorkId: bigint | null;
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }
  return BigInt(String(value));
}

function toTextOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

const CANDIDATE_COLUMNS = `
  e.id AS edition_id, e.title AS edition_title,
  e.work_ref_id AS work_ref_id, w.title AS work_title,
  wk.author_display AS author_display`;

function candidateFromRow(row: Record<string, unknown>): Candidate {
  return {
    editionId: toBigIntOrNull(row["edition_id"]) ?? 0n,
    editionTitle: toTextOrNull(row["edition_title"]),
    workRefId: toBigIntOrNull(row["work_ref_id"]),
    workTitle: toTextOrNull(row["work_title"]),
    authorDisplay: toTextOrNull(row["author_display"]),
  };
}

async function candidatesByIsbn(
  run: QueryRunner,
  isbn13: string,
): Promise<Candidate[]> {
  const rows = await run(
    `SELECT ${CANDIDATE_COLUMNS}
     FROM isbn_index i
     JOIN ref_editions e ON e.id = i.edition_ref_id
     LEFT JOIN ref_works w ON w.id = e.work_ref_id
     LEFT JOIN works wk ON wk.work_ref_id = e.work_ref_id
     WHERE i.isbn13 = $1
     ORDER BY e.id`,
    [isbn13],
  );
  return rows.map(candidateFromRow);
}

async function candidateByEditionKey(
  run: QueryRunner,
  editionKey: string,
): Promise<Candidate | null> {
  const rows = await run(
    `SELECT ${CANDIDATE_COLUMNS}
     FROM ref_editions e
     LEFT JOIN ref_works w ON w.id = e.work_ref_id
     LEFT JOIN works wk ON wk.work_ref_id = e.work_ref_id
     WHERE e.source = 'openlibrary' AND e.source_key = $1
     ORDER BY e.snapshot_id
     LIMIT 1`,
    [editionKey],
  );
  return rows.length === 0 ? null : candidateFromRow(rows[0]);
}

async function getExistingLink(
  run: QueryRunner,
  listingId: bigint,
): Promise<ExistingLink | null> {
  const rows = await run(
    `SELECT edition_ref_id, work_ref_id, local_work_id
     FROM listing_links WHERE listing_id = $1`,
    [listingId],
  );
  if (rows.length === 0) {
    return null;
  }
  return {
    editionRefId: toBigIntOrNull(rows[0]["edition_ref_id"]),
    workRefId: toBigIntOrNull(rows[0]["work_ref_id"]),
    localWorkId: toBigIntOrNull(rows[0]["local_work_id"]),
  };
}

async function insertEvidence(
  runner: QueryRunner,
  listingId: bigint,
  candidate: Candidate,
  bands: AgreementBands,
  outcome: "auto_linked" | "proposed" | "rejected",
): Promise<bigint> {
  // The schema's exactly-one-candidate CHECK: an evidence row names
  // ONE candidate. For Path A that is the edition the ISBN resolved
  // to (the work is reached through the edition, never named twice).
  const rows = await runner(
    `INSERT INTO evidence
       (listing_id, candidate_edition_id, candidate_work_id,
        candidate_local_work_id, model_version_id, total_score, weights,
        bands, outcome)
     VALUES ($1, $2, NULL, NULL, NULL, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING id`,
    [
      listingId,
      candidate.editionId,
      bandsScore(bands),
      { isbn: 1 },
      bands,
      outcome,
    ],
  );
  return toBigIntOrNull(rows[0]?.["id"]) ?? 0n;
}

function linkStateJson(link: ExistingLink | null): Record<string, unknown> {
  if (link === null) {
    return { link: null };
  }
  return {
    edition_ref_id: link.editionRefId?.toString() ?? null,
    work_ref_id: link.workRefId?.toString() ?? null,
    local_work_id: link.localWorkId?.toString() ?? null,
  };
}

async function writeLink(
  deps: PathADeps,
  listing: ListingForLinking,
  isbn13: string,
  source: "isbn_index" | "open_library",
  candidate: Candidate & { workRefId: bigint },
  bands: AgreementBands,
  existing: ExistingLink | null,
): Promise<void> {
  // F3 option C (LAYOUT-DECISION §3, user-decided 2026-11-15): the
  // success path below is exactly the original shape — startRun /
  // finishRun inside the link transaction, so a committed 'ok' run
  // always corresponds to a committed link. Only the failure path is
  // new: when the transaction rolls back, its ai_runs row vanishes
  // with it, so the catch block writes ONE compensating run on the
  // non-transactional handle (see writeCompensatingErrorRun).
  const runInput = { path: "a", isbn13, source };
  try {
    await deps.begin(async (tx) => {
      // ai/runs.ts works against the Db shape; inside the transaction
      // the run's writes must go through the tx runner.
      const txDb: Db = { run: tx, begin: deps.begin, close: async () => {} };
      const runId = await startRun(txDb, {
        kind: "derive_listing_links",
        provider: "worker",
        listingId: listing.id,
        input: runInput,
      });
      const evidenceId = await insertEvidence(
        tx,
        listing.id,
        candidate,
        bands,
        "auto_linked",
      );
      await tx(
        `INSERT INTO listing_links
         (listing_id, edition_ref_id, work_ref_id, local_work_id,
          status, derivation_run_id)
       VALUES ($1, $2, $3, NULL, 'automatic', $4)
       ON CONFLICT (listing_id) DO UPDATE SET
         edition_ref_id = EXCLUDED.edition_ref_id,
         work_ref_id = EXCLUDED.work_ref_id,
         local_work_id = NULL,
         status = 'automatic',
         derivation_run_id = EXCLUDED.derivation_run_id,
         updated_at = now()`,
        [listing.id, candidate.editionId, candidate.workRefId, runId],
      );
      // Minimal facets (the §3.2 facet PARSER is PR 4's Path B work;
      // Path A records the join inputs it actually used).
      await tx(
        `INSERT INTO listing_facets
         (listing_id, isbn13, title_key, author_keys, language)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (listing_id) DO UPDATE SET
         isbn13 = EXCLUDED.isbn13,
         title_key = EXCLUDED.title_key,
         author_keys = EXCLUDED.author_keys,
         updated_at = now()`,
        [
          listing.id,
          isbn13,
          normalizeForAgreement(listing.title) || null,
          [normalizeForAgreement(listing.author)].filter((a) => a !== ""),
        ],
      );
      await tx(
        `INSERT INTO identity_events
         (listing_id, event_type, actor, from_state, to_state,
          evidence_ids, manifest)
       VALUES ($1, $2, 'path-a', $3::jsonb, $4::jsonb, $5, $6::jsonb)`,
        [
          listing.id,
          existing === null ? "link" : "relink",
          linkStateJson(existing),
          {
            edition_ref_id: candidate.editionId.toString(),
            work_ref_id: candidate.workRefId.toString(),
          },
          [evidenceId],
          { path: "a", isbn13, source, bands },
        ],
      );
      await finishRun(txDb, runId, {
        output: {
          edition_ref_id: candidate.editionId.toString(),
          work_ref_id: candidate.workRefId.toString(),
          bands,
        },
      });
    });
  } catch (err) {
    // The link transaction has rolled back by the time control reaches
    // here (deps.begin rejects only after rollback), so the attempt's
    // in-transaction ai_runs row is gone. Record the failure on the
    // outer handle, then rethrow the ORIGINAL error: callers keep the
    // exact failure they would have seen without the ledger write
    // (AddBook's caller logs it; link_seed aborts on it).
    await writeCompensatingErrorRun(deps, listing, runInput, candidate, bands, err);
    throw err;
  }
}

/**
 * F3 option C's compensating record: ONE ai_runs row for a rolled-back
 * link attempt, written start+finish on the non-transactional handle
 * so it is born in its terminal 'error' state — this path can never
 * leave an orphaned 'running' row. It carries the attempt's inputs
 * (the same payload the in-transaction startRun used) and the caught
 * error; it cannot carry the rolled-back run's id, which never
 * committed — the inputs are the linkage. A failure of the
 * compensating write itself is swallowed: the ledger must never mask
 * or replace the real link failure the caller is about to receive.
 */
async function writeCompensatingErrorRun(
  deps: PathADeps,
  listing: ListingForLinking,
  runInput: { path: string; isbn13: string; source: "isbn_index" | "open_library" },
  candidate: Candidate & { workRefId: bigint },
  bands: AgreementBands,
  err: unknown,
): Promise<void> {
  const outerDb: Db = { run: deps.run, begin: deps.begin, close: async () => {} };
  try {
    const runId = await startRun(outerDb, {
      kind: "derive_listing_links",
      provider: "worker",
      listingId: listing.id,
      input: runInput,
    });
    await finishRun(outerDb, runId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      output: {
        edition_ref_id: candidate.editionId.toString(),
        work_ref_id: candidate.workRefId.toString(),
        bands,
        compensated: true,
      },
    });
  } catch {
    // Deliberately empty — see the doc comment above.
  }
}

async function writeDemotion(
  deps: PathADeps,
  listing: ListingForLinking,
  isbn13: string,
  named: { candidate: Candidate; bands: AgreementBands },
  existing: ExistingLink | null,
): Promise<void> {
  if (existing === null) {
    await insertEvidence(
      deps.run,
      listing.id,
      named.candidate,
      named.bands,
      "rejected",
    );
    return;
  }
  // A link existed and the listing no longer agrees with it: remove it
  // and leave the full trail (rejected evidence + unlink event).
  await deps.begin(async (tx) => {
    const evidenceId = await insertEvidence(
      tx,
      listing.id,
      named.candidate,
      named.bands,
      "rejected",
    );
    await tx(`DELETE FROM listing_links WHERE listing_id = $1`, [listing.id]);
    await tx(
      `INSERT INTO identity_events
         (listing_id, event_type, actor, from_state, to_state,
          evidence_ids, manifest)
       VALUES ($1, 'unlink', 'path-a', $2::jsonb, $3::jsonb, $4, $5::jsonb)`,
      [
        listing.id,
        linkStateJson(existing),
        { link: null },
        [evidenceId],
        {
          path: "a",
          isbn13,
          reason: "guard_disagreement",
          bands: named.bands,
        },
      ],
    );
  });
}

/**
 * One Path A pass over one listing. See the module header for the
 * rules; the outcome is returned (never thrown) for every data-shaped
 * situation — only infrastructure failures (DB down) propagate.
 */
export async function linkListingPathA(
  deps: PathADeps,
  listing: ListingForLinking,
): Promise<LinkOutcome> {
  if (listing.isbn.trim() === "") {
    return { status: "no_isbn" };
  }
  const isbn13 = canonicalISBN13(listing.isbn);
  if (isbn13 === null) {
    return { status: "invalid_isbn" };
  }

  let source: "isbn_index" | "open_library" = "isbn_index";
  let candidates = await candidatesByIsbn(deps.run, isbn13);
  if (candidates.length === 0 && deps.lookupEdition !== undefined) {
    let ol: OlEditionInfo | null = null;
    try {
      ol = await deps.lookupEdition(isbn13);
    } catch {
      ol = null; // an unavailable fallback is a miss, not a failure
    }
    if (ol !== null && ol.editionKey !== "") {
      const found = await candidateByEditionKey(deps.run, ol.editionKey);
      if (found !== null) {
        candidates = [found];
        source = "open_library";
      }
    }
  }

  // An edition with no work cannot be a listing_links target (the
  // schema requires edition+work together), so it is not a candidate.
  const linkable = candidates.filter(
    (c): c is Candidate & { workRefId: bigint } => c.workRefId !== null,
  );
  if (linkable.length === 0) {
    return { status: "no_candidate", isbn13 };
  }

  const scored = linkable.map((candidate) => ({
    candidate,
    bands: agreementBands(listing, candidate),
  }));
  const passing = scored.filter((s) => bandsPass(s.bands));
  const existing = await getExistingLink(deps.run, listing.id);

  if (passing.length === 1) {
    const { candidate, bands } = passing[0];
    if (
      existing !== null &&
      existing.editionRefId === candidate.editionId &&
      existing.workRefId === candidate.workRefId &&
      existing.localWorkId === null
    ) {
      return {
        status: "already_linked",
        isbn13,
        editionId: candidate.editionId,
        workRefId: candidate.workRefId,
        source,
        bands,
      };
    }
    await writeLink(deps, listing, isbn13, source, candidate, bands, existing);
    return {
      status: "linked",
      isbn13,
      editionId: candidate.editionId,
      workRefId: candidate.workRefId,
      source,
      bands,
    };
  }

  if (passing.length > 1) {
    // Genuine ambiguity between editions of (usually) the same work:
    // precision first — propose all, link none (Step 6's review band).
    for (const { candidate, bands } of passing) {
      await insertEvidence(deps.run, listing.id, candidate, bands, "proposed");
    }
    return { status: "ambiguous", isbn13, candidateCount: passing.length };
  }

  // Candidates exist but none agree: the lying-ISBN demotion. The
  // named candidate is the least-disagreeing one, for the evidence row.
  const named = [...scored].sort(
    (a, b) => bandsScore(b.bands) - bandsScore(a.bands),
  )[0];
  await writeDemotion(deps, listing, isbn13, named, existing);
  return { status: "demoted", isbn13, bands: named.bands };
}

export interface LocalPrefill {
  title: string;
  author: string;
  publisher: string;
  publicationYear: number;
  pageCount: number;
  categories: string[];
}

/**
 * The LookupBookByISBN local-index step (§4.6 order step 1): the ISBN
 * is already in the seeded catalogue, so the prefill comes from the
 * reference tables — no API call at all. When several editions share
 * the ISBN (printings), the earliest-loaded edition wins; the form is
 * a prefill, and the merchant confirms the details.
 */
export async function lookupLocalPrefill(
  run: QueryRunner,
  isbn13: string,
): Promise<LocalPrefill | null> {
  const rows = await run(
    `SELECT e.title AS title, e.publisher AS publisher,
            e.publish_year AS publish_year, e.page_count AS page_count,
            wk.author_display AS author_display,
            wk.categories AS categories
     FROM isbn_index i
     JOIN ref_editions e ON e.id = i.edition_ref_id
     LEFT JOIN works wk ON wk.work_ref_id = e.work_ref_id
     WHERE i.isbn13 = $1
     ORDER BY e.id
     LIMIT 1`,
    [isbn13],
  );
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  const categories = row["categories"];
  return {
    title: toTextOrNull(row["title"]) ?? "",
    author: toTextOrNull(row["author_display"]) ?? "",
    publisher: toTextOrNull(row["publisher"]) ?? "",
    publicationYear:
      toBigIntOrNull(row["publish_year"]) === null
        ? 0
        : Number(toBigIntOrNull(row["publish_year"])),
    pageCount:
      toBigIntOrNull(row["page_count"]) === null
        ? 0
        : Number(toBigIntOrNull(row["page_count"])),
    categories: Array.isArray(categories)
      ? categories.map((c) => String(c))
      : [],
  };
}
