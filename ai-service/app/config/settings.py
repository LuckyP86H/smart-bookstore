"""
Application configuration using pydantic-settings.
Reads from environment variables with sensible defaults.
"""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """Application settings loaded from environment"""
    
    # Server configuration
    app_name: str = "Bookstore AI Service"
    app_version: str = "1.0.0"
    host: str = "0.0.0.0"
    port: int = 8000
    
    # LLM configuration (Ollama via LiteLLM)
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"  # Default model
    llm_temperature: float = 0.7
    llm_max_tokens: int = 500
    
    # Alternative: Can switch to other providers via LiteLLM
    # Just change these and LiteLLM handles the rest!
    # openai_api_key: Optional[str] = None
    # anthropic_api_key: Optional[str] = None
    
    # Database configuration (PostgreSQL with pgvector)
    db_host: str = "localhost"
    db_port: int = 5434
    db_user: str = "postgres"
    db_password: str = "postgres"
    db_name: str = "bookstore"
    
    # Embedding model configuration
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dimension: int = 384  # Dimension for all-MiniLM-L6-v2
    
    # Vector search configuration
    vector_search_limit: int = 10
    vector_similarity_threshold: float = 0.5
    
    # CORS configuration
    cors_origins: list = ["*"]  # In production, specify exact origins
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


# Global settings instance
settings = Settings()
