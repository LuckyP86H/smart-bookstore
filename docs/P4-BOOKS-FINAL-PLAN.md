# P4 Act 1 — BOOKS, final plan （图书定版计划）

- Repo: LuckyP86H/smart-bookstore · Branch `feat/worker-native-route-b` @ `5d0e5eab` (P0–P3 done)
- In-repo copy: the P4 Act 1 final plan (owner's v2 + §15 addendum, 2026-11-11).
- Direction: **Direction 1, owner's cut** — books, computed identity, Open Library spine. Chosen by the
  owner 2026-11-10 after the challenge rounds (v1 synthesis → v2 audit/re-cut → v3/v4 records pivot →
  three-pass V4 review). The records pivot and Pokémon were dropped by the owner (per-item dual-rights
  clearance labour; Pokémon API offline 2027-03-01). This document is the buildable consolidation.
- Authority, in order: the owner's decisions of 2026-11-09/10 → `SYNTHESIS.v2.md` §2/§3/§5 (the audited
  re-cut; its surviving machinery is owner-endorsed) → challenge `SYNTHESIS.md` Direction 1 →
  `P4-ACT1-PLAN.md` (sequencing discipline, T4 verification, migration approach carry over; its
  ISBN-keyed works layer does **not**) → `V4-REVIEW.md` (transferable findings + failure lessons only).
- Status: PLANNING ONLY. No code, no pushes, no DB changes were made for this document. Building
  starts only on the owner's nod on this plan.
- Scope in one line: replace the ISBN-derived `work_key` with a **computed identity engine**
  (link-first to an offline-built Open Library reference catalogue; score only the residue;
  assertions and evidence are the stored truth; links are derived and reversible), seed a **real
  OL slice** (~1–5k works incl. adversarial cases), ship **work pages** over derived membership,
  and land the **Jev copyright-page flow** behind a benchmark gate with a measured non-Jev fallback.

---

## 0. What changed versus the original Act 1 plan — and where the sources disagreed

The original plan's skeleton survives (migration series authored in repo and applied by the owner;
staging-smoke discipline; `ai_runs` + prompt registry; `GetWork` + work page; owner-run backfill).
Its centre of gravity does not: the queue-driven enrich pipeline around an ISBN key is replaced by
the identity engine. Five disagreements between the source documents were resolved as follows —
each is flagged again where it lands:

| # | Disagreement | Resolution in this plan |
|---|---|---|
| D1 | **Clustering vs linking.** Challenge synthesis (v1) designs listing↔listing clustering throughout, with merges/splits as events *on work ids*. v2 §2.3 Rule 3 corrects both: link listings to reference works first (linear cost, no chaining), cluster only the residue; store **evidence + assertions on stable record ids**, because an event naming a cluster stops meaning anything once re-clustering dissolves the cluster. | v2 governs. Candidate pairs, scoring, vetoes and thresholds (§3) are implemented over listing↔candidate evidence rows; derived-membership changes are logged as audit events carrying the evidence receipt (§3.6) — the brief's "event-sourced, reversible" requirement is met by derivation + receipts, not by cluster events. |
| D2 | **Queues: trio vs none.** The original plan + challenge synthesis keep Cloudflare Queues as transport in a trio (Queue + Postgres backlog + cron sweep). v2 §3.3 argues for removing Queues entirely (a task table + `pg_cron`/cron tick does everything; the queue only adds a 24 h retention and a 10k ops/day cap to work around). | **Revised 2026-11-10 after review, with the owner's go-ahead:** Act 1 builds the task table and the cron sweep only. **Postgres task/status tables are the system of record** (the point both sides agree on) and no job semantics ever live in a queue. The Cloudflare Queue is **not built in Act 1**: at tens of online jobs a day it would carry nothing the sweep does not. It stays the documented add-on (wake-up transport only, §5) if measured wake-up delay becomes a problem. |
| D3 | **Embedding model.** Original plan recipe v2: `@cf/baai/bge-small-en-v1.5` (384-dim, English-only). v2 §2.6: the current MiniLM/bge-small line *cannot* do EN/ZH matching; `bge-m3` (1,024-dim, multilingual) is required — and is cheaper (verified §1: 1,075 vs 1,841 neurons/M tokens). | **bge-m3 adopted.** Consequence: `books.embedding` changes `vector(384)` → `vector(1024)` in the new migration series. The live catalog is empty, so the switch costs nothing today — the one moment it ever will. |
| D4 | **"The database is empty."** The original plan's verified fact is narrow: live `books` count = 0 (P0). V4 review 2B caught the widening of that fact into "the database is empty". Re-checked live on 2026-11-10: the database is 11 MB with 3 migrations applied, and **all four tables — `stores`, `books`, `sales`, `reviews` — hold 0 rows**. No accounts exist remotely yet. | Facts are stated at verified scope throughout this plan. Step 2 is still a **live-DB schema migration** to be rehearsed, but it moves no data (§2, §9 risks). |
| D5 | **Review-aspect extraction in Act 1.** Original plan: `extract` job + `review_aspects` in Act 1. v2 §9.4: not in Act 1 — no real reviews exist, and synthetic rows must never feed insight features (§4.5 rule). | The `review_aspects` **table + counts view** are still created in Step 2 (cheap Act 3 substrate, as the original planned); the **extract job is deferred to Act 3**. |
| D6 | **Tracing.** Challenge synthesis: Langfuse ADOPT as disposable dual-write. v2 §10.12 leans ledger-only. | `ai_runs` (upgraded: `parent_run_id` + full input/output) is the only Act 1 system of record. Langfuse dual-write is an owner decision (§12), default **off**. |
| D7 | **Workflows as review successor.** Challenge synthesis: designated successor (`waitForEvent`). v2 §3.3: a pending review is a row, not a sleeping process. | v2 governs for Act 1: the review band is rows + assertions. Workflows are not adopted; revisit only if a genuinely multi-step waiting process appears. |

---

## 1. Verified figures (checked against official sources, 2026-11-10, unless dated)

**Open Library — dumps** (openlibrary.org/developers/dumps, read 2026-11-10):

| Item | Figure |
|---|---|
| Cadence | Monthly |
| Format | Tab-separated: `type · key · revision · last_modified · JSON` |
| Editions dump | ~9.2 GB gz |
| Works dump | ~2.9 GB gz |
| Authors dump | ~0.5 GB gz |
| All-types dump | ~12.4 GB gz (complete dump with revisions ~29.6 GB — not needed) |
| Wikidata dump (new) | ~700 MB — Wikidata records relevant to OL, currently authors only (the alias source for §3.7) |

**Open Library — API** (openlibrary.org/developers/api, read 2026-11-10):

| Item | Figure / rule |
|---|---|
| Default rate | **1 request/second** |
| Identified rate | **3 requests/second** — requires a `User-Agent` header naming the application + a contact email |
| Intended use | Human-time lookup. **Not a bulk backend** — bulk access is the dumps; OL asks apps to register their use-case and to cache responses |

**Open Library — Covers API** (openlibrary.org/dev/docs/api/covers, read 2026-11-10): access by
ISBN/OCLC/LCCN is rate-limited to **100 requests/IP per 5 minutes** (access by cover ID / OLID is
not under that limit); a missing cover returns a blank 1×1 image unless `?default=false` (then 404);
covers are for **display via hotlinked `covers.openlibrary.org` URLs — do not crawl, do not rehost**.

**Open Library — licence:** bibliographic data and user contributions are dedicated under
**CC0 1.0** (Creative Commons case study on Open Library; OL FAQ ownership answer). The nuance v2
insists on, kept: the Internet Archive asserts no *new* rights and third-party rights may attach to
some content — covers are the standing example (link, never rehost). Every snapshot's manifest
(§4.2) records source + dump date so a terms change is detectable at refresh time.

**Cloudflare Queues** (T4, verified 2026-11-09 against the official Workers pricing page; carried
from the original plan §1): Free = **10,000 operations/day** account-wide; one delivered message
< 64 KB = 3 ops (write+read+delete) → **≈3,333 delivered messages/day**; retries +1 read op each;
Free retention **24 h, non-configurable**. Act 1 volumes are ~1% of this (§5).

**Workers AI** (developers.cloudflare.com/workers-ai/platform/pricing/, page updated 2026-10-20,
read 2026-11-10): Free allocation **10,000 neurons/day**; `@cf/baai/bge-m3` = **1,075 neurons per
M input tokens**; `@cf/baai/bge-small-en-v1.5` = 1,841 neurons/M; `@cf/meta/llama-3.2-11b-vision-instruct`
= 4,410 neurons/M input tokens (the non-Jev vision candidate, §7.4); `@cf/google/gemma-4-26b-a4b-it`
= 9,091 in / 27,273 out neurons per M tokens (v2's in-band second-opinion costing checks out:
≈600 in + 150 out ≈ 9.5 neurons/call → ~1,000 calls/day inside the free allocation).

