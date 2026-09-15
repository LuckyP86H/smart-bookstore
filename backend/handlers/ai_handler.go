package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/LuckyP86H/smart-bookstore/services"
)

// AIHandler handles AI-related HTTP endpoints
type AIHandler struct {
	aiClient *services.AIClient
}

// NewAIHandler creates a new AI handler
func NewAIHandler(aiServiceURL string) *AIHandler {
	return &AIHandler{
		aiClient: services.NewAIClient(aiServiceURL),
	}
}

// ChatRequest represents incoming chat request from frontend
type ChatRequest struct {
	Message string   `json:"message"`
	Context []string `json:"context"`
}

// ChatResponse represents chat response to frontend
type ChatResponse struct {
	Reply      string                        `json:"reply"`
	Books      []services.BookRecommendation `json:"books"`
	Confidence float64                       `json:"confidence"`
}

// HandleChat processes chat requests
func (h *AIHandler) HandleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get username from Basic Auth
	username, _, ok := r.BasicAuth()
	if !ok {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	// Parse request
	var req ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Call AI service
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	aiResp, err := h.aiClient.Chat(ctx, username, req.Message, req.Context)
	if err != nil {
		// Log details server-side; never leak internal errors to clients
		log.Printf("AI chat error: %v", err)
		http.Error(w, "AI service unavailable", http.StatusInternalServerError)
		return
	}

	// Send response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ChatResponse{
		Reply:      aiResp.Reply,
		Books:      aiResp.Books,
		Confidence: aiResp.Confidence,
	})
}

// SemanticSearchRequest represents semantic search request
type SemanticSearchRequest struct {
	Query    string  `json:"query"`
	Limit    int     `json:"limit"`
	MinScore float64 `json:"min_score"`
}

// SemanticSearchResponse represents semantic search response
type SemanticSearchResponse struct {
	Results    []services.SearchResult `json:"results"`
	Query      string                  `json:"query"`
	TotalFound int                     `json:"total_found"`
}

// HandleSemanticSearch processes semantic search requests
func (h *AIHandler) HandleSemanticSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse request
	var req SemanticSearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Set defaults. The similarity floor matches the AI service's default:
	// with all-MiniLM-L6-v2, strong topical matches score ~0.4-0.6.
	if req.Limit == 0 {
		req.Limit = 10
	}
	if req.MinScore == 0 {
		req.MinScore = 0.35
	}

	// Call AI service
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	aiResp, err := h.aiClient.SemanticSearch(ctx, req.Query, req.Limit, req.MinScore)
	if err != nil {
		log.Printf("AI semantic search error: %v", err)
		http.Error(w, "Search unavailable", http.StatusInternalServerError)
		return
	}

	// Send response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(SemanticSearchResponse{
		Results:    aiResp.Results,
		Query:      aiResp.Query,
		TotalFound: aiResp.TotalFound,
	})
}

// HandleHealth checks AI service health
func (h *AIHandler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	health, err := h.aiClient.Health(ctx)
	if err != nil {
		log.Printf("AI health check error: %v", err)
		http.Error(w, "AI service unavailable", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}
