#!/bin/bash
# setup-complete.sh - Complete setup for Bookstore application
# This script does everything: start services, seed data, generate embeddings
# Usage: ./scripts/setup-complete.sh

set -e

echo "🚀 Starting complete Bookstore setup..."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "${BLUE}📋 Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
  echo "❌ Docker is not installed. Please install Docker first."
  exit 1
fi

if ! command -v docker-compose &> /dev/null; then
  echo "❌ Docker Compose is not installed. Please install Docker Compose first."
  exit 1
fi

if ! command -v ollama &> /dev/null; then
  echo "⚠️  Ollama is not installed. AI features will not work."
  echo "   Install with: brew install ollama"
  echo ""
  read -p "Continue without AI features? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
  SKIP_AI=true
fi

echo "✅ Prerequisites check passed"
echo ""

# Start Ollama if available
if [ -z "$SKIP_AI" ]; then
  echo "${BLUE}🤖 Setting up Ollama...${NC}"
  
  # Check if Ollama is running
  if ! curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "Starting Ollama service..."
    nohup ollama serve > /tmp/ollama.log 2>&1 &
    sleep 3
  fi
  
  # Check if llama3.2 is installed
  if ! ollama list | grep -q "llama3.2"; then
    echo "Pulling llama3.2 model (2GB, may take a few minutes)..."
    ollama pull llama3.2
  fi
  
  echo "✅ Ollama is ready"
  echo ""
fi

# Start Docker services
echo "${BLUE}🐳 Starting Docker services...${NC}"
docker-compose up -d

echo "⏳ Waiting for services to be healthy..."
sleep 10

# Check service health
max_attempts=30
attempt=0

while [ $attempt -lt $max_attempts ]; do
  if docker-compose ps | grep -q "healthy"; then
    break
  fi
  echo "   Still waiting... ($attempt/$max_attempts)"
  sleep 2
  attempt=$((attempt + 1))
done

if [ $attempt -eq $max_attempts ]; then
  echo "❌ Services did not become healthy in time"
  echo ""
  echo "Check logs with: docker-compose logs"
  exit 1
fi

echo "✅ All services are healthy"
echo ""

# Display running services
echo "${BLUE}📊 Running services:${NC}"
docker-compose ps
echo ""

# Wait a bit more for backend to be fully ready
echo "⏳ Waiting for backend to initialize..."
sleep 5

# Seed data
echo "${BLUE}🌱 Seeding database with sample books...${NC}"
if [ -f "scripts/seed-data.sh" ]; then
  ./scripts/seed-data.sh
  echo "✅ Data seeding complete"
else
  echo "⚠️  Seed script not found, skipping"
fi
echo ""

# Generate AI embeddings
if [ -z "$SKIP_AI" ]; then
  echo "${BLUE}🤖 Generating AI embeddings...${NC}"
  if [ -f "scripts/generate-embeddings.sh" ]; then
    ./scripts/generate-embeddings.sh
    echo "✅ Embeddings generated"
  else
    echo "⚠️  Embeddings script not found, skipping"
  fi
  echo ""
fi

# Final summary
echo ""
echo "${GREEN}========================================${NC}"
echo "${GREEN}🎉 Setup Complete!${NC}"
echo "${GREEN}========================================${NC}"
echo ""
echo "📱 Application URLs:"
echo "   Frontend:    ${BLUE}http://localhost:3000${NC}"
echo "   Backend API: ${BLUE}http://localhost:8082${NC}"
echo "   AI Service:  ${BLUE}http://localhost:8000${NC}"
echo "   AI Docs:     ${BLUE}http://localhost:8000/docs${NC}"
echo ""
echo "🔐 Test Accounts:"
echo "   Merchant: ${YELLOW}merchant1${NC} / ${YELLOW}password1${NC}"
echo "   Customer: ${YELLOW}customer${NC} / ${YELLOW}password${NC}"
echo ""
echo "💬 AI Chat:"
echo "   1. Open ${BLUE}http://localhost:3000${NC}"
echo "   2. Login as customer"
echo "   3. Click the 💬 button in bottom right"
echo "   4. Try: 'recommend programming books'"
echo ""
echo "🛠️  Useful Commands:"
echo "   View logs:         ${YELLOW}docker-compose logs -f${NC}"
echo "   Stop services:     ${YELLOW}docker-compose down${NC}"
echo "   Restart services:  ${YELLOW}docker-compose restart${NC}"
echo "   Clean restart:     ${YELLOW}docker-compose down -v && ./scripts/setup-complete.sh${NC}"
echo ""
echo "${GREEN}Happy coding! 🚀${NC}"
