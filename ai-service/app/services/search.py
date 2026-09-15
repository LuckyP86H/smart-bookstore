"""
Vector search service using PostgreSQL with pgvector extension.
Performs semantic similarity search on book embeddings.
"""

from contextlib import contextmanager
from typing import List, Dict

import psycopg2
from psycopg2.extras import RealDictCursor

from app.config.settings import settings


def get_db_connection():
    """
    Create a database connection to PostgreSQL.

    Returns:
        psycopg2 connection object
    """
    return psycopg2.connect(
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
        user=settings.db_user,
        password=settings.db_password,
        cursor_factory=RealDictCursor  # Return rows as dictionaries
    )


@contextmanager
def db_cursor():
    """
    Yield a cursor inside a transaction; commits on success, rolls back on
    error, and always closes the connection (including on exceptions).
    """
    conn = get_db_connection()
    try:
        with conn:
            with conn.cursor() as cursor:
                yield cursor
    finally:
        conn.close()


def _to_pgvector(embedding: List[float]) -> str:
    """Format an embedding list as a pgvector literal."""
    return "[" + ",".join(map(str, embedding)) + "]"


async def search_books_by_embedding(
    embedding: List[float],
    limit: int = 10,
    min_score: float = 0.5
) -> List[Dict]:
    """
    Search for books using vector similarity.

    This uses pgvector's cosine distance operator (<=>).
    Lower distance = higher similarity.

    Args:
        embedding: Query embedding vector
        limit: Maximum number of results
        min_score: Minimum similarity score (0-1)

    Returns:
        List of book dictionaries with similarity scores
    """
    embedding_str = _to_pgvector(embedding)

    # Cosine distance: 0 = identical, 2 = opposite; score = 1 - distance
    max_distance = 1 - min_score

    query = """
        SELECT
            id,
            isbn,
            title,
            author,
            genre,
            description,
            price,
            stock_quantity,
            average_rating,
            1 - (embedding <=> %s::vector) as score
        FROM books
        WHERE
            embedding IS NOT NULL
            AND stock_quantity > 0
            AND (embedding <=> %s::vector) < %s
        ORDER BY embedding <=> %s::vector
        LIMIT %s
    """

    try:
        with db_cursor() as cursor:
            cursor.execute(
                query,
                (embedding_str, embedding_str, max_distance, embedding_str, limit)
            )
            return cursor.fetchall()

    except Exception as e:
        print(f"Error searching books by embedding: {e}")
        return []


async def search_books_by_text(
    query: str,
    limit: int = 10
) -> List[Dict]:
    """
    Simple text-based search (fallback if embeddings not available).

    Args:
        query: Text search query
        limit: Maximum number of results

    Returns:
        List of book dictionaries
    """
    search_query = """
        SELECT
            id,
            isbn,
            title,
            author,
            genre,
            description,
            price,
            stock_quantity,
            average_rating,
            CASE
                WHEN LOWER(title) LIKE LOWER(%s) THEN 1.0
                WHEN LOWER(author) LIKE LOWER(%s) THEN 0.9
                WHEN LOWER(description) LIKE LOWER(%s) THEN 0.7
                ELSE 0.5
            END as score
        FROM books
        WHERE
            stock_quantity > 0
            AND (
                LOWER(title) LIKE LOWER(%s)
                OR LOWER(author) LIKE LOWER(%s)
                OR LOWER(description) LIKE LOWER(%s)
                OR LOWER(genre) LIKE LOWER(%s)
            )
        ORDER BY score DESC
        LIMIT %s
    """

    like_query = f"%{query}%"

    try:
        with db_cursor() as cursor:
            cursor.execute(
                search_query,
                (like_query,) * 7 + (limit,)
            )
            return cursor.fetchall()

    except Exception as e:
        print(f"Error searching books by text: {e}")
        return []


async def generate_embeddings_for_all_books() -> int:
    """
    Generate embeddings for all books that don't have them yet.
    This is a batch operation typically run during setup.

    Returns:
        Number of books updated
    """
    from app.services.embeddings import get_embedding_service

    try:
        with db_cursor() as cursor:
            cursor.execute("""
                SELECT id, title, author, description
                FROM books
                WHERE embedding IS NULL
            """)
            books = cursor.fetchall()

        if not books:
            print("All books already have embeddings")
            return 0

        # Batch-encode all book texts in one pass (much faster than one-by-one)
        book_texts = [
            f"{book['title']} by {book['author']}. {book['description'] or ''}"
            for book in books
        ]
        embeddings = get_embedding_service().generate_embeddings_batch(book_texts)

        with db_cursor() as cursor:
            for book, embedding in zip(books, embeddings):
                cursor.execute(
                    "UPDATE books SET embedding = %s::vector WHERE id = %s",
                    (_to_pgvector(embedding), book['id'])
                )
                print(f"✅ Generated embedding for book {book['id']}: {book['title']}")

        print(f"✅ Generated embeddings for {len(books)} books")
        return len(books)

    except Exception as e:
        print(f"Error generating embeddings for books: {e}")
        return 0
