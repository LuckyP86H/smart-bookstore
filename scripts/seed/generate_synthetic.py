#!/usr/bin/env python3
"""Generate the synthetic seed listings for the P4 staging catalog.

Step 3's demo data (plan §4.4): a handful of stores and listings built
ON the loaded reference slice, every row flagged ``is_synthetic`` so
the UI discloses it and no metric ever mistakes it for real inventory
or social proof. The listings exist to exercise Path A and the work
page with known answers:

    hub work, honest ISBN, store A (SOLD: sale + 5-star review)
    hub work, honest ISBN, store B (same edition, second store)
    hub work, LYING ISBN, store C (a donor work's title/author wearing
        the hub edition's ISBN-13 — the guard must demote it)
    hub work, second edition, store A (one work, several editions)
    hub work, third edition, store B
    hyphenated ISBN-13 listing (canonicalisation must strip + link)
    lowercase-x ISBN-10 listing (canonicalisation must convert + link)
    NULL-ISBN pre-1987 Chinese listing (no ISBN evidence at all)

Selection is deterministic (works ordered by edition count, then id)
and anchored to whatever slice is actually loaded — measured fact:
the 9780134685991 Effective Java pair from PR 2's fixtures is NOT in
this slice, so the archetype is rebuilt on the hub work's real ISBN
(decision D3-8). The exact picks are printed in the report.

Listings are inserted as plain books rows, exactly like PR 2's SQL
fixtures; linking them is a separate step that runs the Worker's own
Path A code over them (scripts/seed/link_seed.ts, decision D3-10).

Idempotency: if the seed stores already exist the generator reports
and exits 0 without changing anything; --reset removes the seed
stores/listings (and their sales, reviews, links and events) first.

Connection via DATABASE_URL only, like the loader.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import psycopg
import pyarrow.parquet as pq

SEED_STORES = ["seed-merchant-a", "seed-merchant-b", "seed-merchant-c"]
SEED_CUSTOMER = "seed-customer"
SEED_PASSWORD = "seed-password"  # fixture credential, staging only

# OL 3-letter language -> the app's 2-letter listing convention
# (books.language is marketplace-shaped data; 'en' is the app default).
LANG2 = {"eng": "en", "chi": "zh", "zho": "zh", "fre": "fr",
         "spa": "es", "ger": "de", "ita": "it", "rus": "ru"}


def lang2(code: str | None) -> str:
    if not code:
        return "en"
    return LANG2.get(code, code)


def hyphenate13(isbn13: str) -> str:
    """Insert hyphens in the familiar 3-1-4-4-1 grouping."""
    return (f"{isbn13[0:3]}-{isbn13[3]}-{isbn13[4:8]}-"
            f"{isbn13[8:12]}-{isbn13[12]}")


_CLEAN_RE = re.compile(r"[\s\-]+")


def clean_isbn(raw: str) -> str:
    return _CLEAN_RE.sub("", raw).upper()


def _isbn13_check_digit(first_twelve: str) -> int:
    total = sum(int(d) * (1 if i % 2 == 0 else 3)
                for i, d in enumerate(first_twelve))
    return (10 - (total % 10)) % 10


def canonicalise10(raw: str) -> str:
    """Canonical ISBN-13 for an ISBN-10 (978 + 9 digits + check digit).
    No checksum validation — callers confirm membership in the loaded
    isbn_index, which only holds valid canonical forms."""
    cleaned = clean_isbn(raw)
    core = "978" + cleaned[:9]
    return core + str(_isbn13_check_digit(core))


def pick_from_parquet(data_dir: Path, snapshot_isbns: set[str]):
    """The two archetypes the ref tables cannot express alone: a raw
    ISBN-10 ending in X (the raw form is not stored in ref_editions)
    and a NULL-ISBN pre-1987 Chinese edition (nothing to join on).
    Returns ((x_isbn10_raw_lowercase, x_edition_key), null_edition_key).
    """
    editions = pq.read_table(
        data_dir / "parquet" / "slice_editions.parquet").to_pylist()
    x_pick = None
    null_pick = None
    for e in sorted(editions, key=lambda r: r["key"]):
        if x_pick is None:
            for raw10 in (e["isbn_10"] or []):
                if clean_isbn(raw10).endswith("X"):
                    if canonicalise10(raw10) in snapshot_isbns:
                        x_pick = (raw10.lower(), e["key"])
                        break
        if null_pick is None:
            if (not (e["isbn_13"] or []) and not (e["isbn_10"] or [])
                    and (e["publish_year"] or 9999) < 1987
                    and any(lang in ("chi", "zho")
                            for lang in (e["languages"] or []))):
                null_pick = e["key"]
        if x_pick is not None and null_pick is not None:
            break
    return x_pick, null_pick


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", default=os.environ.get("DATA_DIR", ""))
    parser.add_argument("--database-url",
                        default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--snapshot-id",
                        default=os.environ.get("SNAPSHOT_ID"))
    parser.add_argument("--reset", action="store_true",
                        help="delete existing seed data first")
    args = parser.parse_args(argv)
    if not args.database_url:
        print("ERROR: set DATABASE_URL", file=sys.stderr)
        return 2
    if not args.data_dir:
        print("ERROR: set DATA_DIR (the ISBN-10-X and NULL-ISBN "
              "archetypes are picked from the slice Parquet)",
              file=sys.stderr)
        return 2
    data_dir = Path(args.data_dir)

    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT snapshot_id FROM ref_works")
            snapshots = [r[0] for r in cur.fetchall()]
            snapshot = args.snapshot_id or (
                snapshots[0] if len(snapshots) == 1 else None)
            if snapshot is None:
                print(f"ERROR: cannot pick a snapshot (found "
                      f"{snapshots}); pass --snapshot-id", file=sys.stderr)
                return 2
            print(f"snapshot_id: {snapshot}")

            all_seed = SEED_STORES + [SEED_CUSTOMER]
            cur.execute(
                "SELECT count(*) FROM stores WHERE username = ANY(%s)",
                (all_seed,))
            existing = cur.fetchone()[0]
            if existing and not args.reset:
                cur.execute(
                    "SELECT count(*) FROM books b JOIN stores s "
                    "ON s.id = b.store_id WHERE s.username = ANY(%s)",
                    (SEED_STORES,))
                print(f"already generated: {existing} seed stores, "
                      f"{cur.fetchone()[0]} seed listings "
                      f"(use --reset to rebuild)")
                return 0
            if existing and args.reset:
                cur.execute(
                    "DELETE FROM identity_events WHERE listing_id IN "
                    "(SELECT b.id FROM books b JOIN stores s "
                    " ON s.id = b.store_id WHERE s.username = ANY(%s))",
                    (SEED_STORES,))
                cur.execute(
                    "DELETE FROM books WHERE store_id IN "
                    "(SELECT id FROM stores WHERE username = ANY(%s))",
                    (SEED_STORES,))
                cur.execute(
                    "DELETE FROM stores WHERE username = ANY(%s)",
                    (all_seed,))
                conn.commit()
                print("reset: previous seed data removed")

            # --- anchor picks: the three works with the most editions --
            cur.execute(
                """
                SELECT w.id, w.title, wk.author_display,
                       (SELECT count(*) FROM ref_editions e
                        WHERE e.work_ref_id = w.id) AS edition_count
                FROM ref_works w
                JOIN works wk ON wk.work_ref_id = w.id
                WHERE w.snapshot_id = %s AND wk.author_display IS NOT NULL
                ORDER BY edition_count DESC, w.id
                LIMIT 3
                """, (snapshot,))
            hubs = cur.fetchall()
            if len(hubs) < 3:
                print("ERROR: fewer than 3 authored works in the slice",
                      file=sys.stderr)
                return 1
            hub_id, hub_title, hub_author = hubs[0][0], hubs[0][1], hubs[0][2]
            donor_title, donor_author = hubs[1][1], hubs[1][2]
            third_id, third_author = hubs[2][0], hubs[2][2]
            print(f"hub work: {hub_title!r} by {hub_author} "
                  f"({hubs[0][3]} editions)")
            print(f"donor work (lying metadata): {donor_title!r} "
                  f"by {donor_author}")

            def editions_of(work_id):
                """(id, title, publisher, year, language, pages, isbn13)"""
                cur.execute(
                    """
                    SELECT id, title, publisher, publish_year, language,
                           page_count, isbn13
                    FROM ref_editions
                    WHERE work_ref_id = %s AND isbn13 IS NOT NULL
                    ORDER BY id
                    """, (work_id,))
                return cur.fetchall()

            hub_editions = editions_of(hub_id)
            third_editions = editions_of(third_id)
            if len(hub_editions) < 2 or not third_editions:
                print("ERROR: hub/third work lacks ISBN'd editions",
                      file=sys.stderr)
                return 1
            e1, e2 = hub_editions[0], hub_editions[1]
            e3 = hub_editions[2] if len(hub_editions) > 2 else e2
            hyphen_edition = third_editions[0]

            cur.execute(
                "SELECT isbn13 FROM isbn_index WHERE snapshot_id = %s",
                (snapshot,))
            snapshot_isbns = {r[0] for r in cur.fetchall()}
            x_pick, null_key = pick_from_parquet(data_dir, snapshot_isbns)
            if x_pick is None or null_key is None:
                print(f"ERROR: archetype picks missing "
                      f"(x={x_pick}, null_isbn={null_key})",
                      file=sys.stderr)
                return 1
            x_raw10, x_edition_key = x_pick

            def edition_by_key(key):
                """Edition-shaped tuple + work title/author for a key."""
                cur.execute(
                    """
                    SELECT e.id, e.title, e.publisher, e.publish_year,
                           e.language, e.page_count, e.isbn13,
                           wk.title, wk.author_display
                    FROM ref_editions e
                    LEFT JOIN works wk ON wk.work_ref_id = e.work_ref_id
                    WHERE e.source = 'openlibrary' AND e.source_key = %s
                      AND e.snapshot_id = %s
                    """, (key, snapshot))
                return cur.fetchone()

            x_row = edition_by_key(x_edition_key)
            null_row = edition_by_key(null_key)
            # For the X listing the stored form is the raw ISBN-10; its
            # canonical 13 (for the cover link) is derived, and the
            # edition tuple's isbn13 is replaced accordingly.
            x_edition = (x_row[0], x_row[1], x_row[2], x_row[3], x_row[4],
                         x_row[5], canonicalise10(x_raw10))
            x_title = x_row[1] or x_row[7] or ""
            x_author = x_row[8] or ""
            null_edition = null_row[:7]
            null_title = null_row[1] or null_row[7] or ""
            null_author = null_row[8] or ""

            # --- stores -------------------------------------------------
            store_ids = {}
            for name in SEED_STORES:
                cur.execute(
                    "INSERT INTO stores (username, password, is_customer,"
                    " is_synthetic) VALUES (%s, %s, false, true)"
                    " RETURNING id",
                    (name, SEED_PASSWORD))
                store_ids[name] = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO stores (username, password, is_customer,"
                " is_synthetic) VALUES (%s, %s, true, true) RETURNING id",
                (SEED_CUSTOMER, SEED_PASSWORD))
            customer_id = cur.fetchone()[0]
            a, b, c = (store_ids[n] for n in SEED_STORES)

            def cover(isbn13):
                return (f"https://covers.openlibrary.org/b/isbn/"
                        f"{isbn13}-L.jpg" if isbn13 else "")

            def add_listing(store_id, isbn, title, author, edition,
                            price, stock, archetype):
                # edition: (id, title, publisher, year, language,
                #           pages, canonical_isbn13)
                cur.execute(
                    """
                    INSERT INTO books (store_id, isbn, title, author,
                        genre, publisher, publication_year, page_count,
                        language, cover_image_url, description, price,
                        stock_quantity, is_synthetic)
                    VALUES (%s, %s, %s, %s, 'FICTION', %s, %s, %s, %s,
                            %s, '', %s, %s, true)
                    RETURNING id
                    """,
                    (store_id, isbn, title, author,
                     (edition[2] or "") if edition else "",
                     (edition[3] or 0) if edition else 0,
                     (edition[5] or 0) if edition else 0,
                     lang2(edition[4]) if edition else "en",
                     cover(edition[6]) if edition else "",
                     price, stock))
                listing_id = cur.fetchone()[0]
                print(f"listing {listing_id}: store={store_id} "
                      f"isbn={isbn!r} archetype={archetype} "
                      f"title={title!r}")
                return listing_id

            sold_id = add_listing(a, e1[6], e1[1] or hub_title, hub_author,
                                  e1, 54.99, 5, "hub-honest-sold")
            add_listing(b, e1[6], e1[1] or hub_title, hub_author,
                        e1, 49.99, 3, "hub-honest-store-b")
            add_listing(c, e1[6], donor_title, donor_author,
                        e1, 19.99, 2, "hub-lying-isbn")
            add_listing(a, e2[6], e2[1] or hub_title, hub_author,
                        e2, 44.99, 4, "hub-edition-2")
            add_listing(b, e3[6], e3[1] or hub_title, hub_author,
                        e3, 42.99, 6, "hub-edition-3")
            add_listing(a, hyphenate13(hyphen_edition[6]),
                        hyphen_edition[1] or "", third_author,
                        hyphen_edition, 29.99, 2, "hyphenated-isbn13")
            add_listing(b, x_raw10, x_title, x_author,
                        x_edition, 24.99, 3, "isbn10-lowercase-x")
            add_listing(a, None, null_title, null_author,
                        null_edition, 15.99, 1, "null-isbn-pre1987-zh")

            # The sold archetype: one sale + one 5-star review, with
            # the denormalised counters set the way PurchaseBook /
            # AddReview would leave them.
            cur.execute(
                "INSERT INTO sales (book_id, customer_id, quantity,"
                " price_at_purchase) VALUES (%s, %s, 1, 54.99)",
                (sold_id, customer_id))
            cur.execute(
                "INSERT INTO reviews (book_id, customer_id, rating,"
                " review_text) VALUES (%s, %s, 5, %s)",
                (sold_id, customer_id,
                 "Seed fixture review: exactly as described."))
            cur.execute(
                "UPDATE books SET total_sold = 1, average_rating = 5.00"
                " WHERE id = %s", (sold_id,))
            conn.commit()
            print(f"stores: {store_ids} customer={customer_id}")
            print("RESULT: PASS")
            return 0


if __name__ == "__main__":
    sys.exit(main())
