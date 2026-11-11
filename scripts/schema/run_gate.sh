#!/usr/bin/env bash
# run_gate.sh — schema gate harness for P4 Step 2 (PR 2), smart-bookstore.
#
# Rehearses all repo migrations (3 existing + 5 new) on a scratch Postgres
# with pgvector (>= 0.8 for halfvec) and pg_trgm available, in two
# databases:
#
#   sb_p4_fresh — scaffolding -> all 8 migrations -> assertions.sql
#   sb_p4_live  — the live-equivalent rehearsal: scaffolding -> all 8
#                 migrations in filename order (the 3 existing ones ARE
#                 the live schema; live tables hold 0 rows, so applying
#                 the new 5 on top in the same order is the honest
#                 rehearsal) -> fixtures.sql -> assertions.sql ->
#                 fixture_assertions.sql -> the 384/1024-dimension test
#
# Migration tracking mirrors Supabase (D-R5): each DB keeps a
# p4_gate.applied_migrations table and every file is applied exactly
# once. A second run against the same server finds the tracked state
# complete, applies nothing, prints NO-OP, and only re-runs the
# read-only assertions. A database that exists but is INCOMPLETE (an
# interrupted earlier run) is dropped and recreated, so a gate run
# always starts from a deterministic state; GATE_FRESH=1 forces that
# drop+recreate even for a complete database.
#
# Usage:
#   scripts/schema/run_gate.sh [PGADMIN connection string]
#
# Connection: standard libpq environment (PGHOST, PGPORT, PGUSER,
# PGPASSWORD, ...) is honoured throughout. The optional argument (or the
# PGADMIN env var) is a connection string used as the base connection;
# -d <database> is layered on top of it. Administrative statements
# (create/drop database) run against ${PGADMINDB:-postgres}.
#
# Environment:
#   GATE_LOG_DIR   log directory (default: scripts/schema/gate-logs/)
#   GATE_FRESH=1   drop+recreate both scratch DBs even if complete
#   PGADMINDB      admin database for create/drop (default: postgres)
#
# Exit code: 0 only if every gate step passes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
LOG_DIR="${GATE_LOG_DIR:-$SCRIPT_DIR/gate-logs}"
ADMIN_CONN="${1:-${PGADMIN:-}}"
ADMIN_DB="${PGADMINDB:-postgres}"
FRESH_DB="sb_p4_fresh"
LIVE_DB="sb_p4_live"

mkdir -p "$LOG_DIR"

PASS_STEPS=0
FAIL_STEPS=0
FAILED_NAMES=()

note() { echo "$*"; echo "$*" >> "$LOG_DIR/gate.log"; }
record() { # record <name> <0=pass|nonzero=fail>
  if [ "$2" -eq 0 ]; then
    PASS_STEPS=$((PASS_STEPS + 1)); note "PASS  $1"
  else
    FAIL_STEPS=$((FAIL_STEPS + 1)); FAILED_NAMES+=("$1"); note "FAIL  $1"
  fi
}

psql_db() { # psql_db <db> [psql args...]
  local db="$1"; shift
  if [ -n "$ADMIN_CONN" ]; then
    psql "$ADMIN_CONN" -d "$db" "$@"
  else
    psql -d "$db" "$@"
  fi
}

db_exists() {
  [ "$(psql_db "$ADMIN_DB" -Atc "select count(*) from pg_database where datname = '$1'" 2>/dev/null)" = "1" ]
}

drop_db() {
  psql_db "$ADMIN_DB" -v ON_ERROR_STOP=1 -qc \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid()" \
    >/dev/null 2>&1
  psql_db "$ADMIN_DB" -v ON_ERROR_STOP=1 -qc "drop database if exists \"$1\""
}

create_db() { psql_db "$ADMIN_DB" -v ON_ERROR_STOP=1 -qc "create database \"$1\""; }

ensure_tracking() { # ensure_tracking <db>
  psql_db "$1" -v ON_ERROR_STOP=1 -qc \
    "create schema if not exists p4_gate;
     create table if not exists p4_gate.applied_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )"
}

