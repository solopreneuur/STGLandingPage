import Anthropic from "@anthropic-ai/sdk";
import type { Breakdown } from "./types";
import { USE_FIXTURES, fixtureBreakdown } from "./fixtures";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_BREAKDOWN || "claude-opus-5";

const SYSTEM = `You are a sharp short-form video analyst. A creator is studying
why a reel in their niche outperformed. Give them the real mechanics.

Rules:
- Specifics over platitudes. "Opens on the finished result before showing the
  process" beats "strong hook".
- Never restate the caption back to them. They can read it.
- Never say "engaging", "relatable", "eye-catching", "compelling", or
  "high-quality" without saying what concretely produces that.
- If the cover frame is provided, use what you actually see in it — framing,
  text placement, what is centered, what is deliberately cropped out.
- steal_this must be a move they can execute on their next video, not an
  observation about this one.
- One or two sentences per field. No preamble, no hedging.`;

const SCHEMA = {
  type: "object",
  properties: {
    hook_read: { type: "string" },
    mechanism: { type: "string" },
    format: { type: "string" },
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
${input.plays.toLocaleString()} plays — ${input.score.toFixed(1)}x the niche median
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
      : `Break down this reel. No cover frame available — work from the metrics and caption, and do not speculate about visuals you cannot see.\n\n${facts}`,
  });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block");
  const parsed = JSON.parse(text.text) as Omit<Breakdown, "image_used">;

  return { ...parsed, image_used: cover !== null };
}
