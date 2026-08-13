/**
 * Retire a niche that was written by a failed run.
 *
 *   npx tsx --env-file=.env.local scripts/repair.ts business "real estate"
 *
 * When the Anthropic API dies mid-seed, filterAudience returns no verdicts and
 * the pipeline falls back to `items` — so every scraped reel gets persisted as
 * though it had been judged, with no filter reason and no breakdown behind it.
 * The niche then looks healthy by row count and serves unfiltered junk on a
 * cache hit.
 *
 * This archives those reels rather than deleting them (readReels only ever
 * serves archived = false, so archiving is enough to stop them and keeps the
 * rows for inspection) and clears last_refreshed_at, which both drops the niche
 * out of the explore chips and makes the next search re-run the live pipeline.
 * Re-seeding the slug afterwards restores it properly.
 */
import { db } from "../lib/db.ts";
import { normalizeSlug } from "../lib/cache.ts";

async function main(): Promise<void> {
  const slugs = process.argv.slice(2).map(normalizeSlug);
  if (slugs.length === 0) {
    console.log("usage: repair.ts <slug> [slug...]");
    return;
  }
  const c = db();
  if (!c) {
    console.log("no client");
    return;
  }

  for (const slug of slugs) {
    const { data: niche } = await c
      .from("niches")
      .select("id, slug")
      .eq("slug", slug)
      .maybeSingle();
    if (!niche) {
      console.log(`${slug}: no such niche`);
      continue;
    }

    const { count: before } = await c
      .from("reels")
      .select("*", { count: "exact", head: true })
      .eq("niche_id", niche.id)
      .eq("archived", false);

    await c.from("reels").update({ archived: true }).eq("niche_id", niche.id);
    await c.from("niches").update({ last_refreshed_at: null }).eq("id", niche.id);

    const { count: after } = await c
      .from("reels")
      .select("*", { count: "exact", head: true })
      .eq("niche_id", niche.id)
      .eq("archived", false);

    console.log(
      `${slug}: archived ${before ?? 0} reels (${after ?? 0} active left), ` +
        `last_refreshed_at cleared — will re-run live and is out of the chips`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
