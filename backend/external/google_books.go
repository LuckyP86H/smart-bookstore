package external

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

const googleBooksBaseURL = "https://www.googleapis.com/books/v1/volumes"

// ErrBookNotFound means Google Books has no volume for the ISBN.
var ErrBookNotFound = errors.New("no book found for this ISBN")

type GoogleBooksClient struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

type GoogleBooksResponse struct {
	Items []struct {
		VolumeInfo struct {
			Title         string   `json:"title"`
			Authors       []string `json:"authors"`
			Publisher     string   `json:"publisher"`
			PublishedDate string   `json:"publishedDate"`
			Description   string   `json:"description"`
			PageCount     int      `json:"pageCount"`
			Categories    []string `json:"categories"`
			ImageLinks    struct {
				Thumbnail string `json:"thumbnail"`
			} `json:"imageLinks"`
		} `json:"volumeInfo"`
	} `json:"items"`
}

type BookInfo struct {
	Title           string
	Author          string
	Publisher       string
	PublicationYear int32
	PageCount       int32
	Description     string
	CoverImageURL   string
	Categories      []string
}

// Option configures a GoogleBooksClient.
type Option func(*GoogleBooksClient)

// WithHTTPClient sets the client used for upstream requests — for tracing,
// a proxy, or a fake transport in tests. Its Timeout replaces the default.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *GoogleBooksClient) {
		if hc != nil {
			c.httpClient = hc
		}
	}
}

// WithBaseURL points the client at another volumes endpoint, such as a
// local test server.
func WithBaseURL(baseURL string) Option {
	return func(c *GoogleBooksClient) { c.baseURL = baseURL }
}

func NewGoogleBooksClient(apiKey string, opts ...Option) *GoogleBooksClient {
	c := &GoogleBooksClient{
		apiKey:     apiKey,
		baseURL:    googleBooksBaseURL,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// LookupByISBN fetches volume metadata for a normalized ISBN (see
// NormalizeISBN).
func (c *GoogleBooksClient) LookupByISBN(ctx context.Context, isbn string) (*BookInfo, error) {
	params := url.Values{}
	params.Add("q", "isbn:"+isbn)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("build Google Books request: %w", err)
	}
	// The key goes in a header, never the URL: URLs end up in error
	// messages, proxy logs and traces. Google APIs accept either.
	if c.apiKey != "" {
		req.Header.Set("X-goog-api-key", c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// *url.Error quotes the full request URL; callers only need the cause.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return nil, fmt.Errorf("Google Books request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Google Books API returned status %d", resp.StatusCode)
	}

	// Parse response
	var result GoogleBooksResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if len(result.Items) == 0 {
		return nil, ErrBookNotFound
	}

	// Extract book info
	volumeInfo := result.Items[0].VolumeInfo

	author := ""
	if len(volumeInfo.Authors) > 0 {
		author = volumeInfo.Authors[0]
		if len(volumeInfo.Authors) > 1 {
			for _, a := range volumeInfo.Authors[1:] {
				author += ", " + a
			}
		}
	}

	publicationYear := int32(0)
	if volumeInfo.PublishedDate != "" {
		// Try to parse year from date (formats: "YYYY", "YYYY-MM", "YYYY-MM-DD")
		if len(volumeInfo.PublishedDate) >= 4 {
			fmt.Sscanf(volumeInfo.PublishedDate[:4], "%d", &publicationYear)
		}
	}

	return &BookInfo{
		Title:           volumeInfo.Title,
		Author:          author,
		Publisher:       volumeInfo.Publisher,
		PublicationYear: publicationYear,
		PageCount:       int32(volumeInfo.PageCount),
		Description:     volumeInfo.Description,
		CoverImageURL:   volumeInfo.ImageLinks.Thumbnail,
		Categories:      volumeInfo.Categories,
	}, nil
}
