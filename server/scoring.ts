/**
 * Hot 100 Scoring Engine — Optimal 5-Signal Model
 * Composite score (0–100) — all signals normalized within the weekly batch.
 *
 * Signal weights:
 *   35%  WoW View Acceleration   — Tubular creator.trends (last 2 wks vs prior 2 wks)
 *   20%  YoY Views Growth        — Tubular monthly_performance.views_growth_yoy
 *   20%  Engagement Rate         — Modash engagementRate (fallback: Tubular TCR er)
 *   15%  Followers Growth 30d    — Tubular performance.followers_growth (fractional)
 *   10%  Audience Quality        — 1 − Modash credibilityScore (lower fake% = better)
 *
 * Multiplier: × 1.15 if Tubular rising_star = true
 *
 * All signals are normalized (0–100) within the current batch before combining.
 * Final score is capped at 100.
 */

import type { TubularCreator, TubularTrendData } from "./tubular";
import type { ModashReport } from "./modash";

export interface ScoredCreator {
  // Identity
  tubularId: string;
  modashUserId: string | null;
  name: string;
  description: string;
  thumbnailUrl: string;
  channelUrl: string;
  channelGid: string;
  country: string;
  language: string;
  genre: string;
  genreId: number | null;
  themes: string[];
  risingstar: boolean;

  // Core metrics
  followers: number;
  followersGrowth: number;
  monthlyViews: number;
  monthlyEngagements: number;
  engagementRate: number;
  averageViews: number;
  uploads30d: number;
  latestMonth: string;

  // Velocity signals
  wowAcceleration: number | null;       // fractional, e.g. 0.45 = +45% WoW
  viewVelocityPct: number | null;       // legacy monthly velocity (for display)
  yoyViewsGrowth: number;               // from Tubular monthly_performance

  // Audience
  audienceGenders: Array<{ code: string; weight: number }>;
  audienceCountries: Array<{ name: string; weight: number }>;
  audienceAgeGroups: Array<{ code: string; weight: number }>;

  // Contact
  contactEmail: string | null;
  contactLinks: Array<{ type: string; value: string }>;
  credibilityScore: number | null;

  // Scores (each 0–100)
  hotScore: number;
  accelerationScore: number;  // 35% — WoW view acceleration
  yoyScore: number;           // 20% — YoY views growth
  engagementScore: number;    // 20% — engagement rate
  growthScore: number;        // 15% — followers growth
  qualityScore: number;       // 10% — audience quality
  predictionScore: number;    // ML predicted-growth signal (0 until ML pass)
  risingStarBonus: boolean;   // whether ×1.15 was applied
  rank: number;
}

// ── Scoring weights ───────────────────────────────────────────────────────────
// Base 5-signal weights (sum = 1.0).
export const BASE_WEIGHTS = {
  acceleration: 0.35,
  yoy: 0.20,
  engagement: 0.20,
  growth: 0.15,
  quality: 0.10,
};

// Weight assigned to the ML predicted-growth signal once forecasts exist.
export const PREDICTION_WEIGHT = 0.18;

// 6-signal weights: the base signals are scaled down by (1 − PREDICTION_WEIGHT)
// so the total still sums to 1.0, and prediction takes the remaining share.
export const ML_WEIGHTS = {
  acceleration: BASE_WEIGHTS.acceleration * (1 - PREDICTION_WEIGHT),
  yoy:          BASE_WEIGHTS.yoy          * (1 - PREDICTION_WEIGHT),
  engagement:   BASE_WEIGHTS.engagement   * (1 - PREDICTION_WEIGHT),
  growth:       BASE_WEIGHTS.growth       * (1 - PREDICTION_WEIGHT),
  quality:      BASE_WEIGHTS.quality      * (1 - PREDICTION_WEIGHT),
  prediction:   PREDICTION_WEIGHT,
};

export interface EnrichedInput {
  tubular: TubularCreator;
  modash: ModashReport | null;
  trends: TubularTrendData | null;
}

// ── Normalisation helper ─────────────────────────────────────────────────────

