import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import type { AppDb } from "./db.js";
import type { ServerConfig } from "./config.js";

function buildSimpleHtml(up: Array<{ t: number; p: number }>, down: Array<{ t: number; p: number }>, title: string) {
  return `<!doctype html>
<html><body style="margin:0;background:#111;color:#eee;font-family:Arial">
<div style="padding:12px;font-size:14px">${title}</div>
<svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1280" height="720" fill="#111" />
  <line x1="80" y1="650" x2="1220" y2="650" stroke="#444"/>
  <line x1="80" y1="60" x2="80" y2="650" stroke="#444"/>
  ${polyline(up, "#21d07a")}
  ${polyline(down, "#ff5a5f")}
</svg></body></html>`;
}

function polyline(points: Array<{ t: number; p: number }>, color: string) {
  if (!points.length) return "";
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = Math.max(1, maxT - minT);
  const mapped = points
    .map((pt) => {
      const x = 80 + ((pt.t - minT) / spanT) * 1140;
      const y = 650 - Math.max(0, Math.min(1, pt.p)) * 590;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${mapped}" />`;
}

export class ScreenshotWorker {
  private timer?: NodeJS.Timeout;
  constructor(private readonly cfg: ServerConfig, private readonly db: AppDb) {}

  async start() {
    fs.mkdirSync(this.cfg.screenshotsDir, { recursive: true });
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const rows = this.db.getOpenWindowsNeedingScreenshot(Math.floor(Date.now() / 1000)) as Array<{
      window_slug: string;
      timeframe: string;
      symbol: string;
    }>;
    for (const w of rows) {
      const data = this.db.getSeries(w.window_slug) as Array<{ side: "Up" | "Down"; t: number; p: number }>;
      const up = data.filter((x) => x.side === "Up").map((x) => ({ t: x.t, p: x.p }));
      const down = data.filter((x) => x.side === "Down").map((x) => ({ t: x.t, p: x.p }));
      if (!up.length && !down.length) continue;
      const fileName = `${w.symbol}-${w.timeframe}-${w.window_slug}.${this.cfg.screenshotFormat}`;
      const outPath = path.join(this.cfg.screenshotsDir, fileName);
      await this.renderToFile(buildSimpleHtml(up, down, w.window_slug), outPath, this.cfg.screenshotFormat);
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
      await page.setViewport({ width: 1280, height: 720 });
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
