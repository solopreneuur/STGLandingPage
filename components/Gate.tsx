const PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK_URL ?? "#";

export default function Gate() {
  return (
    <>
      <header className="border-b border-hair pt-1.5 pb-5">
        <span className="font-display text-[clamp(1.05rem,5vw,1.35rem)] tracking-[0.02em]">
          STUDYTHEGAME
        </span>
      </header>

      <main className="flex flex-1 flex-col pt-11 pb-10">
        <p className="mb-[22px] flex items-center gap-2.5 font-display text-[0.7rem] tracking-[0.18em] text-muted">
          <span className="h-[9px] w-[9px] rounded-[2px] bg-accent shadow-[0_0_12px_rgba(250,255,0,0.55)]" />
          OUTLIER FINDER
        </p>

        <h1 className="m-0 text-[clamp(2rem,8.5vw,2.75rem)] leading-[1.06] font-semibold tracking-[-0.025em]">
          Find and break down the best videos in your niche.
        </h1>

        <p className="mt-[18px] max-w-[34ch] text-[clamp(1rem,4.5vw,1.15rem)] leading-[1.45] text-muted">
          Enter a niche. Get its outlier reels ranked by how far they beat the
          median — then break down exactly why each one worked.
        </p>

        <section className="mt-9 rounded-[18px] border border-hair bg-linear-to-b from-white/[0.035] to-white/[0.012] p-[18px] shadow-panel">
          <a
            href={PAYMENT_LINK}
            className="flex h-[54px] w-full items-center justify-center rounded-xl bg-accent px-5 text-[0.95rem] font-semibold tracking-[0.06em] text-black uppercase shadow-accent transition-opacity hover:opacity-90 active:translate-y-px"
          >
            Unlock for $1
          </a>
          <p className="mx-0.5 mt-3.5 text-[0.8125rem] text-muted">
            One-time <span className="font-num text-white">$1</span>. No account,
            no subscription.
          </p>
        </section>
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
