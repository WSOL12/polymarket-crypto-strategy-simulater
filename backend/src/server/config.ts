import "dotenv/config";
import path from "node:path";
import type { TimeframeKey } from "../shared/types.js";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const n = Number(str(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

export type ServerConfig = {
  port: number;
  /** Dedicated HTTP server port for browser WebSocket (avoids Express upgrade conflicts). */
  wsPort: number;
  dataDir: string;
  screenshotsDir: string;
  dbPath: string;
  gammaBaseUrl: string;
  dataApiBaseUrl: string;
  horizons: TimeframeKey[];
  symbol: string;
  seriesByHorizon: Partial<Record<TimeframeKey, string>>;
  pollMs: number;
  screenshotFormat: "png" | "jpg";
  /** Polymarket RTDS WebSocket URL */
  rtdsWsUrl: string;
  /** When collector has not filled SQLite yet, you can paste outcome token IDs from Polymarket (CLOB). */
  manualClobWindowSlug: string;
  manualUpTokenId: string;
  manualDownTokenId: string;
};

const HORIZON_ENV_KEYS: Record<TimeframeKey, string> = {
  "5m": "SERIES_SLUG__5M",
  "15m": "SERIES_SLUG__15M",
  "1h": "SERIES_SLUG__1H",
};

export function loadServerConfig(): ServerConfig {
  const horizons = str("HORIZONS", "15m")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as TimeframeKey[];

  const seriesByHorizon: Partial<Record<TimeframeKey, string>> = {};
  for (const h of horizons) {
    const slug = str(HORIZON_ENV_KEYS[h]);
    if (slug) seriesByHorizon[h] = slug;
  }

  const dataDir = path.resolve(str("OUTPUT_DIR", "./data"));
  const screenshotsDir = path.join(dataDir, "screenshots");
  return {
    port: num("PORT", 3000),
    wsPort: num("WS_PORT", 3001),
    dataDir,
    screenshotsDir,
    dbPath: path.join(dataDir, "realtime.db"),
    gammaBaseUrl: str("GAMMA_BASE_URL", "https://gamma-api.polymarket.com"),
    dataApiBaseUrl: str("DATA_API_BASE_URL", "https://data-api.polymarket.com"),
    horizons,
    symbol: str("SYMBOL", "BTC"),
    seriesByHorizon,
    pollMs: num("POLL_MS", 5000),
    screenshotFormat: str("SCREENSHOT_FORMAT", "png").toLowerCase() === "jpg" ? "jpg" : "png",
    rtdsWsUrl: str("RTDS_URL", "wss://ws-live-data.polymarket.com"),
    manualClobWindowSlug: str("MANUAL_CLOB_WINDOW_SLUG", ""),
    manualUpTokenId: str("MANUAL_UP_TOKEN_ID", ""),
    manualDownTokenId: str("MANUAL_DOWN_TOKEN_ID", ""),
  };
}
