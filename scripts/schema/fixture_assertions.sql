-- fixture_assertions.sql — data assertions for the P4 Step 2 (PR 2) gate.
--
-- Run ONLY against the live-equivalent DB, after fixtures.sql. (The fresh
-- DB has no fixture data; schema-level checks for both DBs live in
-- assertions.sql.) Same pattern as assertions.sql: a DO block raises on
-- failure — the harness runs psql with ON_ERROR_STOP — and a SELECT
-- prints the PASS line. The CHECK-rejection tests use an inner
-- exception block + a flag, so "the bad insert succeeded" is itself
-- raised as a failure outside the handler that would swallow it; the
-- whole DO is one statement, so a raised failure also rolls the bad
-- insert back.
--
-- The Path A joins below compare isbn_index.isbn13 (char(13)) to
-- books.isbn (varchar(20)) WITHOUT a cast on purpose: casting the raw
-- listing isbn to char(13) raises on a longer raw value (the hyphenated
-- '978-0-13-235088-4' is 17 chars), while the bare comparison simply
-- does not match — the length-safe behaviour a join over raw listing
-- data needs.

-- 1. fixture row counts ---------------------------------------------------------

do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.stores;
  if v_count < 3 then raise exception 'fixture_assertions: stores has % rows, expected >= 3', v_count; end if;
  select count(*) into v_count from public.books;
  if v_count < 5 then raise exception 'fixture_assertions: books has % rows, expected >= 5', v_count; end if;
  select count(*) into v_count from public.sales;
  if v_count < 1 then raise exception 'fixture_assertions: sales has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.reviews;
  if v_count < 1 then raise exception 'fixture_assertions: reviews has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.ref_authors;
  if v_count < 2 then raise exception 'fixture_assertions: ref_authors has % rows, expected >= 2', v_count; end if;
  select count(*) into v_count from public.ref_author_aliases;
  if v_count < 3 then raise exception 'fixture_assertions: ref_author_aliases has % rows, expected >= 3', v_count; end if;
  select count(*) into v_count from public.ref_works;
  if v_count < 2 then raise exception 'fixture_assertions: ref_works has % rows, expected >= 2', v_count; end if;
  select count(*) into v_count from public.ref_editions;
  if v_count < 2 then raise exception 'fixture_assertions: ref_editions has % rows, expected >= 2', v_count; end if;
  select count(*) into v_count from public.isbn_index;
  if v_count < 1 then raise exception 'fixture_assertions: isbn_index has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.model_versions;
  if v_count < 1 then raise exception 'fixture_assertions: model_versions has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.listing_facets;
  if v_count < 5 then raise exception 'fixture_assertions: listing_facets has % rows, expected >= 5', v_count; end if;
  select count(*) into v_count from public.evidence;
  if v_count < 2 then raise exception 'fixture_assertions: evidence has % rows, expected >= 2', v_count; end if;
  select count(*) into v_count from public.assertions;
  if v_count < 1 then raise exception 'fixture_assertions: assertions has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.local_works;
  if v_count < 1 then raise exception 'fixture_assertions: local_works has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.listing_links;
  if v_count < 2 then raise exception 'fixture_assertions: listing_links has % rows, expected >= 2', v_count; end if;
  select count(*) into v_count from public.identity_events;
  if v_count < 1 then raise exception 'fixture_assertions: identity_events has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.tasks;
  if v_count < 1 then raise exception 'fixture_assertions: tasks has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.prompts;
  if v_count < 1 then raise exception 'fixture_assertions: prompts has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.ai_runs;
  if v_count < 2 then raise exception 'fixture_assertions: ai_runs has % rows, expected >= 2', v_count; end if;
  select count(*) into v_count from public.works;
  if v_count < 1 then raise exception 'fixture_assertions: works has % rows, expected >= 1', v_count; end if;
  select count(*) into v_count from public.review_aspects;
  if v_count < 1 then raise exception 'fixture_assertions: review_aspects has % rows, expected >= 1', v_count; end if;
  if (select count(*) from public.listing_facets) <> (select count(*) from public.books) then
    raise exception 'fixture_assertions: every fixture book should have exactly one listing_facets row';
  end if;
  if not exists (select 1 from public.stores where is_synthetic) then
    raise exception 'fixture_assertions: no store is flagged is_synthetic';
  end if;
  if not exists (select 1 from public.ai_runs where parent_run_id is not null) then
    raise exception 'fixture_assertions: no ai_runs row has parent_run_id set';
  end if;
end
$$;

select 'PASS: fixture row counts meet the expected minimums (incl. one facet per book, a synthetic store, a child ai_run)' as gate;

-- 2. Path A control join ---------------------------------------------------------
-- books.isbn (canonical here) -> isbn_index -> ref_editions -> ref_works
-- must resolve store A's 'Effective Java' to the Effective Java work.

