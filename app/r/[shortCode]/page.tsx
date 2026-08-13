import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, verifyToken } from "@/lib/gate";
import ReelDetail from "@/components/ReelDetail";

export const dynamic = "force-dynamic";

export default async function ReelPage({
  params,
}: {
  params: Promise<{ shortCode: string }>;
}) {
  const jar = await cookies();
  if (!verifyToken(jar.get(COOKIE_NAME)?.value)) redirect("/");

  const { shortCode } = await params;
  return <ReelDetail shortCode={shortCode} />;
}
