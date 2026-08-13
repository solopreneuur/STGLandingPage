import fs from "node:fs";
import path from "node:path";
import type { ApifyItem, Breakdown, FilterVerdict } from "./types";

/**
 * Offline mode. With USE_FIXTURES=1 the whole pipeline runs against real
 * captured data, so Phases 2-3 are fully workable with no network.
 *
 * NEVER set this in Vercel — production would silently serve stale fixtures
 * instead of live results. The env-push script explicitly excludes it.
 */
export const USE_FIXTURES = process.env.USE_FIXTURES === "1";

const DIR = path.join(process.cwd(), "lib", "fixtures");

function read<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Niches we captured. Anything else falls back to home-gym so any keyword works offline. */
const NICHE_FILES: Record<string, string> = {
  "home gym": "apify-raw-home-gym.json",
  gym: "apify-raw-home-gym.json",
  tech: "apify-raw-tech.json",
  cooking: "apify-raw-cooking.json",
};

export function fixtureItems(keyword: string): ApifyItem[] {
  const key = keyword.trim().toLowerCase();
  const file = NICHE_FILES[key] ?? "apify-raw-home-gym.json";
  return read<ApifyItem[]>(file, []);
}

/** Simulates the no-feed case offline so the widening path is testable. */
export function fixtureHasFeed(keyword: string): boolean {
  const key = keyword.trim().toLowerCase();
  // Mirrors what the real probe found: these genuinely have no popular feed.
  const NO_FEED = new Set(["fitness", "iphone", "skincare", "photography"]);
  return !NO_FEED.has(key);
}

export function fixtureVerdicts(): Map<string, FilterVerdict> {
  const data = read<{ verdicts: FilterVerdict[] }>("filter-response.json", { verdicts: [] });
  return new Map(data.verdicts.map((v) => [v.shortCode, v]));
}

export function fixtureBreakdown(): Breakdown {
  const empty = { punch: "(fixture unavailable)", detail: "" };
  return read<Breakdown>("breakdown.json", {
    hook_read: empty,
    mechanism: empty,
    format: empty,
    steal_this: "(fixture unavailable)",
    image_used: false,
  });
}
