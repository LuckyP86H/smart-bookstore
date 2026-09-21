package external_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/LuckyP86H/smart-bookstore/external"
)

const testKey = "AIzaSy-TEST-SECRET-KEY"

// Black-box tests: only the exported API, configured through options.
func newTestClient(baseURL string, opts ...external.Option) *external.GoogleBooksClient {
	return external.NewGoogleBooksClient(testKey, append([]external.Option{external.WithBaseURL(baseURL)}, opts...)...)
}

func TestLookupByISBNParsesVolume(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("q"); got != "isbn:9780441172719" {
			t.Errorf("q = %q, want isbn:9780441172719", got)
		}
		w.Write([]byte(`{"items":[{"volumeInfo":{"title":"Dune","authors":["Frank Herbert","Brian Herbert"],
			"publishedDate":"1990-09-01","pageCount":535,"imageLinks":{"thumbnail":"http://img"}}}]}`))
	}))
	defer srv.Close()

	info, err := newTestClient(srv.URL).LookupByISBN(context.Background(), "9780441172719")
	if err != nil {
		t.Fatalf("LookupByISBN: %v", err)
	}
	if info.Title != "Dune" || info.Author != "Frank Herbert, Brian Herbert" ||
		info.PublicationYear != 1990 || info.PageCount != 535 {
		t.Errorf("unexpected BookInfo: %+v", info)
	}
}

func TestLookupByISBNNotFound(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"totalItems":0}`))
	}))
	defer srv.Close()

	_, err := newTestClient(srv.URL).LookupByISBN(context.Background(), "9780441172719")
	if !errors.Is(err, external.ErrBookNotFound) {
		t.Errorf("err = %v, want external.ErrBookNotFound", err)
	}
}

func TestLookupByISBNUpstreamStatus(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "quota exceeded", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := newTestClient(srv.URL).LookupByISBN(context.Background(), "9780441172719")
	if err == nil || errors.Is(err, external.ErrBookNotFound) {
		t.Errorf("err = %v, want a non-NotFound upstream error", err)
	}
}

// Regression: transport errors from net/http quote the full request URL,
// which carries the API key. It must not survive into the returned error.
func TestLookupByISBNErrorsNeverContainAPIKey(t *testing.T) {
	t.Parallel()
	blocked := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-blocked // hang until the client times out
	}))
	defer srv.Close()
	defer close(blocked)

	c := newTestClient(srv.URL, external.WithHTTPClient(&http.Client{Timeout: 50 * time.Millisecond}))

	_, err := c.LookupByISBN(context.Background(), "9780441172719")
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if strings.Contains(err.Error(), testKey) || strings.Contains(err.Error(), "key=") {
		t.Errorf("error leaks the API key: %v", err)
	}
}
