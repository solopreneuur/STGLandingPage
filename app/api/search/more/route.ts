import { NextResponse } from "next/server";
import { runSync } from "@/lib/apify";
import { normalize, getPlays } from "@/lib/normalize";
import { filterAudience, applyVerdicts } from "@/lib/filter";
import { USE_FIXTURES, fixtureItems } from "@/lib/fixtures";
import { resolveNiche, writeReels, readReels } from "@/lib/cache";
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
  // Same bound as /api/search/start. This route bills an Apify run and is
  // unauthenticated, so it must not be the looser of the two.
  if (keyword.length < 2 || keyword.length > 60) {
    return NextResponse.json({ results: [] });
  }

  try {
    // Cache first. The cached niche is usually deeper than the 12 the live
    // search pulled, so the reels the user is scrolling toward are normally
    // already in Postgres — scraping first meant paying for a 55s synchronous
    // Apify run to re-fetch data we already had, on every feed, every session.
    if (!USE_FIXTURES) {
      const { niche } = await resolveNiche(keyword);
      if (niche) {
        const { reels } = await readReels(niche.id);
        const unseen = reels.filter((r) => !exclude.includes(r.shortCode));
        if (unseen.length > 0) return NextResponse.json({ results: unseen });
      }
    }

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
    //
    // The PERSISTED score is recomputed server-side. `medianPlays` above comes
    // from the request body, which is right for the response (the multipliers
    // on screen must not shift mid-scroll) and completely wrong to store:
    // readReels orders by that column, so an unauthenticated
    // {"medianPlays":1} would otherwise pin junk to the top of a shared niche.
    void (async () => {
      const { niche } = await resolveNiche(keyword);
      if (!niche) return;
      const { medianPlays: base } = await readReels(niche.id);
      await writeReels(
        niche.id,
        results.map((r) => ({ ...r, score: base > 0 ? r.plays / base : 0 }))
      );
    })();

    return NextResponse.json({ results });
  } catch (err) {
    console.error("[search/more]", err);
    // A failed top-up just means no more reels; never break the feed.
    return NextResponse.json({ results: [] });
  }
}
