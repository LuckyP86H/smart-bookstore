-- scaffolding.sql — ENVIRONMENT REPLICATION, NOT A MIGRATION.
--
-- This file is never shipped as a repo migration and must never be copied
-- into supabase/migrations/. It recreates, on a vanilla Postgres, the
-- things a real Supabase project pre-provides and the existing repo
-- migrations silently assume (decision D-R4 in PR2-BUILD-LOG.md):
--
--   1. the `extensions` schema — migration 1 runs
--      `create extension ... with schema extensions`, which fails if the
--      schema does not already exist;
--   2. the stub function public.rls_auto_enable() — migrations 2 and 3
--      `revoke execute` on it, which fails if the function is absent;
--   3. the `anon` and `authenticated` roles — those same revoke
--      statements name them, and vanilla Postgres has neither role.
--
-- On Supabase all three exist before any migration runs. Creating them
-- here replicates that environment; it does not change what any
-- migration means.

create schema if not exists extensions;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

create or replace function public.rls_auto_enable()
returns void
language plpgsql
as $$
begin
  -- stub: on Supabase this function auto-enables RLS on new public
  -- tables. The rehearsal only needs it to exist so the revoke
  -- migrations can run verbatim.
end
$$;
