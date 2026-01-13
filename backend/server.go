// Package main is the entry point for the ConnectRPC bookstore server
// This demonstrates a production-ready gRPC-style API using ConnectRPC
// which works natively in browsers without needing Envoy proxy
package main

import (
	"log"
	"net/http"
	"os"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"     // HTTP/2 support for better performance
	"golang.org/x/net/http2/h2c" // h2c = HTTP/2 Cleartext (without TLS)

	"github.com/LuckyP86H/smart-bookstore/db"
	"github.com/LuckyP86H/smart-bookstore/external"
	"github.com/LuckyP86H/smart-bookstore/gen/bookstorev1connect" // Auto-generated ConnectRPC service handlers
	"github.com/LuckyP86H/smart-bookstore/handlers"
	"github.com/LuckyP86H/smart-bookstore/interceptors"
	"github.com/LuckyP86H/smart-bookstore/services"
)

func main() {
	// Load configuration from environment variables
	// This follows 12-factor app principles for cloud-native deployments
	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5434")
	dbUser := getEnv("DB_USER", "postgres")
	dbPassword := getEnv("DB_PASSWORD", "postgres")
	dbName := getEnv("DB_NAME", "bookstore")
	googleBooksAPIKey := getEnv("GOOGLE_BOOKS_API_KEY", "")
	aiServiceURL := getEnv("AI_SERVICE_URL", "http://localhost:8000")
	port := getEnv("PORT", "8082")

	// Initialize database connection
	// The database layer handles schema initialization and auto-seeding test accounts
	log.Println("Connecting to database...")
	database, err := db.NewDatabase(dbHost, dbPort, dbUser, dbPassword, dbName)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer database.Close()
	log.Println("✅ Database connected and initialized")

	// Initialize Google Books API client for ISBN lookup
	// This allows merchants to auto-populate book details by entering just the ISBN
	googleBooks := external.NewGoogleBooksClient(googleBooksAPIKey)
	if googleBooksAPIKey == "" {
		log.Println("⚠️  Warning: GOOGLE_BOOKS_API_KEY not set. ISBN lookup will have rate limits.")
	}

	// Create authentication interceptor
	// Interceptors work like Express middleware - they run before each RPC call
	// This one validates credentials and adds user context to requests
	authInterceptor := interceptors.NewAuthInterceptor(database)

	// Create service implementations
	// These implement the business logic defined in our Protocol Buffer service definitions
	merchantService := services.NewMerchantServiceServer(database, googleBooks)
	customerService := services.NewCustomerServiceServer(database)

	// Create HTTP mux (router) for handling RPC requests
	mux := http.NewServeMux()

	// Register Merchant Service with ConnectRPC
	// NewMerchantServiceHandler is auto-generated from our .proto file
	// It creates HTTP handlers for all RPC methods defined in MerchantService
	merchantPath, merchantHandler := bookstorev1connect.NewMerchantServiceHandler(
		merchantService,
		connect.WithInterceptors(authInterceptor), // Apply authentication to all merchant RPCs
	)
	mux.Handle(merchantPath, merchantHandler)

	// Register Customer Service with ConnectRPC
	// Similarly handles all customer-facing RPC methods
	customerPath, customerHandler := bookstorev1connect.NewCustomerServiceHandler(
		customerService,
		connect.WithInterceptors(authInterceptor), // Apply authentication to all customer RPCs
	)
	mux.Handle(customerPath, customerHandler)

	// Register AI Service HTTP endpoints
	// These are REST endpoints that communicate with the Python AI microservice
	aiHandler := handlers.NewAIHandler(aiServiceURL)
	mux.HandleFunc("/api/ai/chat", basicAuthMiddleware(database, aiHandler.HandleChat))
	mux.HandleFunc("/api/ai/search/semantic", aiHandler.HandleSemanticSearch) // No auth required for search
	mux.HandleFunc("/api/ai/health", aiHandler.HandleHealth)

	// Wrap with CORS middleware for browser access
	// Allows frontend running on different origin (port 3000) to make requests
	handler := corsMiddleware(mux)

	// Create HTTP/2 server with h2c (HTTP/2 Cleartext)
	// h2c allows HTTP/2 without TLS, which is fine for local development
	// In production, you'd use TLS and remove the h2c wrapper
	server := &http.Server{
		Addr:    ":" + port,
		Handler: h2c.NewHandler(handler, &http2.Server{}),
	}

	log.Printf("🚀 ConnectRPC server listening on http://localhost:%s", port)
	log.Printf("   Merchant Service: %s", merchantPath)
	log.Printf("   Customer Service: %s", customerPath)
	log.Println("\n📝 Test accounts:")
	log.Println("   Merchants: merchant1:password1, merchant2:password2")
	log.Println("   Customer: customer:password")

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// basicAuthMiddleware wraps HTTP handlers with HTTP Basic Auth validation
func basicAuthMiddleware(database *db.Database, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok {
			w.Header().Set("WWW-Authenticate", `Basic realm="Bookstore"`)
			http.Error(w, "Authentication required", http.StatusUnauthorized)
			return
		}

		// Validate credentials
		if !database.ValidateCredentials(username, password) {
			http.Error(w, "Invalid credentials", http.StatusUnauthorized)
			return
		}

		// Continue to handler
		next(w, r)
	}
}

// corsMiddleware adds CORS headers to allow browser-based clients to access the API
// CORS (Cross-Origin Resource Sharing) is required when frontend and backend are on different origins
// In our case: frontend on port 3000, backend on port 8082
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Allow any origin - in production, you'd specify your frontend domain
		w.Header().Set("Access-Control-Allow-Origin", "*")

		// Allow standard HTTP methods
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")

		// Allow headers needed by ConnectRPC and authentication
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Connect-Protocol-Version, Connect-Timeout-Ms")

		// Expose ConnectRPC-specific headers to the browser
		w.Header().Set("Access-Control-Expose-Headers", "Connect-Protocol-Version, Connect-Timeout-Ms")

		// Handle preflight requests (browsers send OPTIONS before actual request)
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		// Continue to the actual handler
		next.ServeHTTP(w, r)
	})
}

// getEnv retrieves an environment variable or returns a default value
// This is a common pattern for 12-factor app configuration
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
