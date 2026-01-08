package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

type Database struct {
	db *sql.DB
}

func NewDatabase(host, port, user, password, dbname string) (*Database, error) {
	connStr := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, port, user, password, dbname)

	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		return nil, err
	}

	database := &Database{db: db}
	if err := database.initSchema(); err != nil {
		return nil, err
	}

	if err := database.seedAccounts(); err != nil {
		return nil, err
	}

	return database, nil
}

func (d *Database) initSchema() error {
	schema := `
	CREATE TABLE IF NOT EXISTS stores (
		id SERIAL PRIMARY KEY,
		username VARCHAR(255) UNIQUE NOT NULL,
		password VARCHAR(255) NOT NULL,
		is_customer BOOLEAN NOT NULL DEFAULT false
	);

	CREATE TABLE IF NOT EXISTS books (
		id SERIAL PRIMARY KEY,
		store_id INTEGER NOT NULL REFERENCES stores(id),
		isbn VARCHAR(20),
		title VARCHAR(500) NOT NULL,
		author VARCHAR(255) NOT NULL,
		genre VARCHAR(50) NOT NULL,
		publisher VARCHAR(255),
		publication_year INTEGER,
		page_count INTEGER,
		language VARCHAR(50) DEFAULT 'en',
		cover_image_url TEXT,
		description TEXT,
		price DECIMAL(10, 2) NOT NULL,
		stock_quantity INTEGER NOT NULL DEFAULT 0,
		total_sold INTEGER NOT NULL DEFAULT 0,
		average_rating DECIMAL(3, 2) DEFAULT 0,
		created_at TIMESTAMP NOT NULL DEFAULT NOW(),
		UNIQUE(store_id, isbn)
	);

	CREATE TABLE IF NOT EXISTS sales (
		id SERIAL PRIMARY KEY,
		book_id INTEGER NOT NULL REFERENCES books(id),
		customer_id INTEGER NOT NULL REFERENCES stores(id),
		quantity INTEGER NOT NULL,
		price_at_purchase DECIMAL(10, 2) NOT NULL,
		purchased_at TIMESTAMP NOT NULL DEFAULT NOW()
	);

	CREATE TABLE IF NOT EXISTS reviews (
		id SERIAL PRIMARY KEY,
		book_id INTEGER NOT NULL REFERENCES books(id),
		customer_id INTEGER NOT NULL REFERENCES stores(id),
		rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
		review_text TEXT,
		created_at TIMESTAMP NOT NULL DEFAULT NOW(),
		UNIQUE(book_id, customer_id)
	);

	CREATE INDEX IF NOT EXISTS idx_books_store_id ON books(store_id);
	CREATE INDEX IF NOT EXISTS idx_books_genre ON books(genre);
	CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
	CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
	CREATE INDEX IF NOT EXISTS idx_books_stock ON books(stock_quantity);
	CREATE INDEX IF NOT EXISTS idx_sales_book_id ON sales(book_id);
	CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales(customer_id);
	CREATE INDEX IF NOT EXISTS idx_reviews_book_id ON reviews(book_id);
	`

	_, err := d.db.Exec(schema)
	return err
}

