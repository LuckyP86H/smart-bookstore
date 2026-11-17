// Open Library API — the transient, attributed lookup source (plan
// §4.1, §4.6). Open Library data is CC0/public-domain dedications, but
// the data rule still applies to API responses in this codebase:
//
//   * Lookup results inform a DECISION (Path A's fallback candidate)
//     or PREFILL a form (LookupBookByISBN) — they are never written
//     into the reference tables. The reference catalogue grows from
//     dumps at snapshot refreshes (Step 10), not from API dribble.
//   * Covers follow §4.5: the cover URL is LINKED, never stored or
//     proxied (`covers.openlibrary.org/b/isbn/<isbn>-L.jpg`).
//
// Entry points:
//   lookupEditionByISBN — the Path A fallback (§3.1): one identified
//     ISBN lookup when the local index misses. Rate-limited to at most
//     3 requests/second (createOpenLibraryEditionLookup) and memoised
//     per isolate with a TTL, negatives included.
//   lookupOlBookInfo — the prefill source (§4.6): edition + work +
//     author reads assembled into the BookInfo shape. The RAW function
//     is unthrottled and unmemoised (up to 5 sequential requests per
//     call); serving code must call it through
//     createOpenLibraryBookInfoLookup, which applies the same
//     ≤3 req/s + 10-minute memoised policy as the Path A lookup
//     (PR #67 fix round item 2: the public prefill endpoint previously
//     called the raw function directly, so a burst could get the
//     Worker's egress IP rate-limited by OL and break Path A too).

export const OPEN_LIBRARY_USER_AGENT =
  "smart-bookstore-worker/1.0 (Open Library ISBN lookup; " +
  "+https://github.com/LuckyP86H/smart-bookstore)";

const DEFAULT_BASE_URL = "https://openlibrary.org";
const DEFAULT_COVERS_BASE_URL = "https://covers.openlibrary.org";
const FETCH_TIMEOUT_MS = 10_000;

export interface OpenLibraryOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  coversBaseUrl?: string;
  userAgent?: string;
}

export interface OlEditionInfo {
  /** OL edition key, e.g. "/books/OL7356322M" (ref source_key form). */
  editionKey: string;
  /** OL work key, e.g. "/works/OL45883W", when the edition names one. */
  workKey: string | null;
  title: string;
  publisher: string;
  publicationYear: number;
  pageCount: number;
  /** OL language code ("/languages/eng" -> "eng"), "" when unknown. */
  language: string;
}

export interface OlBookInfo {
  title: string;
  author: string;
  publisher: string;
  publicationYear: number;
  pageCount: number;
  description: string;
  coverImageUrl: string;
  categories: string[];
}

interface OlEditionJson {
  key?: string;
  title?: string;
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  languages?: { key?: string }[];
  works?: { key?: string }[];
  authors?: { key?: string }[];
}

interface OlWorkJson {
  subjects?: string[];
  description?: string | { value?: string };
  authors?: { author?: { key?: string } }[];
}

interface OlAuthorJson {
  name?: string;
}