// Percentile-rank normalisation: maps each value to its rank position within
// the batch (0–100). Unlike min-max, this is robust to outliers and produces a
// uniform, well-spread distribution every week regardless of extreme values.
// Ties share the average rank so equal inputs get equal scores.
function normalizeArr(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [100];

  // Pair each value with its original index, then sort ascending by value.
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const out = new Array<number>(n);
  let k = 0;
  while (k < n) {
    // Group ties (identical values) so they receive the same percentile.
    let j = k;
    while (j + 1 < n && indexed[j + 1].v === indexed[k].v) j++;
    // Average rank position of the tie group, scaled to 0–100.
    const avgRank = (k + j) / 2;
    const pct = (avgRank / (n - 1)) * 100;
    for (let m = k; m <= j; m++) out[indexed[m].i] = pct;
    k = j + 1;
  }
  return out;
}

// ── Pre-filter ────────────────────────────────────────────────────────────────
// NOTE: Tubular search already filters by followers + growth + uploads at the
// API level (including the US country filter). This pre-filter is a lightweight
// safety net against edge cases in scroll pagination.

export function preFilter(
  creators: TubularCreator[],
  opts: {
    minFollowers: number;
    maxFollowers: number;
    minFollowersGrowth: number;
    minUploads30d: number;
    countryUsOnly?: boolean;
    englishOnly?: boolean;
  }
): TubularCreator[] {
  return creators.filter(c => {
    if (c.followers < opts.minFollowers || c.followers > opts.maxFollowers) return false;
    if (c.followersGrowth < opts.minFollowersGrowth) return false;
    if (c.uploads30 < opts.minUploads30d) return false;
    // Strict US-only: exclude any creator not explicitly marked country = US
    if (opts.countryUsOnly && (c.country ?? "").toUpperCase() !== "US") return false;
    // English primary language only
    if (opts.englishOnly && (c.language ?? "").toLowerCase() !== "en") return false;
    return true;
  });
}

// ── Main scoring function ─────────────────────────────────────────────────────

export function scoreCreators(inputs: EnrichedInput[]): ScoredCreator[] {
  if (!inputs.length) return [];

  // ── Step 1: Extract raw signals ──────────────────────────────────────────
  const signals = inputs.map(({ tubular: t, modash: m, trends: tr }) => {
    // Signal 1 (35%): WoW acceleration from Tubular trends
    // If trends not available, fall back to 0 (will normalize to median in batch)
    const wowAccel = tr?.wowAcceleration ?? 0;

    // Signal 2 (20%): YoY views growth from Tubular monthly_performance
    const yoyViews = t.monthlyViewsGrowthYoy ?? 0; // already a % value e.g. 97.4

    // Signal 3 (20%): Engagement rate — prefer Modash, fall back to Tubular TCR
    const engagementRate = m
      ? m.engagementRate               // Modash: 0.0–1.0 (e.g. 0.035 = 3.5%)
      : (t.tcrEr ?? 0);               // Tubular TCR er: also 0.0–1.0

    // Signal 4 (15%): Followers growth 30d (fractional, e.g. 0.215 = 21.5%)
    const followersGrowth = t.followersGrowth;

    // Signal 5 (10%): Audience quality = 1 − credibility fake score
    // credibilityScore 0.87 → fakeScore = 1 - 0.87 = 0.13 → quality = 0.87
    // If Modash not available, assume neutral quality (will normalize to median)
    const audienceQuality = m?.credibilityScore != null
      ? m.credibilityScore            // already 0.0–1.0 where 1.0 = best quality
      : 0.5;                          // neutral fallback

    return { wowAccel, yoyViews, engagementRate, followersGrowth, audienceQuality };
  });

  // ── Step 2: Normalize each signal 0–100 across the batch ─────────────────
  const accelNorm    = normalizeArr(signals.map(s => s.wowAccel));
  const yoyNorm      = normalizeArr(signals.map(s => s.yoyViews));
  const engageNorm   = normalizeArr(signals.map(s => s.engagementRate));
  const growthNorm   = normalizeArr(signals.map(s => s.followersGrowth));
  const qualityNorm  = normalizeArr(signals.map(s => s.audienceQuality));

  // ── Step 3: Composite score ──────────────────────────────────────────────
  const scored: ScoredCreator[] = inputs.map(({ tubular: t, modash: m, trends: tr }, i) => {
    const accelerationScore = Math.round(accelNorm[i]   * 10) / 10;
    const yoyScore          = Math.round(yoyNorm[i]     * 10) / 10;
    const engagementScore   = Math.round(engageNorm[i]  * 10) / 10;
    const growthScore       = Math.round(growthNorm[i]  * 10) / 10;
    const qualityScore      = Math.round(qualityNorm[i] * 10) / 10;

    // Weighted composite
    let rawScore =
      accelerationScore * 0.35 +
      yoyScore          * 0.20 +
      engagementScore   * 0.20 +
      growthScore       * 0.15 +
      qualityScore      * 0.10;

    // Rising star bonus: ×1.15
    const risingStarBonus = t.risingstar;
    if (risingStarBonus) rawScore *= 1.15;

    // Cap at 100
    const hotScore = Math.round(Math.min(rawScore, 100) * 10) / 10;

    // Legacy monthly velocity (for display column in table)
    const viewVelocityPct = computeMonthlyVelocity(m);

    return {
      tubularId: t.id,
      modashUserId: m?.userId ?? null,
      name: t.name,
      description: m?.description || t.description,
      thumbnailUrl: m?.picture || t.thumbnailUrl,
      channelUrl: m?.url || t.channelUrl,
      channelGid: t.channelGid,
      country: m?.country || t.country,
      language: t.language,
      genre: t.genre,
      genreId: t.genreId,
      themes: t.themes,
      risingstar: t.risingstar,

      followers: t.followers,
      followersGrowth: t.followersGrowth,
      monthlyViews: t.monthlyViews,
      monthlyEngagements: t.monthlyEngagements,
      engagementRate: m?.engagementRate ?? (t.tcrEr ?? 0),
      averageViews: m?.averageViews ?? (t.tcrV30 ?? 0),
      uploads30d: t.uploads30,
      latestMonth: t.latestMonth,

      wowAcceleration: tr?.wowAcceleration ?? null,
      viewVelocityPct,
      yoyViewsGrowth: t.monthlyViewsGrowthYoy,

      audienceGenders: m?.audience.genders ?? [],
      audienceCountries: m?.audience.geoCountries ?? [],
      audienceAgeGroups: m?.audience.ageGroups ?? [],

      contactEmail: m?.contactEmail ?? null,
      contactLinks: m?.contactLinks ?? [],
      credibilityScore: m?.credibilityScore ?? null,

      hotScore,
      accelerationScore,
      yoyScore,
      engagementScore,
      growthScore,
      qualityScore,
      predictionScore: 0, // set during the ML pass (applyPredictionSignal)
      risingStarBonus,
      rank: 0, // assigned after sorting
    };
  });

  // ── Step 4: Sort + assign ranks ──────────────────────────────────────────
  scored.sort((a, b) => b.hotScore - a.hotScore);
  scored.forEach((s, i) => { s.rank = i + 1; });

  // ── Step 5: Top 100 ──────────────────────────────────────────────────────
  return scored.slice(0, 100);
}

