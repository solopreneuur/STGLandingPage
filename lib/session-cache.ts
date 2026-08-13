import type { Breakdown, Reel, SearchMeta } from "./types";

/**
 * Client-side caches in sessionStorage.
 *
 * Two jobs:
 *  - Navigating to a breakdown and back must not re-run the search. That
 *    costs ~$0.34 and ~40s for data we already had.
 *  - Re-opening a reel must not re-run its breakdown. Each one is a real
 *    Opus call (~16s), so bouncing in and out of three reels used to cost
 *    three fresh calls per reel visit.
 *
 * sessionStorage is per-tab and cleared on close, which matches data that is
 * already ephemeral by design and keeps the server stateless.
 */
const BUILD = process.env.NEXT_PUBLIC_BUILD || "dev";

/** Cached searches older than this are refetched rather than replayed. */
const SEARCH_TTL_MS = 30 * 60 * 1000;

const SEARCH_KEY = "stg_searches";
const BREAKDOWN_KEY = "stg_breakdowns";
const LAST_KEY = "stg_last";

export interface CachedSearch {
  /** Build that wrote this entry. Mismatch => discard. */
  v?: string;
  keyword: string;
  results: Reel[];
  /** Unjudged remainder, filtered just-in-time on scroll. */
  pool: Reel[];
  /** Dataset ids the JIT filter needs to re-read comments. */
  datasets: string;
  meta: SearchMeta;
  at: number;
}

function readMap<T>(key: string): Record<string, T> {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "{}") as Record<string, T>;
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Quota exceeded (results are large). Drop the oldest and retry once so a
    // full cache degrades instead of throwing.
    const entries = Object.entries(map);
    if (entries.length > 1) {
      const trimmed = Object.fromEntries(entries.slice(-1));
      try {
        sessionStorage.setItem(key, JSON.stringify(trimmed));
      } catch {}
    }
  }
}

const norm = (k: string) => k.trim().toLowerCase();

/* ---------------- searches ---------------- */

export function saveResults(v: Omit<CachedSearch, "at" | "v">): void {
  const map = readMap<CachedSearch>(SEARCH_KEY);
  map[norm(v.keyword)] = { ...v, v: BUILD, at: Date.now() };
  writeMap(SEARCH_KEY, map);
  try {
    sessionStorage.setItem(LAST_KEY, norm(v.keyword));
  } catch {}
}

/**
 * Cached search for a keyword. Rejected if written by a different build or
 * older than the TTL — a stale payload replaying across deploys is what makes
 * a shipped fix look like it never landed.
 */
export function getSearch(keyword: string): CachedSearch | null {
  const hit = readMap<CachedSearch>(SEARCH_KEY)[norm(keyword)];
  if (!hit) return null;
  if (hit.v !== BUILD || Date.now() - (hit.at ?? 0) > SEARCH_TTL_MS) return null;
  return hit;
}

/** The feed the user was last looking at, for back-navigation. */
export function loadResults(): CachedSearch | null {
  try {
    const last = sessionStorage.getItem(LAST_KEY);
    if (!last) return null;
    const hit = readMap<CachedSearch>(SEARCH_KEY)[last];
    if (!hit) return null;
    if (hit.v !== BUILD || Date.now() - (hit.at ?? 0) > SEARCH_TTL_MS) return null;
    return hit;
  } catch {
    return null;
  }
}

/**
 * Kick off a breakdown while the user is watching the reel, so tapping is
 * instant instead of a ~15s wait. Capped per session because each one is a
 * real paid call.
 */
const PREFETCH_CAP = 12;
/**
 * Keyed by short code, holding the PROMISE rather than just a flag.
 *
 * A flag can only make a second caller give up; the promise lets it wait for
 * the answer the first call is already paying for. Dwelling on a reel starts
 * the prefetch at 1.5s, and tapping within the next ~10s used to issue a
 * second concurrent POST — two Opus calls, one reel, one user, on the most
 * ordinary interaction in the product.
 */
const inflightPrefetch = new Map<string, Promise<Breakdown | null>>();
let prefetchCount = 0;

/** The in-flight prefetch for this reel, if one is already paying for it. */
export function pendingBreakdown(shortCode: string): Promise<Breakdown | null> | null {
  return inflightPrefetch.get(shortCode) ?? null;
}

export function prefetchBreakdown(reel: {
  shortCode: string;
  caption: string;
  plays: number;
  score: number;
  ownerUsername: string;
  timestamp: string;
  displayUrl: string;
}): void {
  if (typeof window === "undefined") return;
  if (prefetchCount >= PREFETCH_CAP) return;
  if (inflightPrefetch.has(reel.shortCode)) return;
  if (getBreakdown(reel.shortCode)) return;

  prefetchCount++;
  const p = fetch("/api/breakdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reel),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((bd) => {
      if (bd) saveBreakdown(reel.shortCode, bd as Breakdown);
      return (bd as Breakdown | null) ?? null;
    })
    .catch(() => null)
    .finally(() => inflightPrefetch.delete(reel.shortCode));
  inflightPrefetch.set(reel.shortCode, p);
}

/** Mark a keyword as the most recently viewed feed without rewriting it. */
export function markLastViewed(keyword: string): void {
  try {
    sessionStorage.setItem(LAST_KEY, norm(keyword));
  } catch {}
}

export function findReel(shortCode: string): { reel: Reel; keyword: string } | null {
  const map = readMap<CachedSearch>(SEARCH_KEY);
  for (const c of Object.values(map)) {
    const reel = c.results?.find((r) => r.shortCode === shortCode);
    if (reel) return { reel, keyword: c.keyword };
  }
  return null;
}

/* ---------------- breakdowns ---------------- */

type StoredBreakdown = Breakdown & { v?: string };

export function getBreakdown(shortCode: string): Breakdown | null {
  const hit = readMap<StoredBreakdown>(BREAKDOWN_KEY)[shortCode];
  // The breakdown SHAPE changed between builds (flat strings -> punch/detail).
  // Replaying an old one renders blank sections, so version it too.
  if (!hit || hit.v !== BUILD) return null;
  return hit;
}

export function saveBreakdown(shortCode: string, bd: Breakdown): void {
  const map = readMap<StoredBreakdown>(BREAKDOWN_KEY);
  map[shortCode] = { ...bd, v: BUILD };
  writeMap(BREAKDOWN_KEY, map);
}
