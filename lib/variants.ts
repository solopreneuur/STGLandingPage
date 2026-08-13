import Anthropic from "@anthropic-ai/sdk";
import { widenKeyword } from "./apify";
import { USE_FIXTURES } from "./fixtures";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_FILTER || "claude-sonnet-5";

/** Original + this many variants. User's call: keep trying, then give up. */
export const MAX_ATTEMPTS = 6;

const SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

const SYSTEM = `Instagram has a "popular reels" page at instagram.com/popular/<slug>
for SOME keywords but not others. It exists for broad, common, single-word
category terms and short two-word ones. It does not exist for long or niche
phrases.

Confirmed to HAVE a feed: gym, workout, tech, cooking, recipes, travel,
finance, fashion, cars, home gym, dog training, real estate.
Confirmed to have NONE: fitness, iphone, skincare, photography.

Given a creator's niche, return candidate keywords most likely to have a
popular feed AND to surface videos that creator would actually learn from.

Rules:
- Prefer single common words, then two-word phrases.
- Order by descending likelihood the feed exists.
- Stay in the same subject area. "kettlebell mobility for climbers" should
  yield gym/workout/climbing, never cooking.
- Do not repeat any keyword already tried.`;

/**
 * Candidate widenings, cheapest-first.
 *
 * The deterministic transform runs first and costs nothing — it handles the
 * common multi-word case ("home gym" -> "gym"). The model call only happens
 * when that isn't available or was already tried, which is the genuinely hard
 * case (a single word with no feed, like "fitness").
 */
export async function suggestVariants(
  original: string,
  alreadyTried: string[]
): Promise<string[]> {
  const tried = new Set(alreadyTried.map((k) => k.toLowerCase()));
  const out: string[] = [];

  const cheap = widenKeyword(original);
  if (cheap && !tried.has(cheap)) out.push(cheap);

  // Offline: deterministic transform plus known-good feeds, no model call.
  if (USE_FIXTURES) {
    for (const k of FALLBACK_SUGGESTIONS) {
      if (!tried.has(k) && !out.includes(k)) out.push(k);
    }
    return out.slice(0, MAX_ATTEMPTS);
  }

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Niche: "${original}"\nAlready tried (do not repeat): ${alreadyTried.join(", ") || "none"}\n\nReturn up to 6 candidates.`,
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const block = msg.content.find((b) => b.type === "text");
    if (block?.type === "text") {
      const { candidates } = JSON.parse(block.text) as { candidates: string[] };
      for (const c of candidates ?? []) {
        const k = String(c).trim().toLowerCase();
        if (k && !tried.has(k) && !out.includes(k)) out.push(k);
      }
    }
  } catch (err) {
    console.error("[variants] model call failed, using deterministic only:", err);
  }

  return out.slice(0, MAX_ATTEMPTS);
}

/** Shown in the empty state so a paying user always has a next tap. */
export const FALLBACK_SUGGESTIONS = [
  "gym",
  "cooking",
  "tech",
  "travel",
  "finance",
  "fashion",
];
