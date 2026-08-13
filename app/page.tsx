import { cookies } from "next/headers";
import SearchApp from "@/components/SearchApp";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import { popularNiches } from "@/lib/cache";

export const dynamic = "force-dynamic";

/**
 * v2.1 — freemium. The app is no longer gated.
 *
 * Search, the reel feed and per-reel breakdowns are free. The $1 buys one
 * thing: the cross-niche synthesis, gated in /api/synthesis. `paid` here only
 * decides whether the "Go deeper" CTA shows a price or the result.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  const jar = await cookies();
  const paid = verifyToken(jar.get(COOKIE_NAME)?.value);

  // Cached niches, most-hit first — these render as "or explore" chips and
  // are instant by definition.
  const chips = await popularNiches(8);

  const { n } = await searchParams;
  return (
    <SearchApp
      initialKeyword={typeof n === "string" ? n : ""}
      paid={paid}
      chips={chips}
      paymentLink={process.env.STRIPE_PAYMENT_LINK_URL ?? "#"}
    />
  );
}