func (d *Database) seedAccounts() error {
	accounts := []struct {
		username   string
		password   string
		isCustomer bool
	}{
		{"merchant1", "password1", false},
		{"merchant2", "password2", false},
		{"customer", "password", true},
	}

	for _, acc := range accounts {
		var exists bool
		err := d.db.QueryRow("SELECT EXISTS(SELECT 1 FROM stores WHERE username=$1)", acc.username).Scan(&exists)
		if err != nil {
			return err
		}
		if !exists {
			_, err := d.db.Exec("INSERT INTO stores (username, password, is_customer) VALUES ($1, $2, $3)",
				acc.username, acc.password, acc.isCustomer)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func (d *Database) Close() error {
	return d.db.Close()
}

// ============================================================================
// Authentication
// ============================================================================

func (d *Database) AuthenticateStore(username, password string) (int64, bool, error) {
	var storeID int64
	var isCustomer bool
	var storedPassword string

	err := d.db.QueryRow(
		"SELECT id, password, is_customer FROM stores WHERE username = $1",
		username,
	).Scan(&storeID, &storedPassword, &isCustomer)

	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}

	if storedPassword != password {
		return 0, false, nil
	}

	return storeID, isCustomer, nil
}

// ============================================================================
// Book Operations
// ============================================================================

type Book struct {
	ID              int64
	StoreID         int64
	ISBN            string
	Title           string
	Author          string
	Genre           string
	Publisher       string
	PublicationYear int32
	PageCount       int32
	Language        string
	CoverImageURL   string
	Description     string
	Price           float64
	StockQuantity   int32
	TotalSold       int32
	AverageRating   float64
	CreatedAt       time.Time
	StoreName       string
}

func (d *Database) CreateBook(storeID int64, isbn, title, author, genre, publisher string,
	publicationYear, pageCount int32, language, coverImageURL, description string,
	price float64, stockQuantity int32) (*Book, error) {

	var book Book
	// Use upsert: if a book with the same ISBN exists for this store, update it instead of creating duplicate
	// This preserves the book ID, total_sold, average_rating, and created_at when updating
	err := d.db.QueryRow(`
		INSERT INTO books (store_id, isbn, title, author, genre, publisher, publication_year,
			page_count, language, cover_image_url, description, price, stock_quantity)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (store_id, isbn) DO UPDATE SET
			title = EXCLUDED.title,
			author = EXCLUDED.author,
			genre = EXCLUDED.genre,
			publisher = EXCLUDED.publisher,
			publication_year = EXCLUDED.publication_year,
			page_count = EXCLUDED.page_count,
			language = EXCLUDED.language,
			cover_image_url = EXCLUDED.cover_image_url,
			description = EXCLUDED.description,
			price = EXCLUDED.price,
			stock_quantity = EXCLUDED.stock_quantity
		RETURNING id, store_id, isbn, title, author, genre, publisher, publication_year,
			page_count, language, cover_image_url, description, price, stock_quantity,
			total_sold, average_rating, created_at`,
		storeID, isbn, title, author, genre, publisher, publicationYear,
		pageCount, language, coverImageURL, description, price, stockQuantity,
	).Scan(&book.ID, &book.StoreID, &book.ISBN, &book.Title, &book.Author, &book.Genre,
		&book.Publisher, &book.PublicationYear, &book.PageCount, &book.Language,
		&book.CoverImageURL, &book.Description, &book.Price, &book.StockQuantity,
		&book.TotalSold, &book.AverageRating, &book.CreatedAt)

	if err != nil {
		return nil, err
	}

	d.db.QueryRow("SELECT username FROM stores WHERE id = $1", book.StoreID).Scan(&book.StoreName)

	return &book, nil
}

func (d *Database) DeleteBook(bookID, storeID int64) error {
	var hasSales bool
	err := d.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sales WHERE book_id=$1)", bookID).Scan(&hasSales)
	if err != nil {
		return err
	}
	if hasSales {
		return fmt.Errorf("cannot delete book with sales history")
	}

	result, err := d.db.Exec("DELETE FROM books WHERE id = $1 AND store_id = $2", bookID, storeID)
	if err != nil {
		return err
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return fmt.Errorf("book not found or unauthorized")
	}

	return nil
}

func (d *Database) UpdateStock(bookID, storeID int64, quantityToAdd int32) (*Book, error) {
	var book Book
	err := d.db.QueryRow(`
		UPDATE books 
		SET stock_quantity = stock_quantity + $1
		WHERE id = $2 AND store_id = $3
		RETURNING id, store_id, isbn, title, author, genre, publisher, publication_year,
			page_count, language, cover_image_url, description, price, stock_quantity,
			total_sold, average_rating, created_at`,
		quantityToAdd, bookID, storeID,
	).Scan(&book.ID, &book.StoreID, &book.ISBN, &book.Title, &book.Author, &book.Genre,
		&book.Publisher, &book.PublicationYear, &book.PageCount, &book.Language,
		&book.CoverImageURL, &book.Description, &book.Price, &book.StockQuantity,
		&book.TotalSold, &book.AverageRating, &book.CreatedAt)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("book not found or unauthorized")
	}
	if err != nil {
		return nil, err
	}

	d.db.QueryRow("SELECT username FROM stores WHERE id = $1", book.StoreID).Scan(&book.StoreName)

	return &book, nil
}

