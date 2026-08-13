import type { Metadata } from "next";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import { readReelWithNiche, readBreakdown, resolveNiche, readReels } from "@/lib/cache";
import { formatMultiplier } from "@/lib/score";
import ReelDetail from "@/components/ReelDetail";

export const dynamic = "force-dynamic";

/**
 * Per-reel metadata.
 *
 * The root layout pins `canonical` to the homepage, so without an override
 * here crawlers are told every reel page IS the homepage — and a link shared
 * in Slack or iMessage unfurls as the generic landing page. For a tool whose
 * natural growth loop is "look at this breakdown", that loop was dead.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ shortCode: string }>;
}): Promise<Metadata> {
  const { shortCode } = await params;
  const hit = await readReelWithNiche(shortCode);
  const url = `https://studythegame.app/r/${shortCode}`;
  if (!hit) return { alternates: { canonical: url } };

  const { reel, slug } = hit;
  const where = slug || "niche";
  const title = `${formatMultiplier(reel.score)} the ${where} median — @${reel.ownerUsername} | StudyTheGame`;
  const description =
    reel.caption?.trim().slice(0, 155) ||
    `Why this ${where} reel outperformed, broken down.`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ReelPage({
  params,
  searchParams,
}: {
  params: Promise<{ shortCode: string }>;
  searchParams: Promise<{ deep?: string }>;
}) {
  // Breakdowns are FREE in v2.1. `paid` only controls whether the
  // "Go deeper" CTA offers the synthesis or reveals it.
  const jar = await cookies();
  const paid = verifyToken(jar.get(COOKIE_NAME)?.value);

  const { shortCode } = await params;
  // Set by /api/unlock straight after payment.
  const { deep } = await searchParams;

  // Resolve server-side. sessionStorage is per-tab, so a shared link, a new
  // tab, a bookmark or a restart previously landed on "That reel isn't in
  // this session" — even though both the reel and its breakdown were sitting
  // in Postgres and come back in ~250ms.
  const hit = await readReelWithNiche(shortCode);
  const breakdown = hit ? await readBreakdown(shortCode) : null;

  // The niche's real reel count. GoDeeper otherwise counts a per-tab session
  // list that a shared link never has.
  let count = 0;
  if (hit?.slug) {
    const { niche } = await resolveNiche(hit.slug);
    if (niche) count = (await readReels(niche.id)).reels.length;
  }

  return (
    <ReelDetail
      shortCode={shortCode}
      paid={paid}
      paymentLink={process.env.STRIPE_PAYMENT_LINK_URL ?? "#"}
      initialReel={hit?.reel ?? null}
      initialKeyword={hit?.slug ?? ""}
      initialBreakdown={breakdown}
      autoDeep={deep === "1"}
      nicheReelCount={count}
    />
  );
}
