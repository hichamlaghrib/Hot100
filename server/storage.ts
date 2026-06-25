import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, and } from "drizzle-orm";
import { reports, creators, config } from "@shared/schema";
import type { Report, InsertReport, Creator, InsertCreator, Config, InsertConfig } from "@shared/schema";

const sqlite = new Database("data.db");
export const db = drizzle(sqlite);

// ── Migrations (create tables if not exists) ──────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'youtube',
    generated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    total_found INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    modash_id TEXT,
    name TEXT NOT NULL,
    handle TEXT,
    platform TEXT NOT NULL DEFAULT 'youtube',
    profile_url TEXT,
    avatar_url TEXT,
    description TEXT,
    genre TEXT,
    sub_genre TEXT,
    country TEXT,
    language TEXT,
    followers INTEGER,
    subscriber_count INTEGER,
    total_views INTEGER,
    avg_views_30d INTEGER,
    views_30d INTEGER,
    views_7d INTEGER,
    engagement_rate REAL,
    view_velocity_30d REAL,
    upload_frequency REAL,
    audience_age TEXT,
    audience_gender TEXT,
    audience_top_countries TEXT,
    hot_score REAL,
    velocity_score REAL,
    engagement_score REAL,
    consistency_score REAL,
    rank INTEGER,
    contact_email TEXT,
    agency_name TEXT,
    manager_name TEXT,
    manager_email TEXT,
    manager_phone TEXT,
    contact_notes TEXT,
    is_flagged INTEGER DEFAULT 0,
    is_bookmarked INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL
  );
`);

// ── Idempotent column migrations (for DBs created before multi-platform) ──────
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("reports", "platform", "platform TEXT NOT NULL DEFAULT 'youtube'");
// Progress + ML leaderboard columns
ensureColumn("reports", "progress", "progress INTEGER DEFAULT 0");
ensureColumn("reports", "phase", "phase TEXT");
ensureColumn("reports", "model_leaderboard", "model_leaderboard TEXT");
// ML prediction columns on creators
ensureColumn("creators", "prediction_score", "prediction_score REAL");
ensureColumn("creators", "history_json", "history_json TEXT");
ensureColumn("creators", "forecast_json", "forecast_json TEXT");
ensureColumn("creators", "best_model_views", "best_model_views TEXT");
ensureColumn("creators", "best_model_followers", "best_model_followers TEXT");
ensureColumn("creators", "model_scores_json", "model_scores_json TEXT");
ensureColumn("creators", "pred_views_growth", "pred_views_growth REAL");
ensureColumn("creators", "pred_followers_growth", "pred_followers_growth REAL");

export interface IStorage {
  // Reports
  getReports(): Report[];
  getReport(id: number): Report | undefined;
  getLatestReport(): Report | undefined;
  createReport(data: InsertReport): Report;
  updateReport(id: number, data: Partial<InsertReport>): Report | undefined;

  // Creators
  getCreatorsByReport(reportId: number): Creator[];
  getCreator(id: number): Creator | undefined;
  createCreator(data: InsertCreator): Creator;
  updateCreator(id: number, data: Partial<InsertCreator>): Creator | undefined;
  upsertCreators(creators: InsertCreator[]): void;

  // Config
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
  getAllConfig(): Config[];
}

export const storage: IStorage = {
  // ── Reports ──────────────────────────────────────────────────────────────
  getReports() {
    return db.select().from(reports).orderBy(desc(reports.id)).all();
  },
  getReport(id) {
    return db.select().from(reports).where(eq(reports.id, id)).get();
  },
  getLatestReport() {
    return db.select().from(reports).orderBy(desc(reports.id)).limit(1).get();
  },
  createReport(data) {
    return db.insert(reports).values(data).returning().get();
  },
  updateReport(id, data) {
    return db.update(reports).set(data).where(eq(reports.id, id)).returning().get();
  },

  // ── Creators ─────────────────────────────────────────────────────────────
  getCreatorsByReport(reportId) {
    return db.select().from(creators).where(eq(creators.reportId, reportId)).all();
  },
  getCreator(id) {
    return db.select().from(creators).where(eq(creators.id, id)).get();
  },
  createCreator(data) {
    return db.insert(creators).values(data).returning().get();
  },
  updateCreator(id, data) {
    return db.update(creators).set(data).where(eq(creators.id, id)).returning().get();
  },
  upsertCreators(items) {
    for (const item of items) {
      db.insert(creators).values(item).run();
    }
  },

  // ── Config ────────────────────────────────────────────────────────────────
  getConfig(key) {
    const row = db.select().from(config).where(eq(config.key, key)).get();
    return row?.value;
  },
  setConfig(key, value) {
    db.insert(config)
      .values({ key, value })
      .onConflictDoUpdate({ target: config.key, set: { value } })
      .run();
  },
  getAllConfig() {
    return db.select().from(config).all();
  },
};
