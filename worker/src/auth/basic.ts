// Port of backend/interceptors/auth.go: Basic auth on every RPC except the
// public procedures, with the one role gate — customers may not call
// MerchantService (merchants may call all of CustomerService).
//
// Error shapes mirror the Go interceptor exactly: authentication failures
// are CodeUnauthenticated with an empty message, the role gate is
// CodePermissionDenied with an empty message, and a credential-checker
// failure is CodeInternal carrying the underlying error's message.

import {
  Code,
  ConnectError,
  createContextKey,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";

/** The identity an established credential resolves to. */
export interface AuthIdentity {
  storeId: bigint;
  isCustomer: boolean;
  username: string;
}

/**
 * Resolves a username/password pair to an identity, or null when the pair
 * does not authenticate. Implementations must make "unknown user" and
 * "wrong password" indistinguishable to the caller, and must run exactly
 * one password verification per call (PBKDF2-DESIGN.md §7). Production
 * uses the PBKDF2 checker in store-checker.ts; test-double.ts holds the
 * fixture double the routing tests use.
 */
export interface CredentialChecker {
  authenticate(username: string, password: string): Promise<AuthIdentity | null>;
}

/** Procedures that skip authentication entirely (mirrors Go's publicProcedures). */
const PUBLIC_PROCEDURES: ReadonlySet<string> = new Set([
  "/grpc.health.v1.Health/Check",
  "/bookstore.v1.MerchantService/LookupBookByISBN",
]);

/** The authenticated identity for the current call, set by the interceptor. */
export const authIdentityContextKey = createContextKey<AuthIdentity | null>(null);

/**
 * The identity the interceptor established for this call. Mirrors the Go
 * services' own belt-and-braces check: a missing identity surfaces as
 * CodeUnauthenticated with the message "unauthorized".
 */
export function requireIdentity(ctx: HandlerContext): AuthIdentity {
  const identity = ctx.values.get(authIdentityContextKey);
  if (identity === null) {
    throw new ConnectError("unauthorized", Code.Unauthenticated);
  }
  return identity;
}

/**
 * Parses an Authorization header value the way Go's parseBasicAuth does:
 * a case-sensitive "Basic " prefix, standard base64, and a split on the
 * first ":" (passwords may contain colons). Returns null on any failure.
 */
export function parseBasicAuth(
  authHeader: string | null,
): { username: string; password: string } | null {
  const prefix = "Basic ";
  if (authHeader === null || !authHeader.startsWith(prefix)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = atob(authHeader.slice(prefix.length));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) {
    return null;
  }
  return {
    username: decoded.slice(0, sep),
    password: decoded.slice(sep + 1),
  };
}

export function createAuthInterceptor(checker: CredentialChecker): Interceptor {
  return (next) =>
    async (req) => {
      const procedure = `/${req.service.typeName}/${req.method.name}`;
      if (PUBLIC_PROCEDURES.has(procedure)) {
        return next(req);
      }

      const credentials = parseBasicAuth(req.header.get("authorization"));
      if (credentials === null) {
        throw new ConnectError("", Code.Unauthenticated);
      }

      let identity: AuthIdentity | null;
      try {
        identity = await checker.authenticate(
          credentials.username,
          credentials.password,
        );
      } catch (err) {
        throw new ConnectError(
          err instanceof Error ? err.message : String(err),
          Code.Internal,
        );
      }
      if (identity === null) {
        throw new ConnectError("", Code.Unauthenticated);
      }

      // Customers cannot access MerchantService.
      if (procedure.includes("MerchantService") && identity.isCustomer) {
        throw new ConnectError("", Code.PermissionDenied);
      }

      req.contextValues.set(authIdentityContextKey, identity);
      return next(req);
    };
}
