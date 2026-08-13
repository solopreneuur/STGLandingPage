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
import { runSync, SEED_LIMIT } from "../lib/apify.ts";
import { normalize } from "../lib/normalize.ts";
import { filterAudience, applyVerdicts } from "../lib/filter.ts";
import { scoreAndSort } from "../lib/score.ts";
import { breakdownReel } from "../lib/breakdown.ts";
import { synthesize } from "../lib/synthesis.ts";
import { suggestVariants } from "../lib/variants.ts";
import {
  normalizeSlug,
  upsertNiche,
  writeReels,
  readBreakdown,
  writeBreakdown,
  writeSynthesis,
  writeAlias,
  bySlugPublic,
  isFresh,
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
      console.log("   skip — already fresh");
      return;
    }
  }

  // 1. pull, widening the same way the live path does.
  //
  // 12 of 16 keywords have an Instagram popular feed; "fitness" is one that
  // does not. Skipping it would leave a permanent hole in a niche people
  // obviously search for, so fall back to the semantic variants and store
  // under whichever term actually returned data.
  let raw = await runSync(term, SEED_LIMIT, SEED_TIMEOUT_MS);
  let landed = term;

  if (raw.length === 0) {
    const variants = await suggestVariants(term, [term]);
    console.log(`   no feed — widening: ${variants.join(", ") || "(none)"}`);
    for (const v of variants) {
      raw = await runSync(v, SEED_LIMIT, SEED_TIMEOUT_MS);
      if (raw.length > 0) {
        landed = v;
        break;
      }
    }
  }
  if (raw.length === 0) {
    console.log(`   NO FEED for "${term}" and no variant worked — skipping`);
    return;
  }

  const landedSlug = normalizeSlug(landed);
  if (landedSlug !== slug) console.log(`   landed on "${landedSlug}"`);
  const { items, metric } = normalize(raw as unknown[]);
  console.log(`   pulled ${raw.length} → ${items.length} usable  (${secs(t0)}s)`);

  // 2. filter + score
  const tf = Date.now();
  const { verdicts } = await filterAudience(items);
  const kept = applyVerdicts(items, verdicts);
  const { results } = scoreAndSort(kept.length ? kept : items, metric, verdicts);
  console.log(`   filtered → ${results.length} reels  (${secs(tf)}s)`);

  // 3. persist reels
  const nicheId = await upsertNiche(landedSlug);
  if (!nicheId) {
    console.log("   DB write failed — skipping breakdowns");
    return;
  }
  await writeReels(nicheId, results);
  // Memo the term we were ASKED for, so a search for it resolves instantly
  // instead of paying for the synonym call it would otherwise need.
  if (landedSlug !== slug) await writeAlias(slug, nicheId);

  // 4. breakdowns — the expensive part, and the whole reason to seed
  const tb = Date.now();
  let generated = 0;
  let reused = 0;
  await pool(results, BREAKDOWN_CONCURRENCY, async (r) => {
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
    for (const r of results) {
      const b = await readBreakdown(r.shortCode);
      if (b) bds.set(r.shortCode, b);
    }
    const syn = await synthesize(landedSlug, results, bds);
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
