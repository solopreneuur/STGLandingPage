"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Reel, SearchMeta } from "@/lib/types";
import { formatMultiplier, formatPlays } from "@/lib/score";
import { thumbSrc, videoSrc, VIDEO_ENABLED } from "@/lib/thumb";
import {
  prefetchBreakdown,
  saveActiveIndex,
  getActiveIndex,
  getSoundOn,
  saveSoundOn,
  appendResults,
  getTopups,
} from "@/lib/session-cache";
import GoDeeper from "./GoDeeper";

/**
 * Full-viewport snap feed, one reel per screen — the Reels/TikTok pattern
 * rather than a scrolling list of cards.
 *
 * Only the in-view reel mounts a <video>. Reels average ~3.9MB, so mounting
 * all of them would pull hundreds of MB through the proxy on a single search.
 * Neighbours keep their poster image, which also means scrolling stays smooth
 * on a phone.
 */
/** Start fetching the next window when this many slides remain ahead. */
const LOOKAHEAD = 6;
/** Reels judged per just-in-time call. ~3s, and it happens off-screen. */
const WINDOW = 10;
/** Extra Apify runs a single feed may trigger by scrolling. */
const MAX_TOPUPS = 2;

export default function Feed({
  results,
  pool,
  datasets,
  meta,
  keyword,
  paid,
  paymentLink,
  onOpenSearch,
}: {
  results: Reel[];
  pool: Reel[];
  datasets: string;
  meta: SearchMeta;
  keyword: string;
  paid: boolean;
  paymentLink: string;
  onOpenSearch: () => void;
}) {
  const [active, setActive] = useState(0);
  const [slides, setSlides] = useState<Reel[]>(results);
  const [remaining, setRemaining] = useState<Reel[]>(pool);
  const [loadingMore, setLoadingMore] = useState(false);
  // Feed-level, not per-slide: unmuting once should hold as you keep scrolling.
  const [soundOn, setSoundOn] = useState(false);

  // Read after mount so the server and first client render agree.
  useEffect(() => setSoundOn(getSoundOn()), []);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      saveSoundOn(!on);
      return !on;
    });
  }, []);

  /** Autoplay with sound was refused; reflect reality rather than lying. */
  const forceMute = useCallback(() => {
    saveSoundOn(false);
    setSoundOn(false);
  }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const inflight = useRef(false);
  // Seeded from the session, not zero. App Router unmounts Feed on every
  // navigation into /r/, so a per-mount ref handed the user a fresh pair of
  // billed Apify runs every single time they came back from a breakdown.
  const toppedUp = useRef(0);
  useEffect(() => {
    toppedUp.current = getTopups(keyword);
  }, [keyword]);

  const prevKeyword = useRef(keyword);
  const restored = useRef(false);

  // A new search replaces both lists — and only a NEW NICHE returns to the
  // top. This effect also runs on every remount, so resetting unconditionally
  // is what sent the user back to slide 1 every time they came back from a reel.
  useEffect(() => {
    setSlides(results);
    setRemaining(pool);
    if (prevKeyword.current !== keyword) {
      prevKeyword.current = keyword;
      // Re-arm the restore rather than forcing the top: switching to a niche
      // held in the session cache keeps Feed mounted, and that niche may well
      // have a position worth returning to.
      restored.current = false;
      setActive(0);
    }
  }, [results, pool, keyword]);

  // Restore the slide they left off on, once, after the slides exist.
  useEffect(() => {
    if (restored.current || slides.length === 0) return;
    const i = getActiveIndex(keyword);
    if (i <= 0) {
      restored.current = true;
      return;
    }
    // A saved index can sit beyond what has loaded so far — the position was
    // recorded in appended slides. Leave the guard UNARMED so this re-fires
    // once the feed grows, instead of silently dropping the user at the top.
    if (i >= slides.length) return;

    restored.current = true;
    const el = scroller.current?.querySelector(`[data-i="${i}"]`);
    // Instant, never smooth: an animated scroll on mount reads as the page
    // running away from you.
    el?.scrollIntoView({ behavior: "auto" });
    setActive(i);
  }, [slides.length, keyword]);

  useEffect(() => {
    // Never write before the restore has run, or this stores the placeholder
    // 0 from the first render and erases the position it is waiting to read.
    if (!restored.current) return;
    saveActiveIndex(keyword, active);
  }, [keyword, active]);

  /**
   * Judge the next window before the user reaches it. Slides are only ever
   * APPENDED — filtering in place would shrink the feed under the user's
   * thumb, which is worse than waiting for it.
   */
  useEffect(() => {
    if (inflight.current) return;
    // active can now equal slides.length on the terminal paywall slide.
    if (Math.min(active, slides.length - 1) < slides.length - LOOKAHEAD) return;

    // Pool exhausted: pull another sample from Apify rather than ending the
    // feed. The initial run is only 25 precisely because most sessions never
    // get here.
    if (remaining.length === 0) {
      if (toppedUp.current >= MAX_TOPUPS) return;
      toppedUp.current++;
      inflight.current = true;
      setLoadingMore(true);
      (async () => {
        try {
          const res = await fetch("/api/search/more", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              keyword,
              exclude: slides.map((r) => r.shortCode),
              medianPlays: meta.medianPlays,
              metric: meta.metric,
            }),
          });
          const { results: more } = (await res.json()) as { results: Reel[] };
          if (more?.length) {
            setSlides((prev) => [...prev, ...more]);
            // Persist both the reels and the spend, so coming back from a reel
            // neither loses them nor re-buys them.
            appendResults(keyword, more, toppedUp.current);
          }
        } catch {
          // No more reels is an acceptable end state.
        } finally {
          setLoadingMore(false);
          inflight.current = false;
        }
      })();
      return;
    }

    inflight.current = true;
    setLoadingMore(true);
    const batch = remaining.slice(0, WINDOW);

    (async () => {
      try {
        const res = await fetch("/api/filter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            datasets: datasets ? datasets.split(",").filter(Boolean) : [],
            shortCodes: batch.map((r) => r.shortCode),
          }),
        });
        const { verdicts } = (await res.json()) as {
          verdicts: { shortCode: string; keep: boolean; confidence: number }[];
        };
        const byCode = new Map(verdicts.map((v) => [v.shortCode, v]));
        const kept = batch
          // No verdict means unjudged, and an unjudged reel is shown rather
          // than silently dropped — same rule the server uses.
          .filter((r) => byCode.get(r.shortCode)?.keep !== false)
          .map((r) => ({
            ...r,
            confidence: byCode.get(r.shortCode)?.confidence ?? 0.5,
          }));
        setSlides((prev) => [...prev, ...kept]);
      } catch {
        // Filtering failed: show the window unjudged rather than stall.
        setSlides((prev) => [...prev, ...batch]);
      } finally {
        setRemaining((prev) => prev.slice(WINDOW));
        setLoadingMore(false);
        inflight.current = false;
      }
    })();
  }, [active, slides, remaining, datasets, keyword, meta.medianPlays, meta.metric]);

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
    // Depend on the ARRAY, not its length. Slides are keyed by shortCode, so a
    // niche change replaces every node — and a new niche with the same count
    // left the observer bound to detached nodes, freezing `active` at 0. Nine
    // of the thirteen live niches collide on length, so an A -> B -> A search
    // hit it. Re-querying the DOM on an extra render is cheap.
  }, [slides]);

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
        <div className="flex items-center gap-2">
          <button
            onClick={toggleSound}
            aria-label={soundOn ? "Mute" : "Unmute"}
            aria-pressed={soundOn}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-[0.9rem] text-white backdrop-blur-sm"
          >
            {soundOn ? "🔊" : "🔇"}
          </button>
          <span className="pointer-events-auto rounded-full bg-black/55 px-3 py-2 text-[0.7rem] text-white/70 backdrop-blur-sm">
            <span className="font-num text-white">
              {Math.min(active + 1, slides.length)}
            </span>
            /{slides.length}
            {remaining.length > 0 ? "+" : ""}
          </span>
        </div>
      </div>

      {loadingMore && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
          <span className="rounded-full bg-black/60 px-3 py-1.5 text-[0.65rem] text-white/70 backdrop-blur-sm">
            finding more…
          </span>
        </div>
      )}

      <div
        ref={scroller}
        className="h-dvh snap-y snap-mandatory overflow-y-scroll overscroll-contain"
      >
        {/* The paid artifact sits at the END of the feed: offered only after
            they have actually seen the reels it reads across. */}
        {slides.map((reel, i) => (
          <Slide
            key={reel.shortCode}
            reel={reel}
            index={i}
            isActive={i === active}
            medianPlays={meta.medianPlays}
            soundOn={soundOn}
            onAutoplayBlocked={forceMute}
          />
        ))}
        {remaining.length === 0 && slides.length > 0 && (
          <section
            // Observable like any slide. Without it nothing could move `active`
            // past the final reel, so that reel stayed mounted and — once sound
            // shipped — looped audibly underneath the $1 paywall.
            data-i={slides.length}
            className="flex min-h-dvh w-full snap-start snap-always flex-col justify-center bg-bg px-6 py-12"
          >
            <div className="mx-auto w-full max-w-[480px]">
              <GoDeeper
                keyword={keyword}
                reels={slides}
                paid={paid}
                paymentLink={paymentLink}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Slide({
  reel,
  index,
  isActive,
  medianPlays,
  soundOn,
  onAutoplayBlocked,
}: {
  reel: Reel;
  index: number;
  isActive: boolean;
  medianPlays: number;
  soundOn: boolean;
  onAutoplayBlocked: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const poster = thumbSrc(reel.displayUrl);
  const canPlay = VIDEO_ENABLED && Boolean(reel.videoUrl);

  // Start the breakdown only once the reel has been on screen a moment, so
  // scrolling straight past a reel never pays for one.
  useEffect(() => {
    if (!isActive) return;
    const t = setTimeout(() => {
      prefetchBreakdown({
        shortCode: reel.shortCode,
        caption: reel.caption,
        plays: reel.plays,
        score: reel.score,
        ownerUsername: reel.ownerUsername,
        timestamp: reel.timestamp,
        displayUrl: reel.displayUrl,
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [isActive, reel]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!isActive) {
      v.pause();
      v.currentTime = 0;
      return;
    }
    // Muted autoplay is the only kind browsers allow without a gesture. Once
    // the user has tapped the sound control that gesture exists, so unmuted
    // playback is allowed — but Safari in particular can still refuse on a
    // later slide, and a silent refusal would leave the speaker icon claiming
    // sound that is not playing.
    v.muted = !soundOn;
    v.play().catch((err: DOMException) => {
      // Only NotAllowedError means "the browser refused sound". Scrolling
      // tears the element down mid-buffer (AbortError) and a dead Instagram
      // CDN url 502s through the proxy (NotSupportedError) — treating either
      // as a refusal muted the whole feed for an unrelated reason, and retried
      // play() on a detached element, streaming ~4MB for a reel off screen.
      if (videoRef.current !== v) return;
      if (err?.name !== "NotAllowedError" || v.muted) return;
      v.muted = true;
      onAutoplayBlocked();
      v.play().catch(() => {});
    });
  }, [isActive, soundOn, onAutoplayBlocked]);

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
          // The effect above owns the muted property; this is only the initial
          // value, and it must stay true so first autoplay is never refused.
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
        {reel.score > 0 ? (
          <span className="rounded-lg bg-accent px-3 py-1.5 font-num text-[1.35rem] leading-none text-black shadow-accent">
            {formatMultiplier(reel.score)}
          </span>
        ) : (
          /* Painted from the fast run: the median is not final yet, and a
             wrong multiplier is worse than a visibly pending one. */
          <span className="animate-pulse rounded-lg bg-white/15 px-3 py-1.5 font-num text-[1.35rem] leading-none text-white/40">
            ·
          </span>
        )}
        {medianPlays > 0 && (
          <span className="rounded bg-black/55 px-2 py-0.5 text-[0.62rem] text-white/70 backdrop-blur-sm">
            vs {formatPlays(medianPlays)} median
          </span>
        )}
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
