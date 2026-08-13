import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Video proxy with Range support.
 *
 * Same reason as the thumbnail proxy — the Instagram CDN serves a server but
 * blocks the browser. Range matters here specifically: <video> issues partial
 * requests to start playback before the whole file arrives, so forwarding
 * Range and returning 206 is what makes playback start fast instead of
 * stalling on a full 4MB download.
 *
 * Bandwidth note: reels average ~3.9MB. Only the in-view card mounts a
 * <video>, so a 20-reel scroll is ~78MB. That is the first thing that will
 * strain a Hobby plan under real traffic.
 */
import { ALLOWED_HOST, MEDIA_FETCH_INIT } from "@/lib/hosts";

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("u");
  if (!raw) return new NextResponse("missing u", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("bad url", { status: 400 });
  }
  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) {
    return new NextResponse("forbidden host", { status: 403 });
  }

  const range = req.headers.get("range");

  try {
    const upstream = await fetch(target.toString(), {
      // Never follow a redirect off the allowlisted host.
      ...MEDIA_FETCH_INIT,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        ...(range ? { range } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new NextResponse("upstream", { status: 502 });
    }

    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=3600",
    });
    for (const h of ["content-range", "content-length"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch {
    return new NextResponse("fetch failed", { status: 502 });
  }
}
