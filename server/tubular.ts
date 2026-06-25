/**
 * Tubular Labs API v4 Client
 * Base URL : https://tubularlabs.com/api
 * Auth     : api-key header (no Bearer prefix)
 *
 * Endpoints used:
 *   POST /v4/creator.search  — search + filter creators, returns snippet + account data
 *   POST /v4/creator.trends  — weekly time-series for WoW acceleration
 *
 * Rate limit: 60 req/min for Creator API
 * Quota cost: 5 units base + per-field charges for creator.search
 *             0.2 units per row (1 creator × 1 week bucket) for creator.trends
 */

const BASE_URL = "https://tubularlabs.com/api";

// ── Genre ID → label map (from docs) ─────────────────────────────────────────
export const GENRE_MAP: Record<number, string> = {
  2:  "Travel",
  3:  "Music & Dance",
  4:  "Sports",
  5:  "Animals & Pets",
  7:  "People & Blogs",
  9:  "Cars & Racing",
  11: "Business",
  13: "Kids & Animation",
  14: "Education",
  15: "Food & Drink",
  16: "Fashion & Style",
  19: "Health & Fitness",
  21: "Home & DIY",
  22: "News & Politics",
  23: "Beauty",
  24: "Film & Movies",
  27: "Gaming",
  32: "Family & Parenting",
  33: "Science & Tech",
  36: "Entertainment",
  37: "General Interest",
};

// ── Response shapes ───────────────────────────────────────────────────────────

export interface TubularCreator {
  id: string;                   // Tubular creator ID
  name: string;
  description: string;
  thumbnailUrl: string;
  channelUrl: string;           // e.g. http://youtube.com/channel/UC...
  channelGid: string;           // e.g. yta_xxx
  youtubeCategory: string;
  type: string;                 // influencer | brand | media company | aggregator
  country: string;
  language: string;
  genre: string;
  genreId: number | null;
  themes: string[];
  risingstar: boolean;

  // Performance (all-time + 30d)
  followers: number;
  followers30d: number;
  followersGrowth: number;      // fractional e.g. 0.215 = 21.5%
  totalViews: number;
  viewsPerUpload: number;
  totalEngagements: number;
  uploads30: number;
  uploads90: number;
  uploads365: number;
  totalUploads: number;
  firstUpload: string;
  lastUpload: string;
  influencerScore: number;

  // Monthly (latest available month)
  latestMonth: string;          // YYYY-MM
  monthlyViews: number;
  monthlyViewsGrowthYoy: number;
  monthlyEngagements: number;
  monthlyFollowers: number;
  monthlyFollowersGrowthYoy: number;

  // TCR (Tubular Channel Ratings)
  tcrEr: number | null;         // engagement rate (30d)
  tcrV30: number | null;        // views in 30d
  tcrE30: number | null;        // engagements in 30d
}

/**
 * Weekly acceleration computed from creator.trends time-series.
 * wowAcceleration: (avg views last 2 weeks) / (avg views prior 2 weeks) - 1
 * Range: can be negative. Positive = accelerating.
 */
export interface TubularTrendData {
  creatorId: string;
  wowAcceleration: number;      // e.g. 0.45 = +45% acceleration
  weeklyViewBuckets: number[];  // raw weekly view counts, ascending
}

export type Platform = "youtube" | "tiktok" | "instagram";

// ── Normalise a single result row from creator.search ─────────────────────────

