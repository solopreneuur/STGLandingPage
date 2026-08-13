"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Breakdown, Reel } from "@/lib/types";
import { formatMultiplier, formatPlays } from "@/lib/score";
import BreakdownPanel, { type BreakdownState } from "./BreakdownPanel";

function agoLabel(ts: string): string {
  const d = Date.parse(ts);
  if (!Number.isFinite(d)) return "";
  const days = Math.floor((Date.now() - d) / 864e5);
  if (days < 31) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`;
}

export default function ResultCard({
  reel,
  rank,
  autoBreakdown = false,
}: {
  reel: Reel;
  rank: number;
  /** Top 8 auto-run; the rest are tap-to-load. */
  autoBreakdown?: boolean;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [bd, setBd] = useState<BreakdownState>({ s: "idle" });
  const started = useRef(false);

  const run = useCallback(async () => {
    if (started.current && bd.s === "loading") return;
    started.current = true;
    setBd({ s: "loading" });
    try {
      const res = await fetch("/api/breakdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shortCode: reel.shortCode,
          caption: reel.caption,
          plays: reel.plays,
          score: reel.score,
          ownerUsername: reel.ownerUsername,
          timestamp: reel.timestamp,
          displayUrl: reel.displayUrl,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setBd({ s: "done", data: (await res.json()) as Breakdown });
    } catch {
      // One card failing never blocks the others — each retries on its own.
      setBd({ s: "failed" });
    }
  }, [reel, bd.s]);

  // Fire the top 8 immediately and let each land independently, so results
  // are readable while the rest are still working.
  useEffect(() => {
    if (autoBreakdown && !started.current) void run();
  }, [autoBreakdown, run]);

  return (
    <li className="overflow-hidden rounded-[14px] border border-hair bg-white/[0.02]">
      <div className="flex gap-3 p-3">
        <div className="relative h-[104px] w-[72px] shrink-0 overflow-hidden rounded-lg bg-black/40">
          {reel.displayUrl && !thumbFailed ? (
            /* Plain <img>, deliberately not next/image: Hobby image
               optimization is capped at 1,000 source images/month (~20
               searches) and the optimizer proxies from Vercel IPs, which is
               exactly what the Instagram CDN blocks. referrerPolicy is
               load-bearing — IG rejects on Referer. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={reel.displayUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setThumbFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center border border-accent/25 bg-black/40">
              <span className="font-num text-[0.7rem] text-accent">
                {formatPlays(reel.plays)}
              </span>
            </div>
          )}
          <span className="absolute top-1 left-1 rounded bg-black/70 px-1 font-num text-[0.6rem] text-white">
            {rank}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-2">
              <a
                href={reel.url}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate text-[0.95rem] font-medium text-white no-underline hover:underline"
              >
                @{reel.ownerUsername}
              </a>
              <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 font-num text-[0.8rem] text-black">
                {formatMultiplier(reel.score)}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-[0.8125rem] leading-snug text-muted">
              {reel.caption || "—"}
            </p>
          </div>

          <div className="mt-2 flex items-center gap-2 text-[0.75rem] text-muted">
            <span className="font-num text-white">{formatPlays(reel.plays)}</span>
            <span>plays</span>
            {reel.timestamp && (
              <>
                <span aria-hidden>·</span>
                <span>{agoLabel(reel.timestamp)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <BreakdownPanel state={bd} onRun={() => void run()} />
    </li>
  );
}