**Jev / TypeSafe** (from V4-REVIEW Pass 1B, verified against vendor docs 2026-11-10; the live test
itself was run in-session by Claude on generated test images, not on real photographs): **$0.042 per M input tokens, output free; there is
no free tier** (prepaid credit required). Image input on Choice/Score/Noul is real but
vendor-labelled *experimental* (opt-in header `TypeSafe-Danger-Zone-Images: true`). **Box requires
Jev 1.14** — 1.13 rejects it. The 2026-11-10 test: **39 of 42 on the first pass** (round 1,
each case asked once). Counting re-asks and re-runs it is 70 of 74, or 66 of 70 by the V4 review's
cut. Misses concentrated in Locate (16/19). A 1,200-pixel image cost about 3,800 input tokens per
copy. Rounds 2 and 3 named the image asset `i`, so every letter i in a question attached another
copy of the image; that script bug, not a platform limit, caused the nine context errors and
inflated the 151,000-token total ($0.0063). Scripts, images and raw answers are in
`research/jev-test-2026-11-10/`. Standard-plan data posture: no
training on customer input; zero-data-retention is enterprise-only; hosting is US.

**Carried platform facts** (from the original plan §0, verified 2026-11-09): schema = 3 migrations,
4 tables (`stores`, `books`, `sales`, `reviews`); `books.isbn varchar(20)` nullable,
`UNIQUE(store_id, isbn)`; `books.embedding extensions.vector(384)` HNSW; RLS on, 0 policies, app
connects as table owner. **Live `books` count = 0** (P0); the database as a whole is ~11 MB (v2 [F]).

---

## 2. Ground truth and starting posture

- Branch head `5d0e5eab`; P0–P3 parity surface (8 read + 6 write RPCs, PBKDF2 auth) is frozen —
  identity work must not change `AddBook` behaviour or the `(store_id, isbn)` upsert key (v2 §2.3
  Rule 1). Identity reads **derived** keys, never the stored ones.
- The catalog is unseeded remotely (`stores`, `books`, `sales` and `reviews` all hold 0 rows,
  re-checked 2026-11-10). All Act 1 verification therefore
  runs on scratch fixtures and the offline slice first; the live seed is an owner-run step (§10).
- Deploy blockers from earlier phases are unchanged by Act 1 and are **not** Act 1 content: owner
  credential rotation into Cloudflare secrets, first-deploy Durable-Object-class provisioning,
  Workers Paid declined. (V4 review B2 lesson: a plan must not claim a done-condition that
  owner-only provisioning silently gates — §10 lists every owner step up front instead.)
- Worker layout today has **no `ai/` module and no Workers AI binding** — both are Step 2/6
  deliverables, as in the original plan.
- **Route B does not deploy to production during Act 1, by the existing phase plan.** `wrangler.jsonc`
  still declares the Go and Python containers, which need the paid plan, and the original Act 1 plan
  assigns their removal to P5. Two further owner-only blockers stand beside it (credential rotation
  into secrets, first-deploy provisioning; V4 review B2). So every "staging" gate in §9 means the
  throwaway Worker used in P1–P3, with zero remote writes. §12 item 12 asks whether to change that.


---

## 3. The identity engine

Terminology (v2 §2, adopted verbatim): a **listing** is one store's offer (today's `books` row);
an **edition** is one published form (what an ISBN names); a **work** is the text across editions
and translations; the **reference catalogue** is our local Open Library copy; a **link** states
that a listing is a copy of an edition, and through it of a work; a **witness** is one source of
evidence about a link; an **assertion** is a person's decision that two things are, or are not,
the same.

**The routing rule (v2 §2.1): an ISBN decides which route an item takes and what it costs to
resolve. It never decides what the item is.** The with/without-ISBN split is kept — as a routing
rule, not an identity. The ISBN'd majority is never "classified" at all; it is joined.

### 3.1 The four populations and the three paths

"No ISBN" is three situations, and "has ISBN" hides a fourth (v2 §2.2):

| Population | Situation | Path |
|---|---|---|
| Has a valid ISBN | The majority | **Path A — lookup.** Canonical ISBN-13 (978-prefix + recomputed check digit — a ten-line function, *not* an identity problem) joins against the local ISBN index → edition → work. A local miss falls through to one identified OL API lookup (≤3 req/s), then to Path B with the ISBN kept as evidence. |
| Omitted | The book has an ISBN; the merchant didn't type it | **Assisted entry** (§3.5): at the add-book form, title+author candidates are shown while the merchant is still there; picking one recovers the ISBN and the item rejoins Path A. The merchant's answer is simultaneously the review and a labelled example. |
| Never had one | Pre-~1967–70 Western books; mainland Chinese books before 1987, which carry a 统一书号 (Unified Book Number) instead; zines/small-press/self-published | **Path B — evidence.** Other identifiers (LCCN, OCLC, 统一书号） are witnesses, not keys. |
| Unknown to the reference | Nothing in the reference matches | **Path C — residue.** Stays a singleton **local work**; re-tested at every reference refresh. |
| Lying ISBN | Checksum-valid ISBN naming a *different* book (mistyped into another valid number, publisher reuse) | Path A runs a cheap **agreement check** after the join (title/author vs the edition the ISBN names). Disagreement demotes the listing to Path B and flags it. v1's design had no guard for this row; this plan does. |

### 3.2 Path B — evidence, scoring, vetoes, thresholds

Candidate generation (**blocking**) per listing, against the reference slice and (for the residue)
against other unlinked listings: exact/canonical identifier pass · author-key + title-token pass ·
`pg_trgm` neighbours · embedding ANN neighbours over reference-work vectors (§6). Candidate recall
is a gated metric (§3.4) because a match never fetched can never be scored — the silent failure.

Each candidate pair is scored **Fellegi–Sunter-style**: per-field comparison bands converted to
log-odds weights, with the five soundness requirements from v2 §2.5:

1. **Weights are estimated without labels to start**: non-match agreement rates from random pairs,
   match rates by expectation–maximisation over candidate pairs (the classical fit; Splink is the
   reference implementation). Harvested labels (§3.4) choose thresholds and check calibration —
   they are not needed to begin.
2. **Rare values count for more**: term-frequency adjustment — agreement on 王伟 or "Complete
   Works" is weak; agreement on a rare title is strong.
3. **Correlated witnesses are not counted twice**: trigram similarity and embedding similarity of
   the same title are folded into one comparison taking the stronger band (or the final score is
   calibrated against the benchmark and thresholds set from *measured* precision, never from the
   nominal probability).
4. **Fit and serve with the same comparisons**: comparison bands are computed by the same SQL in
   fitting (laptop Postgres) and serving (Supabase), so fitted weights mean the same thing online.
5. **Vetoes are constraints on groups, not only pairs** (Path C): two groups containing a vetoed
   pair never merge; connected components of pairwise matches do not guarantee this, so grouping
   checks constraints explicitly. There are **two veto sets** — a language difference vetoes
   "same edition" and does not veto "same work".

**Witnesses** (v2 Rule 5 — every witness weighed, none decides alone): identifier agreement
(canonical ISBN, LCCN, OCLC, 统一书号） · the reference's own grouping · title similarity in bands ·
author agreement (alias-aware) · publication-year proximity · publisher · language · page count ·
embedding distance · Wikidata cross-script labels for authors and well-known works.

**Hard vetoes** (override any score): conflicting volume/part numbers · conflicting edition
statements · author conflict with no alias evidence · study-guide/companion markers （导读/解读/
summary/workbook) against the parent work · "same edition" across conflicting part numbers or
languages.

**Two thresholds, one human band:** above the upper threshold → auto-link; below the lower →
auto-reject (the pair is *kept*, §3.6); between → **proposed**, and waits in the review band.
The resting state below the band is exactly the owner's T5 decision: **singleton-by-default**.
A NULL-ISBN listing starts as a singleton local work and *graduates* when evidence — or the
owner's assertion — says so. T5 survives as the engine's prior; only its ISBN-key mechanism is
retired.

### 3.3 Editorial policy (defaults — owner's nod, §12; these become vetoes in code)

| Case | Same work? | Same edition? | Note |
|---|---|---|---|
| Translation | **Yes** | No | Goodreads and LibraryThing both combine translations (v2 [S]) |
| Abridgement vs unabridged | **No — separate sibling work**, linked by an explicit `abridgement_of` relation, flagged | No | Goodreads combines abridgements; LibraryThing separates them — the sites disagree (v2 [S]). Recommendation here is *separate*: an abridged text is a different reading experience, and price/rating comparison against the full text misleads — the same argument as volumes. This **differs from v2's default** (same work unless the reference separates them); flagged for the owner's nod precisely because it is his editorial call. Implementation: the sibling is a **variant under the same reference work id**, so Path A and snapshot refresh keep working. An abridgement with no marker in its metadata will still link to the parent; that is the known limit. |
| Annotated / critical / illustrated edition | Yes | No | |
| Study guide, summary, workbook, 导读/解读 companion | **No** | No | Hard veto against the parent work |
| Volumes of one multi-volume work （上/下， Vol. 1/2) | Yes | No | A `part` field is mandatory on the listing: a price for Vol. 1 is not comparable with a price for the set |
| Series members (book 1, book 2) | No | No | A series is a *relation* between works, not an identity |
| Box set / omnibus | Its own work | — | `contains` relations to members; deferred beyond Act 1 |

