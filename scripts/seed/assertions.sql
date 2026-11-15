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

select 'PASS: loaded counts equal the manifest (5070/4993/20000/13940/4993), one snapshot' as gate;

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
