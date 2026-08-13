import { z } from "zod";

/* ============================================================
   Raw Apify item — apify/instagram-search-scraper, searchType "popular".
   Deliberately permissive: .passthrough() keeps unknown fields, and every
   field we don't strictly require is optional/nullable. A missing field must
   never empty the result set (see normalize()).
   ============================================================ */

export const ApifyCommentSchema = z
  .object({
    text: z.string().nullish(),
    ownerUsername: z.string().nullish(),
    likesCount: z.number().nullish(),
    owner: z.object({ username: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export const ApifyItemSchema = z
  .object({
    shortCode: z.string(),
    url: z.string().nullish(),
    caption: z.string().nullish(),
    displayUrl: z.string().nullish(),
    videoUrl: z.string().nullish(),
    ownerUsername: z.string().nullish(),
    ownerFullName: z.string().nullish(),
    timestamp: z.string().nullish(),
    videoPlayCount: z.number().nullish(),
    videoViewCount: z.number().nullish(),
    productType: z.string().nullish(),
    paidPartnership: z.boolean().nullish(),
    isPinned: z.boolean().nullish(),
    firstComment: z.string().nullish(),
    latestComments: z.array(ApifyCommentSchema).nullish(),
    commentsCount: z.number().nullish(),
    likesCount: z.number().nullish(),
  })
  .passthrough();

export type ApifyItem = z.infer<typeof ApifyItemSchema>;

/* ============================================================
   Normalized + scored reel — the shape the UI consumes.
   ============================================================ */

export interface Reel {
  shortCode: string;
  url: string;
  caption: string;
  displayUrl: string;
  /** Direct mp4 for the in-view player. Proxied via /api/video. */
  videoUrl: string;
  ownerUsername: string;
  ownerFullName: string;
  timestamp: string;
  plays: number;
  /** plays / median(plays). Rendered as "7.3×". */
  score: number;
  /** Audience-filter verdict. Borderline (<0.6) sorts to the bottom. */
  confidence: number;
  filterReason?: string;
}

/** Which metric the whole set was ranked on. Never mixed within a set. */
export type Metric = "plays" | "views";

export interface SearchMeta {
  pulled: number;
  kept: number;
  dropped: number;
  medianPlays: number;
  metric: Metric;
  /** false => render the "UNFILTERED" badge; the filter call failed. */
  filtered: boolean;
  /** true => "some sources failed"; partial results are better than an error. */
  partial: boolean;
  /** More than one entry => we widened. Surface as "also searched: X". */
  keywordsUsed: string[];
}

/* ============================================================
   Poll contract. Phase labels are server-driven — never a dead spinner.
   ============================================================ */

/**
 * The `widening` variant carries the next run's ids plus the accumulated
 * queue/used/datasets state. Widening spans multiple poll calls (running six
 * sequential Apify runs in one request would blow the function timeout), so
 * the client echoes these straight back on the next poll.
 */
export interface WideningState {
  runId: string;
  datasetId: string;
  keyword: string;
  original: string;
  /** CSV of dataset ids collected so far — merged at the end. */
  datasets: string;
  /** CSV of remaining candidate keywords. */
  queue: string;
  /** CSV of keywords already attempted. */
  used: string;
}

export type PollResponse =
  | { phase: "pulling"; found: number }
  | { phase: "filtering" }
  | { phase: "scoring" }
  | ({ phase: "widening"; triedKeyword: string } & WideningState)
  /**
   * Scored but NOT yet audience-filtered. Emitted as soon as the Apify data
   * lands so the feed renders ~12s sooner; the client keeps polling and
   * swaps in the filtered set when it arrives.
   */
  | { phase: "partial"; results: Reel[]; meta: SearchMeta; datasets: string; used: string }
  | { phase: "done"; results: Reel[]; meta: SearchMeta }
  | { phase: "empty"; suggestions: string[] }
  | { phase: "failed"; retryable: boolean };

/* ============================================================
   Audience filter — one batched call, strict JSON out.
   ============================================================ */

export const FilterVerdictSchema = z.object({
  shortCode: z.string(),
  keep: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const FilterResponseSchema = z.object({
  verdicts: z.array(FilterVerdictSchema),
});

export type FilterVerdict = z.infer<typeof FilterVerdictSchema>;

/* ============================================================
   Breakdown — the product's core verb. Strict JSON out.
   ============================================================ */

/** Two-tier section: verdict always visible, reasoning one tap away. */
export const TierSchema = z.object({
  /** ONE sentence, <=15 words. The verdict. */
  punch: z.string(),
  /** 2-3 sentences. Collapsed, never truncated. */
  detail: z.string(),
});
export type Tier = z.infer<typeof TierSchema>;

export const BreakdownSchema = z.object({
  hook_read: TierSchema,
  mechanism: TierSchema,
  format: TierSchema,
  /** Hero card. Punch only, no detail. */
  steal_this: z.string(),
});

export type Breakdown = z.infer<typeof BreakdownSchema> & {
  /** false => thumbnail fetch failed and we fell back to text-only. */
  image_used: boolean;
};
