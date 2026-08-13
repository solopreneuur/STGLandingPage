import crypto from "node:crypto";

const SECRET = process.env.GATE_SECRET ?? "";
export const COOKIE_NAME = "stg_access";

/**
 * "Forever" per product decision — a $1 purchase advertised as one-time
 * should not silently re-gate.
 *
 * Note the ceiling is not ours: Chrome clamps any cookie to 400 days
 * (cookie-max-age spec), so real-world lifetime is ~13 months no matter what
 * we send. Setting the max is the closest thing to forever that a
 * cookie-only, no-accounts design can offer.
 */
export const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Reject Stripe sessions older than this at redeem time. Stops a
 * ?session_id=... URL from being shared around indefinitely, without needing
 * any server-side store of used sessions (which would require the database we
 * deliberately cut).
 */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string): string {
  return b64url(crypto.createHmac("sha256", SECRET).update(payload).digest());
}

/** `${sessionId}.${issuedAtMs}.${sig}` */
export function issueToken(sessionId: string): string {
  const payload = `${sessionId}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token || !SECRET) return false;
  const idx = token.lastIndexOf(".");
  if (idx < 1) return false;

  const payload = token.slice(0, idx);
  const provided = token.slice(idx + 1);
  const expected = sign(payload);

  // Constant-time compare. Length check first because timingSafeEqual throws
  // on mismatched lengths.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  // Signature is valid; the cookie's own maxAge governs expiry.
  return true;
}

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // "lax" is required, not incidental: Stripe redirects the user back to our
  // domain and our server sets the cookie first-party on that request.
  // "strict" would drop it on the cross-site redirect and the gate would
  // never open after a real payment.
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE_SECONDS,
};
