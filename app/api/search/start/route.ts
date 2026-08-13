import { NextResponse } from "next/server";
import { startRun } from "@/lib/apify";
import { USE_FIXTURES } from "@/lib/fixtures";
import { resolveNiche, isFresh, readReels, bumpHit } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * FREE. Un-gated as of v2.1 — the feed and per-reel breakdowns are the free
 * product; only /api/synthesis is paid.
 */
export async function POST(req: Request) {
  let keyword = "";
  try {
    const body = await req.json();
    keyword = String(body?.keyword ?? "").trim();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (keyword.length < 2 || keyword.length > 60) {
    return NextResponse.json({ error: "bad_keyword" }, { status: 400 });
  }

  // ---- cache first ----
  // A warm niche never touches Apify: results come straight back on this
  // request, so the client skips polling entirely (~1s instead of ~30-60s).
  if (!USE_FIXTURES) {
    try {
      const { niche } = await resolveNiche(keyword);
      if (niche && isFresh(niche)) {
        const { reels: results, medianPlays } = await readReels(niche.id);
        if (results.length > 0) {
          void bumpHit(niche.id);
          return NextResponse.json({
            cached: true,
            keyword: niche.slug,
            nicheId: niche.id,
            results,
            pool: [],
            datasets: "",
            meta: {
              pulled: results.length,
              kept: results.length,
              dropped: 0,
              // The base readReels actually divided by, so the multiplier,
              // the median and the play count agree on screen.
              medianPlays,
              metric: "plays",
              filtered: true,
              partial: false,
              keywordsUsed: [niche.slug],
            },
          });
        }
      }
    } catch (err) {
      // Cache is an optimisation. Any failure falls through to the live path.
      console.error("[search/start] cache lookup failed:", err);
    }
  }

  if (USE_FIXTURES) {
    return NextResponse.json({
      runId: `fixture-${encodeURIComponent(keyword)}`,
      datasetId: `fixture-${encodeURIComponent(keyword)}`,
      keyword,
    });
  }

  try {
    const { runId, datasetId } = await startRun(keyword);
    return NextResponse.json({ runId, datasetId, keyword });
  } catch (err) {
    console.error("[search/start]", err);
    return NextResponse.json({ error: "apify_start_failed" }, { status: 502 });
  }
}
