package services

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/LuckyP86H/smart-bookstore/external"
	bookstorev1 "github.com/LuckyP86H/smart-bookstore/gen"
	"github.com/LuckyP86H/smart-bookstore/interceptors"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func jsonResponse(body string) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
}

// lookupServer is a MerchantServiceServer whose Google Books client sends
// every request to a fake transport instead of the network. Each test gets
// its own, so tests share no state and can run in parallel.
type lookupServer struct {
	*MerchantServiceServer
	calls int
}

func newLookupServer(upstream roundTripFunc) *lookupServer {
	ls := &lookupServer{}
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		ls.calls++ // RoundTrip runs on the caller's goroutine, so no lock needed
		return upstream(r)
	})
	client := external.NewGoogleBooksClient("SECRET-KEY",
		external.WithHTTPClient(&http.Client{Transport: transport}))
	ls.MerchantServiceServer = &MerchantServiceServer{googleBooks: client}
	return ls
}

func (ls *lookupServer) lookup(isbn string) (*connect.Response[bookstorev1.LookupBookByISBNResponse], error) {
	return ls.LookupBookByISBN(context.Background(),
		connect.NewRequest(&bookstorev1.LookupBookByISBNRequest{Isbn: isbn}))
}

func TestLookupBookByISBNRejectsInvalidInputWithoutCallingUpstream(t *testing.T) {
	t.Parallel()
	srv := newLookupServer(func(*http.Request) (*http.Response, error) { return jsonResponse(`{}`) })
	for _, isbn := range []string{"", "12345", "9780441172718", "9780441172719 OR intitle:x"} {
		_, err := srv.lookup(isbn)
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("isbn %q: code = %v, want InvalidArgument", isbn, connect.CodeOf(err))
		}
	}
	if srv.calls != 0 {
		t.Errorf("upstream called %d times for invalid input, want 0", srv.calls)
	}
}

func TestLookupBookByISBNFound(t *testing.T) {
	t.Parallel()
	srv := newLookupServer(func(r *http.Request) (*http.Response, error) {
		if q := r.URL.Query().Get("q"); q != "isbn:9780441172719" {
			t.Errorf("upstream query = %q, want normalized isbn:9780441172719", q)
		}
		return jsonResponse(`{"items":[{"volumeInfo":{"title":"Dune","authors":["Frank Herbert"]}}]}`)
	})
	resp, err := srv.lookup("978-0-441-17271-9")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if resp.Msg.Title != "Dune" || resp.Msg.Author != "Frank Herbert" {
		t.Errorf("got %+v", resp.Msg)
	}
}

func TestLookupBookByISBNNotFound(t *testing.T) {
	t.Parallel()
	srv := newLookupServer(func(*http.Request) (*http.Response, error) { return jsonResponse(`{"totalItems":0}`) })
	if _, err := srv.lookup("9780441172719"); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("code = %v, want NotFound", connect.CodeOf(err))
	}
}

func TestLookupBookByISBNUpstreamFailureIsGenericUnavailable(t *testing.T) {
	t.Parallel()
	srv := newLookupServer(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	})
	_, err := srv.lookup("9780441172719")
	if connect.CodeOf(err) != connect.CodeUnavailable {
		t.Fatalf("code = %v, want Unavailable", connect.CodeOf(err))
	}
	var cerr *connect.Error
	if errors.As(err, &cerr) && (strings.Contains(cerr.Message(), "SECRET-KEY") || strings.Contains(cerr.Message(), "connection reset")) {
		t.Errorf("client-facing message leaks upstream detail: %q", cerr.Message())
	}
}

// Google answers 429 when the (shared, anonymous without an API key) daily
// quota runs out. That must surface as Unavailable, not NotFound: telling a
// merchant their valid ISBN has no book would be wrong.
func TestLookupBookByISBNQuotaExhaustedIsUnavailable(t *testing.T) {
	t.Parallel()
	srv := newLookupServer(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusTooManyRequests, Header: http.Header{},
			Body: io.NopCloser(strings.NewReader(`{"error":{"code":429}}`))}, nil
	})
	if _, err := srv.lookup("9780441172719"); connect.CodeOf(err) != connect.CodeUnavailable {
		t.Errorf("code = %v, want Unavailable", connect.CodeOf(err))
	}
}

func TestGetSoldBooksValidatesDateRange(t *testing.T) {
	t.Parallel()
	s := &MerchantServiceServer{} // validation fails before any DB access
	ctx := context.WithValue(context.Background(), interceptors.StoreIDKey, int64(1))

	tests := []struct{ name, start, end string }{
		{"bad start format", "2026-01-01", ""},
		{"bad end format", "", "yesterday"},
		{"start after end", "2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z"},
	}
	for _, tt := range tests {
		_, err := s.GetSoldBooks(ctx, connect.NewRequest(&bookstorev1.GetSoldBooksRequest{StartDate: tt.start, EndDate: tt.end}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: code = %v, want InvalidArgument", tt.name, connect.CodeOf(err))
		}
	}
}

func TestParseOptionalTime(t *testing.T) {
	t.Parallel()
	if got, err := parseOptionalTime("start_date", ""); got != nil || err != nil {
		t.Errorf(`empty: got %v, %v; want nil, nil (open bound)`, got, err)
	}
	got, err := parseOptionalTime("start_date", "2026-01-02T15:04:05Z")
	if err != nil || got == nil || got.Year() != 2026 {
		t.Errorf("valid: got %v, %v", got, err)
	}
}