async function fetchOlJson<T>(
  path: string,
  options: OpenLibraryOptions,
): Promise<T | null> {
  const fetchFn = options.fetchFn ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const response = await fetchFn(`${base}${path}`, {
    headers: {
      "User-Agent": options.userAgent ?? OPEN_LIBRARY_USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Open Library request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function yearOf(publishDate: string | undefined): number {
  if (!publishDate) {
    return 0;
  }
  const match = /(\d{4})/.exec(publishDate);
  return match ? Number(match[1]) : 0;
}

function mapEdition(json: OlEditionJson): OlEditionInfo {
  const languageKey = json.languages?.[0]?.key ?? "";
  return {
    editionKey: json.key ?? "",
    workKey: json.works?.[0]?.key ?? null,
    title: json.title ?? "",
    publisher: json.publishers?.[0] ?? "",
    publicationYear: yearOf(json.publish_date),
    pageCount: json.number_of_pages ?? 0,
    language: languageKey.replace("/languages/", ""),
  };
}

/** One ISBN lookup against the OL API. Null = no such edition (404). */
export async function lookupEditionByISBN(
  isbn13: string,
  options: OpenLibraryOptions = {},
): Promise<OlEditionInfo | null> {
  const json = await fetchOlJson<OlEditionJson>(
    `/isbn/${encodeURIComponent(isbn13)}.json`,
    options,
  );
  return json === null ? null : mapEdition(json);
}

/**
 * The prefill read (§4.6): edition JSON, then the work JSON (subjects,
 * description), then up to three author JSONs for display names. The
 * cover URL is constructed, not fetched (§4.5: linked, never stored).
 */
export async function lookupOlBookInfo(
  isbn13: string,
  options: OpenLibraryOptions = {},
): Promise<OlBookInfo | null> {
  const edition = await fetchOlJson<OlEditionJson>(
    `/isbn/${encodeURIComponent(isbn13)}.json`,
    options,
  );
  if (edition === null) {
    return null;
  }
  const mapped = mapEdition(edition);

  let categories: string[] = [];
  let description = "";
  let authorKeys: string[] = (edition.authors ?? [])
    .map((a) => a.key ?? "")
    .filter((k) => k !== "");
  if (mapped.workKey !== null) {
    const work = await fetchOlJson<OlWorkJson>(`${mapped.workKey}.json`, options);
    if (work !== null) {
      categories = work.subjects ?? [];
      description =
        typeof work.description === "string"
          ? work.description
          : (work.description?.value ?? "");
      if (authorKeys.length === 0) {
        authorKeys = (work.authors ?? [])
          .map((a) => a.author?.key ?? "")
          .filter((k) => k !== "");
      }
    }
  }
  const names: string[] = [];
  for (const key of authorKeys.slice(0, 3)) {
    const author = await fetchOlJson<OlAuthorJson>(`${key}.json`, options);
    if (author?.name) {
      names.push(author.name);
    }
  }

  const coversBase = (
    options.coversBaseUrl ?? DEFAULT_COVERS_BASE_URL
  ).replace(/\/$/, "");
  return {
    title: mapped.title,
    author: names.join(", "),
    publisher: mapped.publisher,
    publicationYear: mapped.publicationYear,
    pageCount: mapped.pageCount,
    description,
    coverImageUrl: `${coversBase}/b/isbn/${isbn13}-L.jpg`,
    categories,
  };
}

export interface EditionLookupOptions extends OpenLibraryOptions {
  /** Memoisation TTL per ISBN (default 10 minutes). */
  cacheTtlMs?: number;
  /** Minimum spacing between network calls (default 334ms = ≤3 req/s). */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The prefill lookup (§4.6) under the SAME policy as the Path A
 * fallback above: memoised per isolate for 10 minutes, negatives
 * included, and every underlying HTTP request (a BookInfo lookup makes
 * up to 5: edition + work + up to 3 authors) is serialised through one
 * chain and spaced by at least 334ms from the previous request, so the
 * public prefill path can never exceed ≤3 req/s against Open Library
 * or starve Path A. Errors are not cached (a transient failure may be
 * retried by the next caller); a 404-shaped miss IS cached, as the
 * null result. connect-app.ts holds one shared instance per isolate.
 */
export function createOpenLibraryBookInfoLookup(
  options: EditionLookupOptions = {},
): (isbn13: string) => Promise<OlBookInfo | null> {
  const ttl = options.cacheTtlMs ?? 10 * 60 * 1000;
  const minInterval = options.minIntervalMs ?? 334;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<string, { at: number; value: OlBookInfo | null }>();
  let chain: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;

  const baseFetch = options.fetchFn ?? fetch;
  const throttledFetch: typeof fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const task = chain.then(async () => {
      const wait = Math.max(0, minInterval - (now() - lastCallAt));
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await baseFetch(input, init);
      } finally {
        lastCallAt = now();
      }
    });
    chain = task.catch(() => undefined);
    return task;
  }) as typeof fetch;

  return async (isbn13: string): Promise<OlBookInfo | null> => {
    const hit = cache.get(isbn13);
    if (hit !== undefined && now() - hit.at < ttl) {
      return hit.value;
    }
    const value = await lookupOlBookInfo(isbn13, {
      ...options,
      fetchFn: throttledFetch,
    });
    cache.set(isbn13, { at: now(), value });
    return value;
  };
}

/**
 * The Path A fallback lookup (§3.1): rate-limited to ≤3 requests per
 * second and memoised per isolate, negatives included. Caching choice
 * (build decision D3-13): the cache lives in module memory only —
 * lookup results are decision inputs, not data; nothing is persisted,
 * and a cold isolate simply pays one lookup again. Callers that need a
 * different policy (tests) inject their own lookup function instead.
 */
export function createOpenLibraryEditionLookup(
  options: EditionLookupOptions = {},
): (isbn13: string) => Promise<OlEditionInfo | null> {
  const ttl = options.cacheTtlMs ?? 10 * 60 * 1000;
  const minInterval = options.minIntervalMs ?? 334;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<
    string,
    { at: number; value: OlEditionInfo | null }
  >();
  let chain: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;

  return async (isbn13: string): Promise<OlEditionInfo | null> => {
    const hit = cache.get(isbn13);
    if (hit !== undefined && now() - hit.at < ttl) {
      return hit.value;
    }
    const task = chain.then(async () => {
      // A queued twin may have filled the cache while this waited.
      const again = cache.get(isbn13);
      if (again !== undefined && now() - again.at < ttl) {
        return again.value;
      }
      const wait = Math.max(0, minInterval - (now() - lastCallAt));
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        const value = await lookupEditionByISBN(isbn13, options);
        cache.set(isbn13, { at: now(), value });
        return value;
      } finally {
        lastCallAt = now();
      }
    });
    chain = task.catch(() => undefined);
    return task;
  };
}
