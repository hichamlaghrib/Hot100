import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { fetchTubularCreators, fetchTubularTrends, fetchTubularDailyHistory } from "./tubular";
import { getModashReport } from "./modash";
import { scoreCreators, preFilter } from "./scoring";
import { forecastCreator } from "./forecast";
import type { CreatorForecast } from "./forecast";
import type { EnrichedInput } from "./scoring";
import type { Platform } from "./tubular";
import { z } from "zod";

const VALID_PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram"];

// ── Seed API keys from env on startup ────────────────────────────────────────
const TUBULAR_KEY_ENV = process.env.TUBULAR_API_KEY ?? "";
const MODASH_KEY_ENV  = process.env.MODASH_API_KEY  ?? "";

function seedKeys() {
  if (TUBULAR_KEY_ENV && !storage.getConfig("tubularApiKey")) {
    storage.setConfig("tubularApiKey", TUBULAR_KEY_ENV);
  }
  if (MODASH_KEY_ENV && !storage.getConfig("modashApiKey")) {
    storage.setConfig("modashApiKey", MODASH_KEY_ENV);
  }
}

// ── Week label helper ─────────────────────────────────────────────────────────

function getWeekLabel(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Cancellation registry ──────────────────────────────────────────────────────
const runningPipelines = new Map<number, AbortController>();

// ── Background pipeline ────────────────────────────────────────────────────────
//
// 3-Phase optimal architecture:
//   Phase 1  : Tubular creator.search (US-only, YouTube, 100k–1M followers)
//   Phase 1.5: Tubular creator.trends (top 200 — weekly WoW acceleration)
//   Phase 2  : Modash profile report (engagement, audience, credibility, contacts)

async function runPipeline(reportId: number, platform: Platform = "youtube", signal?: AbortSignal) {
  // Helper: throws if the pipeline has been cancelled
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("__CANCELLED__");
  };
  const tubularKey = storage.getConfig("tubularApiKey") ?? "";
  const modashKey  = storage.getConfig("modashApiKey")  ?? "";

  const minFollowers       = parseInt(storage.getConfig("minFollowers")       ?? "100000");
  const maxFollowers       = parseInt(storage.getConfig("maxFollowers")       ?? "1000000");
  const minFollowersGrowth = parseFloat(storage.getConfig("minFollowersGrowth") ?? "0.03"); // 3%
  const minUploads30d      = parseInt(storage.getConfig("minUploads30d")      ?? "2");
  const minEngagementRate  = parseFloat(storage.getConfig("minEngagementRate")  ?? "2");    // as %
  const targetCount        = parseInt(storage.getConfig("targetCount")        ?? "100");

  // Progress helper: writes a 0–100 percentage + phase + human label so the
  // frontend progress bar can render live status. Phases are weighted by their
  // typical duration: search 0–10, enrich 10–60, ML 60–92, scoring 92–100.
  const setProgress = (progress: number, phase: string, label: string) => {
    storage.updateReport(reportId, {
      status: "running",
      progress: Math.round(progress),
      phase,
      errorMessage: label,
    });
  };

  try {
    // ── Phase 1: Tubular creator.search (US, English, 100k–1M) ───────────
    checkCancelled();
    setProgress(2, "search", `Phase 1: Searching Tubular (US ${platform} creators)...`);
    storage.updateReport(reportId, {
      status: "running",
      errorMessage: `Phase 1: Searching Tubular (US ${platform} creators)...`,
    });

    // Fetch a large candidate pool. Many candidates are dropped downstream
    // (not in Modash DB, below engagement threshold, non-US after enrichment),
    // so we over-fetch heavily to guarantee `targetCount` survivors.
    const candidatePool = Math.min(1000, Math.max(targetCount * 8, 800));
    const rawCreators = await fetchTubularCreators(tubularKey, {
      minFollowers,
      maxFollowers,
      minUploads30d,
      minFollowersGrowth,
      limit: candidatePool,
      platform,
    });

    // Safety-net pre-filter (Tubular already applied these at API level)
    // Strict US-only + English enforced here regardless of API behaviour.
    const filtered = preFilter(rawCreators, {
      minFollowers,
      maxFollowers,
      minFollowersGrowth,
      minUploads30d,
      countryUsOnly: true,
      englishOnly: true,
    });

    if (!filtered.length) {
      storage.updateReport(reportId, {
        status: "error",
        errorMessage: "No creators passed the filter. Try relaxing thresholds in Settings.",
      });
      return;
    }

    // Trends pool: cover the candidates we may need to enrich (up to 400).
    const trendsPool = filtered.slice(0, Math.min(filtered.length, 400));

    // ── Phase 1.5: Tubular creator.trends — weekly WoW acceleration ───────
    checkCancelled();
    setProgress(8, "trends", `Phase 1.5: Fetching weekly trends for ${trendsPool.length} creators...`);

    const trendsMap = await fetchTubularTrends(
      tubularKey,
      trendsPool.map(c => c.id),
      platform
    );

    storage.updateReport(reportId, {
      status: "running",
      errorMessage: `Phase 2: Enriching creators with Modash (target ${targetCount})...`,
    });

    // ── Phase 2: Modash profile reports ───────────────────────────────────
    // Enrich candidates in monthly-views order until we collect `targetCount`
    // qualified survivors (US + above engagement threshold), then stop early.
    // This guarantees a full Hot 100 without over-spending on Modash calls.
    const toEnrich = filtered;
    const enriched: EnrichedInput[] = [];

    for (let i = 0; i < toEnrich.length; i++) {
      // Check cancellation at every iteration
      checkCancelled();
      // Early stop once we have enough qualified survivors.
      if (enriched.length >= targetCount) break;

      const t = toEnrich[i];
      let modash = null;

      // Live progress so the dashboard reflects enrichment advancement.
      // Enrichment spans the 10→60 progress band, scaled by qualified count.
      if (i % 5 === 0) {
        const pct = 10 + Math.min(50, (enriched.length / targetCount) * 50);
        setProgress(pct, "enrich",
          `Phase 2: Enriching creators with Modash... (${enriched.length}/${targetCount} qualified, scanned ${i})`);
      }

      if (modashKey) {
        // Modash lookup key differs by platform:
        //   YouTube   → channel ID (UCxxx) from channelUrl
        //   TikTok/IG → @handle / username from channelUrl
        let lookupId: string | null = null;
        if (platform === "youtube") {
          lookupId = t.channelUrl.match(/channel\/(UC[^/?]+)/)?.[1] ?? null;
        } else {
          // Extract @handle or trailing username segment from the profile URL
          lookupId =
            t.channelUrl.match(/@([^/?]+)/)?.[1] ??
            t.channelUrl.replace(/\/+$/, "").split("/").pop() ??
            null;
        }

        if (lookupId) {
          modash = await getModashReport(modashKey, lookupId, platform);
        }

        // Rate limit: ~3 req/sec (Modash tolerates this for report calls)
        if (enriched.length < targetCount - 1 && i < toEnrich.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Filter by engagement rate if Modash data available
      if (modashKey && modash && (modash.engagementRate * 100) < minEngagementRate) {
        continue; // skip below-threshold creator
      }

      // Strict US-only (post-enrichment): exclude any creator whose resolved
      // country is not explicitly US. Modash creator-location takes precedence
      // over Tubular taxonomy (same precedence used by the scorer). If Modash
      // returns a country at all and it isn't US, drop the creator.
      const resolvedCountry = (modash?.country || t.country || "").toUpperCase();
      if (resolvedCountry && resolvedCountry !== "US") {
        continue;
      }

      // Attach trend data (null if trends API failed or creator not in pool)
      const trends = trendsMap.get(t.id) ?? null;

      enriched.push({ tubular: t, modash, trends });
    }

    // ── Phase 3: Score + rank (base 5-signal model) ──────────────────────
    setProgress(60, "scoring", `Phase 3: Scoring ${enriched.length} creators...`);
    const scored = scoreCreators(enriched);

    // ── Phase 3.5: ML time-series forecasting ────────────────────────────
    setProgress(62, "ml", `Phase 3.5: Fetching 1-year history for ${scored.length} creators...`);

    const forecastById = new Map<string, CreatorForecast>();

    try {
      const ids = scored.map(s => s.tubularId);
      const dailyMap = await fetchTubularDailyHistory(tubularKey, ids, platform, (done, total) => {
        setProgress(62 + (done / total) * 28, "ml",
          `Phase 3.5: Fetching 1-year history... (${done}/${total})`);
      });

      setProgress(90, "ml", `Phase 3.5: Training univariate models on ${scored.length} creators...`);

      for (const s of scored) {
        const daily = dailyMap.get(s.tubularId) ?? [];
        const fc = forecastCreator(
          daily.map(p => ({ date: p.date, views: p.views, followers: p.followers })),
          s.followers
        );
        forecastById.set(s.tubularId, fc);
      }
    } catch (mlErr) {
      console.warn("ML forecasting phase failed — keeping base scores:", mlErr);
    }

    // ── Phase 4: Persist ───────────────────────────────────────────────────
    checkCancelled();
    const now = new Date();
    const toInsert = scored.map(c => {
      const fc = forecastById.get(c.tubularId);
      return {
      reportId,
      channelId: c.tubularId,
      modashId: c.modashUserId,
      name: c.name,
      handle: c.channelUrl.match(/@([^/?]+)/)?.[1]
        ?? c.channelUrl.replace(/\/+$/, "").split("/").pop()
        ?? null,
      platform,
      profileUrl: c.channelUrl,
      avatarUrl: c.thumbnailUrl,
      description: c.description?.slice(0, 600) || null,
      genre: c.genre,
      subGenre: c.themes.slice(0, 3).join(", ") || null,
      country: c.country,
      language: c.language,
      followers: c.followers,
      subscriberCount: c.followers,
      totalViews: null as any,
      avgViews30d: c.averageViews || null,
      views30d: c.monthlyViews || null,
      views7d: null as any,
      engagementRate: c.engagementRate || null,
      viewVelocity30d: c.wowAcceleration != null
        ? c.wowAcceleration * 100           // store as % for display
        : (c.viewVelocityPct ?? null),
      uploadFrequency: c.uploads30d ? (c.uploads30d / 4.33) : null, // per-week
      audienceAge: c.audienceAgeGroups.length ? JSON.stringify(c.audienceAgeGroups) : null,
      audienceGender: c.audienceGenders.length ? JSON.stringify(c.audienceGenders) : null,
      audienceTopCountries: c.audienceCountries.length ? JSON.stringify(c.audienceCountries) : null,
      hotScore: c.hotScore,
      velocityScore: c.accelerationScore,     // 35% WoW acceleration
      engagementScore: c.engagementScore,      // 20% engagement rate
      consistencyScore: c.growthScore,         // 15% followers growth (reuses consistencyScore col)
      rank: c.rank,
      contactEmail: c.contactEmail,
      agencyName: null,
      managerName: null,
      managerEmail: null,
      managerPhone: null,
      contactNotes: null,
      isFlagged: false,
      isBookmarked: false,
      createdAt: now,
      // ── ML forecast fields ──────────────────────────────────────────────
      predictionScore: c.predictionScore ?? 0,
      historyJson: fc ? JSON.stringify(fc.history) : null,
      forecastJson: fc ? JSON.stringify(fc.forecast) : null,
      bestModelViews: fc ? fc.views.bestModel : null,
      bestModelFollowers: fc ? fc.followers.bestModel : null,
      modelScoresJson: fc
        ? JSON.stringify({
            views: fc.views.scores,
            followers: fc.followers.scores,
            viewsDiag: fc.views.diagnostics,
            followersDiag: fc.followers.diagnostics,
          })
        : null,
      predViewsGrowth: fc ? fc.predViewsGrowth : null,
      predFollowersGrowth: fc ? fc.predFollowersGrowth : null,
      };
    });

    storage.upsertCreators(toInsert);
    storage.updateReport(reportId, {
      status: "complete",
      totalFound: scored.length,
      progress: 100,
      phase: "done",
      errorMessage: null,
    });

  } catch (err: any) {
    // If cancelled by the user, the cancel endpoint already updated the status —
    // don't overwrite it with a generic error.
    if (err?.message === "__CANCELLED__") return;
    storage.updateReport(reportId, {
      status: "error",
      errorMessage: err?.message ?? "Unknown error",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerRoutes(httpServer: Server, app: Express) {
  seedKeys();

  // ── Config ──────────────────────────────────────────────────────────────

  app.get("/api/config", (_req, res) => {
    const all = storage.getAllConfig();
    const cfg: Record<string, string> = {};
    for (const row of all) {
      // Mask API keys in response — show only last 8 chars
      if (row.key.toLowerCase().includes("key")) {
        cfg[row.key] = row.value ? `${"•".repeat(Math.max(0, row.value.length - 8))}${row.value.slice(-8)}` : "";
      } else {
        cfg[row.key] = row.value;
      }
    }
    // Return indicator of whether keys are set
    cfg["tubularKeySet"] = storage.getConfig("tubularApiKey") ? "true" : "false";
    cfg["modashKeySet"]  = storage.getConfig("modashApiKey")  ? "true" : "false";
    res.json(cfg);
  });

  app.post("/api/config", (req, res) => {
    const schema = z.object({
      tubularApiKey: z.string().optional(),
      modashApiKey: z.string().optional(),
      minFollowers: z.string().optional(),
      maxFollowers: z.string().optional(),
      minFollowersGrowth: z.string().optional(),
      minEngagementRate: z.string().optional(),
      minUploads30d: z.string().optional(),
      targetCount: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });

    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined && v !== "") storage.setConfig(k, v);
    }
    res.json({ ok: true });
  });

  // ── Reports ──────────────────────────────────────────────────────────────

  app.get("/api/reports", (_req, res) => {
    res.json(storage.getReports());
  });

  app.get("/api/reports/:id", (req, res) => {
    const report = storage.getReport(Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Not found" });
    res.json(report);
  });

  app.get("/api/reports/:id/status", (req, res) => {
    const report = storage.getReport(Number(req.params.id));
    if (!report) return res.status(404).json({ error: "Not found" });
    res.json({
      status: report.status,
      totalFound: report.totalFound,
      progress: report.progress ?? 0,
      phase: report.phase ?? null,
      errorMessage: report.errorMessage,
    });
  });

  app.get("/api/reports/:id/creators", (req, res) => {
    const { genre, platform, bookmarked, sort } = req.query;
    let list = storage.getCreatorsByReport(Number(req.params.id));

    if (genre && genre !== "all") list = list.filter(c => c.genre === genre);
    if (platform && platform !== "all") list = list.filter(c => c.platform === platform);
    if (bookmarked === "true") list = list.filter(c => c.isBookmarked);

    if (sort === "velocity") list.sort((a, b) => (b.viewVelocity30d ?? 0) - (a.viewVelocity30d ?? 0));
    else if (sort === "followers") list.sort((a, b) => (b.subscriberCount ?? 0) - (a.subscriberCount ?? 0));
    else if (sort === "engagement") list.sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0));
    else list.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

    res.json(list);
  });

  // ── Run Pipeline ──────────────────────────────────────────────────────────

  app.post("/api/reports/run", async (req, res) => {
    const tubularKey = storage.getConfig("tubularApiKey") ?? "";
    if (!tubularKey) {
      return res.status(400).json({ error: "Tubular API key not configured. Go to Settings." });
    }

    // Per-platform run: one report covers exactly one platform.
    const requested = String(req.body?.platform ?? "youtube").toLowerCase();
    const platform: Platform = (VALID_PLATFORMS as string[]).includes(requested)
      ? (requested as Platform)
      : "youtube";

    const report = storage.createReport({
      weekLabel: getWeekLabel(),
      generatedAt: new Date(),
      status: "running",
      totalFound: 0,
      platform,
    });

    res.json({ reportId: report.id, status: "running", platform });

    // Fire-and-forget background pipeline with cancellation support
    const ac = new AbortController();
    runningPipelines.set(report.id, ac);
    runPipeline(report.id, platform, ac.signal)
      .catch((err) => {
        if (err?.message === "__CANCELLED__") {
          console.log(`Pipeline ${report.id} cancelled by user.`);
        } else {
          console.error(err);
        }
      })
      .finally(() => runningPipelines.delete(report.id));
  });

  // ── Cancel a running pipeline ──────────────────────────────────────────────

  app.post("/api/reports/:id/cancel", (req, res) => {
    const id = Number(req.params.id);
    const report = storage.getReport(id);
    if (!report) return res.status(404).json({ error: "Not found" });
    if (report.status !== "running") return res.status(400).json({ error: "Report is not running" });

    const ac = runningPipelines.get(id);
    if (ac) {
      ac.abort();
      runningPipelines.delete(id);
    }

    storage.updateReport(id, {
      status: "error",
      errorMessage: "Cancelled by user.",
      progress: 0,
      phase: "done",
    });

    res.json({ ok: true, status: "cancelled" });
  });

  // ── Creator PATCH ─────────────────────────────────────────────────────────

  app.patch("/api/creators/:id", (req, res) => {
    const schema = z.object({
      contactEmail: z.string().optional().nullable(),
      agencyName: z.string().optional().nullable(),
      managerName: z.string().optional().nullable(),
      managerEmail: z.string().optional().nullable(),
      managerPhone: z.string().optional().nullable(),
      contactNotes: z.string().optional().nullable(),
      description: z.string().optional().nullable(),
      isFlagged: z.boolean().optional(),
      isBookmarked: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error });

    const updated = storage.updateCreator(Number(req.params.id), parsed.data);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Export CSV ────────────────────────────────────────────────────────────

  app.get("/api/reports/:id/export", (req, res) => {
    const creators = storage.getCreatorsByReport(Number(req.params.id));

    const esc = (v: any) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = [
      "Rank","Name","Handle","Platform","Genre","Sub-Genre","Country","Language",
      "Subscribers","Avg Views (30d)","Monthly Views","Engagement Rate (%)",
      "WoW Acceleration (%)","Uploads (30d)","Upload Freq (vid/wk)",
      "Hot Score","Acceleration Score","Engagement Score","Growth Score",
      "Contact Email","Agency","Manager Name","Manager Email","Manager Phone",
      "Profile URL","Notes",
    ];

    const rows = creators.map(c => [
      c.rank, c.name, c.handle, c.platform, c.genre, c.subGenre, c.country, c.language,
      c.subscriberCount, c.avgViews30d, c.views30d,
      c.engagementRate != null ? (c.engagementRate * 100).toFixed(2) : "",
      c.viewVelocity30d != null ? c.viewVelocity30d.toFixed(1) : "",
      c.totalViews, c.uploadFrequency != null ? c.uploadFrequency.toFixed(1) : "",
      c.hotScore, c.velocityScore, c.engagementScore, c.consistencyScore,
      c.contactEmail, c.agencyName, c.managerName, c.managerEmail, c.managerPhone,
      c.profileUrl, c.contactNotes,
    ].map(esc).join(","));

    const csv = [headers.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="hot100-${req.params.id}-${getWeekLabel()}.csv"`);
    res.send(csv);
  });
}
