-- assertions.sql — schema-level gate assertions for P4 Step 2 (PR 2).
--
-- These assertions hold on ANY database that has applied all migrations
-- in supabase/migrations/ (they never look at fixture data), so the gate
-- harness runs this file against both the fresh DB and the
-- live-equivalent DB. Data-dependent checks live in
-- fixture_assertions.sql instead.
--
-- Pattern: each check is a DO block that raises an exception on failure
-- (the harness runs psql with ON_ERROR_STOP, so a failure stops the file
-- and fails the gate), followed by a SELECT that prints its PASS line.
--
-- Note on the table count: the PR 2 contract text says "13 new tables"
-- but then lists 17 names. This file asserts the 17 that are listed and
-- created: ref_works, ref_editions, ref_authors, ref_author_aliases,
-- isbn_index, listing_facets, model_versions, evidence, assertions,
-- local_works, listing_links, identity_events, tasks, works, prompts,
-- ai_runs, review_aspects.

-- 1. all 17 new tables exist -------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'ref_works', 'ref_editions', 'ref_authors', 'ref_author_aliases',
    'isbn_index', 'listing_facets', 'model_versions', 'evidence',
    'assertions', 'local_works', 'listing_links', 'identity_events',
    'tasks', 'works', 'prompts', 'ai_runs', 'review_aspects'
  ] loop
    if not exists (
      select 1 from pg_tables
      where schemaname = 'public' and tablename = t
    ) then
      raise exception 'assertions: missing public table %', t;
    end if;
  end loop;
end
$$;

select 'PASS: all 17 new public tables exist' as gate;

-- 2. books.embedding is vector(1024) -----------------------------------------
-- for a vector column, pg_attribute.atttypmod IS the dimension.

do $$
declare
  v_dim integer;
begin
  select atttypmod into v_dim
  from pg_attribute
  where attrelid = 'public.books'::regclass and attname = 'embedding';
  if v_dim is distinct from 1024 then
    raise exception 'assertions: books.embedding dimension is %, expected 1024', v_dim;
  end if;
end
$$;

select 'PASS: books.embedding is vector(1024) (atttypmod = 1024)' as gate;

-- 3. ref_works.embedding is halfvec(1024) -------------------------------------

do $$
declare
  v_dim integer;
begin
  select atttypmod into v_dim
  from pg_attribute
  where attrelid = 'public.ref_works'::regclass and attname = 'embedding';
  if v_dim is distinct from 1024 then
    raise exception 'assertions: ref_works.embedding dimension is %, expected 1024', v_dim;
  end if;
end
$$;

select 'PASS: ref_works.embedding is halfvec(1024) (atttypmod = 1024)' as gate;

-- 4. books gained categories, is_synthetic and the 4 provenance columns ------

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'books'
    and column_name in (
      'categories', 'is_synthetic',
      'embedding_model', 'embedding_recipe', 'embedding_text_hash', 'embedded_at'
    );
  if v_count <> 6 then
    raise exception 'assertions: books has % of the 6 expected new columns', v_count;
  end if;
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'stores'
    and column_name = 'is_synthetic';
  if v_count <> 1 then
    raise exception 'assertions: stores.is_synthetic is missing';
  end if;
end
$$;

select 'PASS: books has categories + is_synthetic + 4 provenance columns; stores has is_synthetic' as gate;

-- 5. pg_trgm probe (§3.7): show_trgm on a 3-character Chinese title -----------

do $$
declare
  v_len integer;
begin
  v_len := array_length(extensions.show_trgm('红楼梦'), 1);
  if v_len is null or v_len = 0 then
    raise exception 'assertions: extensions.show_trgm(''红楼梦'') returned an empty array';
  end if;
end
$$;

select 'PASS: pg_trgm probe — extensions.show_trgm(''红楼梦'') returned '
  || array_length(extensions.show_trgm('红楼梦'), 1)::text
  || ' trigrams (non-empty)' as gate;

-- 6. isbn_index is NOT unique on isbn13 alone (D-R7) ---------------------------

do $$
declare
  v_attnum smallint;
begin
  select attnum into v_attnum
  from pg_attribute
  where attrelid = 'public.isbn_index'::regclass and attname = 'isbn13';
  if exists (
    select 1 from pg_index
    where indrelid = 'public.isbn_index'::regclass
      and indisunique
      and indnatts = 1
      and indkey[0] = v_attnum
  ) then
    raise exception 'assertions: isbn_index has a unique index on isbn13 alone';
  end if;
end
$$;

select 'PASS: isbn_index is not unique on isbn13 alone' as gate;

-- 7. RLS is enabled on every new table -----------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'ref_works', 'ref_editions', 'ref_authors', 'ref_author_aliases',
    'isbn_index', 'listing_facets', 'model_versions', 'evidence',
    'assertions', 'local_works', 'listing_links', 'identity_events',
    'tasks', 'works', 'prompts', 'ai_runs', 'review_aspects'
  ] loop
    if not exists (
      select 1 from pg_class
      where relnamespace = 'public'::regnamespace
        and relname = t
        and relrowsecurity
    ) then
      raise exception 'assertions: row level security is not enabled on %', t;
    end if;
  end loop;
end
$$;

select 'PASS: row level security is enabled on all 17 new tables' as gate;

-- 8. the deferred listing_links -> ai_runs foreign key arrived in file 5 -------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'listing_links_derivation_run_id_fkey'
      and conrelid = 'public.listing_links'::regclass
      and contype = 'f'
  ) then
    raise exception 'assertions: listing_links.derivation_run_id foreign key is missing';
  end if;
  if not exists (
    select 1 from information_schema.views
    where table_schema = 'public' and table_name = 'review_aspects_queue'
  ) then
    raise exception 'assertions: view public.review_aspects_queue is missing';
  end if;
end
$$;

select 'PASS: listing_links.derivation_run_id FK exists; review_aspects_queue view exists' as gate;
