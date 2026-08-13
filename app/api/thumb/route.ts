import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Thumbnail proxy.
 *
 * The Instagram CDN serves these fine to a server (verified 8/8) but blocks
 * the browser, so <img src={displayUrl}> renders as a broken tile no matter
 * what referrerPolicy we set. Since the results feed is visual-first, this is
 * core rather than a fallback.
 *
 * Deliberately NOT next/image: Hobby image optimization caps at 1,000 source
 * images per month (~20 searches at 50 reels), and the optimizer fetches from
 * Vercel IPs — the exact thing being blocked.
 */
const ALLOWED_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("u");
  if (!raw) return new NextResponse("missing u", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("bad url", { status: 400 });
  }

  // Host allowlist — without it this is an open proxy anyone could point at
  // internal addresses or use to launder traffic through our domain.
  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return new NextResponse("forbidden host", { status: 403 });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!upstream.ok) return new NextResponse("upstream", { status: 502 });
    const type = (upstream.headers.get("content-type") || "").split(";")[0];
    if (!type.startsWith("image/")) return new NextResponse("not image", { status: 502 });

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "content-type": type,
        // The signed source url expires in days; cache well inside that.
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse("fetch failed", { status: 502 });
  }
}
