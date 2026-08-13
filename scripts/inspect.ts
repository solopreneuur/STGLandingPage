/**
 * Read-only snapshot of the cache. Run: npx tsx --env-file=.env.local scripts/inspect.ts
 */
import { db } from "../lib/db.ts";

async function main(): Promise<void> {
  const c = db();
  if (!c) {
    console.log("no client — SUPABASE_URL / SUPABASE_SECRET_KEY missing");
    return;
  }

  const { data: niches } = await c
    .from("niches")
    .select("id, slug, hit_count, last_refreshed_at")
    .order("slug");

  console.log(`niches: ${niches?.length ?? 0}`);
  for (const n of niches ?? []) {
    const { count: reels } = await c
      .from("reels")
      .select("*", { count: "exact", head: true })
      .eq("niche_id", n.id)
      .eq("archived", false);
    const { data: syn } = await c
      .from("syntheses")
      .select("niche_id")
      .eq("niche_id", n.id)
      .maybeSingle();
    console.log(
      `  ${n.slug.padEnd(20)} reels=${String(reels ?? 0).padStart(3)}  ` +
        `synthesis=${syn ? "yes" : "no "}  hits=${n.hit_count}  ` +
        `refreshed=${n.last_refreshed_at?.slice(0, 16) ?? "never"}`
    );
  }

  const { count: bds } = await c
    .from("breakdowns")
    .select("*", { count: "exact", head: true });
  const { data: aliases } = await c.from("aliases").select("alias_slug, niche_id");
  console.log(`\nbreakdowns (global): ${bds ?? 0}`);
  console.log(`aliases: ${(aliases ?? []).map((a) => a.alias_slug).join(", ") || "none"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