func (d *Database) GetMerchantBooks(storeID int64, includeSoldOut bool) ([]*Book, error) {
	query := `
		SELECT b.id, b.store_id, b.isbn, b.title, b.author, b.genre, b.publisher,
			b.publication_year, b.page_count, b.language, b.cover_image_url,
			b.description, b.price, b.stock_quantity, b.total_sold, b.average_rating,
			b.created_at, s.username
		FROM books b
		JOIN stores s ON b.store_id = s.id
		WHERE b.store_id = $1`

	if !includeSoldOut {
		query += " AND b.stock_quantity > 0"
	}
	query += " ORDER BY b.created_at DESC"

	rows, err := d.db.Query(query, storeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []*Book
	for rows.Next() {
		var book Book
		err := rows.Scan(&book.ID, &book.StoreID, &book.ISBN, &book.Title, &book.Author,
			&book.Genre, &book.Publisher, &book.PublicationYear, &book.PageCount,
			&book.Language, &book.CoverImageURL, &book.Description, &book.Price,
			&book.StockQuantity, &book.TotalSold, &book.AverageRating, &book.CreatedAt,
			&book.StoreName)
		if err != nil {
			return nil, err
		}
		books = append(books, &book)
	}

	return books, nil
}

func (d *Database) GetLowStockBooks(storeID int64, threshold int32) ([]*Book, error) {
	rows, err := d.db.Query(`
		SELECT b.id, b.store_id, b.isbn, b.title, b.author, b.genre, b.publisher,
			b.publication_year, b.page_count, b.language, b.cover_image_url,
			b.description, b.price, b.stock_quantity, b.total_sold, b.average_rating,
			b.created_at, s.username
		FROM books b
		JOIN stores s ON b.store_id = s.id
		WHERE b.store_id = $1 AND b.stock_quantity <= $2 AND b.stock_quantity > 0
		ORDER BY b.stock_quantity ASC`,
		storeID, threshold)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []*Book
	for rows.Next() {
		var book Book
		err := rows.Scan(&book.ID, &book.StoreID, &book.ISBN, &book.Title, &book.Author,
			&book.Genre, &book.Publisher, &book.PublicationYear, &book.PageCount,
			&book.Language, &book.CoverImageURL, &book.Description, &book.Price,
			&book.StockQuantity, &book.TotalSold, &book.AverageRating, &book.CreatedAt,
			&book.StoreName)
		if err != nil {
			return nil, err
		}
		books = append(books, &book)
	}

	return books, nil
}

// ============================================================================
// Customer Book Operations
// ============================================================================

type BookFilter struct {
	SearchQuery  string
	GenreFilter  string
	AuthorFilter string
	MinPrice     float64
	MaxPrice     float64
	SortOrder    string
	Page         int32
	PageSize     int32
}

func (d *Database) GetAvailableBooks(filter BookFilter) ([]*Book, int32, error) {
	query := `
		SELECT b.id, b.store_id, b.isbn, b.title, b.author, b.genre, b.publisher,
			b.publication_year, b.page_count, b.language, b.cover_image_url,
			b.description, b.price, b.stock_quantity, b.total_sold, b.average_rating,
			b.created_at, s.username
		FROM books b
		JOIN stores s ON b.store_id = s.id
		WHERE b.stock_quantity > 0`

	args := []interface{}{}
	argCount := 0

	if filter.SearchQuery != "" {
		argCount++
		query += fmt.Sprintf(" AND (LOWER(b.title) LIKE $%d OR LOWER(b.author) LIKE $%d)", argCount, argCount)
		args = append(args, "%"+filter.SearchQuery+"%")
	}

	if filter.GenreFilter != "" && filter.GenreFilter != "GENRE_UNSPECIFIED" {
		argCount++
		query += fmt.Sprintf(" AND b.genre = $%d", argCount)
		args = append(args, filter.GenreFilter)
	}

	if filter.AuthorFilter != "" {
		argCount++
		query += fmt.Sprintf(" AND LOWER(b.author) LIKE $%d", argCount)
		args = append(args, "%"+filter.AuthorFilter+"%")
	}

	if filter.MinPrice > 0 {
		argCount++
		query += fmt.Sprintf(" AND b.price >= $%d", argCount)
		args = append(args, filter.MinPrice)
	}

	if filter.MaxPrice > 0 {
		argCount++
		query += fmt.Sprintf(" AND b.price <= $%d", argCount)
		args = append(args, filter.MaxPrice)
	}

	// Count total
	countQuery := "SELECT COUNT(*) FROM (" + query + ") AS filtered"
	var totalCount int32
	err := d.db.QueryRow(countQuery, args...).Scan(&totalCount)
	if err != nil {
		return nil, 0, err
	}

	// Add sorting
	switch filter.SortOrder {
	case "PRICE_ASC":
		query += " ORDER BY b.price ASC"
	case "PRICE_DESC":
		query += " ORDER BY b.price DESC"
	case "TITLE_ASC":
		query += " ORDER BY b.title ASC"
	case "TITLE_DESC":
		query += " ORDER BY b.title DESC"
	case "RATING_DESC":
		query += " ORDER BY b.average_rating DESC"
	case "PUBLICATION_YEAR_DESC":
		query += " ORDER BY b.publication_year DESC"
	default:
		query += " ORDER BY b.created_at DESC"
	}

	// Add pagination
	if filter.PageSize == 0 {
		filter.PageSize = 20
	}
	if filter.Page < 1 {
		filter.Page = 1
	}
	offset := (filter.Page - 1) * filter.PageSize

	argCount++
	query += fmt.Sprintf(" LIMIT $%d", argCount)
	args = append(args, filter.PageSize)

	argCount++
	query += fmt.Sprintf(" OFFSET $%d", argCount)
	args = append(args, offset)

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var books []*Book
	for rows.Next() {
		var book Book
		err := rows.Scan(&book.ID, &book.StoreID, &book.ISBN, &book.Title, &book.Author,
			&book.Genre, &book.Publisher, &book.PublicationYear, &book.PageCount,
			&book.Language, &book.CoverImageURL, &book.Description, &book.Price,
			&book.StockQuantity, &book.TotalSold, &book.AverageRating, &book.CreatedAt,
			&book.StoreName)
		if err != nil {
			return nil, 0, err
		}
		books = append(books, &book)
	}

	return books, totalCount, nil
}

func (d *Database) GetBookByID(bookID int64) (*Book, error) {
	var book Book
	err := d.db.QueryRow(`
		SELECT b.id, b.store_id, b.isbn, b.title, b.author, b.genre, b.publisher,
			b.publication_year, b.page_count, b.language, b.cover_image_url,
			b.description, b.price, b.stock_quantity, b.total_sold, b.average_rating,
			b.created_at, s.username
		FROM books b
		JOIN stores s ON b.store_id = s.id
		WHERE b.id = $1`,
		bookID,
	).Scan(&book.ID, &book.StoreID, &book.ISBN, &book.Title, &book.Author,
		&book.Genre, &book.Publisher, &book.PublicationYear, &book.PageCount,
		&book.Language, &book.CoverImageURL, &book.Description, &book.Price,
		&book.StockQuantity, &book.TotalSold, &book.AverageRating, &book.CreatedAt,
		&book.StoreName)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("book not found")
	}
	if err != nil {
		return nil, err
	}

	return &book, nil
}

