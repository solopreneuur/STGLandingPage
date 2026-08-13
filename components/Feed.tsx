"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Reel, SearchMeta } from "@/lib/types";
import { formatMultiplier, formatPlays } from "@/lib/score";
import { thumbSrc, videoSrc, VIDEO_ENABLED } from "@/lib/thumb";

/**
 * Full-viewport snap feed, one reel per screen — the Reels/TikTok pattern
 * rather than a scrolling list of cards.
 *
 * Only the in-view reel mounts a <video>. Reels average ~3.9MB, so mounting
 * all of them would pull hundreds of MB through the proxy on a single search.
 * Neighbours keep their poster image, which also means scrolling stays smooth
 * on a phone.
 */
export default function Feed({
  results,
  meta,
  keyword,
  onOpenSearch,
}: {
  results: Reel[];
  meta: SearchMeta;
  keyword: string;
  onOpenSearch: () => void;
}) {
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = Number((e.target as HTMLElement).dataset.i);
            if (Number.isFinite(i)) setActive(i);
          }
        }
      },
      // Fires when a slide owns most of the viewport, so `active` flips once
      // per slide rather than thrashing mid-scroll.
      { root, threshold: 0.6 }
    );
    root.querySelectorAll("[data-i]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [results.length]);

  return (
    <div className="fixed inset-0 z-10 bg-bg">
      {/* Header floats over the media */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-4">
        {/* Search is always reachable from inside the feed — tapping the
            current niche opens the overlay rather than navigating away. */}
        <button
          onClick={onOpenSearch}
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/55 py-2 pr-4 pl-3.5 backdrop-blur-sm"
        >
          <span className="text-[0.85rem] text-white/50">⌕</span>
          <span className="font-display text-[0.6rem] tracking-[0.16em] text-white">
            {keyword.toUpperCase()}
          </span>
        </button>
        <span className="pointer-events-auto rounded-full bg-black/55 px-3 py-2 text-[0.7rem] text-white/70 backdrop-blur-sm">
          <span className="font-num text-white">{active + 1}</span>/{results.length}
        </span>
      </div>

      <div
        ref={scroller}
        className="h-dvh snap-y snap-mandatory overflow-y-scroll overscroll-contain"
      >
        {results.map((reel, i) => (
          <Slide
            key={reel.shortCode}
            reel={reel}
            index={i}
            isActive={i === active}
            medianPlays={meta.medianPlays}
          />
        ))}
      </div>
    </div>
  );
}

function Slide({
  reel,
  index,
  isActive,
  medianPlays,
}: {
  reel: Reel;
  index: number;
  isActive: boolean;
  medianPlays: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const poster = thumbSrc(reel.displayUrl);
  const canPlay = VIDEO_ENABLED && Boolean(reel.videoUrl);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isActive) {
      // Muted autoplay is the only kind browsers allow without a gesture —
      // same as Instagram's own default.
      v.play().catch(() => {});
    } else {
      v.pause();
      v.currentTime = 0;
    }
  }, [isActive]);

  return (
    <section
      data-i={index}
      className="relative h-dvh w-full shrink-0 snap-start snap-always overflow-hidden bg-black"
    >
      {canPlay && isActive ? (
        <video
          ref={videoRef}
          src={videoSrc(reel.videoUrl)}
          poster={poster || undefined}
          muted
          loop
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : poster && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={poster}
          alt=""
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-white/[0.03]">
          <span className="font-num text-3xl text-white/20">
            {formatPlays(reel.plays)}
          </span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black via-black/60 to-transparent" />

      {/* Multiplier is the product's whole point, so it gets the loudest slot */}
      <div className="absolute top-16 right-4 flex flex-col items-end gap-1">
        <span className="rounded-lg bg-accent px-3 py-1.5 font-num text-[1.35rem] leading-none text-black shadow-accent">
          {formatMultiplier(reel.score)}
        </span>
        <span className="rounded bg-black/55 px-2 py-0.5 text-[0.62rem] text-white/70 backdrop-blur-sm">
          vs {formatPlays(medianPlays)} median
        </span>
      </div>

      <div className="absolute inset-x-0 bottom-0 p-5 pb-8">
        <a
          href={reel.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[1rem] font-medium text-white no-underline"
        >
          @{reel.ownerUsername}
        </a>

        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="font-num text-[1.6rem] leading-none text-white">
            {formatPlays(reel.plays)}
          </span>
          <span className="text-[0.78rem] text-white/60">plays</span>
        </div>

        {reel.caption && (
          <p
            onClick={() => setExpanded((v) => !v)}
            className={`mt-2.5 cursor-pointer text-[0.85rem] leading-[1.45] text-white/75 ${
              expanded ? "" : "line-clamp-2"
            }`}
          >
            {reel.caption}
          </p>
        )}

        <Link
          href={`/r/${reel.shortCode}`}
          className="mt-4 flex h-[52px] w-full items-center justify-center rounded-xl bg-accent text-[0.9rem] font-semibold tracking-[0.06em] text-black uppercase no-underline shadow-accent active:translate-y-px"
        >
          Break it down
        </Link>
      </div>
    </section>
  );
}
