#!/usr/bin/env bash
# run_gate.sh — seed + Path A gate harness for P4 Steps 3–4 (PR 3).
#
# End-to-end rehearsal on a scratch Postgres 16 + pgvector (>= 0.8),
# in ONE database (sb_p4_seed, always dropped + recreated so a gate run
# starts from a deterministic state):
#
#   scaffolding (scripts/schema/scaffolding.sql)
#   -> all 8 migrations in filename order (3 existing + PR 2's 5)
#   -> seed loader, run 1   (counts must equal the slice manifest)
#   -> seed loader, run 2   (insert-if-absent proof: inserted=0 x6)
#   -> synthetic generator  (8 archetype listings, is_synthetic)
#   -> link_seed.ts         (the Worker's own Path A linker, bundled
#                            with esbuild like scripts/seed-cloud)
#   -> assertions.sql       (link/evidence/demotion/count assertions)
#   -> spot_joins.py        (independent recomputation: PR 1's B-mask
#                            spot joins + synthetic ISBN resolution)
#   -> verify_workpage.ts   (the real GetWork RPC through the Connect
#                            router against the seeded database)
#
# The vitest suite, typecheck, and the frontend production build are
# repo-level gates, run separately (npm test / npm run typecheck /
# npm run build) — see scripts/seed/README.md for the full list.
#
# Usage:
#   DATA_DIR=<p4-data-dir> scripts/seed/run_gate.sh
#
# Connection: libpq environment (PGHOST, PGPORT, PGUSER, PGPASSWORD)
# is honoured; the loader/generator/linker receive a DATABASE_URL
# built from it. DATA_DIR must hold parquet/ + out/slice_manifest.json
# and (for its Python venv) venv/bin/python with pyarrow + psycopg +
# duckdb installed; PYTHON overrides the interpreter.
#
# Environment:
#   GATE_LOG_DIR   log directory (default: $DATA_DIR/gate-logs-seed)
#   SEED_DB        scratch database name (default: sb_p4_seed)
#   PGADMINDB      admin database for create/drop (default: postgres)
#
# Exit code: 0 only if every gate step passes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
SCAFFOLDING="$REPO_ROOT/scripts/schema/scaffolding.sql"
SEED_DB="${SEED_DB:-sb_p4_seed}"
ADMIN_DB="${PGADMINDB:-postgres}"

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-54329}"
export PGUSER="${PGUSER:-postgres}"
DATABASE_URL="postgres://${PGUSER}@${PGHOST}:${PGPORT}/${SEED_DB}"

if [ -z "${DATA_DIR:-}" ]; then
  echo "ERROR: set DATA_DIR (the PR 1 data dir holding parquet/ + out/)" >&2
  exit 2
fi
PYTHON="${PYTHON:-$DATA_DIR/venv/bin/python}"
if [ ! -x "$PYTHON" ]; then
  echo "ERROR: no python at $PYTHON (set PYTHON)" >&2
  exit 2
fi

LOG_DIR="${GATE_LOG_DIR:-$DATA_DIR/gate-logs-seed}"
mkdir -p "$LOG_DIR"
: > "$LOG_DIR/gate.log"

PASS_STEPS=0
FAIL_STEPS=0
FAILED_NAMES=()

note() { echo "$*"; echo "$*" >> "$LOG_DIR/gate.log"; }
record() { # record <name> <0=pass|nonzero=fail>
  if [ "$2" -eq 0 ]; then
    PASS_STEPS=$((PASS_STEPS + 1))
    note "PASS: $1"
  else
    FAIL_STEPS=$((FAIL_STEPS + 1))
    FAILED_NAMES+=("$1")
    note "FAIL: $1"
  fi
}
run_step() { # run_step <name> <logfile> <cmd...>
  local name="$1" logfile="$2"
  shift 2
  note "== $name"
  "$@" > "$LOG_DIR/$logfile" 2>&1
  local rc=$?
  cat "$LOG_DIR/$logfile" >> "$LOG_DIR/gate.log"
  record "$name" "$rc"
}

PSQL_ADMIN=(psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -q)
PSQL_DB=(psql -d "$SEED_DB" -v ON_ERROR_STOP=1 -q)

