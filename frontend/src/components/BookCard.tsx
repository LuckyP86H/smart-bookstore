import { Book, Genre } from '../gen/bookstore_pb';
import './BookCard.css';

// Helper function to convert Genre enum value to display name
const getGenreDisplayName = (genre: Genre): string => {
  const genreNames: Record<Genre, string> = {
    [Genre.GENRE_UNSPECIFIED]: 'Unspecified',
    [Genre.FICTION]: 'Fiction',
    [Genre.NON_FICTION]: 'Non-Fiction',
    [Genre.SCIENCE]: 'Science',
    [Genre.HISTORY]: 'History',
    [Genre.BIOGRAPHY]: 'Biography',
    [Genre.MYSTERY]: 'Mystery',
    [Genre.ROMANCE]: 'Romance',
    [Genre.FANTASY]: 'Fantasy',
    [Genre.SCIENCE_FICTION]: 'Science Fiction',
    [Genre.THRILLER]: 'Thriller',
    [Genre.HORROR]: 'Horror',
    [Genre.SELF_HELP]: 'Self Help',
    [Genre.BUSINESS]: 'Business',
    [Genre.TECHNOLOGY]: 'Technology',
    [Genre.CHILDREN]: 'Children',
  };
  return genreNames[genre] || 'Unknown';
};

interface BookCardProps {
  book: Book;
  onBuyNow: (book: Book) => void;
  onAddToCart: (book: Book) => void;
  cartQuantity?: number; // Current quantity in cart for this book
}

function BookCard({ book, onBuyNow, onAddToCart, cartQuantity = 0 }: BookCardProps) {
  const isOutOfStock = book.stockQuantity === 0;
  const isLowStock = book.stockQuantity > 0 && book.stockQuantity <= 3;
  const remainingStock = book.stockQuantity - cartQuantity;
  const canAddToCart = remainingStock > 0;
  const formatPrice = (price: number) => {
    return `$${price.toFixed(2)}`;
  };

  const renderStars = (rating: number) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      stars.push(
        <span key={i} className={i <= rating ? 'star filled' : 'star'}>
          ★
        </span>
      );
    }
    return stars;
  };

  return (
    <div className="book-card">
      {book.coverImageUrl && (
        <img
          src={book.coverImageUrl}
          alt={book.title}
          className="book-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).src = 'https://via.placeholder.com/128x192?text=No+Cover';
          }}
        />
      )}
      
      <div className="book-info">
        <h3 className="book-title">{book.title}</h3>
        <p className="book-author">by {book.author}</p>
        <p className="book-genre">{getGenreDisplayName(book.genre)}</p>
        
        {book.averageRating > 0 && (
          <div className="book-rating">
            {renderStars(Math.round(book.averageRating))}
            <span className="rating-value">({book.averageRating.toFixed(1)})</span>
          </div>
        )}
        
        <div className="book-meta">
          <span className="book-price">{formatPrice(book.price)}</span>
          <span className={`book-stock ${isOutOfStock ? 'out-of-stock' : ''} ${isLowStock ? 'low-stock' : ''}`}>
            {isOutOfStock
              ? '❌ Out of Stock'
              : isLowStock
                ? `⚠️ Only ${book.stockQuantity} left!`
                : `✓ ${book.stockQuantity} in stock`}
          </span>
        </div>

        {cartQuantity > 0 && (
          <p className="cart-indicator">🛒 {cartQuantity} in cart</p>
        )}
        
        {book.description && (
          <p className="book-description">
            {book.description.length > 150
              ? book.description.substring(0, 150) + '...'
              : book.description}
          </p>
        )}
        
        <div className="book-actions">
          <button
            className="btn-buy-now"
            onClick={() => onBuyNow(book)}
            disabled={isOutOfStock}
          >
            {isOutOfStock ? 'Out of Stock' : 'Buy Now'}
          </button>
          <button
            className="btn-add-cart"
            onClick={() => onAddToCart(book)}
            disabled={!canAddToCart}
            title={!canAddToCart ? (isOutOfStock ? 'Out of stock' : 'Maximum quantity in cart') : ''}
          >
            {!canAddToCart && !isOutOfStock ? 'Max in Cart' : 'Add to Cart'}
          </button>
        </div>
        
        {book.totalSold > 0 && (
          <p className="book-sold">🔥 {book.totalSold} sold</p>
        )}
      </div>
    </div>
  );
}

export default BookCard;
