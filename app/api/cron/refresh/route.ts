import { NextResponse } from "next/server";
import { runSync, SEED_LIMIT } from "@/lib/apify";
import { normalize } from "@/lib/normalize";
import { filterAudience, applyVerdicts } from "@/lib/filter";
import { scoreAndSort } from "@/lib/score";
import { refreshTargets, upsertNiche, writeReels } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 300;

/** The ceiling is 300s; stop starting new niches with room to finish the open ones. */
const DEADLINE_MS = 240_000;
/** Most niches anyone would notice going stale. */
const MAX_NICHES = 20;
/**
 * Sequential was never an option: 20 niches x ~25s is ~500s against a 300s
 * ceiling, so it would silently time out partway every week.
 *
 * Fully parallel is the other trap — 20 concurrent filter calls each fan out
 * into their own chunked Sonnet requests, which is a 429 waiting to happen.
 * Eight at a time clears 20 niches in about three waves, well inside budget.
 */
const CONCURRENCY = 8;

async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

/**
 * Weekly re-pull of every cached niche.
 *
 * Reels only. Breakdowns live in their own reel-keyed table, so a refresh
 * cannot orphan or discard one — every returning reel stays instant and only
 * genuinely new reels ever cost an Opus call.
 *
 * Because the actor re-samples rather than paginates, each week's pull adds
 * new reels alongside the survivors, so cached niches deepen over time.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const started = Date.now();
  const targets = await refreshTargets(MAX_NICHES);
  if (targets.length === 0) {
    return NextResponse.json({ refreshed: 0, note: "nothing cached yet" });
  }

  const report: { slug: string; reels?: number; unjudged?: number; skipped?: string }[] = [];

  await pool(targets, CONCURRENCY, async (n) => {
    if (Date.now() - started > DEADLINE_MS) {
      report.push({ slug: n.slug, skipped: "deadline" });
      return;
    }
    try {
      const raw = await runSync(n.slug, SEED_LIMIT, 120_000);
      if (raw.length === 0) {
        report.push({ slug: n.slug, skipped: "no_feed" });
        return;
      }
      const { items, metric } = normalize(raw as unknown[]);
      const { verdicts, filtered } = await filterAudience(items);

      // filterAudience degrades instead of throwing, so a dead Sonnet returns
      // an empty verdict map and applyVerdicts then keeps EVERYTHING. Writing
      // that would stamp the niche fresh and archive the judged reels it just
      // replaced — an unattended job destroying the only data that cost real
      // money to build. A refresh that cannot judge is a no-op, not a write.
      if (!filtered) {
        report.push({ slug: n.slug, skipped: "filter_failed" });
        return;
      }

      const kept = applyVerdicts(items, verdicts);
      // No `: items` fallback. During an outage applyVerdicts already returns
      // everything, so that branch can only be reached by a SUCCESSFUL filter
      // that rejected the whole set — resurrecting exactly the reels the model
      // just told us were junk.
      const { results } = scoreAndSort(kept, metric, verdicts);

      // A chunk can fail on its own, leaving some reels unjudged. Those are
      // legitimate to serve (borderline-keep), but they are not evidence that
      // last week's reels are gone, so they must not authorise an archive.
      const unjudged = results.filter((r) => !verdicts.has(r.shortCode)).length;

      const id = (await upsertNiche(n.slug)) ?? n.id;
      // Reels absent from the new pull are archived, never deleted — cheap
      // history, and the feed only ever serves the active set.
      await writeReels(id, results, unjudged === 0);
      report.push({ slug: n.slug, reels: results.length, unjudged });
    } catch (err) {
      // One bad niche must never take the weekly job down with it.
      console.error("[cron/refresh]", n.slug, err);
      report.push({ slug: n.slug, skipped: "error" });
    }
  });

  const refreshed = report.filter((r) => r.reels !== undefined).length;
  console.log(
    `[cron/refresh] ${refreshed}/${targets.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  return NextResponse.json({
    refreshed,
    total: targets.length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    report,
  });
}
