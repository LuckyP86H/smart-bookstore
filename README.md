# 📚 Bookstore - ConnectRPC Learning Project

A fullstack bookstore application built to learn modern gRPC development using **ConnectRPC**, **Go**, **React**, and **PostgreSQL**. This project demonstrates production-ready patterns for building type-safe APIs that work natively in browsers.

## 🎯 Learning Objectives

This project teaches:
- **ConnectRPC**: Modern, browser-friendly alternative to gRPC-Web
- **Protocol Buffers**: Schema-first API design with code generation
- **Go Backend**: Building efficient gRPC services
- **Type Safety**: End-to-end type safety from backend to frontend
- **Authentication**: HTTP Basic Auth with interceptors
- **Database Patterns**: ACID transactions and race condition handling
- **Docker**: Container orchestration with docker-compose

---

## 🏗️ Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌──────────────┐
│  React Frontend │ ───▶ │  Go Backend      │ ───▶ │  PostgreSQL  │
│  (Port 3000)    │      │  ConnectRPC      │      │  (Port 5434) │
│                 │      │  (Port 8082)     │      │              │
│  - TypeScript   │      │  - gRPC Services │      │  - Books     │
│  - Vite         │      │  - Interceptors  │      │  - Reviews   │
│  - ConnectRPC   │      │  - Google Books  │      │  - Sales     │
│    Client       │      │    API           │      │              │
└─────────────────┘      └──────────────────┘      └──────────────┘
```

### Technology Stack

| Layer | Technology | Version | Why? |
|-------|-----------|---------|------|
| **Frontend** | React | 19.1.4 | Latest stable React |
| | TypeScript | 5.9.3 | Type safety |
| | Vite | 7.3.1 | Fast dev server and builds |
| | ConnectRPC | 1.7.0 | Browser-native gRPC client |
| **Backend** | Go | 1.25.0 | High performance, great for gRPC |
| | ConnectRPC Go | 1.19.1 | gRPC server framework |
| | PostgreSQL Driver | latest | Database connectivity |
| **Database** | PostgreSQL | 16+ | Reliable, ACID-compliant |
| **Infrastructure** | Docker | latest | Containerization |
| | Docker Compose | latest | Multi-container orchestration |

---

## 🚀 Quick Start

### Prerequisites

- **Docker** and **Docker Compose** installed
- **(Optional)** Google Books API key for ISBN lookup

### One-Command Startup

```bash
# Clone and navigate to project
cd bookstore

# Start all services (database, backend, frontend)
docker-compose up -d

# Wait 10 seconds for services to start, then open browser
open http://localhost:3000
```

### Test Accounts

The database automatically seeds these test accounts:

| Username | Password | Role | Use For |
|----------|----------|------|---------|
| `merchant1` | `password1` | Merchant | Add books, manage inventory |
| `merchant2` | `password2` | Merchant | Second merchant for testing |
| `customer` | `password` | Customer | Browse and purchase books |

---

## 📖 What is ConnectRPC?

**ConnectRPC** is a modern alternative to gRPC-Web that solves a key problem: **gRPC doesn't work in browsers**.

### The Problem with Traditional gRPC

- gRPC uses HTTP/2 with binary framing
- Browsers can't generate these requests
- You need a proxy (like Envoy) to translate

### How ConnectRPC Solves This

1. **Browser-Native**: Works with standard `fetch()` API
2. **No Proxy Needed**: Direct browser → backend communication
3. **Protocol Buffers**: Same type safety and code generation
4. **Interoperable**: Can talk to regular gRPC servers

### Comparison

```
Traditional gRPC-Web:
Browser → Envoy Proxy → gRPC Server
         (translation)

ConnectRPC:
Browser → ConnectRPC Server
         (direct!)
