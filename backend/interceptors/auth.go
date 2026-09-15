package interceptors

import (
	"context"
	"encoding/base64"
	"strings"

	"connectrpc.com/connect"
	"github.com/LuckyP86H/smart-bookstore/db"
)

type contextKey string

const (
	StoreIDKey    = contextKey("store_id")
	IsCustomerKey = contextKey("is_customer")
	UsernameKey   = contextKey("username")
)

type AuthInterceptor struct {
	db *db.Database
}

func NewAuthInterceptor(database *db.Database) *AuthInterceptor {
	return &AuthInterceptor{db: database}
}

func (a *AuthInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		// Skip authentication for health checks or public endpoints
		if req.Spec().Procedure == "/grpc.health.v1.Health/Check" {
			return next(ctx, req)
		}

		// Extract Basic Auth credentials
		authHeader := req.Header().Get("Authorization")
		if authHeader == "" {
			return nil, connect.NewError(connect.CodeUnauthenticated, nil)
		}

		username, password, err := parseBasicAuth(authHeader)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, err)
		}

		// Authenticate
		storeID, isCustomer, err := a.db.AuthenticateStore(username, password)
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		if storeID == 0 {
			return nil, connect.NewError(connect.CodeUnauthenticated, nil)
		}

		// Check authorization based on service
		procedure := req.Spec().Procedure

		// Customers cannot access MerchantService
		if strings.Contains(procedure, "MerchantService") && isCustomer {
			return nil, connect.NewError(connect.CodePermissionDenied, nil)
		}

		// Merchants CAN access CustomerService read-only endpoints for browsing books
		// This allows merchants to view available books from all stores
		// Only restrict customer-specific actions (like PurchaseBook) if needed
		// For now, we allow merchants full access to CustomerService as well

		// Add to context
		ctx = context.WithValue(ctx, StoreIDKey, storeID)
		ctx = context.WithValue(ctx, IsCustomerKey, isCustomer)
		ctx = context.WithValue(ctx, UsernameKey, username)

		return next(ctx, req)
	}
}

func (a *AuthInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (a *AuthInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		// Extract Basic Auth credentials
		authHeader := conn.RequestHeader().Get("Authorization")
		if authHeader == "" {
			return connect.NewError(connect.CodeUnauthenticated, nil)
		}

		username, password, err := parseBasicAuth(authHeader)
		if err != nil {
			return connect.NewError(connect.CodeUnauthenticated, err)
		}

		// Authenticate
		storeID, isCustomer, err := a.db.AuthenticateStore(username, password)
		if err != nil {
			return connect.NewError(connect.CodeInternal, err)
		}
		if storeID == 0 {
			return connect.NewError(connect.CodeUnauthenticated, nil)
		}

		// Check authorization based on service
		procedure := conn.Spec().Procedure

		// Customers cannot access MerchantService
		if strings.Contains(procedure, "MerchantService") && isCustomer {
			return connect.NewError(connect.CodePermissionDenied, nil)
		}

		// Merchants CAN access CustomerService read-only endpoints for browsing books

		// Add to context
		ctx = context.WithValue(ctx, StoreIDKey, storeID)
		ctx = context.WithValue(ctx, IsCustomerKey, isCustomer)
		ctx = context.WithValue(ctx, UsernameKey, username)

		return next(ctx, conn)
	}
}

func parseBasicAuth(authHeader string) (string, string, error) {
	const prefix = "Basic "
	if !strings.HasPrefix(authHeader, prefix) {
		return "", "", connect.NewError(connect.CodeUnauthenticated, nil)
	}

	encoded := authHeader[len(prefix):]
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", connect.NewError(connect.CodeUnauthenticated, err)
	}

	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return "", "", connect.NewError(connect.CodeUnauthenticated, nil)
	}

	return parts[0], parts[1], nil
}

// Helper functions to extract from context
func GetStoreID(ctx context.Context) int64 {
	if storeID, ok := ctx.Value(StoreIDKey).(int64); ok {
		return storeID
	}
	return 0
}

func IsCustomer(ctx context.Context) bool {
	if isCustomer, ok := ctx.Value(IsCustomerKey).(bool); ok {
		return isCustomer
	}
	return false
}

func GetUsername(ctx context.Context) string {
	if username, ok := ctx.Value(UsernameKey).(string); ok {
		return username
	}
	return ""
}
