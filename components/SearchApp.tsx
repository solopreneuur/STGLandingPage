"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PollResponse, Reel, SearchMeta } from "@/lib/types";
import ResultCard from "./ResultCard";
import ProgressRail, { type Stage } from "./ProgressRail";

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
  const abort = useRef(false);

  // The niche they typed before paying. The `n` param wins; localStorage is
  // the fallback when Stripe didn't carry client_reference_id.
  useEffect(() => {
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

    // Widening spans multiple polls, so all state is carried in the query
    // string and echoed straight back from each response.
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

  // Auto-run once on arrival if they already told us their niche pre-payment.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !keyword || view.k !== "idle") return;
    autoRan.current = true;
    void run(keyword);
  }, [keyword, view.k, run]);

  useEffect(() => () => { abort.current = true; }, []);

  const busy = view.k === "running";

  return (
    <>
      <header className="flex items-center justify-between border-b border-hair pt-1.5 pb-5">
        <span className="font-display text-[clamp(1.05rem,5vw,1.35rem)] tracking-[0.02em]">
          STUDYTHEGAME
        </span>
        <span className="font-display text-[0.6rem] tracking-[0.18em] text-success">
          UNLOCKED
        </span>
      </header>

      <main className="flex flex-1 flex-col pt-7 pb-10">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(keyword);
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="kw" className="sr-only">Niche</label>
          <input
            id="kw"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="home gym"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={60}
            disabled={busy}
            className="h-[54px] w-full appearance-none rounded-xl border border-hair bg-field px-4 text-base text-white outline-none transition-colors placeholder:text-muted focus:border-hairfocus disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || keyword.trim().length < 2}
            className="h-[54px] w-full rounded-xl bg-accent px-5 text-[0.95rem] font-semibold tracking-[0.06em] text-black uppercase shadow-accent transition-opacity hover:opacity-90 active:translate-y-px disabled:opacity-35 disabled:shadow-none"
          >
            {busy ? "Working…" : "Find the outliers"}
          </button>
        </form>

        {view.k === "running" && (
          <ProgressRail stage={view.stage} found={view.found} widenedTo={view.widenedTo} />
        )}

        {view.k === "failed" && (
          <div className="mt-8 rounded-[14px] border border-hair bg-white/[0.02] p-5">
            <p className="text-[0.95rem]">That search didn&apos;t come back.</p>
            <p className="mt-1.5 text-sm text-muted">
              Instagram&apos;s feed for this term may be temporarily unavailable.
            </p>
            <button
              onClick={() => void run(keyword)}
              className="mt-4 h-11 rounded-xl border border-hair px-4 text-sm transition-colors hover:border-hairfocus"
            >
              Try again
            </button>
          </div>
        )}

        {view.k === "empty" && (
          <div className="mt-8 rounded-[14px] border border-hair bg-white/[0.02] p-5">
            <p className="text-[0.95rem]">
              Instagram has no popular feed for that niche yet.
            </p>
            <p className="mt-1.5 text-sm text-muted">
              It only builds them for broader terms. Try one of these:
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {view.suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setKeyword(s);
                    void run(s);
                  }}
                  className="h-10 rounded-full border border-hair px-4 text-sm transition-colors hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {view.k === "done" && <Results results={view.results} meta={view.meta} />}
      </main>

      <footer className="mt-6 border-t border-hair pt-5">
        <a
          href="https://instagram.com/huzzybuilds"
          className="text-sm text-muted no-underline transition-colors hover:text-white"
        >
          @huzzybuilds
        </a>
      </footer>
    </>
  );
}

function Results({ results, meta }: { results: Reel[]; meta: SearchMeta }) {
  const solid = results.filter((r) => r.confidence >= 0.6);
  const borderline = results.filter((r) => r.confidence < 0.6);

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.8125rem] text-muted">
        <span>
          <span className="font-num text-white">{results.length}</span> reels
        </span>
        <span aria-hidden>·</span>
        <span>
          median{" "}
          <span className="font-num text-white">
            {meta.medianPlays.toLocaleString()}
          </span>{" "}
          {meta.metric}
        </span>
        {!meta.filtered && (
          <span className="rounded border border-hair px-1.5 py-0.5 font-display text-[0.55rem] tracking-[0.14em]">
            UNFILTERED
          </span>
        )}
        {meta.partial && (
          <span className="rounded border border-hair px-1.5 py-0.5 font-display text-[0.55rem] tracking-[0.14em]">
            PARTIAL
          </span>
        )}
      </div>

      {meta.keywordsUsed.length > 1 && (
        <p className="mt-2 text-[0.8125rem] text-muted">
          also searched{" "}
          <span className="text-white">{meta.keywordsUsed.slice(1).join(", ")}</span>
        </p>
      )}

      <ol className="mt-5 flex flex-col gap-3">
        {solid.map((r, i) => (
          <ResultCard key={r.shortCode} reel={r} rank={i + 1} autoBreakdown={i < 8} />
        ))}
      </ol>

      {borderline.length > 0 && (
        <>
          <div className="mt-8 mb-3 flex items-center gap-3">
            <span className="h-px flex-1 bg-hair" />
            <span className="font-display text-[0.6rem] tracking-[0.16em] text-muted">
              LESS CERTAIN
            </span>
            <span className="h-px flex-1 bg-hair" />
          </div>
          <ol className="flex flex-col gap-3 opacity-70">
            {borderline.map((r, i) => (
              <ResultCard
                key={r.shortCode}
                reel={r}
                rank={solid.length + i + 1}
                autoBreakdown={false}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