When unsure, follow how the reference catalogue models the case (v2 §2.8).

### 3.4 Benchmarks first — the ISBN'd half grades the ISBN-less half

No threshold is chosen and no witness added until a benchmark can say whether the change helped
(v2 Rule 6). The benchmark suite is built in Step 1, before engine code:

| Suite | Built from | Tests | Size |
|---|---|---|---|
| **B-mask** | Reference editions with the ISBN hidden | Path B end-to-end: candidate recall, auto-link precision | Thousands |
| **B-open** | B-mask with the true work *removed* from the reference | Declining to link when the answer is absent (the costliest error) | Thousands |
| **B-pairs** | Edition pairs inside one OL work (positives) vs different works by one author (hard negatives) — OL reports 6,438,282 works with ≥2 editions (v2 [A]) | The scorer on hard negatives; strata: volumes, translations, companions | Tens of thousands |
| **B-enzh** | Works with English + Chinese editions (958,112 OL works have ≥1 Chinese edition, v2 [A]); Wikidata labels in both scripts | The cross-language stratum | Hundreds–thousands |
| **B-shelf** | ~150 real books, hand-checked, incl. ISBN-less and pre-1987 Chinese items — the owner's own shelf entered as a store (§4.4) | Reality check on all of the above; the only hand-labelling in the plan | ~150 |

**Proposed gates** (v2 §2.4; owner's nod, §12):

| Measure | Gate |
|---|---|
| Candidate recall | ≥ 0.98 |
| Automatic-link precision | ≥ 0.99 observed on ≥1,000 automatic links (95% lower bound ≈ 0.98) |
| False-link rate when the answer is absent (B-open) | ≤ 1% |
| Share of Path B items left for a person | ≤ 10% |
| Recall | Reported, not gated (a missed link is visible and heals on confirmation) |
| Calibration | Plotted per model version |

The 0.99-on-1,000 precision gate applies to the large harvested suites (B-mask, B-pairs). B-shelf
(~150) and B-photo (~200) are too small to carry it and report with confidence intervals instead.

All measures also reported per stratum (language, era, multi-volume, translations, companions).
Known benchmark hazards, with countermeasures (v2 §2.4): masked books are younger/more-English/
metadata-richer than real ISBN-less books → weight the masked sample to the real profile and check
against B-shelf; the reference's own grouping contains duplicates only OL librarians may merge →
sample disagreements, and where a second opinion exists (LibraryThing ISBN→work, Wikidata
work→edition links) keep only positives both sources agree on; masking alone never tests the
absent-answer case → B-open exists for exactly that.

**Fallback written in advance:** if the precision gate cannot be met after two fitting rounds,
Path B ships **propose-only** (it ranks, a person confirms every link) and tuning stops. That is
still a better product than an ISBN key, and the decision is recorded with the numbers.

### 3.5 When resolution runs (v2 Rule 4 — resolve when it matters)

Path A always runs; it is a join. Path B runs in three situations only: (1) **at the add-book
form** — "is it one of these?" — the merchant's answer is the review *and* a labelled example;
(2) **when a listing is first viewed or sold**; (3) **a background sweep ordered by value**
(sales velocity, views, recency — §5). An ISBN-less listing nobody has looked at can stay a
singleton indefinitely. This is what keeps the review band at one person's scale: the owner is
the reviewer in Act 1 (§12).

### 3.6 What is stored, what is derived — receipts and negative lineage

Stored, as source of truth (new migration series, §9 Step 2):

- **Listings** — today's `books` rows, unchanged in shape; plus **listing facets**: canonical
  ISBN-13, normalised title key, author keys, part number, edition statement, format and companion
  markers, language. (The discriminating tokens are kept as fields, never normalised away.)
- **Reference tables** — `ref_works`, `ref_editions`, `ref_authors`, `ref_author_aliases`,
  `isbn_index` (canonical ISBN-13 → edition). Every row carries source, source key, snapshot id.
- **Evidence** — one row per listing↔candidate scored: comparison bands, weights applied, total,
  model version, outcome (auto-linked / proposed / rejected). **Rejected pairs are kept forever**
  — **negative lineage**: they are the threshold-tuning gold and the reason a rejected pair is
  never re-proposed unchanged.
- **Assertions** — a person's statement about two stable ids (same / not-same, at work or edition
  level), with who, when, reason. Assertions are constraints the derivation must respect,
  including vetoes between groups.
- **Model versions** — weights, thresholds, comparison definitions, and the benchmark results at
  fitting time.
- **Tasks** — the §5 work list, written in the same transaction as the listing it concerns.
- **`ai_runs`** — as the original plan, upgraded with `parent_run_id` and full input/output
  (D6: the only observability system of record).

Derived, rebuildable at any time:

- **Listing links** (`listing_links`: listing → edition → work, or → local work; status
  automatic/confirmed/proposed; derivation run id).
- **Local works** for the residue, grouped under assertion/veto constraints.
- **The display `works` projection** (§8): canonical fields, categories union, EN/ZH summaries,
  per-work rollups (offers, ratings) — computed through *current* membership at read time.

**Merge evidence receipts:** every change in derived membership (link, unlink, relink, group
merge/split) appends an `identity_events` row carrying its **evidence manifest**: the evidence
row ids, bands and weights, thresholds and model version in force, the actor (engine version or
the asserting person), and the prior state. A receipt proves *what evidence the decision rested
on* — it does not claim metaphysical truth (the PD-receipt lesson from the V4 proposals, kept at
its honest scope). Because sales and reviews stay attached to the listing they were written
against and roll up through the *current* link, **undoing a link instantly un-poisons a merged
review set** — reversibility is a property of the derivation, not a cleanup job.

### 3.7 English and Chinese (v2 §2.6 — first-class, not a stratum of leftovers)

- Normalise for comparison, keep the original for display: Unicode NFKC; traditional→simplified
  via OpenCC; 《》 and bracketed qualifiers parsed into facet fields, not discarded; a **pinyin key**
  for personal names （曹雪芹 ↔ "Cao Xueqin"); Wade–Giles forms ("Tsao Hsueh-chin") need alias data,
  not rules.
- **Wikidata earns its place here** — author names and famous-work titles across scripts (the new
  OL wikidata dump, ~700 MB, authors, is the harvest path). v1 dismissed Wikidata on ISBN counts;
  its value in this plan is aliases.
- Cross-language titles are translations, not transliterations （红楼梦 = *Dream of the Red
  Chamber* = *The Story of the Stone*): string similarity is useless; the evidence is author
  alias + multilingual embedding + the reference already holding both-language editions under one
  work + Wikidata labels. Expect this to be the hardest stratum; B-enzh reports it separately.
- `pg_trgm` on Chinese needs care: DB locale is `en_US.UTF-8`; a 3-character title yields ~4
  trigrams and simplified/traditional spellings share none — hence OpenCC *before* trigram
  indexing. One `show_trgm` probe settles behaviour once `pg_trgm` is enabled (available, not yet
  installed). PGroonga is the documented fallback if recall is poor.

### 3.8 Born-identified creations

Anything created *inside* the system is born identified: when a user creates a **shelf, bundle,
reading list, or derived entry** (e.g., a "same-text, three translations" comparison set), the
creation records its **derivation** — the exact listing/edition/work ids it was made from, by
whom, when — and that derivation *is* its identity statement, written in advance. Such objects
never enter Path B; their membership changes only by explicit edit, and each edit appends to the
same event log (§3.6), so a bundle's lineage is auditable exactly like a merge's. Only arrivals
from outside (merchant listings, imports) go through resolution. (This is the transferable core
of the v4 records insight — identity and derivation are one graph read in two directions — with
the records-specific content removed.)

