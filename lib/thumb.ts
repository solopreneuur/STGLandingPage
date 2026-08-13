/**
 * Proxy Instagram CDN media through our own origin.
 *
 * The IG CDN serves these to a server but blocks the browser, so a direct
 * <img>/<video> src renders broken regardless of referrerPolicy.
 */
export function thumbSrc(displayUrl: string): string {
  return displayUrl ? `/api/thumb?u=${encodeURIComponent(displayUrl)}` : "";
}

export function videoSrc(videoUrl: string): string {
  return videoUrl ? `/api/video?u=${encodeURIComponent(videoUrl)}` : "";
}

/**
 * Kill switch. Reels average ~3.9MB and only the in-view card mounts a
 * player, but a 20-reel scroll is still ~78MB of proxied bandwidth. Flip to
 * false to fall back to poster images everywhere.
 */
export const VIDEO_ENABLED = process.env.NEXT_PUBLIC_VIDEO !== "0";
