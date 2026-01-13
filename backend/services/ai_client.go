// Package services contains AI client for communicating with Python AI service
// This demonstrates REST API communication between Go and Python microservices
package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// AIClient handles communication with the Python AI service via REST API
type AIClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewAIClient creates a new AI service client
func NewAIClient(baseURL string) *AIClient {
	return &AIClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second, // AI responses can take time
		},
	}
}

// ============================================================================
// Request/Response structures matching Python AI service
// ============================================================================

// ChatRequest represents a chat message to the AI
type ChatRequest struct {
	UserID  string   `json:"user_id"`
	Message string   `json:"message"`
	Context []string `json:"context"`
}

// BookRecommendation represents a recommended book from AI
type BookRecommendation struct {
	BookID         int64   `json:"book_id"`
	Title          string  `json:"title"`
	Author         string  `json:"author"`
	RelevanceScore float64 `json:"relevance_score"`
	Reason         string  `json:"reason"`
}

// ChatResponse represents AI's response
type ChatResponse struct {
	Reply      string               `json:"reply"`
	Books      []BookRecommendation `json:"books"`
	Confidence float64              `json:"confidence"`
}

// SemanticSearchRequest represents a semantic search query
type SemanticSearchRequest struct {
	Query    string  `json:"query"`
	Limit    int     `json:"limit"`
	MinScore float64 `json:"min_score"`
}

// SearchResult represents a single search result
type SearchResult struct {
	BookID      int64   `json:"book_id"`
	Title       string  `json:"title"`
	Author      string  `json:"author"`
	Description string  `json:"description"`
	Score       float64 `json:"score"`
}

// SemanticSearchResponse represents semantic search results
type SemanticSearchResponse struct {
	Results    []SearchResult `json:"results"`
	Query      string         `json:"query"`
	TotalFound int            `json:"total_found"`
}

// HealthResponse represents AI service health status
type HealthResponse struct {
	Status            string `json:"status"`
	OllamaConnected   bool   `json:"ollama_connected"`
	DatabaseConnected bool   `json:"database_connected"`
	Version           string `json:"version"`
}

// ============================================================================
// API Methods
// ============================================================================

// Chat sends a message to the AI and gets recommendations
func (c *AIClient) Chat(ctx context.Context, userID, message string, context []string) (*ChatResponse, error) {
	// Prepare request
	reqBody := ChatRequest{
		UserID:  userID,
		Message: message,
		Context: context,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Make HTTP POST request
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/chat", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("AI service returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var chatResp ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &chatResp, nil
}

// SemanticSearch performs semantic search for books
func (c *AIClient) SemanticSearch(ctx context.Context, query string, limit int, minScore float64) (*SemanticSearchResponse, error) {
	// Prepare request
	reqBody := SemanticSearchRequest{
		Query:    query,
		Limit:    limit,
		MinScore: minScore,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Make HTTP POST request
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/search/semantic", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("AI service returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var searchResp SemanticSearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &searchResp, nil
}

// Health checks if the AI service is healthy
func (c *AIClient) Health(ctx context.Context) (*HealthResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/health", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("AI service returned status %d", resp.StatusCode)
	}

	var healthResp HealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&healthResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &healthResp, nil
}

// GenerateEmbeddingsForAllBooks triggers batch embedding generation
// This is typically called once during setup/migration
func (c *AIClient) GenerateEmbeddingsForAllBooks(ctx context.Context) (int, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/embeddings/generate-all", nil)
	if err != nil {
		return 0, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("failed to call AI service: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("AI service returned status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Status       string `json:"status"`
		BooksUpdated int    `json:"books_updated"`
		Message      string `json:"message"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("failed to decode response: %w", err)
	}

	return result.BooksUpdated, nil
}
