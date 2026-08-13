"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PollResponse, Reel, SearchMeta } from "@/lib/types";
import Feed from "./Feed";
import SearchOverlay from "./SearchOverlay";
import ProgressRail, { type Stage } from "./ProgressRail";
import { saveResults, loadResults } from "@/lib/session-cache";

type View =
  | { k: "idle" }
  | { k: "running"; stage: Stage; found: number; widenedTo?: string }
  | { k: "done"; results: Reel[]; meta: SearchMeta }
  | { k: "empty"; suggestions: string[] }
  | { k: "failed" };

const POLL_MS = 2000;

export default function SearchApp({ initialKeyword }: { initialKeyword: string }) {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [view, setView] = useState<View>({ k: "idle" });
  const [searchOpen, setSearchOpen] = useState(false);
  const abort = useRef(false);

  // Restore the last feed when returning from a breakdown page, so the back
  // button doesn't silently cost another search.
  useEffect(() => {
    const cached = loadResults();
    if (cached?.results?.length) {
      setKeyword(cached.keyword);
      setView({ k: "done", results: cached.results, meta: cached.meta });
      return;
    }
    if (initialKeyword) return;
    try {
      const saved = localStorage.getItem("stg_niche");
      if (saved) setKeyword(saved);
    } catch {}
  }, [initialKeyword]);

  const run = useCallback(async (kw: string) => {
    const q = kw.trim();
    if (q.length < 2) return;
    abort.current = false;
    setKeyword(q);
    setSearchOpen(false);
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
    const start = (await res.json()) as { runId: string; datasetId: string };

    // Widening spans multiple polls, so all state rides in the query string
    // and is echoed straight back from each response.
    let params = new URLSearchParams({
      runId: start.runId,
      datasetId: start.datasetId,
      keyword: q,
      original: q,
      datasets: "",
      queue: "",
      used: q,
    });

    for (;;) {
      if (abort.current) return;
      let data: PollResponse & Record<string, string>;
      try {
        const r = await fetch(`/api/search/poll?${params.toString()}`);
        data = await r.json();
      } catch {
        setView({ k: "failed" });
        return;
      }
      if (abort.current) return;

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
          saveResults({ keyword: q, results: data.results, meta: data.meta });
          setView({ k: "done", results: data.results, meta: data.meta });
          return;
        case "empty":
          setView({ k: "empty", suggestions: data.suggestions ?? [] });
          return;
        case "failed":
          setView({ k: "failed" });
          return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, []);

  // Auto-run on arrival if they told us their niche before paying.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !keyword || view.k !== "idle") return;
    autoRan.current = true;
    void run(keyword);
  }, [keyword, view.k, run]);

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
