// ConnectRPC client setup for communicating with the backend
// ConnectRPC is a modern, type-safe alternative to gRPC-Web that works natively in browsers

import { createPromiseClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { MerchantService } from "../gen/bookstore_connect";
import { CustomerService } from "../gen/bookstore_connect";

// Backend API URL - reads from environment variable or defaults to localhost
const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8082";

/**
 * Creates a ConnectRPC transport with optional authentication
 * Transport handles the HTTP communication between frontend and backend
 * 
 * @param username - Optional username for HTTP Basic Auth
 * @param password - Optional password for HTTP Basic Auth
 * @returns ConnectTransport configured for our backend
 */
function createTransport(username?: string, password?: string) {
  // Interceptor adds authentication headers to every request
  // Similar to middleware in Express - runs before each RPC call
  const interceptor = username && password ? (next: any) => async (req: any) => {
    // Add HTTP Basic Auth header: "Authorization: Basic base64(username:password)"
    req.header.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
    return next(req);
  } : undefined;
  
  return createConnectTransport({
    baseUrl,
    interceptors: interceptor ? [interceptor] : [],
  });
}

/**
 * Creates a type-safe client for Merchant service operations
 * Use this for merchant-specific operations (add books, manage inventory, view sales)
 * 
 * @param username - Merchant username (e.g., "merchant1")
 * @param password - Merchant password
 * @returns Promise-based client with full type safety from Protocol Buffers
 */
export function createMerchantClient(username: string, password: string) {
  const transport = createTransport(username, password);
  // createPromiseClient generates a client with methods matching our .proto service definition
  // All methods return Promises and have TypeScript types auto-generated
  return createPromiseClient(MerchantService, transport);
}

/**
 * Creates a type-safe client for Customer service operations  
 * Use this for customer-specific operations (browse books, purchase, add reviews)
 * 
 * @param username - Customer username (e.g., "customer")
 * @param password - Customer password
 * @returns Promise-based client with full type safety from Protocol Buffers
 */
export function createCustomerClient(username: string, password: string) {
  const transport = createTransport(username, password);
  return createPromiseClient(CustomerService, transport);
}

/**
 * Creates a public client for unauthenticated operations
 * Currently used for ISBN lookup which doesn't require authentication
 *
 * @returns Promise-based merchant client without authentication
 */
export function createPublicMerchantClient() {
  const transport = createTransport();
  return createPromiseClient(MerchantService, transport);
}

/**
 * Detects if a username is a merchant account
 * Merchant usernames start with "merchant"
 *
 * @param username - The username to check
 * @returns true if the user is a merchant, false if customer
 */
export function isMerchantUser(username: string): boolean {
  return username.toLowerCase().startsWith('merchant');
}
