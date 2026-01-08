#!/bin/bash

# ============================================
# BOOK SEEDING SCRIPT FOR CONNECTRPC BOOKSTORE
# ============================================
# 
# This script uses the MerchantService AddBook RPC to populate
# the database with realistic book data.
#
# Usage:
#   ./scripts/seed-books.sh                    # Seed all books with default credentials
#   ./scripts/seed-books.sh merchant2 password2 # Seed with specific merchant credentials
#
# Prerequisites:
#   - Backend running on http://localhost:8082
#   - curl installed
#
# ============================================

set -e

# Configuration
API_URL="${API_URL:-http://localhost:8082}"
MERCHANT_USER="${1:-merchant1}"
MERCHANT_PASS="${2:-password1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Encode credentials for Basic Auth
AUTH_HEADER=$(echo -n "${MERCHANT_USER}:${MERCHANT_PASS}" | base64)

echo -e "${BLUE}📚 Bookstore Seeding Script${NC}"
echo -e "${BLUE}================================${NC}"
echo -e "API URL: ${API_URL}"
echo -e "Merchant: ${MERCHANT_USER}"
echo ""

# Function to add a book
add_book() {
    local isbn="$1"
    local title="$2"
    local author="$3"
    local genre="$4"
    local publisher="$5"
    local year="$6"
    local pages="$7"
    local description="$8"
    local price="$9"
    local stock="${10}"
    local cover_url="${11}"
    
    echo -e "${YELLOW}Adding: ${title}...${NC}"
    
    response=$(curl -s -X POST "${API_URL}/bookstore.v1.MerchantService/AddBook" \
        -H "Content-Type: application/json" \
        -H "Authorization: Basic ${AUTH_HEADER}" \
        -d "{
            \"isbn\": \"${isbn}\",
            \"title\": \"${title}\",
            \"author\": \"${author}\",
            \"genre\": ${genre},
            \"publisher\": \"${publisher}\",
            \"publicationYear\": ${year},
            \"pageCount\": ${pages},
            \"language\": \"en\",
            \"description\": \"${description}\",
            \"price\": ${price},
            \"stockQuantity\": ${stock},
            \"coverImageUrl\": \"${cover_url}\"
        }" 2>&1)
    
    if echo "$response" | grep -q '"book"'; then
        echo -e "${GREEN}  ✓ Added successfully${NC}"
    else
        echo -e "${RED}  ✗ Failed: ${response}${NC}"
    fi
}

echo -e "${BLUE}Adding Technology Books...${NC}"
echo ""

# Genre values from proto:
# TECHNOLOGY = 14, FICTION = 1, NON_FICTION = 2, SCIENCE = 3, HISTORY = 4, BIOGRAPHY = 5
# MYSTERY = 6, ROMANCE = 7, FANTASY = 8, SCIENCE_FICTION = 9, THRILLER = 10
# HORROR = 11, SELF_HELP = 12, BUSINESS = 13, CHILDREN = 15

add_book "978-0132350884" \
    "Clean Code: A Handbook of Agile Software Craftsmanship" \
    "Robert C. Martin" \
    14 \
    "Prentice Hall" \
    2008 \
    464 \
    "Even bad code can function. But if code isn't clean, it can bring a development organization to its knees." \
    39.99 \
    15 \
    "https://m.media-amazon.com/images/I/41xShlnTZTL._SX376_BO1,204,203,200_.jpg"

add_book "978-0596517748" \
    "JavaScript: The Good Parts" \
    "Douglas Crockford" \
    14 \
    "O'Reilly Media" \
    2008 \
    176 \
    "Most programming languages contain good and bad parts, but JavaScript has more than its share of the bad." \
    29.99 \
    20 \
    "https://m.media-amazon.com/images/I/5131OWtQRaL._SX381_BO1,204,203,200_.jpg"

add_book "978-1491950357" \
    "Building Microservices" \
    "Sam Newman" \
    14 \
    "O'Reilly Media" \
    2015 \
    280 \
    "Distributed systems have become more fine-grained in the past 10 years, as developers have moved to smaller services." \
    44.99 \
    12 \
    "https://covers.openlibrary.org/b/isbn/9781491950357-L.jpg"

add_book "978-0134685991" \
    "Effective Java" \
    "Joshua Bloch" \
    14 \
    "Addison-Wesley" \
    2017 \
    416 \
    "The definitive guide to Java platform best practices, updated for Java 9, 10, and 11." \
    54.99 \
    8 \
    "https://m.media-amazon.com/images/I/41zLisPNN2L._SX376_BO1,204,203,200_.jpg"

add_book "978-1617294945" \
    "Kubernetes in Action" \
    "Marko Luksa" \
    14 \
    "Manning" \
    2017 \
    624 \
    "A comprehensive guide to mastering Kubernetes, the industry-standard container orchestration platform." \
    59.99 \
    10 \
    "https://covers.openlibrary.org/b/isbn/9781617294945-L.jpg"

echo ""
echo -e "${BLUE}Adding Fiction Books...${NC}"
echo ""

