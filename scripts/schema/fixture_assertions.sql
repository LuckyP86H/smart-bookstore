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
  -- Guard (PR #63 review round 2): a missed lookup leaves NULLs, and a
  -- probe insert with zero candidate columns violates the CHECK for the
  -- wrong reason — the probe would PASS while testing nothing. Fail
  -- loud on a missing fixture instead.
  if v_listing is null or v_edition is null or v_work is null then
    raise exception 'fixture_assertions: evidence probe fixture lookup missed (listing=%, edition=%, work=%)', v_listing, v_edition, v_work;
  end if;
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
  -- Guard (PR #63 review round 2): same false-pass shape as the
  -- evidence probe above — if the '红楼梦' lookup misses, v_local is
  -- NULL and the inserted row's shape violates the CHECK without the
  -- probe ever exercising the two-target case. Fail loud instead.
  if v_listing is null or v_edition is null or v_local is null then
    raise exception 'fixture_assertions: listing_links probe fixture lookup missed (listing=%, edition=%, local_work=%)', v_listing, v_edition, v_local;
  end if;
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
-- The claimable predicate is derived from plan §5's claim semantics,
-- not quoted from it: §5 gives the claim mechanism (the sweep claims
-- pending rows with FOR UPDATE SKIP LOCKED, in priority order, and
-- locked_until is the visibility timeout) but never writes a WHERE
-- clause. Spelled out as a predicate, a task is claimable when it is
-- pending, its run_after is due, and it is not locked (locked_until
-- NULL or already past). The fixture task (locked_until NULL) must
-- match it; the probes below pin the other two directions — a
-- future-locked task and a future-dated task must NOT match, a
-- past-locked one must. (Before PR #63 review round 4 the probe
-- ignored locked_until entirely, so a future-locked task "passed" as
-- claimable.)

do $$
declare
  v_future_locked bigint;
  v_past_locked bigint;
  v_future_dated bigint;
begin
  if not exists (
    select 1 from public.tasks
    where kind = 'resolve_path_b' and status = 'pending'
      and run_after <= now()
      and (locked_until is null or locked_until <= now())
  ) then
    raise exception 'fixture_assertions: no claimable resolve_path_b task (pending, run_after due, not locked)';
  end if;
  insert into public.tasks (kind, status, locked_until)
  values ('resolve_path_b', 'pending', now() + interval '1 hour')
  returning id into v_future_locked;
  insert into public.tasks (kind, status, locked_until)
  values ('resolve_path_b', 'pending', now() - interval '1 minute')
  returning id into v_past_locked;
  insert into public.tasks (kind, status, run_after)
  values ('resolve_path_b', 'pending', now() + interval '1 hour')
  returning id into v_future_dated;
  if exists (
    select 1 from public.tasks
    where id = v_future_locked and status = 'pending' and run_after <= now()
      and (locked_until is null or locked_until <= now())
  ) then
    raise exception 'fixture_assertions: future-locked task % reads as claimable', v_future_locked;
  end if;
  if not exists (
    select 1 from public.tasks
    where id = v_past_locked and status = 'pending' and run_after <= now()
      and (locked_until is null or locked_until <= now())
  ) then
    raise exception 'fixture_assertions: past-locked task % does not read as claimable', v_past_locked;
  end if;
  if exists (
    select 1 from public.tasks
    where id = v_future_dated and status = 'pending' and run_after <= now()
      and (locked_until is null or locked_until <= now())
  ) then
    raise exception 'fixture_assertions: future-dated task % reads as claimable', v_future_dated;
  end if;
  delete from public.tasks where id in (v_future_locked, v_past_locked, v_future_dated);
end
$$;

select 'PASS: resolve_path_b task is claimable (status pending, run_after due, locked_until not in the future); future-locked and future-dated probes are not claimable' as gate;

-- 7. assertions CHECK: a record cannot be asserted against itself -----------------

do $$
declare
  v_work bigint;
  v_inserted boolean := false;
begin
  select id into v_work from public.ref_works
    where source_key = 'fixture/effective-java';
  -- Guard (PR #63 review round 2): same pattern as the probes above —
  -- never let a missed fixture lookup decide what this probe tests.
  if v_work is null then
    raise exception 'fixture_assertions: assertions probe fixture lookup missed (work=%)', v_work;
  end if;
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

-- 8. updated_at actually advances on UPDATE (D-R11 behavioural proof) ------------
-- assertions.sql §11 asserts the trigger wiring exists; this section
-- proves the behaviour end to end on all six tables that carry the
-- trigger (listing_facets, local_works, listing_links, tasks, works,
-- review_aspects): update a probe row in a LATER transaction and
-- require updated_at to have moved past created_at. Two tables get
-- fresh probe rows (tasks, local_works); the other four reuse their
-- fixture rows — the Effective Java listing's facets and link, its
-- works projection row, and its review's aspects row. The probes are
-- separate statements on purpose — now() is the transaction
-- timestamp, so insert and update must not share one — with a
-- pg_sleep between them for margin. The per-table update and check
-- statements run as data-driven loops over (table, statement) pairs
-- so the six tables cannot drift apart. Inserted probe rows are
-- deleted at the end; a failed assertion leaves them behind for
-- debugging.

do $$
declare
  v_facets bigint;
  v_link bigint;
  v_work bigint;
  v_aspects bigint;
begin
  insert into public.tasks (kind, status) values ('gate_probe_updated_at', 'pending');
  insert into public.local_works (title) values ('gate probe updated_at');
  -- The four reused fixture rows, resolved by natural key. Guarded
  -- like every other probe lookup in this file: a missed lookup must
  -- fail loud here, never silently shrink what the probe exercises.
  select listing_id into v_facets from public.listing_facets
  where title_key = 'effective java';
  select id into v_link from public.listing_links
  where listing_id = (select id from public.books
                      where title = 'Effective Java'
                        and store_id = (select id from public.stores
                                        where username = 'fixture-merchant-a'));
  select id into v_work from public.works
  where work_ref_id = (select id from public.ref_works
                       where source_key = 'fixture/effective-java');
  select id into v_aspects from public.review_aspects
  where review_id = (select r.id from public.reviews r
                     join public.books b on b.id = r.book_id
                     where b.title = 'Effective Java'
                       and b.store_id = (select id from public.stores
                                          where username = 'fixture-merchant-a'));
  if v_facets is null or v_link is null or v_work is null or v_aspects is null then
    raise exception 'fixture_assertions: updated_at probe fixture lookup missed (facets=%, link=%, work=%, aspects=%)', v_facets, v_link, v_work, v_aspects;
  end if;
end
$$;

select pg_sleep(0.05);

do $$
declare
  probe record;
  v_rows integer;
begin
  for probe in
    select * from (values
      ('tasks',
       $u$update public.tasks set attempts = attempts + 1 where kind = 'gate_probe_updated_at'$u$),
      ('local_works',
       $u$update public.local_works set title = title where title = 'gate probe updated_at'$u$),
      ('listing_facets',
       $u$update public.listing_facets set title_key = title_key where title_key = 'effective java'$u$),
      ('listing_links',
       $u$update public.listing_links set status = status where listing_id = (select id from public.books where title = 'Effective Java' and store_id = (select id from public.stores where username = 'fixture-merchant-a'))$u$),
      ('works',
       $u$update public.works set title = title where work_ref_id = (select id from public.ref_works where source_key = 'fixture/effective-java')$u$),
      ('review_aspects',
       $u$update public.review_aspects set status = status where review_id = (select r.id from public.reviews r join public.books b on b.id = r.book_id where b.title = 'Effective Java' and b.store_id = (select id from public.stores where username = 'fixture-merchant-a'))$u$)
    ) as p(label, stmt)
  loop
    execute probe.stmt;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'fixture_assertions: updated_at probe update on % hit % rows (expected 1)', probe.label, v_rows;
    end if;
  end loop;
end
$$;

do $$
declare
  probe record;
  v_created timestamptz;
  v_updated timestamptz;
begin
  for probe in
    select * from (values
      ('tasks',
       $q$select created_at, updated_at from public.tasks where kind = 'gate_probe_updated_at'$q$),
      ('local_works',
       $q$select created_at, updated_at from public.local_works where title = 'gate probe updated_at'$q$),
      ('listing_facets',
       $q$select created_at, updated_at from public.listing_facets where title_key = 'effective java'$q$),
      ('listing_links',
       $q$select created_at, updated_at from public.listing_links where listing_id = (select id from public.books where title = 'Effective Java' and store_id = (select id from public.stores where username = 'fixture-merchant-a'))$q$),
      ('works',
       $q$select created_at, updated_at from public.works where work_ref_id = (select id from public.ref_works where source_key = 'fixture/effective-java')$q$),
      ('review_aspects',
       $q$select created_at, updated_at from public.review_aspects where review_id = (select r.id from public.reviews r join public.books b on b.id = r.book_id where b.title = 'Effective Java' and b.store_id = (select id from public.stores where username = 'fixture-merchant-a'))$q$)
    ) as p(label, stmt)
  loop
    execute probe.stmt into v_created, v_updated;
    if v_created is null then
      raise exception 'fixture_assertions: updated_at probe row for % not found', probe.label;
    end if;
    if not (v_updated > v_created) then
      raise exception 'fixture_assertions: %.updated_at did not advance on UPDATE (created %, updated %)', probe.label, v_created, v_updated;
    end if;
  end loop;
  delete from public.tasks where kind = 'gate_probe_updated_at';
  delete from public.local_works where title = 'gate probe updated_at';
end
$$;

select 'PASS: updated_at advances past created_at on UPDATE (all six triggered tables: listing_facets, local_works, listing_links, tasks, works, review_aspects — D-R11 trigger behaviour)' as gate;

-- 9. works CHECK: exactly one source ------------------------------------------------
-- Both directions, like §6: a projection row naming BOTH a reference
-- work and a local work, and one naming NEITHER, must both be
-- rejected. (The constraint existed since PR 2 but had no rejection
-- probe until this round — findings F13.)

do $$
declare
  v_ref bigint;
  v_local bigint;
  v_inserted boolean := false;
begin
  select id into v_ref from public.ref_works
    where source_key = 'fixture/effective-java';
  select id into v_local from public.local_works where title = '红楼梦';
  if v_ref is null or v_local is null then
    raise exception 'fixture_assertions: works probe fixture lookup missed (ref_work=%, local_work=%)', v_ref, v_local;
  end if;
  begin
    insert into public.works (work_ref_id, local_work_id, title)
    values (v_ref, v_local, 'gate probe');
    v_inserted := true;
  exception when check_violation then
    v_inserted := false;
  end;
  if v_inserted then
    raise exception 'fixture_assertions: works insert with both sources set unexpectedly succeeded';
  end if;
  begin
    insert into public.works (work_ref_id, local_work_id, title)
    values (null, null, 'gate probe');
    v_inserted := true;
  exception when check_violation then
    v_inserted := false;
  end;
  if v_inserted then
    raise exception 'fixture_assertions: works insert with neither source set unexpectedly succeeded';
  end if;
end
$$;

select 'PASS: works CHECK rejects a row with both sources set and a row with neither source set' as gate;
