package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newMockAIService mimics the Python AI service for handler tests.
func newMockAIService(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/chat", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"reply":      "Try Dune!",
			"books":      []map[string]any{{"book_id": 1, "title": "Dune", "author": "Frank Herbert", "relevance_score": 0.9, "reason": "Great match"}},
			"confidence": 0.9,
		})
	})
	mux.HandleFunc("/search/semantic", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		json.NewEncoder(w).Encode(map[string]any{
			"results":     []map[string]any{{"book_id": 1, "title": "Dune", "author": "Frank Herbert", "score": 0.9}},
			"query":       req["query"],
			"total_found": 1,
		})
	})
	return httptest.NewServer(mux)
}

func TestHandleChatRequiresAuth(t *testing.T) {
	h := NewAIHandler("http://unused")
	req := httptest.NewRequest(http.MethodPost, "/api/ai/chat", strings.NewReader(`{"message":"hi"}`))
	rec := httptest.NewRecorder()

	h.HandleChat(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 without Basic Auth", rec.Code)
	}
}

func TestHandleChatRejectsNonPost(t *testing.T) {
	h := NewAIHandler("http://unused")
	req := httptest.NewRequest(http.MethodGet, "/api/ai/chat", nil)
	rec := httptest.NewRecorder()

	h.HandleChat(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405 for GET", rec.Code)
	}
}

func TestHandleChatProxiesToAIService(t *testing.T) {
	srv := newMockAIService(t)
	defer srv.Close()

	h := NewAIHandler(srv.URL)
	req := httptest.NewRequest(http.MethodPost, "/api/ai/chat", strings.NewReader(`{"message":"recommend sci-fi","context":[]}`))
	req.SetBasicAuth("customer", "password")
	rec := httptest.NewRecorder()

	h.HandleChat(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp ChatResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if resp.Reply != "Try Dune!" || len(resp.Books) != 1 {
		t.Errorf("resp = %+v, want Dune recommendation", resp)
	}
}

func TestHandleSemanticSearchDefaults(t *testing.T) {
	srv := newMockAIService(t)
	defer srv.Close()

	h := NewAIHandler(srv.URL)
	req := httptest.NewRequest(http.MethodPost, "/api/ai/search/semantic", strings.NewReader(`{"query":"space opera"}`))
	rec := httptest.NewRecorder()

	h.HandleSemanticSearch(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp SemanticSearchResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if resp.TotalFound != 1 || resp.Query != "space opera" {
		t.Errorf("resp = %+v, want 1 result echoing the query", resp)
	}
}
