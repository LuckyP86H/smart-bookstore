-- fixtures.sql — synthetic gate fixtures for P4 Step 2 (PR 2).
--
-- Applied by run_gate.sh to the live-equivalent DB only, after all
-- migrations. Everything here is invented gate data (snapshot
-- 'fixture-2026-11-11'); every store and listing is flagged
-- is_synthetic, per §4.4 / D-R9 (fixture stores are equally synthetic).
-- Ids are always resolved by subquery on natural keys (store username,
-- book title, source_key) so the file does not depend on identity
-- sequence values.
--
-- The listing set is built to exercise the identity paths:
--   * store A holds the honest 'Effective Java' with isbn 9780134685991;
--     store B holds 'Design Patterns' carrying the SAME isbn — that pair
--     is both the same-ISBN-at-2-stores case and the lying-ISBN case
--     (checksum-valid, wrong book). They cannot be separate rows at
--     store B: unique (store_id, isbn) forbids it, and one lying copy
--     is the better fixture anyway.
--   * store A holds a hyphen-variant isbn on a different book
--     ('Clean Code', '978-0-13-235088-4'); store B holds a lowercase-x
--     ISBN-10 variant ('The Design of Everyday Things', '080442957x').
--   * store A holds the NULL-isbn 红楼梦 (pre-1987, language 'zh') that
--     lands in the residue as a local work.
--   * store A's 'Effective Java' is the one sold listing (a sales row
--     and a customer review); every other listing is unsold.

begin;

-- stores: two merchants + one customer -------------------------------------

insert into public.stores (username, password, is_customer, is_synthetic) values
  ('fixture-merchant-a', 'fixture-password', false, true),
  ('fixture-merchant-b', 'fixture-password', false, true),
  ('fixture-customer', 'fixture-password', true, true);

-- books (listings) -----------------------------------------------------------

insert into public.books
  (store_id, isbn, title, author, genre, publisher, publication_year,
   page_count, language, price, stock_quantity, categories, is_synthetic)
select (select id from public.stores where username = 'fixture-merchant-a'),
  '9780134685991', 'Effective Java', 'Joshua Bloch', 'Programming',
  'Addison-Wesley', 2018, 416, 'en', 54.99, 5,
  '{Programming,Java}'::text[], true
union all
select (select id from public.stores where username = 'fixture-merchant-b'),
  '9780134685991', 'Design Patterns', 'Erich Gamma', 'Programming',
  'Addison-Wesley', 1994, 395, 'en', 49.99, 3,
  '{Programming,Design patterns}'::text[], true
union all
select (select id from public.stores where username = 'fixture-merchant-a'),
  '978-0-13-235088-4', 'Clean Code', 'Robert C. Martin', 'Programming',
  'Prentice Hall', 2008, 464, 'en', 44.99, 4,
  '{Programming,Craftsmanship}'::text[], true
union all
select (select id from public.stores where username = 'fixture-merchant-b'),
  '080442957x', 'The Design of Everyday Things', 'Don Norman', 'Design',
  'Basic Books', 1988, 257, 'en', 29.99, 2,
  '{Design,Usability}'::text[], true
union all
select (select id from public.stores where username = 'fixture-merchant-a'),
  null, '红楼梦', '曹雪芹', 'Fiction',
  '人民文学出版社', 1982, null, 'zh', 39.99, 1,
  '{Fiction,Chinese literature}'::text[], true;

-- the one sold listing: a sale and a review from the customer ----------------

insert into public.sales (book_id, customer_id, quantity, price_at_purchase)
select
  (select id from public.books
   where title = 'Effective Java'
     and store_id = (select id from public.stores where username = 'fixture-merchant-a')),
  (select id from public.stores where username = 'fixture-customer'),
  1, 54.99;

insert into public.reviews (book_id, customer_id, rating, review_text)
select
  (select id from public.books
   where title = 'Effective Java'
     and store_id = (select id from public.stores where username = 'fixture-merchant-a')),
  (select id from public.stores where username = 'fixture-customer'),
  5, 'Fixture review (synthetic gate data): clear examples, still relevant.';

update public.books
set total_sold = 1, average_rating = 5.00
where title = 'Effective Java'
  and store_id = (select id from public.stores where username = 'fixture-merchant-a');

-- reference catalogue, snapshot 'fixture-2026-11-11' ---------------------------

insert into public.ref_authors
  (source, source_key, snapshot_id, name, name_key, pinyin_key, birth_year, death_year)
values
  ('openlibrary', 'fixture/joshua-bloch', 'fixture-2026-11-11',
   'Joshua Bloch', 'joshua bloch', null, null, null),
  ('openlibrary', 'fixture/cao-xueqin', 'fixture-2026-11-11',
   '曹雪芹', '曹雪芹', 'cao xueqin', 1715, 1763);

