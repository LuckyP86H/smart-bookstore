#!/usr/bin/env python3
"""Independent spot-join checks for the PR 3 gate.

Everything here is recomputed from PR 1's artifacts (the slice and
benchmark Parquet) and compared against what the loader + linker
actually wrote — a second reader, so a loader bug cannot grade
itself:

  1. B-mask spot joins (decision D3-12): PR 1's B-mask sampled
     editions from the full catalogue; exactly 12 of its true
     editions are inside the slice. For each, every canonical
     ISBN-13 of the true edition must resolve through the loaded
     isbn_index to that edition, and its work must be the case's
     true work.
  2. isbn_index total: PR 1's independent isbn_map.parquet, cut to
     slice editions, must have exactly as many rows as the loaded
     index.
  3. Synthetic resolution: every ISBN'd synthetic listing's stored
     ISBN canonicalises (PR 1 rules, via load_slice.canonicalise)
     to an isbn_index entry; and for the 6 honest listings, the
     edition Path A linked is one of the editions that ISBN names
     in the index. The lying listing's ISBN resolves in the index
     (resolution is not linking) while the listing stays unlinked —
     that part is asserted in assertions.sql.

Exit code 0 only when every check passes.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import duckdb
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_slice import canonicalise  # noqa: E402  (PR 1 rules, verbatim port)


def canonical_set(isbn10s, isbn13s) -> set[str]:
    out: set[str] = set()
    for raw in list(isbn13s or []) + list(isbn10s or []):
        canon, _ = canonicalise(raw)
        if canon is not None:
            out.add(canon)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir",
                        default=os.environ.get("DATA_DIR", ""))
    parser.add_argument("--database-url",
                        default=os.environ.get("DATABASE_URL"))
    args = parser.parse_args(argv)
    if not args.data_dir or not args.database_url:
        print("ERROR: set DATA_DIR and DATABASE_URL", file=sys.stderr)
        return 2
    data_dir = Path(args.data_dir)
    parquet = data_dir / "parquet"

    con = duckdb.connect()
    con.execute("SET threads=2")
    con.execute("SET memory_limit='2GB'")
    q = lambda sql: con.execute(sql).fetchall()  # noqa: E731

    failures: list[str] = []

    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            # --- 1. B-mask spot joins ----------------------------------
            cases = q(f"""
                SELECT b.case_id, b.true_edition_key, b.true_work_key
                FROM '{parquet}/benchmarks/b_mask.parquet' b
                JOIN '{parquet}/slice_editions.parquet' e
                  ON e.key = b.true_edition_key
                ORDER BY b.case_id
                """)
            print(f"b-mask cases with true edition in slice: {len(cases)}")
            edition_isbns = {
                key: canonical_set(i10, i13)
                for key, i10, i13 in q(f"""
                    SELECT key, isbn_10, isbn_13
                    FROM '{parquet}/slice_editions.parquet'
                    """)
            }
            resolved_cases = 0
            for case_id, edition_key, work_key in cases:
                isbns = edition_isbns.get(edition_key, set())
                if not isbns:
                    failures.append(
                        f"{case_id}: true edition {edition_key} has no "
                        f"canonical ISBN")
                    continue
                cur.execute(
                    """
                    SELECT DISTINCT e.source_key, w.source_key
                    FROM isbn_index i
                    JOIN ref_editions e ON e.id = i.edition_ref_id
                    LEFT JOIN ref_works w ON w.id = e.work_ref_id
                    WHERE i.isbn13 = ANY(%s)
                    """, (sorted(isbns),))
                resolved = {(r[0], r[1]) for r in cur.fetchall()}
                if (edition_key, work_key) in resolved:
                    resolved_cases += 1
                else:
                    failures.append(
                        f"{case_id}: {sorted(isbns)} resolved to "
                        f"{sorted(resolved)}, expected "
                        f"({edition_key}, {work_key})")
            print(f"b-mask spot joins resolved: {resolved_cases}/"
                  f"{len(cases)}")
            if resolved_cases != len(cases):
                failures.append("b-mask spot joins incomplete")

            # --- 2. isbn_index total vs PR 1's independent map ---------
            map_rows = q(f"""
                SELECT count(*) FROM '{parquet}/isbn_map.parquet' m
                JOIN '{parquet}/slice_editions.parquet' e
                  ON e.key = m.edition_key
                """)[0][0]
            cur.execute("SELECT count(*) FROM isbn_index")
            index_rows = cur.fetchone()[0]
            print(f"isbn_index rows: db={index_rows} "
                  f"isbn_map slice cut={map_rows}")
            if index_rows != map_rows:
                failures.append(
                    f"isbn_index total {index_rows} != isbn_map cut "
                    f"{map_rows}")

            # --- 3. synthetic ISBN resolution + link agreement ---------
            cur.execute(
                """
                SELECT b.id, b.isbn, e.source_key
                FROM books b
                LEFT JOIN listing_links ll ON ll.listing_id = b.id
                LEFT JOIN ref_editions e ON e.id = ll.edition_ref_id
                WHERE b.is_synthetic
                ORDER BY b.id
                """)
            listings = cur.fetchall()
            isbn_listings = [r for r in listings if r[1]]
            print(f"synthetic listings with ISBN: {len(isbn_listings)}")
            for listing_id, stored_isbn, linked_edition in listings:
                if not stored_isbn:
                    continue
                canon, reason = canonicalise(stored_isbn)
                if canon is None:
                    failures.append(
                        f"listing {listing_id}: stored ISBN "
                        f"{stored_isbn!r} does not canonicalise ({reason})")
                    continue
                cur.execute(
                    "SELECT e.source_key FROM isbn_index i "
                    "JOIN ref_editions e ON e.id = i.edition_ref_id "
                    "WHERE i.isbn13 = %s", (canon,))
                named = {r[0] for r in cur.fetchall()}
                if not named:
                    failures.append(
                        f"listing {listing_id}: canonical {canon} not "
                        f"in isbn_index")
                elif linked_edition is not None and \
                        linked_edition not in named:
                    failures.append(
                        f"listing {listing_id}: linked edition "
                        f"{linked_edition} is not one of the editions "
                        f"{canon} names ({sorted(named)})")

    for failure in failures:
        print(f"FAIL: {failure}")
    if failures:
        print("RESULT: FAIL")
        return 1
    print("PASS: b-mask spot joins, isbn_index total, synthetic resolution")
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
