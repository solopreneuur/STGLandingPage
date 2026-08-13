"use client";

import { useEffect, useRef, useState } from "react";

const SUGGESTED = [
  "home gym",
  "tech",
  "cooking",
  "travel",
  "finance",
  "fashion",
  "cars",
  "dog training",
];

/**
 * Search lives on top of the feed rather than on its own screen.
 *
 * A dedicated search page meant arriving at a bare input on an empty dark
 * viewport — nothing to look at and nothing to do. As an overlay it keeps the
 * feed visible behind it, and the suggestion chips give an obvious next tap
 * instead of a blinking cursor.
 */
export default function SearchOverlay({
  initial,
  chips,
  busy,
  onSearch,
  onClose,
  closable,
}: {
  initial: string;
  /** Cached niches, most-hit first. Tapping one is instant by definition. */
  chips: string[];
  busy: boolean;
  onSearch: (kw: string) => void;
  onClose: () => void;
  /** First load has nothing behind it, so there is nothing to close back to. */
  closable: boolean;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closable, onClose]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (v.length >= 2) onSearch(v);
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg/92 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col px-6 pt-6">
        <div className="flex items-center justify-between">
          <span className="font-display text-[1.05rem] tracking-[0.02em]">
            STUDYTHEGAME
          </span>
          {closable && (
            <button
              onClick={onClose}
              className="font-display text-[0.62rem] tracking-[0.16em] text-muted transition-colors hover:text-white"
            >
              CLOSE
            </button>
          )}
        </div>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-3">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="what's your niche?"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={60}
            disabled={busy}
            className="h-[56px] w-full appearance-none rounded-xl border border-hair bg-field px-4 text-[1.05rem] text-white outline-none transition-colors placeholder:text-muted focus:border-hairfocus disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || value.trim().length < 2}
            className="h-[54px] w-full rounded-xl bg-accent px-5 text-[0.95rem] font-semibold tracking-[0.06em] text-black uppercase shadow-accent transition-opacity active:translate-y-px disabled:opacity-30 disabled:shadow-none"
          >
            {busy ? "Working…" : "Find the outliers"}
          </button>
        </form>

        <p className="mt-9 font-display text-[0.6rem] tracking-[0.16em] text-muted">
          {chips.length > 0 ? "OR EXPLORE" : "TRY"}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(chips.length > 0 ? chips : SUGGESTED).map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => {
                setValue(s);
                onSearch(s);
              }}
              className="h-10 rounded-full border border-hair px-4 text-[0.85rem] text-white/80 transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
