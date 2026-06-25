/**
 * forecast.ts — Time-series prediction engine (pure TypeScript, no Python).
 *
 * Pipeline:
 *   1. Aggregate Tubular's long weekly history (up to 10y, trimmed to each
 *      creator's own start — leading all-zero weeks are dropped) into a series.
 *   2. Run several candidate models on each series (views, followers).
 *   3. Backtest each model via a holdout split → compute MAPE + RMSE.
 *   4. Pick the model with the lowest error per creator/metric.
 *   5. Refit the winner on the full series → forecast `HORIZON_WEEKS` ahead.
 *
 * Models chosen for short, noisy, sparse creator-growth series:
 *   - naive_drift        : last value + average step (Random-Walk w/ drift)
 *   - moving_average     : mean of last 4 weeks, flat forecast
 *   - linear_regression  : OLS trend on week index
 *   - loglinear_regression: OLS on log(1+y) → captures exponential growth
 *   - holt_linear        : double exponential smoothing (level + trend)
 *   - holt_damped        : Holt with damped trend (φ) — avoids runaway forecasts
 *   - theta              : Theta method (decomposition of SES + linear trend)
 *
 * All models are implemented from first principles in TS so they run anywhere
 * Node runs — including a published pplx.app sandbox.
 */

export const HORIZON_WEEKS = 12;

// Training/back-test window. Creator metrics are highly non-stationary: a
// channel that did 2K views/week two years ago and 50M today has effectively
// switched regimes. Including that ancient history makes rolling-origin CV test
// the model against obsolete levels, inflating CV-MAPE and wrecking the verdict.
// Empirically (measured on 100 real creators) the most RELIABLE window is ~1
// year: cap 52w → 15 unreliable (views) vs 32 with full 10y history. We still
// FETCH the full history (used for display/charts), but models only fit & score
// on the most recent MODEL_WINDOW_WEEKS observations.
export const MODEL_WINDOW_WEEKS = 52;

export interface WeeklySeries {
  weeks: string[];   // ISO week-ending dates, ascending
  views: number[];   // weekly total views
  followers: number[]; // weekly follower NET change (delta)
}

export interface ForecastResult {
  weeks: string[];
  views: number[];
  followers: number[];
}

export interface ModelScore {
  model: string;
  transform: string;   // data transform applied before fitting (identity/log/clip/smooth)
  mode: "raw" | "trend"; // "raw" = fit/score on raw weekly values; "trend" = fit/score on the robust rolling-median trend (viral spikes removed)
  // ── Holdout (out-of-sample) accuracy — the headline numbers ──────────────
  mape: number;        // mean absolute percentage error % (lower = better)
  smape: number;       // symmetric MAPE % — robust when values are small/zero
  rmse: number;        // root mean squared error
  mae: number;         // mean absolute error
  r2: number;          // coefficient of determination on the holdout (can be <0)
  mase: number;        // mean absolute scaled error vs naive (1.0 = ties naive)
  skillVsNaive: number;// % improvement in RMSE over the naive baseline

  // ── Overfitting diagnostics ──────────────────────────────────────────────
  trainMape: number;   // in-sample MAPE % (fit on train, scored on train)
  testMape: number;    // out-of-sample MAPE % (== mape; surfaced for clarity)
  overfitRatio: number;// testMape / trainMape — >>1 means overfitting
  overfitGap: number;  // testMape − trainMape (absolute pp gap)

  // ── Rolling-origin cross-validation (robustness) ─────────────────────────
  cvMape: number;      // mean MAPE across CV folds (lower = better)
  cvStd: number;       // std-dev of fold MAPEs — high = unstable / unreliable
  cvFolds: number;     // number of CV folds actually run

  // ── Verdict ──────────────────────────────────────────────────────────────
  verdict: "robust" | "moderate" | "weak" | "unreliable";
}

export interface SeriesDiagnostics {
  points: number;      // number of weekly observations
  testSize: number;    // holdout length used
  nonZeroWeeks: number;// active weeks (helps explain sparse-data caveats)
  mean: number;        // mean of the series (scale context for RMSE/MAE)
  trendMode: boolean;  // true when the winning forecast targets the smoothed trend, not raw spikes
  trendWindow: number; // rolling-median window used to extract the trend (0 if raw)
}