do $$
begin
  if not exists (
    select 1
    from public.books b
    join public.isbn_index ii on ii.isbn13 = b.isbn
    join public.ref_editions e on e.id = ii.edition_ref_id
    join public.ref_works w on w.id = e.work_ref_id
    where b.title = 'Effective Java'
      and b.store_id = (select id from public.stores where username = 'fixture-merchant-a')
      and w.title = 'Effective Java'
  ) then
    raise exception 'fixture_assertions: Path A join did not resolve store A Effective Java to the Effective Java work';
  end if;
end
$$;

select 'PASS: Path A control join resolves store A Effective Java -> Effective Java work' as gate;

select b.title as listing_title, e.title as edition_title, w.title as work_title
from public.books b
join public.isbn_index ii on ii.isbn13 = b.isbn
join public.ref_editions e on e.id = ii.edition_ref_id
join public.ref_works w on w.id = e.work_ref_id
where b.store_id = (select id from public.stores where username = 'fixture-merchant-a')
  and b.title = 'Effective Java';

-- 3. the lying ISBN really lies -----------------------------------------------------
-- store B's 'Design Patterns' carries the same isbn, so the same join
-- lands on the Effective Java edition/work — the title mismatch in the
-- output below is the fixture working as designed, not a join error.

do $$
begin
  if not exists (
    select 1
    from public.books b
    join public.isbn_index ii on ii.isbn13 = b.isbn
    join public.ref_editions e on e.id = ii.edition_ref_id
    join public.ref_works w on w.id = e.work_ref_id
    where b.title = 'Design Patterns'
      and w.title = 'Effective Java'
  ) then
    raise exception 'fixture_assertions: lying listing did not join to the Effective Java edition/work';
  end if;
end
$$;

select 'PASS: lying ISBN listing joins to the Effective Java edition (title mismatch is the fixture, visible below)' as gate;

select b.title as listing_title, e.title as edition_title, w.title as work_title
from public.books b
join public.isbn_index ii on ii.isbn13 = b.isbn
join public.ref_editions e on e.id = ii.edition_ref_id
join public.ref_works w on w.id = e.work_ref_id
where b.title = 'Design Patterns';

-- 4. evidence CHECK: exactly one candidate column -------------------------------------

do $$
declare
  v_listing bigint;
  v_edition bigint;
  v_work bigint;
  v_inserted boolean := false;
begin
  select id into v_listing from public.books where title = 'Clean Code';
  select id into v_edition from public.ref_editions
    where source_key = 'fixture/effective-java-edition-2018';
  select id into v_work from public.ref_works
    where source_key = 'fixture/effective-java';
  begin
    insert into public.evidence
      (listing_id, candidate_edition_id, candidate_work_id, bands, outcome)
    values (v_listing, v_edition, v_work, '{}'::jsonb, 'proposed');
    v_inserted := true;
  exception when check_violation then
    v_inserted := false;
  end;
  if v_inserted then
    raise exception 'fixture_assertions: evidence insert with two candidate columns unexpectedly succeeded';
  end if;
end
$$;

select 'PASS: evidence CHECK rejects an insert with two candidate columns set' as gate;

-- 5. listing_links CHECK: exactly one target shape --------------------------------------

do $$
declare
  v_listing bigint;
  v_edition bigint;
  v_local bigint;
  v_inserted boolean := false;
begin
  select id into v_listing from public.books where title = 'Clean Code';
  select id into v_edition from public.ref_editions
    where source_key = 'fixture/effective-java-edition-2018';
  select id into v_local from public.local_works where title = '红楼梦';
  begin
    insert into public.listing_links
      (listing_id, edition_ref_id, local_work_id, status)
    values (v_listing, v_edition, v_local, 'automatic');
    v_inserted := true;
  exception when check_violation then
    v_inserted := false;
  end;
  if v_inserted then
    raise exception 'fixture_assertions: listing_links insert with both local_work_id and edition_ref_id unexpectedly succeeded';
  end if;
end
$$;

select 'PASS: listing_links CHECK rejects a row with both local_work_id and edition_ref_id' as gate;

-- 6. the Path B task is claimable ----------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from public.tasks
    where kind = 'resolve_path_b' and status = 'pending' and run_after <= now()
  ) then
    raise exception 'fixture_assertions: no claimable resolve_path_b task (pending, run_after <= now())';
  end if;
end
$$;

select 'PASS: resolve_path_b task is claimable (status pending, run_after <= now())' as gate;

-- 7. assertions CHECK: a record cannot be asserted against itself -----------------

do $$
declare
  v_work bigint;
  v_inserted boolean := false;
begin
  select id into v_work from public.ref_works
    where source_key = 'fixture/effective-java';
  begin
    insert into public.assertions
      (left_kind, right_kind, left_id, right_id, relation, level, asserted_by)
    values ('ref_work', 'ref_work', v_work, v_work, 'same', 'work', 'gate-probe');
    v_inserted := true;
  exception when check_violation then
    v_inserted := false;
  end;
  if v_inserted then
    raise exception 'fixture_assertions: assertions insert pairing a record with itself unexpectedly succeeded';
  end if;
end
$$;

select 'PASS: assertions CHECK rejects a self-pair (same kind, same id)' as gate;
