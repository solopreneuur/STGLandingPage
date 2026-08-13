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
const SEARCH_KEY = "stg_searches";
const BREAKDOWN_KEY = "stg_breakdowns";
const LAST_KEY = "stg_last";

export interface CachedSearch {
  keyword: string;
  results: Reel[];
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

export function saveResults(v: Omit<CachedSearch, "at">): void {
  const map = readMap<CachedSearch>(SEARCH_KEY);
  map[norm(v.keyword)] = { ...v, at: Date.now() };
  writeMap(SEARCH_KEY, map);
  try {
    sessionStorage.setItem(LAST_KEY, norm(v.keyword));
  } catch {}
}

/** Cached search for a keyword — used to answer a repeat search instantly. */
export function getSearch(keyword: string): CachedSearch | null {
  return readMap<CachedSearch>(SEARCH_KEY)[norm(keyword)] ?? null;
}

/** The feed the user was last looking at, for back-navigation. */
export function loadResults(): CachedSearch | null {
  try {
    const last = sessionStorage.getItem(LAST_KEY);
    if (!last) return null;
    return readMap<CachedSearch>(SEARCH_KEY)[last] ?? null;
  } catch {
    return null;
  }
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

export function getBreakdown(shortCode: string): Breakdown | null {
  return readMap<Breakdown>(BREAKDOWN_KEY)[shortCode] ?? null;
}

export function saveBreakdown(shortCode: string, bd: Breakdown): void {
  const map = readMap<Breakdown>(BREAKDOWN_KEY);
  map[shortCode] = bd;
  writeMap(BREAKDOWN_KEY, map);
}
