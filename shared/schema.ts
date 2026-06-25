import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Weekly Report ───────────────────────────────────────────────────────────
export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weekLabel: text("week_label").notNull(), // e.g. "2026-W23"
  platform: text("platform").notNull().default("youtube"), // youtube | tiktok | instagram
  generatedAt: integer("generated_at", { mode: "timestamp" }).notNull(),
  status: text("status").notNull().default("pending"), // pending | running | complete | error
  errorMessage: text("error_message"),
  totalFound: integer("total_found").default(0),

  // Progress tracking (0–100) + current phase label for the progress bar
  progress: integer("progress").default(0),
  phase: text("phase"), // search | trends | enrich | ml | scoring | done

  // ML model leaderboard (JSON): per-model avg backtest error + win counts
  modelLeaderboard: text("model_leaderboard"),
});

export const insertReportSchema = createInsertSchema(reports).omit({ id: true });
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reports.$inferSelect;

// ─── Creator ─────────────────────────────────────────────────────────────────
export const creators = sqliteTable("creators", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportId: integer("report_id").notNull(),

  // Identity
  channelId: text("channel_id").notNull(),   // Tubular / platform native ID
  modashId: text("modash_id"),               // Modash profile ID
  name: text("name").notNull(),
  handle: text("handle"),
  platform: text("platform").notNull().default("youtube"), // youtube | tiktok | instagram
  profileUrl: text("profile_url"),
  avatarUrl: text("avatar_url"),
  description: text("description"),          // 2-3 sentence AI-generated bio

  // Classification
  genre: text("genre"),                      // e.g. Gaming, Fitness, Finance, Beauty
  subGenre: text("sub_genre"),
  country: text("country"),
  language: text("language"),

  // Core metrics
  followers: integer("followers"),
  subscriberCount: integer("subscriber_count"),
  totalViews: integer("total_views"),
  avgViews30d: integer("avg_views_30d"),
  views30d: integer("views_30d"),
  views7d: integer("views_7d"),
  engagementRate: real("engagement_rate"),   // 0.0–1.0
  viewVelocity30d: real("view_velocity_30d"), // % growth in views over last 30d
  uploadFrequency: real("upload_frequency"), // videos/week

  // Audience
  audienceAge: text("audience_age"),         // JSON: { "18-24": 0.4, "25-34": 0.3, ... }
  audienceGender: text("audience_gender"),   // JSON: { "male": 0.6, "female": 0.4 }
  audienceTopCountries: text("audience_top_countries"), // JSON array

  // Scoring
  hotScore: real("hot_score"),               // 0–100 composite score
  velocityScore: real("velocity_score"),
  engagementScore: real("engagement_score"),
  consistencyScore: real("consistency_score"),
  predictionScore: real("prediction_score"), // 0–100 ML-predicted growth signal
  rank: integer("rank"),

  // ML time-series forecasts (JSON)
  //   history: { weeks: string[], views: number[], followers: number[] }
  //   forecast: { weeks: string[], views: number[], followers: number[] }
  historyJson: text("history_json"),
  forecastJson: text("forecast_json"),
  bestModelViews: text("best_model_views"),       // winning model name for views
  bestModelFollowers: text("best_model_followers"),// winning model name for followers
  modelScoresJson: text("model_scores_json"),      // per-creator backtest errors per model
  predViewsGrowth: real("pred_views_growth"),      // predicted 12w views growth ratio
  predFollowersGrowth: real("pred_followers_growth"),// predicted 12w followers growth ratio

  // Contact / Agency
  contactEmail: text("contact_email"),
  agencyName: text("agency_name"),
  managerName: text("manager_name"),
  managerEmail: text("manager_email"),
  managerPhone: text("manager_phone"),
  contactNotes: text("contact_notes"),       // free-form manual notes

  // Metadata
  isFlagged: integer("is_flagged", { mode: "boolean" }).default(false),
  isBookmarked: integer("is_bookmarked", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }),
});

export const insertCreatorSchema = createInsertSchema(creators).omit({ id: true });
export type InsertCreator = z.infer<typeof insertCreatorSchema>;
export type Creator = typeof creators.$inferSelect;

// ─── App Config ──────────────────────────────────────────────────────────────
export const config = sqliteTable("config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export const insertConfigSchema = createInsertSchema(config).omit({ id: true });
export type InsertConfig = z.infer<typeof insertConfigSchema>;
export type Config = typeof config.$inferSelect;
