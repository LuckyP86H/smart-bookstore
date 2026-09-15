"""API contract tests for the FastAPI endpoints (services mocked)."""

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app


class FakeChatService:
    async def chat(self, user_id, message, context=None):
        books = [{
            "book_id": 1, "title": "Dune", "author": "Frank Herbert",
            "relevance_score": 0.9, "reason": "Great match",
        }]
        return "Try Dune!", books, 0.9


@pytest.fixture
def client(monkeypatch, fake_litellm):
    # lifespan initializes the (stubbed) services; keep it enabled to cover it
    with TestClient(app) as c:
        yield c


def test_health_reports_degraded_when_db_down(client, monkeypatch):
    # psycopg2 stub raises on connect; ollama probe is skipped for cloud models
    from app.config.settings import settings
    monkeypatch.setattr(settings, "llm_model", "gpt-4o-mini")
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["llm_connected"] is True
    assert body["database_connected"] is False


def test_chat_endpoint_contract(client, monkeypatch):
    monkeypatch.setattr(main_module, "get_chat_service", lambda: FakeChatService())
    resp = client.post("/chat", json={"user_id": "u1", "message": "recommend sci-fi"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["reply"] == "Try Dune!"
    assert body["books"][0]["book_id"] == 1
    assert body["confidence"] == 0.9


def test_chat_endpoint_validates_request(client):
    resp = client.post("/chat", json={"message": "no user_id"})
    assert resp.status_code == 422


def test_chat_endpoint_accepts_null_and_missing_context(client, monkeypatch):
    """Go's encoding/json marshals a nil slice as null — must not 422."""
    monkeypatch.setattr(main_module, "get_chat_service", lambda: FakeChatService())
    for payload in (
        {"user_id": "u1", "message": "hi", "context": None},
        {"user_id": "u1", "message": "hi"},
    ):
        resp = client.post("/chat", json=payload)
        assert resp.status_code == 200, payload


def test_semantic_search_contract(client, monkeypatch, sample_books):
    async def fake_search(**kwargs):
        return sample_books

    monkeypatch.setattr(main_module, "search_books_by_embedding", fake_search)
    resp = client.post("/search/semantic", json={"query": "space opera", "limit": 5, "min_score": 0.5})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_found"] == 2
    assert body["results"][0]["title"] == "Dune"
    assert body["query"] == "space opera"


def test_embeddings_generate_contract(client):
    resp = client.post("/embeddings/generate", json={"text": "hello world"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["dimension"] == 384
    assert len(body["embedding"]) == 384
