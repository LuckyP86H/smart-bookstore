#!/bin/bash
# seed-data.sh - Populate database with sample books for testing
# Usage: ./scripts/seed-data.sh

set -e

# Configuration
BACKEND_URL="${BACKEND_URL:-http://localhost:8082}"
MERCHANT_USER="${MERCHANT_USER:-merchant1}"
MERCHANT_PASS="${MERCHANT_PASS:-password1}"

echo "🌱 Seeding bookstore database..."
echo "📍 Backend URL: $BACKEND_URL"
echo "👤 Merchant: $MERCHANT_USER"
echo ""

# Function to add a book
add_book() {
  local isbn=$1
  local title=$2
  local author=$3
  local genre=$4
  local price=$5
  local stock=$6
  local description=$7
  
  echo "📚 Adding: $title by $author"
  
  curl -s -X POST "$BACKEND_URL/bookstore.v1.MerchantService/AddBook" \
    -u "$MERCHANT_USER:$MERCHANT_PASS" \
    -H "Content-Type: application/json" \
    -d "{
      \"isbn\": \"$isbn\",
      \"title\": \"$title\",
      \"author\": \"$author\",
      \"genre\": \"$genre\",
      \"price\": $price,
      \"stock_quantity\": $stock,
      \"description\": \"$description\"
    }" | jq -r '.book.id // "Error"'
}

# Programming Books
add_book "9780132350884" \
  "Clean Code: A Handbook of Agile Software Craftsmanship" \
  "Robert C. Martin" \
  "GENRE_TECHNOLOGY" \
  45.99 \
  25 \
  "Even bad code can function. But if code isn't clean, it can bring a development organization to its knees. Every year, countless hours and significant resources are lost because of poorly written code."

add_book "9780137081073" \
  "The Pragmatic Programmer: Your Journey To Mastery" \
  "David Thomas, Andrew Hunt" \
  "GENRE_TECHNOLOGY" \
  49.99 \
  30 \
  "The Pragmatic Programmer is one of those rare tech books you'll read, re-read, and read again over the years. Whether you're new to the field or an experienced practitioner, you'll come away with fresh insights each and every time."

add_book "9781449355739" \
  "Designing Data-Intensive Applications" \
  "Martin Kleppmann" \
  "GENRE_TECHNOLOGY" \
  54.99 \
  20 \
  "Data is at the center of many challenges in system design today. Difficult issues need to be figured out, such as scalability, consistency, reliability, efficiency, and maintainability."

# Business & Entrepreneurship
add_book "9780307887894" \
  "The Lean Startup" \
  "Eric Ries" \
  "GENRE_BUSINESS" \
  26.99 \
  40 \
  "A new approach to business that's being adopted around the world, changing the way companies are built and new products are launched. The Lean Startup approach fosters companies that are both more capital efficient and that leverage human creativity more effectively."

add_book "9780307463746" \
  "Zero to One: Notes on Startups, or How to Build the Future" \
  "Peter Thiel" \
  "GENRE_BUSINESS" \
  28.99 \
  35 \
  "Every moment in business happens only once. The next Bill Gates will not build an operating system. The next Larry Page or Sergey Brin won't make a search engine. If you are copying these guys, you aren't learning from them."

add_book "9780307465351" \
  "Shoe Dog: A Memoir by the Creator of Nike" \
  "Phil Knight" \
  "GENRE_BIOGRAPHY" \
  29.99 \
  30 \
  "In this candid and riveting memoir, for the first time ever, Nike founder and CEO Phil Knight shares the inside story of the company's early days as an intrepid start-up and its evolution into one of the world's most iconic, game-changing, and profitable brands."

# Science & History
add_book "9780062316097" \
  "Sapiens: A Brief History of Humankind" \
  "Yuval Noah Harari" \
  "GENRE_HISTORY" \
  24.99 \
  45 \
  "From a renowned historian comes a groundbreaking narrative of humanity's creation and evolution that explores the ways in which biology and history have defined us and enhanced our understanding of what it means to be human."