function normaliseCreator(raw: any, platform: Platform = "youtube"): TubularCreator | null {
  try {
    const yt = raw.accounts?.[platform];
    if (!yt) return null;

    const perf = yt.performance ?? {};
    const monthly = yt.monthly_performance ?? {};
    const tax = raw.taxonomy ?? {};
    const genreId: number | null = tax.genre?.id ?? null;

    return {
      id: raw.id,
      name: raw.snippet?.title ?? yt.title ?? "",
      description: raw.snippet?.description ?? yt.description ?? "",
      thumbnailUrl: raw.snippet?.thumbnail ?? yt.thumbnail ?? "",
      channelUrl: yt.url ?? "",
      channelGid: yt.gid ?? "",
      youtubeCategory: yt.category ?? "",
      type: tax.type ?? "influencer",
      country: tax.country ?? "",
      language: tax.language ?? "",
      genre: genreId ? (GENRE_MAP[genreId] ?? `Genre ${genreId}`) : (yt.category ?? ""),
      genreId,
      themes: (tax.themes ?? []).map((t: any) => t.title),
      risingstar: tax.rising_star ?? false,

      followers: perf.followers ?? 0,
      followers30d: perf.followers_30 ?? 0,
      followersGrowth: perf.followers_growth ?? 0,
      totalViews: perf.views ?? 0,
      viewsPerUpload: perf.views_per_upload ?? 0,
      totalEngagements: perf.engagements ?? 0,
      uploads30: perf.uploads_30 ?? 0,
      uploads90: perf.uploads_90 ?? 0,
      uploads365: perf.uploads_365 ?? 0,
      totalUploads: perf.uploads ?? 0,
      firstUpload: perf.first_upload ?? "",
      lastUpload: perf.last_upload ?? "",
      influencerScore: perf.influencer_score ?? 0,

      latestMonth: monthly.month ?? "",
      monthlyViews: monthly.views ?? 0,
      monthlyViewsGrowthYoy: monthly.views_growth_yoy ?? 0,
      monthlyEngagements: monthly.engagements ?? 0,
      monthlyFollowers: monthly.followers ?? 0,
      monthlyFollowersGrowthYoy: monthly.followers_growth_yoy ?? 0,

      tcrEr: monthly.tcr?.er ?? null,
      tcrV30: monthly.tcr?.v30 ?? null,
      tcrE30: monthly.tcr?.e30 ?? null,
    };
  } catch {
    return null;
  }
}

// ── Phase 1: creator.search with US filter ────────────────────────────────────

export async function fetchTubularCreators(
  apiKey: string,
  opts: {
    minFollowers: number;
    maxFollowers: number;
    minUploads30d: number;
    minFollowersGrowth: number;
    limit: number;
    platform?: Platform;
  }
): Promise<TubularCreator[]> {
  if (!apiKey?.trim()) throw new Error("Tubular API key not configured");
  const platform: Platform = opts.platform ?? "youtube";

  const allCreators: TubularCreator[] = [];
  let scrollToken: string | null = null;
  const batchSize = Math.min(200, opts.limit);
  let fetched = 0;

  // Build the base request payload — US-only filter
  const basePayload = {
    include: {
      platforms: [platform],
      types: ["influencer"],
      countries: ["US"],          // ← US creators only (strict)
      languages: ["en"],          // ← English-language creators only
      performance: {
        followers: { min: opts.minFollowers, max: opts.maxFollowers },
        uploads_30d: { min: opts.minUploads30d },
        followers_growth: { min: opts.minFollowersGrowth },
      },
    },
    fields: {
      snippet: true,
      taxonomy: true,
      account_snippet: true,
      account_performance: true,
      account_monthly_performance: true,
    },
    sort: {
      metric: "account_monthly_views",
      platform,
      ascending: false,
    },
    scroll: { size: batchSize },
  };

  do {
    const payload: any = { ...basePayload };
    if (scrollToken) {
      payload.scroll = { token: scrollToken, size: batchSize };
    }

    const res = await fetch(`${BASE_URL}/v4/creator.search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tubular API ${res.status}: ${body}`);
    }

    const data = await res.json();
    const results: any[] = data.results ?? [];

    for (const row of results) {
      const creator = normaliseCreator(row, platform);
      if (creator) allCreators.push(creator);
    }

    // Tubular returns the next-page cursor under `scroll.token` (NOT `scroll_token`).
    scrollToken = data.scroll?.token ?? data.scroll_token ?? null;
    fetched += results.length;

    // Stop if the page came back empty (no more data) to avoid infinite loops.
    if (results.length === 0) break;

    // Respect rate limit: 60 req/min → ~1 req/s minimum
    if (scrollToken && fetched < opts.limit) {
      await new Promise(r => setTimeout(r, 1100));
    }
  } while (scrollToken && fetched < opts.limit);

  return allCreators;
}

