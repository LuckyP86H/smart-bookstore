# Multi-stage build for Go backend
# Stage 1: Build the Go binary
FROM golang:1.25-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git protobuf

# Set working directory
WORKDIR /app

# Copy go.mod and go.sum first for better layer caching
# Docker caches layers, so if dependencies don't change, this layer is reused
COPY go.mod go.sum ./
RUN go mod download

# Copy the entire source code
COPY . .

# Ensure module graph is complete (helps when generated code lives in the repo)
RUN go mod tidy

# Build the binary
# CGO_ENABLED=0 creates a static binary that doesn't depend on C libraries
# This makes it portable across different Linux distributions
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o bookstore-server .

# Stage 2: Create minimal runtime image
# Alpine is a tiny Linux distribution (~5MB base image)
FROM alpine:latest

# Install ca-certificates for HTTPS requests (needed for Google Books API)
# Also install wget for Docker health checks
RUN apk --no-cache add ca-certificates wget

# Create non-root user for security
# Running as root is a security risk if container is compromised
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only the binary from builder stage (not source code)
COPY --from=builder /app/bookstore-server .

# Change ownership to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the port the app runs on
EXPOSE 8082

# Command to run the application
CMD ["./bookstore-server"]
