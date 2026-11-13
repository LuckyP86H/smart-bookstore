-- 20261111130200_p4_identity_store.sql
-- P4 Step 2 (PR 2): the identity store — model versions, scored evidence
-- (with negative lineage), human assertions, local works for the residue,
-- derived listing links, the identity-event receipt log, and the task
-- table that is the Act 1 job mechanism (no Queue objects anywhere).
-- Implements P4-BOOKS-FINAL-PLAN.md §3.6 and decision D-R6 (FK delete
-- behaviour: derivations cascade with their listing, tasks set null,
-- identity_events is append-only with no FK on listing_id).
-- Ordering note: local_works is created before evidence and listing_links
-- because both carry foreign keys to it.
-- listing_links.derivation_run_id is declared here WITHOUT its foreign
-- key: ai_runs is created in 20261111130400_p4_ai_platform.sql, which
-- adds the FK.

create table public.model_versions (
  id bigint generated always as identity primary key,
  name text not null unique,
  weights jsonb,
  thresholds jsonb,
  comparison_defs jsonb,
  benchmark_results jsonb,
  created_at timestamptz not null default now()
);

create table public.local_works (
  id bigint generated always as identity primary key,
  title text,
  created_from text not null default 'residue',
  -- the §3.3 abridgement mechanism: a variant living under the same
  -- reference work instead of becoming a separate work.
  variant_of_ref_work_id bigint references public.ref_works(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.evidence (
  id bigint generated always as identity primary key,
  listing_id bigint not null references public.books(id) on delete cascade,
  candidate_edition_id bigint references public.ref_editions(id),
  candidate_work_id bigint references public.ref_works(id),
  candidate_local_work_id bigint references public.local_works(id),
  candidate_listing_id bigint references public.books(id),
  bands jsonb not null,
  weights jsonb,
  total_score numeric,
  model_version_id bigint references public.model_versions(id),
  outcome text check (outcome in ('auto_linked', 'proposed', 'rejected')),
  created_at timestamptz not null default now(),
  constraint evidence_exactly_one_candidate check (
    (candidate_edition_id is not null)::int
    + (candidate_work_id is not null)::int
    + (candidate_local_work_id is not null)::int
    + (candidate_listing_id is not null)::int
    = 1
  )
);

-- Assertions name stable record ids only (§3.6), never listings, so they
-- never conflict with listing deletion. left_id / right_id are plain
-- bigints on purpose: the kind columns say which table they belong to.
-- The kind / relation / level columns are NOT NULL: a row whose kind is
-- NULL leaves its id uninterpretable, which defeats the table's purpose.
-- A record also cannot be asserted against itself: 'same' would be a
-- tautology and 'not_same' a contradiction, so the pair must name two
-- different records (same id under a DIFFERENT kind is a different
-- record and stays legal). No uniqueness constraint on the pair:
-- assertions are an append-only judgment log — the same pair may be
-- re-asserted over time or by different people, and deduplication is
-- the Step 5 consumer's concern, not the schema's.
create table public.assertions (
  id bigint generated always as identity primary key,
  left_kind text not null check (left_kind in ('ref_work', 'ref_edition', 'local_work')),
  right_kind text not null check (right_kind in ('ref_work', 'ref_edition', 'local_work')),
  left_id bigint not null,
  right_id bigint not null,
  relation text not null check (relation in ('same', 'not_same')),
  level text not null check (level in ('work', 'edition')),
  asserted_by text not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint assertions_no_self_pair check (
    not (left_kind = right_kind and left_id = right_id)
  )
);

create table public.listing_links (
  id bigint generated always as identity primary key,
  listing_id bigint not null references public.books(id) on delete cascade,
  edition_ref_id bigint references public.ref_editions(id),
  work_ref_id bigint references public.ref_works(id),
  local_work_id bigint references public.local_works(id),
  -- exactly one target shape: local alone, edition+work, or work alone.
  constraint listing_links_one_target_shape check (
    (local_work_id is not null and edition_ref_id is null and work_ref_id is null)
    or (local_work_id is null and edition_ref_id is not null and work_ref_id is not null)
    or (local_work_id is null and edition_ref_id is null and work_ref_id is not null)
  ),
  status text check (status in ('automatic', 'confirmed', 'proposed')),
  -- foreign key to ai_runs(id) is added in
  -- 20261111130400_p4_ai_platform.sql, where ai_runs is created.
  derivation_run_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id)
);

-- Append-only receipt log (§3.6): listing_id is a plain column with no
-- foreign key (D-R6), so receipts survive the listing they describe.
create table public.identity_events (
  id bigint generated always as identity primary key,
  listing_id bigint,
  local_work_id bigint references public.local_works(id) on delete set null,
  event_type text check (event_type in ('link', 'unlink', 'relink', 'group_merge', 'group_split')),
  from_state jsonb,
  to_state jsonb,
  evidence_ids bigint[] not null default '{}',
  manifest jsonb,
  model_version_id bigint references public.model_versions(id),
  actor text not null,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id bigint generated always as identity primary key,
  kind text not null,
  listing_id bigint references public.books(id) on delete set null,
  payload jsonb not null default '{}',
  status text default 'pending' check (status in ('pending', 'claimed', 'done', 'failed', 'dead')),
  attempts integer not null default 0,
  claimed_by text,
  claimed_at timestamptz,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_assertions_left_right on public.assertions(left_kind, left_id, right_kind, right_id);
create index idx_tasks_status_run_after on public.tasks(status, run_after);

-- The backend and AI service connect as the table owner, which bypasses RLS.
-- With RLS on and no policies, the public API keys can read and write nothing.
alter table public.model_versions enable row level security;
alter table public.local_works enable row level security;
alter table public.evidence enable row level security;
alter table public.assertions enable row level security;
alter table public.listing_links enable row level security;
alter table public.identity_events enable row level security;
alter table public.tasks enable row level security;
