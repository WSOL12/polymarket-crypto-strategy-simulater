import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import type { AppDb } from "./db.js";
import type { ServerConfig } from "./config.js";
import {
  chainlinkTicksInRange,
  strikeFromChainlinkBuffer,
} from "./chainlinkBuffer.js";
import { fetchGammaStrikeContext } from "./services.js";
import {
  formatScreenshotFileStem,
  formatWindowRangeEt,
} from "../shared/formatEtWindow.js";

/** Vertical grid lines: elapsed time = (span / 40) × i, i = 0…40 (41 ticks). */
const TIME_LABEL_STEP_SEC_DEFAULT = 30;
const TIME_LABEL_STEP_SEC_HOURLY = 120;
const TIME_LABEL_STEP_SEC_5M = 15;
const FIVE_MIN_SEC = 5 * 60;
const PRICE_GRID_STEPS = 50;
const DIFF_USD_PER_GRID = 5; // 2 grids = $10
const DIFF_MAX_ABS_USD = (PRICE_GRID_STEPS / 2) * DIFF_USD_PER_GRID; // +/-125

/** Taller plot so 2¢ Y labels (~51 rows) do not overlap (~13px per row). */
const PLOT = {
  left: 96,
  right: 1132,
  top: 64,
  bottom: 814,
} as const;

function plotW() {
  return PLOT.right - PLOT.left;
}

function plotH() {
  return PLOT.bottom - PLOT.top;
}

function xForT(t: number, minT: number, spanT: number): number {
  return PLOT.left + ((t - minT) / spanT) * plotW();
}

