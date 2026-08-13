"use client";

import { useState } from "react";
import Shell from "./Shell";

/**
 * Niche-first funnel.
 *
 * Step 1 asks for a niche and costs nothing — a 2-second micro-commitment
 * that gets the visitor invested before any ask. Step 2 shows the paywall
 * personalized to what they just typed, which is when desire is highest.
 *
 * We deliberately do NOT run a search before payment: it would burn ~$0.12 of
 * Apify spend on every visitor who never converts. That also means we have no
 * real result count at this point, so nothing here fabricates one.
 */
export default function Landing({ paymentLink }: { paymentLink: string }) {
  const [niche, setNiche] = useState("");
  const [asked, setAsked] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = niche.trim();
    if (v.length < 2) return;
    // Survives the Stripe round-trip; the redirect only carries session_id.
    try {
      localStorage.setItem("stg_niche", v);
    } catch {}
    setAsked(v);
  }

  // client_reference_id is restricted to [A-Za-z0-9_-], so encode. This is a
  // durable backup for the niche if localStorage is unavailable, and doubles
  // as free analytics on what people actually search.
  const ref =
    asked != null
      ? Buffer.from(asked, "utf8")
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")
      : "";
  const checkoutUrl = asked
    ? `${paymentLink}${paymentLink.includes("?") ? "&" : "?"}client_reference_id=${ref}`
    : paymentLink;

  return (
    <Shell>
      <header className="border-b border-hair pt-1.5 pb-5">
        <span className="font-display text-[clamp(1.05rem,5vw,1.35rem)] tracking-[0.02em]">
          STUDYTHEGAME
        </span>
      </header>

      <main className="flex flex-1 flex-col pt-12 pb-10">
        {asked === null ? (
          <>
            <h1 className="m-0 text-[clamp(2rem,8.5vw,2.75rem)] leading-[1.06] font-semibold tracking-[-0.025em]">
              Some reel in your niche just did{" "}
              <span className="font-num text-accent">25×</span> the average.
            </h1>
            <p className="mt-4 text-[clamp(1.05rem,4.5vw,1.2rem)] leading-[1.4] text-muted">
              Find out which. And why.
            </p>

            <form onSubmit={submit} className="mt-9 flex flex-col gap-3">
              <label htmlFor="niche" className="sr-only">
                Your niche
              </label>
              <input
                id="niche"
                value={niche}
                onChange={(e) => setNiche(e.target.value)}
                placeholder="home gym"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={60}
                className="h-[54px] w-full appearance-none rounded-xl border border-hair bg-field px-4 text-base text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] outline-none transition-colors placeholder:text-muted focus:border-hairfocus"
              />
              <button
                type="submit"
                disabled={niche.trim().length < 2}
                className="h-[54px] w-full rounded-xl bg-accent px-5 text-[0.95rem] font-semibold tracking-[0.06em] text-black uppercase shadow-accent transition-opacity hover:opacity-90 active:translate-y-px disabled:opacity-35 disabled:shadow-none"
              >
                Find the outliers
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="mb-[18px] flex items-center gap-2.5 font-display text-[0.7rem] tracking-[0.18em] text-muted">
              <span className="h-[9px] w-[9px] rounded-[2px] bg-accent shadow-[0_0_12px_rgba(250,255,0,0.55)]" />
              {asked.toUpperCase()}
            </p>

            <h1 className="m-0 text-[clamp(1.9rem,7.5vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.025em]">
              Ready to break down{" "}
              <span className="text-accent">{asked}</span>.
            </h1>

            {/* No subline by design. They already committed by typing a niche;
                re-explaining the product here adds doubt rather than
                confidence. Headline + button carry it. */}

            <a
              href={checkoutUrl}
              className="mt-8 flex h-[54px] w-full items-center justify-center rounded-xl bg-accent px-5 text-[0.95rem] font-semibold tracking-[0.06em] text-black uppercase shadow-accent transition-opacity hover:opacity-90 active:translate-y-px"
            >
              Unlock for $1
            </a>
            <p className="mt-3.5 text-center text-[0.8125rem] text-muted">
              One-time <span className="font-num text-white">$1</span>. No account.
            </p>

            <button
              onClick={() => setAsked(null)}
              className="mt-5 self-center text-[0.8125rem] text-muted underline underline-offset-4 transition-colors hover:text-white"
            >
              change niche
            </button>
          </>
        )}
      </main>

      <footer className="mt-6 border-t border-hair pt-5">
        <a
          href="https://instagram.com/huzzybuilds"
          className="text-sm text-muted no-underline transition-colors hover:text-white"
        >
          @huzzybuilds
        </a>
      </footer>
    </Shell>
  );
}
