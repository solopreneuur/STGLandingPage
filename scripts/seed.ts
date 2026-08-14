/**
 * Seed the cache with popular niches.
 *
 * Run locally:  npx tsx scripts/seed.ts
 *               npx tsx scripts/seed.ts "content creation" cooking   (subset)
 *               FORCE=1 npx tsx scripts/seed.ts                      (ignore freshness)
 *
 * Deliberately a CLI script, not a route: the full pipeline for 15 niches is
 * far longer than any serverless timeout. Sequential with a delay, resumable,
 * and it skips anything already fresh so a re-run is cheap.
 *
 * Uses SEED_LIMIT (50), not SEARCH_LIMIT (12) — nobody is waiting on this, so
 * a thin pull would only make every cached niche permanently shallow.
 */
import { SEED_LIMIT } from "../lib/apify.ts";
import { pullCluster, CLUSTER_SIZE } from "../lib/cluster.ts";
import { normalize } from "../lib/normalize.ts";
import { filterAudience, applyVerdicts } from "../lib/filter.ts";
import { scoreAndSort } from "../lib/score.ts";
import { breakdownReel } from "../lib/breakdown.ts";
import { synthesize } from "../lib/synthesis.ts";
import {
  normalizeSlug,
  upsertNiche,
  writeReels,
  readBreakdown,
  writeBreakdown,
  writeSynthesis,
  writeAlias,
  readReels,
  bySlugPublic,
  isFresh,
  nicheHealth,
} from "../lib/cache.ts";
import type { Breakdown } from "../lib/types.ts";

const SEED = [
  "content creation",
  "fitness",
  "cooking",
  "tech",
  "coding",
  "personal finance",
  "fashion",
  "travel",
  "self improvement",
  "business",
  "real estate",
  "gaming",
  "beauty",
  "productivity",
  "food",
];

const MODEL = process.env.MODEL_BREAKDOWN || "claude-opus-5";
const FORCE = process.env.FORCE === "1";
const DELAY_MS = 2000;
/** Nobody is waiting on this, so give a 50-item pull all the room it needs. */
const SEED_TIMEOUT_MS = 240_000;
/** Concurrent Opus calls per niche. Enough to be quick, not enough to 429. */
const BREAKDOWN_CONCURRENCY = 5;
/**
 * How many reels get a breakdown warmed at seed time.
 *
 * Clustering roughly triples the pool, and pre-warming all of it would triple
 * the seed bill for reels most sessions never scroll to. The top slice covers
 * what people actually open; the tail generates on demand in ~11s and is then
 * cached globally forever, which is the same path any uncached reel takes.
 */
