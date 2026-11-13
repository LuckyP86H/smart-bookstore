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

-- 2. books.embedding stays vector(384) -----------------------------------------
-- The 384 -> 1024 switch is deferred to the P5 ai-service migration
-- (see the header of 20261111130400_p4_ai_platform.sql): the live
-- Python ai-service's contract is 384 dimensions, so this migration
-- series must leave the column at 384.
-- for a vector column, pg_attribute.atttypmod IS the dimension.

do $$
declare
  v_dim integer;
begin
  select atttypmod into v_dim
  from pg_attribute
  where attrelid = 'public.books'::regclass and attname = 'embedding';
  if v_dim is distinct from 384 then
    raise exception 'assertions: books.embedding dimension is %, expected 384 (switch deferred to P5)', v_dim;
  end if;
end
$$;

select 'PASS: books.embedding stays vector(384) (atttypmod = 384; 1024 switch deferred to P5)' as gate;

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

-- 4. books gained categories + is_synthetic — and NOT the embedding --------
-- provenance columns, which arrive only with the deferred 1024 switch.

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'books'
    and column_name in ('categories', 'is_synthetic');
  if v_count <> 2 then
    raise exception 'assertions: books has % of the 2 expected new columns (categories, is_synthetic)', v_count;
  end if;
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'books'
    and column_name in (
      'embedding_model', 'embedding_recipe', 'embedding_text_hash', 'embedded_at'
    );
  if v_count <> 0 then
    raise exception 'assertions: books has % embedding provenance columns; they belong to the deferred P5 switch and must not be here', v_count;
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

select 'PASS: books has categories + is_synthetic and no embedding provenance columns (deferred); stores has is_synthetic' as gate;

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

-- 9. ai_runs lifecycle + assertions column discipline ---------------------------
-- ai_runs: status defaults to 'running', the CHECK admits 'running', and
-- finished_at exists — a crashed run must read as unfinished, not 'ok'.
-- assertions: left_kind / right_kind / relation / level are NOT NULL, so
-- an id can never be left uninterpretable by a NULL kind.

do $$
declare
  v_default text;
  v_check text;
  v_count integer;
begin
  select column_default into v_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'status';
  if v_default is null or v_default not like '%running%' then
    raise exception 'assertions: ai_runs.status default is %, expected a ''running'' default', v_default;
  end if;
  select pg_get_constraintdef(oid) into v_check
  from pg_constraint
  where conrelid = 'public.ai_runs'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%';
  if v_check is null or v_check not like '%running%' then
    raise exception 'assertions: ai_runs status CHECK does not admit ''running'': %', v_check;
  end if;
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'ai_runs' and column_name = 'finished_at';
  if v_count <> 1 then
    raise exception 'assertions: ai_runs.finished_at is missing';
  end if;
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'assertions'
    and column_name in ('left_kind', 'right_kind', 'relation', 'level')
    and is_nullable = 'NO';
  if v_count <> 4 then
    raise exception 'assertions: % of the 4 assertions kind/relation/level columns are NOT NULL, expected 4', v_count;
  end if;
end
$$;

select 'PASS: ai_runs starts ''running'' with finished_at present; assertions kind/relation/level are NOT NULL' as gate;
