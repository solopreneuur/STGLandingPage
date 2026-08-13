import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import { getDatasetItems } from "@/lib/apify";
import { filterAudience } from "@/lib/filter";
import { USE_FIXTURES, fixtureVerdicts } from "@/lib/fixtures";
import type { ApifyItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Cap per request so one call can't be used to filter the whole set at once. */
const MAX_WINDOW = 20;

/**
 * Just-in-time audience filter for one window of reels.
 *
 * The client asks for the next slice as the user scrolls, staying ahead of
 * the viewport. Filtering all ~40 up front cost ~12s of dead wait before
 * anything could render; a window of ~10 is ~3s and happens off-screen.
 *
 * Only shortCodes come from the client — the comments needed to judge are
 * re-read server-side from the dataset, so the client never has to hold
 * (or be trusted with) the raw payload.
 */
export async function POST(req: Request) {
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

  let datasets: string[] = [];
  let shortCodes: string[] = [];
  try {
    const b = await req.json();
    datasets = Array.isArray(b?.datasets) ? b.datasets.map(String) : [];
    shortCodes = Array.isArray(b?.shortCodes)
      ? b.shortCodes.map(String).slice(0, MAX_WINDOW)
      : [];
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (shortCodes.length === 0) return NextResponse.json({ verdicts: [] });

  const wanted = new Set(shortCodes);

  if (USE_FIXTURES) {
    const captured = fixtureVerdicts();
    return NextResponse.json({
      verdicts: shortCodes
        .map((c) => captured.get(c))
        .filter((v): v is NonNullable<typeof v> => Boolean(v)),
    });
  }

  try {
    const pulls = await Promise.all(datasets.map((d) => getDatasetItems(d)));
    const items: ApifyItem[] = [];
    const seen = new Set<string>();
    for (const arr of pulls) {
      for (const i of arr) {
        if (wanted.has(i.shortCode) && !seen.has(i.shortCode)) {
          seen.add(i.shortCode);
          items.push(i);
        }
      }
    }
    if (items.length === 0) return NextResponse.json({ verdicts: [] });

    const { verdicts } = await filterAudience(items);
    return NextResponse.json({ verdicts: [...verdicts.values()] });
  } catch (err) {
    console.error("[filter/window]", err);
    // Degrade to "keep everything in this window" rather than blocking the
    // scroll — an unjudged reel is far better than a stalled feed.
    return NextResponse.json({ verdicts: [] });
  }
}
