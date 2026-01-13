import { useState, useRef, useEffect } from 'react';
import './Chat.css';

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
}

interface ChatProps {
  username: string;
  password: string;
  onBookClick?: (bookId: number) => void;
}

function Chat({ username, password, onBookClick }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '👋 Hi! I\'m your AI book assistant. Ask me for recommendations or help finding books!',
      timestamp: new Date(),
    },
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: inputMessage,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      // Build context from previous messages (last 3 exchanges)
      const context = messages
        .slice(-6) // Last 3 user-assistant pairs
        .filter((msg) => msg.role === 'user')
        .map((msg) => msg.content);

      const response = await fetch('http://localhost:8082/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${btoa(`${username}:${password}`)}`,
        },
        body: JSON.stringify({
          message: inputMessage,
          context,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: data.reply,
        books: data.books && data.books.length > 0 ? data.books : undefined,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage: ChatMessage = {
        role: 'assistant',
        content: '❌ Sorry, I encountered an error. Please try again.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      {/* Floating Chat Button */}
      <button
        className={`chat-toggle ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Toggle chat"
      >
        {isOpen ? '✕' : '💬'}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="chat-window">
          <div className="chat-header">
            <h3>🤖 AI Book Assistant</h3>
            <p>Powered by Ollama + LiteLLM</p>
          </div>

          <div className="chat-messages">
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                <div className="message-content">
                  <div className="message-text">{msg.content}</div>
                  
                  {/* Show recommended books if any */}
                  {msg.books && msg.books.length > 0 && (
                    <div className="recommended-books">
                      <div className="books-header">📚 Recommended Books:</div>
                      {msg.books.map((book) => (
                        <div
                          key={book.book_id}
                          className="book-recommendation"
                          onClick={() => onBookClick?.(book.book_id)}
                        >
                          <div className="book-title">{book.title}</div>
                          <div className="book-author">by {book.author}</div>
                          <div className="book-reason">{book.reason}</div>
                          <div className="book-score">
                            Relevance: {(book.relevance_score * 100).toFixed(0)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="message-time">
                  {msg.timestamp.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="message assistant">
                <div className="message-content">
                  <div className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-container">
            <textarea
              className="chat-input"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Ask about books, get recommendations..."
              rows={2}
              disabled={isLoading}
            />
            <button
              className="chat-send"
              onClick={sendMessage}
              disabled={!inputMessage.trim() || isLoading}
            >
              {isLoading ? '⏳' : '➤'}
            </button>
          </div>

          <div className="chat-footer">
            <span className="chat-hint">💡 Try: "recommend sci-fi books" or "books for learning React"</span>
          </div>
        </div>
      )}
    </>
  );
}

export default Chat;