insert into public.ref_author_aliases (author_ref_id, alias, alias_key, script, source)
select a.id, 'Bloch, Joshua', 'bloch, joshua', 'en', 'wikidata'
from public.ref_authors a where a.source_key = 'fixture/joshua-bloch'
union all
select a.id, 'Cao Xueqin', 'cao xueqin', 'en', 'wikidata'
from public.ref_authors a where a.source_key = 'fixture/cao-xueqin'
union all
select a.id, 'Tsao Hsueh-chin', 'tsao hsueh-chin', 'wade-giles', 'wikidata'
from public.ref_authors a where a.source_key = 'fixture/cao-xueqin';

insert into public.ref_works
  (source, source_key, snapshot_id, title, title_key, first_publish_year, subjects)
values
  ('openlibrary', 'fixture/effective-java', 'fixture-2026-11-11',
   'Effective Java', 'effective java', 2001, '{Programming,Java}'::text[]),
  ('openlibrary', 'fixture/hongloumeng', 'fixture-2026-11-11',
   '红楼梦', '红楼梦', 1791, '{Fiction,Chinese literature}'::text[]);

insert into public.ref_editions
  (source, source_key, snapshot_id, work_ref_id, isbn13, title, title_key,
   publisher, publish_year, language, page_count)
select 'openlibrary', 'fixture/effective-java-edition-2018', 'fixture-2026-11-11',
  w.id, '9780134685991', 'Effective Java', 'effective java',
  'Addison-Wesley', 2018, 'en', 416
from public.ref_works w where w.source_key = 'fixture/effective-java'
union all
select 'openlibrary', 'fixture/hongloumeng-edition-1982', 'fixture-2026-11-11',
  w.id, null, '红楼梦', '红楼梦',
  '人民文学出版社', 1982, 'zh', null
from public.ref_works w where w.source_key = 'fixture/hongloumeng';

insert into public.isbn_index (isbn13, edition_ref_id, snapshot_id)
select '9780134685991', e.id, 'fixture-2026-11-11'
from public.ref_editions e
where e.source_key = 'fixture/effective-java-edition-2018';

-- model version ----------------------------------------------------------------

insert into public.model_versions
  (name, weights, thresholds, comparison_defs, benchmark_results)
values
  ('pathb-fixture-0',
   '{"isbn": 0.4, "title": 0.3, "author": 0.3}'::jsonb,
   '{"auto_link": 0.9, "propose": 0.6}'::jsonb,
   '{"bands": ["isbn", "title", "author"]}'::jsonb,
   '{"fixture": true}'::jsonb);

-- listing facets, one per fixture book ------------------------------------------
-- isbn13 is the canonical form where one is derivable: hyphens stripped
-- ('978-0-13-235088-4' -> 9780132350884) and the ISBN-10 '080442957x'
-- converted (978 + first 9 digits + recomputed check digit =
-- 9780804429573). The NULL-isbn listing has no canonical isbn13.

insert into public.listing_facets (listing_id, isbn13, title_key, author_keys, language)
select b.id, '9780134685991', 'effective java', '{"joshua bloch"}'::text[], 'en'
from public.books b
where b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a');

insert into public.listing_facets (listing_id, isbn13, title_key, author_keys, language)
select b.id, '9780134685991', 'design patterns', '{"erich gamma"}'::text[], 'en'
from public.books b
where b.title = 'Design Patterns';

insert into public.listing_facets (listing_id, isbn13, title_key, author_keys, language)
select b.id, '9780132350884', 'clean code', '{"robert c. martin"}'::text[], 'en'
from public.books b
where b.title = 'Clean Code';

insert into public.listing_facets (listing_id, isbn13, title_key, author_keys, language)
select b.id, '9780804429573', 'the design of everyday things', '{"don norman"}'::text[], 'en'
from public.books b
where b.title = 'The Design of Everyday Things';

insert into public.listing_facets (listing_id, isbn13, title_key, author_keys, language)
select b.id, null, '红楼梦', '{"曹雪芹", "cao xueqin"}'::text[], 'zh'
from public.books b
where b.title = '红楼梦';

-- prompts + ai runs --------------------------------------------------------------

insert into public.prompts (key, version, body, description) values
  ('work_summary', 1,
   'Fixture prompt body: summarise the work titled {{title}} from its catalogue metadata.',
   'Fixture prompt for the P4 schema gate.');

insert into public.ai_runs
  (kind, provider, model, input, output, status, listing_id)
select 'embedding', 'workers-ai', '@cf/baai/bge-m3',
  '{"texts": ["Effective Java by Joshua Bloch"]}'::jsonb,
  '{"dimensions": 1024, "vectors": 1}'::jsonb,
  'ok', b.id
from public.books b
where b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a');

insert into public.ai_runs
  (parent_run_id, kind, provider, model, input, output, status, listing_id)
select p.id, 'derive_listing_links', 'worker', null,
  '{"path": "a", "isbn13": "9780134685991"}'::jsonb,
  '{"link_status": "automatic"}'::jsonb,
  'ok', b.id
from public.ai_runs p, public.books b
where p.kind = 'embedding'
  and b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a');

-- evidence: one auto-link, one rejection kept as negative lineage -----------------