add_book "9780385537859" \
  "The Gene: An Intimate History" \
  "Siddhartha Mukherjee" \
  "GENRE_SCIENCE" \
  32.99 \
  25 \
  "A groundbreaking work of science, history, and memoir, The Gene is a sweeping narrative that illuminates how the secrets of our genetic code shape our identities, our destinies, and our futures."

# Fiction
add_book "9780547928227" \
  "The Hobbit" \
  "J.R.R. Tolkien" \
  "GENRE_FICTION" \
  15.99 \
  50 \
  "A great modern classic and the prelude to The Lord of the Rings. Bilbo Baggins is a hobbit who enjoys a comfortable, unambitious life, rarely traveling any farther than his pantry or cellar."

add_book "9780544003415" \
  "The Lord of the Rings" \
  "J.R.R. Tolkien" \
  "GENRE_FICTION" \
  35.99 \
  40 \
  "One Ring to rule them all, One Ring to find them, One Ring to bring them all and in the darkness bind them. In ancient times the Rings of Power were crafted by the Elven-smiths, and Sauron, the Dark Lord, forged the One Ring."

add_book "9780441172719" \
  "Dune" \
  "Frank Herbert" \
  "GENRE_FICTION" \
  18.99 \
  35 \
  "Set on the desert planet Arrakis, Dune is the story of Paul Atreides, who would become the mysterious man known as Muad'Dib. He would avenge the traitorous plot against his noble family and would bring to fruition humankind's most ancient and unattainable dream."

# Self-Help
add_book "9780062457714" \
  "The Subtle Art of Not Giving a F*ck" \
  "Mark Manson" \
  "GENRE_SELF_HELP" \
  24.99 \
  60 \
  "For decades, we've been told that positive thinking is the key to a happy, rich life. But those days are over. Stop trying to be positive all the time. It's time to stop and recognize that not everything is special."

add_book "9781501110368" \
  "When Breath Becomes Air" \
  "Paul Kalanithi" \
  "GENRE_BIOGRAPHY" \
  26.99 \
  30 \
  "At the age of thirty-six, on the verge of completing a decade's worth of training as a neurosurgeon, Paul Kalanithi was diagnosed with stage IV lung cancer. One day he was a doctor treating the dying, and the next he was a patient struggling to live."

# Psychology
add_book "9780374533557" \
  "Thinking, Fast and Slow" \
  "Daniel Kahneman" \
  "GENRE_PSYCHOLOGY" \
  30.99 \
  25 \
  "In the highly anticipated Thinking, Fast and Slow, Kahneman takes us on a groundbreaking tour of the mind and explains the two systems that drive the way we think."

add_book "9780143127741" \
  "Atomic Habits" \
  "James Clear" \
  "GENRE_SELF_HELP" \
  27.99 \
  55 \
  "No matter your goals, Atomic Habits offers a proven framework for improving every day. James Clear, one of the world's leading experts on habit formation, reveals practical strategies that will teach you exactly how to form good habits, break bad ones, and master the tiny behaviors that lead to remarkable results."

# Technology & Future
add_book "9781501197277" \
  "The Innovators" \
  "Walter Isaacson" \
  "GENRE_HISTORY" \
  35.99 \
  20 \
  "Following his blockbuster biography of Steve Jobs, The Innovators is Walter Isaacson's revealing story of the people who created the computer and the Internet."

echo ""
echo "✅ Database seeding complete!"
echo ""
echo "📊 Summary:"
echo "   - 16 books added across multiple genres"
echo "   - Genres: Technology, Business, Fiction, Self-Help, Science, History"
echo "   - Total stock: ~500 books"
echo ""
echo "🔐 Test with:"
echo "   Username: customer"
echo "   Password: password"
echo ""
echo "💬 Try AI Chat:"
echo "   - 'recommend programming books'"
echo "   - 'find books about startups'"
echo "   - 'suggest sci-fi novels'"
