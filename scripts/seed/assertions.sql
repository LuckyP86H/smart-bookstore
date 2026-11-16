-- assertions.sql — gate assertions for P4 Steps 3–4 (PR 3).
--
-- Runs against the gate database ONLY (sb_p4_seed): scaffolding + all
-- 8 migrations + the real PR 1 slice loaded by scripts/seed/
-- load_slice.py + the synthetic generator + link_seed.ts (the
-- Worker's own Path A code). Pattern mirrors scripts/schema/
-- assertions.sql: a DO block raises on failure (psql ON_ERROR_STOP
-- stops the file), then a SELECT prints the PASS line.
--
-- The count constants are THIS slice's manifest numbers
-- (out/slice_manifest.json: 4,993 works / 20,000 editions / 5,070
-- authors; isbn_index 13,940 cross-checked against PR 1's independent
-- isbn_map.parquet). The loader asserts them too; this file is the
-- second, independent reader.
--
-- Archetype identification is by construction, not by id: the gate DB
-- holds ONLY the seed stores/listings. Sold = total_sold 1; lying =
-- seed-merchant-c's listing; hyphen = isbn containing '-'; X-ISBN-10 =
-- isbn matching ^[0-9]{9}x$; NULL-ISBN = isbn IS NULL.

-- 1. loaded counts equal the manifest -------------------------------------

do $$
begin
  if (select count(*) from ref_authors) <> 5070 then
    raise exception 'assertions: ref_authors count %', (select count(*) from ref_authors);
  end if;
  -- Pinned in the fix round (PR #67 nit): the alias total was stated
  -- in the docs but only ever checked against the loader's own
  -- self-derived expectation; this file is the independent reader.
  if (select count(*) from ref_author_aliases) <> 21597 then
    raise exception 'assertions: ref_author_aliases count %', (select count(*) from ref_author_aliases);
  end if;
  if (select count(*) from ref_works) <> 4993 then
    raise exception 'assertions: ref_works count %', (select count(*) from ref_works);
  end if;
  if (select count(*) from ref_editions) <> 20000 then
    raise exception 'assertions: ref_editions count %', (select count(*) from ref_editions);
  end if;
  if (select count(*) from isbn_index) <> 13940 then
    raise exception 'assertions: isbn_index count %', (select count(*) from isbn_index);
  end if;
  if (select count(*) from works where work_ref_id is not null) <> 4993 then
    raise exception 'assertions: works projection count %',
      (select count(*) from works where work_ref_id is not null);
  end if;
  if (select count(distinct snapshot_id) from ref_works) <> 1
     or (select count(distinct snapshot_id) from ref_editions) <> 1
     or (select count(distinct snapshot_id) from ref_authors) <> 1 then
    raise exception 'assertions: reference rows are not stamped with one snapshot';
  end if;
end
$$;

select 'PASS: loaded counts equal the manifest (5070/21597/4993/20000/13940/4993), one snapshot' as gate;

-- 2. seed shape: 4 synthetic stores, 8 synthetic listings --------------------

do $$
begin
  if (select count(*) from stores where is_synthetic) <> 4 then
    raise exception 'assertions: synthetic store count %',
      (select count(*) from stores where is_synthetic);
  end if;
  if (select count(*) from books where is_synthetic) <> 8 then
    raise exception 'assertions: synthetic listing count %',
      (select count(*) from books where is_synthetic);
  end if;
  if exists (select 1 from books b join stores s on s.id = b.store_id
             where s.is_synthetic and not b.is_synthetic) then
    raise exception 'assertions: a seed-store listing is missing is_synthetic';
  end if;
end
$$;

select 'PASS: 4 synthetic stores, 8 synthetic listings, flags consistent' as gate;

-- 3. links: exactly the 6 honest ISBN'd listings, fully lineaged -------------

do $$
declare
  v_links integer;
begin
  select count(*) into v_links
  from listing_links ll join books b on b.id = ll.listing_id
  where b.is_synthetic;
  if v_links <> 6 then
    raise exception 'assertions: synthetic listing_links count % (expected 6)', v_links;
  end if;
  if exists (
    select 1 from listing_links ll join books b on b.id = ll.listing_id
    where b.is_synthetic
      and (ll.status <> 'automatic' or ll.derivation_run_id is null
           or ll.edition_ref_id is null or ll.work_ref_id is null)
  ) then
    raise exception 'assertions: a synthetic link is incomplete or not automatic';
  end if;
  if exists (
    select 1 from listing_links ll join books b on b.id = ll.listing_id
    join ai_runs r on r.id = ll.derivation_run_id
    where b.is_synthetic
      and (r.kind <> 'derive_listing_links' or r.status <> 'ok'
           or r.output is null)
  ) then
    raise exception 'assertions: a derivation ai_run is missing or unfinished';
  end if;
  -- Fix round item 15: the README/PR claim "ai_runs payloads are
  -- verified jsonb objects" is now actually verified. A
  -- double-encoded payload (a JSON string scalar — exactly the bug
  -- PR #63's rounds caught in ai/runs.ts) has jsonb_typeof 'string'
  -- and must fail here, for BOTH input and output.
  if exists (
    select 1 from listing_links ll join books b on b.id = ll.listing_id
    join ai_runs r on r.id = ll.derivation_run_id
    where b.is_synthetic
      and (jsonb_typeof(r.input) <> 'object'
           or jsonb_typeof(r.output) <> 'object')
  ) then
    raise exception 'assertions: a derivation ai_run payload is not a jsonb object (double-encoded?)';
  end if;
  if (select count(*) from identity_events ev join books b
        on b.id = ev.listing_id
      where b.is_synthetic and ev.event_type = 'link'
        and ev.actor = 'path-a') <> 6 then
    raise exception 'assertions: link identity_events count is not 6';
  end if;
  if (select count(*) from evidence e join books b on b.id = e.listing_id
      where b.is_synthetic and e.outcome = 'auto_linked') <> 6 then
    raise exception 'assertions: auto_linked evidence count is not 6';
  end if;
  if (select count(*) from listing_facets f join books b
        on b.id = f.listing_id
      where b.is_synthetic and f.isbn13 is not null) <> 6 then
    raise exception 'assertions: facets rows for linked listings is not 6';
  end if;
end
$$;

select 'PASS: 6 links, each with ai_run, auto_linked evidence, facet, link event' as gate;

-- 4. the lying-ISBN listing: demoted, flagged, never linked -------------------

do $$
declare
  v_lying bigint;
begin
  select b.id into v_lying from books b
  join stores s on s.id = b.store_id
  where s.username = 'seed-merchant-c' and b.is_synthetic;
  if v_lying is null then
    raise exception 'assertions: lying listing not found';
  end if;
  if exists (select 1 from listing_links where listing_id = v_lying) then
    raise exception 'assertions: LYING listing % was auto-linked', v_lying;
  end if;
  if not exists (
    select 1 from evidence
    where listing_id = v_lying and outcome = 'rejected'
      and bands ->> 'title' = 'mismatch'
  ) then
    raise exception 'assertions: lying listing has no rejected evidence with title mismatch';
  end if;
  if exists (
    select 1 from identity_events
    where listing_id = v_lying and event_type = 'link'
  ) then
    raise exception 'assertions: lying listing has a link event';
  end if;
end
$$;

select 'PASS: lying-ISBN listing demoted + flagged (rejected evidence), zero auto-links' as gate;

-- 5. the hub work is genuinely multi-store, multi-edition ----------------------

do $$
declare
  v_work bigint;
  v_links integer;
  v_stores integer;
  v_editions integer;
begin
  select ll.work_ref_id into v_work
  from listing_links ll join books b on b.id = ll.listing_id
  where b.is_synthetic and b.total_sold = 1;
  if v_work is null then
    raise exception 'assertions: sold listing is not linked';
  end if;
  select count(*), count(distinct b.store_id), count(distinct ll.edition_ref_id)
    into v_links, v_stores, v_editions
  from listing_links ll join books b on b.id = ll.listing_id
  where ll.work_ref_id = v_work and b.is_synthetic;
  if v_links <> 4 or v_stores < 2 or v_editions < 2 then
    raise exception 'assertions: hub work links=% stores=% editions=% (expected 4/>=2/>=2)',
      v_links, v_stores, v_editions;
  end if;
  if not exists (
    select 1 from works where work_ref_id = v_work
      and author_display is not null and author_display <> ''
  ) then
    raise exception 'assertions: hub work projection lacks author_display';
  end if;
end
$$;

select 'PASS: hub work has 4 linked listings across >=2 stores and >=2 editions' as gate;

-- 6. canonicalisation archetypes linked (hyphen strip, ISBN-10 X convert) -----

do $$
begin
  if not exists (
    select 1 from books b join listing_links ll on ll.listing_id = b.id
    where b.is_synthetic and b.isbn like '%-%'
  ) then
    raise exception 'assertions: hyphenated-ISBN listing is not linked';
  end if;
  if not exists (
    select 1 from books b
    join listing_links ll on ll.listing_id = b.id
    join listing_facets f on f.listing_id = b.id
    where b.is_synthetic and b.isbn ~ '^[0-9]{9}x$'
      and f.isbn13 like '978%' and length(f.isbn13) = 13
  ) then
    raise exception 'assertions: lowercase-x ISBN-10 listing not linked with canonical facet';
  end if;
end
$$;

select 'PASS: hyphenated ISBN-13 and lowercase-x ISBN-10 listings linked canonically' as gate;

-- 7. the NULL-ISBN listing: untouched by Path A --------------------------------

do $$
begin
  if exists (
    select 1 from books b
    left join listing_links ll on ll.listing_id = b.id
    where b.is_synthetic and b.isbn is null and ll.listing_id is not null
  ) then
    raise exception 'assertions: NULL-ISBN listing was linked';
  end if;
  if exists (
    select 1 from evidence e join books b on b.id = e.listing_id
    where b.is_synthetic and b.isbn is null
  ) then
    raise exception 'assertions: NULL-ISBN listing has evidence (no attempt should be made)';
  end if;
end
$$;

select 'PASS: NULL-ISBN listing has no link and no evidence (no ISBN, no attempt)' as gate;

-- 8. the sold archetype's paper trail -------------------------------------------

do $$
declare
  v_sold bigint;
begin
  select id into v_sold from books where is_synthetic and total_sold = 1;
  if v_sold is null then
    raise exception 'assertions: sold listing not found';
  end if;
  if (select count(*) from sales where book_id = v_sold) <> 1
     or (select count(*) from reviews where book_id = v_sold and rating = 5) <> 1
     or (select average_rating from books where id = v_sold) <> 5.00 then
    raise exception 'assertions: sold listing sale/review/counters inconsistent';
  end if;
end
$$;

select 'PASS: sold listing carries its sale, 5-star review, and counters' as gate;

-- 9. F1: review_aspects_queue runs with invoker rights (fix round item 5) -----

do $$
declare
  v_sold bigint;
  v_customer bigint;
  v_review bigint;
  v_invoker_blocked boolean := false;
  v_owner_count integer := -1;
  v_n integer;
begin
  -- (a) catalog: the shipped view (migration 20261111130500) carries
  -- security_invoker in its reloptions.
  if not exists (
    select 1 from pg_class
    where relname = 'review_aspects_queue' and relkind = 'v'
      and reloptions is not null
      and 'security_invoker=true' = any (reloptions)
  ) then
    raise exception 'assertions: review_aspects_queue lacks security_invoker=true in pg_class.reloptions';
  end if;

  -- (b) functional probe that distinguishes the two semantics. A
  -- probe role is granted SELECT on the view but has NO access to the
  -- underlying tables (which are RLS-enabled with no policies):
  --   * through the shipped (invoker) view its query must be REFUSED;
  --   * through an identical owner-semantics probe view it must
  --     ANSWER (the owner bypasses the underlying restrictions) —
  --     proving the probe can tell the two apart on THIS database.
  -- A pending review_aspects row is planted so the owner view has
  -- something to return; all probe artifacts are removed before the
  -- block ends (the gate DB is throwaway, but verify_workpage runs
  -- after this file against the same database).
  -- Any synthetic listing with no review yet (reviews is unique on
  -- (book_id, customer_id) and the sold listing already carries the
  -- seed customer's review).
  select b.id into v_sold from books b
  where b.is_synthetic
    and not exists (select 1 from reviews r where r.book_id = b.id)
  order by b.id limit 1;
  select id into v_customer from stores where username = 'seed-customer';
  if v_sold is null or v_customer is null then
    raise exception 'assertions: F1 probe fixtures missing (reviewless listing / seed customer)';
  end if;
  insert into reviews (book_id, customer_id, rating, review_text)
  values (v_sold, v_customer, 4, 'gate F1 probe review')
  returning id into v_review;
  insert into review_aspects (review_id, status) values (v_review, 'pending');

  if not exists (select 1 from pg_roles where rolname = 'sb_gate_probe') then
    execute 'create role sb_gate_probe nologin';
  end if;
  -- The control view repeats the queue's base query WITHOUT
  -- security_invoker, so it runs with owner semantics.
  execute $v$create view public.sb_gate_probe_owner_view as
    select ra.id as review_aspects_id, ra.status as aspects_status,
           r.id as review_id, r.book_id, r.customer_id, r.rating,
           r.review_text, r.created_at as review_created_at,
           b.store_id, b.title as book_title, b.author as book_author
    from public.review_aspects ra
    join public.reviews r on r.id = ra.review_id
    join public.books b on b.id = r.book_id
    where ra.status = 'pending'$v$;
  execute 'grant select on public.review_aspects_queue to sb_gate_probe';
  execute 'grant select on public.sb_gate_probe_owner_view to sb_gate_probe';

  execute 'set role sb_gate_probe';
  begin
    select count(*) into v_n from public.review_aspects_queue;
  exception when others then
    v_invoker_blocked := true;
  end;
  begin
    select count(*) into v_owner_count from public.sb_gate_probe_owner_view;
  exception when others then
    v_owner_count := -2;
  end;
  execute 'reset role';

  execute 'revoke select on public.review_aspects_queue from sb_gate_probe';
  execute 'revoke select on public.sb_gate_probe_owner_view from sb_gate_probe';
  execute 'drop view public.sb_gate_probe_owner_view';
  delete from review_aspects where review_id = v_review;
  delete from reviews where id = v_review;

  if not v_invoker_blocked then
    raise exception 'assertions: probe role could read review_aspects_queue — view is NOT running with invoker rights';
  end if;
  if v_owner_count < 1 then
    raise exception 'assertions: probe control failed — owner-semantics view returned % (expected >= 1); the probe cannot distinguish the semantics', v_owner_count;
  end if;
end
$$;

select 'PASS: review_aspects_queue has security_invoker=true and refuses a role without underlying access (owner-semantics control answers)' as gate;
