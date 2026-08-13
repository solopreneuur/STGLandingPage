"use client";

import type { Breakdown } from "@/lib/types";

const FIELDS: { key: keyof Omit<Breakdown, "image_used">; label: string }[] = [
  { key: "hook_read", label: "HOOK" },
  { key: "mechanism", label: "MECHANISM" },
  { key: "format", label: "FORMAT" },
  { key: "steal_this", label: "STEAL THIS" },
];

export type BreakdownState =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "done"; data: Breakdown }
  | { s: "failed" };

export default function BreakdownPanel({
  state,
  onRun,
}: {
  state: BreakdownState;
  onRun: () => void;
}) {
  if (state.s === "idle") {
    return (
      <button
        onClick={onRun}
        className="w-full border-t border-hair px-3 py-3 text-left font-display text-[0.6rem] tracking-[0.16em] text-muted transition-colors hover:text-accent"
      >
        BREAK IT DOWN →
      </button>
    );
  }

  if (state.s === "loading") {
    return (
      <div className="border-t border-hair px-3 py-3">
        <div className="flex items-center gap-2.5">
          <span className="h-[7px] w-[7px] animate-pulse rounded-[2px] bg-accent" />
          <span className="font-display text-[0.6rem] tracking-[0.16em] text-muted">
            BREAKING IT DOWN
          </span>
        </div>
        {/* Skeleton lines keep the card height stable so the list doesn't
            jump as each of the 8 breakdowns lands independently. */}
        <div className="mt-3 flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="h-2 w-16 rounded bg-white/[0.06]" />
              <div className="h-2 w-full rounded bg-white/[0.04]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (state.s === "failed") {
    return (
      <div className="flex items-center justify-between border-t border-hair px-3 py-3">
        <span className="text-[0.8125rem] text-muted">Breakdown failed.</span>
        <button
          onClick={onRun}
          className="font-display text-[0.6rem] tracking-[0.16em] text-accent"
        >
          RETRY
        </button>
      </div>
    );
  }

  const { data } = state;
  return (
    <div className="border-t border-hair bg-black/20 px-3 py-3">
      <dl className="flex flex-col gap-3">
        {FIELDS.map(({ key, label }) => {
          const value = data[key];
          if (!value) return null;
          return (
            <div key={key}>
              <dt
                className={
                  key === "steal_this"
                    ? "font-display text-[0.55rem] tracking-[0.16em] text-accent"
                    : "font-display text-[0.55rem] tracking-[0.16em] text-muted"
                }
              >
                {label}
              </dt>
              <dd className="mt-1 text-[0.85rem] leading-[1.45] text-white/90">
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
      {!data.image_used && (
        <p className="mt-3 border-t border-hair pt-2 text-[0.7rem] text-muted">
          Cover frame unavailable — read from caption and metrics only.
        </p>
      )}
    </div>
  );
}