const WARM_CAP = Number(process.env.WARM_CAP ?? 30);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (t: number) => ((Date.now() - t) / 1000).toFixed(1);

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function seedOne(term: string): Promise<void> {
  const slug = normalizeSlug(term);
  const t0 = Date.now();
  process.stdout.write(`\n── ${slug}\n`);

  if (!FORCE) {
    const existing = await bySlugPublic(slug);
    if (existing && isFresh(existing)) {
      // Fresh is not the same as finished. A run that lost the API partway
      // leaves a niche that is recent but has no breakdowns and no synthesis,
      // and skipping on date alone would make the seed unable to repair it.
      const h = await nicheHealth(existing.id);
      // Judged is NOT part of the bar: an absent verdict is a deliberate
      // borderline-keep, not missing work, and requiring it would re-run a
      // healthy niche on every pass.
      const done =
        h.reels > 0 && h.breakdowns >= Math.min(h.reels, WARM_CAP) && h.synthesis;
      if (done) {
        console.log(`   skip — complete (${h.reels} reels)`);
        return;
      }
      console.log(
        `   fresh but incomplete (${h.judged}/${h.reels} judged, ` +
          `${h.breakdowns}/${h.reels} breakdowns, synthesis ${h.synthesis ? "yes" : "no"}) — redoing`
      );
    }
  }

  // 1. pull the whole keyword CLUSTER, not just this term.
  //
  // One keyword tops out around 48 items no matter what limit we ask for, so
  // a single-term niche was never going to hold enough reels to draw a
  // conclusion from. Siblings are also what covers the keywords with no
  // popular feed at all ("fitness"), which used to be skipped outright.
  const { items: raw, landed, used, counts, failed, retryable } = await pullCluster(
    term,
    SEED_LIMIT,
    SEED_TIMEOUT_MS
  );
  console.log(
    `   cluster: ${used.map((t) => `${t}=${counts[t]}`).join(", ") || "(nothing)"}` +
      (failed.length ? `  FAILED: ${failed.join(", ")}` : "")
  );
  if (raw.length === 0) {
    // A failed run is not an empty feed. Saying "NO FEED" for a keyword that
    // has one sends you looking for a scraping problem that isn't there.
    console.log(
      retryable
        ? `   ALL RUNS FAILED for "${term}" and at least one is transient — RETRY, not a missing feed`
        : `   NO FEED for "${term}" or any sibling — skipping`
    );
    return;
  }

  const landedSlug = normalizeSlug(landed);
  if (landedSlug !== slug) console.log(`   landed on "${landedSlug}"`);
  const { items, metric } = normalize(raw as unknown[]);
  console.log(`   pulled ${raw.length} → ${items.length} usable  (${secs(t0)}s)`);

  // 2. filter + score
  const tf = Date.now();
  const { verdicts, filtered } = await filterAudience(items);
  if (!filtered) {
    // Every reel would be written unjudged and the niche stamped fresh, which
    // is exactly how "business" and "real estate" ended up holding 89
    // unscreened reels that looked filtered.
    console.log("   FILTER FAILED — refusing to write an unjudged niche");
    return;
  }
  const kept = applyVerdicts(items, verdicts);
  // No `: items` fallback: applyVerdicts already keeps everything when there
  // are no verdicts, so that branch could only resurrect a set the model
  // successfully rejected in full.
  const { results } = scoreAndSort(kept, metric, verdicts);
  console.log(`   filtered → ${results.length} reels  (${secs(tf)}s)`);

  // 3. persist reels
  const nicheId = await upsertNiche(landedSlug);
  if (!nicheId) {
    console.log("   DB write failed — skipping breakdowns");
    return;
  }
  await writeReels(nicheId, results);

  // Work from the niche's FULL active set, not just this pull. The actor
  // re-samples rather than paginates, so each run returns a partly different
  // slice and the stored niche is the union of every run. Generating
  // breakdowns only for the current pull leaves older reels permanently
  // uncovered — and makes the completeness check below re-run this niche
  // forever, since coverage can never reach 100%.
  const { reels: active } = await readReels(nicheId);
  const targets = (active.length > 0 ? active : results).slice(0, WARM_CAP);
  // Memo the term we were ASKED for, so a search for it resolves instantly
  // instead of paying for the synonym call it would otherwise need.
  // Only the term we were ASKED for is memoized — never the cluster siblings.
  // A sibling is a broadening query, not a synonym: "esports" and "tech" are
  // useful sources of gaming reels but are their own search intents, and
  // "tech" is a seeded niche in its own right. Aliasing them hijacked those
  // searches. resolveNiche's synonym step already handles genuine equivalence,
  // conservatively and one term at a time.
  if (landedSlug !== slug) await writeAlias(slug, nicheId);

  // 4. breakdowns — the expensive part, and the whole reason to seed
  const tb = Date.now();
  let generated = 0;
  let reused = 0;
  await pool(targets, BREAKDOWN_CONCURRENCY, async (r) => {
    // Global cache: a reel already analyzed under another niche is free here.
    if (await readBreakdown(r.shortCode)) {
      reused++;
      return;
    }
    try {
      const bd = await breakdownReel({
        shortCode: r.shortCode,
        caption: r.caption,
        plays: r.plays,
        score: r.score,
        ownerUsername: r.ownerUsername,
        timestamp: r.timestamp,
        displayUrl: r.displayUrl,
      });
      await writeBreakdown(r.shortCode, bd, MODEL);
      generated++;
    } catch {
      // One bad reel must not abort the niche.
    }
  });
  console.log(
    `   breakdowns: ${generated} new, ${reused} already cached  (${secs(tb)}s)`
  );

  // 5. synthesis
  const ts = Date.now();
  try {
    const bds = new Map<string, Breakdown>();
    for (const r of targets) {
      const b = await readBreakdown(r.shortCode);
      if (b) bds.set(r.shortCode, b);
    }
    const syn = await synthesize(landedSlug, targets, bds);
    await writeSynthesis(nicheId, syn);
    console.log(`   synthesis ok  (${secs(ts)}s)  "${syn.headline.slice(0, 70)}"`);
  } catch (err) {
    console.log("   synthesis failed:", (err as Error).message.slice(0, 80));
  }

  console.log(`   DONE in ${secs(t0)}s`);
}

// Wrapped rather than top-level await: the package is CommonJS, so tsx
// transforms this to CJS where top-level await is a syntax error.
async function main(): Promise<void> {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : SEED;
  console.log(`seeding ${targets.length} niches at SEED_LIMIT=${SEED_LIMIT}\n`);

  const start = Date.now();
  for (const t of targets) {
    try {
      await seedOne(t);
    } catch (err) {
      console.log(`   FAILED: ${(err as Error).message.slice(0, 120)}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\nall done in ${((Date.now() - start) / 60000).toFixed(1)} min`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
