-- 20261111130300_p4_works_projection.sql
-- P4 Step 2 (PR 2): the display works projection — one row per reference
-- work or local work, carrying only the canonical display fields.
-- Implements P4-BOOKS-FINAL-PLAN.md §3.6: the projection is derived and
-- rebuildable; per-work rollups (offers, ratings) are computed at read
-- time through current membership, NOT stored here.

create table public.works (
  id bigint generated always as identity primary key,
  work_ref_id bigint unique references public.ref_works(id),
  local_work_id bigint unique references public.local_works(id),
  constraint works_exactly_one_source check (
    (work_ref_id is not null)::int + (local_work_id is not null)::int = 1
  ),
  title text not null,
  author_display text,
  categories text[] not null default '{}',
  summary_en text,
  summary_zh text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at trigger (D-R11): the shared set_updated_at() function
-- is defined in 20261111130100_p4_listing_facets.sql.
create trigger trg_works_set_updated_at
  before update on public.works
  for each row execute function public.set_updated_at();

-- The backend and AI service connect as the table owner, which bypasses RLS.
-- With RLS on and no policies, the public API keys can read and write nothing.
alter table public.works enable row level security;