migration_files() { ls "$MIGRATIONS_DIR"/*.sql | sort; }

is_tracked() { # is_tracked <db> <basename>
  [ "$(psql_db "$1" -Atc "select count(*) from p4_gate.applied_migrations where name = '$2'" 2>/dev/null)" = "1" ]
}

mark_tracked() { # mark_tracked <db> <basename>
  psql_db "$1" -v ON_ERROR_STOP=1 -qc \
    "insert into p4_gate.applied_migrations (name) values ('$2') on conflict (name) do nothing"
}

apply_migrations() { # apply_migrations <db> <logfile> ; 0 = all applied or already tracked
  local db="$1" log="$2" f base applied=0 skipped=0
  while IFS= read -r f; do
    base="$(basename "$f")"
    if is_tracked "$db" "$base"; then
      echo "skip (already applied): $base" >> "$log"; skipped=$((skipped + 1))
    else
      echo "applying: $base" >> "$log"
      if psql_db "$db" -v ON_ERROR_STOP=1 -f "$f" >> "$log" 2>&1; then
        mark_tracked "$db" "$base" >> "$log" 2>&1 || return 1
        applied=$((applied + 1))
      else
        echo "ERROR applying $base — see $log" >> "$log"; return 1
      fi
    fi
  done < <(migration_files)
  if [ "$applied" -eq 0 ]; then
    echo "NO-OP: all migrations already applied to $db ($skipped skipped, 0 applied)" | tee -a "$log"
  else
    echo "applied $applied migration(s) to $db ($skipped already tracked)" >> "$log"
  fi
  return 0
}

apply_fixtures() { # apply_fixtures <db> <logfile>
  local db="$1" log="$2"
  if is_tracked "$db" "fixtures.sql"; then
    echo "NO-OP: fixtures.sql already applied to $db" | tee -a "$log"; return 0
  fi
  if psql_db "$db" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/fixtures.sql" >> "$log" 2>&1; then
    mark_tracked "$db" "fixtures.sql" >> "$log" 2>&1
  else
    echo "ERROR applying fixtures.sql — see $log" >> "$log"; return 1
  fi
}

db_complete() { # db_complete <db> <live:0|1>
  local db="$1" live="$2" expected tracked
  expected=$(migration_files | wc -l)
  tracked=$(psql_db "$db" -Atc "select count(*) from p4_gate.applied_migrations where name like '2%.sql'" 2>/dev/null) || return 1
  [ "$tracked" = "$expected" ] || return 1
  if [ "$live" = "1" ]; then is_tracked "$db" "fixtures.sql" || return 1; fi
  return 0
}

prepare_db() { # prepare_db <db> <live:0|1> <logfile>
  local db="$1" live="$2" log="$3"
  echo "=== prepare $db (live=$live) ===" >> "$log"
  if [ "${GATE_FRESH:-0}" != "1" ] && db_exists "$db" && db_complete "$db" "$live"; then
    echo "NO-OP: $db already fully prepared by an earlier run; nothing re-applied" | tee -a "$log"
    return 0
  fi
  if db_exists "$db"; then
    echo "$db exists but is incomplete (or GATE_FRESH=1): dropping for a deterministic start" >> "$log"
    drop_db "$db" >> "$log" 2>&1 || return 1
  fi
  create_db "$db" >> "$log" 2>&1 || return 1
  ensure_tracking "$db" >> "$log" 2>&1 || return 1
  echo "applying scaffolding.sql (Supabase environment replication, D-R4 — not a migration)" >> "$log"
  psql_db "$db" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/scaffolding.sql" >> "$log" 2>&1 || return 1
  apply_migrations "$db" "$log" || return 1
  if [ "$live" = "1" ]; then apply_fixtures "$db" "$log" || return 1; fi
  return 0
}

gen_vector() { # gen_vector <dimensions> -> "[0.1,0.1,...]"
  local dim="$1" i
  printf '['
  for ((i = 0; i < dim; i++)); do
    [ "$i" -gt 0 ] && printf ','
    printf '0.1'
  done
  printf ']'
}

dimension_test() { # dimension_test <db> <logfile>
  local db="$1" log="$2" out code rc=0
  echo "=== dimension test on $db ===" >> "$log"
  out=$(psql_db "$db" -v ON_ERROR_STOP=1 -qc \
    "insert into public.books (store_id, title, author, genre, price, embedding)
     values ((select id from public.stores order by id limit 1),
             'dimension probe 384', 'gate harness', 'probe', 1.00,
             '$(gen_vector 384)'::extensions.vector)" 2>&1)
  code=$?
  echo "384-dim insert exit=$code: $out" >> "$log"
  if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qi 'dimension'; then
    echo "PASS: 384-dimension insert failed loud, error mentions dimensions" | tee -a "$log"
  else
    echo "FAIL: 384-dimension insert should have failed with a dimension error (exit=$code)" | tee -a "$log"
    rc=1
  fi
  out=$(psql_db "$db" -v ON_ERROR_STOP=1 -qc \
    "insert into public.books (store_id, title, author, genre, price, embedding)
     values ((select id from public.stores order by id limit 1),
             'dimension probe 1024', 'gate harness', 'probe', 1.00,
             '$(gen_vector 1024)'::extensions.vector)" 2>&1)
  code=$?
  echo "1024-dim insert exit=$code: $out" >> "$log"
  if [ "$code" -eq 0 ]; then
    echo "PASS: 1024-dimension insert succeeded" | tee -a "$log"
    psql_db "$db" -qc "delete from public.books where title = 'dimension probe 1024'" >> "$log" 2>&1
  else
    echo "FAIL: 1024-dimension insert should have succeeded (exit=$code)" | tee -a "$log"
    rc=1
  fi
  return $rc
}

run_sql_gate() { # run_sql_gate <name> <db> <file> <logfile>
  local name="$1" db="$2" file="$3" log="$4"
  psql_db "$db" -v ON_ERROR_STOP=1 -f "$file" > "$log" 2>&1
  record "$name" $?
}

# ---------------------------------------------------------------- main ------

note "=== P4 schema gate — $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
note "migrations dir: $MIGRATIONS_DIR ($(migration_files | wc -l) files)"
note "logs: $LOG_DIR"

if ! command -v psql >/dev/null 2>&1; then
  note "FAIL  psql not found on PATH"
  exit 1
fi

prepare_db "$FRESH_DB" 0 "$LOG_DIR/fresh-setup.log"
record "prepare $FRESH_DB (scaffolding + 8 migrations)" $?

prepare_db "$LIVE_DB" 1 "$LOG_DIR/live-setup.log"
record "prepare $LIVE_DB (scaffolding + 8 migrations + fixtures)" $?

run_sql_gate "assertions.sql on $FRESH_DB" "$FRESH_DB" "$SCRIPT_DIR/assertions.sql" "$LOG_DIR/assertions-fresh.log"
run_sql_gate "assertions.sql on $LIVE_DB" "$LIVE_DB" "$SCRIPT_DIR/assertions.sql" "$LOG_DIR/assertions-live.log"
run_sql_gate "fixture_assertions.sql on $LIVE_DB" "$LIVE_DB" "$SCRIPT_DIR/fixture_assertions.sql" "$LOG_DIR/fixture-assertions.log"

dimension_test "$LIVE_DB" "$LOG_DIR/dimensions.log"
record "dimension test on $LIVE_DB (384 fails, 1024 succeeds)" $?

# D-R5 demonstration: re-running the apply step is a no-op on both DBs.
{
  apply_migrations "$FRESH_DB" "$LOG_DIR/noop-rerun.log"
  apply_migrations "$LIVE_DB" "$LOG_DIR/noop-rerun.log"
} >/dev/null 2>&1
record "migration re-apply is a no-op (D-R5)" $?

PASS_LINES=$(grep -h -c 'PASS' "$LOG_DIR"/assertions-fresh.log "$LOG_DIR"/assertions-live.log \
  "$LOG_DIR"/fixture-assertions.log "$LOG_DIR"/dimensions.log 2>/dev/null | awk '{s += $1} END {print s + 0}')

note "=== summary ==="
note "gate steps: $PASS_STEPS passed, $FAIL_STEPS failed"
note "individual PASS lines in assertion/dimension logs: $PASS_LINES"
if [ "$FAIL_STEPS" -gt 0 ]; then
  note "failed steps: ${FAILED_NAMES[*]}"
  note "GATE RESULT: FAIL"
  exit 1
fi
note "GATE RESULT: PASS"
exit 0
