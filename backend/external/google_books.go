package external

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

type GoogleBooksClient struct {
	apiKey     string
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

func NewGoogleBooksClient(apiKey string) *GoogleBooksClient {
	return &GoogleBooksClient{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

func (c *GoogleBooksClient) LookupByISBN(isbn string) (*BookInfo, error) {
	// Build URL
	baseURL := "https://www.googleapis.com/books/v1/volumes"
	params := url.Values{}
	params.Add("q", "isbn:"+isbn)
	if c.apiKey != "" {
		params.Add("key", c.apiKey)
	}

	fullURL := fmt.Sprintf("%s?%s", baseURL, params.Encode())

	// Make request
	resp, err := c.httpClient.Get(fullURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch from Google Books API: %w", err)
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
		return nil, fmt.Errorf("no book found with ISBN %s", isbn)
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
