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
  /** Billed Apify top-ups already spent on this niche, across mounts. */
  topups?: number;
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

/**
 * Merge scroll-appended reels back into the cached search.
 *
 * Deliberately does NOT re-stamp `at`: the TTL runs from the moment of the
 * search, and refreshing it on every append would let a feed outlive the
 * window the rest of the app assumes.
 *
 * `topups` rides along because the budget has to survive the Feed remount that
 * happens on every trip into a reel — otherwise each visit hands the user two
 * fresh billed Apify runs.
 */
export function appendResults(
  keyword: string,
  extra: Reel[],
  topups: number
): void {
  const map = readMap<CachedSearch>(SEARCH_KEY);
  const hit = map[norm(keyword)];
  if (!hit) return;
  const seen = new Set(hit.results.map((r) => r.shortCode));
  hit.results = [...hit.results, ...extra.filter((r) => !seen.has(r.shortCode))];
  hit.topups = Math.max(hit.topups ?? 0, topups);
  writeMap(SEARCH_KEY, map);
}

/** Top-ups already billed for this niche in this tab. */
export function getTopups(keyword: string): number {
  return getSearch(keyword)?.topups ?? 0;
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

/**
 * Which slide the user was on, per niche.
 *
 * Feed remounts when they come back from a reel — App Router does not preserve
 * component state across that navigation — so without this they land back at
 * slide 1 and have to scroll to where they were.
 */
const ACTIVE_KEY = "stg_active";

export function saveActiveIndex(keyword: string, index: number): void {
  if (typeof window === "undefined" || !keyword) return;
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[keyword] = index;
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(map));
  } catch {
    // Storage full or blocked; losing the position is not worth an error.
  }
}

export function getActiveIndex(keyword: string): number {
  if (typeof window === "undefined" || !keyword) return 0;
  try {
    const raw = sessionStorage.getItem(ACTIVE_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    const i = map[keyword];
    return Number.isFinite(i) && i > 0 ? i : 0;
  } catch {
    return 0;
  }
}

/**
 * Sound preference, remembered for the tab.
 *
 * Kept out of component state so it survives the Feed remount that happens on
 * feed -> reel -> back; otherwise every trip into a breakdown silently muted
 * the feed again.
 */
const SOUND_KEY = "stg_sound";

export function getSoundOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSoundOn(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    // Not worth an error; the feed just starts muted next time.
  }
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
