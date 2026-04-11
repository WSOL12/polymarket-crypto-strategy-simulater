import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import type { AppDb } from "./db.js";
import type { ServerConfig } from "./config.js";
import {
  formatScreenshotFileStem,
  formatWindowRangeEt,
} from "../shared/formatEtWindow.js";

/** Vertical grid lines: elapsed time = (span / 40) × i, i = 0…40 (41 ticks). */
const TIME_DIVISIONS = 40;

/** Taller plot so 2¢ Y labels (~51 rows) do not overlap (~13px per row). */
const PLOT = {
  left: 96,
  right: 1188,
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

function axisAndGridSvg(minT: number, maxT: number, spanT: number): string {
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
  const stepSec = spanT / TIME_DIVISIONS;
  for (let i = 0; i <= TIME_DIVISIONS; i++) {
    const elapsed = i * stepSec;
    const tAbs = minT + elapsed;
    const x = xForT(tAbs, minT, spanT);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${PLOT.top}" x2="${x.toFixed(1)}" y2="${PLOT.bottom}" stroke="#2a2a2a" stroke-width="1" />`
    );
    parts.push(
      `<text x="${x.toFixed(1)}" y="${PLOT.bottom + 16}" fill="#aaa" font-size="9" text-anchor="middle">${escapeXml(formatElapsed(elapsed))}</text>`
    );
  }
  parts.push(
    `<line x1="${PLOT.left}" y1="${PLOT.bottom}" x2="${PLOT.right}" y2="${PLOT.bottom}" stroke="#666" stroke-width="1.5" />`
  );
  parts.push(
    `<line x1="${PLOT.left}" y1="${PLOT.top}" x2="${PLOT.left}" y2="${PLOT.bottom}" stroke="#666" stroke-width="1.5" />`
  );
  const stepLabel = formatTimeStep(stepSec);
  parts.push(
    `<text x="${(PLOT.left + PLOT.right) / 2}" y="${PLOT.bottom + 40}" fill="#888" font-size="12" text-anchor="middle">Time from window start — ${TIME_DIVISIONS} equal parts, one tick every ${escapeXml(stepLabel)}</text>`
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
  title: string,
  subtitle: string
) {
  const allT = [...up.map((p) => p.t), ...down.map((p) => p.t)];
  const minT = allT.length ? Math.min(...allT) : 0;
  const maxT = allT.length ? Math.max(...allT) : 1;
  const spanT = Math.max(1, maxT - minT);

  const axes = axisAndGridSvg(minT, maxT, spanT);
  const lines =
    polylineSvg(up, "#21d07a", minT, spanT) + "\n" + polylineSvg(down, "#ff5a5f", minT, spanT);
  const marks = extremaAnnotations(up, down, minT, spanT);

  return `<!doctype html>
<html><body style="margin:0;background:#111;color:#eee;font-family:system-ui,Segoe UI,Arial,sans-serif">
<div style="padding:16px 20px 8px">
  <div style="font-size:18px;font-weight:600">${escapeXml(title)}</div>
  <div style="font-size:13px;color:#9ab;margin-top:4px">${escapeXml(subtitle)}</div>
  <div style="margin-top:10px;font-size:13px">
    <span style="color:#21d07a">● Up</span>
    <span style="margin-left:16px;color:#ff5a5f">● Down</span>
    <span style="margin-left:16px;color:#888">Y: 0–100¢ (every 2¢) · X: elapsed (window ÷ ${TIME_DIVISIONS})</span>
  </div>
</div>
<svg width="1280" height="900" viewBox="0 0 1280 900" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1280" height="900" fill="#111" />
  ${axes}
  ${lines}
  ${marks}
</svg></body></html>`;
}

export class ScreenshotWorker {
  private timer?: NodeJS.Timeout;
  constructor(private readonly cfg: ServerConfig, private readonly db: AppDb) {}

  async start() {
    fs.mkdirSync(this.cfg.screenshotsDir, { recursive: true });
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 8000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const rows = this.db.getOpenWindowsNeedingScreenshot(Math.floor(Date.now() / 1000)) as Array<{
      window_slug: string;
      timeframe: string;
      symbol: string;
      start_ts: number;
      end_ts: number;
    }>;
    for (const w of rows) {
      const data = this.db.getSeries(w.window_slug) as Array<{ side: "Up" | "Down"; t: number; p: number }>;
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
      const subtitle = "Up vs Down (mid from live stream & trades) · Eastern Time";
      await this.renderToFile(
        buildSimpleHtml(up, down, title, subtitle),
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
  }

  private async renderToFile(html: string, outPath: string, format: "png" | "jpg") {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ??
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1040 });
      await page.setContent(html, { waitUntil: "networkidle0" });
      if (format === "jpg") {
        await page.screenshot({ path: outPath, type: "jpeg", quality: 90 });
      } else {
        await page.screenshot({ path: outPath, type: "png" });
      }
    } finally {
      await browser.close();
    }
  }
}