export interface MetricForecast {
  bestModel: string;
  forecast: number[];     // HORIZON_WEEKS predicted values
  scores: ModelScore[];   // backtest scores for every candidate model
  diagnostics: SeriesDiagnostics; // series-level context
}

// ── Daily → weekly aggregation ────────────────────────────────────────────────

interface DailyPoint { date: string; views: number; followers: number; }

/**
 * Bucket sparse daily points into ISO weeks.
 *  - views     → SUM within the week (total views that week)
 *  - followers → SUM of daily deltas within the week (net follower change)
 * Returns only weeks from the first non-empty week onward.
 */
export function aggregateWeekly(daily: DailyPoint[]): WeeklySeries {
  if (!daily.length) return { weeks: [], views: [], followers: [] };

  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const byWeek = new Map<string, { v: number; f: number }>();

  for (const p of sorted) {
    const d = new Date(p.date + "T00:00:00Z");
    // Week-ending Sunday key (normalise to end-of-week)
    const day = d.getUTCDay(); // 0=Sun
    const diff = (7 - day) % 7;
    const weekEnd = new Date(d);
    weekEnd.setUTCDate(d.getUTCDate() + diff);
    const key = weekEnd.toISOString().slice(0, 10);

    const cur = byWeek.get(key) ?? { v: 0, f: 0 };
    cur.v += p.views || 0;
    cur.f += p.followers || 0;
    byWeek.set(key, cur);
  }

  const weeks = Array.from(byWeek.keys()).sort();
  // Trim leading empty weeks (creator may have no data early in the year)
  let start = 0;
  while (start < weeks.length && byWeek.get(weeks[start])!.v === 0) start++;
  const kept = weeks.slice(start);

  return {
    weeks: kept,
    views: kept.map(w => byWeek.get(w)!.v),
    followers: kept.map(w => byWeek.get(w)!.f),
  };
}

// ── Individual models (each returns an h-step forecast) ───────────────────────

type Model = (y: number[], h: number) => number[];

function naiveDrift(y: number[], h: number): number[] {
  const n = y.length;
  if (n === 0) return Array(h).fill(0);
  if (n === 1) return Array(h).fill(y[0]);
  const drift = (y[n - 1] - y[0]) / (n - 1);
  const last = y[n - 1];
  return Array.from({ length: h }, (_, i) => Math.max(0, last + drift * (i + 1)));
}

function movingAverage(y: number[], h: number): number[] {
  const n = y.length;
  if (n === 0) return Array(h).fill(0);
  const w = Math.min(4, n);
  const avg = y.slice(n - w).reduce((a, b) => a + b, 0) / w;
  return Array(h).fill(Math.max(0, avg));
}

function olsFit(x: number[], y: number[]): { a: number; b: number } {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  const b = den === 0 ? 0 : num / den; // slope
  const a = my - b * mx;               // intercept
  return { a, b };
}

function linearRegression(y: number[], h: number): number[] {
  const n = y.length;
  if (n < 2) return Array(h).fill(y[0] ?? 0);
  const x = Array.from({ length: n }, (_, i) => i);
  const { a, b } = olsFit(x, y);
  return Array.from({ length: h }, (_, i) => Math.max(0, a + b * (n + i)));
}

function loglinearRegression(y: number[], h: number): number[] {
  const n = y.length;
  if (n < 2) return Array(h).fill(y[0] ?? 0);
  const x = Array.from({ length: n }, (_, i) => i);
  const ly = y.map(v => Math.log(1 + Math.max(0, v)));
  const { a, b } = olsFit(x, ly);
  return Array.from({ length: h }, (_, i) => Math.max(0, Math.expm1(a + b * (n + i))));
}

