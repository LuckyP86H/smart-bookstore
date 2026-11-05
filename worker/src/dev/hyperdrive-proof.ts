// DEV-ONLY proof route (Route B, phase P0).
//
// GET /api/dev/hyperdrive-proof
//
// Proves the Worker can reach the real Supabase database through the
// Hyperdrive binding (env.HYPERDRIVE) by running three read-only queries:
//   1. SELECT 1                                  — basic connectivity/auth
//   2. SELECT count(*) FROM books                — a real table read
//   3. One HNSW nearest-neighbour lookup         — pgvector through the pooler,
//      using an existing row's stored embedding as the query vector
//      (the row itself is excluded from its own results).
//
// This route is unauthenticated and exists only to verify the wiring.
// It MUST be removed or gated (e.g. behind a secret + an enabled flag)
// before any production deploy; the Route B plan's P5/P6 cleanup owns that.

import postgres from "postgres";

export interface HyperdriveProofEnv {
  HYPERDRIVE: Hyperdrive;
}

interface NearestRow {
  id: number;
  title: string;
  distance: number;
}

export async function hyperdriveProof(env: HyperdriveProofEnv): Promise<Response> {
  const started = Date.now();
  // Hyperdrive pools connections on its side, so a fresh client per request
  // is the documented pattern; max: 5 is the Hyperdrive example's setting.
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
  });

  try {
    const [select1] = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM books
    `;

    // Take one stored embedding as the query vector, then find its nearest
    // neighbours through the HNSW index (idx_books_embedding). The operator
    // is schema-qualified because pgvector lives in the `extensions` schema
    // on Supabase and the session's search_path is not guaranteed to find it.
    const [source] = await sql<{ id: number; title: string }[]>`
      SELECT id, title FROM books
      WHERE embedding IS NOT NULL
      ORDER BY id
      LIMIT 1
    `;

    let nearest: NearestRow[] = [];
    if (source) {
      nearest = await sql<NearestRow[]>`
        SELECT b.id, b.title,
               (b.embedding OPERATOR(extensions.<=>) q.embedding) AS distance
        FROM books AS b
        CROSS JOIN (SELECT embedding FROM books WHERE id = ${source.id}) AS q
        WHERE b.embedding IS NOT NULL AND b.id <> ${source.id}
        ORDER BY b.embedding OPERATOR(extensions.<=>) q.embedding
        LIMIT 5
      `;
    }

    return Response.json({
      select1: select1?.ok ?? null,
      books_count: count?.count ?? null,
      hnsw_nearest_neighbours: {
        query_book: source ?? null,
        results: nearest,
      },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - started,
      },
      { status: 500 },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
