import Anthropic from "@anthropic-ai/sdk";
import { safe } from "./db";
import { median } from "./score";
import type { Breakdown, Reel, SearchMeta } from "./types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
/** Synonym resolution is a one-line classification — the cheapest model wins. */
const SYNONYM_MODEL = process.env.MODEL_SYNONYM || "claude-haiku-4-5";

/** Outliers stay outliers; the data moves weekly. */
export const TTL_DAYS = Number(process.env.CACHE_TTL_DAYS ?? 7);
/** Cap the payload so niches deepening week over week don't bloat responses. */
export const SERVE_CAP = 50;
/** Read past SERVE_CAP so the median is the niche's, not the served slice's. */
const FETCH_CAP = 200;

/* ------------------------------------------------------------------ */
/* normalize                                                           */
/* ------------------------------------------------------------------ */

/**
 * Canonical slug for a user-typed term.
 *
 * Singularization deliberately skips words ending in "ss". Naive stripping
 * turned "fitness" into "fitnes" in v1 — a word with no Instagram feed, which
 * burned a whole widening attempt before failing.
 */
export function normalizeSlug(input: string): string {
  const base = input.trim().toLowerCase().replace(/\s+/g, " ");
  return base
    .split(" ")
    .map((w) =>
      w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w
    )
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* niche lookup                                                        */
/* ------------------------------------------------------------------ */

export interface NicheRow {
  id: string;
  slug: string;
  last_refreshed_at: string | null;
  hit_count: number;
}

export function isFresh(n: NicheRow): boolean {
  if (!n.last_refreshed_at) return false;
  return Date.now() - Date.parse(n.last_refreshed_at) < TTL_DAYS * 864e5;
}

/** Step 2: alias memo. A term resolved once never costs a model call again. */
async function byAlias(slug: string): Promise<NicheRow | null> {
  return safe<NicheRow | null>(
    "byAlias",
    async (c) => {
      const { data } = await c
        .from("aliases")
        .select("niches(id, slug, last_refreshed_at, hit_count)")
        .eq("alias_slug", slug)
        .maybeSingle();
      const n = (data as { niches?: NicheRow } | null)?.niches;
      return n ?? null;
    },
    null
  );
}

/** Step 3: exact canonical match. */
async function bySlug(slug: string): Promise<NicheRow | null> {
  return safe<NicheRow | null>(
    "bySlug",
    async (c) => {
      const { data } = await c
        .from("niches")
        .select("id, slug, last_refreshed_at, hit_count")
        .eq("slug", slug)
        .maybeSingle();
      return (data as NicheRow) ?? null;
    },
    null
  );
}

/** Freshness probe by slug — used by the seed script to skip warm niches. */
export async function bySlugPublic(slug: string): Promise<NicheRow | null> {
  return bySlug(slug);
}

export async function listSlugs(): Promise<string[]> {
  return safe<string[]>(
    "listSlugs",
    async (c) => {
      const { data } = await c.from("niches").select("slug").limit(500);
      return (data ?? []).map((r: { slug: string }) => r.slug);
    },
    []
  );
}

/**
 * Step 4: synonym resolution. Runs ONCE per never-seen term, then the alias
 * row makes it free forever.
 *
 * Deliberately conservative — a false match silently serves someone the wrong
 * niche, which is far worse than paying for one extra pipeline run.
 */
export async function resolveSynonym(
  term: string,
  slugs: string[]
): Promise<string | null> {
  if (slugs.length === 0) return null;
  try {
    const msg = await anthropic.messages.create({
      model: SYNONYM_MODEL,
      max_tokens: 200,
      system: `You match a search term to an existing cached niche.

Return a slug ONLY if a person searching the term would expect substantially
the SAME set of videos as the niche. Match synonyms and equivalent phrasings:
gym = workout = fitness, cooking = food, coding = programming.

Do NOT match merely-related niches. yoga is not fitness. crypto is not
personal finance. skincare is not beauty. A wrong match shows someone the
wrong niche, which is worse than a cache miss.

When in doubt, return null.`,
      // No `effort` here. claude-haiku-4-5 rejects the parameter outright with
      // a 400, and the catch below turned that into a silent `null` — so this
      // step never resolved a single synonym. Structured outputs are supported;
      // only `effort` is not.
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { slug: { type: ["string", "null"] } },
            required: ["slug"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "user",
          content: `Term: "${term}"\n\nCached niches:\n${slugs.join("\n")}`,
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const t = msg.content.find((b) => b.type === "text");
    if (!t || t.type !== "text") return null;
    const { slug } = JSON.parse(t.text) as { slug: string | null };
    return slug && slugs.includes(slug) ? slug : null;
  } catch (err) {
    // Treat as a new niche. Worst case is a duplicate cache entry, never an
    // error surfaced to the user.
    console.error("[cache] synonym resolution failed:", err);
    return null;
  }
}

export async function writeAlias(alias: string, nicheId: string): Promise<void> {
  await safe(
    "writeAlias",
    async (c) => {
      await c.from("aliases").upsert({ alias_slug: alias, niche_id: nicheId });
      return null;
    },
    null
  );
}

export interface Resolution {
  niche: NicheRow | null;
  /** The canonical slug to use if we end up creating this niche. */
  slug: string;
  /** True when a model call resolved it — used only for logging. */
  viaSynonym: boolean;
}

/** Steps 1-4 of the read path, in order. */
export async function resolveNiche(input: string): Promise<Resolution> {
  const slug = normalizeSlug(input);

  const alias = await byAlias(slug);
  if (alias) return { niche: alias, slug, viaSynonym: false };

  const exact = await bySlug(slug);
  if (exact) return { niche: exact, slug, viaSynonym: false };

  const slugs = await listSlugs();
  const match = await resolveSynonym(slug, slugs);
  if (match) {
    const n = await bySlug(match);
    if (n) {
      await writeAlias(slug, n.id); // never pay for this term again
      return { niche: n, slug, viaSynonym: true };
    }
  }
  return { niche: null, slug, viaSynonym: false };
}

/* ------------------------------------------------------------------ */
/* reels                                                               */
/* ------------------------------------------------------------------ */

interface ReelRow {
  short_code: string;
  payload: Reel;
  score: number | null;
  confidence: number | null;
}

export interface CachedNiche {
  reels: Reel[];
  /** The single base every multiplier on screen was divided by. */
  medianPlays: number;
}

/**
 * Serve a niche, rescored against ONE median.
 *
 * The stored `score` column cannot be trusted as a display value: rows arrive
 * from the seed, from a live search and from scroll top-ups, each dividing by
 * whatever median it happened to see. Mixing those bases is what made the top
 * card read "13x, 211K median, 3.4M plays" — three numbers that contradict
 * each other by 22%.
 *
 * Recomputing here means the multiplier, the median and the play count are
 * always arithmetically consistent, and it makes the stored score a sort hint
 * rather than something a client can poison.
 */
export async function readReels(nicheId: string): Promise<CachedNiche> {
  return safe<CachedNiche>(
    "readReels",
    async (c) => {
      const { data } = await c
        .from("reels")
        .select("short_code, payload, score, confidence")
        .eq("niche_id", nicheId)
        .eq("archived", false)
        .order("score", { ascending: false })
        .limit(FETCH_CAP);

      const reels = (data ?? []).map((r: ReelRow) => ({
        ...r.payload,
        confidence: r.confidence ?? r.payload.confidence ?? 0.5,
      }));
      // Median over every active reel, not the served slice, so the headline
      // number does not shift as a niche deepens past SERVE_CAP.
      const med = median(reels.map((r) => r.plays));
      const scored = reels
        .map((r) => ({ ...r, score: med > 0 ? r.plays / med : 0 }))
        .sort((a, b) => b.score - a.score);

      return { reels: scored.slice(0, SERVE_CAP), medianPlays: med };
    },
    { reels: [], medianPlays: 0 }
  );
}

/**
 * The stored copy of a reel, by short code, from whichever niche holds it.
 *
 * /api/breakdown is unauthenticated and takes the whole reel off the request
 * body, so a caller can otherwise pair a real short code with any caption and
 * cover they like — and the result is written to a global, TTL-less table that
 * every niche then serves. Preferring the stored row makes the short code the
 * only thing a caller actually controls.
 */
export async function readReelByCode(shortCode: string): Promise<Reel | null> {
  return safe<Reel | null>(
    "readReelByCode",
    async (c) => {
      const { data } = await c
        .from("reels")
        .select("payload")
        .eq("short_code", shortCode)
        .limit(1)
        .maybeSingle();
      return ((data as { payload: Reel } | null)?.payload) ?? null;
    },
    null
  );
}

/**
 * A reel plus the niche it belongs to.
 *
 * The reel page needs both: the reel to render server-side, and the slug so
 * the "Go deeper" CTA offers the right niche. Reading it from the session
 * cache instead is what made every shared link a dead end.
 */
export async function readReelWithNiche(
  shortCode: string
): Promise<{ reel: Reel; slug: string } | null> {
  return safe<{ reel: Reel; slug: string } | null>(
    "readReelWithNiche",
    async (c) => {
      const { data } = await c
        .from("reels")
        .select("payload, niches(slug)")
        .eq("short_code", shortCode)
        .eq("archived", false)
        .limit(1)
        .maybeSingle();
      const row = data as { payload: Reel; niches?: { slug: string } } | null;
      if (!row?.payload) return null;
      return { reel: row.payload, slug: row.niches?.slug ?? "" };
    },
    null
  );
}

export async function upsertNiche(slug: string): Promise<string | null> {
  return safe<string | null>(
    "upsertNiche",
    async (c) => {
      const { data } = await c
        .from("niches")
        .upsert(
          { slug, last_refreshed_at: new Date().toISOString() },
          { onConflict: "slug" }
        )
        .select("id")
        .single();
      return (data as { id: string } | null)?.id ?? null;
    },
    null
  );
}

/**
 * Write a pull through to the cache.
 *
 * `archiveMissing` is for the weekly refresh: reels absent from the new pull
 * become archived rather than deleted, keeping cheap history for future
 * velocity work. Scroll top-ups pass false — they ADD reels and must never
 * archive the ones the user is currently looking at.
 */
export async function writeReels(
  nicheId: string,
  reels: Reel[],
  archiveMissing = false
): Promise<void> {
  if (reels.length === 0) return;
  await safe(
    "writeReels",
    async (c) => {
      if (archiveMissing) {
        const keep = reels.map((r) => r.shortCode);
        await c
          .from("reels")
          .update({ archived: true })
          .eq("niche_id", nicheId)
          .not("short_code", "in", `(${keep.join(",")})`);
      }
      await c.from("reels").upsert(
        reels.map((r) => ({
          niche_id: nicheId,
          short_code: r.shortCode,
          payload: r,
          score: r.score,
          keep: true,
          confidence: r.confidence,
          reason: r.filterReason ?? null,
          archived: false,
        })),
        { onConflict: "niche_id,short_code" }
      );
      return null;
    },
    null
  );
}

export async function bumpHit(nicheId: string): Promise<void> {
  await safe(
    "bumpHit",
    async (c) => {
      await c.rpc("increment_hit", { n_id: nicheId });
      return null;
    },
    null
  );
}

/* ------------------------------------------------------------------ */
/* breakdowns — global, keyed by reel                                  */
/* ------------------------------------------------------------------ */

export async function readBreakdown(shortCode: string): Promise<Breakdown | null> {
  return safe<Breakdown | null>(
    "readBreakdown",
    async (c) => {
      const { data } = await c
        .from("breakdowns")
        .select("payload")
        .eq("short_code", shortCode)
        .maybeSingle();
      return ((data as { payload: Breakdown } | null)?.payload) ?? null;
    },
    null
  );
}

export async function writeBreakdown(
  shortCode: string,
  payload: Breakdown,
  model: string
): Promise<void> {
  await safe(
    "writeBreakdown",
    async (c) => {
      await c
        .from("breakdowns")
        .upsert({ short_code: shortCode, payload, model }, { onConflict: "short_code" });
      return null;
    },
    null
  );
}

/** Warm breakdowns for a whole feed in one round trip. */
export async function readBreakdowns(
  shortCodes: string[]
): Promise<Map<string, Breakdown>> {
  if (shortCodes.length === 0) return new Map();
  return safe<Map<string, Breakdown>>(
    "readBreakdowns",
    async (c) => {
      const { data } = await c
        .from("breakdowns")
        .select("short_code, payload")
        .in("short_code", shortCodes);
      return new Map(
        (data ?? []).map((r: { short_code: string; payload: Breakdown }) => [
          r.short_code,
          r.payload,
        ])
      );
    },
    new Map()
  );
}

/* ------------------------------------------------------------------ */
/* syntheses — the paid artifact                                       */
/* ------------------------------------------------------------------ */

export interface Synthesis {
  headline: string;
  patterns: { punch: string; detail: string }[];
  do_next: string;
}

export async function readSynthesis(nicheId: string): Promise<Synthesis | null> {
  return safe<Synthesis | null>(
    "readSynthesis",
    async (c) => {
      const { data } = await c
        .from("syntheses")
        .select("payload")
        .eq("niche_id", nicheId)
        .maybeSingle();
      return ((data as { payload: Synthesis } | null)?.payload) ?? null;
    },
    null
  );
}

export async function writeSynthesis(
  nicheId: string,
  payload: Synthesis
): Promise<void> {
  await safe(
    "writeSynthesis",
    async (c) => {
      await c
        .from("syntheses")
        .upsert({ niche_id: nicheId, payload }, { onConflict: "niche_id" });
      return null;
    },
    null
  );
}

export interface NicheHealth {
  reels: number;
  /** Reels carrying a filter verdict. A gap here means the filter call failed. */
  judged: number;
  breakdowns: number;
  synthesis: boolean;
}

/**
 * Completeness of a cached niche, as opposed to its age.
 *
 * A run that loses the Anthropic API partway writes reels that look fine by
 * row count but were never judged and have no breakdowns behind them. Freshness
 * alone cannot tell those apart, so anything that decides whether to redo work
 * has to ask this instead.
 */
export async function nicheHealth(nicheId: string): Promise<NicheHealth> {
  return safe<NicheHealth>(
    "nicheHealth",
    async (c) => {
      const { data } = await c
        .from("reels")
        .select("short_code, reason")
        .eq("niche_id", nicheId)
        .eq("archived", false);
      const rows = (data ?? []) as { short_code: string; reason: string | null }[];

      let breakdowns = 0;
      // Chunked because PostgREST puts `in` lists in the query string.
      for (let i = 0; i < rows.length; i += 100) {
        const codes = rows.slice(i, i + 100).map((r) => r.short_code);
        const { count } = await c
          .from("breakdowns")
          .select("*", { count: "exact", head: true })
          .in("short_code", codes);
        breakdowns += count ?? 0;
      }

      const { data: syn } = await c
        .from("syntheses")
        .select("niche_id")
        .eq("niche_id", nicheId)
        .maybeSingle();

      return {
        reels: rows.length,
        judged: rows.filter((r) => r.reason !== null).length,
        breakdowns,
        synthesis: !!syn,
      };
    },
    { reels: 0, judged: 0, breakdowns: 0, synthesis: false }
  );
}

/**
 * Niches the weekly cron should re-pull: everything anyone has ever landed on,
 * most-wanted first. Capped by the caller so the job stays inside 300s.
 */
export async function refreshTargets(limit: number): Promise<NicheRow[]> {
  return safe<NicheRow[]>(
    "refreshTargets",
    async (c) => {
      const { data } = await c
        .from("niches")
        .select("id, slug, last_refreshed_at, hit_count")
        .order("hit_count", { ascending: false })
        .order("last_refreshed_at", { ascending: true, nullsFirst: true })
        .limit(limit);
      return (data ?? []) as NicheRow[];
    },
    []
  );
}

/** Powers the "or explore" chips. */
export async function popularNiches(limit = 8): Promise<string[]> {
  return safe<string[]>(
    "popularNiches",
    async (c) => {
      // Must mirror /api/search/start's isFresh() check, not merely
      // "has ever been refreshed". A chip is a promise that the niche is
      // instant; offering a stale one delivers a 40-60s scrape instead.
      const cutoff = new Date(Date.now() - TTL_DAYS * 864e5).toISOString();
      const { data } = await c
        .from("niches")
        .select("slug, hit_count")
        .gt("last_refreshed_at", cutoff)
        .order("hit_count", { ascending: false })
        .limit(limit);
      return (data ?? []).map((r: { slug: string }) => r.slug);
    },
    []
  );
}

export type { SearchMeta };
