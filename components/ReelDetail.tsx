"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Breakdown, Reel } from "@/lib/types";
import { formatMultiplier, formatPlays } from "@/lib/score";
import { findReel } from "@/lib/session-cache";
import { thumbSrc } from "@/lib/thumb";
import Rich from "./Rich";
import type { Tier } from "@/lib/types";

type State =
  | { s: "loading" }
  | { s: "gone" }
  | { s: "ready"; reel: Reel; bd: "loading" | "failed" | Breakdown };

export default function ReelDetail({ shortCode }: { shortCode: string }) {
  const [state, setState] = useState<State>({ s: "loading" });
  const [imgFailed, setImgFailed] = useState(false);
  const ran = useRef(false);

  const fetchBreakdown = useCallback(async (reel: Reel) => {
    setState({ s: "ready", reel, bd: "loading" });
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
      setState({ s: "ready", reel, bd: (await res.json()) as Breakdown });
    } catch {
      setState({ s: "ready", reel, bd: "failed" });
    }
  }, []);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const hit = findReel(shortCode);
    if (!hit) {
      setState({ s: "gone" });
      return;
    }
    void fetchBreakdown(hit.reel);
  }, [shortCode, fetchBreakdown]);

  if (state.s === "loading") {
    return <div className="py-24 text-center text-sm text-muted">Loading…</div>;
  }

  // sessionStorage is per-tab; a shared or reopened link has no cached reel.
  if (state.s === "gone") {
    return (
      <div className="mx-auto max-w-[480px] px-6 py-24">
        <p className="text-[0.95rem]">That reel isn&apos;t in this session.</p>
        <p className="mt-1.5 text-sm text-muted">
          Results live in your browser only — run the search again to see it.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-11 items-center rounded-xl border border-hair px-4 text-sm no-underline"
        >
          Back to search
        </Link>
      </div>
    );
  }

  const { reel, bd } = state;
  const poster = thumbSrc(reel.displayUrl);

  return (
    <div className="min-h-dvh">
      {/* Media banner keeps the reel present while reading the analysis, and
          the whole thing is a tap target to the original on Instagram. */}
      <div className="relative h-[38dvh] w-full overflow-hidden bg-black">
        <a
          href={reel.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open @${reel.ownerUsername}'s reel on Instagram`}
          className="absolute inset-0 z-10 block"
        >
          {poster && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={poster}
              alt=""
              onError={() => setImgFailed(true)}
              className="h-full w-full object-cover opacity-70"
            />
          ) : (
            <div className="h-full w-full bg-white/[0.03]" />
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-bg/60" />
          <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-4 py-2.5 text-[0.78rem] text-white backdrop-blur-sm">
            ▶ Watch on Instagram
          </span>
        </a>

        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between p-4">
          <Link
            href="/"
            className="rounded-full bg-black/55 px-3.5 py-2 font-display text-[0.6rem] tracking-[0.16em] text-white no-underline backdrop-blur-sm"
          >
            ← FEED
          </Link>
          <span className="rounded-lg bg-accent px-3 py-1.5 font-num text-[1.2rem] leading-none text-black shadow-accent">
            {formatMultiplier(reel.score)}
          </span>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 mx-auto max-w-[480px] px-6 pb-4">
          <a
            href={`https://www.instagram.com/${reel.ownerUsername}/`}
            target="_blank"
            rel="noreferrer noopener"
            className="pointer-events-auto text-[0.95rem] font-medium text-white no-underline"
          >
            @{reel.ownerUsername} ↗
          </a>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-num text-[1.4rem] leading-none text-white">
              {formatPlays(reel.plays)}
            </span>
            <span className="text-[0.75rem] text-white/50">plays</span>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[480px] px-6 pt-6 pb-16">
        {bd === "loading" && (
          <div className="flex items-center gap-2.5">
            <span className="h-[7px] w-[7px] animate-pulse rounded-[2px] bg-accent" />
            <span className="font-display text-[0.62rem] tracking-[0.16em] text-muted">
              BREAKING IT DOWN
            </span>
          </div>
        )}

        {bd === "failed" && (
          <div className="flex items-center justify-between rounded-[14px] border border-hair p-4">
            <span className="text-[0.875rem] text-muted">Breakdown failed.</span>
            <button
              onClick={() => void fetchBreakdown(reel)}
              className="font-display text-[0.62rem] tracking-[0.16em] text-accent"
            >
              RETRY
            </button>
          </div>
        )}

        {typeof bd === "object" && (
          <>
            {/* The one thing they can act on leads, at the largest size.
                Everything else is supporting evidence and is set quieter and
                tighter so the page scans instead of reading as an essay. */}
            <div className="rounded-2xl border border-accent/30 bg-accent/[0.05] p-5">
              <span className="font-display text-[0.6rem] tracking-[0.16em] text-accent">
                STEAL THIS
              </span>
              <p className="mt-2.5 text-[1.05rem] leading-[1.4] font-medium text-white">
                <Rich text={bd.steal_this} />
              </p>
            </div>

            <div className="mt-7">
              {(
                [
                  ["hook_read", "HOOK"],
                  ["mechanism", "WHY IT WORKED"],
                  ["format", "FORMAT"],
                ] as const
              ).map(([key, label], i) => (
                <Section
                  key={key}
                  label={label}
                  tier={bd[key]}
                  divided={i > 0}
                />
              ))}
            </div>

            {!bd.image_used && (
              <p className="mt-6 text-[0.7rem] text-muted">
                Cover frame unavailable — read from caption and metrics only.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Two-tier section. The punch is the verdict and is always on screen; the
 * detail is the reasoning and is COLLAPSED, not truncated, so the full text
 * is exactly one tap away. Four equal paragraphs was the thing that made the
 * page read as a wall of text.
 */
function Section({
  label,
  tier,
  divided,
}: {
  label: string;
  tier: Tier;
  divided: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(tier?.detail?.trim());

  return (
    <div className={divided ? "mt-5 border-t border-hair pt-5" : ""}>
      <div className="font-display text-[0.58rem] tracking-[0.16em] text-muted">
        {label}
      </div>
      <p className="mt-1.5 text-[0.95rem] leading-[1.45] text-white">
        <Rich text={tier?.punch ?? ""} />
      </p>

      {hasDetail && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-2 flex items-center gap-1.5 text-[0.78rem] text-muted transition-colors hover:text-white"
          >
            <span
              className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
            >
              ›
            </span>
            {open ? "less" : "more"}
          </button>
          {open && (
            <p className="mt-2 text-[0.875rem] leading-[1.55] text-white/70">
              <Rich text={tier.detail} />
            </p>
          )}
        </>
      )}
    </div>
  );
}
