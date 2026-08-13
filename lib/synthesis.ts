import Anthropic from "@anthropic-ai/sdk";
import type { Breakdown, Reel } from "./types";
import type { Synthesis } from "./cache";
import { decodeDeep } from "./unescape";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL_SYNTHESIS || process.env.MODEL_BREAKDOWN || "claude-opus-5";

const SYSTEM = `You read a whole niche at once and name the pattern in what is
winning right now.

The reader has already seen every individual reel and its breakdown. Telling
them what one video did is worthless. Your entire job is what they could only
see by looking ACROSS all of them at the same time.

Look for:
- Formats that recur across DIFFERENT accounts, not one creator's habit
- What the top performers share that the bottom of the set does not
- The specific thing this niche's audience reliably rewards
- Anything counterintuitive: a pattern that contradicts standard advice

Rules:
- Every pattern must be supported by more than one reel in the set.
- Name the mechanism, not the vibe. "Opens mid-action with no setup shot"
  beats "high energy".
- Never restate a single reel's breakdown. If it is only true of one video,
  it is not a pattern.
- Cite what you are generalising from: "6 of the top 10 do X".
- Wrap the 1-2 load-bearing phrases per field in **double asterisks**.
- Numbers as digits. Plain ASCII punctuation only, no em dashes.

headline: one sentence, max 18 words. The single most useful thing about
this niche right now.
patterns: 3 to 4 items. punch is ONE sentence, max 20 words. detail is 2-3
sentences of evidence.
do_next: one instruction for the reader's next video, starting with a verb.`;

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: { punch: { type: "string" }, detail: { type: "string" } },
        required: ["punch", "detail"],
        additionalProperties: false,
      },
    },
    do_next: { type: "string" },
  },
  required: ["headline", "patterns", "do_next"],
  additionalProperties: false,
} as const;

/**
 * One call across the whole niche.
 *
 * Takes whatever breakdowns are already cached rather than requiring all of
 * them — the cross-reel pattern lives mostly in the aggregate, so a user who
 * opened three reels gets the same synthesis as one who opened twenty.
 */
export async function synthesize(
  keyword: string,
  reels: Reel[],
  breakdowns: Map<string, Breakdown>
): Promise<Synthesis> {
  const compact = reels.slice(0, 25).map((r, i) => {
    const bd = breakdowns.get(r.shortCode);
    return {
      rank: i + 1,
      account: r.ownerUsername,
      multiplier: Number(r.score.toFixed(1)),
      plays: r.plays,
      posted: r.timestamp?.slice(0, 10),
      caption: (r.caption ?? "").slice(0, 200),
      ...(bd
        ? {
            hook: bd.hook_read?.punch,
            mechanism: bd.mechanism?.punch,
            format: bd.format?.punch,
          }
        : {}),
    };
  });

  const withBd = compact.filter((c) => "hook" in c).length;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Niche: "${keyword}"
${reels.length} outlier reels, ranked by how far they beat the niche median.
${withBd} of them have a per-reel breakdown attached.

${JSON.stringify(compact)}`,
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block");
  return decodeDeep(JSON.parse(text.text) as Synthesis);
}
