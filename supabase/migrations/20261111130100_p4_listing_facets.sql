-- 20261111130100_p4_listing_facets.sql
-- P4 Step 2 (PR 2): listing facets, plus the categories / is_synthetic
-- columns on the existing marketplace tables.
-- Implements P4-BOOKS-FINAL-PLAN.md §3.6 (listings + listing facets: the
-- discriminating tokens are kept as fields, never normalised away), §4.4
-- (synthetic fixtures are flagged is_synthetic, D-R9: on books and on
-- stores) and §4.5 (books.categories persists from Open Library subjects).

alter table public.books add column categories text[] not null default '{}';
alter table public.books add column is_synthetic boolean not null default false;
alter table public.stores add column is_synthetic boolean not null default false;

create table public.listing_facets (
  listing_id bigint primary key references public.books(id) on delete cascade,
  isbn13 char(13),
  title_key text,
  author_keys text[] not null default '{}',
  part text,
  edition_statement text,
  format text,
  companion_marker boolean not null default false,
  language varchar(50),
  unified_book_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at discipline (PR #63 review round 4, decision D-R11):
-- updated_at columns in this series are maintained by trigger, never
-- left to writers remembering to set them — without one, the column
-- silently equals created_at forever. The shared trigger function is
-- defined HERE, in the first migration that needs it; each later
-- migration adds its own tables' triggers against this one function
-- (130200: local_works, listing_links, tasks; 130300: works;
-- 130400: review_aspects).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_listing_facets_set_updated_at
  before update on public.listing_facets
  for each row execute function public.set_updated_at();

-- The backend and AI service connect as the table owner, which bypasses RLS.
-- With RLS on and no policies, the public API keys can read and write nothing.
alter table public.listing_facets enable row level security;