// ============================================================================
// Purchase Operations
// ============================================================================

type Sale struct {
	ID              int64
	BookID          int64
	BookTitle       string
	CustomerID      int64
	CustomerName    string
	Quantity        int32
	PriceAtPurchase float64
	PurchasedAt     time.Time
}

func (d *Database) PurchaseBook(bookID, customerID int64, quantity int32) (*Sale, error) {
	tx, err := d.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var stockQuantity int32
	var price float64
	var title string
	err = tx.QueryRow(
		"SELECT stock_quantity, price, title FROM books WHERE id = $1 FOR UPDATE",
		bookID,
	).Scan(&stockQuantity, &price, &title)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("book not found")
	}
	if err != nil {
		return nil, err
	}

	if stockQuantity < quantity {
		return nil, fmt.Errorf("insufficient stock: only %d available", stockQuantity)
	}

	_, err = tx.Exec(
		"UPDATE books SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2",
		quantity, bookID,
	)
	if err != nil {
		return nil, err
	}

	var saleID int64
	var purchasedAt time.Time
	err = tx.QueryRow(`
		INSERT INTO sales (book_id, customer_id, quantity, price_at_purchase)
		VALUES ($1, $2, $3, $4)
		RETURNING id, purchased_at`,
		bookID, customerID, quantity, price,
	).Scan(&saleID, &purchasedAt)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	var customerName string
	d.db.QueryRow("SELECT username FROM stores WHERE id = $1", customerID).Scan(&customerName)

	return &Sale{
		ID:              saleID,
		BookID:          bookID,
		BookTitle:       title,
		CustomerID:      customerID,
		CustomerName:    customerName,
		Quantity:        quantity,
		PriceAtPurchase: price,
		PurchasedAt:     purchasedAt,
	}, nil
}