add_book "978-0451524935" \
    "1984" \
    "George Orwell" \
    1 \
    "Signet Classics" \
    1949 \
    328 \
    "A dystopian social science fiction novel and cautionary tale about the dangers of totalitarianism." \
    14.99 \
    25 \
    "https://m.media-amazon.com/images/I/71kxa1-0mfL._AC_UF1000,1000_QL80_.jpg"

add_book "978-0061120084" \
    "To Kill a Mockingbird" \
    "Harper Lee" \
    1 \
    "Harper Perennial" \
    1960 \
    336 \
    "A timeless classic of modern American literature about racial injustice and the loss of innocence." \
    16.99 \
    18 \
    "https://m.media-amazon.com/images/I/81gepf1eMqL._AC_UF1000,1000_QL80_.jpg"

add_book "978-0743273565" \
    "The Great Gatsby" \
    "F. Scott Fitzgerald" \
    1 \
    "Scribner" \
    1925 \
    180 \
    "A portrait of the Jazz Age in all of its decadence and excess." \
    15.99 \
    22 \
    "https://m.media-amazon.com/images/I/81af+MCATTL._AC_UF1000,1000_QL80_.jpg"

echo ""
echo -e "${BLUE}Adding Science Fiction Books...${NC}"
echo ""

add_book "978-0441172719" \
    "Dune" \
    "Frank Herbert" \
    9 \
    "Ace Books" \
    1965 \
    688 \
    "Set in the distant future amidst a feudal interstellar society in which noble houses control planetary fiefs." \
    19.99 \
    14 \
    "https://m.media-amazon.com/images/I/81ym3QUd3KL._AC_UF1000,1000_QL80_.jpg"

add_book "978-0345342966" \
    "Fahrenheit 451" \
    "Ray Bradbury" \
    9 \
    "Del Rey" \
    1953 \
    158 \
    "A dystopian novel about a future American society where books are outlawed and burned by firemen." \
    14.99 \
    16 \
    "https://m.media-amazon.com/images/I/71OFqSRFDgL._AC_UF1000,1000_QL80_.jpg"

add_book "978-0553380163" \
    "A Brief History of Time" \
    "Stephen Hawking" \
    3 \
    "Bantam" \
    1988 \
    212 \
    "A landmark volume in science writing exploring the origin and fate of the universe." \
    18.99 \
    20 \
    "https://m.media-amazon.com/images/I/A1xkFZX5k-L._AC_UF1000,1000_QL80_.jpg"

echo ""
echo -e "${BLUE}Adding Business Books...${NC}"
echo ""

add_book "978-0062316110" \
    "Sapiens: A Brief History of Humankind" \
    "Yuval Noah Harari" \
    4 \
    "Harper" \
    2014 \
    464 \
    "A groundbreaking narrative of humanity's creation and evolution that explores human history from the Stone Age to the present." \
    24.99 \
    12 \
    "https://m.media-amazon.com/images/I/713jIoMO3UL._AC_UF1000,1000_QL80_.jpg"

add_book "978-0307887436" \
    "The Lean Startup" \
    "Eric Ries" \
    13 \
    "Currency" \
    2011 \
    336 \
    "A new approach to business that's being adopted around the world, changing the way companies are built and new products are launched." \
    28.99 \
    15 \
    "https://m.media-amazon.com/images/I/81-QB7nDh4L._AC_UF1000,1000_QL80_.jpg"

add_book "978-0062457714" \
    "The Subtle Art of Not Giving a F*ck" \
    "Mark Manson" \
    12 \
    "Harper" \
    2016 \
    224 \
    "A counterintuitive approach to living a good life by learning to accept your limitations." \
    26.99 \
    18 \
    "https://m.media-amazon.com/images/I/71QKQ9mwV7L._AC_UF1000,1000_QL80_.jpg"

echo ""
echo -e "${BLUE}Adding Fantasy Books...${NC}"
echo ""

add_book "978-0547928227" \
    "The Hobbit" \
    "J.R.R. Tolkien" \
    8 \
    "Mariner Books" \
    1937 \
    300 \
    "Bilbo Baggins is a hobbit who enjoys a comfortable, unambitious life, until the wizard Gandalf appears." \
    16.99 \
    20 \
    "https://m.media-amazon.com/images/I/710+HcoP38L._AC_UF1000,1000_QL80_.jpg"

add_book "978-0439708180" \
    "Harry Potter and the Sorcerer's Stone" \
    "J.K. Rowling" \
    8 \
    "Scholastic" \
    1997 \
    309 \
    "Harry Potter discovers on his 11th birthday that he is the orphaned son of two powerful wizards." \
    12.99 \
    30 \
    "https://m.media-amazon.com/images/I/81YOuOGFCJL._AC_UF1000,1000_QL80_.jpg"

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}✓ Book seeding complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo -e "View books at: ${BLUE}http://localhost:3000${NC}"
echo -e "Login as: ${YELLOW}customer / password${NC}"