```

---

## 🔍 Project Structure

```
bookstore/
├── backend/                  # Go backend with ConnectRPC
│   ├── proto/
│   │   └── bookstore.proto  # Protocol Buffer definitions (the schema)
│   ├── gen/                 # Auto-generated code from .proto
│   │   ├── bookstore.pb.go  # Go message types
│   │   └── bookstorev1connect/  # ConnectRPC handlers
│   ├── services/
│   │   ├── merchant_service.go  # Merchant RPC implementations
│   │   └── customer_service.go  # Customer RPC implementations
│   ├── interceptors/
│   │   └── auth.go          # Authentication middleware
│   ├── db/
│   │   └── database.go      # PostgreSQL operations
│   ├── external/
│   │   └── google_books.go  # Google Books API client
│   ├── server.go            # Main entry point
│   ├── go.mod               # Go dependencies
│   └── Dockerfile           # Backend container config
│
├── frontend/                 # React frontend
│   ├── src/
│   │   ├── gen/             # Auto-generated TypeScript from .proto
│   │   ├── api/
│   │   │   └── client.ts    # ConnectRPC client setup
│   │   ├── components/
│   │   │   ├── BookCard.tsx # Book display component
│   │   │   ├── Cart.tsx     # Shopping cart
│   │   │   └── FilterPanel.tsx  # Search and filters
│   │   ├── types/
│   │   │   └── book.ts      # TypeScript type definitions
│   │   └── App.tsx          # Main application
│   ├── package.json         # Node dependencies
│   ├── Dockerfile           # Frontend container config
│   └── nginx.conf           # Nginx server config
│
└── docker-compose.yml       # Orchestrates all services
```

---

## 🎓 Key Learning Points

### 1. Protocol Buffers (Schema-First Design)

**File**: `backend/proto/bookstore.proto`

```protobuf
// Define your data structures
message Book {
  int64 id = 1;
  string title = 2;
  string author = 3;
  Genre genre = 4;
  double price = 5;
}

// Define your API
service CustomerService {
  rpc GetAvailableBooks(GetAvailableBooksRequest) 
    returns (GetAvailableBooksResponse);
}
```

**Benefits**:
- ✅ Single source of truth for API contract
- ✅ Auto-generates code for both backend and frontend
- ✅ Compile-time type checking
- ✅ Impossible to have backend/frontend mismatch

### 2. Code Generation

**Backend (Go)**:
```bash
protoc --go_out=. --connect-go_out=. bookstore.proto
```
Generates:
- Message types (structs)
- Service interfaces
- HTTP handlers

**Frontend (TypeScript)**:
```bash
protoc --es_out=. --connect-es_out=. bookstore.proto
```
Generates:
- TypeScript types
- Client code

### 3. Type-Safe API Calls

**Frontend** (`src/api/client.ts`):
```typescript
// Create a typed client
const client = createCustomerClient("customer", "password");

// All methods are typed!
const response = await client.getAvailableBooks({
  searchQuery: "clean code",
  genreFilter: Genre.TECHNOLOGY,
  page: 1,
  pageSize: 20
});

// response.books is typed as Book[]
// TypeScript knows all properties!
```

### 4. Authentication with Interceptors

**Backend** (`interceptors/auth.go`):
```go
// Interceptor runs before each RPC call
func (a *AuthInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
  return func(ctx context.Context, req connect.AnyRequest) {
    // Extract and validate credentials
    username, password := parseBasicAuth(req.Header())
    storeID, isCustomer := a.db.Authenticate(username, password)
    
    // Add to context for use in handlers
    ctx = context.WithValue(ctx, StoreIDKey, storeID)
    
    return next(ctx, req)  // Continue to handler
  }
}
```

**Similar to Express middleware**:
```javascript
app.use((req, res, next) => {
  // Validate auth
  req.user = validateAuth(req.headers);
  next();  // Continue to route handler
});
```

### 5. Race Condition Handling

**Database** (`db/database.go`):
```go
// Problem: Two customers try to buy the last book
// Solution: Database transactions with row-level locking

