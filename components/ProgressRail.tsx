"use client";

export type Stage = "pulling" | "widening" | "filtering" | "scoring";

const STEPS: { key: Stage; label: string }[] = [
  { key: "pulling", label: "pulling reels" },
  { key: "filtering", label: "filtering audience" },
  { key: "scoring", label: "scoring outliers" },
];

/**
 * Server-driven progress. Every label reflects an actual phase reported by the
 * poll route — never a timer pretending to be progress. Apify runs take real
 * seconds and a bare spinner reads as broken.
 */
export default function ProgressRail({
  stage,
  found,
  widenedTo,
}: {
  stage: Stage;
  found: number;
  widenedTo?: string;
}) {
  const activeIndex = stage === "widening" ? 0 : STEPS.findIndex((s) => s.key === stage);

  return (
    <div className="mt-8 rounded-[14px] border border-hair bg-white/[0.02] p-5">
      <ol className="flex flex-col gap-3">
        {STEPS.map((s, i) => {
          const done = i < activeIndex;
          const active = i === activeIndex;
          return (
            <li key={s.key} className="flex items-center gap-3">
              <span
                className={
                  done
                    ? "h-[9px] w-[9px] rounded-[2px] bg-success"
                    : active
                      ? "h-[9px] w-[9px] animate-pulse rounded-[2px] bg-accent shadow-[0_0_12px_rgba(250,255,0,0.55)]"
                      : "h-[9px] w-[9px] rounded-[2px] bg-white/15"
                }
              />
              <span
                className={
                  active ? "text-[0.95rem] text-white" : "text-[0.95rem] text-muted"
                }
              >
                {s.label}
                {active && s.key === "pulling" && found > 0 && (
                  <>
                    {" "}
                    <span className="font-num text-white">{found}</span> found
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {widenedTo && (
        <p className="mt-4 border-t border-hair pt-3 text-[0.8125rem] text-muted">
          No popular feed for that exact term — widening to{" "}
          <span className="text-accent">{widenedTo}</span>
        </p>
      )}
    </div>
  );
}
