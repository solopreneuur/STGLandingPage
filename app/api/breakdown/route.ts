import { NextResponse } from "next/server";
import { breakdownReel, type BreakdownInput } from "@/lib/breakdown";
import { readBreakdown, writeBreakdown, readReelByCode } from "@/lib/cache";
import { USE_FIXTURES } from "@/lib/fixtures";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  let input: BreakdownInput;
  try {
    const b = await req.json();
    input = {
      shortCode: String(b?.shortCode ?? ""),
      caption: String(b?.caption ?? ""),
      plays: Number(b?.plays ?? 0),
      score: Number(b?.score ?? 0),
      ownerUsername: String(b?.ownerUsername ?? ""),
      timestamp: String(b?.timestamp ?? ""),
      displayUrl: String(b?.displayUrl ?? ""),
    };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!input.shortCode) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Cache first, keyed by reel GLOBALLY. A breakdown generated while someone
  // browsed "gym" is already warm for someone browsing "workout", and it
  // survives every weekly niche refresh. ~50ms instead of ~13s of Opus.
  if (!USE_FIXTURES) {
    const hit = await readBreakdown(input.shortCode);
    if (hit) return NextResponse.json(hit);
  }

  // Prefer the stored reel over the caller's copy. The short code is the only
  // field that has to be trusted; everything else is server-owned when we have
  // it, so a poisoned body cannot become the permanent global breakdown for a
  // real reel. A reel still in flight from a live search simply falls back.
  const stored = await readReelByCode(input.shortCode);
  if (stored) {
    input = {
      shortCode: input.shortCode,
      caption: stored.caption ?? "",
      plays: stored.plays ?? 0,
      score: stored.score ?? 0,
      ownerUsername: stored.ownerUsername ?? "",
      timestamp: stored.timestamp ?? "",
      displayUrl: stored.displayUrl ?? "",
    };
  }

  try {
    const result = await breakdownReel(input);
    // Write through before responding, but never let a cache failure lose a
    // breakdown the user already waited 13s for.
    if (!USE_FIXTURES) {
      void writeBreakdown(
        input.shortCode,
        result,
        process.env.MODEL_BREAKDOWN || "claude-opus-5"
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[breakdown]", input.shortCode, err);
    // One card failing must never block the others — the client renders a
    // retry on this card alone.
    return NextResponse.json({ error: "breakdown_failed" }, { status: 502 });
  }
}
