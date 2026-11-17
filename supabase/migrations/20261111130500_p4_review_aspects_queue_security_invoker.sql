-- 20261111130500_p4_review_aspects_queue_security_invoker.sql
-- P4 PR 3 fix round (2026-11-16, PR #67 review item 5 / finding F1):
-- recreate public.review_aspects_queue WITH (security_invoker = true).
--
-- The view was created in 20261111130400_p4_ai_platform.sql with the
-- Postgres default (security_invoker = false): a query through the
-- view then accesses the underlying tables with the VIEW OWNER's
-- rights, not the caller's. The underlying tables (reviews, books,
-- review_aspects) have RLS enabled with no policies, which protects
-- them from the public API keys directly — but through an
-- owner-semantics view readable via PostgREST, that protection is
-- bypassed: the view would answer with the owner's access.
--
-- The exposure exists from the moment 20261111130400 is applied,
-- whether or not any seed data is ever loaded (the seed README's
-- original framing — a manual pre-seed dashboard check — understated
-- this and left no durable record; this migration IS the fix, so the
-- owner's procedure is simply: apply it in filename order with the
-- other five P4 migrations).
--
-- With security_invoker = true (Postgres 15+), the view runs with the
-- INVOKING user's rights: underlying-table grants and RLS policies
-- apply to the caller, so an API role with no access to the underlying
-- tables gets nothing through the view either. The view's definition
-- (columns, joins, pending filter) is byte-for-byte the one from
-- 20261111130400; only the security property changes.
--
-- The seed gate proves both halves (scripts/seed/assertions.sql §9):
-- the catalog carries security_invoker in the view's reloptions, and a
-- functional probe — a role granted SELECT on the view but with no
-- access to the underlying tables — is REFUSED through this view
-- while an identical owner-semantics probe view answers it.

create or replace view public.review_aspects_queue
  with (security_invoker = true) as
select
  ra.id as review_aspects_id,
  ra.status as aspects_status,
  r.id as review_id,
  r.book_id,
  r.customer_id,
  r.rating,
  r.review_text,
  r.created_at as review_created_at,
  b.store_id,
  b.title as book_title,
  b.author as book_author
from public.review_aspects ra
join public.reviews r on r.id = ra.review_id
join public.books b on b.id = r.book_id
where ra.status = 'pending';
