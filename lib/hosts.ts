/**
 * The only hosts this server will fetch on a caller's behalf.
 *
 * Instagram's CDN serves servers but blocks browsers, which is why the app
 * proxies media at all. Every one of those fetch targets arrives in a request
 * body or query string, so without an allowlist each proxy is an open relay
 * into anything the deployment can reach.
 */
const ALLOWED_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

/** Parse and validate a caller-supplied media URL. Null means refuse. */
export function allowedMediaUrl(raw: string): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!ALLOWED_HOST.test(u.hostname)) return null;
  return u;
}

/**
 * Fetch options every media proxy shares.
 *
 * `redirect: "manual"` is the part that is easy to miss: Node follows
 * redirects by default, so validating only the URL the caller handed us lets
 * an allowlisted host 302 the request anywhere it likes — including back
 * inside the network. Refusing to follow keeps the check meaningful.
 */
export const MEDIA_FETCH_INIT = { redirect: "manual" } as const;

export { ALLOWED_HOST };
