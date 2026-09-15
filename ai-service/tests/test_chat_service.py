"""Tests for ChatService: query detection, prompt building, provider handling."""

import pytest

import app.services.chat as chat_module
from app.services.chat import ChatService, FALLBACK_REPLY, SYSTEM_PROMPT


@pytest.mark.parametrize("message,expected", [
    ("Recommend me a good book", True),
    ("looking for sci-fi novels", True),
    ("what's the weather like", False),
    ("hello there", False),
])
def test_is_book_query(chat_service, message, expected):
    assert chat_service._is_book_query(message) is expected


def test_build_messages_basic(chat_service):
    messages = chat_service._build_messages("hi", [], [])
    assert messages[0] == {"role": "system", "content": SYSTEM_PROMPT}
    assert messages[-1] == {"role": "user", "content": "hi"}


def test_build_messages_trims_context_to_last_three(chat_service):
    context = [f"msg{i}" for i in range(10)]
    messages = chat_service._build_messages("current", context, [])
    # system + 3 context + 1 current
    assert len(messages) == 5
    assert [m["content"] for m in messages[1:4]] == ["msg7", "msg8", "msg9"]


def test_build_messages_injects_top_books(chat_service, sample_books):
    books = [
        {"title": b["title"], "author": b["author"]} for b in sample_books
    ] * 3  # 6 books; only top 3 should be included
    messages = chat_service._build_messages("recommend", [], books)
    prompt = messages[-1]["content"]
    assert "Dune by Frank Herbert" in prompt
    assert prompt.count("- ") == 3


@pytest.mark.asyncio
async def test_generate_response_returns_llm_reply(chat_service, fake_litellm):
    fake_litellm.reply = "Try Dune!"
    reply = await chat_service._generate_response("recommend sci-fi", [], [])
    assert reply == "Try Dune!"
    call = fake_litellm.calls[0]
    assert call["model"] == chat_service.model
    assert call["messages"][0]["role"] == "system"


@pytest.mark.asyncio
async def test_generate_response_falls_back_on_provider_error(chat_service, fake_litellm):
    fake_litellm.raise_error = RuntimeError("provider down")
    reply = await chat_service._generate_response("recommend sci-fi", [], [])
    assert reply == FALLBACK_REPLY


@pytest.mark.asyncio
async def test_generate_response_falls_back_on_empty_reply(chat_service, fake_litellm):
    fake_litellm.reply = "   "
    books = [{"title": "Dune", "author": "Frank Herbert"}]
    reply = await chat_service._generate_response("recommend", [], books)
    assert "1 books" in reply


@pytest.mark.asyncio
@pytest.mark.parametrize("model,expects_api_base", [
    ("ollama/llama3.2", True),
    ("gpt-4o-mini", False),
    ("claude-sonnet-5", False),
    ("deepseek/deepseek-chat", False),
    ("gemini/gemini-2.0-flash", False),
])
async def test_provider_swap_is_config_only(fake_litellm, monkeypatch, model, expects_api_base):
    """Switching providers must require no code changes — only the model string."""
    from app.config.settings import settings
    import app.services.embeddings as embeddings_module

    monkeypatch.setattr(settings, "llm_model", model)
    monkeypatch.setattr(settings, "llm_api_base", None)
    embeddings_module._embedding_service = None

    service = ChatService()
    await service._generate_response("recommend books", [], [])

    call = fake_litellm.calls[0]
    assert call["model"] == model
    if expects_api_base:
        assert call["api_base"] == "http://localhost:11434"
    else:
        assert call["api_base"] is None


@pytest.mark.asyncio
async def test_chat_skips_book_search_for_non_book_message(chat_service, fake_litellm, monkeypatch):
    async def fail_search(*a, **k):
        raise AssertionError("search should not be called")

    monkeypatch.setattr(chat_module, "search_books_by_embedding", fail_search)
    reply, books, confidence = await chat_service.chat("u1", "hello!")
    assert books == []
    assert confidence == 0.8
    assert reply


@pytest.mark.asyncio
async def test_chat_recommends_books_for_book_query(chat_service, fake_litellm, sample_books, monkeypatch):
    async def fake_search(**kwargs):
        return sample_books

    monkeypatch.setattr(chat_module, "search_books_by_embedding", fake_search)
    reply, books, confidence = await chat_service.chat("u1", "recommend sci-fi books")
    assert [b["book_id"] for b in books] == [1, 2]
    assert all({"title", "author", "relevance_score", "reason"} <= set(b) for b in books)
    assert confidence == 0.9
