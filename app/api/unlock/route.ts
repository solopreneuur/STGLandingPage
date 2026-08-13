import { NextResponse } from "next/server";
import Stripe from "stripe";
import {
  COOKIE_NAME,
  cookieOptions,
  issueToken,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/gate";

export const runtime = "nodejs";

/**
 * Redirect back to the origin that actually served this request, not a
 * hardcoded site url.
 *
 * Stripe's redirect target is fixed to the production domain, but the route
 * itself gets hit on localhost and on preview deploys too (paste the
 * session_id at any origin). Hardcoding NEXT_PUBLIC_SITE_URL sent every
 * environment to production — locally that lands on a dead page, and from a
 * preview it would kick a paying user onto the old waitlist site.
 */
function originOf(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) return `${proto}://${host}`;
  return process.env.NEXT_PUBLIC_SITE_URL || "https://studythegame.app";
}

function decodeRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    const b64 = ref.replace(/-/g, "+").replace(/_/g, "/");
    const s = Buffer.from(b64, "base64").toString("utf8").trim();
    return s.length >= 2 && s.length <= 60 ? s : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const SITE = originOf(req);
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id");
  const dev = url.searchParams.get("dev");

  // Dev bypass — without this every iteration costs a real $1 charge.
  //
  // Guarded to non-production because using it means putting GATE_SECRET in a
  // URL, which lands in Vercel's runtime logs and the browser's history. That
  // secret signs every access token, and it has no rotation path that does not
  // log out every paying customer.
  if (
    process.env.NODE_ENV !== "production" &&
    dev &&
    process.env.GATE_SECRET &&
    dev === process.env.GATE_SECRET
  ) {
    const res = NextResponse.redirect(new URL("/", SITE), 307);
    res.cookies.set(COOKIE_NAME, issueToken("dev-bypass"), cookieOptions);
    return res;
  }

  if (!sessionId) return NextResponse.redirect(new URL("/", SITE), 307);

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return NextResponse.redirect(new URL("/?denied=1", SITE), 307);
    }

    // Reject stale sessions so a shared ?session_id= link can't unlock the
    // product forever. Costs nothing and needs no server-side store of used
    // sessions (which would require the database we deliberately cut).
    const ageSeconds = Date.now() / 1000 - (session.created ?? 0);
    if (ageSeconds > SESSION_MAX_AGE_SECONDS) {
      return NextResponse.redirect(new URL("/?expired=1", SITE), 307);
    }

    // The niche the user typed before paying, carried through Stripe as a
    // backup to localStorage.
    const niche = decodeRef(session.client_reference_id);
    const dest = niche ? `/?n=${encodeURIComponent(niche)}` : "/";

    const res = NextResponse.redirect(new URL(dest, SITE), 307);
    // Store the Stripe session id itself, not a random token: when auth ships
    // later, this is the key that maps an existing cookie back to a Stripe
    // customer email, so paid users migrate without re-paying.
    res.cookies.set(COOKIE_NAME, issueToken(session.id), cookieOptions);
    return res;
  } catch (err) {
    console.error("[unlock]", err);
    return NextResponse.redirect(new URL("/?error=1", SITE), 307);
  }
}
