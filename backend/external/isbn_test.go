package external

import (
	"errors"
	"testing"
)

func TestNormalizeISBN(t *testing.T) {
	tests := []struct {
		in, want string
		ok       bool
	}{
		{"9780441172719", "9780441172719", true},     // Dune, ISBN-13
		{"978-0-441-17271-9", "9780441172719", true}, // hyphenated
		{" 978 0441172719 ", "9780441172719", true},  // spaces
		{"0441172717", "0441172717", true},           // Dune, ISBN-10
		{"080442957X", "080442957X", true},           // ISBN-10 with X check digit
		{"080442957x", "080442957X", true},           // lowercase x
		{"9780441172718", "", false},                 // wrong check digit
		{"0441172718", "", false},                    // wrong ISBN-10 check digit
		{"X804429570", "", false},                    // X only allowed last
		{"", "", false},
		{"12345", "", false},
		// Search operators must be rejected, not forwarded to Google
		{"9780441172719 OR intitle:x", "", false},
		{"isbn:9780441172719", "", false},
	}
	for _, tt := range tests {
		got, err := NormalizeISBN(tt.in)
		if tt.ok {
			if err != nil || got != tt.want {
				t.Errorf("NormalizeISBN(%q) = %q, %v; want %q, nil", tt.in, got, err, tt.want)
			}
		} else if !errors.Is(err, ErrInvalidISBN) {
			t.Errorf("NormalizeISBN(%q) = %q, %v; want ErrInvalidISBN", tt.in, got, err)
		}
	}
}
