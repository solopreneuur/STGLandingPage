/**
 * Per-niche health check. Run: npx tsx --env-file=.env.local scripts/audit.ts
 *
 * A niche is only genuinely cached if its reels were actually filtered and its
 * breakdowns exist. A run that lost the Anthropic API partway writes reels that
 * look fine by count but were never judged and have no breakdowns behind them —
 * this is what tells those apart.
 */
import { db } from "../lib/db.ts";

interface Row {
  short_code: string;
  reason: string | null;
  confidence: number | null;
}

async function main(): Promise<void> {
  const c = db();
  if (!c) {
    console.log("no client");
    return;
  }

  const { data: niches } = await c
    .from("niches")
    .select("id, slug, last_refreshed_at")
    .order("slug");

  const damaged: string[] = [];
  console.log(
    "niche                reels  judged  breakdowns  synthesis  verdict"
  );
  for (const n of niches ?? []) {
    const { data: reels } = await c
      .from("reels")
      .select("short_code, reason, confidence")
      .eq("niche_id", n.id)
      .eq("archived", false);
    const rows = (reels ?? []) as Row[];

    const judged = rows.filter((r) => r.reason !== null).length;
    const codes = rows.map((r) => r.short_code);
    let bds = 0;
    for (let i = 0; i < codes.length; i += 100) {
      const { count } = await c
        .from("breakdowns")
        .select("*", { count: "exact", head: true })
        .in("short_code", codes.slice(i, i + 100));
      bds += count ?? 0;
    }
    const { data: syn } = await c
      .from("syntheses")
      .select("niche_id")
      .eq("niche_id", n.id)
      .maybeSingle();

    const ok = rows.length > 0 && judged === rows.length && bds === rows.length && !!syn;
    if (!ok) damaged.push(n.slug);
    console.log(
      `${n.slug.padEnd(20)} ${String(rows.length).padStart(5)}  ` +
        `${String(judged).padStart(6)}  ${String(bds).padStart(10)}  ` +
        `${(syn ? "yes" : "no").padStart(9)}  ${ok ? "OK" : "INCOMPLETE"}`
    );
  }

  console.log(
    `\n${damaged.length} incomplete: ${damaged.join(", ") || "none"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
