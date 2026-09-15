"""Tests for provider-agnostic LLM configuration."""

import pytest

from app.config.settings import Settings, DEFAULT_OLLAMA_BASE_URL


@pytest.mark.parametrize(
    "model,api_base,expected",
    [
        # Ollama gets the default local endpoint
        ("ollama/llama3.2", None, DEFAULT_OLLAMA_BASE_URL),
        # Explicit override wins for Ollama (e.g. docker host gateway)
        ("ollama/llama3.2", "http://host.docker.internal:11434", "http://host.docker.internal:11434"),
        # Cloud providers never inherit the Ollama endpoint, even if set
        ("gpt-4o-mini", "http://host.docker.internal:11434", None),
        ("claude-sonnet-5", None, None),
        ("deepseek/deepseek-chat", None, None),
        ("gemini/gemini-2.0-flash", None, None),
    ],
)
def test_resolved_llm_api_base(model, api_base, expected):
    s = Settings(_env_file=None, llm_model=model, llm_api_base=api_base)
    assert s.resolved_llm_api_base == expected


def test_unknown_env_keys_are_ignored():
    """Provider API keys living in .env must not crash settings loading."""
    s = Settings(_env_file=None, openai_api_key="sk-test", deepseek_api_key="sk-test")
    assert s.llm_model  # settings object constructed fine


def test_defaults_are_local_dev_friendly():
    s = Settings(_env_file=None)
    assert s.llm_model == "ollama/llama3.2"
    assert s.embedding_dimension == 384
