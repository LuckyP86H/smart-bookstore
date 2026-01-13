# Multi-stage build for React frontend
# Stage 1: Build the React application
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
# If package.json doesn't change, npm install is cached
COPY frontend/package*.json ./

# Install dependencies
# Use `npm install` because `package-lock.json` may be absent in the build context
RUN npm install

# Copy the rest of the application
COPY frontend/ .

# Install protoc (protobuf compiler) so we can generate TypeScript clients
# and copy backend proto files into the build context (CI uses repo root)
RUN apk add --no-cache protobuf

# Copy backend proto files into the image so protoc can access them
# when the build context is the repository root (CI will use that).
COPY backend/proto ./proto

# Generate protobuf TypeScript client code into src/gen using the installed
# protoc compiler and the npm-installed protoc plugins.
RUN mkdir -p src/gen \
	&& protoc \
		--proto_path=proto \
		--plugin=protoc-gen-es=./node_modules/.bin/protoc-gen-es \
		--plugin=protoc-gen-connect-es=./node_modules/.bin/protoc-gen-connect-es \
		--es_out=src/gen --es_opt=target=ts \
		--connect-es_out=src/gen --connect-es_opt=target=ts \
		proto/bookstore.proto proto/ai.proto

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
