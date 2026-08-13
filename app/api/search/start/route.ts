import { NextResponse } from "next/server";
import { startRun } from "@/lib/apify";
import { USE_FIXTURES } from "@/lib/fixtures";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  // Offline: synthetic ids. The poll route resolves them from fixtures.
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
