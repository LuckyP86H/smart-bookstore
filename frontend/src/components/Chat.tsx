import { useState, useRef, useEffect, useCallback } from 'react';
import './Chat.css';

// Same backend base URL convention as api/client.ts
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8082';

interface BookRecommendation {
  book_id: number;
  title: string;
  author: string;
  relevance_score: number;
  reason: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  books?: BookRecommendation[];
  timestamp: Date;
  error?: boolean;
}

interface ChatProps {
  username: string;
  password: string;
  onBookClick?: (bookId: number) => void;
}

const WELCOME_MESSAGE: ChatMessage = {
  role: 'assistant',
  content: "Hi! I'm your AI book assistant. Ask me for recommendations or help finding your next great read.",
  timestamp: new Date(),
};

// Quick-start prompts that teach users what the assistant can do
const SUGGESTIONS = [
  'Recommend sci-fi books',
  'Something about entrepreneurship',
  'Books for learning to code',
  'A gripping mystery novel',
];

function Chat({ username, password, onBookClick }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Focus the input whenever the chat opens
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const sendMessage = useCallback(async (text?: string) => {
    const messageText = (text ?? inputMessage).trim();
    if (!messageText || isLoading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: messageText,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
    setLastFailedMessage(null);
    setIsLoading(true);

    try {
      // Build context from the previous user messages (last 3)
      const context = messages
        .filter((msg) => msg.role === 'user')
        .slice(-3)
        .map((msg) => msg.content);

      const response = await fetch(`${API_BASE_URL}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${btoa(`${username}:${password}`)}`,
        },
        body: JSON.stringify({ message: messageText, context }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.reply,
          books: data.books && data.books.length > 0 ? data.books : undefined,
          timestamp: new Date(),
        },
      ]);
    } catch (error) {
      console.error('Error sending message:', error);
      setLastFailedMessage(messageText);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: "Sorry, I couldn't reach the assistant. Check your connection and try again.",
          timestamp: new Date(),
          error: true,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [inputMessage, isLoading, messages, username, password]);

  const retryLastMessage = () => {
    if (!lastFailedMessage) return;
    // Drop the failed exchange before retrying so the transcript stays clean
    setMessages((prev) => prev.slice(0, -2));
    sendMessage(lastFailedMessage);
  };

  const startNewChat = () => {
    setMessages([{ ...WELCOME_MESSAGE, timestamp: new Date() }]);
    setLastFailedMessage(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const showSuggestions = messages.length <= 1 && !isLoading;

  return (
    <>
      {/* Floating Chat Button */}
      <button
        className={`chat-toggle ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? 'Close AI book assistant' : 'Open AI book assistant'}
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" />
            <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" />
          </svg>
        )}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="chat-window" role="dialog" aria-label="AI book assistant">
          <div className="chat-header">
            <div className="chat-header-info">
              <h3>Book Assistant</h3>
              <p>AI-powered recommendations</p>
            </div>
            <button
              className="chat-new"
              onClick={startNewChat}
              disabled={isLoading}
              title="Start a new conversation"
              aria-label="Start a new conversation"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New chat
            </button>
          </div>

          <div className="chat-messages" aria-live="polite">
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}${msg.error ? ' error' : ''}`}>
                <div className="message-content">
                  <div className="message-text">{msg.content}</div>

                  {msg.error && lastFailedMessage && (
                    <button className="chat-retry" onClick={retryLastMessage}>
                      Try again
                    </button>
                  )}

                  {/* Show recommended books if any */}
                  {msg.books && msg.books.length > 0 && (
                    <div className="recommended-books">
                      <div className="books-header">Recommended for you</div>
                      {msg.books.map((book) => (
                        <button
                          key={book.book_id}
                          className="book-recommendation"
                          onClick={() => onBookClick?.(book.book_id)}
                          title="Show this book in the store"
                        >
                          <div className="book-rec-main">
                            <div className="book-title">{book.title}</div>
                            <div className="book-author">by {book.author}</div>
                            <div className="book-reason">{book.reason}</div>
                          </div>
                          <div className="book-score" aria-label={`${(book.relevance_score * 100).toFixed(0)} percent match`}>
                            {(book.relevance_score * 100).toFixed(0)}%
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="message-time">
                  {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="message assistant">
                <div className="message-content">
                  <div className="typing-indicator" aria-label="Assistant is typing">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {showSuggestions && (
            <div className="chat-suggestions" aria-label="Suggested questions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  className="chat-suggestion"
                  onClick={() => sendMessage(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <div className="chat-input-container">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about books…"
              rows={1}
              disabled={isLoading}
              aria-label="Message the book assistant"
            />
            <button
              className="chat-send"
              onClick={() => sendMessage()}
              disabled={!inputMessage.trim() || isLoading}
              aria-label="Send message"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          </div>

          <div className="chat-footer">
            <span className="chat-hint">AI-generated — may make mistakes. Verify important details.</span>
          </div>
        </div>
      )}
    </>
  );
}

export default Chat;
