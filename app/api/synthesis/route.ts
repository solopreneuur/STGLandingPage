import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import { synthesize } from "@/lib/synthesis";
import {
  resolveNiche,
  readReels,
  readBreakdowns,
  readSynthesis,
  writeSynthesis,
} from "@/lib/cache";
import type { Reel } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * THE PAID ROUTE — the only gated endpoint in v2.1.
 *
 * Everything else (feed, per-reel breakdowns) is free. $1 buys the cross-reel
 * pattern read: what is winning in this niche right now, which you can only
 * see by looking at all ~20 reels at once.
 */
export async function POST(req: Request) {
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

  let keyword = "";
  let clientReels: Reel[] = [];
  try {
    const b = await req.json();
    keyword = String(b?.keyword ?? "").trim();
    clientReels = Array.isArray(b?.reels) ? (b.reels as Reel[]) : [];
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (keyword.length < 2) {
    return NextResponse.json({ error: "bad_keyword" }, { status: 400 });
  }

  try {
    const { niche } = await resolveNiche(keyword);

    // A second buyer of the same niche gets it instantly rather than waiting
    // on a fresh call.
    if (niche) {
      const cached = await readSynthesis(niche.id);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    // Prefer the cached reel set (deeper, seeded at 50) and fall back to what
    // the client is actually looking at when the niche isn't cached yet.
    const reels = niche ? (await readReels(niche.id)).reels : [];
    const source = reels.length > 0 ? reels : clientReels;
    if (source.length === 0) {
      return NextResponse.json({ error: "no_reels" }, { status: 400 });
    }

    const breakdowns = await readBreakdowns(source.map((r) => r.shortCode));
    const result = await synthesize(keyword, source, breakdowns);

    if (niche) void writeSynthesis(niche.id, result);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[synthesis]", err);
    return NextResponse.json({ error: "synthesis_failed" }, { status: 502 });
  }
}
