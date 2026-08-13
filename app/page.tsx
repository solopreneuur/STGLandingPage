import { cookies } from "next/headers";
import Landing from "@/components/Landing";
import SearchApp from "@/components/SearchApp";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  const jar = await cookies();
  const unlocked = verifyToken(jar.get(COOKIE_NAME)?.value);

  if (!unlocked) {
    return <Landing paymentLink={process.env.STRIPE_PAYMENT_LINK_URL ?? "#"} />;
  }

  // `n` is the niche carried through Stripe via client_reference_id; the
  // client also falls back to localStorage.
  const { n } = await searchParams;
  return <SearchApp initialKeyword={typeof n === "string" ? n : ""} />;
}
