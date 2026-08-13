import { ApifyItemSchema, type ApifyItem, type Metric } from "./types";

/**
 * PHASE 0 FINDING — this is not the brief's 90.
 *
 * The popular-reels feed is a *greatest-hits* surface, not a recent-content
 * surface. Measured across a real 50-item pull for "home gym":
 *
 *     <=30d:  0     91-180d: 23
 *     31-90d: 0     181-365d: 19      >365d: 8
 *
 * Newest item was 93 days old; median 187 days. Across 12 working feeds the
 * newest item ranged 8-182 days. At 90 days, most niches return ZERO results
 * and the product silently shows an empty page. 365 keeps the meaningful body
 * of each feed while still excluding genuinely stale content.
 */
export const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS ?? 365);

/** If more than this share lack a usable play count, fall back to view count. */
const VIEWS_FALLBACK_THRESHOLD = 0.4;

export interface NormalizeResult {
  items: ApifyItem[];
  metric: Metric;
  pulled: number;
  dropped: number;
}

function plausible(i: unknown): i is ApifyItem {
  return ApifyItemSchema.safeParse(i).success;
}

/**
 * Every predicate is written so that an ABSENT field never drops the item.
 *
 * This matters concretely: the actor's published field list omits
 * `productType` and `paidPartnership`, and a real 50-item pull had
 * `paidPartnership` on only 47/50 and `isPinned` on 7/50. A strict
 * `productType === "clips"` would drop 100% of items the moment that field
 * went missing, producing an empty results page with no error anywhere.
 * The popular feed is reels-only by construction, so the clips check is a
 * cheap safety net, not a load-bearing gate.
 */
export function normalize(raw: unknown[]): NormalizeResult {
  const pulled = raw.length;
  const parsed = raw.filter(plausible);

  const fresh = parsed.filter((i) => {
    if (!i.shortCode) return false;
    if (i.productType != null && i.productType !== "clips") return false;
    if (i.paidPartnership === true) return false;
    const ts = i.timestamp ? Date.parse(i.timestamp) : NaN;
    if (!Number.isFinite(ts)) return false;
    if (Date.now() - ts > MAX_AGE_DAYS * 864e5) return false;
    return true;
  });

  // Decide the metric ACROSS THE WHOLE SET, never per item — mixing plays and
  // views within one set makes the median ratio meaningless.
  const missingPlays = fresh.filter((i) => !(Number(i.videoPlayCount) > 0)).length;
  const metric: Metric =
    fresh.length > 0 && missingPlays / fresh.length > VIEWS_FALLBACK_THRESHOLD
      ? "views"
      : "plays";

  const withMetric = fresh.filter((i) => getPlays(i, metric) > 0);

  // Dedupe by shortCode, keeping the highest-count copy.
  const byCode = new Map<string, ApifyItem>();
  for (const i of withMetric) {
    const prev = byCode.get(i.shortCode);
    if (!prev || getPlays(i, metric) > getPlays(prev, metric)) {
      byCode.set(i.shortCode, i);
    }
  }

  const items = [...byCode.values()];
  return { items, metric, pulled, dropped: pulled - items.length };
}

export function getPlays(i: ApifyItem, metric: Metric): number {
  const n = metric === "plays" ? i.videoPlayCount : i.videoViewCount;
  return Number(n) > 0 ? Number(n) : 0;
}

/** Merge two pulls (original + widened keyword) before scoring. */
export function mergeUnique(a: ApifyItem[], b: ApifyItem[]): ApifyItem[] {
  const seen = new Set(a.map((i) => i.shortCode));
  return [...a, ...b.filter((i) => !seen.has(i.shortCode))];
}
