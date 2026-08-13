import Anthropic from "@anthropic-ai/sdk";
import type { ApifyItem, FilterVerdict } from "./types";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_FILTER || "claude-sonnet-5";

const CAPTION_CHARS = 300;
const COMMENT_CHARS = 120;
const COMMENTS_PER_ITEM = 5;

const SYSTEM = `You screen Instagram reels for a creator-research tool.

For each reel, answer ONE question: would this video's performance be useful
evidence for an English-market creator studying their niche — or is its
engagement mass-market noise that says nothing transferable?

Judge holistically from the whole picture: caption, who posted it, and how
people actually engage in the comments. You are reading BEHAVIOUR, not
keywords. Do not pattern-match on single words.

Red flags that this is mass-market noise:
- Follow-begging ("I am your new follower", "followed you", follow-for-follow)
- Gift/emoji walls with no words (🎁🎁🎁, 🔥🔥🔥 as the entire comment)
- Giveaway-begging ("give me one", "pick me", "send me one")
- Giveaway-bait formats ("real or fake", "comment X to win", "guess the price")
- The same commenter appearing repeatedly
- Walls of generic praise with zero likes and zero topical content
- Comments that engage with nothing specific about the actual video

Signals it IS useful evidence:
- Comments reference something specific that happened in the video
- Questions about technique, product, process, or how it was made
- Disagreement, correction, or debate about the content
- Niche vocabulary that a casual scroller would not use

Be decisive. If engagement is clearly organic and topical, keep it with high
confidence. If it is clearly farmed or mass-market, drop it with high
confidence. Use confidence below 0.6 ONLY when you genuinely cannot tell —
those get sorted to the bottom rather than removed, so a mid confidence is a
real answer, not a hedge.

Return a verdict for EVERY shortCode you are given. Never omit one.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          shortCode: { type: "string" },
          keep: { type: "boolean" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["shortCode", "keep", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

function compact(items: ApifyItem[]) {
  return items.map((i) => ({
    shortCode: i.shortCode,
    account: [i.ownerUsername, i.ownerFullName].filter(Boolean).join(" / "),
    caption: (i.caption ?? "").slice(0, CAPTION_CHARS),
    firstComment: (i.firstComment ?? "").slice(0, COMMENT_CHARS),
    comments: (i.latestComments ?? []).slice(0, COMMENTS_PER_ITEM).map((c) => ({
      // commenter username is included so repeated-commenter patterns are visible
      by: c.ownerUsername ?? c.owner?.username ?? "",
      text: (c.text ?? "").slice(0, COMMENT_CHARS),
      likes: c.likesCount ?? 0,
    })),
  }));
}

export interface FilterResult {
  verdicts: Map<string, FilterVerdict>;
  /** false => the call failed; caller must render the UNFILTERED badge. */
  filtered: boolean;
}

/**
 * One batched call for the whole set.
 *
 * Two failure modes are handled deliberately:
 *  - The call fails entirely -> return filtered:false and let the caller ship
 *    unfiltered results with a badge. Never block the product on the filter.
 *  - The model returns FEWER verdicts than we sent -> the missing items default
 *    to keep at confidence 0.5 (borderline, sorts to the bottom). Dropping on
 *    absence would silently turn model truncation into data loss.
 */
export async function filterAudience(items: ApifyItem[]): Promise<FilterResult> {
  const verdicts = new Map<string, FilterVerdict>();
  if (items.length === 0) return { verdicts, filtered: true };

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      // effort low: this is classification, not reasoning. Effort is the
      // latency lever here and the filter sits on the critical path.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Screen these ${items.length} reels. Return one verdict per shortCode.\n\n${JSON.stringify(compact(items))}`,
        },
      ],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = msg.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block");
    const parsed = JSON.parse(text.text) as { verdicts: FilterVerdict[] };

    for (const v of parsed.verdicts ?? []) {
      if (typeof v?.shortCode === "string") verdicts.set(v.shortCode, v);
    }
    return { verdicts, filtered: true };
  } catch (err) {
    console.error("[filter] failed, shipping unfiltered:", err);
    return { verdicts, filtered: false };
  }
}

/** Items the filter explicitly rejected. Borderlines are NOT dropped. */
export function applyVerdicts(
  items: ApifyItem[],
  verdicts: Map<string, FilterVerdict>
): ApifyItem[] {
  return items.filter((i) => {
    const v = verdicts.get(i.shortCode);
    if (!v) return true; // absent verdict => keep as borderline
    return v.keep;
  });
}
