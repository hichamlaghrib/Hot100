import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useParams, Link } from "wouter";
import {
  Download, ChevronLeft, Bookmark, BookmarkCheck, Flag, FlagOff,
  ExternalLink, Edit2, Check, X, TrendingUp, Users, Eye, Zap, Star,
  Youtube, Music2, Instagram, ChevronDown, ChevronRight, BrainCircuit, Trophy,
  ShieldCheck, ShieldAlert, AlertTriangle, ShieldQuestion, Info
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Legend, ReferenceLine, Area, ComposedChart
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useState, useMemo } from "react";
import type { Creator, Report } from "@shared/schema";

const PLATFORM_META: Record<string, { label: string; Icon: any }> = {
  youtube: { label: "YouTube", Icon: Youtube },
  tiktok: { label: "TikTok", Icon: Music2 },
  instagram: { label: "Instagram", Icon: Instagram },
};

function PlatformBadge({ platform }: { platform?: string | null }) {
  const meta = PLATFORM_META[(platform ?? "youtube")] ?? PLATFORM_META.youtube;
  const Icon = meta.Icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-secondary text-muted-foreground border-border">
      <Icon size={12} />
      {meta.label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 70) return "text-green-400";
  if (score >= 40) return "text-amber-400";
  return "text-red-400";
}

// Pretty model names for display
const MODEL_LABELS: Record<string, string> = {
  naive_drift: "Random-Walk + Drift",
  moving_average: "Moving Average (4w)",
  linear_regression: "Linear Regression",
  loglinear_regression: "Log-Linear Regression",
  holt_linear: "Holt (linear trend)",
  holt_damped: "Holt (damped trend)",
  theta: "Theta Method",
  lightgbm_global: "LightGBM Global (Quantile)",
};
function modelLabel(m: string | null | undefined): string {
  if (!m) return "—";
  return MODEL_LABELS[m] ?? m;
}

// Pretty data-transform names (applied before fitting each model).
const TRANSFORM_LABELS: Record<string, string> = {
  identity: "raw",
  log: "log1p",
  clip: "clip 95%",
  smooth: "smoothed",
};
function transformLabel(t: string | null | undefined): string {
  if (!t) return "raw";
  return TRANSFORM_LABELS[t] ?? t;
}

// Forecast target: raw weekly values vs. the spike-free rolling-median trend.
function modeLabel(m: string | null | undefined): string {
  return m === "trend" ? "trend" : "raw";
}

// ── ML diagnostic helpers ─────────────────────────────────────────────────────
const SENTINEL = 999;

// Format a percentage-type metric (MAPE/sMAPE), guarding the sentinel.
function fmtPct(v: number | null | undefined): string {
  if (v == null || v >= 900) return "n/a";
  return `${v.toFixed(1)}%`;
}
// Format a raw-scale metric (RMSE/MAE) compactly.
function fmtScale(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || v >= 1e15) return "n/a";
  return compactNum(v);
}
// Format R² (can be negative; clamp the absurdly-negative for display).
function fmtR2(v: number | null | undefined): string {
  if (v == null || v <= -900) return "n/a";
  return v.toFixed(2);
}
// Format MASE (skill vs naive).
function fmtMase(v: number | null | undefined): string {
  if (v == null || v >= 900) return "n/a";
  return v.toFixed(2);
}
function fmtRatio(v: number | null | undefined): string {
  if (v == null || v >= 900) return "n/a";
  return `${v.toFixed(2)}×`;
}

