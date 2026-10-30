import { useState, useEffect, useMemo } from 'react';
import { createCustomerClient, isMerchantUser } from './api/client';
import { Book, Genre } from './gen/bookstore_pb';
import { CartItem } from './types/book';
import BookCard from './components/BookCard';
import Cart from './components/Cart';
import FilterPanel from './components/FilterPanel';
import ThemeToggle from './components/ThemeToggle';
import Chat from './components/Chat';
import './App.css';

// Helper functions for session persistence
const SESSION_STORAGE_KEY = 'bookstore_session';

interface SessionData {
  username: string;
  authenticated: boolean;
  isMerchant: boolean;
}

const loadSession = (): SessionData | null => {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load session:', e);
  }
  return null;
};

const saveSession = (data: SessionData): void => {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save session:', e);
  }
};

const clearSession = (): void => {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear session:', e);
  }
};

function App() {
  // Load initial state from localStorage
  const savedSession = loadSession();

  // If there's a saved session, we need password to resume
  const [pendingSession, setPendingSession] = useState<SessionData | null>(savedSession);

  // The book list is stored as the outcome of the last completed fetch,
  // tagged with the key of the request that produced it. `books`, `loading`
  // and the visible `error` are derived from that during render (below), so
  // the fetch effect never has to set state synchronously.
  const [booksResult, setBooksResult] = useState<{
    key: string;
    books: Book[];
    error: string | null;
  } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState(savedSession?.username ?? '');
  const [password, setPassword] = useState('');
  const [isMerchant, setIsMerchant] = useState(savedSession?.isMerchant ?? false);

  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [genreFilter, setGenreFilter] = useState<Genre>(Genre.GENRE_UNSPECIFIED);
  const [authorFilter, setAuthorFilter] = useState('');
  const [minPrice, setMinPrice] = useState(0);
  const [maxPrice, setMaxPrice] = useState(0);

  // Memoized so the client identity only changes when credentials do —
  // the fetch effect depends on it, and an unstable client would refetch
  // every render.
  const customerClient = useMemo(
    () => (authenticated ? createCustomerClient(username, password) : null),
    [authenticated, username, password]
  );
  // Note: a merchantClient can be added here the same way when merchant-specific
  // UI features are implemented.

  // Identifies the current book-list request (user + filters + manual
  // refreshes). A stored result only counts as current while its key matches.
  const booksKey = JSON.stringify([
    username,
    searchQuery,
    genreFilter,
    authorFilter,
    minPrice,
    maxPrice,
    refreshTick,
  ]);

  const books = booksResult?.books ?? [];
  // A fetch is outstanding whenever a client exists but no result for the
  // current key has landed yet — this replaces the old `loading` flag that
  // was set synchronously at the start of every fetch.
  const loading = customerClient !== null && booksResult?.key !== booksKey;
  // An error is only shown for the request it belongs to: while a newer
  // fetch is in flight the previous error is hidden, matching the old
  // behaviour of clearing the error at the start of every fetch.
  const error =
    booksResult !== null && booksResult.key === booksKey ? booksResult.error : null;

  // Event handlers (buy / checkout) bump the tick to re-run the fetch
  // effect for the same filters.
  const reloadBooks = () => setRefreshTick(tick => tick + 1);

  // Fetch the book list on login and on every filter change. All state
  // updates happen after the await, in the async continuation — nothing
  // sets state synchronously in the effect (react-hooks/set-state-in-effect).
  // The cancelled flag drops a stale response when a newer request has
  // already superseded this one.
  useEffect(() => {
    if (!customerClient) return;

    let cancelled = false;
    const fetchKey = booksKey;

    (async () => {
      try {
        const response = await customerClient.getAvailableBooks({
          searchQuery,
          genreFilter,
          authorFilter,
          minPrice,
          maxPrice,
          sortOrder: 0,
          page: 1,
          pageSize: 50,
        });
        if (cancelled) return;
        setBooksResult({ key: fetchKey, books: response.books, error: null });

        // Update cart items with fresh book data to sync stock quantities
        setCart(prevCart => {
          const bookMap = new Map(response.books.map(book => [book.id.toString(), book]));
          return prevCart
            .map(item => {
              const updatedBook = bookMap.get(item.book.id.toString());
              if (updatedBook) {
                // Adjust quantity if it exceeds new stock
                const newQuantity = Math.min(item.quantity, updatedBook.stockQuantity);
                return newQuantity > 0
                  ? { ...item, book: updatedBook, quantity: newQuantity }
                  : null;
              }
              // Remove items for books no longer available
              return null;
            })
            .filter((item): item is CartItem => item !== null);
        });
      } catch (err) {
        if (cancelled) return;
        // Keep showing the previously loaded books alongside the error.
        setBooksResult(prev => ({
          key: fetchKey,
          books: prev?.books ?? [],
          error: err instanceof Error ? err.message : 'Failed to load books',
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [customerClient, booksKey, searchQuery, genreFilter, authorFilter, minPrice, maxPrice]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username && password) {
      const merchantStatus = isMerchantUser(username);
      setIsMerchant(merchantStatus);
      setAuthenticated(true);
      setPendingSession(null); // Clear pending session after successful login
      // Persist session to localStorage (never store password)
      saveSession({ username, authenticated: true, isMerchant: merchantStatus });
    }
  };

  const handleLogout = () => {
    setAuthenticated(false);
    setUsername('');
    setPassword('');
    setIsMerchant(false);
    setBooksResult(null);
    setCart([]);
    setPendingSession(null); // Clear pending session
    // Clear session from localStorage
    clearSession();
  };

  const handleCancelSession = () => {
    setPendingSession(null);
    setUsername('');
    setIsMerchant(false);
    clearSession();
  };

  const addToCart = (book: Book) => {
    setCart(prev => {
      const existing = prev.find(item => item.book.id === book.id);
      if (existing) {
        // Check if we can add more (don't exceed stock)
        if (existing.quantity >= book.stockQuantity) {
          return prev; // Can't add more, already at stock limit
        }
        return prev.map(item =>
          item.book.id === book.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      // For new items, check if stock is available
      if (book.stockQuantity <= 0) {
        return prev; // Can't add out-of-stock items
      }
      return [...prev, { book, quantity: 1 }];
    });
  };

  // Helper to get quantity of a book in cart
  const getCartQuantity = (bookId: bigint): number => {
    const item = cart.find(item => item.book.id === bookId);
    return item?.quantity ?? 0;
  };

  const updateCartQuantity = (bookId: bigint, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(bookId);
    } else {
      setCart(prev =>
        prev.map(item =>
          item.book.id === bookId ? { ...item, quantity } : item
        )
      );
    }
  };

  const removeFromCart = (bookId: bigint) => {
    setCart(prev => prev.filter(item => item.book.id !== bookId));
  };

  const handleBuyNow = async (book: Book) => {
    if (!customerClient) return;

    try {
      await customerClient.purchaseBook({
        bookId: book.id,
        quantity: 1,
      });
      alert(`Successfully purchased "${book.title}"!`);
      reloadBooks(); // Refresh book list
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Purchase failed');
    }
  };

  const handleCheckout = async () => {
    if (!customerClient || cart.length === 0) return;

    try {
      await customerClient.checkoutCart({
        items: cart.map(item => ({
          bookId: item.book.id,
          quantity: item.quantity,
        })),
      });
      alert('Successfully checked out!');
      setCart([]);
      reloadBooks(); // Refresh book list
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Checkout failed');
    }
  };

  const clearFilters = () => {
    setSearchQuery('');
    setGenreFilter(Genre.GENRE_UNSPECIFIED);
    setAuthorFilter('');
    setMinPrice(0);
    setMaxPrice(0);
  };

  if (!authenticated) {
    const isResuming = pendingSession !== null;

    return (
      <div className="login-container">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="login-box">
          <h1>📚 Bookstore</h1>
          {isResuming ? (
            <>
              <p className="subtitle">Welcome back, {username}!</p>
              <p className="resume-hint">Enter your password to continue</p>
            </>
          ) : (
            <p className="subtitle">ConnectRPC Learning Project</p>
          )}
          <form onSubmit={handleLogin}>
            {!isResuming && (
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            )}
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus={isResuming}
            />
            <button type="submit">{isResuming ? 'Resume Session' : 'Sign In'}</button>
            {isResuming && (
              <button type="button" className="btn-secondary" onClick={handleCancelSession}>
                Sign in as different user
              </button>
            )}
          </form>
          {!isResuming && (
            <div className="test-accounts">
              <p><strong>Customer:</strong> customer / password</p>
              <p><strong>Merchant:</strong> merchant1 / password1</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>📚 Bookstore</h1>
        <div className="header-right">
          <span>Welcome, {username} {isMerchant ? '(Merchant)' : '(Customer)'}</span>
          <ThemeToggle />
          <button onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <div className="main-content">
        <FilterPanel
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          genreFilter={genreFilter}
          setGenreFilter={setGenreFilter}
          authorFilter={authorFilter}
          setAuthorFilter={setAuthorFilter}
          minPrice={minPrice}
          setMinPrice={setMinPrice}
          maxPrice={maxPrice}
          setMaxPrice={setMaxPrice}
          onClear={clearFilters}
        />

        <div className="content-area">
          <div className="books-section">
            <h2>Available Books ({books.length})</h2>
            
            {loading && <p>Loading books...</p>}
            {error && <p className="error">{error}</p>}
            
            <div className="books-grid">
              {books.map((book) => (
                <BookCard
                  key={book.id.toString()}
                  book={book}
                  onBuyNow={handleBuyNow}
                  onAddToCart={addToCart}
                  cartQuantity={getCartQuantity(book.id)}
                />
              ))}
            </div>
            
            {!loading && books.length === 0 && (
              <p className="no-books">No books found. Try adjusting your filters.</p>
            )}
          </div>

          <Cart
            items={cart}
            onUpdateQuantity={updateCartQuantity}
            onRemove={removeFromCart}
            onCheckout={handleCheckout}
          />
        </div>
      </div>

      {/* AI Chat Assistant - Only show when authenticated */}
      {authenticated && (
        <Chat
          username={username}
          password={password}
          onBookClick={(bookId) => {
            // Scroll to and briefly highlight the book recommended in chat
            const bookElement = document.querySelector(`[data-book-id="${bookId}"]`);
            if (bookElement) {
              bookElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
              bookElement.classList.add('book-card-highlight');
              setTimeout(() => bookElement.classList.remove('book-card-highlight'), 2000);
            }
          }}
        />
      )}
    </div>
  );
}

export default App;