// ML pass: rescore with the predicted-growth signal.
// Called AFTER the time-series forecasts are computed. Normalises the new
// predicted-growth signal across the batch, recomputes the composite with
// ML_WEIGHTS, and re-ranks. Returns the same array, mutated and re-sorted.
export function applyPredictionSignal(
  scored: ScoredCreator[],
  predictedGrowthById: Map<string, number>
): ScoredCreator[] {
  if (!scored.length) return scored;

  const rawPred = scored.map(s => predictedGrowthById.get(s.tubularId) ?? 0);
  const predNorm = normalizeArr(rawPred);

  scored.forEach((s, i) => {
    s.predictionScore = Math.round(predNorm[i] * 10) / 10;

    let raw =
      s.accelerationScore * ML_WEIGHTS.acceleration +
      s.yoyScore          * ML_WEIGHTS.yoy +
      s.engagementScore   * ML_WEIGHTS.engagement +
      s.growthScore       * ML_WEIGHTS.growth +
      s.qualityScore      * ML_WEIGHTS.quality +
      s.predictionScore   * ML_WEIGHTS.prediction;

    if (s.risingStarBonus) raw *= 1.15;
    s.hotScore = Math.round(Math.min(raw, 100) * 10) / 10;
  });

  scored.sort((a, b) => b.hotScore - a.hotScore);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}

// ── Legacy monthly velocity (Modash statHistory) ──────────────────────────────
// Used for display in the creator table, not for scoring.
function computeMonthlyVelocity(
  m: ModashReport | null
): number | null {
  if (!m?.statHistory || m.statHistory.length < 2) return null;
  const sorted = [...m.statHistory].sort((a, b) => a.month.localeCompare(b.month));
  const latest = sorted[sorted.length - 1];
  const prior  = sorted[Math.max(0, sorted.length - 4)];
  if (!prior || prior.avgViews === 0) return null;
  return ((latest.avgViews - prior.avgViews) / prior.avgViews) * 100;
}