func (d *Database) PurchaseBook(bookID, customerID int64, quantity int32) error {
  tx, _ := d.db.Begin()
  defer tx.Rollback()
  
  // FOR UPDATE locks the row until transaction completes
  var stock int32
  tx.QueryRow(
    "SELECT stock_quantity FROM books WHERE id = $1 FOR UPDATE",
    bookID
  ).Scan(&stock)
  
  if stock < quantity {
    return fmt.Errorf("insufficient stock")
  }
  
  // Update stock and create sale record
  tx.Exec("UPDATE books SET stock_quantity = stock_quantity - $1 WHERE id = $2",
    quantity, bookID)
  tx.Exec("INSERT INTO sales ...")
  
  tx.Commit()  // Release lock
}
```

---

## 🛠️ Development

### Local Development (Without Docker)

**Backend**:
```bash
cd backend

# Install dependencies
go mod download

# Generate code from proto
protoc --proto_path=proto \
  --go_out=gen --go_opt=paths=source_relative \
  --connect-go_out=gen --connect-go_opt=paths=source_relative \
  proto/bookstore.proto

# Run server
go run server.go

# Server starts on http://localhost:8082
```

**Frontend**:
```bash
cd frontend

# Install dependencies
npm install

# Generate TypeScript from proto
protoc --proto_path=../backend/proto \
  --plugin=protoc-gen-es=./node_modules/.bin/protoc-gen-es \
  --plugin=protoc-gen-connect-es=./node_modules/.bin/protoc-gen-connect-es \
  --es_out=src/gen --es_opt=target=ts \
  --connect-es_out=src/gen --connect-es_opt=target=ts \
  ../backend/proto/bookstore.proto

# Run dev server
npm run dev

# Frontend starts on http://localhost:3000
```

### Database Setup

If running locally without Docker:
```bash
# Create database
createdb bookstore

# Set environment variables
export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=postgres
export DB_PASSWORD=postgres
export DB_NAME=bookstore

# Schema and seed data are auto-created when backend starts
```

---

## 🧪 Testing the API

### Using the Frontend

1. Open http://localhost:3000
2. Login as `customer` / `password`
3. Browse books, add to cart, checkout
4. See real-time stock updates

### Using cURL (ConnectRPC uses standard HTTP)

**Get Available Books**:
```bash
curl -X POST http://localhost:8082/bookstore.v1.CustomerService/GetAvailableBooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'customer:password' | base64)" \
  -d '{
    "searchQuery": "",
    "genreFilter": 0,
    "page": 1,
    "pageSize": 10
  }'
```

**Purchase a Book**:
```bash
curl -X POST http://localhost:8082/bookstore.v1.CustomerService/PurchaseBook \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'customer:password' | base64)" \
  -d '{
    "bookId": "1",
    "quantity": 1
  }'
```

---

## 📚 API Reference

### Customer Service

| RPC Method | Description | Auth Required |
|------------|-------------|---------------|
| `GetAvailableBooks` | Browse books with filters and pagination | Yes |
| `GetBookDetails` | Get details of a specific book | Yes |
| `PurchaseBook` | Buy a single book | Yes |
| `CheckoutCart` | Purchase multiple books at once | Yes |
| `AddReview` | Submit a review for a purchased book | Yes |
| `GetBookReviews` | Get all reviews for a book | Yes |
| `GetPurchaseHistory` | View your purchase history | Yes |

### Merchant Service

| RPC Method | Description | Auth Required |
|------------|-------------|---------------|
| `AddBook` | Add a new book to inventory | Yes |
| `RemoveBook` | Remove an unsold book | Yes |
| `UpdateStock` | Add more copies of a book | Yes |
| `GetMerchantBooks` | View your inventory | Yes |
| `GetSoldBooks` | View sales history | Yes |
| `GetLowStockBooks` | Get books below stock threshold | Yes |
| `LookupBookByISBN` | Fetch book details from Google Books | No |

---

## 🔐 Security Features

1. **HTTP Basic Authentication**: Simple but effective for learning
2. **Role-Based Access Control**: Merchants and customers have different permissions
3. **Authorization Interceptors**: Every request is authenticated
4. **Non-Root Docker Containers**: Security best practice
5. **CORS Configuration**: Prevents unauthorized domains from accessing API

**Production Recommendations**:
- Use JWT tokens instead of Basic Auth
- Add rate limiting
- Enable HTTPS (TLS)
- Use secrets management for credentials

---

## 📊 Database Schema

```sql
-- Users table (stores = merchants and customers)
CREATE TABLE stores (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    is_customer BOOLEAN NOT NULL DEFAULT false
);

