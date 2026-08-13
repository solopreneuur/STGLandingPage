import Anthropic from "@anthropic-ai/sdk";
import type { Breakdown } from "./types";
import { USE_FIXTURES, fixtureBreakdown } from "./fixtures";
import { decodeDeep } from "./unescape";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_BREAKDOWN || "claude-opus-5";

const SYSTEM = `You are a sharp short-form video analyst. A creator is studying
why a reel in their niche outperformed. Give them the real mechanics.

STRUCTURE — every section except steal_this returns two tiers:
- "punch": ONE sentence, MAXIMUM 15 words. The verdict. Always on screen.
- "detail": 2-3 sentences. The reasoning behind the verdict. Hidden behind a
  tap, so it is read only by someone who already wants more.

The punch must stand alone. Someone who reads only punches should understand
why this reel worked. Never write "see below" or lead into the detail.

steal_this is punch only — it is the hero card and must stay a blade.
ONE sentence, start with a verb, an instruction for their NEXT video.

EMPHASIS — in punch and detail, wrap the 1-2 load-bearing phrases in **double
asterisks**. Maximum two per field. Highlight the phrase that carries the
insight, never a whole sentence and never filler.

Write numbers as digits: 32k, $2k, 3s. Never spell them out.

Use plain ASCII punctuation only: hyphens, commas, periods. Do NOT use em
dashes, curly quotes, or any escape sequences.

Content rules:
- Specifics over platitudes. "Opens on the finished result before showing the
  process" beats "strong hook".
- Never restate the caption. They can read it.
- Never say "engaging", "relatable", "eye-catching", or "compelling" without
  naming what concretely produces it.
- If a cover frame is provided, use what you actually see: framing, text
  placement, what is centered, what is cropped out.`;

const TIER = {
  type: "object",
  properties: {
    punch: { type: "string" },
    detail: { type: "string" },
  },
  required: ["punch", "detail"],
  additionalProperties: false,
} as const;

const SCHEMA = {
  type: "object",
  properties: {
    hook_read: TIER,
    mechanism: TIER,
    format: TIER,
    steal_this: { type: "string" },
  },
  required: ["hook_read", "mechanism", "format", "steal_this"],
  additionalProperties: false,
} as const;

export interface BreakdownInput {
  shortCode: string;
  caption: string;
  plays: number;
  score: number;
  ownerUsername: string;
  timestamp: string;
  displayUrl: string;
}

/**
 * Fetch the cover frame server-side and return base64.
 *
 * Phase 0 established this is the ONLY viable image path: passing the
 * Instagram CDN url straight to Anthropic returns 400 "disallowed by the
 * website's robots.txt". Server-side fetch succeeded on 12/12 thumbnails.
 * No Referer header — the IG CDN rejects on it.
 */
async function fetchCover(
  url: string
): Promise<{ data: string; mediaType: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const mediaType = (res.headers.get("content-type") || "").split(";")[0];
    if (!mediaType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return null;
    return { data: buf.toString("base64"), mediaType };
  } catch {
    return null;
  }
}

export async function breakdownReel(input: BreakdownInput): Promise<Breakdown> {
  if (USE_FIXTURES) return fixtureBreakdown();

  const cover = await fetchCover(input.displayUrl);

  const facts = `@${input.ownerUsername}
${input.plays.toLocaleString()} plays, ${input.score.toFixed(1)}x the niche median
posted ${input.timestamp}
caption: ${input.caption || "(none)"}`;

  const content: Anthropic.ContentBlockParam[] = [];
  if (cover) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: cover.mediaType as "image/jpeg",
        data: cover.data,
      },
    });
  }
  content.push({
    type: "text",
    text: cover
      ? `Break down this reel. The image is its cover frame.\n\n${facts}`
      : `Break down this reel. No cover frame available, so work from the metrics and caption and do not speculate about visuals you cannot see.\n\n${facts}`,
  });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block");

  // decodeDeep repairs the model's occasional double-escaped unicode, which
  // otherwise reaches the UI as a literal "—".
  const parsed = decodeDeep(
    JSON.parse(text.text) as Omit<Breakdown, "image_used">
  );

  return { ...parsed, image_used: cover !== null };
}
