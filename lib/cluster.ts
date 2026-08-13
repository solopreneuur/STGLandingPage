import { runSync } from "./apify";
import { mergeUnique } from "./normalize";
import { suggestVariants } from "./variants";
import type { ApifyItem } from "./types";

/**
 * Terms pulled per niche, including the primary.
 *
 * Instagram's popular feed is roughly 50 deep per keyword and that is a hard
 * ceiling — measured, searchLimit=50 and searchLimit=120 both return the same
 * 48 items. So depth cannot come from asking for more; it can only come from
 * asking more questions. Five sibling terms take a niche from ~48 raw items to
 * ~200 before dedup, which is the difference between a feed you can draw a
 * conclusion from and one you cannot.
 */
export const CLUSTER_SIZE = Number(process.env.CLUSTER_SIZE ?? 5);

export interface ClusterPull {
  /** Raw items across the whole cluster, deduped by shortCode. */
  items: ApifyItem[];
  /**
   * The term the niche should be stored under: the primary when it has a feed,
   * otherwise the first sibling that actually returned data.
   */
  landed: string;
  /** Terms that returned at least one item, in the order they were tried. */
  used: string[];
  /** Per-term counts, for logging. */
  counts: Record<string, number>;
}

/**
 * Pull a whole keyword cluster for one niche.
 *
 * Runs concurrently: the queries are independent, each costs ~30s of mostly
 * fixed container startup, and nothing is waiting on the result but a
 * background job. Serially this would be two and a half minutes per niche.
 *
 * Overlap between siblings is expected and wanted — it is evidence a reel is
 * central to the niche rather than incidental to one phrasing. mergeUnique
 * keeps the first occurrence, and the reels table's (niche_id, short_code)
 * constraint is the backstop.
 */
export async function pullCluster(
  term: string,
  limit: number,
  timeoutMs: number
): Promise<ClusterPull> {
  const siblings = await suggestVariants(term, [term]);
  const terms = [term, ...siblings].slice(0, CLUSTER_SIZE);

  const results = await Promise.all(
    terms.map(async (t) => {
      try {
        return { t, items: await runSync(t, limit, timeoutMs) };
      } catch {
        // One dead keyword must not cost the niche its other four.
        return { t, items: [] as ApifyItem[] };
      }
    })
  );

  const counts: Record<string, number> = {};
  const used: string[] = [];
  let items: ApifyItem[] = [];
  for (const r of results) {
    counts[r.t] = r.items.length;
    if (r.items.length === 0) continue;
    used.push(r.t);
    items = mergeUnique(items, r.items);
  }

  return { items, landed: used[0] ?? term, used, counts };
}
