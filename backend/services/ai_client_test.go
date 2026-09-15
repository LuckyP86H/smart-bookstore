package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newMockAIService returns a test server that mimics the Python AI service API.
func newMockAIService(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/chat", func(w http.ResponseWriter, r *http.Request) {
		var req ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(ChatResponse{
			Reply: "Try Dune!",
			Books: []BookRecommendation{
				{BookID: 1, Title: "Dune", Author: "Frank Herbert", RelevanceScore: 0.9, Reason: "Great match"},
			},
			Confidence: 0.9,
		})
	})

	mux.HandleFunc("/search/semantic", func(w http.ResponseWriter, r *http.Request) {
		var req SemanticSearchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(SemanticSearchResponse{
			Results: []SearchResult{
				{BookID: 1, Title: "Dune", Author: "Frank Herbert", Score: 0.9},
			},
			Query:      req.Query,
			TotalFound: 1,
		})
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(HealthResponse{
			Status:            "healthy",
			LLMConnected:      true,
			DatabaseConnected: true,
			Version:           "1.0.0",
		})
	})

	return httptest.NewServer(mux)
}

func TestAIClientChat(t *testing.T) {
	srv := newMockAIService(t)
	defer srv.Close()

	client := NewAIClient(srv.URL)
	resp, err := client.Chat(context.Background(), "customer", "recommend sci-fi", nil)
	if err != nil {
		t.Fatalf("Chat returned error: %v", err)
	}
	if resp.Reply != "Try Dune!" {
		t.Errorf("Reply = %q, want %q", resp.Reply, "Try Dune!")
	}
	if len(resp.Books) != 1 || resp.Books[0].Title != "Dune" {
		t.Errorf("Books = %+v, want one Dune recommendation", resp.Books)
	}
}

func TestAIClientSemanticSearch(t *testing.T) {
	srv := newMockAIService(t)
	defer srv.Close()

	client := NewAIClient(srv.URL)
	resp, err := client.SemanticSearch(context.Background(), "space opera", 5, 0.5)
	if err != nil {
		t.Fatalf("SemanticSearch returned error: %v", err)
	}
	if resp.TotalFound != 1 || resp.Query != "space opera" {
		t.Errorf("got %+v, want 1 result echoing the query", resp)
	}
}

func TestAIClientHealth(t *testing.T) {
	srv := newMockAIService(t)
	defer srv.Close()

	client := NewAIClient(srv.URL)
	resp, err := client.Health(context.Background())
	if err != nil {
		t.Fatalf("Health returned error: %v", err)
	}
	if resp.Status != "healthy" || !resp.LLMConnected {
		t.Errorf("Health = %+v, want healthy with llm_connected=true", resp)
	}
}

func TestAIClientMarshalsNilContextAsEmptyList(t *testing.T) {
	var gotBody map[string]json.RawMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&gotBody)
		json.NewEncoder(w).Encode(ChatResponse{Reply: "ok"})
	}))
	defer srv.Close()

	client := NewAIClient(srv.URL)
	if _, err := client.Chat(context.Background(), "u", "m", nil); err != nil {
		t.Fatalf("Chat returned error: %v", err)
	}
	// The Python service rejects "context": null, so nil must become []
	if string(gotBody["context"]) != "[]" {
		t.Errorf(`context marshaled as %s, want []`, gotBody["context"])
	}
}

func TestAIClientSurfacesUpstreamErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := NewAIClient(srv.URL)
	if _, err := client.Chat(context.Background(), "u", "m", nil); err == nil {
		t.Fatal("expected error from failing upstream, got nil")
	}
}
