"""Tests for the vector/text search service (DB access mocked)."""

from contextlib import contextmanager

import pytest

import app.services.search as search_module
from app.services.search import (
    _to_pgvector,
    search_books_by_embedding,
    search_books_by_text,
)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []

    def execute(self, query, params=None):
        self.executed.append((query, params))

    def fetchall(self):
        return self.rows


@pytest.fixture
def fake_db(monkeypatch, sample_books):
    cursor = FakeCursor(sample_books)

    @contextmanager
    def fake_db_cursor():
        yield cursor

    monkeypatch.setattr(search_module, "db_cursor", fake_db_cursor)
    return cursor


def test_to_pgvector_format():
    assert _to_pgvector([0.1, 0.2, 0.3]) == "[0.1,0.2,0.3]"


@pytest.mark.asyncio
async def test_search_by_embedding_returns_rows(fake_db, sample_books):
    results = await search_books_by_embedding([0.1] * 3, limit=5, min_score=0.6)
    assert results == sample_books
    query, params = fake_db.executed[0]
    assert "embedding <=> %s::vector" in query
    # min_score 0.6 -> max cosine distance 0.4
    assert params[2] == pytest.approx(0.4)
    assert params[4] == 5


@pytest.mark.asyncio
async def test_search_by_embedding_returns_empty_on_db_error(monkeypatch):
    @contextmanager
    def broken_db_cursor():
        raise RuntimeError("db down")
        yield

    monkeypatch.setattr(search_module, "db_cursor", broken_db_cursor)
    assert await search_books_by_embedding([0.1] * 3) == []


@pytest.mark.asyncio
async def test_text_search_uses_parameterized_like(fake_db):
    await search_books_by_text("dune", limit=7)
    query, params = fake_db.executed[0]
    # The user-supplied text must be bound as parameters, never interpolated
    assert "dune" not in query
    assert params.count("%dune%") == 7
    assert params[-1] == 7
