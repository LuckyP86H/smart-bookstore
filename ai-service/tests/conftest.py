"""
Shared test fixtures.

Heavy third-party dependencies (sentence-transformers, litellm, psycopg2) are
replaced with lightweight stubs BEFORE the app modules are imported, so the
unit tests run fast and deterministically anywhere — no ML models, no LLM
calls, no database. Integration with the real dependencies is covered by the
docker-compose end-to-end flow.
"""

import sys
import types
from typing import List

import pytest

EMBEDDING_DIM = 384


# ----------------------------------------------------------------------------
# Stub: sentence_transformers
# ----------------------------------------------------------------------------
class _FakeTensor(list):
    def tolist(self):
        return list(self)


class _FakeSentenceTransformer:
    def __init__(self, *args, **kwargs):
        pass

    def encode(self, texts, **kwargs):
        if isinstance(texts, str):
            return _FakeTensor([0.1] * EMBEDDING_DIM)
        return _FakeTensor([_FakeTensor([0.1] * EMBEDDING_DIM) for _ in texts])


_st = types.ModuleType("sentence_transformers")
_st.SentenceTransformer = _FakeSentenceTransformer
sys.modules["sentence_transformers"] = _st


# ----------------------------------------------------------------------------
# Stub: litellm
# ----------------------------------------------------------------------------
class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Msg(content)


class FakeLLMResponse:
    def __init__(self, content):
        self.choices = [_Choice(content)]


_litellm = types.ModuleType("litellm")
_litellm.drop_params = False
_litellm.calls = []


async def _fake_acompletion(**kwargs):
    _litellm.calls.append(kwargs)
    if getattr(_litellm, "raise_error", None):
        raise _litellm.raise_error
    return FakeLLMResponse(getattr(_litellm, "reply", "Here are some great books!"))


_litellm.acompletion = _fake_acompletion
sys.modules["litellm"] = _litellm


# ----------------------------------------------------------------------------
# Stub: psycopg2 (only needs to be importable; DB access is monkeypatched)
# ----------------------------------------------------------------------------
_psycopg2 = types.ModuleType("psycopg2")
_psycopg2.connect = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("no DB in unit tests"))
_extras = types.ModuleType("psycopg2.extras")
_extras.RealDictCursor = object
_psycopg2.extras = _extras
sys.modules["psycopg2"] = _psycopg2
sys.modules["psycopg2.extras"] = _extras


# ----------------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------------
@pytest.fixture
def fake_litellm():
    """Access to the litellm stub; resets recorded calls around each test."""
    _litellm.calls = []
    _litellm.reply = "Here are some great books!"
    _litellm.raise_error = None
    yield _litellm
    _litellm.calls = []
    _litellm.raise_error = None


@pytest.fixture
def sample_books() -> List[dict]:
    return [
        {
            "id": 1, "isbn": "111", "title": "Dune", "author": "Frank Herbert",
            "genre": "Sci-Fi", "description": "Desert planet epic.",
            "price": 9.99, "stock_quantity": 3, "average_rating": 4.8,
            "score": 0.9,
        },
        {
            "id": 2, "isbn": "222", "title": "Neuromancer", "author": "William Gibson",
            "genre": "Sci-Fi", "description": "Cyberpunk classic.",
            "price": 8.99, "stock_quantity": 5, "average_rating": 4.5,
            "score": 0.7,
        },
    ]


@pytest.fixture
def chat_service(fake_litellm):
    """A fresh ChatService instance (module singletons reset)."""
    import app.services.chat as chat_module
    import app.services.embeddings as embeddings_module

    chat_module._chat_service = None
    embeddings_module._embedding_service = None
    yield chat_module.get_chat_service()
    chat_module._chat_service = None
    embeddings_module._embedding_service = None
