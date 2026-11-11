#!/usr/bin/env bash
# Fetch the Open Library dumps (+ OL wikidata dump) sequentially, resume-able.
# Data lives OUTSIDE the repo under DATA_DIR. Idempotent: a file with a valid
# .done marker (size + gzip integrity + sha256 recorded) is skipped.
set -u
DATA_DIR="${DATA_DIR:-$HOME/workspace/review-scratch/smart-bookstore-p4-data}"
DUMPS="$DATA_DIR/dumps"
LOG="$DATA_DIR/progress.log"
mkdir -p "$DUMPS"
BASE="https://openlibrary.org/data"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] fetch $*" | tee -a "$LOG"; }

for name in authors wikidata works editions; do
  file="ol_dump_${name}_latest.txt.gz"
  url="$BASE/$file"
  dest="$DUMPS/$file"
  done_marker="$dest.done"
  if [ -f "$done_marker" ]; then
    log "$name: skip (done marker present)"
    continue
  fi
  log "$name: downloading $url"
  # -C - resumes a partial file; sequential, one file at a time (VM stability).
  nice -n 10 curl -L -C - --retry 5 --retry-delay 10 -o "$dest" "$url" 2>>"$LOG"
  rc=$?
  if [ $rc -ne 0 ]; then log "$name: curl failed rc=$rc (partial kept for resume)"; exit $rc; fi
  bytes=$(stat -c %s "$dest")
  log "$name: downloaded bytes=$bytes; verifying gzip integrity"
  if ! nice -n 10 gzip -t "$dest"; then log "$name: GZIP INTEGRITY FAIL"; exit 2; fi
  sha=$(sha256sum "$dest" | cut -d' ' -f1)
  lastmod=$(curl -sI "$url" | grep -i '^Last-Modified:' | tail -1 | tr -d '\r' | cut -d' ' -f2-)
  printf '{"file":"%s","url":"%s","bytes":%s,"sha256":"%s","source_last_modified":"%s","fetched_at":"%s"}\n' \
    "$file" "$url" "$bytes" "$sha" "$lastmod" "$(ts)" > "$DUMPS/$file.manifest.json"
  touch "$done_marker"
  log "$name: DONE bytes=$bytes sha256=${sha:0:16}..."
done
log "all dumps fetched"