// ── Phase 1.5: creator.trends — weekly WoW acceleration ──────────────────────
//
// Fetches weekly view time-series for up to 200 creators.
// Cost: 0.2 units × (creators × weeks). With 200 creators × 8 weeks = 320 units.
// Batches IDs in groups of 50 to avoid oversized request bodies.

export async function fetchTubularTrends(
  apiKey: string,
  creatorIds: string[],
  platform: Platform = "youtube"
): Promise<Map<string, TubularTrendData>> {
  const result = new Map<string, TubularTrendData>();
  if (!apiKey?.trim() || !creatorIds.length) return result;

  // Process in batches of 50 to stay within request size limits
  const BATCH = 50;
  for (let i = 0; i < creatorIds.length; i += BATCH) {
    const batchIds = creatorIds.slice(i, i + BATCH);

    const res = await fetch(`${BASE_URL}/v4/creator.trends`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        ids: batchIds,
        platforms: [platform],
        metrics: ["views", "followers", "uploads"],
        date_range: { min: "last_60" },
        time_bucket: "weeks",
      }),
    });

    if (!res.ok) {
      // Non-fatal: trends enrichment degrades gracefully to YoY signal
      console.warn(`Tubular trends ${res.status} — skipping acceleration signal`);
      break;
    }

    const data = await res.json();
    const rows: any[] = data.results ?? data.data ?? [];

    // Group rows by creator ID, collect weekly view buckets
    const viewsByCreator = new Map<string, number[]>();
    for (const row of rows) {
      const cid: string = row.creator_id ?? row.id ?? "";
      if (!cid) continue;
      const views: number = row.views ?? row.metrics?.views ?? 0;
      if (!viewsByCreator.has(cid)) viewsByCreator.set(cid, []);
      viewsByCreator.get(cid)!.push(views);
    }

    // Compute WoW acceleration for each creator in this batch
    for (const [cid, buckets] of Array.from(viewsByCreator.entries())) {
      // Buckets arrive in chronological order from the API
      const sorted = [...buckets]; // already sorted by date ascending from Tubular
      const wowAcceleration = computeWowAcceleration(sorted);
      result.set(cid, {
        creatorId: cid,
        wowAcceleration,
        weeklyViewBuckets: sorted,
      });
    }

    // Rate-limit gap between batches
    if (i + BATCH < creatorIds.length) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  return result;
}

/**
 * Week-over-week acceleration from weekly view buckets.
 * Compares avg views of the last 2 weeks vs prior 2 weeks.
 * Returns fractional change, e.g. 0.45 = +45%.
 */
function computeWowAcceleration(weeklyViews: number[]): number {
  if (weeklyViews.length < 4) {
    // Not enough data — fall back to simple last/first ratio
    if (weeklyViews.length < 2) return 0;
    const first = weeklyViews[0] || 1;
    const last = weeklyViews[weeklyViews.length - 1];
    return (last - first) / first;
  }

  const n = weeklyViews.length;
  // Last 2 weeks
  const recent = (weeklyViews[n - 1] + weeklyViews[n - 2]) / 2;
  // Prior 2 weeks (weeks 3-4 from end)
  const prior = (weeklyViews[n - 3] + weeklyViews[n - 4]) / 2;

  if (prior <= 0) return recent > 0 ? 1 : 0; // avoid div-by-zero
  return (recent - prior) / prior;
}