insert into public.evidence
  (listing_id, candidate_edition_id, bands, weights, total_score, model_version_id, outcome)
select b.id, e.id,
  '{"isbn": "exact", "title": "exact", "author": "exact"}'::jsonb,
  '{"isbn": 0.4, "title": 0.3, "author": 0.3}'::jsonb,
  0.98,
  (select id from public.model_versions where name = 'pathb-fixture-0'),
  'auto_linked'
from public.books b, public.ref_editions e
where b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a')
  and e.source_key = 'fixture/effective-java-edition-2018';

-- the lying listing: the isbn matches the Effective Java edition exactly,
-- the title and author do not — rejected, and the pair is kept forever.
insert into public.evidence
  (listing_id, candidate_edition_id, bands, weights, total_score, model_version_id, outcome)
select b.id, e.id,
  '{"isbn": "exact", "title": "mismatch", "author": "mismatch"}'::jsonb,
  '{"isbn": 0.4, "title": 0.3, "author": 0.3}'::jsonb,
  0.41,
  (select id from public.model_versions where name = 'pathb-fixture-0'),
  'rejected'
from public.books b, public.ref_editions e
where b.title = 'Design Patterns'
  and e.source_key = 'fixture/effective-java-edition-2018';

-- assertions -----------------------------------------------------------------------
-- with exactly two distinct reference works in the fixture set, the only
-- 'same' pair available at work level is the Effective Java work paired
-- with itself; it exercises the assertion shape against real row ids.

insert into public.assertions
  (left_kind, right_kind, left_id, right_id, relation, level, asserted_by, reason)
select 'ref_work', 'ref_work', w.id, w.id, 'same', 'work', 'owner',
  'Fixture assertion: the owner confirms the identity of the Effective Java reference work.'
from public.ref_works w
where w.source_key = 'fixture/effective-java';

-- local work for the residue + listing links -----------------------------------------

insert into public.local_works (title, created_from, variant_of_ref_work_id)
values ('红楼梦', 'residue', null);

insert into public.listing_links
  (listing_id, edition_ref_id, work_ref_id, local_work_id, status, derivation_run_id)
select b.id, null, null, lw.id, 'automatic', null
from public.books b, public.local_works lw
where b.title = '红楼梦' and lw.title = '红楼梦';

insert into public.listing_links
  (listing_id, edition_ref_id, work_ref_id, local_work_id, status, derivation_run_id)
select b.id, e.id, w.id, null, 'automatic', r.id
from public.books b, public.ref_editions e, public.ref_works w, public.ai_runs r
where b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a')
  and e.source_key = 'fixture/effective-java-edition-2018'
  and w.source_key = 'fixture/effective-java'
  and r.kind = 'derive_listing_links';

-- identity event: the link receipt, with its evidence manifest ------------------------

insert into public.identity_events
  (listing_id, local_work_id, event_type, from_state, to_state,
   evidence_ids, manifest, model_version_id, actor)
select b.id, null, 'link',
  '{"link": null}'::jsonb,
  jsonb_build_object('edition_ref_id', e.id, 'work_ref_id', w.id),
  array[(select id from public.evidence where outcome = 'auto_linked')],
  jsonb_build_object(
    'model_version', 'pathb-fixture-0',
    'thresholds', '{"auto_link": 0.9, "propose": 0.6}'::jsonb,
    'evidence_ids', jsonb_build_array((select id from public.evidence where outcome = 'auto_linked')),
    'bands', '{"isbn": "exact", "title": "exact", "author": "exact"}'::jsonb
  ),
  (select id from public.model_versions where name = 'pathb-fixture-0'),
  'fixture'
from public.books b, public.ref_editions e, public.ref_works w
where b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a')
  and e.source_key = 'fixture/effective-java-edition-2018'
  and w.source_key = 'fixture/effective-java';

-- tasks: Path B resolution queued for the hyphen-variant listing ------------------------

insert into public.tasks (kind, listing_id, payload, status)
select 'resolve_path_b', b.id,
  '{"raw_isbn": "978-0-13-235088-4", "reason": "hyphenated isbn-13 in the raw listing; canonical isbn13 lives in listing_facets"}'::jsonb,
  'pending'
from public.books b
where b.title = 'Clean Code';

-- works projection -----------------------------------------------------------------------

insert into public.works
  (work_ref_id, local_work_id, title, author_display, categories, summary_en, summary_zh)
select w.id, null, 'Effective Java', 'Joshua Bloch',
  '{Programming,Java}'::text[],
  'Fixture summary (synthetic gate data): a practical guide to Java best practices.',
  '这是 Effective Java 的夹具投影行（合成门禁数据）。'
from public.ref_works w
where w.source_key = 'fixture/effective-java';

-- review aspects substrate, tied to the fixture review -------------------------------------

insert into public.review_aspects (review_id, aspects, status, model)
select r.id, null, 'pending', null
from public.reviews r
join public.books b on b.id = r.book_id
where b.title = 'Effective Java'
  and b.store_id = (select id from public.stores where username = 'fixture-merchant-a');

commit;
