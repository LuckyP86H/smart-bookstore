-- 20261111130000_p4_reference_catalogue.sql
-- P4 Step 2 (PR 2): the reference catalogue — Open Library works, editions,
-- authors and author aliases, plus the slice-scoped ISBN index.
-- Implements P4-BOOKS-FINAL-PLAN.md §3.6 (reference tables) and §4.3 (the
-- slice: full records for ~5k works / ~20k editions, identifiers-only ISBN
-- index). pg_trgm joins vector in the extensions schema (D-R8), qualified
-- the same way migration 1 qualifies extensions.vector_cosine_ops.

create extension if not exists pg_trgm with schema extensions;

create table public.ref_works (
  id bigint generated always as identity primary key,
  source text not null default 'openlibrary',
  source_key text not null,
  snapshot_id text not null,
  title text not null,
  title_key text,
  first_publish_year integer,
  subjects text[] not null default '{}',
  embedding extensions.halfvec(1024),
  embedding_model text,
  embedding_recipe text,
  embedding_text_hash text,
  embedded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, source_key, snapshot_id)
);

create table public.ref_editions (
  id bigint generated always as identity primary key,
  source text not null default 'openlibrary',
  source_key text not null,
  snapshot_id text not null,
  -- nullable: PR 1 found edition -> work keys with no works row.
  work_ref_id bigint references public.ref_works(id),
  isbn13 char(13),
  title text not null,
  title_key text,
  publisher text,
  publish_year integer,
  language text,
  page_count integer,
  created_at timestamptz not null default now(),
  unique (source, source_key, snapshot_id)
);

create table public.ref_authors (
  id bigint generated always as identity primary key,
  source text not null default 'openlibrary',
  source_key text not null,
  snapshot_id text not null,
  name text not null,
  name_key text,
  pinyin_key text,
  birth_year integer,
  death_year integer,
  created_at timestamptz not null default now(),
  unique (source, source_key, snapshot_id)
);

create table public.ref_author_aliases (
  id bigint generated always as identity primary key,
  author_ref_id bigint not null references public.ref_authors(id) on delete cascade,
  alias text not null,
  alias_key text,
  script text,
  source text not null default 'wikidata',
  created_at timestamptz not null default now(),
  unique (author_ref_id, alias_key, source)
);

-- Slice-scoped and snapshot-carrying (D-R7): an ISBN-13 can name more than
-- one edition record, so the index is unique on (snapshot_id, isbn13,
-- edition_ref_id) and deliberately NOT unique on isbn13 alone.
create table public.isbn_index (
  id bigint generated always as identity primary key,
  isbn13 char(13) not null,
  edition_ref_id bigint not null references public.ref_editions(id) on delete cascade,
  snapshot_id text not null,
  created_at timestamptz not null default now(),
  unique (snapshot_id, isbn13, edition_ref_id)
);

create index idx_ref_works_title_key_trgm on public.ref_works using gin (title_key extensions.gin_trgm_ops);
create index idx_ref_works_embedding on public.ref_works using hnsw (embedding extensions.halfvec_cosine_ops);
create index idx_ref_editions_isbn13 on public.ref_editions(isbn13);
create index idx_ref_editions_title_key_trgm on public.ref_editions using gin (title_key extensions.gin_trgm_ops);
create index idx_isbn_index_isbn13 on public.isbn_index(isbn13);

-- The backend and AI service connect as the table owner, which bypasses RLS.
-- With RLS on and no policies, the public API keys can read and write nothing.
alter table public.ref_works enable row level security;
alter table public.ref_editions enable row level security;
alter table public.ref_authors enable row level security;
alter table public.ref_author_aliases enable row level security;
alter table public.isbn_index enable row level security;