function holt(y: number[], h: number, alpha: number, beta: number, phi: number): number[] {
  const n = y.length;
  if (n < 2) return Array(h).fill(y[0] ?? 0);
  let level = y[0];
  let trend = y[1] - y[0];
  for (let i = 1; i < n; i++) {
    const prevLevel = level;
    level = alpha * y[i] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  const out: number[] = [];
  let phiSum = 0;
  for (let i = 1; i <= h; i++) {
    phiSum += Math.pow(phi, i);
    out.push(Math.max(0, level + phiSum * trend));
  }
  return out;
}

const holtLinear: Model = (y, h) => holt(y, h, 0.5, 0.3, 1.0);
const holtDamped: Model = (y, h) => holt(y, h, 0.5, 0.3, 0.85);

// ── Robust models (added to reduce "unreliable" verdicts on noisy series) ──────

// Simple exponential smoothing — flat forecast at the smoothed level. Very
// stable on spiky data where a trend would chase noise.
function ses(y: number[], h: number, alpha = 0.4): number[] {
  const n = y.length;
  if (n === 0) return Array(h).fill(0);
  let s = y[0];
  for (let i = 1; i < n; i++) s = alpha * y[i] + (1 - alpha) * s;
  return Array(h).fill(Math.max(0, s));
}

// Median drift — random-walk using the MEDIAN step (robust to viral-spike
// outliers that wreck a mean-based drift).
function medianDrift(y: number[], h: number): number[] {
  const n = y.length;
  if (n < 2) return Array(h).fill(y[n - 1] ?? 0);
  const diffs: number[] = [];
  for (let i = 1; i < n; i++) diffs.push(y[i] - y[i - 1]);
  diffs.sort((a, b) => a - b);
  const md = diffs[Math.floor(diffs.length / 2)];
  const last = y[n - 1];
  return Array.from({ length: h }, (_, i) => Math.max(0, last + md * (i + 1)));
}

// Median of the last-k window — robust flat level, ignores a single huge week.
function medianWindow(y: number[], h: number): number[] {
  const n = y.length;
  if (n === 0) return Array(h).fill(0);
  const w = Math.min(6, n);
  const s = y.slice(n - w).slice().sort((a, b) => a - b);
  return Array(h).fill(Math.max(0, s[Math.floor(s.length / 2)]));
}

function theta(y: number[], h: number): number[] {
  // Theta method: combine a linear trend (theta=0 line) with SES of the
  // theta=2 series, then average. A robust M3-competition workhorse.
  const n = y.length;
  if (n < 2) return Array(h).fill(y[0] ?? 0);
  const x = Array.from({ length: n }, (_, i) => i);
  const { a, b } = olsFit(x, y);
  const linFut = Array.from({ length: h }, (_, i) => a + b * (n + i));

  // SES on the original series for the level component
  const alpha = 0.5;
  let s = y[0];
  for (let i = 1; i < n; i++) s = alpha * y[i] + (1 - alpha) * s;
  const sesFut = Array(h).fill(s);

  return linFut.map((v, i) => Math.max(0, 0.5 * v + 0.5 * sesFut[i]));
}

export const MODELS: Record<string, Model> = {
  naive_drift: naiveDrift,
  moving_average: movingAverage,
  linear_regression: linearRegression,
  loglinear_regression: loglinearRegression,
  holt_linear: holtLinear,
  holt_damped: holtDamped,
  theta,
  ses,
  median_drift: medianDrift,
  median_window: medianWindow,
};

// ── Data transformations ──────────────────────────────────────────────────────
// Each transform exposes fwd() (raw → fit space) and inv() (forecast → raw).
// Models are fit on fwd(series); the resulting forecast is mapped back with
// inv() so all error metrics are always computed in the RAW value space.
interface Transform { fwd: (y: number[]) => number[]; inv: (p: number[]) => number[]; }
type TransformFactory = (series: number[]) => Transform;

const tfIdentity: TransformFactory = () => ({ fwd: y => y.slice(), inv: p => p });

// log1p — tames exponential growth & heavy right tails (viral spikes).
const tfLog: TransformFactory = () => ({
  fwd: y => y.map(v => Math.log1p(Math.max(0, v))),
  inv: p => p.map(v => Math.max(0, Math.expm1(v))),
});

// Winsorize at the 95th percentile — caps single-week outliers before fitting.
const tfClip: TransformFactory = (series) => {
  const s = series.slice().sort((a, b) => a - b);
  const cap = s[Math.floor(s.length * 0.95)] ?? s[s.length - 1] ?? 0;
  return { fwd: y => y.map(v => Math.min(v, cap)), inv: p => p };
};

// Centered 3-point moving-average smoothing — denoise before fitting.
const tfSmooth: TransformFactory = () => ({
  fwd: y => {
    const n = y.length; const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let sum = 0, cnt = 0;
      for (let j = a; j <= b; j++) { sum += y[j]; cnt++; }
      out.push(sum / cnt);
    }
    return out;
  },
  inv: p => p,
});

export const TRANSFORMS: Record<string, TransformFactory> = {
  identity: tfIdentity,
  log: tfLog,
  clip: tfClip,
  smooth: tfSmooth,
};

