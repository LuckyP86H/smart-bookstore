"""
Vector search service using PostgreSQL with pgvector extension.
Performs semantic similarity search on book embeddings.
"""

import psycopg2
from psycopg2.extras import RealDictCursor
from typing import List, Dict, Optional
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


async def search_books_by_embedding(
    embedding: List[float],
    limit: int = 10,
    min_score: float = 0.5
) -> List[Dict]:
    """
    Search for books using vector similarity.
    
    This uses pgvector's cosine similarity operator (<=>).
    Lower distance = higher similarity.
    
    Args:
        embedding: Query embedding vector
        limit: Maximum number of results
        min_score: Minimum similarity score (0-1)
        
    Returns:
        List of book dictionaries with similarity scores
    """
    # Convert embedding list to pgvector format
    embedding_str = "[" + ",".join(map(str, embedding)) + "]"
    
    # Convert min_score to max distance
    # Cosine distance: 0 = identical, 2 = opposite
    # Score: 1 = identical, 0 = opposite
    # Distance = 1 - Score
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
            -- Calculate similarity score (1 - cosine distance)
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
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            query,
            (embedding_str, embedding_str, max_distance, embedding_str, limit)
        )
        
        results = cursor.fetchall()
        
        cursor.close()
        conn.close()
        
        return results
        
    except Exception as e:
        print(f"Error searching books by embedding: {e}")
        return []


async def search_books_by_text(
    query: str,
    limit: int = 10
) -> List[Dict]:
    """
    Simple text-based search (fallback if embeddings not available).
    Uses PostgreSQL full-text search.
    
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
            -- Simple relevance scoring
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
    
    # Add wildcards for LIKE search
    like_query = f"%{query}%"
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute(
            search_query,
            (like_query, like_query, like_query, like_query, like_query, like_query, like_query, limit)
        )
        
        results = cursor.fetchall()
        
        cursor.close()
        conn.close()
        
        return results
        
    except Exception as e:
        print(f"Error searching books by text: {e}")
        return []


async def get_book_by_id(book_id: int) -> Optional[Dict]:
    """
    Get a single book by its ID.
    
    Args:
        book_id: Book ID
        
    Returns:
        Book dictionary or None if not found
    """
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
            average_rating
        FROM books
        WHERE id = %s
    """
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute(query, (book_id,))
        result = cursor.fetchone()
        
        cursor.close()
        conn.close()
        
        return result
        
    except Exception as e:
        print(f"Error getting book by ID: {e}")
        return None


async def update_book_embedding(book_id: int, embedding: List[float]) -> bool:
    """
    Update a book's embedding vector in the database.
    
    Args:
        book_id: Book ID
        embedding: Embedding vector
        
    Returns:
        True if successful, False otherwise
    """
    embedding_str = "[" + ",".join(map(str, embedding)) + "]"
    
    query = """
        UPDATE books
        SET embedding = %s::vector
        WHERE id = %s
    """
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute(query, (embedding_str, book_id))
        conn.commit()
        
        success = cursor.rowcount > 0
        
        cursor.close()
        conn.close()
        
        return success
        
    except Exception as e:
        print(f"Error updating book embedding: {e}")
        return False


async def generate_embeddings_for_all_books() -> int:
    """
    Generate embeddings for all books that don't have them yet.
    This is a batch operation typically run during setup.
    
    Returns:
        Number of books updated
    """
    from app.services.embeddings import get_embedding_service
    
    # Get all books without embeddings
    query = """
        SELECT id, title, author, description
        FROM books
        WHERE embedding IS NULL
    """
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        cursor.execute(query)
        books = cursor.fetchall()
        
        if not books:
            print("All books already have embeddings")
            return 0
        
        embedding_service = get_embedding_service()
        updated_count = 0
        
        for book in books:
            # Create text representation of the book
            book_text = f"{book['title']} by {book['author']}. {book['description'] or ''}"
            
            # Generate embedding
            embedding = embedding_service.generate_embedding(book_text)
            
            # Update in database
            if await update_book_embedding(book['id'], embedding):
                updated_count += 1
                print(f"✅ Generated embedding for book {book['id']}: {book['title']}")
        
        cursor.close()
        conn.close()
        
        print(f"✅ Generated embeddings for {updated_count} books")
        return updated_count
        
    except Exception as e:
        print(f"Error generating embeddings for books: {e}")
        return 0
