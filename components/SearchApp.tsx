"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PollResponse, Reel, SearchMeta } from "@/lib/types";
import Feed from "./Feed";
import SearchOverlay from "./SearchOverlay";
import ProgressRail, { type Stage } from "./ProgressRail";
import { saveResults, loadResults, getSearch } from "@/lib/session-cache";

type View =
  | { k: "idle" }
  | { k: "running"; stage: Stage; found: number; widenedTo?: string }
  | { k: "done"; results: Reel[]; pool: Reel[]; datasets: string; meta: SearchMeta }
  | { k: "empty"; suggestions: string[] }
  | { k: "failed" };

const POLL_MS = 2000;

export default function SearchApp({ initialKeyword }: { initialKeyword: string }) {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [view, setView] = useState<View>({ k: "idle" });
  const [searchOpen, setSearchOpen] = useState(false);
  const abort = useRef(false);

  const run = useCallback(async (kw: string) => {
    const q = kw.trim();
    if (q.length < 2) return;
    abort.current = false;
    setKeyword(q);
    setSearchOpen(false);

    // Repeat search in the same tab: serve it instantly rather than paying
    // ~$0.34 and ~40s to recompute the same answer.
    const hit = getSearch(q);
    if (hit?.results?.length) {
      setView({
        k: "done",
        results: hit.results,
        pool: hit.pool ?? [],
        datasets: hit.datasets ?? "",
        meta: hit.meta,
      });
      saveResults(hit);
      return;
    }

    setView({ k: "running", stage: "pulling", found: 0 });
    try {
      localStorage.setItem("stg_niche", q);
    } catch {}

    let res: Response;
    try {
      res = await fetch("/api/search/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: q }),
      });
    } catch {
      setView({ k: "failed" });
      return;
    }
    if (!res.ok) {
      setView({ k: "failed" });
      return;
    }
    const start = (await res.json()) as {
      runId: string;
      datasetId: string;
      fastRunId?: string;
      fastDatasetId?: string;
    };

    // Widening spans multiple polls, so all state rides in the query string
    // and is echoed straight back from each response.
    let params = new URLSearchParams({
      runId: start.runId,
      datasetId: start.datasetId,
      fastRunId: start.fastRunId ?? "",
      fastDatasetId: start.fastDatasetId ?? "",
      keyword: q,
      original: q,
      datasets: "",
      queue: "",
      used: q,
    });

    /**
     * Hard bounds on the poll loop.
     *
     * Previously this was `for(;;)` with a switch that only handled known
     * phases. Any response without a `phase` — a 401 from another tab's stale
     * session, a 502, an edge error — matched nothing, fell through, slept,
     * and retried forever. That is the "Working..." that never finishes.
     */
    const deadline = Date.now() + 4 * 60 * 1000;
    let ticks = 0;

    for (;;) {
      if (abort.current) return;
      if (Date.now() > deadline || ++ticks > 150) {
        setView({ k: "failed" });
        return;
      }

      let data: PollResponse & Record<string, string>;
      try {
        const r = await fetch(`/api/search/poll?${params.toString()}`);
        if (r.status === 401) {
          // Access cookie is gone or invalid. Reloading re-runs the server
          // gate, which shows the paywall instead of spinning forever.
          window.location.href = "/";
          return;
        }
        if (!r.ok) {
          setView({ k: "failed" });
          return;
        }
        data = await r.json();
      } catch {
        setView({ k: "failed" });
        return;
      }
      if (abort.current) return;

      // Unknown/absent phase must terminate, never fall through to the sleep.
      if (!data || typeof data.phase !== "string") {
        setView({ k: "failed" });
        return;
      }

      switch (data.phase) {
        case "pulling":
          setView((v) => ({
            k: "running",
            stage: "pulling",
            found: data.found ?? 0,
            widenedTo: v.k === "running" ? v.widenedTo : undefined,
          }));
          break;
        case "widening":
          setView({ k: "running", stage: "widening", found: 0, widenedTo: data.triedKeyword });
          params = new URLSearchParams({
            runId: data.runId,
            datasetId: data.datasetId,
            keyword: data.keyword,
            original: data.original,
            datasets: data.datasets,
            queue: data.queue,
            used: data.used,
          });
          break;
        case "done":
          if (data.provisional && data.results?.length) {
            // Feed is live now; keep polling so the full run can supply the
            // real median and reveal multipliers.
            setView({
              k: "done",
              results: data.results,
              pool: data.pool,
              datasets: data.datasets,
              meta: data.meta,
            });
            params.set("painted", "1");
            break;
          }
          saveResults({
            keyword: q,
            results: data.results,
            pool: data.pool,
            datasets: data.datasets,
            meta: data.meta,
          });
          setView({
            k: "done",
            results: data.results,
            pool: data.pool,
            datasets: data.datasets,
            meta: data.meta,
          });
          return;
        case "empty":
          setView({ k: "empty", suggestions: data.suggestions ?? [] });
          return;
        case "failed":
          setView({ k: "failed" });
          return;
        default:
          setView({ k: "failed" });
          return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, []);

  /**
   * ONE mount decision. Previously the restore effect and the auto-run effect
   * both ran in the same commit, so auto-run read a stale view.k === "idle"
   * and kicked off a fresh search before the restore landed — which is why
   * coming back from a breakdown re-fetched everything.
   */
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    const cached = loadResults();
    if (cached?.results?.length) {
      setKeyword(cached.keyword);
      setView({
        k: "done",
        results: cached.results,
        pool: cached.pool ?? [],
        datasets: cached.datasets ?? "",
        meta: cached.meta,
      });
      return;
    }

    let kw = initialKeyword;
    if (!kw) {
      try {
        kw = localStorage.getItem("stg_niche") ?? "";
      } catch {}
    }
    if (kw) {
      setKeyword(kw);
      void run(kw);
    }
  }, [initialKeyword, run]);

  // Cold arrival with no niche: open the overlay rather than showing a bare
  // input on an empty screen.
  useEffect(() => {
    if (view.k === "idle" && !keyword) setSearchOpen(true);
  }, [view.k, keyword]);

  useEffect(() => () => { abort.current = true; }, []);

  const busy = view.k === "running";
  const hasFeed = view.k === "done";

  return (
    <>
      {hasFeed && (
        <Feed
          results={view.results}
          pool={view.pool}
          datasets={view.datasets}
          meta={view.meta}
          keyword={keyword}
          onOpenSearch={() => setSearchOpen(true)}
        />
      )}

      {!hasFeed && (
        <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center px-6">
          {busy && (
            <div>
              <p className="mb-6 font-display text-[0.62rem] tracking-[0.18em] text-muted">
                {keyword.toUpperCase()}
              </p>
              <ProgressRail
                stage={view.stage}
                found={view.found}
                widenedTo={view.widenedTo}
              />
            </div>
          )}

          {view.k === "failed" && (
            <div className="rounded-[14px] border border-hair bg-white/[0.02] p-5">
              <p className="text-[0.95rem]">That search didn&apos;t come back.</p>
              <p className="mt-1.5 text-sm text-muted">
                Instagram&apos;s feed for this term may be temporarily unavailable.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => void run(keyword)}
                  className="h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-black"
                >
                  Try again
                </button>
                <button
                  onClick={() => setSearchOpen(true)}
                  className="h-11 rounded-xl border border-hair px-4 text-sm"
                >
                  New niche
                </button>
              </div>
            </div>
          )}

          {view.k === "empty" && (
            <div className="rounded-[14px] border border-hair bg-white/[0.02] p-5">
              <p className="text-[0.95rem]">
                Instagram has no popular feed for {keyword}.
              </p>
              <p className="mt-1.5 text-sm text-muted">
                It only builds them for broader terms. Try one of these:
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {view.suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => void run(s)}
                    className="h-10 rounded-full border border-hair px-4 text-sm transition-colors hover:border-accent hover:text-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {searchOpen && (
        <SearchOverlay
          initial={keyword}
          busy={busy}
          onSearch={(kw) => void run(kw)}
          onClose={() => setSearchOpen(false)}
          closable={hasFeed}
        />
      )}
    </>
  );
}
