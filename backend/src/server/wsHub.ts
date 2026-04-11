import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerConfig } from "./config.js";
import type { AppDb } from "./db.js";
import type { PriceEvent, TimeframeKey, TrackedWindow } from "../shared/types.js";
import { RtdsClient, type RtdsMessage } from "./rtds.js";
import { ClobMarketClient, type BookLevel, type ClobMarketEvent } from "./clobMarket.js";
import { recordChainlinkTick, strikeFromChainlinkBuffer } from "./chainlinkBuffer.js";
import {
  fetchCurrentWindowBySeriesId,
  fetchGammaStrikeContext,
  fetchSeriesId,
} from "./services.js";

type ClientState = {
  timeframe?: string;
  symbol?: string;
  activeWindowSlug?: string;
};

type UpDownTokens = {
  up: string;
  down: string;
  startTs: number | null;
  endTs: number | null;
  windowSlug: string | null;
};

/** Min interval between persisted mid samples per side (keeps DB + end-of-window chart size reasonable). */
const WS_MID_RECORD_MIN_MS = 1500;

async function resolveUpDownTokens(
  cfg: ServerConfig,
  timeframe: string,
  symbol: string
): Promise<UpDownTokens | null> {
  const sym = symbol.toUpperCase();
  const tf = timeframe === "5m" || timeframe === "15m" || timeframe === "1h" ? timeframe : "15m";
  const seriesSlug =
    tf === "1h"
      ? `${sym.toLowerCase()}-up-or-down-hourly`
      : `${sym.toLowerCase()}-up-or-down-${tf}`;
  const seriesId = await fetchSeriesId(cfg.gammaBaseUrl, seriesSlug);
  if (seriesId) {
    const w = await fetchCurrentWindowBySeriesId({
      gammaBaseUrl: cfg.gammaBaseUrl,
      seriesId,
      timeframe: tf as any,
      symbol: sym,
    });
    if (w?.upTokenId && w?.downTokenId) {
      return {
        up: w.upTokenId,
        down: w.downTokenId,
        startTs: w.startTs > 0 ? w.startTs : null,
        endTs: w.endTs > 0 ? w.endTs : null,
        windowSlug: w.windowSlug || null,
      };
    }
  }
  if (cfg.manualUpTokenId && cfg.manualDownTokenId) {
    return {
      up: cfg.manualUpTokenId,
      down: cfg.manualDownTokenId,
      startTs: null,
      endTs: null,
      windowSlug: null,
    };
  }
  return null;
}

/** Full window row for DB + same token IDs used by CLOB (Gamma path). */
async function fetchTrackedWindowAndTokens(
  cfg: ServerConfig,
  timeframe: string,
  symbol: string
): Promise<{ tracked: TrackedWindow | null; tokens: UpDownTokens | null }> {
  const sym = symbol.toUpperCase();
  const tf: TimeframeKey =
    timeframe === "5m" || timeframe === "15m" || timeframe === "1h" ? timeframe : "15m";
  const seriesSlug =
    tf === "1h"
      ? `${sym.toLowerCase()}-up-or-down-hourly`
      : `${sym.toLowerCase()}-up-or-down-${tf}`;
  const seriesId = await fetchSeriesId(cfg.gammaBaseUrl, seriesSlug);
  if (seriesId) {
    const tracked = await fetchCurrentWindowBySeriesId({
      gammaBaseUrl: cfg.gammaBaseUrl,
      seriesId,
      timeframe: tf,
      symbol: sym,
    });
    if (tracked?.upTokenId && tracked?.downTokenId) {
      return {
        tracked,
        tokens: {
          up: tracked.upTokenId,
          down: tracked.downTokenId,
          startTs: tracked.startTs,
          endTs: tracked.endTs,
          windowSlug: tracked.windowSlug,
        },
      };
    }
  }
  const manual = await resolveUpDownTokens(cfg, timeframe, symbol);
  if (!manual) return { tracked: null, tokens: null };
  return { tracked: null, tokens: manual };
}