---

## 4. Data — Open Library spine, built offline

### 4.1 The data rule (owner's nod, §12)

**Persist only from dumps and explicitly open data. Treat every API as a transient, attributed
lookup.** This one rule covers Google Books, bulk use of the OL API, and everything else. The
shipped `LookupBookByISBN` prefill is audited against it in Step 4 (§4.6).

### 4.2 The offline pipeline (owner's laptop; v2 §5.2)

Runs on the laptop, reproducible end to end; nothing in it touches the Worker or the 10 ms CPU cap:

1. Fetch the OL dumps (works 2.9 GB, authors 0.5 GB, editions 9.2 GB gz) + the wikidata dump
   (~700 MB). Record file name, date, size, checksum in the manifest.
2. Read the gzipped TSV+JSON with DuckDB; write compressed Parquet once. (Gzip reads are
   single-threaded — this first pass is the slow one; everything after reads Parquet.)
3. Build the full ISBN → edition → work map in Parquet. It stays on the laptop and feeds the
   benchmarks at full size.
4. Select the Postgres slice (§4.3).
5. Normalise, parse facets, validate against a schema; rejected rows go to a file with a reason.
6. Embed reference-work titles+authors with the production model (`bge-m3`, §6) through its REST
   endpoint — the same model id the Worker uses — storing model id + dimension with each vector.
7. Load into Supabase, one transaction per table, with a **manifest**: sources, checksums,
   selection queries, row counts, model ids. Every reference row carries the snapshot id.
8. Same inputs → same slice. A new dump = a new snapshot id; links re-derive against it (§9
   Step 10) with **zero assertions lost** — that property is a gate, not a hope.

Laptop cost, stated up front (V4 review MAJ-1 lesson — pipeline weight is never left implicit):
~13 GB of downloads, tens of GB of scratch, one long unattended first pass. The owner's disk and
an overnight window are an owner step (§10).

### 4.3 The slice — composition and the 500 MB arithmetic

