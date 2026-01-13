# Multi-stage build for Go backend
# Stage 1: Build the Go binary
FROM golang:1.25-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git protobuf

# Set working directory
WORKDIR /app

# Ensure Go binaries installed by `go install` are on PATH
ENV PATH="/go/bin:${PATH}"

# Copy go.mod and go.sum first for better layer caching
# Docker caches layers, so if dependencies don't change, this layer is reused
COPY go.mod go.sum ./
RUN go mod download


# Copy the entire source code
COPY . .

# Install protoc-gen plugins and generate protobuf code inside the builder
# This ensures generated code is available during `go build` without relying on
# CI job artifacts or fetching modules from the proxy.
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11 \
	&& go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.19.1

RUN mkdir -p gen \
	&& protoc --proto_path=proto \
		--go_out=gen --go_opt=paths=source_relative \
		--connect-go_out=gen --connect-go_opt=paths=source_relative \
		proto/bookstore.proto proto/ai.proto

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