// Verdict → colors + icon + human label.
const VERDICT_META: Record<string, { label: string; cls: string; Icon: any }> = {
  robust:     { label: "Robust",     cls: "bg-green-500/15 text-green-400 border-green-500/30",  Icon: ShieldCheck },
  moderate:   { label: "Moderate",   cls: "bg-amber-500/15 text-amber-400 border-amber-500/30",  Icon: ShieldQuestion },
  weak:       { label: "Weak",       cls: "bg-orange-500/15 text-orange-400 border-orange-500/30", Icon: ShieldAlert },
  unreliable: { label: "Unreliable", cls: "bg-red-500/15 text-red-400 border-red-500/30",      Icon: AlertTriangle },
};
function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  const meta = VERDICT_META[verdict ?? ""] ?? VERDICT_META.weak;
  const Icon = meta.Icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${meta.cls}`}>
      <Icon size={10} /> {meta.label}
    </span>
  );
}

// Overfitting badge based on test/train MAPE ratio.
function OverfitBadge({ ratio }: { ratio: number | null | undefined }) {
  if (ratio == null || ratio >= 900) {
    return <span className="text-[10px] text-muted-foreground">n/a</span>;
  }
  let cls = "text-green-400", label = "low";
  if (ratio > 3) { cls = "text-red-400"; label = "high"; }
  else if (ratio > 1.5) { cls = "text-amber-400"; label = "moderate"; }
  return (
    <span className={`tabular-nums ${cls}`} title={`test/train MAPE ratio = ${ratio.toFixed(2)} (${label} overfitting)`}>
      {ratio.toFixed(2)}×
    </span>
  );
}

function compactNum(n: number): string {
  if (n == null || isNaN(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return Math.round(n).toString();
}

// ── Prediction chart (history + forecast) ─────────────────────────────────────
// Builds a single continuous series: actual history followed by the 12-week
// forecast. The boundary week is marked with a reference line.
function PredictionChart({
  metric, history, forecast, color,
}: {
  metric: "views" | "followers";
  history: any[] | null;
  forecast: { views: any; followers: any; dates: string[] } | null;
  color: string;
}) {
  if (!history || !history.length) {
    return (
      <div className="h-44 flex items-center justify-center text-xs text-muted-foreground">
        No history available to forecast.
      </div>
    );
  }

  const data: any[] = [];
  history.forEach(p => {
    data.push({ date: p.date, actual: p[metric] ?? 0, p50: null, band: null });
  });

  const boundaryDate = history[history.length - 1]?.date;
  const lastActual = history[history.length - 1]?.[metric] ?? 0;

  if (data.length) {
    data[data.length - 1].p50 = lastActual;
    data[data.length - 1].band = [lastActual, lastActual];
  }

  if (forecast && forecast.dates) {
    const fcVals = forecast[metric] ?? { p10: [], p50: [], p90: [] };
    forecast.dates.forEach((d, i) => {
      const p10 = fcVals.p10[i] ?? 0;
      const p50 = fcVals.p50[i] ?? 0;
      const p90 = fcVals.p90[i] ?? 0;
      data.push({
        date: d,
        actual: null,
        p50: p50,
        band: [p10, p90]
      });
    });
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
        <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} minTickGap={20} />
        <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickFormatter={compactNum} width={40} />
        <RTooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
          formatter={(v: any, name: string) => {
            if (v == null) return ["—", name];
            if (Array.isArray(v)) return [`${compactNum(v[0])} - ${compactNum(v[1])}`, "P10 - P90"];
            return [compactNum(v), name];
          }}
        />
        {boundaryDate && <ReferenceLine x={boundaryDate} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" opacity={0.5} />}
        <Area type="monotone" dataKey="band" fill={color} fillOpacity={0.15} stroke="none" connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="actual" name="History" stroke={color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="p50" name="Forecast (P50)" stroke={color} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Per-creator forecast panel (expanded row) ─────────────────────────────────
function CreatorForecastPanel({ creator }: { creator: Creator }) {
  const c = creator as any;
  const history = useMemo(() => {
    try { 
      const parsed = c.historyJson ? JSON.parse(c.historyJson) : null; 
      if (!parsed) return null;
      if (Array.isArray(parsed)) return parsed; // new format
      if (parsed.weeks) {
        // convert old format
        return parsed.weeks.map((w: string, i: number) => ({
          date: w,
          views: parsed.views?.[i] ?? 0,
          followers: parsed.followers?.[i] ?? 0
        }));
      }
      return null;
    } catch { return null; }
  }, [c.historyJson]);
  
  const forecast = useMemo(() => {
    try { 
      const parsed = c.forecastJson ? JSON.parse(c.forecastJson) : null; 
      if (!parsed) return null;
      if (parsed.dates) return parsed; // new format
      if (parsed.weeks) {
        // convert old format
        return {
          dates: parsed.weeks,
          views: { p10: parsed.views, p50: parsed.views, p90: parsed.views },
          followers: { p10: parsed.followers, p50: parsed.followers, p90: parsed.followers }
        };
      }
      return null;
    } catch { return null; }
  }, [c.forecastJson]);

  const modelScores = useMemo(() => {
    try { return c.modelScoresJson ? JSON.parse(c.modelScoresJson) : null; } catch { return null; }
  }, [c.modelScoresJson]);

  const hasForecast = history && forecast && history.length;

  return (
    <div className="px-6 py-5 bg-secondary/20 border-b border-border">
      {!hasForecast ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          No ML forecast was generated for this creator (insufficient time-series history).
        </div>
      ) : (
        <div className="space-y-5">
          {/* Two prediction charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Eye size={13} className="text-primary" /> Views forecast (12 weeks)
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Model: <span className="text-foreground font-medium">LightGBM Global (P10-P90)</span>
                </span>
              </div>
              <PredictionChart metric="views" history={history} forecast={forecast} color="hsl(var(--primary))" />
              {c.predViewsGrowth != null && (
                <div className="text-[11px] text-muted-foreground mt-1">
                  Predicted 12-week views growth:{" "}
                  <span className={c.predViewsGrowth >= 0 ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                    {c.predViewsGrowth >= 0 ? "+" : ""}{(c.predViewsGrowth * 100).toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Users size={13} className="text-accent" /> Followers forecast (12 weeks)
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Model: <span className="text-foreground font-medium">LightGBM Global (P10-P90)</span>
                </span>
              </div>
              <PredictionChart metric="followers" history={history} forecast={forecast} color="hsl(var(--accent))" />
              {c.predFollowersGrowth != null && (
                <div className="text-[11px] text-muted-foreground mt-1">
                  Predicted 12-week follower growth:{" "}
                  <span className={c.predFollowersGrowth >= 0 ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                    {c.predFollowersGrowth >= 0 ? "+" : ""}{(c.predFollowersGrowth * 100).toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Per-creator detailed model evaluation & overfitting diagnostics */}
          {modelScores && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-1">
                <BrainCircuit size={13} className="text-primary" /> Model evaluation & overfitting diagnostics
              </div>
              <p className="text-[10.5px] text-muted-foreground mb-3 leading-relaxed max-w-3xl">
                Each candidate is back-tested on a hold-out split and via rolling-origin cross-validation.
                The winner (★) is chosen by lowest <span className="text-foreground">CV&nbsp;MAPE</span> (most reliable),
                not a single split. Watch the <span className="text-foreground">Overfit</span> column
                (test/train ratio &gt; 3× = high), the <span className="text-foreground">CV&nbsp;±σ</span> stability,
                and the <span className="text-foreground">verdict</span> badge to judge whether a prediction is trustworthy.
              </p>
              <div className="space-y-5">
                {(["views", "followers"] as const).map(metric => {
                  const rows = (modelScores[metric] ?? []).slice()
                    .sort((a: any, b: any) => (a.cvMape - b.cvMape) || (a.mape - b.mape));
                  const diag = modelScores[metric === "views" ? "viewsDiag" : "followersDiag"];
                  if (!rows.length) return null;
                  return (
                    <div key={metric}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="text-[11px] uppercase tracking-wide font-semibold text-foreground flex items-center gap-1.5">
                          {metric === "views" ? <Eye size={12} className="text-primary" /> : <Users size={12} className="text-accent" />}
                          {metric}
                        </div>
                        {diag && (
                          <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <Info size={10} />
                            {diag.points} weekly pts · {diag.nonZeroWeeks} active · hold-out {diag.testSize}w · mean {compactNum(diag.mean)}
                            {diag.trendMode && (
                              <span className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30" title={`Forecasts the spike-free trend (rolling-median window ${diag.trendWindow}) instead of un-forecastable viral spikes — like Tubular/Social Blade trend lines`}>
                                <TrendingUp size={9} /> trend forecast
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="overflow-x-auto rounded-md border border-border">
                        <table className="w-full text-[10.5px] border-collapse">
                          <thead>
                            <tr className="bg-secondary/50 text-muted-foreground">
                              <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Model</th>
                              <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap" title="Data transform applied before fitting (chosen automatically per model)">Transform</th>
                              <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap" title="Forecast target: 'raw' = raw weekly values; 'trend' = the spike-free rolling-median trend (more reliable for viral data)">Target</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Cross-validation MAPE (mean across rolling folds) — selection metric">CV MAPE</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Std-dev of fold errors — lower = more stable">±σ (folds)</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Hold-out MAPE">Test MAPE</th>
                              <th className="text-right font-medium px-2 py-1.5" title="In-sample (train) MAPE">Train MAPE</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Test/Train ratio — >3× indicates overfitting">Overfit</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Symmetric MAPE (bounded, robust to small values)">sMAPE</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Root mean squared error">RMSE</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Mean absolute error">MAE</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Coefficient of determination on hold-out (can be <0)">R²</th>
                              <th className="text-right font-medium px-2 py-1.5" title="Mean absolute scaled error vs naive (<1 beats naive)">MASE</th>
                              <th className="text-center font-medium px-2 py-1.5">Verdict</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((s: any, idx: number) => {
                              const isBest = idx === 0;
                              return (
                                <tr key={s.model} className={`border-t border-border ${isBest ? "bg-primary/10" : "hover:bg-secondary/30"}`}>
                                  <td className={`px-2 py-1.5 whitespace-nowrap ${isBest ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
                                    {isBest && <Trophy size={10} className="inline mr-1 text-amber-400" />}
                                    {modelLabel(s.model)}
                                  </td>
                                  <td className="px-2 py-1.5 whitespace-nowrap">
                                    <span className="inline-block px-1.5 py-0.5 rounded bg-secondary/70 text-muted-foreground text-[10px] border border-border">
                                      {transformLabel(s.transform)}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5 whitespace-nowrap">
                                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${s.mode === "trend" ? "bg-primary/15 text-primary border-primary/30" : "bg-secondary/70 text-muted-foreground border-border"}`}>
                                      {modeLabel(s.mode)}
                                    </span>
                                  </td>
                                  <td className={`text-right px-2 py-1.5 tabular-nums ${isBest ? "text-green-400 font-semibold" : "text-foreground"}`}>{fmtPct(s.cvMape)}</td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtPct(s.cvStd)}<span className="text-muted-foreground/60"> ({s.cvFolds ?? 0})</span></td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtPct(s.testMape)}</td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtPct(s.trainMape)}</td>
                                  <td className="text-right px-2 py-1.5"><OverfitBadge ratio={s.overfitRatio} /></td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtPct(s.smape)}</td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtScale(s.rmse)}</td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtScale(s.mae)}</td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtR2(s.r2)}</td>
                                  <td className="text-right px-2 py-1.5 tabular-nums text-muted-foreground">{fmtMase(s.mase)}</td>
                                  <td className="text-center px-2 py-1.5"><VerdictBadge verdict={s.verdict} /></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Report-level model leaderboard ────────────────────────────────────────────
function ModelLeaderboard({ report }: { report: Report | undefined }) {
  const lb = useMemo(() => {
    try {
      const raw = (report as any)?.modelLeaderboard;
      return raw ? JSON.parse(raw) as Array<{ model: string; wins: number; avgMape: number | null; avgOverfit?: number | null; robustCount?: number }> : null;
    } catch { return null; }
  }, [report]);

  if (!lb || !lb.length) return null;
  const maxWins = Math.max(1, ...lb.map(m => m.wins));

  return (
    <div className="px-5 py-4 border-b border-border bg-card/20">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground mb-3">
        <BrainCircuit size={15} className="text-primary" /> ML Model Comparison
        <span className="text-xs font-normal text-muted-foreground ml-1">
          — wins (best per creator/metric), avg CV MAPE, avg overfit ratio (OF), and robust-verdict count across all creators
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-2 max-w-4xl">
        {lb.map((m, i) => (
          <div key={m.model} className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-4 text-right">{i + 1}.</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-medium text-foreground truncate flex items-center gap-1">
                  {i === 0 && <Trophy size={11} className="text-amber-400" />}
                  {modelLabel(m.model)}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums ml-2">
                  {m.wins} wins{m.avgMape != null ? ` · ${m.avgMape}% CV` : ""}{m.avgOverfit != null ? ` · ${m.avgOverfit}× OF` : ""}{m.robustCount ? ` · ${m.robustCount} robust` : ""}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(m.wins / maxWins) * 100}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeatBar({ value, max = 100 }: { value: number | null | undefined; max?: number }) {
  const pct = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  return (
    <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${pct}%`,
          background: pct >= 70
            ? "hsl(142 70% 45%)"
            : pct >= 40
            ? "hsl(38 92% 55%)"
            : "hsl(4 90% 58%)",
        }}
      />
    </div>
  );
}