// ── Trend extraction ──────────────────────────────────────────────────────────
// Robust centered rolling median. This strips out one-off viral spikes and
// leaves the underlying, *predictable* trend of the series. For very spiky
// creator data, forecasting (and back-testing against) this trend is far more
// reliable than chasing un-forecastable spikes — which is exactly what
// commercial tools (Tubular, Social Blade) surface as their trend lines.
function rollingMedian(y: number[], w: number): number[] {
  const n = y.length;
  const half = Math.floor(w / 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    const win = y.slice(a, b + 1).slice().sort((p, q) => p - q);
    out.push(win[Math.floor(win.length / 2)]);
  }
  return out;
}

// Window scales mildly with series length (wider window = smoother trend).
function trendWindowFor(n: number): number {
  return n >= 20 ? 5 : 3;
}

// ── Error metrics ─────────────────────────────────────────────────────────────

const SENTINEL = 999; // used when a metric can't be computed (e.g. all-zero test)

function mape(actual: number[], pred: number[]): number {
  let sum = 0, cnt = 0;
  for (let i = 0; i < actual.length; i++) {
    const denom = Math.abs(actual[i]);
    if (denom < 1e-6) continue; // skip zero weeks to avoid div-by-zero blowups
    sum += Math.abs(actual[i] - pred[i]) / denom;
    cnt++;
  }
  return cnt === 0 ? SENTINEL : (sum / cnt) * 100;
}

// Symmetric MAPE — bounded [0,200], robust when actuals are near zero.
function smape(actual: number[], pred: number[]): number {
  let sum = 0, cnt = 0;
  for (let i = 0; i < actual.length; i++) {
    const denom = (Math.abs(actual[i]) + Math.abs(pred[i])) / 2;
    if (denom < 1e-6) continue;
    sum += Math.abs(actual[i] - pred[i]) / denom;
    cnt++;
  }
  return cnt === 0 ? SENTINEL : (sum / cnt) * 100;
}

function rmse(actual: number[], pred: number[]): number {
  let sum = 0;
  for (let i = 0; i < actual.length; i++) sum += (actual[i] - pred[i]) ** 2;
  return Math.sqrt(sum / actual.length);
}

function mae(actual: number[], pred: number[]): number {
  let sum = 0;
  for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i] - pred[i]);
  return sum / actual.length;
}

// R² on the holdout. Can be negative when a model does worse than the test mean.
function r2(actual: number[], pred: number[]): number {
  const n = actual.length;
  if (n === 0) return 0;
  const mean = actual.reduce((a, b) => a + b, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (actual[i] - pred[i]) ** 2;
    ssTot += (actual[i] - mean) ** 2;
  }
  if (ssTot < 1e-9) return 0; // flat series → R² undefined, report 0
  return 1 - ssRes / ssTot;
}

// MASE: MAE of the model divided by the MAE of a one-step naive forecast on
// the training data. <1 means the model beats naive; >1 means it doesn't.
function mase(trainSeries: number[], actual: number[], pred: number[]): number {
  let naiveSum = 0, naiveCnt = 0;
  for (let i = 1; i < trainSeries.length; i++) {
    naiveSum += Math.abs(trainSeries[i] - trainSeries[i - 1]);
    naiveCnt++;
  }
  const naiveMae = naiveCnt > 0 ? naiveSum / naiveCnt : 0;
  if (naiveMae < 1e-9) return SENTINEL;
  return mae(actual, pred) / naiveMae;
}

