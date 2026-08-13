/**
 * Delete alias rows that shadow a real niche.
 *
 *   npx tsx --env-file=.env.local scripts/unalias.ts          (report only)
 *   npx tsx --env-file=.env.local scripts/unalias.ts --apply
 *
 * byAlias runs BEFORE bySlug in resolveNiche, so an alias whose slug is also a
 * niche silently hijacks that niche: "tech" -> gaming made every search for
 * tech serve gaming's reels while tech's own were unreachable. Also removes
 * aliases pointing at a niche that no longer exists.
 */
import { db } from "../lib/db.ts";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  // Extra slugs to drop regardless of whether they shadow anything yet — used
  // to clean up the cluster-sibling aliases, which are broadening queries
  // rather than synonyms and would shadow those niches if ever seeded.
  const extra = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const c = db();
  if (!c) {
    console.log("no client");
    return;
  }

  const { data: aliases } = await c.from("aliases").select("alias_slug, niche_id");
  const { data: niches } = await c.from("niches").select("id, slug");
  const bySlug = new Map((niches ?? []).map((n: { id: string; slug: string }) => [n.slug, n.id]));
  const ids = new Set((niches ?? []).map((n: { id: string }) => n.id));

  const bad: string[] = [];
  for (const a of (aliases ?? []) as { alias_slug: string; niche_id: string }[]) {
    const shadows = bySlug.has(a.alias_slug) && bySlug.get(a.alias_slug) !== a.niche_id;
    const orphan = !ids.has(a.niche_id);
    if (shadows || orphan || extra.includes(a.alias_slug)) {
      bad.push(a.alias_slug);
      console.log(
        `  ${a.alias_slug.padEnd(20)} ${
          shadows ? "SHADOWS its own niche" : orphan ? "orphaned" : "requested"
        }`
      );
    }
  }

  if (bad.length === 0) {
    console.log("no shadowing aliases");
    return;
  }
  if (!apply) {
    console.log(`\n${bad.length} to delete — re-run with --apply`);
    return;
  }
  await c.from("aliases").delete().in("alias_slug", bad);
  const { data: left } = await c.from("aliases").select("alias_slug");
  console.log(
    `\ndeleted ${bad.length}; remaining: ${(left ?? []).map((r: { alias_slug: string }) => r.alias_slug).join(", ") || "none"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