// ── Contact Editor ─────────────────────────────────────────────────────────────

function ContactEditor({ creator, onSaved }: { creator: Creator; onSaved: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    contactEmail: creator.contactEmail || "",
    agencyName: creator.agencyName || "",
    managerName: creator.managerName || "",
    managerEmail: creator.managerEmail || "",
    managerPhone: creator.managerPhone || "",
    contactNotes: creator.contactNotes || "",
    description: creator.description || "",
  });

  const mutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const res = await apiRequest("PATCH", `/api/creators/${creator.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      onSaved();
      toast({ title: "Saved" });
    },
  });

  return (
    <div className="space-y-4 py-2">
      <div>
        <label className="text-xs text-muted-foreground block mb-1.5">Bio / Description</label>
        <Textarea
          data-testid="input-description"
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="2-3 sentence description of what they create..."
          rows={3}
          className="text-sm"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1.5">Contact Email</label>
          <Input data-testid="input-contact-email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} placeholder="creator@email.com" className="text-sm h-8" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1.5">Agency</label>
          <Input data-testid="input-agency" value={form.agencyName} onChange={e => setForm(f => ({ ...f, agencyName: e.target.value }))} placeholder="Agency name" className="text-sm h-8" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1.5">Manager Name</label>
          <Input data-testid="input-manager-name" value={form.managerName} onChange={e => setForm(f => ({ ...f, managerName: e.target.value }))} placeholder="Full name" className="text-sm h-8" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1.5">Manager Email</label>
          <Input data-testid="input-manager-email" value={form.managerEmail} onChange={e => setForm(f => ({ ...f, managerEmail: e.target.value }))} placeholder="manager@agency.com" className="text-sm h-8" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1.5">Manager Phone</label>
          <Input data-testid="input-manager-phone" value={form.managerPhone} onChange={e => setForm(f => ({ ...f, managerPhone: e.target.value }))} placeholder="+1 555 000 0000" className="text-sm h-8" />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1.5">Notes</label>
        <Textarea data-testid="input-notes" value={form.contactNotes} onChange={e => setForm(f => ({ ...f, contactNotes: e.target.value }))} placeholder="Internal notes..." rows={2} className="text-sm" />
      </div>
      <Button data-testid="button-save-contact" size="sm" onClick={() => mutation.mutate(form)} disabled={mutation.isPending}>
        {mutation.isPending ? "Saving..." : "Save Changes"}
      </Button>
    </div>
  );
}

// ── Creator Row ─────────────────────────────────────────────────────────────────

function CreatorRow({ creator, reportId }: { creator: Creator; reportId: number }) {
  const { toast } = useToast();
  const [contactOpen, setContactOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const c = creator as any;
  const hasForecast = !!c.historyJson || !!c.forecastJson;

  const patchMutation = useMutation({
    mutationFn: async (data: Partial<Creator>) => {
      const res = await apiRequest("PATCH", `/api/creators/${creator.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId, "creators"] });
    },
  });

  const toggle = (field: "isBookmarked" | "isFlagged") => {
    patchMutation.mutate({ [field]: !creator[field] });
  };

  const hasContact = creator.contactEmail || creator.agencyName || creator.managerName;

  return (
   <>
    <div
      data-testid={`row-creator-${creator.id}`}
      onClick={() => hasForecast && setExpanded(e => !e)}
      className={`grid grid-cols-[28px_48px_auto_1fr_120px_100px_100px_100px_100px] gap-3 items-center px-4 py-3 border-b border-border/50 hover:bg-secondary/20 transition-colors text-sm ${hasForecast ? "cursor-pointer" : ""}`}
    >
      {/* Expand chevron */}
      <div className="flex items-center justify-center text-muted-foreground">
        {hasForecast
          ? (expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />)
          : null}
      </div>

      {/* Rank */}
      <div className="text-center">
        <span className={`text-sm font-bold ${creator.rank === 1 ? "text-primary" : creator.rank && creator.rank <= 10 ? "text-accent" : "text-muted-foreground"}`}>
          #{creator.rank}
        </span>
      </div>

      {/* Avatar + name */}
      <div className="flex items-center gap-3 min-w-0">
        {creator.avatarUrl ? (
          <img src={creator.avatarUrl} alt={creator.name} className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 text-xs font-bold text-muted-foreground">
            {creator.name.charAt(0)}
          </div>
        )}
        <div className="min-w-0">
          <div className="font-medium truncate text-foreground">{creator.name}</div>
          <div className="text-xs text-muted-foreground truncate">{creator.handle}</div>
        </div>
      </div>

      {/* Genre + contact */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {creator.genre && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 border-border text-muted-foreground">
              {creator.genre}
            </Badge>
          )}
          {creator.description && (
            <span className="text-xs text-muted-foreground line-clamp-1 max-w-xs">{creator.description}</span>
          )}
        </div>
        {hasContact && (
          <div className="text-xs text-muted-foreground/70">
            {creator.agencyName || creator.managerName || creator.contactEmail}
          </div>
        )}
      </div>

      {/* Subscribers */}
      <div className="text-right">
        <div className="font-medium">{fmt(creator.subscriberCount)}</div>
        <div className="text-xs text-muted-foreground">subs</div>
      </div>

      {/* Views 30d */}
      <div className="text-right">
        <div className="font-medium">{fmt(creator.views30d)}</div>
        <div className="text-xs text-muted-foreground">30d views</div>
      </div>

      {/* Engagement */}
      <div className="text-right">
        <div className="font-medium">{creator.engagementRate != null ? `${(creator.engagementRate * 100).toFixed(1)}%` : "—"}</div>
        <div className="text-xs text-muted-foreground">eng. rate</div>
      </div>

      {/* Velocity */}
      <div className="text-right">
        <div className={`font-medium ${creator.viewVelocity30d && creator.viewVelocity30d > 0 ? "text-green-400" : "text-muted-foreground"}`}>
          {creator.viewVelocity30d != null ? `+${creator.viewVelocity30d.toFixed(0)}%` : "—"}
        </div>
        <div className="text-xs text-muted-foreground">30d vel.</div>
      </div>

      {/* Hot Score + actions */}
      <div className="flex items-center justify-end gap-2">
        <div className="text-right">
          <div className={`font-bold text-sm ${scoreColor(creator.hotScore)}`}>
            {creator.hotScore != null ? creator.hotScore.toFixed(0) : "—"}
          </div>
          <HeatBar value={creator.hotScore} />
        </div>

        {/* Actions */}
        <div className="flex gap-1 ml-1" onClick={e => e.stopPropagation()}>
          <Dialog open={contactOpen} onOpenChange={setContactOpen}>
            <DialogTrigger asChild>
              <button
                data-testid={`button-edit-${creator.id}`}
                className={`p-1 rounded hover:bg-secondary transition-colors ${hasContact ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
                title="Edit contact"
              >
                <Edit2 size={13} />
              </button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {creator.name} — Contact Info
                </DialogTitle>
              </DialogHeader>
              <ContactEditor creator={creator} onSaved={() => {
                setContactOpen(false);
                queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId, "creators"] });
              }} />
            </DialogContent>
          </Dialog>

          <button
            data-testid={`button-bookmark-${creator.id}`}
            onClick={() => toggle("isBookmarked")}
            className={`p-1 rounded hover:bg-secondary transition-colors ${creator.isBookmarked ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
            title={creator.isBookmarked ? "Remove bookmark" : "Bookmark"}
          >
            {creator.isBookmarked ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
          </button>

          {creator.profileUrl && (
            <a
              href={creator.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`link-profile-${creator.id}`}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              title="Open channel"
            >
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
    {expanded && hasForecast && <CreatorForecastPanel creator={creator} />}
   </>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function ReportDetail() {
  const { id } = useParams<{ id: string }>();
  const reportId = Number(id);
  const [genre, setGenre] = useState("all");
  const [sort, setSort] = useState("rank");
  const [tab, setTab] = useState("all");

  const { data: report } = useQuery<Report>({
    queryKey: ["/api/reports", reportId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/reports/${reportId}`);
      return res.json() as Promise<Report>;
    },
  });

  const { data: creators, isLoading } = useQuery<Creator[]>({
    queryKey: ["/api/reports", reportId, "creators", { genre, sort, tab }],
    queryFn: async () => {
      const params = new URLSearchParams({ sort });
      if (genre !== "all") params.set("genre", genre);
      if (tab === "bookmarked") params.set("bookmarked", "true");
      if (tab === "flagged") params.set("flagged", "true");
      const res = await apiRequest("GET", `/api/reports/${reportId}/creators?${params}`);
      return res.json() as Promise<Creator[]>;
    },
    enabled: !!reportId,
  });

  // Get unique genres
  const genres = useMemo(() => {
    if (!creators) return [];
    const g = new Set(creators.map(c => c.genre).filter(Boolean));
    return Array.from(g).sort() as string[];
  }, [creators]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-background z-10">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground h-7">
              <ChevronLeft size={14} /> Reports
            </Button>
          </Link>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{report?.weekLabel || `Report #${id}`}</span>
            <PlatformBadge platform={(report as any)?.platform} />
            {report?.totalFound && (
              <span className="text-xs text-muted-foreground">{report.totalFound} creators</span>
            )}
          </div>
        </div>
        <a
          href={`/api/reports/${id}/export`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="button-export-csv"
        >
          <Button variant="outline" size="sm" className="gap-2 h-7">
            <Download size={13} /> Export CSV
          </Button>
        </a>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-card/30">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-7">
            <TabsTrigger value="all" className="text-xs h-6 px-3">All</TabsTrigger>
            <TabsTrigger value="bookmarked" className="text-xs h-6 px-3">
              <Bookmark size={11} className="mr-1" />Saved
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Select value={genre} onValueChange={setGenre}>
          <SelectTrigger data-testid="select-genre" className="w-40 h-7 text-xs">
            <SelectValue placeholder="All genres" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All genres</SelectItem>
            {genres.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger data-testid="select-sort" className="w-36 h-7 text-xs">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rank">Hot Score</SelectItem>
            <SelectItem value="velocity">View Velocity</SelectItem>
            <SelectItem value="followers">Subscribers</SelectItem>
            <SelectItem value="engagement">Engagement</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ML model comparison */}
      <ModelLeaderboard report={report} />

      {/* Table header */}
      <div className="grid grid-cols-[28px_48px_auto_1fr_120px_100px_100px_100px_100px] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border bg-card/20 sticky top-[57px] z-10">
        <div></div>
        <div className="text-center">#</div>
        <div>Creator</div>
        <div>Genre / Bio</div>
        <div className="text-right">Subs</div>
        <div className="text-right">Views 30d</div>
        <div className="text-right">Eng. Rate</div>
        <div className="text-right">Velocity</div>
        <div className="text-right pr-8">Score</div>
      </div>

      {/* Creator rows */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-0">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="px-4 py-3 border-b border-border/50">
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        ) : !creators?.length ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Star size={28} className="text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No creators found for this filter</p>
          </div>
        ) : (
          creators.map(c => (
            <CreatorRow key={c.id} creator={c} reportId={reportId} />
          ))
        )}
      </div>
    </div>
  );
}
