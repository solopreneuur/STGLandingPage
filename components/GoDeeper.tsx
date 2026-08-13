"use client";

import { useCallback, useState } from "react";
import type { Reel } from "@/lib/types";
import Rich from "./Rich";

interface Synthesis {
  headline: string;
  patterns: { punch: string; detail: string }[];
  do_next: string;
}

type State =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "done"; data: Synthesis }
  | { s: "failed" };

/**
 * The paid artifact.
 *
 * Everything else in the product is free, so this is the only place money is
 * ever mentioned. It reads across the whole niche at once — the one thing a
 * user genuinely cannot get by scrolling the feed themselves.
 */
export default function GoDeeper({
  keyword,
  reels,
  paid,
  paymentLink,
}: {
  keyword: string;
  reels: Reel[];
  paid: boolean;
  paymentLink: string;
}) {
  const [state, setState] = useState<State>({ s: "idle" });

  const run = useCallback(async () => {
    setState({ s: "loading" });
    try {
      const res = await fetch("/api/synthesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword, reels: reels.slice(0, 25) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState({ s: "done", data: (await res.json()) as Synthesis });
    } catch {
      setState({ s: "failed" });
    }
  }, [keyword, reels]);

  // Carry the niche through Stripe so they land back on the same feed.
  const ref = Buffer.from(keyword, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const checkout = `${paymentLink}${paymentLink.includes("?") ? "&" : "?"}client_reference_id=${ref}`;

  if (!paid) {
    return (
      <div className="rounded-2xl border border-accent/30 bg-accent/[0.05] p-5">
        <span className="font-display text-[0.6rem] tracking-[0.16em] text-accent">
          GO DEEPER
        </span>
        <p className="mt-2.5 text-[1.05rem] leading-[1.35] font-medium text-white">
          What&apos;s the pattern across all{" "}
          <span className="font-num">{reels.length}</span> of these?
        </p>
        <p className="mt-2 text-[0.85rem] leading-[1.45] text-muted">
          One read across the whole niche — the formats winning right now, what
          the top performers share, and the move to run next.
        </p>
        <a
          href={checkout}
          className="mt-4 flex h-[52px] w-full items-center justify-center rounded-xl bg-accent text-[0.9rem] font-semibold tracking-[0.06em] text-black uppercase no-underline shadow-accent active:translate-y-px"
        >
          Unlock for $1
        </a>
        <p className="mt-2.5 text-center text-[0.75rem] text-muted">
          One-time. Every niche, forever.
        </p>
      </div>
    );
  }

  if (state.s === "idle") {
    return (
      <button
        onClick={() => void run()}
        className="flex h-[52px] w-full items-center justify-center rounded-xl bg-accent text-[0.9rem] font-semibold tracking-[0.06em] text-black uppercase shadow-accent active:translate-y-px"
      >
        Go deeper on {keyword}
      </button>
    );
  }

  if (state.s === "loading") {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl border border-hair p-5">
        <span className="h-[7px] w-[7px] animate-pulse rounded-[2px] bg-accent" />
        <span className="font-display text-[0.62rem] tracking-[0.16em] text-muted">
          READING THE WHOLE NICHE
        </span>
      </div>
    );
  }

  if (state.s === "failed") {
    return (
      <div className="flex items-center justify-between rounded-2xl border border-hair p-4">
        <span className="text-[0.875rem] text-muted">That didn&apos;t come back.</span>
        <button
          onClick={() => void run()}
          className="font-display text-[0.62rem] tracking-[0.16em] text-accent"
        >
          RETRY
        </button>
      </div>
    );
  }

  const { data } = state;
  return (
    <div className="rounded-2xl border border-accent/30 bg-accent/[0.05] p-5">
      <span className="font-display text-[0.6rem] tracking-[0.16em] text-accent">
        {keyword.toUpperCase()} — THE PATTERN
      </span>
      <p className="mt-2.5 text-[1.1rem] leading-[1.35] font-medium text-white">
        <Rich text={data.headline} />
      </p>

      <div className="mt-5">
        {data.patterns.map((p, i) => (
          <div key={i} className={i > 0 ? "mt-4 border-t border-hair pt-4" : ""}>
            <p className="text-[0.95rem] leading-[1.45] text-white">
              <Rich text={p.punch} />
            </p>
            <p className="mt-1.5 text-[0.85rem] leading-[1.5] text-white/70">
              <Rich text={p.detail} />
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5 border-t border-accent/25 pt-4">
        <span className="font-display text-[0.58rem] tracking-[0.16em] text-accent">
          DO NEXT
        </span>
        <p className="mt-1.5 text-[0.95rem] leading-[1.45] font-medium text-white">
          <Rich text={data.do_next} />
        </p>
      </div>
    </div>
  );
}
