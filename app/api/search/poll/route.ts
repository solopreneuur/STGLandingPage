import { NextResponse } from "next/server";
import { getRunStatus, getDatasetItems, startRun } from "@/lib/apify";
import { normalize, mergeUnique } from "@/lib/normalize";
import { filterAudience, applyVerdicts } from "@/lib/filter";
import { scoreAndSort, byConfidenceThenScore } from "@/lib/score";
import { suggestVariants, MAX_ATTEMPTS, FALLBACK_SUGGESTIONS } from "@/lib/variants";
import { USE_FIXTURES, fixtureItems, fixtureHasFeed } from "@/lib/fixtures";
import type { ApifyItem, PollResponse } from "@/lib/types";
import { upsertNiche, writeReels, normalizeSlug } from "@/lib/cache";
import { USE_FIXTURES as _FIXTURES } from "@/lib/fixtures";

export const runtime = "nodejs";
// Vercel Fluid gives this project 300s. We stay well under it: the only
// expensive poll is the terminal one (dataset fetch + one filter call).
export const maxDuration = 120;

/**
 * Below this we widen rather than ship a thin, noisy median.
 *
 * MUST stay well under what a single run can yield. At SEARCH_LIMIT 50 this
 * was 30; dropping the pull to 25 without moving it made EVERY search widen
 * and take twice as long (caught live: "home gym" widened to "gym" at 40s).
 * The pull is now 12, normalising to ~9-10, so this sits at 5.
 */
const MIN_RESULTS = 5;

/**
 * Judged up front; everything beyond this is filtered on scroll.
 *
 * Sized against the real rejection rate, not the raw count: the filter drops
 * roughly half to two thirds, so a 12-item head opened the feed on only 4
 * reels. 20 lands ~8-10 on screen for ~4s of filtering.
 */
const FIRST_WINDOW = 20;

const csv = (s: string | null) => (s ? s.split(",").filter(Boolean) : []);

/**
 * All state rides in the query string, because widening spans MULTIPLE poll
 * calls. Running up to 6 sequential Apify runs inside one request would blow
 * the function timeout and give the user a dead spinner; instead each poll
 * either advances the current run or kicks off the next variant and returns
 * immediately with the new ids for the client to carry forward.
 */
export async function GET(req: Request) {
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
  // Merge both samples. The runs are not stably ordered, so the fast run
  // contributes reels the full run may not have returned at all.
  const allDatasets = [...new Set([...datasets, datasetId].filter(Boolean))];
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
  partialFlag = false
): Promise<NextResponse> {
  const { items, metric, pulled, dropped } = normalize(collected as unknown[]);

  if (items.length === 0) {
    return NextResponse.json({
      phase: "empty",
      suggestions: FALLBACK_SUGGESTIONS.filter((s) => !usedList.includes(s)).slice(0, 3),
    } satisfies PollResponse);
  }

  // Median over the FULL normalised set, not the filtered subset. It is the
  // niche's median, so it must not move as JIT filtering resolves later
  // windows — the multiplier is the headline number and a shifting one is
  // worse than a slightly different one.
  const ranked = scoreAndSort(items, metric, new Map());
  const medianPlays = ranked.medianPlays;
  const ordered = ranked.results;

  // Judge only enough to fill the first screens. The rest is filtered
  // just-in-time as the user scrolls, so the wait is ~3s instead of ~12s.
  const head = ordered.slice(0, FIRST_WINDOW);
  const byCode = new Map(items.map((i) => [i.shortCode, i]));
  const headItems = head.map((r) => byCode.get(r.shortCode)!).filter(Boolean);

  const { verdicts, filtered } = await filterAudience(headItems);
  const keptCodes = new Set(
    applyVerdicts(headItems, verdicts).map((i) => i.shortCode)
  );

  // Re-sorted below: scoreAndSort ran with an empty verdict map so every
  // confidence was the 0.5 default and the borderline rule degenerated to
  // plain score order.
  const results = head
    .filter((r) => keptCodes.has(r.shortCode))
    .map((r) => ({
      ...r,
      confidence: verdicts.get(r.shortCode)?.confidence ?? 0.5,
      // scoreAndSort ran with an empty verdict map (the median must come from
      // the FULL set), so the reason has to be re-attached here. Without it
      // every row this path writes lands with reason NULL and the niche reads
      // back as entirely unjudged.
      filterReason: verdicts.get(r.shortCode)?.reason,
    }))
    .sort(byConfidenceThenScore);

  const pool = ordered.slice(FIRST_WINDOW);

  // Write through so the next person searching this niche skips Apify
  // entirely. Fire-and-forget: a cache write must never delay or fail the
  // response the user is waiting on.
  if (!_FIXTURES) {
    void (async () => {
      try {
        const slug = normalizeSlug(usedList[0] ?? original);
        const nicheId = await upsertNiche(slug);
        // Only the judged head. The pool has not been through the filter yet
        // — persisting it would store unscreened reels as though they had been
        // screened, which is the same laundering the cron now refuses to do.
        if (nicheId && results.length > 0) await writeReels(nicheId, results);
      } catch (err) {
        console.error("[search/poll] cache write failed:", err);
      }
    })();
  }

  return NextResponse.json({
    phase: "done",
    results,
    pool,
    datasets: datasets.join(","),
    meta: {
      pulled,
      kept: results.length,
      dropped,
      medianPlays,
      metric,
      filtered,
      partial: partialFlag,
      keywordsUsed: usedList,
    },
  } satisfies PollResponse);
}
