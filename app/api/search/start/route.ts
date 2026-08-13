import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import { startRun, FAST_LIMIT, SEARCH_LIMIT } from "@/lib/apify";
import { USE_FIXTURES } from "@/lib/fixtures";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  // Searches spend real Apify and Anthropic money. Ungated, anyone could hit
  // this endpoint directly on production and run up the bill without paying.
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

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
      fastRunId: `fixture-${encodeURIComponent(keyword)}`,
      fastDatasetId: `fixture-${encodeURIComponent(keyword)}`,
      keyword,
    });
  }

  try {
    // Two runs in parallel: a small one to paint the feed ~10s sooner, and
    // the full one to backfill. They re-sample rather than paginate, so
    // merging them also yields more unique reels than either alone.
    const [fast, full] = await Promise.all([
      startRun(keyword, FAST_LIMIT),
      startRun(keyword, SEARCH_LIMIT),
    ]);
    return NextResponse.json({
      runId: full.runId,
      datasetId: full.datasetId,
      fastRunId: fast.runId,
      fastDatasetId: fast.datasetId,
      keyword,
    });
  } catch (err) {
    console.error("[search/start]", err);
    return NextResponse.json({ error: "apify_start_failed" }, { status: 502 });
  }
}
