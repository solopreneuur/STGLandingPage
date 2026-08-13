import type { ApifyItem } from "./types";

const TOKEN = process.env.APIFY_TOKEN!;
const ACTOR = process.env.APIFY_ACTOR_ID || "apify~instagram-search-scraper";
const BASE = "https://api.apify.com/v2";

/** Max 250 per keyword (Instagram's own ceiling). Verified in Phase 0. */
export const SEARCH_LIMIT = Number(process.env.SEARCH_LIMIT ?? 50);

/**
 * Size of the fast first run, fired in parallel with the full one.
 *
 * Measured: searchLimit 12 -> 18.3s, searchLimit 50 -> 28.1s. Roughly 15s of
 * that is fixed container startup, so the marginal cost is ~0.25s per item
 * and splitting further buys nothing — you re-pay the 15s floor every time.
 *
 * The runs are NOT stably ordered (they returned different top items), so the
 * fast run is a separate sample rather than a prefix. That is why its results
 * are merged rather than treated as page 1, and why the multiplier waits for
 * the full set: a median over 12 popularity-skewed reels is badly wrong.
 */
export const FAST_LIMIT = Number(process.env.FAST_LIMIT ?? 12);

/**
 * The actor's input contract, verified against the live build's input schema.
 *  - `search` is the keyword field (NOT `keyword`/`query`)
 *  - `searchLimit` is the cap (NOT `resultsLimit` — that key does not exist
 *    and would be silently ignored)
 *  - `searchType` DEFAULTS TO "place"; omitting it returns places, not reels
 *  - `liveSearch: true` returns a different dataset shape — keep it false
 */
export function buildInput(search: string, limit = SEARCH_LIMIT) {
  return {
    search,
    searchType: "popular" as const,
    searchLimit: limit,
    liveSearch: false,
    enhanceUserSearchWithFacebookPage: false,
  };
}

export interface StartedRun {
  runId: string;
  datasetId: string;
}

export async function startRun(search: string, limit = SEARCH_LIMIT): Promise<StartedRun> {
  const res = await fetch(`${BASE}/acts/${ACTOR}/runs?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildInput(search, limit)),
  });
  if (!res.ok) {
    throw new Error(`apify_start_failed: ${res.status} ${await res.text()}`);
  }
  const { data } = await res.json();
  return { runId: data.id, datasetId: data.defaultDatasetId };
}

export type RunPhase = "running" | "succeeded" | "no_feed" | "failed";

export interface RunStatus {
  phase: RunPhase;
  itemCount: number;
  statusMessage?: string;
}

/**
 * CRITICAL: when a keyword has no popular feed, the actor does NOT return an
 * empty dataset — it exits code 1 with status FAILED. Its statusMessage says
 * "blocked by Instagram", which is misleading; the run log actually reads
 * "NO RESULTS: zero public details for https://www.instagram.com/popular/<slug>".
 *
 * So a FAILED run is the *normal* no-feed signal and must be surfaced as
 * `no_feed` (→ widen the keyword), never as a hard error. Treating it as an
 * error would show a stranger a broken page for a perfectly valid niche.
 */
function classify(status: string, statusMessage: string | undefined, itemCount: number): RunPhase {
  if (status === "RUNNING" || status === "READY") return "running";
  if (status === "SUCCEEDED") return itemCount > 0 ? "succeeded" : "no_feed";
  if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
    // Partial data can exist even on a failed run — take what we got.
    if (itemCount > 0) return "succeeded";
    const msg = (statusMessage ?? "").toLowerCase();
    if (msg.includes("failed to find any results") || msg.includes("blocked by instagram")) {
      return "no_feed";
    }
    return "failed";
  }
  return "running";
}

export async function getRunStatus(runId: string, datasetId: string): Promise<RunStatus> {
  const [runRes, countRes] = await Promise.all([
    fetch(`${BASE}/actor-runs/${runId}?token=${TOKEN}`),
    fetch(`${BASE}/datasets/${datasetId}?token=${TOKEN}`),
  ]);
  const run = runRes.ok ? (await runRes.json()).data : null;
  const ds = countRes.ok ? (await countRes.json()).data : null;
  const itemCount = Number(ds?.itemCount ?? 0);
  return {
    phase: classify(run?.status ?? "RUNNING", run?.statusMessage, itemCount),
    itemCount,
    statusMessage: run?.statusMessage,
  };
}

export async function getDatasetItems(datasetId: string): Promise<ApifyItem[]> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/items?token=${TOKEN}&clean=true`);
  if (!res.ok) return [];
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

/**
 * Derive one close variant for widening. Deterministic string transform — no
 * LLM call, no extra latency budget. The popular feed is slug-based
 * (instagram.com/popular/<slug>), and long multi-word slugs rarely exist, so
 * shortening toward the head noun is the highest-yield move.
 */
export function widenKeyword(keyword: string): string | null {
  const words = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Multi-word: drop to the head noun ("home gym" -> "gym"). Cheap and
  // genuinely effective, since long slugs rarely have a popular feed.
  if (words.length > 1) return words[words.length - 1];

  // Single word: there is no safe string transform. Naive singularization
  // turned "fitness" into "fitnes", which cannot have a feed and wastes an
  // attempt. Return null and let the semantic model call handle it — that is
  // exactly the case it exists for.
  return null;
}
