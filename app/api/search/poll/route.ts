import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import { getRunStatus, getDatasetItems, startRun } from "@/lib/apify";
import { normalize, mergeUnique } from "@/lib/normalize";
import { filterAudience, applyVerdicts } from "@/lib/filter";
import { scoreAndSort } from "@/lib/score";
import { suggestVariants, MAX_ATTEMPTS, FALLBACK_SUGGESTIONS } from "@/lib/variants";
import { USE_FIXTURES, fixtureItems, fixtureHasFeed } from "@/lib/fixtures";
import type { ApifyItem, PollResponse } from "@/lib/types";

export const runtime = "nodejs";
// Vercel Fluid gives this project 300s. We stay well under it: the only
// expensive poll is the terminal one (dataset fetch + one filter call).
export const maxDuration = 120;

/** Below this we try to widen rather than ship a thin, noisy median. */
const MIN_RESULTS = 30;

const csv = (s: string | null) => (s ? s.split(",").filter(Boolean) : []);

/**
 * All state rides in the query string, because widening spans MULTIPLE poll
 * calls. Running up to 6 sequential Apify runs inside one request would blow
 * the function timeout and give the user a dead spinner; instead each poll
 * either advances the current run or kicks off the next variant and returns
 * immediately with the new ids for the client to carry forward.
 */
export async function GET(req: Request) {
  // Searches spend real Apify and Anthropic money. Ungated, anyone could hit
  // this endpoint directly on production and run up the bill without paying.
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

  const url = new URL(req.url);
  const runId = url.searchParams.get("runId") ?? "";
  const datasetId = url.searchParams.get("datasetId") ?? "";
  const keyword = url.searchParams.get("keyword") ?? "";
  const original = url.searchParams.get("original") || keyword;
  const datasets = csv(url.searchParams.get("datasets"));
  const queue = csv(url.searchParams.get("queue"));
  const used = csv(url.searchParams.get("used"));
  const usedList = used.length ? used : [keyword];

  if (!runId || !datasetId || !keyword) {
    return NextResponse.json({ phase: "failed", retryable: false } satisfies PollResponse);
  }

  // ---------- offline ----------
  if (USE_FIXTURES) {
    if (!fixtureHasFeed(keyword)) {
      return widen({ original, usedList, queue, datasets, collected: [] });
    }
    const items = fixtureItems(keyword);
    return finish(items, datasets, usedList, original);
  }

  // ---------- live ----------
  let status;
  try {
    status = await getRunStatus(runId, datasetId);
  } catch (err) {
    console.error("[search/poll] status", err);
    return NextResponse.json({ phase: "failed", retryable: true } satisfies PollResponse);
  }

  if (status.phase === "running") {
    return NextResponse.json({
      phase: "pulling",
      found: status.itemCount,
    } satisfies PollResponse);
  }

  if (status.phase === "failed") {
    // A genuine actor failure, not the no-feed case. If earlier runs collected
    // anything, ship that rather than erroring out.
    if (datasets.length > 0) return finishFromDatasets(datasets, usedList, original, true);
    return NextResponse.json({ phase: "failed", retryable: true } satisfies PollResponse);
  }

  if (status.phase === "no_feed") {
    return widen({ original, usedList, queue, datasets, collected: [] });
  }

  // succeeded
  const allDatasets = [...new Set([...datasets, datasetId])];
  let collected: ApifyItem[] = [];
  try {
    const pulls = await Promise.all(allDatasets.map((d) => getDatasetItems(d)));
    collected = pulls.reduce<ApifyItem[]>((acc, cur) => mergeUnique(acc, cur), []);
  } catch (err) {
    console.error("[search/poll] dataset fetch", err);
    return NextResponse.json({ phase: "failed", retryable: true } satisfies PollResponse);
  }

  const { items: kept } = normalize(collected as unknown[]);

  // Thin result set and attempts remaining -> widen instead of scoring a
  // median off too few items.
  if (kept.length < MIN_RESULTS && usedList.length < MAX_ATTEMPTS) {
    return widen({ original, usedList, queue, datasets: allDatasets, collected });
  }

  return finish(collected, allDatasets, usedList, original);
}

