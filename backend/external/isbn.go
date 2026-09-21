package external

import (
	"errors"
	"strings"
)

// ErrInvalidISBN reports input that is not a well-formed ISBN-10 or ISBN-13.
var ErrInvalidISBN = errors.New("invalid ISBN: expected 10 or 13 digits with a valid check digit")

// NormalizeISBN strips hyphens and spaces and verifies the check digit,
// returning the bare ISBN. The result is safe to embed in a search query:
// it contains only digits (plus a trailing X for ISBN-10), so it can never
// smuggle extra search operators into the upstream request.
func NormalizeISBN(raw string) (string, error) {
	s := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(raw))

	switch len(s) {
	case 10:
		// Weights 10..1; the final character may be X (= 10).
		sum := 0
		for i, r := range s {
			var d int
			switch {
			case r >= '0' && r <= '9':
				d = int(r - '0')
			case r == 'X' && i == 9:
				d = 10
			default:
				return "", ErrInvalidISBN
			}
			sum += d * (10 - i)
		}
		if sum%11 != 0 {
			return "", ErrInvalidISBN
		}
	case 13:
		// Weights alternate 1, 3.
		sum := 0
		for i, r := range s {
			if r < '0' || r > '9' {
				return "", ErrInvalidISBN
			}
			d := int(r - '0')
			if i%2 == 1 {
				d *= 3
			}
			sum += d
		}
		if sum%10 != 0 {
			return "", ErrInvalidISBN
		}
	default:
		return "", ErrInvalidISBN
	}
	return s, nil
}