func (d *Database) CheckoutCart(customerID int64, items []struct {
	BookID   int64
	Quantity int32
}) ([]*Sale, error) {
	tx, err := d.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var sales []*Sale

	for _, item := range items {
		var stockQuantity int32
		var price float64
		var title string
		err = tx.QueryRow(
			"SELECT stock_quantity, price, title FROM books WHERE id = $1 FOR UPDATE",
			item.BookID,
		).Scan(&stockQuantity, &price, &title)

		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("book %d not found", item.BookID)
		}
		if err != nil {
			return nil, err
		}

		if stockQuantity < item.Quantity {
			return nil, fmt.Errorf("insufficient stock for book '%s': only %d available", title, stockQuantity)
		}

		_, err = tx.Exec(
			"UPDATE books SET stock_quantity = stock_quantity - $1, total_sold = total_sold + $1 WHERE id = $2",
			item.Quantity, item.BookID,
		)
		if err != nil {
			return nil, err
		}

		var saleID int64
		var purchasedAt time.Time
		err = tx.QueryRow(`
			INSERT INTO sales (book_id, customer_id, quantity, price_at_purchase)
			VALUES ($1, $2, $3, $4)
			RETURNING id, purchased_at`,
			item.BookID, customerID, item.Quantity, price,
		).Scan(&saleID, &purchasedAt)
		if err != nil {
			return nil, err
		}

		var customerName string
		tx.QueryRow("SELECT username FROM stores WHERE id = $1", customerID).Scan(&customerName)

		sales = append(sales, &Sale{
			ID:              saleID,
			BookID:          item.BookID,
			BookTitle:       title,
			CustomerID:      customerID,
			CustomerName:    customerName,
			Quantity:        item.Quantity,
			PriceAtPurchase: price,
			PurchasedAt:     purchasedAt,
		})
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return sales, nil
}

