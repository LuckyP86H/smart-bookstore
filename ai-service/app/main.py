"""
FastAPI application for Bookstore AI Service.
Provides REST API endpoints for AI-powered book recommendations and search.

This service communicates with the Go backend via REST API.
"""

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import sys

# Import configuration and models
from app.config.settings import settings
from app.models.schemas import (
    ChatRequest, ChatResponse, BookRecommendation,
    SemanticSearchRequest, SemanticSearchResponse, SearchResult,
    GenerateEmbeddingRequest, GenerateEmbeddingResponse,
    HealthResponse
)

# Import services
from app.services.chat import get_chat_service
from app.services.embeddings import get_embedding_service
from app.services.search import (
    search_books_by_embedding,
    search_books_by_text,
    generate_embeddings_for_all_books
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager for startup and shutdown events.
    Initializes services on startup.
    """
    print("🚀 Starting Bookstore AI Service...")
    print(f"📦 Model: {settings.ollama_model}")
    print(f"🔌 Ollama: {settings.ollama_base_url}")
    print(f"💾 Database: {settings.db_host}:{settings.db_port}/{settings.db_name}")
    
    # Initialize services (loads models)
    try:
        _ = get_embedding_service()
        _ = get_chat_service()
        print("✅ AI Service ready!")
    except Exception as e:
        print(f"❌ Error initializing services: {e}")
        sys.exit(1)
    
    yield
    
    # Cleanup (if needed)
    print("👋 Shutting down AI Service...")


# Create FastAPI application
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="AI-powered book recommendation and search service",
    lifespan=lifespan
)

# Add CORS middleware to allow requests from frontend/backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Health Check Endpoints
# ============================================================================

@app.get("/", response_model=HealthResponse)
async def root():
    """Root endpoint - health check"""
    return await health_check()


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.
    Verifies that Ollama and database connections are working.
    """
    # Check Ollama connection
    ollama_connected = True
    try:
        import httpx
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{settings.ollama_base_url}/api/tags")
            ollama_connected = response.status_code == 200
    except:
        ollama_connected = False
    
    # Check database connection
    db_connected = True
    try:
        from app.services.search import get_db_connection
        conn = get_db_connection()
        conn.close()
    except:
        db_connected = False
    
    return HealthResponse(
        status="healthy" if (ollama_connected and db_connected) else "degraded",
        ollama_connected=ollama_connected,
        database_connected=db_connected,
        version=settings.app_version
    )


# ============================================================================
# Chat Endpoints
# ============================================================================

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Chat with AI assistant about books.
    The AI will understand natural language and recommend relevant books.
    
    Example:
        POST /chat
        {
            "user_id": "customer123",
            "message": "I want to read something about entrepreneurship",
            "context": []
        }
    """
    try:
        chat_service = get_chat_service()
        
        # Process the chat message
        reply, books, confidence = await chat_service.chat(
            user_id=request.user_id,
            message=request.message,
            context=request.context
        )
        
        # Format book recommendations
        book_recommendations = [
            BookRecommendation(**book) for book in books
        ]
        
        return ChatResponse(
            reply=reply,
            books=book_recommendations,
            confidence=confidence
        )
        
    except Exception as e:
        print(f"Error in chat endpoint: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Chat service error: {str(e)}"
        )


# ============================================================================
# Search Endpoints
# ============================================================================

@app.post("/search/semantic", response_model=SemanticSearchResponse)
async def semantic_search(request: SemanticSearchRequest):
    """
    Semantic search for books using vector similarity.
    Understands the meaning of the query, not just keywords.
    
    Example:
        POST /search/semantic
        {
            "query": "books about overcoming challenges",
            "limit": 10,
            "min_score": 0.6
        }
    """
    try:
        # Generate embedding for the query
        embedding_service = get_embedding_service()
        query_embedding = embedding_service.generate_embedding(request.query)
        
        # Search for similar books
        results = await search_books_by_embedding(
            embedding=query_embedding,
            limit=request.limit,
            min_score=request.min_score
        )
        
        # Format results
        search_results = [
            SearchResult(
                book_id=book["id"],
                title=book["title"],
                author=book["author"],
                description=book.get("description", ""),
                score=float(book["score"])
            )
            for book in results
        ]
        
        return SemanticSearchResponse(
            results=search_results,
            query=request.query,
            total_found=len(search_results)
        )
        
    except Exception as e:
        print(f"Error in semantic search: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Search error: {str(e)}"
        )


@app.get("/search/text")
async def text_search(query: str, limit: int = 10):
    """
    Simple text-based search (fallback).
    Uses PostgreSQL text search.
    """
    try:
        results = await search_books_by_text(query=query, limit=limit)
        return {"results": results, "query": query, "total_found": len(results)}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Text search error: {str(e)}"
        )


# ============================================================================
# Embedding Endpoints
# ============================================================================

@app.post("/embeddings/generate", response_model=GenerateEmbeddingResponse)
async def generate_embedding(request: GenerateEmbeddingRequest):
    """
    Generate embedding for a text.
    Useful for custom vector operations.
    """
    try:
        embedding_service = get_embedding_service()
        embedding = embedding_service.generate_embedding(request.text)
        
        return GenerateEmbeddingResponse(
            embedding=embedding,
            dimension=len(embedding)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Embedding generation error: {str(e)}"
        )


@app.post("/embeddings/generate-all")
async def generate_all_embeddings():
    """
    Generate embeddings for all books in the database.
    This is a batch operation typically run during setup.
    
    WARNING: This can take a while for large databases!
    """
    try:
        count = await generate_embeddings_for_all_books()
        return {
            "status": "success",
            "books_updated": count,
            "message": f"Generated embeddings for {count} books"
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Batch embedding error: {str(e)}"
        )


# ============================================================================
# Run the application
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,  # Auto-reload on code changes (development only)
        log_level="info"
    )
