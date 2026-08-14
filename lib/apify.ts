import type { ApifyItem } from "./types";

const TOKEN = process.env.APIFY_TOKEN!;
const ACTOR = process.env.APIFY_ACTOR_ID || "apify~instagram-search-scraper";
const BASE = "https://api.apify.com/v2";

/**
 * Per-run size for the live path. Max 250 per keyword (Instagram's own ceiling).
 *
 * Measured, not interpolated: 12 items lands at 18.3s, 50 items at 28.1s.
 * About 15s of every run is fixed container startup and the rest is ~0.26s per
 * item, so a small first run is worth a real 10s and the remainder is fetched
 * with a top-up only if the user actually scrolls that deep.
 */
export const SEARCH_LIMIT = Number(process.env.SEARCH_LIMIT ?? 12);

/**
 * Background pull size, for the seed script and weekly cron.
 *
 * Deliberately much larger than SEARCH_LIMIT: the live limit is small because
 * a user is watching a spinner, but nobody waits on a background job. Sharing
 * one constant would make every cached niche permanently thin to save time no
 * user ever experiences.
 */
export const SEED_LIMIT = Number(process.env.SEED_LIMIT ?? 50);

/**
 * The parallel "fast paint" run is gone.
 *
 * It existed because the main run was 50 (28s) and a 12-item run landed at
 * 18s. With the main run now 25 (~21s) the gap is only ~3s, which does not
 * justify a second billed run or the provisional-multiplier machinery.
 *
 * Note the actor has no cursor: a second run RE-SAMPLES rather than paginates,
 * and the two runs measurably returned different items. That is why top-ups
 * add genuinely new reels instead of repeating page 1.
 */

/**
 * Sync run, used for scroll-triggered top-ups and every background job.
 *
 * The timeout has to be the caller's choice, not a constant. 55s is right for
 * a live top-up where someone is waiting, but a 50-item background pull can
 * exceed it — multi-word searches are slower than the 28.1s measured for a
 * single word, and the seed aborted "content creation" at exactly 55s.
 */
export async function runSync(
  search: string,
  limit = SEARCH_LIMIT,
  timeoutMs = 55_000
): Promise<ApifyItem[]> {
  const res = await fetch(
    `${BASE}/acts/${ACTOR}/run-sync-get-dataset-items?token=${TOKEN}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildInput(search, limit)),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  // Throw rather than return []. A rate-limited or failed run is NOT an empty
  // feed, and collapsing the two made four niches report "NO FEED" for
  // keywords that demonstrably have one — "cooking" returned nothing in its
  // own cluster and 50 items in another minutes later.
  if (!res.ok) {
    // The status is the only signal separating the two failure modes, and they
    // want opposite responses. 429/5xx is us hitting concurrency and is worth
    // retrying; 4xx is Instagram having no popular feed for the keyword at all
    // — which the actor reports as a FAILED run, not an empty dataset.
    const err = new Error(`apify ${res.status} for "${search}"`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

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
  // Stays lenient: the live poll path treats a missing dataset as "nothing
  // yet" and has its own retry/deadline handling around it.
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