Target **~5,000 works / ~20,000 editions** of full records (the top of the brief's 1–5k range),
plus a deliberately oversized ISBN index. Selection is adversarial by construction, not a random
sample: the canon (Gutenberg/Standard Ebooks overlap) · works with many editions · same-title
different-work collisions · translations (EN↔ZH weighted up: B-enzh needs hundreds of works with
Chinese editions) · reprint chains · the owner's shelf (B-shelf) · a stratum of NULL-ISBN and
pre-1987 Chinese items. The ISBN index is identifiers-only, so Path A can resolve ~1M ISBNs
without the database holding ~1M titles; full records grow on demand from single OL lookups.

Supabase Free budget = **500 MB**; the database is ~11 MB today. Estimates below are v2 §5.3's,
to be **replaced by measurements in Step 1** (the v2 discipline: estimates are placeholders, not
figures):

| Item | Basis | Estimate |
|---|---|---|
| ISBN index, ~1M ISBNs | 70–90 B/row incl. index | 70–90 MB |
| Full reference records: ~5k works + ~20k editions + authors/aliases, with trigram index | | 15–25 MB |
| Reference-work embeddings: 5,000 × bge-m3 1,024-dim at half precision (`halfvec`), + HNSW | ~2 KB/vector, as much again for the index | 20–25 MB |
| Listing embeddings (seed-scale listings, §6) | ~2 KB/vector + index | 10–15 MB |
| Evidence + assertions + events + tasks (+ negative lineage growth) | | 10–20 MB |
| `ai_runs` with full input/output | ~4 KB/run | ~20 MB per 5,000 runs — **retention rule required** (payloads pruned after 90 days; aggregates kept) |
| Born-identified creations + lineage edges | | < 5 MB |
| Marketplace tables at seed scale | | Negligible |
| **Total** | | **≈ 150–200 MB of 500 MB (~2.5× headroom)** |

Two standing warnings (v2 §5.3): embed **works**, not editions — editions are told apart by
structured fields, and embedding every edition would not fit; `pgvector 0.8.2` (already installed)
supports half-precision vectors.

### 4.4 Stores, listings, and the one real store

The reference catalogue is not the storefront catalog: listings arrive as (a) **synthetic
fixtures** — flagged `is_synthetic` in-DB and disclosed in the UI as demo data, never presented
as real social proof (the labelling rule, owner's nod §12) — exercising mechanics across the
slice's works (multiple stores per work, price/stock spread, a sales ledger history); and (b) the
**owner's own shelf, entered as one real store** — real listings, real missing ISBNs, doubling as
B-shelf. **No analytic or insight feature is built on synthetic rows** (v2 §5.6): fixtures
exercise mechanics; they do not support findings. Act 2's eval inherits this rule.

### 4.5 Categories, covers, summaries — what persists, from where

- **Categories persist — from Open Library subjects** (CC0), via the reference slice and single
  lookups. This replaces the original plan's Google-Books-categories flow, which §5(e) forbids
  warehousing. `books.categories` per listing; `works.categories` = union across member listings
  (derived). The seed script's `GENRE_PSYCHOLOGY` bug class (original codebase-map §8.10) is
  handled by enum validation at facet-parse time → mismatch flags the listing, never propagates.
- **Covers are linked, never stored**: `covers.openlibrary.org` URLs by OLID/cover id (the
  un-rate-limited key path, §1), with `?default=false` semantics so the 1×1 blank-cover trap is a
  catchable 404.
- **Bilingual work summaries** (original plan §4 step 4, kept): generated by the batch LLM from
  canonical OL metadata, prompt-registry-versioned, logged in `ai_runs`, stored on the works
  projection. Source metadata is CC0; the summary is our own text — no §5(e) exposure.

### 4.6 Google Books — demoted, and the shipped prefill audited

Google Books is the **third fallback at the add-book form only**: local ISBN index → OL API →
live Google Books lookup, shown to the merchant **with attribution, used to prefill the form,
never stored** (Google APIs Terms §5(e): no databases or permanent copies of API content; caching
only as response headers allow). The already-shipped `LookupBookByISBN` prefill currently lets a
Google-supplied **description and cover link be persisted by `AddBook`** (v2 §5.5 [F]). Under the
data rule, Step 4 changes the prefill source order to OL-first and stops persisting those two
fields from Google. The fix lives in the add-book form, which shows Google's description and cover
but does not submit them: `AddBook` cannot know where a field came from and must stay at P3 parity.
This is a behaviour change to a shipped surface — it is therefore an explicit
owner decision (§12), not a silent fix.

---

## 5. Orchestration — Postgres is the backlog; the Queue is a trigger; the sweep reconciles

Where each kind of work runs (v2 §3.1, adopted): **the laptop** for everything heavy and offline
(dump filtering, weight fitting, benchmarks, bulk embedding); **Postgres** for everything
set-based (candidate fetch, scoring with fitted weights, link derivation, residue grouping,
rollups — and the task list itself); **the Worker** for the request path and thin I/O on a cron
tick (a few OL lookups, one batched embedding call — waiting on network/DB does not count against
the 10 ms CPU cap); **the browser** for the add-book "is it one of these?" and the review screen.
No orchestrator switch buys CPU on Workers Free; the placement *is* the design.

**The task table is the queue of record** (v2 §3.2): a task row is written in the same transaction
as the listing it concerns, so a task can be neither lost nor duplicated — a guarantee no external
queue can give across two systems. Workers claim rows with `FOR UPDATE SKIP LOCKED`;
`locked_until` is the visibility timeout; `attempts` + backoff are retries; terminal `failed`
with the error text is the dead-letter list; a **priority column** is how "resolve the fast
sellers first" is said — honestly, as data, not as a fictitious priority lane. (`pgmq` exists on
the project but is FIFO without priorities; a plain table fits this workload better.)

**Revised after review (D2): the Queue described below is not built in Act 1.** The task table and
the cron sweep carry every job, and request-path jobs are picked up by the next sweep tick. The
paragraph that follows is kept as the design for adding the Queue later, if measured wake-up delay
ever justifies it.

**The T4 trio, as originally reconciled:** the Cloudflare Queue (`smart-bookstore-jobs` + DLQ, per the
original plan §3 envelope and consumer semantics — idempotent consumers, ack only after DB commit,
poison shapes acked to `ai_runs` as errors) is retained **only as wake-up transport** for online
jobs that originate in the request path (re-embed on write, second-opinion calls, single-lookup
enrichment). It is never the backlog: job state lives in the task table and status columns, and
the **cron sweep** (one Workers cron trigger; `pg_cron` for pure-SQL steps) reconciles — it
re-derives any job whose status column says the work is undone, which is also what makes the
Queue's 24 h Free retention a non-event, and what produces the regular DB activity that keeps a
Free Supabase project from pausing. Volume check against T4: seed-scale online jobs are tens/day;
the backfill wave is Postgres-internal and never enters the Queue at all. If the owner later
adopts v2 §3.3 wholesale and deletes the Queue, every job degrades to sweep-claimed task rows with
no semantic change — that exit is designed in, and the disagreement is on the record (§0 D2).

**Sales-velocity ordering** lives where it can be true: the sweep's `ORDER BY` over the priority
column (trailing-90-day ledger quantity, `total_sold` as proxy), not in any queue.

## 6. Embeddings — bge-m3, provenance, and the cost of the switch

- **Model: `@cf/baai/bge-m3`** (multilingual, 1,024-dim, 1,075 neurons/M input tokens — §1). It is
  the only embedding choice consistent with the EN/ZH requirement (D3). Model id lives in
  configuration, never in code paths (Workers AI retires models on short notice — v2 [F]: the
  2026-11-05 notice withdraws 24 models on 2026-11-20; `bge-m3` is not on that list, and it has
  open weights as a last-resort exit).
- **Migration consequence:** `books.embedding` `vector(384)` → `vector(1024)`; provenance columns
  from the original plan §2.2 carry over (`embedding_model`, `embedding_recipe`, `embedding_text_hash`,
  `embedded_at`) — the hash is what makes re-embed-on-write honest (re-embed only when the recipe
  text changed) and turns embedding drift into a queryable report. Reference-work vectors live in
  the reference tables as `halfvec(1024)` (§4.3).
- **What gets embedded:** reference works (title+author+subjects, offline, §4.2 step 6) for the
  ANN witness; listings (recipe: title + author + genre + categories + description) on write, for
  Act 2's search continuity. Editions are *not* embedded (§4.3 warning).
- **Neuron arithmetic:** 5,000 work strings × ~200 tokens ≈ 1M tokens ≈ **~1,075 neurons ≈ 11% of
  one day's free allocation**. Steady-state listing re-embeds are noise. The full-catalog
  re-embed on a future model change is a laptop/REST batch job, sized before it runs, and its
  cost is read back from `ai_runs` — measured, not assumed (original plan §9 discipline).

## 7. Jev — books-shaped, behind a benchmark gate, with a real fallback

Jev is **owner-provisioned**: prepaid TypeSafe credit loaded by the owner, the API key entered by
the owner as a Worker secret (dashboard only — §10). There is no free tier (§1), so every Jev
call in Act 1 is either inside the benchmark or on the listing path, logged in `ai_runs` with its
token count. The vendor labels image support *experimental*; the plan treats Jev as a measured
component, never a load-bearing assumption. **Version is pinned: Jev ≥ 1.14** (Box requires it —
V4 review 1B; the version condition is stated here because v4's silence on it was a finding).

### 7.1 The gold set comes first, and its scoring is defined before anything runs

The V4 lessons, applied as rules: (a) a gate is meaningless if the gold set is too small for its
threshold — MAJ-4's ≥0.99-on-≥1,000 gate was unreachable at n≈100 — so each flow's gold set is
sized to its gate *before* the gate is set; (b) "partial" hits and overlap thresholds are defined
in writing before scoring (the 16/19 Locate row was not reproducible without them); (c) scores
are **first-attempt** (39 of 42 on the first pass of the 2026-11-10 test, not the 70 of 74 after re-asks and re-runs); (d) gold is built from ground
truth (physical books, reference records), never by the heuristic it must judge (MAJ-3).

**B-photo** (new suite, Step 9): ~200 copyright-page photographs of real books (owner's shelf +
seed canon), each with hand-verified field truth: ISBN, publisher, year, edition statement,
printing line. Field-level exactness is the score; any Locate/Box use carries a pre-registered
IoU threshold. Strata: EN pages, ZH pages （版权页）, sideways/poor-light photos (the owner's
test conditions), pages with no ISBN (pre-ISBN and 统一书号 items).

**A free grader for the ISBN field:** a misread ISBN almost always fails its check digit, so any
photograph containing an ISBN scores its own reading. This lets the ISBN-reading row of B-photo
grow to thousands of cases with no hand labels. Hand-verified truth is still required for
publisher, year, edition statement and printing line.

### 7.2 The three flows

**(a) Copyright-page photo → edition identification — the flagship.** A merchant (or the owner)
photographs the one page that carries ISBN, edition and printing. Jev Choice/Score over the
candidate editions (generated by the §3.2 blocking from whatever the photo yields) reads the
page against them: the photo *becomes* the listing — facets filled, edition linked, listing
created — with the merchant confirming, never silently. This is the books-native form of
"a photo can be the listing": shelf-spine scanning for books is a commodity (V4 review 1C), but
copyright-page reading is not established as novel either: at least one app's store listing claims
edition identification from a photographed page (accuracy unverified; one search, 2026-11-10). What
this plan can own is narrower and checkable: measured accuracy on B-photo, printing-level detail,
and the EN/ZH stratum.

**(b) The self-questioning shortlist.** When candidates remain split after scoring, the candidate
set generates its own **discriminating question** — the single field whose answer best splits the
remaining editions (boxed logo? printing line digit? publisher city?) — and Jev is asked exactly
that, or the merchant is. (Transferred from the V4 proposals' #1 KEEP, re-shaped for editions.
It attacks the precise point where photo-cataloguing products punt to manual inspection.)

**(c) EN/ZH cross-lingual matching as a first-class test row.** Title-page/spine photos of Chinese
editions matched against EN/ZH candidate works — a stratum the 2026-11-10 test went 5-for-5 on as text and read correctly on
clean images, now measured properly inside B-photo/B-enzh conditions (sideways shelves included),
reported separately, never averaged away into the headline number.

### 7.3 The call budget is a design constraint, not a surprise

Per-candidate Jev questions collide with the Worker's **50 outbound subrequests per invocation**
at unmeasured candidate counts (V4 review MAJ-6). Therefore: candidate sets are capped before
any Jev call (blocking + cheap witnesses first — Jev sees the shortlist, not the catalogue);
questions are batched per candidate set; candidate counts are *measured* in Step 9's first week;
and if the cap still binds, orchestration moves client-side (the browser sequences the calls).
Jev's known weakness is Locate (16/19 in the 2026-11-10 test) — so no flow may depend on raw Locate
alone; flows use Choice/Score over candidate crops, with Box (≥1.14) only where its gold-set
numbers earn it.

**Image cost and asset naming (corrected 2026-11-10).** A 1,200-pixel image placed once in the
state cost about 3,800 input tokens for the whole request, with up to eight questions asked of it,
against a 64,000-token request limit. An earlier note here blamed a context limit; the real cause
was a test-script bug. Jev treats an asset's key as a reference wherever that string appears, so an
asset named `i` was attached again for every letter i in the question text. **Asset keys must be
long unique strings** (the vendor recommends a UUID per image), and each image goes in the state
once. Rules carried from the test: point at things by what is printed on them, never by position
or colour; pair every "which" or "where" with a yes/no "is it there at all"; probe with near-misses
(a number one digit off) before trusting a yes; crop before locating small targets; and do not use
the returned confidence as a gate.

### 7.4 The fallback is real, in the plan, and measured on the same gold set

If Jev fails its gate, is withdrawn, or the credit runs out, Act 1 still ships: **typed entry +
assisted entry (§3.5) is the baseline flow** — it exists from Step 6, before Jev appears at all —
and **Workers AI vision** (`@cf/meta/llama-3.2-11b-vision-instruct`, 4,410 neurons/M input tokens,
§1) is benchmarked on the *identical* B-photo set in Step 9, so the keep/replace decision is a
number, not a preference (the pre-registered rule: Jev ships per-flow only where its first-attempt
score beats the fallback's by the margin set at Step 9's start; otherwise the fallback ships and
Jev remains a spike). V4 review MAJ-7's standard — a fallback that appears in no milestone is
hollow — is met by construction: the fallback is Steps 4–6, Jev is Step 9.

### 7.5 Photo handling, specified end-to-end (V4 review MAJ-5's checklist)

Upload path (presigned direct-to-storage or Worker route within the 100 MB body cap — photos are
small; Worker route suffices, HEIC→JPEG conversion client-side before upload, with location metadata stripped and the rotation
baked into the pixels, because Jev ignores orientation tags), resize before any
model call, retention posture is an **owner decision** (§10): originals stored (they are B-photo
gold and re-runnable evidence) or deleted after facet extraction (TypeSafe's standard plan has no
zero-data-retention; US hosting). The default in code is *store the photo with the listing it
created*, because a photo that created a listing is part of that listing's evidence receipt
(§3.6) — the owner may override to delete-after-extract at the cost of re-runnability.

## 8. Work pages and born-identified surfaces

**Contract:** `GetWork` joins `CustomerService` in `backend/proto/bookstore.proto` (original plan
§7, kept): request by `book_id` (the frontend only ever holds listing ids) or by projection work
id; the Worker resolves through `listing_links` to the current work. Response: canonical fields,
categories, EN/ZH summaries, `offers[]` (listing id, store, price, stock, per-listing rating,
`total_sold`), merged `reviews[]` across member listings with **store attribution**, and aggregates
with **exact denominators** (review count, mean rating, price spread). Additive proto change →
both gens regenerated with the pinned protoc-gen-es and byte-checked (P1/P3 pattern). Go-side
disposition: Worker-only with the divergence written in DEPLOY.md (the identity layer is
Worker-native per v2 §10.11's lean — freeze Go parity at the P3 surface; §12 asks the owner to
confirm).

**Two-axis trust** (original plan §7, kept): the work's aggregated rating is displayed separately
from each offer's seller signals. The schema conflated them; the page un-conflates them.

**Reviews roll up through current membership** — and Step 7's gate includes the reversibility
demonstration: split a work on fixtures and watch the merged review set un-merge with correct
denominators, instantly. **Edition-scoped receipts**: a review names the edition it was written
about (via its listing's link at read time), so "great translation" and "bad printing" are
distinguishable on the same work page — the verified-reader evidence layer, citation-or-silence.

**Born-identified surfaces:** shelves/bundles/derived entries (§3.8) render as first-class pages
whose header *is* the derivation ("built from these 3 editions of this work, by the owner, on
this date") — lineage displayed, not hidden in a table.

**Deliberately not in Act 1** (as the original plan): work-level dedup of the catalog grid and of
search results (Act 2, measured by its golden set); aspect-digest display (Act 3); also-bought
(Act 3). `GetAvailableBooks` stays listing-shaped; only click targets change.

Frontend touches mirror the original plan §7 table: new `WorkPage.tsx` (+ CSS), `App.tsx`
view-state (no router), `BookCard.tsx` click-through, `client.ts` work call, regenerated gen —
plus the add-book form's candidate panel (§3.5) and the review screen (§3.5/Step 6), both
plain components in the same SPA.

---

## 9. Build sequence — shelf-first, every step gated

Sequencing follows the V4 builder's verdict (MAJ-8): the visible, lawful payoff comes early; the
heavy engine is fed by real data and real benchmarks, not preceded by platform ceremony. Decisions
are Step 0 *inputs*, never a milestone's content (B1 lesson). Sizes: S = a few sessions, M =
several, L = many. The earlier estimate of **≈ 8–12 focused days** looks optimistic on review: Steps 1 and 5 are each
multi-day on their own. Treat it as a floor and let the cut order below protect the schedule (Step 5 is the swing factor;
propose-only fallback caps it).

| Step | Work | Verification gate |
|---|---|---|
| **0. Decisions & pre-flight** (S) | Owner answers §12 (or explicitly defers items — deferral is an answer). Sync checkout to `5d0e5eab`; re-run the P3 baseline (vitest 123/123, typecheck, build). Provisioning checklist (§10) confirmed item by item. | Baseline green recorded; every §12 item answered or deferred in writing; any drift from `5d0e5eab` understood before new work starts. |
| **1. Offline catalogue + benchmarks** (M) | §4.2 pipeline through slice selection; manifest written; **B-mask, B-open, B-pairs, B-enzh built**; two baselines measured (exact-ISBN-only; naive trigram title match); §4.3 estimates replaced by measurements. | One-page benchmark report with baseline numbers exists; measured slice footprint projects ≤ ~250 MB loaded; manifest reproduces the slice byte-for-byte on a re-run. |
| **2. Thin platform + schema** (S–M) | New migration series: reference tables + `isbn_index`; listing facets; evidence; assertions; `identity_events`; `listing_links` + local works; tasks table + status columns; `works` display projection; `books.categories`; embedding provenance + `vector(1024)` switch (D3); `ai_runs` upgrade (D6); `prompts` registry + `review_aspects` table/view (job deferred, D5); `is_synthetic` flags. Worker: `ai/` module skeleton (embeddings via bge-m3, `runs.ts`, prompt loader), `AI` binding; container declarations removed from `wrangler.jsonc` only if §12 item 12 pulls that forward from P5. | Migrations apply cleanly to a scratch Postgres **and** rehearse against a copy of the live (~11 MB) DB (D4: priced as a live migration); fixtures load (same ISBN at 2 stores, hyphen/case variants, NULL-ISBN, lying ISBN, sold + unsold); P3 suite still 123/123; 384-dim assertion replaced by a 1024-dim one that fails loud. |
| **3. Seed load** (S, owner-run) | Owner loads the slice into Supabase (§10); synthetic listings fixtures generated against slice works, flagged `is_synthetic`; owner's shelf entered as the one real store (owner, optional-but-recommended — it is B-shelf). | Row counts match the manifest exactly; snapshot id recorded on every reference row; spot Path A joins resolve by hand-checked examples; UI discloses synthetic rows. |
| **4. Path A live + data-rule fix + first work page** (S–M) | Canonical ISBN-13 derived key; linking on write in `AddBook` (join only — stored ISBN and upsert key untouched); lying-ISBN agreement guard; single-lookup fallback (identified UA, ≤3 req/s, cached); **Google Books prefill fix per §4.6** (OL-first; Google fields transient, description/cover shown but not submitted by the form). **A minimal work page ships here**: `GetWork` and `WorkPage` over lookup-only links, so the first visible result comes before the heavy Step 5. | Every ISBN'd seed listing resolves by join; planted lying-ISBN fixtures are demoted + flagged, none auto-linked; no P3 parity case changes; a listing added with a Google-only ISBN shows attribution and stores no Google content; a multi-store fixture work renders on the minimal work page. |
| **5. Path B offline** (M–L) | Facet parser (rules first); comparison bands in SQL (one implementation, laptop + serving); EM weight fitting; term-frequency adjustment; veto sets at both levels; thresholds from measured precision; calibration plot; optional in-band LLM second opinion (measured on band pairs only; never overrides a veto; never a weighted witness — v2 §2.9). | §3.4 gates met on B-mask/B-open/B-pairs (recall reported per stratum) — **or** the propose-only decision is recorded with the numbers, per §3.4's pre-written fallback. Two fitting rounds maximum before that decision is forced (§11). |
| **6. Path B online + the review band** (M) | Task table + claim loop; cron sweep reconciler; assisted entry in the add-book form (candidate panel; recovers omitted ISBNs); the review screen (evidence bands shown per proposal — the Reading-Desk principle: the human reads evidence, the model never silently decides in the band); assertions written from both surfaces; re-derivation job. | An ISBN-less listing added through the UI gets ranked candidates in one round trip; a confirmed link survives a full re-derivation; a "not the same" assertion suppresses the same proposal afterwards; sweep re-derives a deliberately orphaned task. |
| **7. Work pages, completed** (M) | Extends Step 4's minimal page: `GetWork` over full derived membership; `WorkPage` + App/BookCard wiring; two-axis trust display; merged verified reviews with exact denominators + edition attribution; born-identified shelf/bundle pages with derivation headers (§8). | Fixture test: multi-store work, merged reviews ordered, aggregates exact; **reversibility demo**: split a fixture work → review set un-merges with correct denominators; staging click-through grid → work page → buy from a non-first offer; frontend build green, zero `localhost` strings. |
| **8. EN/ZH stratum** (M) | OpenCC normalisation before trigram indexing; pinyin author keys; Wikidata alias harvest (from the OL wikidata dump) into `ref_author_aliases`; bge-m3 ANN witness live for ZH; 统一书号 handled as a witness identifier; B-enzh + B-shelf executed and reported. | B-enzh reported separately with its own numbers (no averaging into the EN headline); B-shelf (~150 hand-checked) reported; pre-1987 Chinese items resolve or rest as local works *by decision*, none force-linked; if the ZH stratum only meets propose-only, that is the recorded outcome, not a failure to hide. |
| **9. Jev photo flows** (M) | B-photo gold set built and scoring rules registered (§7.1) **before** any Jev call is scored; Jev pinned ≥1.14; flows (a) copyright-page → edition, (b) self-questioning shortlist, (c) EN/ZH photo rows; candidate caps + batching per §7.3 (candidate counts measured in week 1); Workers AI vision fallback benchmarked on the identical set; photo pipeline per §7.5. | Per-flow keep/replace decision taken by the pre-registered rule (§7.4) on first-attempt scores; every Jev call in `ai_runs` with token counts (total Act 1 Jev spend reported in §9 Step 10's closeout); fallback path demonstrably ships a listing end-to-end with Jev disabled. |
| **10. Residue, refresh, closeout** (S–M) | Path C grouping under constraint checks (§3.2 rule 5); snapshot refresh drill (newer OL dump → re-derive all links); DEPLOY.md Act 1 section (migration order, owner steps, measured numbers: queue ops, neurons and Jev spend from `ai_runs`, final benchmark table); README interim note (full dynamic-UML + GIF treatment lands at P5 per the docs standard). | Refresh drill: **zero assertions lost**, every link re-derived, diff report reviewed; docs-vs-code pass: every command in the new DEPLOY.md section executed or marked owner-dashboard. |

Cut order if time runs short (v2 §9.2's discipline): Step 9's flow (b), then (c) as a *shipped*
flow (its test row still runs), then Step 10's Path C automation (residue rests as singletons).
**Never cut Step 1** — every later choice needs its numbers.

## 10. Owner-only steps — front-loaded, complete list

Nothing below can be done by the implementer; per the frontload lesson, all of it is visible
*before* the nod, not discovered mid-build:

1. **Answer §12** (Step 0 gate). Deferrals in writing are acceptable answers.
2. **Apply the migrations** in the Supabase dashboard, one file at a time, in order (the bamazon
   console lesson) — Step 2's output, applied at Step 3.
3. **Run the seed load** with Supabase direct-connection credentials, entered by the owner on his
   own machine/dashboard only (never via chat) — Step 3.
4. **Laptop resources for Step 1**: ~13 GB of dump downloads, tens of GB of scratch, one
   unattended multi-hour first pass.
5. **TypeSafe provisioning**: load prepaid credit on his own account; enter the API key as the
   Worker secret `TYPESAFE_API_KEY` in the Cloudflare dashboard — before Step 9.
6. **B-shelf labour**: the ~150-book hand-check and his own shelf entered as a store (Steps 1/3/8).
   This is the only hand-labelling in the plan, and it is his because he is the reviewer (§3.5).
7. **Photo retention posture** (§7.5): store originals with listings (default) or delete after
   extraction — decided before Step 9.
8. **Carried deploy items** (unchanged by Act 1, listed so they are never mistaken for Act 1
   blockers or Act 1 content): credential rotation into Cloudflare secrets; first-deploy
   Durable-Object-class provisioning confirmations; `GOOGLE_BOOKS_API_KEY` if the transient
   fallback should be keyed.
9. **PR #51 disposition and the superseding PR's merge** — his hand, as before (§12 carries the
   recommendation).

## 11. Risks and stop conditions

| Risk | Signal | Pre-committed response |
|---|---|---|
| The engine eats the schedule | §3.4 precision gate unmet after **two** fitting rounds | Ship propose-only (§3.4); stop tuning. Do not start a third round without a new witness and the owner's say-so. |
| Reference noise corrupts the benchmark | Many "false merges" turn out to be OL duplicates | Keep only positives a second source agrees on; report the OL duplicate rate as a finding, not an embarrassment. |
| Masked books ≠ real ISBN-less books | B-shelf results far below B-mask | Reweight the masked sample to the real profile; grow B-shelf; report both numbers. |
| OL is thin on Chinese | < half of B-shelf's Chinese titles found in the reference | Wikidata aliases + hand-curated core; accept local works; the stratum ships propose-only if that is what the numbers say. |
| The 500 MB cap | Step 1 measurements project > ~250 MB loaded | Shrink the ISBN index; confirm halfvec everywhere; enforce the `ai_runs` retention rule; drop listing embeddings before touching the reference slice. |
| Supabase Free pauses the project | A week of low activity | The cron sweep's regular activity is the mitigation; dashboard check is in the Step 10 runbook. |
| Embedding model withdrawn | Deprecation notice (precedent: 24 models, 2026-11-20) | Model id is config; provenance is per-vector; re-embed is a sized batch job (§6). `bge-m3` has open weights as the final exit. |
| Jev changes or vanishes | Vendor's own "experimental" label; prepaid, no free tier | §7.4: the fallback is Steps 4–6 and ships regardless; Jev is gated per flow, never load-bearing. |
| Terms change (OL / Google) | New snapshot or terms update | Dumps-only rule (§4.1); terms re-read at each snapshot refresh; manifest records dates. |
| Candidate counts explode | Step 9 week-1 measurement ≫ shortlist caps | Client-orchestrated calls (§7.3); Jev restricted to flow (a) until counts are understood. |
| Scope drifts back to storefront features | New RPCs unrelated to identity appear in a step | §13 non-goals are enforced at the step gates; a storefront idea goes to the Act 2/3 list, not into Act 1. |
| **Global stop-and-rethink** | B-open's absent-answer false-link rate cannot be brought ≤1% by any threshold that keeps auto-link useful, **or** the OL slice cannot be built inside the 500 MB budget at any useful size | Act 1 reverts to Path A + assisted entry + propose-only as its final shape (still a shipped improvement over the ISBN key), and the direction returns to the owner with the benchmark report as the evidence. |

## 12. Decisions for the owner's nod (recommendations stated; silence is not consent)

Already decided, recorded so they are not re-litigated: direction = books (2026-11-10); T5
singleton-by-default (2026-11-09, survives as the engine's prior, §3.2); PBKDF2 iterations stay
10,000 on Free; Workers Paid stays declined.

1. **Editorial table (§3.3)** — accept as written, including the flagged abridgement default
   (*separate sibling work*, against v2's default) and translations = same work.
2. **Benchmark gates (§3.4)** — accept the proposed numbers, or set his own. The propose-only
   fallback triggers on these numbers, so they are policy, not tuning.
3. **The data rule (§4.1) and the Google prefill fix (§4.6)** — adopt dumps-only persistence;
   OL-first prefill; Google description/cover stop being persisted.
4. **Synthetic-data rule (§4.4)** — `is_synthetic` + UI disclosure; no insight features on
   synthetic rows.
5. **EN/ZH in Act 1** — in, as Step 8 (recommended; it is this project's native niche), or
   English-first with Step 8 deferred.
6. **LLM second opinion inside the band (§3.2/Step 5)** — allowed, measured, veto-bound
   (recommended), or out of bounds under the bamazon-judge rule. The design works without it.
7. **Langfuse dual-write (D6)** — ledger-only (recommended default), or dual-write with
   prompts/outputs egressing to Langfuse Cloud Hobby while `ai_runs` stays authoritative.
8. **Go parity freeze** — freeze the Go backend at the P3 surface; identity is Worker-only and
   `GetWork`'s divergence is documented (recommended), or port `GetWork` to Go as well.
9. **Photo retention (§7.5)** — store-with-listing (recommended default) or delete-after-extract.
10. **PR #51** — close unmerged and let the Route B branch be the vehicle (v2's lean; nothing is
    lost — the branch contains #51's commits), or merge #51 first for the migrations on `main`.
11. **Review-band staffing** — the owner himself in Act 1 (the plan's assumption). If that stops
    being true, the band's thresholds, not its existence, are what change.
12. **Containers and the real deployment (added on review, revised after reading the original
    Act 1 plan)** — keep the existing phase plan: P5 removes the containers, and every Act 1 gate
    runs on the throwaway staging Worker (default, since that is what `P4-ACT1-PLAN.md` §0 already
    says). The alternative is to pull container removal forward into Step 2. That alone would not
    make production deployable: credential rotation and first-deploy provisioning are still the
    owner's, and `/api/ai/*` would answer "not available" until Act 2 ports search.

    **Resolved 2026-11-11 (kickoff): keep the phase plan.** Act 1 does not deploy to
    production; every Act 1 gate runs on the throwaway staging Worker with zero remote
    writes; the container declarations come out in P5, as the original Act 1 plan already
    assigned. (This supersedes the remove-in-Step-2 lean recorded the previous evening —
    the owner's re-read of `P4-ACT1-PLAN.md` §0 governs.)

**Review notes on items 1–11 (Claude, 2026-11-10; the owner's nod still decides).** All eleven
defaults are sound. Conditions attached:

- **1.** Build the abridgement sibling as a variant under the same reference work id (§3.3).
- **2.** The precision gate applies to the large suites only (§3.4).
- **3.** Make the prefill fix in the form, not in `AddBook` (§4.6).
- **5.** EN/ZH stays in. Open Library holds 958,113 works with a Chinese edition, 298,227 of them
  first published 1986 or earlier with no ISBN, and only about 24,000 that join a Chinese and an
  English edition (live search counts, 2026-11-10).
- **6.** Leave the second opinion off until Step 5 shows the band exceeds 10%, and benchmark Jev's
  text questions beside the Workers AI model.
- **9.** Store photos in a private bucket, with location metadata stripped (§7.5).
- **10.** If `main` should go green before the superseding PR, cherry-pick commit `323d7e8`.
- **11.** Only the owner can confirm this one. The real labour is the two hand-checked sets
  (B-shelf and B-photo), not the ongoing band.

**Candidate additions, not yet decided.**

- **Printing-level identity.** Western number lines and the Chinese 版次 / 印次 / 印数 / 定价 lines
  identify a printing, a level below edition that the reference slice does not carry. Every
  photographed copyright page would add it, including a list-price series taken from the object
  itself.
- **A duplicates report for Open Library** as a by-product: probable duplicate and cross-language
  works. A title search for 红楼梦 returned 43 separate works on 2026-11-10.
- **B-enzh published as an open English/Chinese matching benchmark.** None was found in research.

## 13. Act 2 / Act 3 knock-ons (books)

**Act 2 (Proof):** the search golden set is built against **post-identity data** — work-level
dedup is measured against derived membership, so its numbers describe the catalogue Act 1 actually
produced. The semantic-search SQL port is still owed as Act 2's baseline (per T2), now over
bge-m3 vectors with a work-level recipe; `ai/embeddings.ts` is its shared half. The bake-off
substrate is ready: B-* suites judge embedding challengers (e.g. qwen3-embedding-0.6b at the same
1,075 neurons/M) and any Jev expansion; the preserved Go/Python branch remains the differential
oracle, untouched. Langfuse dual-write (Decision 7) is revisited with a phase of `ai_runs` data
in hand. The synthetic-data rule binds Act 2's eval exactly as it binds Act 1's fixtures.

**Act 3 (Discovery & Librarian):** the librarian agent's substrate is the evidence/assertion
graph itself — every grouping it surfaces can be *explained* from receipts, which is the feature
no template has. Taste-vector recommendations aggregate listing vectors per work at query time
(Act 1 deliberately stores no canonical per-work embedding — freshness is a listing property;
flagged now so the schema never pretends otherwise). Aspect digests display from the
`review_aspects` substrate created in Step 2 (extraction job lands here, when real reviews
exist). Also-bought and cross-store availability routing sit on the works projection unchanged.
The Agents SDK Durable Object spike remains Act 3's entry gate (T6). Cloudflare Workflows are
adopted only if a step must genuinely *wait* or be *approved* as a process — Act 1's review band
is rows, so the expectation is: not yet (D7).

## 14. Non-goals (Act 1)

No new storefront features beyond the work page, assisted entry, and the review screen. No price
analysis, and no insight feature of any kind on synthetic rows. No chat/concierge port (the
bamazon rule; also v2 §9.4). No aspect-extraction *job* (Act 3, D5). No external vector database,
no LangSmith, no Nx, no Tauri (challenge-synthesis verdicts stand; entry is as a measured
bake-off spike in Act 2 or not at all). No domain pivot. No queue-as-backlog, anywhere. No
hosted tracer as system of record. No ISBN-keyed identity, in any new code path, ever again —
that is the one-sentence summary of this plan.

## 15. PR series and stopping points (kickoff addendum, 2026-11-11)

The build runs as a series of PRs, each one a safe place to pause. Every PR targets
`feat/worker-native-route-b` as its base; `main` stays untouched until Act 1 completes.
A PR is done when its §9 gate is met and the suite is green — pausing between PRs loses
nothing, and no PR depends on work from a later one.

**Step 0 status — pre-flight executed 2026-11-11.** Remote head of
`feat/worker-native-route-b` re-verified at `5d0e5eab92c01d9b20e89093a5b7c0bb823c05cb`;
a fresh checkout of that head passes `npm ci` + `npm test` at **123/123** with the
iteration-literal guard clean. The owner-side items in §10 are unchanged and are called
out per-PR below.

| PR | Steps | Contents | Gate / stopping point |
|---|---|---|---|
| **PR 1** `feat/p4-pr1-catalogue-benchmarks` | 1 | Offline catalogue build (OL dumps → DuckDB/Parquet slice + manifest); benchmark builders (B-mask, B-open, B-pairs, B-enzh); ISBN-only and naive-trigram baseline scorers. Scripts and research outputs only — no Worker code, no migrations. | Slice builds reproducibly; baselines measured and recorded. **Pause point: the data verdict — everything after this is sized by real numbers.** |
| **PR 2** `feat/p4-pr2-schema-platform` | 2 | Migration series (reference tables + `isbn_index`, facets, evidence, assertions, `identity_events`, `listing_links`, tasks, works projection, `books.categories`); embedding provenance + `vector(1024)`; `ai_runs` upgrade; `prompts` registry; `review_aspects` table/view; `is_synthetic` flags; Worker `ai/` skeleton + `AI` binding. Container declarations stay (decision 12). | Migrations rehearse clean against a copy of the live DB; P3 suite still 123/123; the 1024-dim assertion fails loud where the 384-dim one stood. |
| **PR 3** `feat/p4-pr3-path-a-workpage` | 3–4 | Seed loader + synthetic flags/UI disclosure (load itself is owner-run, §10); Path A live: canonical ISBN-13 join on write, lying-ISBN guard, identified OL API fallback, Google prefill demoted in the form; minimal work page. | Staging smoke on the throwaway Worker; **pause point: the first surface the owner can actually look at.** |
| **PR 4** `feat/p4-pr4-path-b-offline` | 5 | Facet parser; one SQL comparison implementation used for both fitting and serving; EM weight fitting; both veto sets; thresholds set from measured precision (max two fitting rounds). Offline only — no online behaviour changes. | Fitted report lands; auto-link precision on the large suites meets the §3.4 gates; the review band's expected share is a measured number, not a guess (feeds decision 6's 10% tripwire). |
| **PR 5** `feat/p4-pr5-path-b-online-review` | 6 | Task table + claim loop, cron sweep, assisted entry, evidence-showing review screen, assertions write path, re-derivation. | End-to-end on staging fixtures; **pause point: the identity engine is live, with the owner working the band.** |
| **PR 6** `feat/p4-pr6-work-pages` | 7 | `GetWork` complete over derived membership; two-axis trust; merged verified reviews with exact denominators; gated reversibility demo; born-identified shelf/bundle pages. | Work pages serve merged data with honest denominators; a merge can be reversed in the demo without touching an assertion. |
| **PR 7** `feat/p4-pr7-enzh` | 8 | OpenCC normalisation before trigram indexing; pinyin author keys; Wikidata alias harvest; 统一书号 as witness. B-enzh and B-shelf reported separately, with intervals. | EN/ZH stratum measured on its own sets; no regression on the English suites. |
| **PR 8** `feat/p4-pr8-photo-flows` | 9 | B-photo gold set (~200 copyright-page photos) with pre-registered scoring **before** any scored Jev call; Jev pinned ≥1.14; flows (a) copyright-page → edition, (b) self-questioning shortlist, (c) EN/ZH photo rows; Workers AI vision benchmarked on the identical set; per-flow keep/replace by the pre-registered rule. Owner gate: TypeSafe credit + dashboard-entered secret (§10). | **Pause point: the photo verdict** — each flow kept or replaced on measured accuracy, with the ISBN check-digit self-grading set as the scale path. |
| **PR 9** `feat/p4-pr9-closeout` (small) | 10 | Path C residue under constraint checks; snapshot-refresh drill gated on zero assertions lost; DEPLOY.md updated with measured ops/neurons/Jev spend; README UML + demo GIF per the Route B docs standard. | Act 1 closes with measured operating numbers. Owner action alongside: close PR #51 unmerged (decision 10). |

Sequencing notes:

- PR 1 needs the OL dumps (~13 GB). **Decided 2026-11-11: the build runs in Pawlie's
  VM** (owner's call — slow is acceptable; §4.2's "laptop" references read as "the VM"
  for Act 1). Stability rules for the VM run: one heavy job at a time, resume-able
  downloads (`curl -C -`), DuckDB memory-capped with on-disk spill, per-file completion
  checkpoints and a progress log under `~/workspace` so a VM replacement resumes the
  pipeline instead of restarting it. The known bottleneck is the one §4.2 already names:
  gzip decompression is single-threaded, so the first pass over the editions dump is
  the long pole; everything after reads Parquet.
- Two PRs carry owner-only gates that should be front-loaded before their build starts,
  per the standing pre-flight rule: PR 3 (seed load credentials — his run) and PR 8
  (TypeSafe prepaid credit + the secret entered in the dashboard, never via chat).
- Merging each PR is the owner's word, as always; Pawlie builds, verifies, and opens.
