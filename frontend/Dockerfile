# Multi-stage build for React frontend
# Stage 1: Build the React application
FROM node:26-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
# If package.json doesn't change, npm install is cached
COPY frontend/package*.json ./

# Install dependencies reproducibly from the lockfile
RUN npm ci

# Copy the rest of the application
COPY frontend/ .

# protoc for code generation; the protoc-gen-es plugin comes from npm
RUN apk add --no-cache protobuf

# Place the schema where the shared `npm run generate` script expects it
# (../backend/proto relative to /app), so codegen is identical here, in CI,
# and locally.
COPY backend/proto /backend/proto
RUN npm run generate

# Build the application
# This creates optimized production files in /app/dist
RUN npm run build

# Stage 2: Serve with nginx
# Nginx is a lightweight, high-performance web server
FROM nginx:alpine

# Copy custom nginx configuration
# This configures nginx to serve our React SPA (Single Page App)
# When building with repo root as context, nginx.conf lives under frontend/
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built files from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 3000 (nginx will listen on this port)
EXPOSE 3000

# Start nginx in foreground
# daemon off prevents nginx from running in background (required for Docker)
CMD ["nginx", "-g", "daemon off;"]