func (d *Database) GetSoldBooks(storeID int64, startDate, endDate time.Time) ([]*Sale, error) {
	rows, err := d.db.Query(`
		SELECT s.id, s.book_id, b.title, s.customer_id, st.username, s.quantity, 
			s.price_at_purchase, s.purchased_at
		FROM sales s
		JOIN books b ON s.book_id = b.id
		JOIN stores st ON s.customer_id = st.id
		WHERE b.store_id = $1 AND s.purchased_at BETWEEN $2 AND $3
		ORDER BY s.purchased_at DESC`,
		storeID, startDate, endDate,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sales []*Sale
	for rows.Next() {
		var sale Sale
		err := rows.Scan(&sale.ID, &sale.BookID, &sale.BookTitle, &sale.CustomerID,
			&sale.CustomerName, &sale.Quantity, &sale.PriceAtPurchase, &sale.PurchasedAt)
		if err != nil {
			return nil, err
		}
		sales = append(sales, &sale)
	}

	return sales, nil
}

func (d *Database) GetPurchaseHistory(customerID int64) ([]*Sale, error) {
	rows, err := d.db.Query(`
		SELECT s.id, s.book_id, b.title, s.customer_id, st.username, s.quantity, 
			s.price_at_purchase, s.purchased_at
		FROM sales s
		JOIN books b ON s.book_id = b.id
		JOIN stores st ON s.customer_id = st.id
		WHERE s.customer_id = $1
		ORDER BY s.purchased_at DESC`,
		customerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sales []*Sale
	for rows.Next() {
		var sale Sale
		err := rows.Scan(&sale.ID, &sale.BookID, &sale.BookTitle, &sale.CustomerID,
			&sale.CustomerName, &sale.Quantity, &sale.PriceAtPurchase, &sale.PurchasedAt)
		if err != nil {
			return nil, err
		}
		sales = append(sales, &sale)
	}

	return sales, nil
}

// ============================================================================
// Review Operations
// ============================================================================

type Review struct {
	ID           int64
	BookID       int64
	CustomerID   int64
	CustomerName string
	Rating       int32
	ReviewText   string
	CreatedAt    time.Time
}

func (d *Database) AddReview(bookID, customerID int64, rating int32, reviewText string) (*Review, error) {
	// Check if customer purchased this book
	var hasPurchased bool
	err := d.db.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM sales WHERE book_id=$1 AND customer_id=$2)",
		bookID, customerID,
	).Scan(&hasPurchased)
	if err != nil {
		return nil, err
	}
	if !hasPurchased {
		return nil, fmt.Errorf("you can only review books you have purchased")
	}

	// Insert review
	var review Review
	err = d.db.QueryRow(`
		INSERT INTO reviews (book_id, customer_id, rating, review_text)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (book_id, customer_id) 
		DO UPDATE SET rating = $3, review_text = $4, created_at = NOW()
		RETURNING id, book_id, customer_id, rating, review_text, created_at`,
		bookID, customerID, rating, reviewText,
	).Scan(&review.ID, &review.BookID, &review.CustomerID, &review.Rating,
		&review.ReviewText, &review.CreatedAt)
	if err != nil {
		return nil, err
	}

	// Update average rating
	d.db.Exec(`
		UPDATE books 
		SET average_rating = (SELECT AVG(rating) FROM reviews WHERE book_id = $1)
		WHERE id = $1`,
		bookID,
	)

	d.db.QueryRow("SELECT username FROM stores WHERE id = $1", customerID).Scan(&review.CustomerName)

	return &review, nil
}

func (d *Database) GetBookReviews(bookID int64) ([]*Review, error) {
	rows, err := d.db.Query(`
		SELECT r.id, r.book_id, r.customer_id, s.username, r.rating, r.review_text, r.created_at
		FROM reviews r
		JOIN stores s ON r.customer_id = s.id
		WHERE r.book_id = $1
		ORDER BY r.created_at DESC`,
		bookID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reviews []*Review
	for rows.Next() {
		var review Review
		err := rows.Scan(&review.ID, &review.BookID, &review.CustomerID, &review.CustomerName,
			&review.Rating, &review.ReviewText, &review.CreatedAt)
		if err != nil {
			return nil, err
		}
		reviews = append(reviews, &review)
	}

	return reviews, nil
}