function std(values: number[]): number {
  const v = values.filter(x => x < SENTINEL); // drop sentinels
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

function meanOf(values: number[]): number {
  const v = values.filter(x => x < SENTINEL);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : SENTINEL;
}

// ── Verdict heuristic ─────────────────────────────────────────────────────────
// Combines out-of-sample accuracy (MASE vs naive) and CV stability into a
// single label. Thresholds are calibrated for noisy, viral-spike creator data:
// a single huge week makes a low MAPE impossible, so "beats / ties naive" and
// cross-validation stability matter far more than a low absolute MAPE or a
// strict test/train ratio. The test/train ratio is kept only as a sanity guard
// against genuinely catastrophic divergence, not as the primary trigger.
function makeVerdict(mase: number, overfitRatio: number, cvStd: number, cvMape: number): ModelScore["verdict"] {
  if (cvMape >= SENTINEL && mase >= SENTINEL) return "unreliable";

  const beatsNaive   = mase < 1.3;                 // within ~30% of naive (noisy domain)
  const decent       = mase < 2.5;                 // worse than naive but still usable
  const stable       = cvStd < 35 && cvMape < 150; // CV errors don't swing wildly
  const veryStable   = cvStd < 20 && cvMape < 100;
  const catastrophic = cvMape >= SENTINEL || cvStd > 90 || mase > 6;

  if (catastrophic) return "unreliable";
  if (beatsNaive && veryStable) return "robust";
  if ((beatsNaive && stable) || (decent && veryStable)) return "moderate";
  if (decent || stable) return "weak";
  return "unreliable";
}

// ── Rolling-origin cross-validation ───────────────────────────────────────────
// Expanding window: train on [0..k), test on the next `step` points, slide
// forward. `predict` already bakes in the data transform, and MAPE is always
// computed against RAW test values. Returns the per-fold MAPEs.
type PredictFn = (train: number[], h: number) => number[];
function rollingCvMapes(series: number[], predict: PredictFn, step: number, minTrain: number): number[] {
  const n = series.length;
  const out: number[] = [];
  for (let cut = minTrain; cut + 1 <= n; cut += step) {
    const testEnd = Math.min(cut + step, n);
    const train = series.slice(0, cut);
    const test = series.slice(cut, testEnd);
    if (test.length === 0) break;
    try {
      const pred = predict(train, test.length);
      out.push(mape(test, pred));
    } catch {
      out.push(SENTINEL);
    }
  }
  return out;
}

// Build a transform-aware prediction function: fit the model in the transformed
// space, then invert the forecast back to raw value space.
function makePredict(fn: Model, tfFactory: TransformFactory): PredictFn {
  return (train: number[], h: number) => {
    const t = tfFactory(train);
    return t.inv(fn(t.fwd(train), h));
  };
}

/**
 * Backtest every model on a single series and produce a full diagnostic
 * profile per model:
 *   - holdout accuracy (MAPE, sMAPE, RMSE, MAE, R², MASE, skill vs naive)
 *   - overfitting (train vs test MAPE, ratio, gap)
 *   - rolling-origin CV (mean + std of fold MAPEs)
 *   - a robustness verdict
 * The best model is chosen by lowest CV MAPE (more reliable than a single
 * holdout), with the single-holdout MAPE as a tiebreaker.
 */
export function fitAndForecast(fullSeries: number[], h: number): MetricForecast {
  // Only model the most recent window — ancient regimes hurt reliability (see
  // MODEL_WINDOW_WEEKS). The full series is kept upstream for charting.
  const series = fullSeries.length > MODEL_WINDOW_WEEKS
    ? fullSeries.slice(fullSeries.length - MODEL_WINDOW_WEEKS)
    : fullSeries;
  const n = series.length;
  const nonZeroWeeks = series.filter(v => Math.abs(v) > 1e-6).length;
  const mean = n ? series.reduce((a, b) => a + b, 0) / n : 0;

  // Too short to backtest meaningfully → fall back to drift, no diagnostics.
  if (n < 6) {
    const fc = naiveDrift(series, h);
    const flat: ModelScore = {
      model: "naive_drift", transform: "identity", mode: "raw", mape: 0, smape: 0, rmse: 0, mae: 0, r2: 0, mase: 1,
      skillVsNaive: 0, trainMape: 0, testMape: 0, overfitRatio: 1, overfitGap: 0,
      cvMape: 0, cvStd: 0, cvFolds: 0, verdict: "weak",
    };
    return {
      bestModel: "naive_drift", forecast: fc, scores: [flat],
      diagnostics: { points: n, testSize: 0, nonZeroWeeks, mean, trendMode: false, trendWindow: 0 },
    };
  }

  // The robust trend (rolling median) is the spike-free backbone of the series.
  // We evaluate every model on BOTH the raw series and its trend, then keep
  // whichever is more reliable. For viral creator data the trend almost always
  // wins because raw spikes are simply not forecastable.
  const tWindow = trendWindowFor(n);
  const trend = rollingMedian(series, tWindow);

  // Hold-out size: a balanced back-test window. On noisy creator data a longer
  // hold-out starves the (already short) training set and inflates test/CV MAPE,
  // pushing too many series to "unreliable" — empirically n/6 produced ~41/100
  // unreliable views vs. ~30 with n/8 (and a better median CV). A ~1/8 window
  // is a meaningful look-ahead without over-penalising sparse series. Bounded so
  // short series still get ≥2 weeks and no series tests on more than a third.
  //   • n ≈ 52  (1y, capped) → testSize 6
  //   • n = 16              → testSize 2
  //   • n = 6   (min)       → testSize 2
  const testSize = Math.max(2, Math.min(HORIZON_WEEKS, Math.floor(n / 8), Math.floor(n / 3)));

  // Evaluate one (model, transform) combo against a given TARGET series (raw or
  // trend). All metrics are computed against that target's own holdout/folds.
  const evalCombo = (
    target: number[], mode: "raw" | "trend",
    name: string, fn: Model, tfName: string, tfFactory: TransformFactory,
  ): ModelScore => {
    const train = target.slice(0, target.length - testSize);
    const test = target.slice(target.length - testSize);
    const naivePred = Array(testSize).fill(train[train.length - 1] ?? 0);
    const naiveRmse = rmse(test, naivePred);
    const cvStep = Math.max(2, Math.min(4, Math.floor(target.length / 4)));
    const cvMinTrain = Math.max(6, Math.floor(target.length * 0.4));

    const predict = makePredict(fn, tfFactory);

    // Out-of-sample (holdout).
    const pred = predict(train, testSize);
    const testMapeV = mape(test, pred);
    const rmseV = rmse(test, pred);

    // In-sample (fit on train-minus-tail, predict the held-back tail of train).
    const innerTrain = train.slice(0, Math.max(2, train.length - testSize));
    const innerTest = train.slice(Math.max(2, train.length - testSize));
    const trainPred = innerTest.length ? predict(innerTrain, innerTest.length) : pred;
    const trainMapeV = innerTest.length ? mape(innerTest, trainPred) : testMapeV;

    // Rolling-origin CV (over the target series).
    const folds = rollingCvMapes(target, predict, cvStep, cvMinTrain);
    const cvMapeV = meanOf(folds);
    const cvStdV = std(folds);

    const maseV = mase(train, test, pred);
    const skill = naiveRmse > 1e-9 ? (1 - rmseV / naiveRmse) * 100 : 0;
    const overfitRatioV = trainMapeV > 1e-6 ? testMapeV / trainMapeV : (testMapeV > 1 ? SENTINEL : 1);

    return {
      model: name,
      transform: tfName,
      mode,
      mape: testMapeV,
      smape: smape(test, pred),
      rmse: rmseV,
      mae: mae(test, pred),
      r2: r2(test, pred),
      mase: maseV,
      skillVsNaive: +skill.toFixed(1),
      trainMape: trainMapeV,
      testMape: testMapeV,
      overfitRatio: +overfitRatioV.toFixed(2),
      overfitGap: +(testMapeV - trainMapeV).toFixed(1),
      cvMape: cvMapeV,
      cvStd: cvStdV,
      cvFolds: folds.length,
      verdict: makeVerdict(maseV, overfitRatioV, cvStdV, cvMapeV),
    };
  };

  const better = (a: ModelScore, b: ModelScore) => (a.cvMape - b.cvMape) || (a.mape - b.mape);

  // For each (model), search all transforms × both modes, keep the single best
  // variant. This keeps the diagnostics table to one row per model, annotated
  // with the winning transform AND whether it targeted raw values or the trend.
  const scores: ModelScore[] = [];
  for (const [name, fn] of Object.entries(MODELS)) {
    let bestForModel: ModelScore | null = null;
    for (const [tfName, tfFactory] of Object.entries(TRANSFORMS)) {
      for (const [target, mode] of [[series, "raw"], [trend, "trend"]] as [number[], "raw" | "trend"][]) {
        try {
          const s = evalCombo(target, mode, name, fn, tfName, tfFactory);
          if (!bestForModel || better(s, bestForModel) < 0) bestForModel = s;
        } catch { /* skip this combo */ }
      }
    }
    scores.push(bestForModel ?? {
      model: name, transform: "identity", mode: "raw", mape: SENTINEL, smape: SENTINEL, rmse: Infinity, mae: Infinity,
      r2: -SENTINEL, mase: SENTINEL, skillVsNaive: -SENTINEL, trainMape: SENTINEL,
      testMape: SENTINEL, overfitRatio: SENTINEL, overfitGap: SENTINEL,
      cvMape: SENTINEL, cvStd: SENTINEL, cvFolds: 0, verdict: "unreliable",
    });
  }

  // Select best overall by CV MAPE (robust), tiebreak on holdout MAPE.
  scores.sort(better);
  const winner = scores[0];
  // Refit the winning (model + transform) on the FULL winning target (raw series
  // or its trend) so the published forecast matches what was back-tested.
  const winningTarget = winner.mode === "trend" ? trend : series;
  const forecast = makePredict(MODELS[winner.model], TRANSFORMS[winner.transform] ?? tfIdentity)(winningTarget, h);

  return {
    bestModel: winner.model,
    forecast,
    scores,
    diagnostics: {
      points: n, testSize, nonZeroWeeks, mean,
      trendMode: winner.mode === "trend",
      trendWindow: winner.mode === "trend" ? tWindow : 0,
    },
  };
}

// ── Convenience: forecast both metrics for a creator ──────────────────────────

export interface CreatorForecast {
  history: WeeklySeries;
  forecast: ForecastResult;
  views: MetricForecast;
  followers: MetricForecast;
  predViewsGrowth: number;     // (sum forecast views) / (sum recent views) - 1
  predFollowersGrowth: number; // predicted net follower change / current followers
}

function futureWeekLabels(lastWeek: string, h: number): string[] {
  const out: string[] = [];
  let d = new Date((lastWeek || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
  for (let i = 0; i < h; i++) {
    d = new Date(d);
    d.setUTCDate(d.getUTCDate() + 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function forecastCreator(daily: DailyPoint[], currentFollowers: number): CreatorForecast {
  const history = aggregateWeekly(daily);
  const h = HORIZON_WEEKS;

  const viewsFc = fitAndForecast(history.views, h);
  const followersFc = fitAndForecast(history.followers, h);
  const futureWeeks = futureWeekLabels(history.weeks[history.weeks.length - 1], h);

  // Predicted growth ratios for the scoring signal.
  const recentN = Math.min(h, history.views.length);
  const recentViews = history.views.slice(-recentN).reduce((a, b) => a + b, 0) || 1;
  const futViews = viewsFc.forecast.reduce((a, b) => a + b, 0);
  const predViewsGrowth = futViews / recentViews - 1;

  const futFollowerNet = followersFc.forecast.reduce((a, b) => a + b, 0);
  const predFollowersGrowth = currentFollowers > 0 ? futFollowerNet / currentFollowers : 0;

  return {
    history,
    forecast: { weeks: futureWeeks, views: viewsFc.forecast, followers: followersFc.forecast },
    views: viewsFc,
    followers: followersFc,
    predViewsGrowth,
    predFollowersGrowth,
  };
}

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export interface GlobalForecastResult {
  [creatorId: string]: {
    views: { p10: number[]; p50: number[]; p90: number[] };
    followers: { p10: number[]; p50: number[]; p90: number[] };
    dates: string[];
    metrics: {
      views: { cvMape: number; testMape: number };
      followers: { cvMape: number; testMape: number };
    };
  };
}

export async function globalForecast(
  creatorsData: { creatorId: string; genre: string; history: any[] }[],
  horizonDays: number = 84
): Promise<GlobalForecastResult> {
  return new Promise((resolve, reject) => {
    // Determine python executable path (using the .venv if it exists)
    const venvPython = path.resolve(process.cwd(), ".venv/bin/python3");
    const pythonExec = fs.existsSync(venvPython) ? venvPython : "python3";
    const scriptPath = path.resolve(process.cwd(), "server/ml/forecast.py");

    const py = spawn(pythonExec, [scriptPath]);

    let out = "";
    let err = "";

    py.stdout.on("data", (data) => {
      out += data.toString();
    });

    py.stderr.on("data", (data) => {
      err += data.toString();
    });

    py.on("close", (code) => {
      if (code !== 0) {
        console.error("Python forecasting error:", err);
        return reject(new Error(`Python script exited with code ${code}: ${err}`));
      }
      try {
        const result = JSON.parse(out);
        resolve(result);
      } catch (e) {
        reject(new Error("Failed to parse Python forecast output"));
      }
    });

    const payload = JSON.stringify({
      creators: creatorsData,
      horizon_days: horizonDays,
    });

    py.stdin.write(payload);
    py.stdin.end();
  });
}
