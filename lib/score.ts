import type { ApifyItem, Metric, Reel, FilterVerdict } from "./types";
import { getPlays } from "./normalize";

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Borderline verdicts sort to the bottom rather than being dropped. */
export const BORDERLINE = 0.6;

/**
 * score = plays / median(plays of the set)
 *
 * Deliberately crude for v1: no follower normalization. The median is
 * computed over the SAME set that gets rendered, so a "7.3x" always means
 * "7.3x the median of what you're looking at".
 */
export function scoreAndSort(
  items: ApifyItem[],
  metric: Metric,
  verdicts: Map<string, FilterVerdict>
): { results: Reel[]; medianPlays: number } {
  const plays = items.map((i) => getPlays(i, metric));
  const med = median(plays);

  const results: Reel[] = items.map((i) => {
    const p = getPlays(i, metric);
    const v = verdicts.get(i.shortCode);
    return {
      shortCode: i.shortCode,
      url: i.url ?? `https://www.instagram.com/reel/${i.shortCode}/`,
      caption: i.caption ?? "",
      displayUrl: i.displayUrl ?? "",
      ownerUsername: i.ownerUsername ?? "",
      ownerFullName: i.ownerFullName ?? "",
      timestamp: i.timestamp ?? "",
      plays: p,
      score: med > 0 ? p / med : 0,
      // Absent verdict => treat as borderline-keep, never as a drop.
      confidence: v?.confidence ?? 0.5,
      filterReason: v?.reason,
    };
  });

  results.sort((a, b) => {
    const aBorder = a.confidence < BORDERLINE;
    const bBorder = b.confidence < BORDERLINE;
    if (aBorder !== bBorder) return aBorder ? 1 : -1; // borderlines to the bottom
    return b.score - a.score;
  });

  return { results, medianPlays: med };
}

/**
 * "7.3×" — Archivo Black in the UI.
 *
 * Guards the sub-0.1 case: a 50K-play reel against a 1.0M median is 0.048,
 * which toFixed(1) renders as "0.0×" and reads as broken rather than as
 * "well below median". Floor the display instead.
 */
export function formatMultiplier(score: number): string {
  if (!Number.isFinite(score) || score <= 0) return "—";
  if (score >= 10) return `${Math.round(score)}×`;
  if (score < 0.1) return "<0.1×";
  return `${score.toFixed(1)}×`;
}

export function formatPlays(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