// ── Weekly long-history (for ML forecasting) ─────────────────────────────────
//
// Fetches per-WEEK views/followers for the given creators over a very long
// window (10 years). Tubular only has real data from each creator's start, so
// older weeks come back as zeros — forecast.ts trims those leading zeros, so
// every creator effectively trains on the MAX history it actually has.
//
// We request `time_bucket: "weeks"` (Tubular aggregates server-side) instead of
// daily points: far smaller payloads over a decade, and weekly is exactly the
// granularity the models use. Tubular returns ISO-week labels (e.g. 2022-W09)
// which we convert to the week-ending Sunday date so the rest of the pipeline
// keeps working with calendar dates.

// How far back to request. Anything before a creator's first data is zero-padded
// by Tubular and trimmed downstream, so this is just an upper bound.
const HISTORY_YEARS = 1;

export interface DailyHistoryPoint {
  date: string;      // YYYY-MM-DD
  views: number;     // views that day
  followers: number; // net follower change that day
  uploads: number;   // number of videos uploaded that day
  engagements: number; // engagements that day
}

// Convert an ISO week label "YYYY-Www" to that week's ending Sunday (YYYY-MM-DD).
function isoWeekToSunday(label: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) return label; // already a date? pass through
  const year = Number(m[1]), week = Number(m[2]);
  // ISO week 1 contains the year's first Thursday; Monday of week 1 is the base.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const mon = new Date(week1Mon);
  mon.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6); // week-ending Sunday
  return sun.toISOString().slice(0, 10);
}

export async function fetchTubularDailyHistory(
  apiKey: string,
  creatorIds: string[],
  platform: Platform = "youtube",
  onBatch?: (done: number, total: number) => void
): Promise<Map<string, DailyHistoryPoint[]>> {
  const result = new Map<string, DailyHistoryPoint[]>();
  if (!apiKey?.trim() || !creatorIds.length) return result;

  // Long explicit date window. Tubular's `last_730`/`last_1095` keywords 500, so
  // we pass explicit min/max dates which reliably return the full history.
  const minDate = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - HISTORY_YEARS);
    return d.toISOString().slice(0, 10);
  })();
  const maxDate = new Date().toISOString().slice(0, 10);

  const BATCH = 25;
  for (let i = 0; i < creatorIds.length; i += BATCH) {
    const batchIds = creatorIds.slice(i, i + BATCH);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v4/creator.trends`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        body: JSON.stringify({
          ids: batchIds,
          platforms: [platform],
          metrics: ["views", "followers", "uploads", "engagements"],
          date_range: { min: minDate, max: maxDate },
          time_bucket: "days", // daily points
        }),
      });
    } catch (e) {
      console.warn(`Tubular history fetch error — skipping batch:`, e);
      onBatch?.(Math.min(i + BATCH, creatorIds.length), creatorIds.length);
      continue;
    }

    if (!res.ok) {
      console.warn(`Tubular history ${res.status} — skipping batch`);
      onBatch?.(Math.min(i + BATCH, creatorIds.length), creatorIds.length);
      if (res.status === 429) await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    const data = await res.json();
    const rows: any[] = data.results ?? data.data ?? [];
    for (const row of rows) {
      const cid: string = row.id ?? row.creator_id ?? "";
      if (!cid) continue;
      const points: DailyHistoryPoint[] = (row.points ?? []).map((p: any) => ({
        date: isoWeekToSunday(p.date), // YYYY-Www or YYYY-MM-DD
        views: p.views ?? 0,
        followers: p.followers ?? 0,
        uploads: p.uploads ?? 0,
        engagements: p.engagements ?? 0,
      }));
      result.set(cid, points);
    }

    onBatch?.(Math.min(i + BATCH, creatorIds.length), creatorIds.length);

    if (i + BATCH < creatorIds.length) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  return result;
}

// ── Genre lookup (returns name from ID) ──────────────────────────────────────
export function getGenreLabel(id: number | null): string {
  if (id === null) return "Uncategorized";
  return GENRE_MAP[id] ?? `Genre ${id}`;
}
