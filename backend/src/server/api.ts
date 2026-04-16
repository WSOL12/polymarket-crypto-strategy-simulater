import express from "express";
import cors from "cors";
import path from "node:path";
import type { AppDb } from "./db.js";
import type { ServerConfig } from "./config.js";
import { strikeFromChainlinkBuffer } from "./chainlinkBuffer.js";
import { fetchGammaStrikeContext } from "./services.js";
import { formatWindowRangeEt } from "../shared/formatEtWindow.js";
import { executeSimulation, type SideRule } from "./simEngine.js";

/** sql.js / SQLite sometimes varies column name casing; avoid undefined → JSON omits key. */
function rowStr(row: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = row[n];
    if (v != null && String(v) !== "") return String(v);
  }
  for (const k of Object.keys(row)) {
    const kl = k.toLowerCase();
    for (const n of names) {
      if (kl === n.toLowerCase()) {
        const v = row[k];
        if (v != null && String(v) !== "") return String(v);
      }
    }
  }
  return "";
}

function rowNum(row: Record<string, unknown>, name: string): number | null {
  const tryVal = (v: unknown): number | null => {
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "bigint") return Number(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const direct = tryVal(row[name]);
  if (direct != null) return direct;
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === name.toLowerCase()) return tryVal(row[k]);
  }
  return null;
}

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
    const rows = db.listScreenshots({ timeframe, symbol }) as Record<string, unknown>[];
    res.json(
      rows.map((raw) => {
        const r = raw;
        const id = rowNum(r, "id") ?? 0;
        const windowSlug = rowStr(r, "window_slug");
        const filePath = rowStr(r, "file_path");
        const file_name = filePath ? path.basename(filePath) : "";
        const stem = file_name.replace(/\.(png|jpg|jpeg)$/i, "");

        const st = rowNum(r, "start_ts");
        const et = rowNum(r, "end_ts");
        let labelEt =
          st != null && et != null && et > st ? formatWindowRangeEt(st, et) : "";
        if (!labelEt) labelEt = stem;
        if (!labelEt) labelEt = windowSlug;
        if (!labelEt) labelEt = `screenshot-${id || "?"}`;

        return {
          id,
          window_slug: windowSlug,
          timeframe: rowStr(r, "timeframe"),
          symbol: rowStr(r, "symbol"),
          file_path: filePath,
          file_name: file_name || "file.png",
          format: rowStr(r, "format"),
          created_at: rowNum(r, "created_at") ?? 0,
          label_et: labelEt,
        };
      })
    );
  });

  app.get("/api/screenshots/:id/file", (req, res) => {
    const list = db.listScreenshots({}) as Array<{ id: number; file_path: string }>;
    const row = list.find((x) => String(x.id) === req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    return res.sendFile(path.resolve(row.file_path));
  });

  app.use("/assets/screenshots", express.static(cfg.screenshotsDir));

  app.post("/api/sim/run", async (req, res) => {
    try {
      const b = req.body as Record<string, unknown>;
      const windowSlug = typeof b.windowSlug === "string" ? b.windowSlug.trim() : "";
      const timeframe = typeof b.timeframe === "string" ? b.timeframe : "";
      const symbol = typeof b.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
      const laneIndex = typeof b.laneIndex === "number" ? b.laneIndex : Number(b.laneIndex);
      const threshold = typeof b.threshold === "number" ? b.threshold : Number(b.threshold);
      const shares = typeof b.shares === "number" ? b.shares : Number(b.shares);
      const entryDelaySec =
        typeof b.entryDelaySec === "number" ? b.entryDelaySec : Number(b.entryDelaySec ?? 0);
      const tokenDiffLimitP =
        b.tokenDiffLimitP == null
          ? null
          : typeof b.tokenDiffLimitP === "number"
            ? b.tokenDiffLimitP
            : Number(b.tokenDiffLimitP);
      const sideRule = (typeof b.sideRule === "string" ? b.sideRule : "both").toLowerCase() as SideRule;
      if (!windowSlug) return res.status(400).json({ error: "windowSlug required" });
      if (!timeframe || !symbol) return res.status(400).json({ error: "timeframe and symbol required" });
      if (!Number.isFinite(laneIndex) || laneIndex < 0 || laneIndex > 7) {
        return res.status(400).json({ error: "laneIndex must be 0–7" });
      }
      const out = await executeSimulation(db, {
        windowSlug,
        timeframe,
        symbol,
        laneIndex,
        threshold,
        shares,
        entryDelaySec,
        tokenDiffLimitP: tokenDiffLimitP != null && Number.isFinite(tokenDiffLimitP) ? tokenDiffLimitP : null,
        sideRule: sideRule === "up" || sideRule === "down" || sideRule === "both" ? sideRule : "both",
      });
      if (out.status === "error") return res.status(400).json(out);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/sim/run-pending", async (req, res) => {
    try {
      const b = req.body as Record<string, unknown>;
      const timeframe = typeof b.timeframe === "string" ? b.timeframe : "";
      const symbol = typeof b.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
      const laneIndex = typeof b.laneIndex === "number" ? b.laneIndex : Number(b.laneIndex);
      const threshold = typeof b.threshold === "number" ? b.threshold : Number(b.threshold);
      const shares = typeof b.shares === "number" ? b.shares : Number(b.shares);
      const entryDelaySec =
        typeof b.entryDelaySec === "number" ? b.entryDelaySec : Number(b.entryDelaySec ?? 0);
      const tokenDiffLimitP =
        b.tokenDiffLimitP == null
          ? null
          : typeof b.tokenDiffLimitP === "number"
            ? b.tokenDiffLimitP
            : Number(b.tokenDiffLimitP);
      const sideRule = (typeof b.sideRule === "string" ? b.sideRule : "both").toLowerCase() as SideRule;
      const settleAfterSec =
        typeof b.settleAfterSec === "number" ? b.settleAfterSec : Number(b.settleAfterSec ?? 5);
      const maxRuns = typeof b.maxRuns === "number" ? b.maxRuns : Number(b.maxRuns ?? 8);
      const fromOldest = b.fromOldest === true;
      if (!timeframe || !symbol) return res.status(400).json({ error: "timeframe and symbol required" });
      if (!Number.isFinite(laneIndex) || laneIndex < 0 || laneIndex > 7) {
        return res.status(400).json({ error: "laneIndex must be 0–7" });
      }
      const after = Number.isFinite(settleAfterSec) && settleAfterSec >= 0 ? settleAfterSec : 5;
      const cap = Number.isFinite(maxRuns) && maxRuns >= 1 ? Math.floor(Math.min(5000, maxRuns)) : Infinity;
      const windows = db.listWindows({
        timeframe,
        symbol,
        order: fromOldest ? "asc" : "desc",
      }) as Record<string, unknown>[];
      const now = Math.floor(Date.now() / 1000);
      const results: unknown[] = [];
      let ran = 0;
      for (const w of windows) {
        if (results.length >= cap) break;
        const slug = rowStr(w, "window_slug");
        const endTs = rowNum(w, "end_ts");
        if (!slug || endTs == null || endTs > now - after) continue;
        if (db.hasSimResult(slug, laneIndex)) continue;
        const out = await executeSimulation(db, {
          windowSlug: slug,
          timeframe: rowStr(w, "timeframe") || timeframe,
          symbol: rowStr(w, "symbol") || symbol,
          laneIndex,
          threshold,
          shares,
          entryDelaySec,
          tokenDiffLimitP:
            tokenDiffLimitP != null && Number.isFinite(tokenDiffLimitP) ? tokenDiffLimitP : null,
          sideRule: sideRule === "up" || sideRule === "down" || sideRule === "both" ? sideRule : "both",
        });
        if (out.status !== "error") ran += 1;
        results.push(out);
      }
      res.json({ ran, results });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/sim/history", (req, res) => {
    const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : undefined;
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const rows = db.listSimResults({ timeframe, symbol, limit }) as Record<string, unknown>[];
    res.json(
      rows.map((r) => ({
        id: rowNum(r, "id") ?? 0,
        created_at: rowNum(r, "created_at") ?? 0,
        window_slug: rowStr(r, "window_slug"),
        timeframe: rowStr(r, "timeframe"),
        symbol: rowStr(r, "symbol"),
        lane_index: rowNum(r, "lane_index") ?? 0,
        threshold_p: rowNum(r, "threshold_p"),
        shares: rowNum(r, "shares"),
        side_rule: rowStr(r, "side_rule"),
        timer_sec: rowNum(r, "timer_sec"),
        token_diff_limit_p: rowNum(r, "token_diff_limit_p"),
        entry_side: rowStr(r, "entry_side") || null,
        entry_price: rowNum(r, "entry_price"),
        entry_t: rowNum(r, "entry_t"),
        strike_price: rowNum(r, "strike_price"),
        final_price: rowNum(r, "final_price"),
        last_up_p: rowNum(r, "last_up_p"),
        last_down_p: rowNum(r, "last_down_p"),
        outcome_won: rowNum(r, "outcome_won"),
        pnl_usdc: rowNum(r, "pnl_usdc"),
        status: rowStr(r, "status"),
        error: rowStr(r, "error") || null,
      }))
    );
  });

  app.delete("/api/sim/history/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    if (!db.deleteSimResult(id)) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  app.delete("/api/sim/history", (req, res) => {
    if (req.query.confirm !== "yes") {
      return res.status(400).json({
        error: "Refused: delete all requires query confirm=yes",
      });
    }
    const deleted = db.deleteAllSimResults();
    res.json({ ok: true, deleted });
  });

  return app;
}
