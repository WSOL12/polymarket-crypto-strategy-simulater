import express from "express";
import cors from "cors";
import path from "node:path";
import type { AppDb } from "./db.js";
import type { ServerConfig } from "./config.js";
import { strikeFromChainlinkBuffer } from "./chainlinkBuffer.js";
import { fetchGammaStrikeContext } from "./services.js";

function inferSymbolFromSlug(slug: string): string | null {
  const s = slug.toLowerCase();
  if (s.startsWith("btc")) return "BTC";
  if (s.startsWith("eth")) return "ETH";
  if (s.startsWith("sol")) return "SOL";
  if (s.startsWith("xrp")) return "XRP";
  return null;
}

export function createApi(db: AppDb, cfg: ServerConfig) {
  const app = express();
  app.set("etag", false);
  app.use(cors());
  app.use(express.json());
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/favicon.ico", (_req, res) => {
    res.status(204).end();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, now: Date.now() });
  });

  app.get("/api/price-to-beat", async (req, res) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug : "";
    const symbolQ = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
    if (!slug) return res.status(400).json({ error: "missing slug", priceToBeat: null });
    try {
      const ctx = await fetchGammaStrikeContext(cfg.gammaBaseUrl, slug);
      const sym = (symbolQ || inferSymbolFromSlug(slug) || "").toUpperCase();
      const fromBuf =
        sym && ctx.startTs > 0 ? strikeFromChainlinkBuffer(sym, ctx.startTs) : null;
      const priceToBeat = ctx.metadataStrike ?? fromBuf;
      res.json({ priceToBeat });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "failed",
        priceToBeat: null,
      });
    }
  });

  app.get("/api/stream-config", (_req, res) => {
    const hasManualClob = Boolean(
      cfg.manualClobWindowSlug && cfg.manualUpTokenId && cfg.manualDownTokenId
    );
    res.json({
      defaultWindowSlug: hasManualClob ? cfg.manualClobWindowSlug : "",
      hasManualClob,
    });
  });

  app.get("/api/windows", (req, res) => {
    const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : undefined;
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
    res.json(db.getLatestWindows(timeframe, symbol));
  });

  app.get("/api/windows/:slug/series", (req, res) => {
    const side = typeof req.query.side === "string" ? req.query.side : undefined;
    res.json(db.getSeries(req.params.slug, side));
  });

  app.get("/api/screenshots", (req, res) => {
    const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : undefined;
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
    res.json(db.listScreenshots({ timeframe, symbol }));
  });

  app.get("/api/screenshots/:id/file", (req, res) => {
    const list = db.listScreenshots({}) as Array<{ id: number; file_path: string }>;
    const row = list.find((x) => String(x.id) === req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    return res.sendFile(path.resolve(row.file_path));
  });

  app.use("/assets/screenshots", express.static(cfg.screenshotsDir));
  return app;
}