/* ------------------------------------------------------------------ */

async function widen(args: {
  original: string;
  usedList: string[];
  queue: string[];
  datasets: string[];
  collected: ApifyItem[];
}): Promise<NextResponse> {
  const { original, usedList, datasets } = args;
  let queue = args.queue;

  // Out of attempts -> ship whatever we have, or a real empty state.
  if (usedList.length >= MAX_ATTEMPTS) {
    if (datasets.length > 0) return finishFromDatasets(datasets, usedList, original, false);
    return NextResponse.json({
      phase: "empty",
      suggestions: FALLBACK_SUGGESTIONS.filter((s) => !usedList.includes(s)).slice(0, 3),
    } satisfies PollResponse);
  }

  if (queue.length === 0) {
    queue = await suggestVariants(original, usedList);
  }

  const next = queue.find((k) => !usedList.includes(k));
  if (!next) {
    if (datasets.length > 0) return finishFromDatasets(datasets, usedList, original, false);
    return NextResponse.json({
      phase: "empty",
      suggestions: FALLBACK_SUGGESTIONS.filter((s) => !usedList.includes(s)).slice(0, 3),
    } satisfies PollResponse);
  }

  const rest = queue.filter((k) => k !== next);

  if (USE_FIXTURES) {
    return NextResponse.json({
      phase: "widening",
      triedKeyword: next,
      runId: `fixture-${encodeURIComponent(next)}`,
      datasetId: `fixture-${encodeURIComponent(next)}`,
      keyword: next,
      original,
      datasets: datasets.join(","),
      queue: rest.join(","),
      used: [...usedList, next].join(","),
    });
  }

  try {
    const { runId, datasetId } = await startRun(next);
    return NextResponse.json({
      phase: "widening",
      triedKeyword: next,
      runId,
      datasetId,
      keyword: next,
      original,
      datasets: datasets.join(","),
      queue: rest.join(","),
      used: [...usedList, next].join(","),
    });
  } catch (err) {
    console.error("[search/poll] widen start", err);
    if (datasets.length > 0) return finishFromDatasets(datasets, usedList, original, true);
    return NextResponse.json({ phase: "failed", retryable: true } satisfies PollResponse);
  }
}

async function finishFromDatasets(
  datasets: string[],
  usedList: string[],
  original: string,
  partial: boolean
): Promise<NextResponse> {
  const pulls = await Promise.all(datasets.map((d) => getDatasetItems(d)));
  const collected = pulls.reduce<ApifyItem[]>((acc, cur) => mergeUnique(acc, cur), []);
  return finish(collected, datasets, usedList, original, partial);
}

async function finish(
  collected: ApifyItem[],
  datasets: string[],
  usedList: string[],
  original: string,
  partial = false
): Promise<NextResponse> {
  const { items, metric, pulled, dropped } = normalize(collected as unknown[]);

  if (items.length === 0) {
    return NextResponse.json({
      phase: "empty",
      suggestions: FALLBACK_SUGGESTIONS.filter((s) => !usedList.includes(s)).slice(0, 3),
    } satisfies PollResponse);
  }

  const { verdicts, filtered } = await filterAudience(items);
  const kept = applyVerdicts(items, verdicts);

  // The filter can legitimately reject nearly everything. Never return an
  // empty page off the back of that — fall back to the unfiltered set and
  // let the borderline sort handle ordering.
  const forScoring = kept.length > 0 ? kept : items;

  const { results, medianPlays } = scoreAndSort(forScoring, metric, verdicts);

  return NextResponse.json({
    phase: "done",
    results,
    meta: {
      pulled,
      kept: results.length,
      dropped,
      medianPlays,
      metric,
      filtered,
      partial,
      keywordsUsed: usedList,
    },
  } satisfies PollResponse);
}
