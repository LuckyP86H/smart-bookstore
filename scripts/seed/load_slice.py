#!/usr/bin/env python3
"""Load the PR 1 Open Library slice into the P4 reference schema (Step 3).

Reads the slice Parquet produced by scripts/catalogue (PR 1) and loads it
into the tables PR 2's migrations created:

    ref_authors, ref_author_aliases, ref_works, ref_editions,
    isbn_index (slice-scoped, plan §4.2 step 3 — the full 37M-row ISBN
    map stays off-database), and the `works` display projection
    (derived, rebuildable — seeded here because GetWork reads it, §8).

Every reference row is stamped with the snapshot id (D3-1): the value of
--snapshot-id / $SNAPSHOT_ID when given, else derived deterministically
from the slice manifest's generated_at date as ``ol-YYYY-MM-DD``.

Idempotency (D3-2): insert-if-absent. Every insert carries the schema's
own unique key as its conflict target with DO NOTHING, and the loader
reports inserted vs already-present counts per table. A re-run against
the same snapshot inserts 0 rows and verifies the same totals — that is
the idempotency proof, and it is safe after listing_links exist (a
delete-and-replace would not be: links reference editions/works with
NO ACTION deletes).

Connection: the Postgres connection string comes from --database-url or
$DATABASE_URL only. Nothing else in this script knows where the
database lives, so the owner runs the identical command against
Supabase (plan §10 item 3).

Runtime: Python + pyarrow + psycopg (see D3-3 in PR3-BUILD-LOG.md —
the loader started on DuckDB's postgres extension, whose COPY write
path cannot omit identity columns, and moved to psycopg in rehearsal;
pyarrow alone reads the Parquet). ISBN canonicalisation below is a
verbatim port of scripts/catalogue/build_isbn_map.py (PR 1), so the
index cut here agrees with the full map by construction. One extra
package over the PR 1 venv: ``pip install "psycopg[binary]"``.

Usage:
    DATA_DIR=<data-dir holding parquet/ + out/> \
    DATABASE_URL=postgres://user:pass@host:5432/dbname \
        <data-dir>/venv/bin/python scripts/seed/load_slice.py

Exit code: 0 only when every loaded count matches its expectation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import psycopg
import pyarrow.parquet as pq

# ---------------------------------------------------------------------------
# ISBN canonicalisation — ported verbatim from PR 1's build_isbn_map.py
# (cleaning: hyphens/whitespace removed, upper-cased; ISBN-13 is its own
# canonical form when the mod-10 check digit holds; ISBN-10 converts as
# 978 + first nine digits + recomputed check digit; anything else is
# rejected with a reason).
# ---------------------------------------------------------------------------

_CLEAN_RE = re.compile(r"[\s\-]+")


def clean_isbn(raw: str) -> str:
    return _CLEAN_RE.sub("", raw).upper()


def _isbn13_check_digit(first_twelve: str) -> int:
    total = sum(int(d) * (1 if i % 2 == 0 else 3)
                for i, d in enumerate(first_twelve))
    return (10 - (total % 10)) % 10


def is_valid_isbn13(cleaned: str) -> bool:
    return (len(cleaned) == 13 and cleaned.isdigit()
            and _isbn13_check_digit(cleaned[:12]) == int(cleaned[12]))


def is_valid_isbn10(cleaned: str) -> bool:
    if len(cleaned) != 10 or not cleaned[:9].isdigit():
        return False
    last = cleaned[9]
    if not (last.isdigit() or last == "X"):
        return False
    total = 0
    for i, char in enumerate(cleaned):
        value = 10 if char == "X" else int(char)
        total += (10 - i) * value
    return total % 11 == 0


def isbn10_to_isbn13(cleaned: str) -> str:
    core = "978" + cleaned[:9]
    return core + str(_isbn13_check_digit(core))


def canonicalise(raw: str) -> tuple[str | None, str | None]:
    """Return ``(canonical_isbn13, None)`` or ``(None, reason)``."""
    cleaned = clean_isbn(raw)
    if not cleaned:
        return None, "empty_after_cleaning"
    if len(cleaned) == 13:
        if not cleaned.isdigit():
            return None, "bad_characters: ISBN-13 must be all digits"
        if not is_valid_isbn13(cleaned):
            return None, "bad_checksum_isbn13"
        return cleaned, None
    if len(cleaned) == 10:
        if not cleaned[:9].isdigit() or not (
                cleaned[9].isdigit() or cleaned[9] == "X"):
            return None, "bad_characters: malformed ISBN-10"
        if not is_valid_isbn10(cleaned):
            return None, "bad_checksum_isbn10"
        return isbn10_to_isbn13(cleaned), None
    return None, f"bad_length: {len(cleaned)} after cleaning"


# ---------------------------------------------------------------------------
# Small normalisations (display-grade keys, matching PR 2's fixture style:
# lower-cased, whitespace-collapsed — real normalisation is Path B's job)
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")
_YEAR_RE = re.compile(r"(\d{4})")


def norm_key(text: str | None) -> str | None:
    if text is None:
        return None
    key = _WS_RE.sub(" ", text.strip().lower())
    return key or None


def parse_year(value: str | None) -> int | None:
    """First 4-digit year in an OL date string ('1908-11-21', '1539?')."""
    if not value:
        return None
    match = _YEAR_RE.search(value)
    if match is None:
        return None
    year = int(match.group(1))
    return year if 0 < year < 2100 else None


# ---------------------------------------------------------------------------
# Transform: slice Parquet -> row sets for the reference tables
# ---------------------------------------------------------------------------

def build_rows(data_dir: Path) -> dict:
    parquet_dir = data_dir / "parquet"
    authors = pq.read_table(parquet_dir / "slice_authors.parquet").to_pylist()
    works = pq.read_table(parquet_dir / "slice_works.parquet").to_pylist()
    editions = pq.read_table(parquet_dir / "slice_editions.parquet").to_pylist()
    wikidata_path = parquet_dir / "wikidata_authors.parquet"
    wikidata = (pq.read_table(wikidata_path).to_pylist()
                if wikidata_path.exists() else [])

    author_rows = []
    author_name_by_key: dict[str, str] = {}
    for a in authors:
        name = (a["name"] or a["personal_name"] or "").strip()
        if not name:
            continue
        author_name_by_key[a["key"]] = name
        author_rows.append({
            "source_key": a["key"],
            "name": name,
            "name_key": norm_key(name),
            "birth_year": parse_year(a["birth_date"]),
            "death_year": parse_year(a["death_date"]),
        })

    work_title_by_key: dict[str, str] = {}
    work_rows = []
    projection_rows = []
    for w in works:
        title = (w["title"] or "").strip()
        work_title_by_key[w["key"]] = title
        subjects = list(w["subjects"] or [])
        work_rows.append({
            "source_key": w["key"],
            "title": title,
            "title_key": norm_key(title),
            "first_publish_year": w["first_publish_year"],
            "subjects": subjects,
        })
        names = [author_name_by_key[k] for k in (w["author_keys"] or [])
                 if k in author_name_by_key]
        projection_rows.append({
            "work_key": w["key"],
            "title": title,
            "author_display": ", ".join(names) if names else None,
            "categories": subjects,
        })

    edition_rows = []
    index_rows = []  # (isbn13, edition source_key)
    rejected_isbns = 0
    title_fallbacks = 0
    for e in editions:
        seen: set[str] = set()

        # Native ISBN-13s first (PR 1's preference), then ISBN-10
        # conversions, each in listed order.
        native13: list[str] = []
        converted: list[str] = []
        for raw in (e["isbn_13"] or []):
            canon, _ = canonicalise(raw)
            if canon is None:
                rejected_isbns += 1
            elif canon not in seen:
                seen.add(canon)
                native13.append(canon)
        for raw in (e["isbn_10"] or []):
            canon, _ = canonicalise(raw)
            if canon is None:
                rejected_isbns += 1
            elif canon not in seen:
                seen.add(canon)
                converted.append(canon)
        canonical_in_order = native13 + converted

        title = (e["title"] or "").strip()
        if not title:
            title = work_title_by_key.get(e["work_key"] or "", "")
            title_fallbacks += 1
        publishers = e["publishers"] or []
        languages = e["languages"] or []
        edition_rows.append({
            "source_key": e["key"],
            "work_key": e["work_key"],
            "isbn13": canonical_in_order[0] if canonical_in_order else None,
            "title": title,
            "title_key": norm_key(title),
            "publisher": publishers[0] if publishers else None,
            "publish_year": e["publish_year"],
            "language": languages[0] if languages else None,
            "page_count": (e["number_of_pages"]
                           if e["number_of_pages"] and e["number_of_pages"] > 0
                           else None),
        })
        for canon in canonical_in_order:
            index_rows.append({"isbn13": canon, "edition_key": e["key"]})

    # Aliases (D3-6): the authors dump's alternate_names (source
    # 'openlibrary') + the wikidata dump's labels/aliases (source
    # 'wikidata', script en/zh), for slice authors only. The author's
    # own name is never its own alias.
    alias_rows: list[dict] = []
    seen_alias: set[tuple[str, str, str]] = set()

    def add_alias(author_key: str, alias: str | None, script: str | None,
                  source: str) -> None:
        if not alias or not alias.strip():
            return
        alias = alias.strip()
        key = norm_key(alias)
        if key is None or key == norm_key(author_name_by_key.get(author_key)):
            return
        dedupe = (author_key, key, source)
        if dedupe in seen_alias:
            return
        seen_alias.add(dedupe)
        alias_rows.append({
            "author_key": author_key,
            "alias": alias,
            "alias_key": key,
            "script": script,
            "source": source,
        })

    for a in authors:
        # Mirror of the Wikidata loop's guard below (PR #67 fix round
        # item 8): authors with no usable name never enter
        # author_rows/author_name_by_key and are never inserted, so
        # their aliases must not be counted either — otherwise
        # expected['ref_author_aliases'] counts rows the insert step
        # filters out and the loader reports a phantom MISMATCH. With
        # this guard, counted == inserted by construction.
        if a["key"] not in author_name_by_key:
            continue
        for alias in (a["alternate_names"] or []):
            add_alias(a["key"], alias, None, "openlibrary")
    for wd in wikidata:
        author_key = wd["ol_author_key"]
        if author_key not in author_name_by_key:
            continue
        add_alias(author_key, wd["label_en"], "en", "wikidata")
        add_alias(author_key, wd["label_zh"], "zh", "wikidata")
        for alias in (wd["aliases_en"] or []):
            add_alias(author_key, alias, "en", "wikidata")
        for alias in (wd["aliases_zh"] or []):
            add_alias(author_key, alias, "zh", "wikidata")

    return {
        "authors": author_rows,
        "works": work_rows,
        "editions": edition_rows,
        "aliases": alias_rows,
        "isbn_index": index_rows,
        "projection": projection_rows,
        "rejected_isbns": rejected_isbns,
        "title_fallbacks": title_fallbacks,
    }



# ---------------------------------------------------------------------------
# Load: psycopg inserts, one transaction per table (§4.2 step 7).
# Foreign keys are resolved in Python through (source, source_key,
# snapshot_id) id maps read back after each parent table lands.
# ---------------------------------------------------------------------------

def run_load(rows: dict, snapshot: str,
             database_url: str) -> dict[str, dict[str, int]]:
    results: dict[str, dict[str, int]] = {}

    with psycopg.connect(database_url) as conn:
        def count(sql: str) -> int:
            with conn.cursor() as cur:
                cur.execute(sql, (snapshot,))
                return cur.fetchone()[0]

        def load_table(name: str, count_sql: str, insert_sql: str,
                       params: list[tuple]) -> None:
            before = count(count_sql)
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.executemany(insert_sql, params)
            total = count(count_sql)
            results[name] = {"before": before,
                             "inserted": total - before, "total": total}

        def id_map(table: str) -> dict[str, int]:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT source_key, id FROM public.{table} "
                    "WHERE source = 'openlibrary' AND snapshot_id = %s",
                    (snapshot,))
                return {key: row_id for key, row_id in cur.fetchall()}

        snap_count = "SELECT count(*) FROM public.{} WHERE snapshot_id = %s"
        load_table(
            "ref_authors",
            snap_count.format("ref_authors"),
            """
            INSERT INTO public.ref_authors
              (source, source_key, snapshot_id, name, name_key,
               birth_year, death_year)
            VALUES ('openlibrary', %s, %s, %s, %s, %s, %s)
            ON CONFLICT (source, source_key, snapshot_id) DO NOTHING
            """,
            [(r["source_key"], snapshot, r["name"], r["name_key"],
              r["birth_year"], r["death_year"]) for r in rows["authors"]],
        )

        author_ids = id_map("ref_authors")
        alias_count = """
            SELECT count(*) FROM public.ref_author_aliases x
            JOIN public.ref_authors a ON a.id = x.author_ref_id
            WHERE a.snapshot_id = %s
            """
        load_table(
            "ref_author_aliases",
            alias_count,
            """
            INSERT INTO public.ref_author_aliases
              (author_ref_id, alias, alias_key, script, source)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (author_ref_id, alias_key, source) DO NOTHING
            """,
            [(author_ids[r["author_key"]], r["alias"], r["alias_key"],
              r["script"], r["source"]) for r in rows["aliases"]
             if r["author_key"] in author_ids],
        )

        load_table(
            "ref_works",
            snap_count.format("ref_works"),
            """
            INSERT INTO public.ref_works
              (source, source_key, snapshot_id, title, title_key,
               first_publish_year, subjects)
            VALUES ('openlibrary', %s, %s, %s, %s, %s, %s)
            ON CONFLICT (source, source_key, snapshot_id) DO NOTHING
            """,
            [(r["source_key"], snapshot, r["title"], r["title_key"],
              r["first_publish_year"], r["subjects"])
             for r in rows["works"]],
        )

        work_ids = id_map("ref_works")
        load_table(
            "ref_editions",
            snap_count.format("ref_editions"),
            """
            INSERT INTO public.ref_editions
              (source, source_key, snapshot_id, work_ref_id, isbn13,
               title, title_key, publisher, publish_year, language,
               page_count)
            VALUES ('openlibrary', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (source, source_key, snapshot_id) DO NOTHING
            """,
            [(r["source_key"], snapshot, work_ids.get(r["work_key"]),
              r["isbn13"], r["title"], r["title_key"], r["publisher"],
              r["publish_year"], r["language"], r["page_count"])
             for r in rows["editions"]],
        )

        edition_ids = id_map("ref_editions")
        load_table(
            "isbn_index",
            snap_count.format("isbn_index"),
            """
            INSERT INTO public.isbn_index (isbn13, edition_ref_id, snapshot_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (snapshot_id, isbn13, edition_ref_id) DO NOTHING
            """,
            [(r["isbn13"], edition_ids[r["edition_key"]], snapshot)
             for r in rows["isbn_index"]
             if r["edition_key"] in edition_ids],
        )

        proj_count = """
            SELECT count(*) FROM public.works wk
            JOIN public.ref_works w ON w.id = wk.work_ref_id
            WHERE w.snapshot_id = %s
            """
        load_table(
            "works_projection",
            proj_count,
            """
            INSERT INTO public.works
              (work_ref_id, local_work_id, title, author_display, categories)
            VALUES (%s, NULL, %s, %s, %s)
            ON CONFLICT (work_ref_id) DO NOTHING
            """,
            [(work_ids[r["work_key"]], r["title"], r["author_display"],
              r["categories"]) for r in rows["projection"]
             if r["work_key"] in work_ids],
        )
    return results



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--data-dir",
        default=os.environ.get(
            "DATA_DIR",
            str(Path.home() / "workspace" / "review-scratch"
                / "smart-bookstore-p4-data")),
        help="DATA_DIR holding parquet/ and out/ (default: $DATA_DIR)")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres connection string (default: $DATABASE_URL)")
    parser.add_argument(
        "--snapshot-id",
        default=os.environ.get("SNAPSHOT_ID"),
        help="Snapshot id to stamp (default: $SNAPSHOT_ID, else derived "
             "from the slice manifest as ol-YYYY-MM-DD)")
    args = parser.parse_args(argv)

    if not args.database_url:
        print("ERROR: no database connection — pass --database-url or "
              "set DATABASE_URL", file=sys.stderr)
        return 2

    data_dir = Path(args.data_dir)
    manifest = json.loads(
        (data_dir / "out" / "slice_manifest.json").read_text())
    snapshot = args.snapshot_id or (
        "ol-" + manifest["generated_at"][:10])

    print(f"snapshot_id: {snapshot}")
    print(f"manifest: works={manifest['total_works']} "
          f"editions={manifest['total_editions']} "
          f"authors={manifest['total_authors']}")

    rows = build_rows(data_dir)
    print(f"transformed: authors={len(rows['authors'])} "
          f"works={len(rows['works'])} editions={len(rows['editions'])} "
          f"aliases={len(rows['aliases'])} "
          f"isbn_index={len(rows['isbn_index'])} "
          f"(rejected ISBNs skipped: {rows['rejected_isbns']}, "
          f"edition title fallbacks: {rows['title_fallbacks']})")

    results = run_load(rows, snapshot, args.database_url)

    expected = {
        # Counted == inserted by construction (PR #67 fix round 2,
        # same treatment as ref_author_aliases below): build_rows
        # skips authors with no usable name — they never enter
        # rows['authors'] and are never inserted — so the manifest's
        # total_authors would over-count on any future slice that
        # contains a nameless author and report a phantom MISMATCH.
        "ref_authors": len(rows["authors"]),
        "ref_works": manifest["total_works"],
        "ref_editions": manifest["total_editions"],
        "isbn_index": len(rows["isbn_index"]),
        "works_projection": manifest["total_works"],
        "ref_author_aliases": len(rows["aliases"]),
    }
    ok = True
    for name in ("ref_authors", "ref_author_aliases", "ref_works",
                 "ref_editions", "isbn_index", "works_projection"):
        r = results[name]
        match = r["total"] == expected[name]
        ok = ok and match
        print(f"{name}: before={r['before']} inserted={r['inserted']} "
              f"total={r['total']} expected={expected[name]} "
              f"{'OK' if match else 'MISMATCH'}")
    print(f"RESULT: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
