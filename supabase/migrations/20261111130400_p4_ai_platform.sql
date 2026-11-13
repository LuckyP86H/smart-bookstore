-- 20261111130400_p4_ai_platform.sql
-- P4 Step 2 (PR 2): the thin AI platform — prompt registry, ai_runs (the
-- only observability record, D6: no Langfuse columns, no dual-write
-- hooks; created directly in its upgraded shape, D-R1), and the
-- review-aspects substrate for Act 3.
-- Implements P4-BOOKS-FINAL-PLAN.md §3.6 (ai_runs) and §4.3 (payload
-- retention; bge-m3 is a 1024-dimension model).
--
-- DEFERRED, deliberately: the books.embedding switch from vector(384)
-- to vector(1024) is NOT in this migration. The live Python ai-service
-- still produces and queries 384-dimension vectors
-- (ai-service/app/config/settings.py: embedding_dimension = 384,
-- model all-MiniLM-L6-v2), and its semantic-search endpoint is live —
-- switching the column here would break it silently. The switch (the
-- column type change, its HNSW rebuild, and the embedding provenance
-- columns) lands with the P5 change that retires/migrates the Python
-- ai-service. The P4 reference catalogue is unaffected: ref_works is a
-- new table with no legacy writer and stores halfvec(1024) from the
-- start (20261111130000).

create table public.prompts (
  id bigint generated always as identity primary key,
  key text not null,
  version integer not null,
  body text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (key, version)
);

create table public.ai_runs (
  id bigint generated always as identity primary key,
  parent_run_id bigint references public.ai_runs(id),
  kind text not null,
  provider text,
  model text,
  prompt_id bigint references public.prompts(id),
  prompt_version integer,
  -- payload retention is a job (prune payloads after 90 days, §4.3),
  -- not a schema property: input/output stay plain jsonb columns here.
  input jsonb,
  output jsonb,
  input_tokens integer,
  output_tokens integer,
  neurons numeric,
  -- lifecycle: a run starts 'running' (the default) and finishRun moves
  -- it to exactly one terminal state, stamping finished_at. A worker
  -- that dies mid-run leaves a 'running' row with finished_at NULL —
  -- visibly unfinished, never a false 'ok'.
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  error text,
  listing_id bigint references public.books(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- The foreign key deferred from 20261111130200_p4_identity_store.sql:
-- listing_links.derivation_run_id can only reference ai_runs now that
-- ai_runs exists.
alter table public.listing_links
  add constraint listing_links_derivation_run_id_fkey
  foreign key (derivation_run_id) references public.ai_runs(id) on delete set null;

-- books.embedding stays vector(384) here — see the DEFERRED note in the
-- file header. The column, its existing idx_books_embedding index, and
-- the Go backend's vector(384) fallback in backend/db/database.go all
-- stay mutually consistent until the P5 ai-service migration moves the
-- whole contract to 1024 at once.

create table public.review_aspects (
  id bigint generated always as identity primary key,
  review_id bigint not null unique references public.reviews(id) on delete cascade,
  aspects jsonb,
  status text not null default 'pending' check (status in ('pending', 'extracted', 'failed')),
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The Act 3 extraction job's input (substrate only: no job in this PR).
-- One row per review whose aspect extraction is still pending.
create view public.review_aspects_queue as
select
  ra.id as review_aspects_id,
  ra.status as aspects_status,
  r.id as review_id,
  r.book_id,
  r.customer_id,
  r.rating,
  r.review_text,
  r.created_at as review_created_at,
  b.store_id,
  b.title as book_title,
  b.author as book_author
from public.review_aspects ra
join public.reviews r on r.id = ra.review_id
join public.books b on b.id = r.book_id
where ra.status = 'pending';

-- The backend and AI service connect as the table owner, which bypasses RLS.
-- With RLS on and no policies, the public API keys can read and write nothing.
alter table public.prompts enable row level security;
alter table public.ai_runs enable row level security;
alter table public.review_aspects enable row level security;
