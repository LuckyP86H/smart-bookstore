// Port of backend/external/google_books.go: a plain fetch against the
// Google Books volumes endpoint. The API key, when configured, travels in
// the X-goog-api-key header — never in the URL, because URLs end up in
// error messages, proxy logs and traces.

const GOOGLE_BOOKS_BASE_URL = "https://www.googleapis.com/books/v1/volumes";
const REQUEST_TIMEOUT_MS = 10_000;

/** Google Books has no volume for the ISBN. */
export class BookNotFoundError extends Error {
  constructor() {
    super("no book found for this ISBN");
    this.name = "BookNotFoundError";
  }
}

export interface BookInfo {
  title: string;
  author: string;
  publisher: string;
  publicationYear: number;
  pageCount: number;
  description: string;
  coverImageUrl: string;
  categories: string[];
}

export interface GoogleBooksOptions {
  /** Optional API key (GOOGLE_BOOKS_API_KEY); absent means the keyless path. */
  apiKey?: string;
  /** Override the volumes endpoint (tests). */
  baseUrl?: string;
  /** Override the fetch implementation (tests). */
  fetchFn?: typeof fetch;
}

interface GoogleBooksVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  categories?: string[];
  imageLinks?: { thumbnail?: string };
}

/** Fetches volume metadata for a normalized ISBN (see normalizeISBN). */
export async function lookupBookByISBN(
  isbn: string,
  options: GoogleBooksOptions = {},
): Promise<BookInfo> {
  const baseUrl = options.baseUrl ?? GOOGLE_BOOKS_BASE_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const params = new URLSearchParams({ q: `isbn:${isbn}` });

  const headers = new Headers();
  if (options.apiKey) {
    headers.set("X-goog-api-key", options.apiKey);
  }

  let resp: Response;
  try {
    resp = await fetchFn(`${baseUrl}?${params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch errors can quote the request URL; callers only need the cause.
    throw new Error(
      `Google Books request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (resp.status !== 200) {
    throw new Error(`Google Books API returned status ${resp.status}`);
  }

  let result: { items?: { volumeInfo?: GoogleBooksVolumeInfo }[] };
  try {
    result = (await resp.json()) as typeof result;
  } catch {
    throw new Error("failed to decode response");
  }

  if (!result.items || result.items.length === 0) {
    throw new BookNotFoundError();
  }

  const volumeInfo = result.items[0].volumeInfo ?? {};

  // The Go client joins every author: first author, then ", " + the rest.
  const author = (volumeInfo.authors ?? []).join(", ");

  // Year comes from the first four characters of publishedDate
  // ("YYYY", "YYYY-MM" or "YYYY-MM-DD"); anything else stays 0.
  let publicationYear = 0;
  if (volumeInfo.publishedDate && volumeInfo.publishedDate.length >= 4) {
    const match = /^\d+/.exec(volumeInfo.publishedDate.slice(0, 4));
    if (match) publicationYear = Number.parseInt(match[0], 10) || 0;
  }

  return {
    title: volumeInfo.title ?? "",
    author,
    publisher: volumeInfo.publisher ?? "",
    publicationYear,
    pageCount: volumeInfo.pageCount ?? 0,
    description: volumeInfo.description ?? "",
    coverImageUrl: volumeInfo.imageLinks?.thumbnail ?? "",
    categories: volumeInfo.categories ?? [],
  };
}
