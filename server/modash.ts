/**
 * Modash Discovery API Client
 * Base URL : https://api.modash.io/v1
 * Auth     : Authorization: Bearer <key>
 * Docs     : https://docs.modash.io/products/discovery_api/openapi_doc/discovery
 *
 * Endpoints used:
 *   POST /v1/youtube/search          — find creators by filters
 *   GET  /v1/youtube/profile/:id/report — full audience + contact report
 *
 * Each search returns 15 results per page.
 * Profile reports are more expensive — only call for shortlisted creators.
 */

const BASE_URL = "https://api.modash.io/v1";

export type Platform = "youtube" | "tiktok" | "instagram";

// ── Response shapes ───────────────────────────────────────────────────────────

export interface ModashSearchProfile {
  userId: string;               // YouTube channel ID (UC...)
  fullname: string;
  handle: string;               // @handle
  url: string;
  picture: string;
  followers: number;
  engagementRate: number;       // 0.0–1.0 (e.g. 0.035 = 3.5%)
  engagements: number;
  averageViews: number;
  isVerified: boolean;
}

export interface ModashAudience {
  genders: Array<{ code: "MALE" | "FEMALE"; weight: number }>;
  geoCountries: Array<{ name: string; weight: number }>;
  ageGroups: Array<{ code: string; weight: number }>;
  languages: Array<{ name: string; weight: number }>;
}

export interface ModashReport {
  userId: string;
  fullname: string;
  handle: string;
  url: string;
  picture: string;
  followers: number;
  engagementRate: number;
  averageViews: number;
  averagePosts: number;
  totalViews: number;
  country: string;
  description: string;

  // Contact info extracted from bio / linked accounts
  contactEmail: string | null;
  contactLinks: Array<{ type: string; value: string }>;

  // Audience data
  audience: ModashAudience;

  // Monthly history (last 7 months)
  statHistory: Array<{
    month: string;
    followers: number;
    avgViews: number;
    totalViews: number;
    avgLikes: number;
    avgComments: number;
  }>;

  // Fake followers (credibility) — 0.0–1.0 (lower is better)
  credibilityScore: number | null;
}

// ── Search (returns 15 per page) ──────────────────────────────────────────────

export async function searchModashYouTube(
  apiKey: string,
  opts: {
    minFollowers: number;
    maxFollowers: number;
    minEngagementRate: number; // as %, e.g. 3 for 3%
    page: number;
  }
): Promise<{ total: number; profiles: ModashSearchProfile[] }> {
  const res = await fetch(`${BASE_URL}/youtube/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      sort: { field: "followers", direction: "desc" },
      filter: {
        influencer: {
          followers: { min: opts.minFollowers, max: opts.maxFollowers },
          engagementRate: { min: opts.minEngagementRate },
        },
      },
      page: opts.page,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Modash search ${res.status}: ${body}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Modash: ${data.message}`);

  const profiles: ModashSearchProfile[] = (data.lookalikes ?? []).map((item: any) => ({
    userId: item.userId,
    fullname: item.profile.fullname ?? "",
    handle: item.profile.handle ?? "",
    url: item.profile.url ?? "",
    picture: item.profile.picture ?? "",
    followers: item.profile.followers ?? 0,
    engagementRate: item.profile.engagementRate ?? 0,
    engagements: item.profile.engagements ?? 0,
    averageViews: item.profile.averageViews ?? 0,
    isVerified: item.profile.isVerified ?? false,
  }));

  return { total: data.total ?? 0, profiles };
}

// ── Full Profile Report ────────────────────────────────────────────────────────

export async function getModashReport(
  apiKey: string,
  userId: string,
  platform: Platform = "youtube"
): Promise<ModashReport | null> {
  try {
    // Abort slow/hanging requests after 12s so the pipeline never stalls
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/${platform}/profile/${encodeURIComponent(userId)}/report`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null; // profile not in Modash DB or rate limited

    const data = await res.json();
    if (data.error) return null;

    const p = data.profile?.profile ?? data.profile ?? {};
    const full = data.profile ?? {};

    // Extract email from contacts array
    const contacts: Array<{ type: string; value: string }> = full.contacts ?? [];
    const emailContact = contacts.find((c: any) => c.type === "email");
    const contactEmail = emailContact?.value ?? null;

    // Parse audience
    const aud = full.audience ?? {};
    const audience: ModashAudience = {
      genders: (aud.genders ?? []).map((g: any) => ({ code: g.code, weight: g.weight })),
      geoCountries: (aud.geoCountries ?? []).slice(0, 10).map((c: any) => ({
        name: c.name ?? c.code,
        weight: c.weight,
      })),
      ageGroups: (aud.ages ?? aud.ageGroups ?? []).map((a: any) => ({
        code: a.code ?? a.name,
        weight: a.weight,
      })),
      languages: (aud.languages ?? []).slice(0, 5).map((l: any) => ({
        name: l.name ?? l.code,
        weight: l.weight,
      })),
    };

    // Monthly history
    const statHistory = (full.statHistory ?? []).map((s: any) => ({
      month: s.month,
      followers: s.followers ?? 0,
      avgViews: s.avgViews ?? 0,
      totalViews: s.totalViews ?? 0,
      avgLikes: s.avgLikes ?? 0,
      avgComments: s.avgComments ?? 0,
    }));

    return {
      userId: full.userId ?? userId,
      fullname: p.fullname ?? "",
      handle: p.handle ?? "",
      url: p.url ?? "",
      picture: p.picture ?? "",
      followers: p.followers ?? 0,
      engagementRate: p.engagementRate ?? 0,
      averageViews: p.averageViews ?? 0,
      averagePosts: p.averagePosts ?? 0,
      totalViews: p.totalViews ?? full.totalViews ?? 0,
      country: full.country ?? "",
      description: full.description ?? "",
      contactEmail,
      contactLinks: contacts.filter((c: any) => c.type !== "email"),
      audience,
      statHistory,
      credibilityScore: full.credibility?.score ?? null,
    };
  } catch {
    return null;
  }
}

// ── Compute view velocity from stat history ────────────────────────────────────
// Compare avg views of most recent month vs 3 months ago (% change)
export function computeViewVelocity(statHistory: ModashReport["statHistory"]): number | null {
  if (!statHistory || statHistory.length < 2) return null;

  // Sort by month ascending
  const sorted = [...statHistory].sort((a, b) => a.month.localeCompare(b.month));

  const latest = sorted[sorted.length - 1];
  const prior = sorted[Math.max(0, sorted.length - 4)]; // ~3 months ago

  if (!prior || prior.avgViews === 0) return null;
  return ((latest.avgViews - prior.avgViews) / prior.avgViews) * 100;
}
