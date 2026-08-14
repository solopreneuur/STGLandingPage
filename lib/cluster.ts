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
/** Simultaneous Apify runs per niche. Above this the account starts refusing. */
const CLUSTER_CONCURRENCY = Number(process.env.CLUSTER_CONCURRENCY ?? 2);

export interface ClusterPull {
  /** Raw items across the whole cluster, deduped by shortCode. */
  items: ApifyItem[];
  /**
   * The term the niche is stored under — ALWAYS the primary.
   *
   * Storing under whichever sibling happened to answer first meant a seed for
   * "beauty" wrote its reels into the "fashion" niche. Siblings are sources;
   * the niche's identity is what was asked for.
   */
  landed: string;
  /** Terms that returned at least one item, in the order they were tried. */
  used: string[];
  /** Per-term counts, for logging. */
  counts: Record<string, number>;
  /** Terms whose run FAILED, as `term(status)`. 4xx means no feed; 429/5xx is transient. */
  failed: string[];
  /** True when at least one failure looks transient and is worth retrying. */
  retryable: boolean;
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

  // Bounded, not wide open. Five simultaneous runs exceeded the account's
  // concurrency and the failures came back looking like empty feeds.
  const results: {
    t: string;
    items: ApifyItem[];
    ok: boolean;
    status?: number;
  }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CLUSTER_CONCURRENCY, terms.length) }, async () => {
      while (next < terms.length) {
        const t = terms[next++];
        try {
          results.push({
            t,
            items: await runSync(t, limit, timeoutMs),
            ok: true,
          });
        } catch (err) {
          // One dead keyword must not cost the niche its siblings — but record
          // that it FAILED, so the caller can tell that apart from no feed.
          const status = (err as { status?: number }).status ?? 0;
          results.push({ t, items: [], ok: false, status });
        }
      }
    })
  );

  const counts: Record<string, number> = {};
  const used: string[] = [];
  const failed: string[] = [];
  let retryable = false;
  let items: ApifyItem[] = [];
  // Keep the caller's term order, not completion order.
  for (const t of terms) {
    const r = results.find((x) => x.t === t);
    if (!r) continue;
    if (!r.ok) {
      const st = r.status ?? 0;
      failed.push(`${t}(${st || "err"})`);
      // 4xx is a settled answer: that keyword has no popular feed. Anything
      // else — 429, 5xx, a timeout — is worth another go.
      if (st === 429 || st === 0 || st >= 500) retryable = true;
      continue;
    }
    counts[t] = r.items.length;
    if (r.items.length === 0) continue;
    used.push(t);
    items = mergeUnique(items, r.items);
  }

  return { items, landed: term, used, counts, failed, retryable };
}
