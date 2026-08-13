import Anthropic from "@anthropic-ai/sdk";
import { safe } from "./db";
import type { Breakdown, Reel, SearchMeta } from "./types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
/** Synonym resolution is a one-line classification — the cheapest model wins. */
const SYNONYM_MODEL = process.env.MODEL_SYNONYM || "claude-haiku-4-5";

/** Outliers stay outliers; the data moves weekly. */
export const TTL_DAYS = Number(process.env.CACHE_TTL_DAYS ?? 7);
/** Cap the payload so niches deepening week over week don't bloat responses. */
export const SERVE_CAP = 50;

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
      output_config: {
        effort: "low",
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

export async function readReels(nicheId: string): Promise<Reel[]> {
  return safe<Reel[]>(
    "readReels",
    async (c) => {
      const { data } = await c
        .from("reels")
        .select("short_code, payload, score, confidence")
        .eq("niche_id", nicheId)
        .eq("archived", false)
        .order("score", { ascending: false })
        .limit(SERVE_CAP);
      return (data ?? []).map((r: ReelRow) => ({
        ...r.payload,
        score: r.score ?? r.payload.score ?? 0,
        confidence: r.confidence ?? r.payload.confidence ?? 0.5,
      }));
    },
    []
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

/** Powers the "or explore" chips. */
export async function popularNiches(limit = 8): Promise<string[]> {
  return safe<string[]>(
    "popularNiches",
    async (c) => {
      const { data } = await c
        .from("niches")
        .select("slug, hit_count")
        .not("last_refreshed_at", "is", null)
        .order("hit_count", { ascending: false })
        .limit(limit);
      return (data ?? []).map((r: { slug: string }) => r.slug);
    },
    []
  );
}

export type { SearchMeta };