function broadcastRtds(clients: Map<WebSocket, ClientState>, msg: RtdsMessage) {
  const out = JSON.stringify({
    type: "rtds",
    topic: msg.topic,
    eventType: msg.type,
    timestamp: msg.timestamp,
    payload: msg.payload,
  });
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(out);
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function attachRealtimeWs(server: HttpServer, db: AppDb, cfg: ServerConfig) {
  /** Bind with `server` + `path` so `ws` owns the upgrade (manual handleUpgrade + Express often drops the socket). */
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    perMessageDeflate: false,
  });
  const clients = new Map<WebSocket, ClientState>();
  let rtds: RtdsClient | null = null;
  let rtdsSymbol: string | null = null;
  let clob: ClobMarketClient | null = null;
  let clobKey: string | null = null;
  let clobUpTokenId: string | null = null;
  let clobDownTokenId: string | null = null;

  const ensureRtds = (symbol: string) => {
    const sym = symbol || cfg.symbol;
    if (!sym) return;
    if (rtds && rtdsSymbol === sym) return;
    rtds?.stop();
    rtdsSymbol = sym;
    rtds = new RtdsClient({
      url: cfg.rtdsWsUrl,
      symbol: sym,
      onMessage: (msg) => {
        const p = msg.payload;
        const v = p?.value;
        const tsRaw = p?.timestamp ?? msg.timestamp;
        const ts = typeof tsRaw === "number" ? tsRaw : Number(tsRaw);
        if (typeof v === "number" && Number.isFinite(v) && Number.isFinite(ts)) {
          recordChainlinkTick(sym, ts, v);
        }
        broadcastRtds(clients, msg);
      },
    });
    rtds.start();
  };

  const stopRtdsIfIdle = () => {
    if (clients.size > 0) return;
    rtds?.stop();
    rtds = null;
    rtdsSymbol = null;
    clob?.stop();
    clob = null;
    clobKey = null;
    clobUpTokenId = null;
    clobDownTokenId = null;
    activeTrackedWindow = null;
  };

  type SideSnap = {
    orderbook: { bids: BookLevel[]; asks: BookLevel[]; t: number } | null;
    bestBidAsk: {
      bestBid: number;
      bestAsk: number;
      spread?: number;
      t: number;
    } | null;
  };
  let snap: { up: SideSnap; down: SideSnap } = {
    up: { orderbook: null, bestBidAsk: null },
    down: { orderbook: null, bestBidAsk: null },
  };

  /** Gamma window row while CLOB stream is active; used to append mid price samples for end-of-window chart. */
  let activeTrackedWindow: TrackedWindow | null = null;
  const lastWsMidRecordAt: { Up: number; Down: number } = { Up: 0, Down: 0 };

  const broadcastClobSnapshot = () => {
    const payload = JSON.stringify({
      type: "clob_snapshot",
      up: snap.up,
      down: snap.down,
    });
    for (const ws of clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  const handleClobEvent = (ev: ClobMarketEvent) => {
    const upId = clobUpTokenId;
    const downId = clobDownTokenId;
    if (!upId || !downId) return;

    if (ev.kind === "book") {
      const target = ev.assetId === upId ? snap.up : ev.assetId === downId ? snap.down : null;
      if (!target) return;
      target.orderbook = { bids: ev.bids, asks: ev.asks, t: ev.timestamp };
      broadcastClobSnapshot();
      return;
    }
    if (ev.kind === "best_bid_ask") {
      const target = ev.assetId === upId ? snap.up : ev.assetId === downId ? snap.down : null;
      if (!target) return;
      target.bestBidAsk = {
        bestBid: ev.bestBid,
        bestAsk: ev.bestAsk,
        ...(ev.spread !== undefined ? { spread: ev.spread } : {}),
        t: ev.timestamp,
      };
      broadcastClobSnapshot();

      const w = activeTrackedWindow;
      if (w && ev.assetId) {
        const side: "Up" | "Down" | null =
          ev.assetId === upId ? "Up" : ev.assetId === downId ? "Down" : null;
        if (side) {
          const now = Date.now();
          if (now - lastWsMidRecordAt[side] >= WS_MID_RECORD_MIN_MS) {
            const mid = (ev.bestBid + ev.bestAsk) / 2;
            if (Number.isFinite(mid) && mid >= 0 && mid <= 1) {
              lastWsMidRecordAt[side] = now;
              const rawT = ev.timestamp;
              const tSec =
                rawT > 1e12 ? Math.floor(rawT / 1000) : Math.floor(rawT);
              const evt: PriceEvent = {
                windowSlug: w.windowSlug,
                timeframe: w.timeframe,
                symbol: w.symbol,
                side,
                tokenId: ev.assetId,
                t: tSec,
                p: mid,
                source: "ws",
                sourceId: `mid-${rawT}-${ev.assetId}`,
              };
              db.insertPriceEvent(evt);
            }
          }
        }
      }
    }
  };

  const ensureClobForSymbolTimeframe = async (timeframe: string, symbol: string, key: string) => {
    if (clob && clobKey === key) return;
    const { tracked, tokens } = await fetchTrackedWindowAndTokens(cfg, timeframe, symbol);
    if (!tokens) return;

    clob?.stop();
    clobKey = key;
    clobUpTokenId = tokens.up;
    clobDownTokenId = tokens.down;
    activeTrackedWindow = tracked;
    lastWsMidRecordAt.Up = 0;
    lastWsMidRecordAt.Down = 0;
    if (tracked) {
      db.upsertWindow(tracked);
    }
    snap = {
      up: { orderbook: null, bestBidAsk: null },
      down: { orderbook: null, bestBidAsk: null },
    };
    clob = new ClobMarketClient([tokens.up, tokens.down], handleClobEvent);
    clob.start();
  };

  // Mid prices (best bid/ask midpoint) appended to SQLite for end-of-window PNG chart.

  wss.on("connection", (ws) => {
    clients.set(ws, {});
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: "connected",
          ts: Date.now(),
          hint: "send {action:'subscribe', timeframe, symbol}",
        })
      );
    }
    ws.on("message", (buf) => {
      const msg = safeParse(String(buf));
      if (!msg) return;
      if (msg.action === "subscribe") {
        const state = clients.get(ws) ?? {};
        if (typeof msg.timeframe === "string") state.timeframe = msg.timeframe;
        if (typeof msg.symbol === "string") state.symbol = msg.symbol;
        clients.set(ws, state);
        ensureRtds(state.symbol ?? cfg.symbol);
        const tf = state.timeframe ?? "15m";
        const sym = state.symbol ?? cfg.symbol;
        const clobStreamKey = `${sym}:${tf}`;
        void ensureClobForSymbolTimeframe(tf, sym, clobStreamKey)
          .then(async () => {
            const pair = await resolveUpDownTokens(cfg, tf, sym);
            let priceToBeat: number | null = null;
            if (pair?.windowSlug) {
              const ctx = await fetchGammaStrikeContext(cfg.gammaBaseUrl, pair.windowSlug);
              priceToBeat = ctx.metadataStrike;
              const openSec =
                ctx.startTs > 0 ? ctx.startTs : pair.startTs != null && pair.startTs > 0 ? pair.startTs : 0;
              if (priceToBeat == null && openSec > 0) {
                priceToBeat = strikeFromChainlinkBuffer(sym, openSec);
              }
            } else if (pair?.startTs != null && pair.startTs > 0) {
              priceToBeat = strikeFromChainlinkBuffer(sym, pair.startTs);
            }
            if (ws.readyState === ws.OPEN) {
              const windowPayload =
                pair && pair.startTs != null && pair.endTs != null
                  ? {
                      startTs: pair.startTs,
                      endTs: pair.endTs,
                      windowSlug: pair.windowSlug,
                      ...(priceToBeat != null ? { priceToBeat } : {}),
                    }
                  : null;
              ws.send(
                JSON.stringify({
                  type: "stream_status",
                  updownClob: pair ? "active" : "no_tokens",
                  window: windowPayload,
                })
              );
            }
          })
          .catch((err) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "stream_status",
                  updownClob: "error",
                  error: err instanceof Error ? err.message : String(err),
                  window: null,
                })
              );
            }
          });
      }
      if (msg.action === "ping" && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      stopRtdsIfIdle();
    });
  });

  return () => {
    rtds?.stop();
    rtds = null;
    rtdsSymbol = null;
    clob?.stop();
    clob = null;
    clobKey = null;
    clobUpTokenId = null;
    clobDownTokenId = null;
    wss.close();
  };
}
