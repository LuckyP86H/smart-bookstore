#!/usr/bin/env bash
# negative_test.sh — proves the fixture-probe guards bite (PR #63).
#
# Background: the rejection probes in fixture_assertions.sql (§4, §5,
# §7) look their fixture rows up by natural key. Before review round 2
# the lookups were unverified: if one missed, the probe insert violated
# the CHECK for the wrong reason (zero candidates instead of two), the
# inner handler caught it, and the probe printed PASS while testing
# nothing. Round 2 added fail-loud guards; the proof was a one-off
# manual mutation whose logs lived outside the repo (round-3 review
# noted the claim was not re-checkable as it stood). This script is
# that proof, made re-runnable.
#
# What it does, against a throwaway database built exactly like the
# gate's fresh DB (scaffolding -> all migrations -> fixtures):
#
#   Variant A — fixture_assertions.sql truncated at the §4 PASS line,
#   with §4's two source-key lookups mutated to miss
#   ('fixture/effective-java*' -> '...-NEGMISS'). Expected: psql exits
#   non-zero and the §4 guard's 'evidence probe fixture lookup missed'
#   exception is in the output — the guard fires before the probe.
#
#   Variant B — the same mutation with the §4 guard block stripped.
#   Expected: psql exits 0 and §4 prints its PASS line — the round-1
#   false pass, reproduced on purpose.
#
# The script passes only if BOTH expectations hold.
#
# Usage: scripts/schema/negative_test.sh [PGADMIN connection string]
# Connection: standard libpq environment (PGHOST, PGPORT, PGUSER, ...),
# same conventions as run_gate.sh. Requires psql and python3.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
ADMIN_CONN="${1:-${PGADMIN:-}}"
ADMIN_DB="${PGADMINDB:-postgres}"
DB="sb_p4_negtest"
WORK="$(mktemp -d)"

psql_db() { # psql_db <db> [psql args...]
  local db="$1"; shift
  if [ -n "$ADMIN_CONN" ]; then
    psql "$ADMIN_CONN" -d "$db" "$@"
  else
    psql -d "$db" "$@"
  fi
}

drop_db() {
  psql_db "$ADMIN_DB" -qc \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB' and pid <> pg_backend_pid()" \
    >/dev/null 2>&1
  psql_db "$ADMIN_DB" -qc "drop database if exists \"$DB\"" >/dev/null 2>&1
}
cleanup() {
  drop_db
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "NEGATIVE TEST: FAIL — $1"; exit 1; }

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
command -v python3 >/dev/null 2>&1 || fail "python3 not found on PATH"

# --- build the throwaway fixture DB -------------------------------------------
drop_db || true
psql_db "$ADMIN_DB" -v ON_ERROR_STOP=1 -qc "create database \"$DB\"" \
  || fail "could not create $DB"
psql_db "$DB" -v ON_ERROR_STOP=1 -qf "$SCRIPT_DIR/scaffolding.sql" \
  || fail "scaffolding failed"
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  psql_db "$DB" -v ON_ERROR_STOP=1 -qf "$f" || fail "migration failed: $f"
done
psql_db "$DB" -v ON_ERROR_STOP=1 -qf "$SCRIPT_DIR/fixtures.sql" \
  || fail "fixtures failed"

# --- build the two variants ----------------------------------------------------
# Truncate at the §4 PASS line: §4 is the first guarded probe, and the
# expectations below are stated about §4 alone.
sed -n '1,/PASS: evidence CHECK rejects an insert with two candidate columns set/p' \
  "$SCRIPT_DIR/fixture_assertions.sql" > "$WORK/prefix.sql"

# Mutate §4's edition/work source-key lookups so they miss. (The listing
# lookup stays intact, so the guard reports listing=<id>, edition/work
# NULL — the exact shape observed in the round-2 manual run.) The
# trailing-quote pattern targets only the work key; the edition key is
# rewritten first so the two never collide.
sed -e 's/fixture\/effective-java-edition-2018/fixture\/effective-java-edition-2018-NEGMISS/g' \
    -e "s/fixture\/effective-java'/fixture\/effective-java-NEGMISS'/g" \
    "$WORK/prefix.sql" > "$WORK/variant-a.sql"

# Variant B: same mutation, guard block removed.
python3 - "$WORK/variant-a.sql" "$WORK/variant-b.sql" <<'PYEOF'
import sys

src = open(sys.argv[1], encoding="utf-8").read().splitlines(keepends=True)
start = next(
    i for i, ln in enumerate(src) if "-- Guard (PR #63 review round 2)" in ln
)
end = next(
    i for i in range(start, len(src)) if src[i].strip() == "end if;"
)
del src[start : end + 1]
open(sys.argv[2], "w", encoding="utf-8").writelines(src)
PYEOF

# --- variant A: the guard must fire ---------------------------------------------
psql_db "$DB" -v ON_ERROR_STOP=1 -f "$WORK/variant-a.sql" \
  > "$WORK/a.out" 2>&1
A_RC=$?
[ "$A_RC" -ne 0 ] \
  || fail "variant A (guarded, lookups mutated) unexpectedly exited 0"
grep -q 'evidence probe fixture lookup missed' "$WORK/a.out" \
  || fail "variant A failed, but not with the guard's message — see $WORK/a.out (kept on failure only if run manually)"
echo "variant A: guard fired as expected (psql exit $A_RC, 'evidence probe fixture lookup missed')"

# --- variant B: the false pass must reproduce -----------------------------------
psql_db "$DB" -v ON_ERROR_STOP=1 -f "$WORK/variant-b.sql" \
  > "$WORK/b.out" 2>&1
B_RC=$?
[ "$B_RC" -eq 0 ] \
  || fail "variant B (guard stripped) unexpectedly exited $B_RC — the false pass no longer reproduces"
grep -q 'PASS: evidence CHECK rejects an insert with two candidate columns set' "$WORK/b.out" \
  || fail "variant B exited 0 but did not print the false PASS line"
echo "variant B: false pass reproduced as expected (psql exit 0, §4 PASS line printed for a probe that tested nothing)"

echo "NEGATIVE TEST: PASS"
exit 0
