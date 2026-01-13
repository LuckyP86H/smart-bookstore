#!/bin/bash
# generate-embeddings.sh - Generate AI embeddings for all books
# Run this after seeding data to enable semantic search and AI chat
# Usage: ./scripts/generate-embeddings.sh

set -e

AI_SERVICE_URL="${AI_SERVICE_URL:-http://localhost:8000}"

echo "🤖 Generating AI embeddings for all books..."
echo "📍 AI Service URL: $AI_SERVICE_URL"
echo ""

# Check if AI service is running
if ! curl -sf "$AI_SERVICE_URL/health" > /dev/null 2>&1; then
  echo "❌ Error: AI service is not running at $AI_SERVICE_URL"
  echo ""
  echo "Please start the AI service first:"
  echo "  docker-compose up -d ai-service"
  echo ""
  echo "Or if running locally:"
  echo "  cd ai-service && uvicorn app.main:app --reload"
  exit 1
fi

echo "✅ AI service is running"
echo ""

# Generate embeddings for all books
echo "🔄 Generating embeddings (this may take 30-60 seconds)..."
response=$(curl -s -X POST "$AI_SERVICE_URL/embeddings/generate-all")

# Parse response
books_updated=$(echo "$response" | jq -r '.books_updated // 0')
status=$(echo "$response" | jq -r '.status // "error"')

if [ "$status" = "success" ]; then
  echo "✅ Successfully generated embeddings for $books_updated books"
  echo ""
  echo "🎉 AI features are now ready!"
  echo ""
  echo "Try these AI chat queries:"
  echo "  - 'recommend books about programming'"
  echo "  - 'find startup and business books'"
  echo "  - 'suggest fiction novels'"
  echo ""
  echo "Or test semantic search API:"
  echo "  curl -X POST $AI_SERVICE_URL/search/semantic \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"query\": \"entrepreneurship\", \"limit\": 5}' | jq"
else
  echo "❌ Error generating embeddings"
  echo "Response: $response"
  exit 1
fi