function yForP(p: number): number {
  const clamped = Math.max(0, Math.min(1, p));
  return PLOT.bottom - clamped * plotH();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Elapsed seconds from window start (0, step, 2·step, …). */
function formatElapsed(secTotal: number): string {
  const s = Math.max(0, Math.round(secTotal));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (r === 0) return `${m}m`;
  return `${m}m ${r}s`;
}

function formatCents(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

/** Human-readable step size for X (e.g. 15m → 22.5s). */
function formatTimeStep(stepSec: number): string {
  if (!Number.isFinite(stepSec) || stepSec <= 0) return "—";
  const s = Math.round(stepSec * 100) / 100;
  if (s < 60) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round((s - m * 60) * 100) / 100;
  if (r <= 0) return `${m}m`;
  const rStr = Number.isInteger(r) ? `${r}` : `${r.toFixed(1)}`;
  return `${m}m ${rStr}s`;
}

function polylineSvg(
  points: Array<{ t: number; p: number }>,
  color: string,
  minT: number,
  spanT: number
): string {
  if (!points.length) return "";
  const mapped = points
    .map((pt) => {
      const x = xForT(pt.t, minT, spanT);
      const y = yForP(pt.p);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${mapped}" />`;
}

function polylineDiffSvg(
  points: Array<{ t: number; d: number }>,
  minT: number,
  spanT: number,
  maxAbsD: number
): string {
  if (!points.length || !Number.isFinite(maxAbsD) || maxAbsD <= 0) return "";
  const centerY = (PLOT.top + PLOT.bottom) / 2;
  const pxPerGrid = plotH() / PRICE_GRID_STEPS;
  const yForD = (d: number) => {
    const clamped = Math.max(-maxAbsD, Math.min(maxAbsD, d));
    return centerY - (clamped / DIFF_USD_PER_GRID) * pxPerGrid;
  };
  const mapped = points
    .map((pt) => {
      const x = xForT(pt.t, minT, spanT);
      const y = yForD(pt.d);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `<polyline fill="none" stroke="#5fb6ff" stroke-width="3" points="${mapped}" />`;
}

function axisAndGridSvg(
  minT: number,
  maxT: number,
  spanT: number,
  diffAbsMax?: number | null
): string {
  const parts: string[] = [];
  for (let cents = 0; cents <= 100; cents += 2) {
    const p = cents / 100;
    const y = yForP(p);
    parts.push(
      `<line x1="${PLOT.left}" y1="${y.toFixed(1)}" x2="${PLOT.right}" y2="${y.toFixed(1)}" stroke="#2a2a2a" stroke-width="1" />`
    );
    parts.push(
      `<text x="${PLOT.left - 8}" y="${y + 4}" fill="#aaa" font-size="10" text-anchor="end">${escapeXml(`${cents}¢`)}</text>`
    );
  }
  const stepSec =
    spanT >= 3600 - 1
      ? TIME_LABEL_STEP_SEC_HOURLY
      : spanT <= FIVE_MIN_SEC + 1
        ? TIME_LABEL_STEP_SEC_5M
        : TIME_LABEL_STEP_SEC_DEFAULT;
  let lastElapsed = -1;
  for (let elapsed = 0; elapsed <= spanT + 0.001; elapsed += stepSec) {
    const e = Math.min(elapsed, spanT);
    const tAbs = minT + e;
    const x = xForT(tAbs, minT, spanT);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${PLOT.top}" x2="${x.toFixed(1)}" y2="${PLOT.bottom}" stroke="#2a2a2a" stroke-width="1" />`
    );
    parts.push(
      `<text x="${x.toFixed(1)}" y="${PLOT.bottom + 16}" fill="#aaa" font-size="9" text-anchor="middle">${escapeXml(formatElapsed(e))}</text>`
    );
    lastElapsed = e;
  }
  if (spanT - lastElapsed > 1) {
    const x = xForT(minT + spanT, minT, spanT);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${PLOT.top}" x2="${x.toFixed(1)}" y2="${PLOT.bottom}" stroke="#2a2a2a" stroke-width="1" />`
    );
    parts.push(
      `<text x="${x.toFixed(1)}" y="${PLOT.bottom + 16}" fill="#aaa" font-size="9" text-anchor="middle">${escapeXml(formatElapsed(spanT))}</text>`
    );
  }
  parts.push(
    `<line x1="${PLOT.left}" y1="${PLOT.bottom}" x2="${PLOT.right}" y2="${PLOT.bottom}" stroke="#666" stroke-width="1.5" />`
  );
  parts.push(
    `<line x1="${PLOT.left}" y1="${PLOT.top}" x2="${PLOT.left}" y2="${PLOT.bottom}" stroke="#666" stroke-width="1.5" />`
  );
  if (diffAbsMax != null && Number.isFinite(diffAbsMax) && diffAbsMax > 0) {
    const centerY = (PLOT.top + PLOT.bottom) / 2;
    const pxPerGrid = plotH() / PRICE_GRID_STEPS;
    const start = Math.ceil((-diffAbsMax) / 10) * 10;
    const end = Math.floor(diffAbsMax / 10) * 10;
    for (let v = start; v <= end; v += 10) {
      const y = centerY - (v / DIFF_USD_PER_GRID) * pxPerGrid;
      if (y < PLOT.top + 12 || y > PLOT.bottom - 12) continue;
      parts.push(
        `<text x="${PLOT.right + 12}" y="${y + 4}" fill="#8fc9ff" font-size="10" text-anchor="start">${escapeXml(`${v >= 0 ? "+" : ""}$${v.toFixed(2)}`)}</text>`
      );
    }
    parts.push(
      `<line x1="${PLOT.left}" y1="${centerY.toFixed(1)}" x2="${PLOT.right}" y2="${centerY.toFixed(1)}" stroke="#36516f" stroke-width="1" stroke-dasharray="4 4" />`
    );
    const yMid = (PLOT.top + PLOT.bottom) / 2;
    parts.push(
      `<text transform="translate(${PLOT.right + 50},${yMid}) rotate(90)" fill="#8fc9ff" font-size="13" text-anchor="middle">Token Diff ($)</text>`
    );
  }
  const stepLabel = formatTimeStep(stepSec);
  parts.push(
    `<text x="${(PLOT.left + PLOT.right) / 2}" y="${PLOT.bottom + 40}" fill="#888" font-size="12" text-anchor="middle">Time from window start — label every ${escapeXml(stepLabel)}</text>`
  );
  const yMid = (PLOT.top + PLOT.bottom) / 2;
  parts.push(
    `<text transform="translate(22,${yMid}) rotate(-90)" fill="#888" font-size="12" text-anchor="middle">Price (¢)</text>`
  );
  return parts.join("\n");
}

function extremaAnnotations(
  up: Array<{ t: number; p: number }>,
  down: Array<{ t: number; p: number }>,
  minT: number,
  spanT: number
): string {
  const all: Array<{ t: number; p: number; side: string }> = [
    ...up.map((pt) => ({ ...pt, side: "Up" })),
    ...down.map((pt) => ({ ...pt, side: "Down" })),
  ];
  if (all.length === 0) return "";
  let hi = all[0];
  let lo = all[0];
  for (const pt of all) {
    if (pt.p > hi.p) hi = pt;
    if (pt.p < lo.p) lo = pt;
  }
  const parts: string[] = [];
  const samePoint =
    hi.t === lo.t && Math.abs(hi.p - lo.p) < 1e-12;

  const drawMark = (
    pt: { t: number; p: number },
    label: string,
    color: string,
    dy: number
  ) => {
    const x = xForT(pt.t, minT, spanT);
    const y = yForP(pt.p);
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${color}" stroke="#fff" stroke-width="1.5" />`
    );
    const boxW = Math.min(220, Math.max(130, label.length * 7.5 + 16));
    let tx = x - boxW / 2;
    tx = Math.max(PLOT.left + 4, Math.min(PLOT.right - boxW - 4, tx));
    const ty = y + dy;
    const boxY = Math.max(PLOT.top + 4, Math.min(PLOT.bottom - 26, ty));
    parts.push(
      `<rect x="${tx.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(0)}" height="20" rx="4" fill="#1a1a1a" stroke="${color}" stroke-width="1" opacity="0.96" />`
    );
    parts.push(
      `<text x="${(tx + 8).toFixed(1)}" y="${(boxY + 14).toFixed(1)}" fill="#eee" font-size="12" font-weight="600">${escapeXml(label)}</text>`
    );
  };

  if (samePoint) {
    drawMark(hi, `High & low ${formatCents(hi.p)} (${hi.side})`, "#21d07a", -28);
  } else {
    drawMark(hi, `High ${formatCents(hi.p)} (${hi.side})`, "#21d07a", -28);
    drawMark(lo, `Low ${formatCents(lo.p)} (${lo.side})`, "#ff5a5f", 22);
  }
  return parts.join("\n");
}

function buildSimpleHtml(
  up: Array<{ t: number; p: number }>,
  down: Array<{ t: number; p: number }>,
  diff: Array<{ t: number; d: number }>,
  title: string,
  subtitle: string
) {
  const allT = [...up.map((p) => p.t), ...down.map((p) => p.t)];
  const minT = allT.length ? Math.min(...allT) : 0;
  const maxT = allT.length ? Math.max(...allT) : 1;
  const spanT = Math.max(1, maxT - minT);

  const diffMinRaw = diff.length ? Math.min(...diff.map((x) => x.d)) : NaN;
  const diffMaxRaw = diff.length ? Math.max(...diff.map((x) => x.d)) : NaN;
  const hasDiffData = Number.isFinite(diffMinRaw) && Number.isFinite(diffMaxRaw);
  const diffAbsMax = hasDiffData ? DIFF_MAX_ABS_USD : null;
  const xLabelStepSec =
    spanT >= 3600 - 1
      ? TIME_LABEL_STEP_SEC_HOURLY
      : spanT <= FIVE_MIN_SEC + 1
        ? TIME_LABEL_STEP_SEC_5M
        : TIME_LABEL_STEP_SEC_DEFAULT;
  const xLabelStepText = formatTimeStep(xLabelStepSec);

  const axes = axisAndGridSvg(minT, maxT, spanT, diffAbsMax);
  const lines = [
    polylineSvg(up, "#21d07a", minT, spanT),
    polylineSvg(down, "#ff5a5f", minT, spanT),
    diffAbsMax != null ? polylineDiffSvg(diff, minT, spanT, diffAbsMax) : "",
  ].join("\n");
  const marks = extremaAnnotations(up, down, minT, spanT);

  return `<!doctype html>
<html><body style="margin:0;background:#111;color:#eee;font-family:system-ui,Segoe UI,Arial,sans-serif">
<div style="padding:16px 20px 8px">
  <div style="font-size:18px;font-weight:600">${escapeXml(title)}</div>
  <div style="font-size:13px;color:#9ab;margin-top:4px">${escapeXml(subtitle)}</div>
  <div style="margin-top:10px;font-size:13px">
    <span style="color:#21d07a">● Up</span>
    <span style="margin-left:16px;color:#ff5a5f">● Down</span>
    ${diffAbsMax != null ? '<span style="margin-left:16px;color:#5fb6ff">● Token diff ($)</span>' : ""}
    <span style="margin-left:16px;color:#888">Y: 0–100¢ (every 2¢) · X labels every ${xLabelStepText}</span>
  </div>
</div>
<svg width="1280" height="900" viewBox="0 0 1280 900" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1280" height="900" fill="#111" />
  ${axes}
  ${lines}
  ${marks}
</svg></body></html>`;
}

/** Static chart HTML has no network; `networkidle0` often times out on VPS / busy hosts. */
const SET_CONTENT_WAIT: "domcontentloaded" = "domcontentloaded";
const SET_CONTENT_TIMEOUT_MS = 120_000;

export class ScreenshotWorker {
  private timer?: NodeJS.Timeout;
  /** One browser reused for all PNGs — avoids spawning dozens of Chrome processes under load. */
  private browser: Browser | null = null;
  /** Prevents overlapping ticks when renders are slower than the interval (e.g. many windows). */
  private tickInFlight = false;

  constructor(private readonly cfg: ServerConfig, private readonly db: AppDb) {}

  async start() {
    fs.mkdirSync(this.cfg.screenshotsDir, { recursive: true });
    await this.tick().catch((err) => console.error("[screenshotWorker] initial tick:", err));
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("[screenshotWorker] tick:", err));
    }, 8000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    void this.closeBrowser();
  }

  private async closeBrowser() {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch {
      // ignore
    }
    this.browser = null;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ??
      (process.platform === "win32"
        ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
        : undefined);
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--mute-audio",
      ],
    });
    return this.browser;
  }

  private async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
    const rows = this.db.getOpenWindowsNeedingScreenshot(Math.floor(Date.now() / 1000)) as Array<{
      window_slug: string;
      timeframe: string;
      symbol: string;
      start_ts: number;
      end_ts: number;
    }>;
    for (const w of rows) {
      // Screenshot must be based on WS best-ask samples only (not trade prints / other sources).
      const data = this.db.getSeries(w.window_slug, undefined, "ws") as Array<{
        side: "Up" | "Down";
        t: number;
        p: number;
      }>;
      const up = data.filter((x) => x.side === "Up").map((x) => ({ t: x.t, p: x.p }));
      const down = data.filter((x) => x.side === "Down").map((x) => ({ t: x.t, p: x.p }));
      if (!up.length && !down.length) continue;
      const startTs = Number(w.start_ts);
      const endTs = Number(w.end_ts);
      const readable =
        Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs
          ? formatWindowRangeEt(startTs, endTs)
          : w.window_slug;
      const stem =
        Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs
          ? formatScreenshotFileStem(w.symbol, w.timeframe, startTs, endTs)
          : `${w.symbol}-${w.timeframe}-${w.window_slug}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const fileName = `${stem}.${this.cfg.screenshotFormat}`;
      const outPath = path.join(this.cfg.screenshotsDir, fileName);
      const title = `${w.symbol} · ${w.timeframe} · ${readable}`;
      let strike: number | null = null;
      try {
        const ctx = await fetchGammaStrikeContext(this.cfg.gammaBaseUrl, w.window_slug);
        strike = ctx.metadataStrike ?? null;
      } catch {
        strike = null;
      }
      if (strike == null && Number.isFinite(startTs) && startTs > 0) {
        strike = strikeFromChainlinkBuffer(w.symbol, startTs);
      }
      const rangeTicks =
        Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs
          ? chainlinkTicksInRange(w.symbol, startTs, endTs)
          : [];
      // If strike metadata is missing, keep diff-line visible using first in-window tick as baseline.
      if (strike == null && rangeTicks.length > 0) {
        strike = rangeTicks[0]!.value;
      }
      const diff =
        strike != null && rangeTicks.length > 0
          ? rangeTicks.map((t) => ({
              t: Math.floor(t.ts / 1000),
              d: t.value - strike!,
            }))
          : [];
      const subtitle = "Up/Down best ask + token diff (spot - strike) · Eastern Time";
      await this.renderToFile(
        buildSimpleHtml(up, down, diff, title, subtitle),
        outPath,
        this.cfg.screenshotFormat
      );
      this.db.addScreenshot({
        windowSlug: w.window_slug,
        timeframe: w.timeframe,
        symbol: w.symbol,
        filePath: outPath,
        format: this.cfg.screenshotFormat,
      });
    }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async renderToFile(html: string, outPath: string, format: "png" | "jpg") {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 1040 });
      await page.setContent(html, {
        waitUntil: SET_CONTENT_WAIT,
        timeout: SET_CONTENT_TIMEOUT_MS,
      });
      if (format === "jpg") {
        await page.screenshot({ path: outPath, type: "jpeg", quality: 90 });
      } else {
        await page.screenshot({ path: outPath, type: "png" });
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
}
