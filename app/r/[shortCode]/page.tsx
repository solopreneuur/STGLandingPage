import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import ReelDetail from "@/components/ReelDetail";

export const dynamic = "force-dynamic";

export default async function ReelPage({
  params,
}: {
  params: Promise<{ shortCode: string }>;
}) {
  // Breakdowns are FREE in v2.1. `paid` only controls whether the
  // "Go deeper" CTA offers the synthesis or reveals it.
  const jar = await cookies();
  const paid = verifyToken(jar.get(COOKIE_NAME)?.value);

  const { shortCode } = await params;
  return (
    <ReelDetail
      shortCode={shortCode}
      paid={paid}
      paymentLink={process.env.STRIPE_PAYMENT_LINK_URL ?? "#"}
    />
  );
}
