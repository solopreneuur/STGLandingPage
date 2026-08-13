import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { breakdownReel, type BreakdownInput } from "@/lib/breakdown";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  // Breakdowns cost real money per call — gate them the same way the UI is
  // gated, so an unpaid caller can't run up the Anthropic bill.
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

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

  try {
    const result = await breakdownReel(input);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[breakdown]", input.shortCode, err);
    // One card failing must never block the others — the client renders a
    // retry on this card alone.
    return NextResponse.json({ error: "breakdown_failed" }, { status: 502 });
  }
}
