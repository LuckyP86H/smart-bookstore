"""
Chat service using LiteLLM for LLM interactions.
LiteLLM provides a unified interface to multiple LLM providers
(Ollama, OpenAI, Anthropic, DeepSeek, Gemini, ...) — the provider is
selected purely by the configured model string, e.g. "ollama/llama3.2",
"gpt-4o-mini", "claude-sonnet-5", "deepseek/deepseek-chat".
"""

from typing import List, Dict, Tuple, Optional

import litellm

from app.config.settings import settings
from app.services.embeddings import get_embedding_service
from app.services.search import search_books_by_embedding

# Drop provider-unsupported params gracefully instead of erroring
litellm.drop_params = True

SYSTEM_PROMPT = """You are a helpful bookstore AI assistant.
Your role is to help users find books they'll love.
Be friendly, concise, and enthusiastic about books.
If books are provided, mention them naturally in your response.
Keep responses under 100 words."""

FALLBACK_REPLY = "I'm here to help you find great books. What are you interested in reading?"


class ChatService:
    """
    Service for conversational AI using LLM.
    Handles chat interactions and book recommendations.
    """

    def __init__(self):
        self.model = settings.llm_model
        self.api_base = settings.resolved_llm_api_base
        self.embedding_service = get_embedding_service()
        print(f"✅ Chat service initialized with model: {self.model}")

    async def chat(
        self,
        user_id: str,
        message: str,
        context: Optional[List[str]] = None
    ) -> Tuple[str, List[Dict], float]:
        """
        Process a chat message and optionally recommend books.

        Args:
            user_id: ID of the user
            message: User's message
            context: Previous conversation context

        Returns:
            Tuple of (AI reply, recommended books, confidence score)
        """
        context = context or []

        # Check if user is asking about books
        is_book_query = self._is_book_query(message)

        recommended_books = []

        if is_book_query:
            # Search for relevant books using semantic search
            recommended_books = await self._find_relevant_books(message)

        # Generate AI response
        reply = await self._generate_response(message, context, recommended_books)

        # Calculate confidence (simple heuristic for now)
        confidence = 0.9 if is_book_query and recommended_books else 0.8

        return reply, recommended_books, confidence

    def _is_book_query(self, message: str) -> bool:
        """
        Determine if the message is asking about books.
        Simple keyword matching for now.
        """
        message_lower = message.lower()

        book_keywords = [
            'book', 'books', 'read', 'reading', 'recommend', 'recommendation',
            'author', 'novel', 'story', 'fiction', 'literature', 'genre',
            'suggest', 'suggestion', 'looking for', 'find', 'search'
        ]

        return any(keyword in message_lower for keyword in book_keywords)

    async def _find_relevant_books(self, query: str, limit: int = 5) -> List[Dict]:
        """
        Find books relevant to the query using semantic search.

        Args:
            query: Search query
            limit: Maximum number of books to return

        Returns:
            List of book dictionaries with relevance scores
        """
        try:
            # Generate embedding for the query
            query_embedding = self.embedding_service.generate_embedding(query)

            # Search for similar books in the database
            books = await search_books_by_embedding(
                embedding=query_embedding,
                limit=limit,
                min_score=settings.vector_similarity_threshold
            )

            # Format books for response
            return [
                {
                    "book_id": book["id"],
                    "title": book["title"],
                    "author": book["author"],
                    "relevance_score": book["score"],
                    "reason": self._generate_recommendation_reason(book, query),
                }
                for book in books
            ]

        except Exception as e:
            print(f"Error finding relevant books: {e}")
            return []

    def _generate_recommendation_reason(self, book: Dict, query: str) -> str:
        """
        Generate a brief explanation for why this book is recommended.
        """
        # Simple template-based reasoning for now
        # In production, you might use the LLM to generate this
        score = book["score"]

        if score > 0.85:
            return f"Highly relevant to your query about '{query}'"
        elif score > 0.75:
            return f"Strong match for your interest in {query}"
        else:
            return f"Related to your search for {query}"

    def _build_messages(
        self,
        message: str,
        context: List[str],
        books: List[Dict]
    ) -> List[Dict]:
        """Build the OpenAI-format message list sent to the LLM."""
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]

        # Add conversation context (last 3 messages)
        for ctx_msg in context[-3:]:
            messages.append({"role": "user", "content": ctx_msg})

        # If we have book recommendations, include them in the prompt
        user_prompt = message
        if books:
            book_list = "\n".join(
                f"- {book['title']} by {book['author']}"
                for book in books[:3]  # Top 3 books
            )
            user_prompt = f"{message}\n\nRelevant books I found:\n{book_list}"

        messages.append({"role": "user", "content": user_prompt})
        return messages

    async def _generate_response(
        self,
        message: str,
        context: List[str],
        books: List[Dict]
    ) -> str:
        """
        Generate AI response using LiteLLM.

        Args:
            message: User's message
            context: Conversation context
            books: Recommended books (if any)

        Returns:
            AI-generated response text
        """
        messages = self._build_messages(message, context, books)

        try:
            # acompletion keeps the event loop free while the provider responds.
            # LiteLLM normalizes every provider to the OpenAI response shape.
            response = await litellm.acompletion(
                model=self.model,
                messages=messages,
                temperature=settings.llm_temperature,
                max_tokens=settings.llm_max_tokens,
                api_base=self.api_base,
            )

            reply = (response.choices[0].message.content or "").strip()
            if reply:
                return reply

        except Exception as e:
            print(f"Error generating LLM response: {e}")

        # Fallback response if the LLM fails or returns nothing
        if books:
            return f"I found {len(books)} books that might interest you!"
        return FALLBACK_REPLY


# Global chat service instance
_chat_service = None


def get_chat_service() -> ChatService:
    """Get or create the global chat service instance"""
    global _chat_service
    if _chat_service is None:
        _chat_service = ChatService()
    return _chat_service
