"""
Pydantic models for request/response validation.
These define the REST API contracts between Go backend and Python AI service.
"""

from pydantic import BaseModel, Field
from typing import List, Optional


# ============================================================================
# Chat Models
# ============================================================================

class ChatRequest(BaseModel):
    """Request for chat endpoint"""
    user_id: str = Field(..., description="User identifier")
    message: str = Field(..., description="User's message")
    context: List[str] = Field(default=[], description="Previous conversation messages")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "user_id": "customer123",
                    "message": "Recommend books about entrepreneurship",
                    "context": []
                }
            ]
        }
    }


class BookRecommendation(BaseModel):
    """Book recommendation from AI"""
    book_id: int = Field(..., description="Book ID")
    title: str = Field(..., description="Book title")
    author: str = Field(..., description="Book author")
    relevance_score: float = Field(..., description="Relevance score (0-1)")
    reason: str = Field(..., description="Reason for recommendation")


class ChatResponse(BaseModel):
    """Response from chat endpoint"""
    reply: str = Field(..., description="AI's text response")
    books: List[BookRecommendation] = Field(default=[], description="Recommended books")
    confidence: float = Field(..., description="Confidence score (0-1)")


# ============================================================================
# Search Models
# ============================================================================

class SemanticSearchRequest(BaseModel):
    """Request for semantic search"""
    query: str = Field(..., description="Search query")
    limit: int = Field(default=10, description="Maximum number of results")
    min_score: float = Field(default=0.5, description="Minimum similarity score (0-1)")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "query": "books about building companies",
                    "limit": 10,
                    "min_score": 0.5
                }
            ]
        }
    }


class SearchResult(BaseModel):
    """Single search result"""
    book_id: int = Field(..., description="Book ID")
    title: str = Field(..., description="Book title")
    author: str = Field(..., description="Book author")
    description: str = Field(default="", description="Book description")
    score: float = Field(..., description="Similarity score (0-1)")


class SemanticSearchResponse(BaseModel):
    """Response from semantic search"""
    results: List[SearchResult] = Field(..., description="Search results")
    query: str = Field(..., description="Original query")
    total_found: int = Field(..., description="Total number of results")


# ============================================================================
# Embedding Models
# ============================================================================

class GenerateEmbeddingRequest(BaseModel):
    """Request to generate embedding for text"""
    text: str = Field(..., description="Text to embed")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "text": "The Lean Startup by Eric Ries. A guide to building successful startups."
                }
            ]
        }
    }


class GenerateEmbeddingResponse(BaseModel):
    """Response with generated embedding"""
    embedding: List[float] = Field(..., description="Embedding vector")
    dimension: int = Field(..., description="Vector dimension")


# ============================================================================
# Health Check Models
# ============================================================================

class HealthResponse(BaseModel):
    """Health check response"""
    status: str = Field(..., description="Service status (healthy/degraded)")
    ollama_connected: bool = Field(..., description="Ollama connection status")
    database_connected: bool = Field(..., description="Database connection status")
    version: str = Field(..., description="Service version")
