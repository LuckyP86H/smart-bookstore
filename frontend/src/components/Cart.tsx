import { CartItem } from '../types/book';
import './Cart.css';

interface CartProps {
  items: CartItem[];
  onUpdateQuantity: (bookId: bigint, quantity: number) => void;
  onRemove: (bookId: bigint) => void;
  onCheckout: () => void;
}

function Cart({ items, onUpdateQuantity, onRemove, onCheckout }: CartProps) {
  const total = items.reduce(
    (sum, item) => sum + item.book.price * item.quantity,
    0
  );

  if (items.length === 0) {
    return (
      <div className="cart">
        <h2>🛒 Cart</h2>
        <p className="cart-empty">Your cart is empty</p>
      </div>
    );
  }

  return (
    <div className="cart">
      <h2>🛒 Cart ({items.length})</h2>
      
      <div className="cart-items">
        {items.map((item) => (
          <div key={item.book.id.toString()} className="cart-item">
            <div className="cart-item-info">
              <h4>{item.book.title}</h4>
              <p className="cart-item-author">{item.book.author}</p>
              <p className="cart-item-price">${item.book.price.toFixed(2)}</p>
            </div>
            
            <div className="cart-item-actions">
              <div className="quantity-controls">
                <button
                  onClick={() => onUpdateQuantity(item.book.id, item.quantity - 1)}
                >
                  −
                </button>
                <span>{item.quantity}</span>
                <button
                  onClick={() => onUpdateQuantity(item.book.id, item.quantity + 1)}
                  disabled={item.quantity >= item.book.stockQuantity}
                >
                  +
                </button>
              </div>
              
              <button
                className="btn-remove"
                onClick={() => onRemove(item.book.id)}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      
      <div className="cart-footer">
        <div className="cart-total">
          <strong>Total:</strong>
          <strong>${total.toFixed(2)}</strong>
        </div>
        <button className="btn-checkout" onClick={onCheckout}>
          Checkout
        </button>
      </div>
    </div>
  );
}

export default Cart;
