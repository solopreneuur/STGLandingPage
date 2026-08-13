import type { Reel, SearchMeta } from "./types";

/**
 * Results live in React state, but the breakdown lives on its own route, so
 * navigating there would lose them. sessionStorage carries them across the
 * navigation and a refresh, without adding a server-side store (which would
 * mean the database we deliberately cut).
 *
 * Scoped to the tab and cleared by the browser on close — appropriate for
 * data that is already ephemeral by design.
 */
const KEY = "stg_results";

export interface CachedSearch {
  keyword: string;
  results: Reel[];
  meta: SearchMeta;
  at: number;
}

export function saveResults(v: Omit<CachedSearch, "at">): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...v, at: Date.now() }));
  } catch {
    // Quota or private mode — the detail page falls back to a "search again"
    // prompt rather than breaking.
  }
}

export function loadResults(): CachedSearch | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedSearch;
  } catch {
    return null;
  }
}

export function findReel(shortCode: string): { reel: Reel; keyword: string } | null {
  const c = loadResults();
  const reel = c?.results.find((r) => r.shortCode === shortCode);
  return reel && c ? { reel, keyword: c.keyword } : null;
}
