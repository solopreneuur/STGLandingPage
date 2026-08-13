import { NextResponse } from "next/server";
import { runSync } from "@/lib/apify";
import { normalize, getPlays } from "@/lib/normalize";
import { filterAudience, applyVerdicts } from "@/lib/filter";
import { USE_FIXTURES, fixtureItems } from "@/lib/fixtures";
import { resolveNiche, writeReels } from "@/lib/cache";
import type { Metric, Reel } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Scroll-triggered top-up.
 *
 * The initial search only pulls 25 because ~15s of every Apify run is fixed
 * startup and the rest is ~0.26s per item — so a smaller first run is
 * meaningfully faster, and most sessions never scroll deep enough to need
 * more. This fetches another sample only when they do.
 *
 * The actor has no cursor, so this RE-SAMPLES rather than paginates. That is
 * fine, and measurably useful: two runs of the same keyword returned
 * different items, so after excluding what the client already has we still
 * net new reels.
 */
export async function POST(req: Request) {
  let keyword = "";
  let exclude: string[] = [];
  let medianPlays = 0;
  let metric: Metric = "plays";
  try {
    const b = await req.json();
    keyword = String(b?.keyword ?? "").trim();
    exclude = Array.isArray(b?.exclude) ? b.exclude.map(String) : [];
    medianPlays = Number(b?.medianPlays) || 0;
    metric = b?.metric === "views" ? "views" : "plays";
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (keyword.length < 2) return NextResponse.json({ results: [] });

  try {
    const raw = USE_FIXTURES ? fixtureItems(keyword) : await runSync(keyword);
    if (raw.length === 0) return NextResponse.json({ results: [] });

    const have = new Set(exclude);
    const { items } = normalize(raw as unknown[]);
    const fresh = items.filter((i) => !have.has(i.shortCode));
    if (fresh.length === 0) return NextResponse.json({ results: [] });

    const { verdicts } = await filterAudience(fresh);
    const kept = applyVerdicts(fresh, verdicts);

    // Score against the median the client is ALREADY showing. Recomputing it
    // here would silently change every multiplier on screen.
    const results: Reel[] = kept
      .map((i) => {
        const plays = getPlays(i, metric);
        return {
          shortCode: i.shortCode,
          url: i.url ?? `https://www.instagram.com/reel/${i.shortCode}/`,
          caption: i.caption ?? "",
          displayUrl: i.displayUrl ?? "",
          videoUrl: i.videoUrl ?? "",
          ownerUsername: i.ownerUsername ?? "",
          ownerFullName: i.ownerFullName ?? "",
          timestamp: i.timestamp ?? "",
          plays,
          score: medianPlays > 0 ? plays / medianPlays : 0,
          confidence: verdicts.get(i.shortCode)?.confidence ?? 0.5,
          filterReason: verdicts.get(i.shortCode)?.reason,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Write-through: one person scrolling deep enriches the niche for everyone
    // after them. Fire-and-forget so the response never waits on Postgres, and
    // `archiveMissing` stays false — this ADDS reels and must never archive the
    // ones the user is currently looking at.
    void (async () => {
      const { niche } = await resolveNiche(keyword);
      if (niche) await writeReels(niche.id, results);
    })();

    return NextResponse.json({ results });
  } catch (err) {
    console.error("[search/more]", err);
    // A failed top-up just means no more reels; never break the feed.
    return NextResponse.json({ results: [] });
  }
}