# --- 0. fresh scratch database -------------------------------------------
"${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS \"$SEED_DB\"" \
  > "$LOG_DIR/00-drop.log" 2>&1
"${PSQL_ADMIN[@]}" -c "CREATE DATABASE \"$SEED_DB\"" \
  >> "$LOG_DIR/00-drop.log" 2>&1
record "fresh scratch database $SEED_DB" $?

# --- 1. scaffolding + migrations ------------------------------------------
{
  "${PSQL_DB[@]}" -f "$SCAFFOLDING" || exit 1
  for f in "$MIGRATIONS_DIR"/*.sql; do
    echo "applying $(basename "$f")"
    "${PSQL_DB[@]}" -f "$f" || exit 1
  done
} > "$LOG_DIR/01-migrations.log" 2>&1
record "scaffolding + 8 migrations" $?

# --- 2/3. loader, twice ----------------------------------------------------
run_step "loader run 1 (manifest counts)" 02-loader-run1.log \
  env DATA_DIR="$DATA_DIR" DATABASE_URL="$DATABASE_URL" \
  "$PYTHON" "$SCRIPT_DIR/load_slice.py"

run_step "loader run 2 (idempotency)" 03-loader-run2.log \
  env DATA_DIR="$DATA_DIR" DATABASE_URL="$DATABASE_URL" \
  "$PYTHON" "$SCRIPT_DIR/load_slice.py"
# The loader's own report must show inserted=0 for all six tables.
if grep -c "inserted=0" "$LOG_DIR/03-loader-run2.log" | grep -qx 6; then
  record "loader run 2 inserted 0 rows in all 6 tables" 0
else
  record "loader run 2 inserted 0 rows in all 6 tables" 1
fi

# --- 4. synthetic generator --------------------------------------------------
run_step "synthetic generator" 04-generator.log \
  env DATA_DIR="$DATA_DIR" DATABASE_URL="$DATABASE_URL" \
  "$PYTHON" "$SCRIPT_DIR/generate_synthetic.py"

# --- 5. link the seed listings with the shipped Path A code ------------------
(
  cd "$REPO_ROOT" || exit 1
  npx esbuild scripts/seed/link_seed.ts --bundle --platform=node \
    --format=esm --outfile=scripts/seed/.link_seed.bundle.mjs || exit 1
  DATABASE_URL="$DATABASE_URL" node scripts/seed/.link_seed.bundle.mjs
) > "$LOG_DIR/05-link-seed.log" 2>&1
record "link_seed (Worker Path A over seed listings)" $?

# --- 6. SQL assertions ---------------------------------------------------------
run_step "assertions.sql" 06-assertions.log \
  "${PSQL_DB[@]}" -f "$SCRIPT_DIR/assertions.sql"

# --- 7. independent spot joins ---------------------------------------------------
run_step "spot_joins.py (B-mask + synthetic resolution)" 07-spot-joins.log \
  env DATABASE_URL="$DATABASE_URL" \
  "$PYTHON" "$SCRIPT_DIR/spot_joins.py" --data-dir "$DATA_DIR"

# --- 8. GetWork RPC end-to-end ---------------------------------------------------
(
  cd "$REPO_ROOT" || exit 1
  npx esbuild scripts/seed/verify_workpage.ts --bundle --platform=node \
    --format=esm --outfile=scripts/seed/.verify_workpage.bundle.mjs || exit 1
  DATABASE_URL="$DATABASE_URL" node scripts/seed/.verify_workpage.bundle.mjs
) > "$LOG_DIR/08-verify-workpage.log" 2>&1
record "verify_workpage (real GetWork RPC, seeded DB)" $?

rm -f "$REPO_ROOT/scripts/seed/.link_seed.bundle.mjs" \
      "$REPO_ROOT/scripts/seed/.verify_workpage.bundle.mjs"

note "=================================================="
note "GATE SUMMARY: $PASS_STEPS passed, $FAIL_STEPS failed"
if [ "$FAIL_STEPS" -gt 0 ]; then
  note "failed steps: ${FAILED_NAMES[*]}"
  exit 1
fi
note "RESULT: GATE PASS"