-- Books table
CREATE TABLE books (
    id SERIAL PRIMARY KEY,
    store_id INTEGER REFERENCES stores(id),
    isbn VARCHAR(20),
    title VARCHAR(500) NOT NULL,
    author VARCHAR(255) NOT NULL,
    genre VARCHAR(50) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    total_sold INTEGER NOT NULL DEFAULT 0,
    average_rating DECIMAL(3, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Sales table (tracks each purchase)
CREATE TABLE sales (
    id SERIAL PRIMARY KEY,
    book_id INTEGER REFERENCES books(id),
    customer_id INTEGER REFERENCES stores(id),
    quantity INTEGER NOT NULL,
    price_at_purchase DECIMAL(10, 2) NOT NULL,
    purchased_at TIMESTAMP DEFAULT NOW()
);

-- Reviews table
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    book_id INTEGER REFERENCES books(id),
    customer_id INTEGER REFERENCES stores(id),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(book_id, customer_id)
);
```

---

## 🐛 Troubleshooting

### Port Already in Use

If ports are in use, change them in `docker-compose.yml`:
```yaml
services:
  database:
    ports:
      - "5435:5432"  # Change 5434 to 5435
  
  backend:
    ports:
      - "8083:8082"  # Change 8082 to 8083
```

### Database Connection Failed

```bash
# Check if database is running
docker-compose ps database

# View database logs
docker-compose logs database

# Restart database
docker-compose restart database
```

### Frontend Can't Connect to Backend

1. Check backend is running: `curl http://localhost:8082`
2. Check `.env.production` has correct backend URL
3. Rebuild frontend: `docker-compose build frontend`

---

## 📈 Next Steps

### Immediate Learning Extensions

1. **Add Server Streaming**: Implement real-time book notifications
2. **Add Client Streaming**: Batch upload books via CSV
3. **Add Bidirectional Streaming**: Real-time chat for customer support
4. **Implement Caching**: Add Redis for frequently accessed data
5. **Add Metrics**: Instrument with Prometheus

### Production Readiness

1. **Authentication**: Replace Basic Auth with JWT
2. **TLS**: Enable HTTPS for production
3. **Logging**: Add structured logging (zerolog)
4. **Monitoring**: Add health checks and metrics
5. **Testing**: Add unit and integration tests
6. **CI/CD**: Set up automated testing and deployment

### AI Features (Your Next Phase)

1. **Smart Search**: Use LLM for natural language book search
2. **Recommendations**: ML-based book recommendations
3. **Chatbot**: AI assistant for book discovery
4. **Vector Search**: Semantic similarity search with pgvector

---

## 📝 License

MIT License - Feel free to use this project for learning!

## 🙏 Acknowledgments

- **ConnectRPC**: https://connectrpc.com/
- **Protocol Buffers**: https://protobuf.dev/
- **Google Books API**: https://developers.google.com/books

---

## 💡 Key Takeaways

1. **ConnectRPC makes gRPC accessible to browsers** without proxies
2. **Protocol Buffers provide type safety** across frontend and backend
3. **Code generation eliminates boilerplate** and prevents bugs
4. **Interceptors are powerful** for cross-cutting concerns like auth
5. **Docker makes deployment consistent** across environments

**Happy Learning! 🚀📚**
