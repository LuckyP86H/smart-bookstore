"""
Application configuration using pydantic-settings.
Reads from environment variables with sensible defaults.
"""

from typing import Optional

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Export .env into os.environ so libraries that read the environment directly
# (LiteLLM looks up provider keys like OPENAI_API_KEY there) can see it.
load_dotenv()

# Default endpoint for a locally running Ollama server
DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"


class Settings(BaseSettings):
    """Application settings loaded from environment"""

    # .env also holds provider API keys (OPENAI_API_KEY, ...) that LiteLLM
    # reads from the environment — don't reject them as unknown settings.
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server configuration
    app_name: str = "Bookstore AI Service"
    app_version: str = "1.0.0"
    host: str = "0.0.0.0"
    port: int = 8000

    # LLM configuration.
    # llm_model is any LiteLLM model string; the provider prefix selects the backend:
    #   ollama/llama3.2, gpt-4o-mini, claude-sonnet-5, deepseek/deepseek-chat,
    #   gemini/gemini-2.0-flash, ...
    # Cloud providers authenticate via their standard env vars (OPENAI_API_KEY,
    # ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, ...), which LiteLLM
    # reads directly. llm_api_base is only needed for self-hosted endpoints.
    llm_model: str = "ollama/llama3.2"
    llm_api_base: Optional[str] = None
    llm_temperature: float = 0.7
    llm_max_tokens: int = 500

    # Database configuration (PostgreSQL with pgvector)
    db_host: str = "localhost"
    db_port: int = 5434
    db_user: str = "postgres"
    db_password: str = "postgres"
    db_name: str = "bookstore"

    # Embedding model configuration
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dimension: int = 384  # Dimension for all-MiniLM-L6-v2

    # Vector search configuration. With all-MiniLM-L6-v2, strong topical
    # matches score ~0.4-0.6 cosine similarity, so the floor sits below that.
    vector_search_limit: int = 10
    vector_similarity_threshold: float = 0.35

    # CORS configuration. Browsers never call this service directly (the Go
    # backend proxies all requests), so only local dev tools need an origin.
    cors_origins: list = ["http://localhost:3000"]

    @property
    def resolved_llm_api_base(self) -> Optional[str]:
        """
        API base to pass to LiteLLM. Only applies to self-hosted Ollama models;
        cloud providers use their own endpoints (custom OpenAI-compatible proxies
        can be configured via LiteLLM's native env vars, e.g. OPENAI_BASE_URL).
        """
        if self.llm_model.startswith("ollama/"):
            return self.llm_api_base or DEFAULT_OLLAMA_BASE_URL
        return None


# Global settings instance
settings = Settings()
