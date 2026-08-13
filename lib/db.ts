import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client.
 *
 * Uses the SECRET key, which bypasses RLS entirely — it must never reach the
 * browser bundle. Nothing here is imported from a client component; every
 * caller is a route handler or a script.
 *
 * The cache is an optimisation, never a dependency: if the env vars are
 * missing or the project is unreachable, `db()` returns null and every caller
 * falls through to the live pipeline. A cache outage makes the product slow,
 * not broken.
 */
let client: SupabaseClient | null | undefined;

export function db(): SupabaseClient | null {
  if (client !== undefined) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.warn("[db] SUPABASE_URL/SUPABASE_SECRET_KEY unset — cache disabled");
    client = null;
    return null;
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "studythegame" } },
  });
  return client;
}

/**
 * Run a cache operation that must never take down the request.
 *
 * Every read returns `fallback` on failure; every write is fire-and-forget
 * from the caller's perspective. This is the single place that decides the
 * cache degrades rather than throws.
 */
export async function safe<T>(
  label: string,
  op: (c: SupabaseClient) => Promise<T>,
  fallback: T
): Promise<T> {
  const c = db();
  if (!c) return fallback;
  try {
    return await op(c);
  } catch (err) {
    console.error(`[db:${label}]`, err);
    return fallback;
  }
}
