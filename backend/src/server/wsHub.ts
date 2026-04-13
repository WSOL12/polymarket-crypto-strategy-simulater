import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
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
  /** `SYMBOL:timeframe` — used to route CLOB snapshots (multi-stream). */
  subscribedKey?: string;
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
  for (const client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) client.send(out);
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

type SideSnap = {
  orderbook: { bids: BookLevel[]; asks: BookLevel[]; t: number } | null;
  bestBidAsk: {
    bestBid: number;
    bestAsk: number;
    spread?: number;
    t: number;
  } | null;
};

type ClobStreamEntry = {
  clob: ClobMarketClient;
  snap: { up: SideSnap; down: SideSnap };
  activeTrackedWindow: TrackedWindow | null;
  lastWsMidRecordAt: { Up: number; Down: number };
  clobUpTokenId: string;
  clobDownTokenId: string;
};

function streamKeyForClient(st: ClientState, fallbackSymbol: string): string {
  const sym = (st.symbol ?? fallbackSymbol).toUpperCase();
  const tf = st.timeframe ?? "15m";
  return `${sym}:${tf}`;
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

  /** One CLOB WS + snap per `BTC:5m` / `BTC:15m` / … so browsers on different horizons do not stomp each other. */
  const clobStreams = new Map<string, ClobStreamEntry>();
  /** Which sockets listen to each stream (Set avoids double-count if the same tab re-sends subscribe). */
  const clobSubscribers = new Map<string, Set<WebSocket>>();
  const clobStreamPromises = new Map<string, Promise<ClobStreamEntry | null>>();

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

  const stopAllClobStreams = () => {
    for (const e of clobStreams.values()) {
      e.clob.stop();
    }
    clobStreams.clear();
    clobSubscribers.clear();
    clobStreamPromises.clear();
  };

  const stopRtdsIfIdle = () => {
    if (clients.size > 0) return;
    rtds?.stop();
    rtds = null;
    rtdsSymbol = null;
    stopAllClobStreams();
  };

  const detachClientFromStream = (client: WebSocket, streamKey: string) => {
    const subs = clobSubscribers.get(streamKey);
    if (!subs) return;
    subs.delete(client);
    if (subs.size === 0) {
      clobSubscribers.delete(streamKey);
      clobStreams.get(streamKey)?.clob.stop();
      clobStreams.delete(streamKey);
    }
  };

  const pushClobSnapshotToClient = (client: WebSocket, streamKey: string) => {
    const entry = clobStreams.get(streamKey);
    if (!entry || client.readyState !== WebSocket.OPEN) return;
    client.send(
      JSON.stringify({
        type: "clob_snapshot",
        up: entry.snap.up,
        down: entry.snap.down,
      })
    );
  };

  const broadcastClobSnapshot = (streamKey: string) => {
    const entry = clobStreams.get(streamKey);
    if (!entry) return;
    const payload = JSON.stringify({
      type: "clob_snapshot",
      up: entry.snap.up,
      down: entry.snap.down,
    });
    for (const [client, st] of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (st.subscribedKey !== streamKey) continue;
      client.send(payload);
    }
  };

  const makeClobHandler =
    (streamKey: string) =>
    (ev: ClobMarketEvent): void => {
      const entry = clobStreams.get(streamKey);
      if (!entry) return;
      const upId = entry.clobUpTokenId;
      const downId = entry.clobDownTokenId;
      if (!upId || !downId) return;
      const { snap } = entry;

      if (ev.kind === "book") {
        const target = ev.assetId === upId ? snap.up : ev.assetId === downId ? snap.down : null;
        if (!target) return;
        target.orderbook = { bids: ev.bids, asks: ev.asks, t: ev.timestamp };
        broadcastClobSnapshot(streamKey);
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
        broadcastClobSnapshot(streamKey);

        const w = entry.activeTrackedWindow;
        if (w && ev.assetId) {
          const side: "Up" | "Down" | null =
            ev.assetId === upId ? "Up" : ev.assetId === downId ? "Down" : null;
          if (side) {
            const now = Date.now();
            if (now - entry.lastWsMidRecordAt[side] >= WS_MID_RECORD_MIN_MS) {
              const mid = (ev.bestBid + ev.bestAsk) / 2;
              if (Number.isFinite(mid) && mid >= 0 && mid <= 1) {
                entry.lastWsMidRecordAt[side] = now;
                const rawT = ev.timestamp;
                const tSec =
                  rawT > 1e12 ? Math.floor(rawT / 1000) : Math.floor(rawT);
                const pe: PriceEvent = {
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
                db.insertPriceEvent(pe);
              }
            }
          }
        }
      }
    };

  const emptySnap = (): { up: SideSnap; down: SideSnap } => ({
    up: { orderbook: null, bestBidAsk: null },
    down: { orderbook: null, bestBidAsk: null },
  });

  /** Create CLOB connection for this key if missing (shared by all subscribers). */
  const getOrCreateClobStream = async (
    streamKey: string,
    timeframe: string,
    symbol: string
  ): Promise<ClobStreamEntry | null> => {
    const existing = clobStreams.get(streamKey);
    if (existing) return existing;

    let p = clobStreamPromises.get(streamKey);
    if (!p) {
      p = (async (): Promise<ClobStreamEntry | null> => {
        const { tracked, tokens } = await fetchTrackedWindowAndTokens(
          cfg,
          timeframe,
          symbol
        );
        if (!tokens) return null;
        if (clobStreams.has(streamKey)) {
          return clobStreams.get(streamKey)!;
        }
        if (tracked) {
          db.upsertWindow(tracked);
        }
        const snap = emptySnap();
        const entry: ClobStreamEntry = {
          clob: new ClobMarketClient(
            [tokens.up, tokens.down],
            makeClobHandler(streamKey)
          ),
          snap,
          activeTrackedWindow: tracked,
          lastWsMidRecordAt: { Up: 0, Down: 0 },
          clobUpTokenId: tokens.up,
          clobDownTokenId: tokens.down,
        };
        clobStreams.set(streamKey, entry);
        entry.clob.start();
        return entry;
      })().finally(() => {
        clobStreamPromises.delete(streamKey);
      });
      clobStreamPromises.set(streamKey, p);
    }

    return p;
  };

  const sendClobStreamStatus = async (
    client: WebSocket,
    timeframe: string,
    symbol: string
  ) => {
    const pair = await resolveUpDownTokens(cfg, timeframe, symbol);
    let priceToBeat: number | null = null;
    if (pair?.windowSlug) {
      const ctx = await fetchGammaStrikeContext(cfg.gammaBaseUrl, pair.windowSlug);
      priceToBeat = ctx.metadataStrike;
      const openSec =
        ctx.startTs > 0 ? ctx.startTs : pair.startTs != null && pair.startTs > 0 ? pair.startTs : 0;
      if (priceToBeat == null && openSec > 0) {
        priceToBeat = strikeFromChainlinkBuffer(symbol, openSec);
      }
    } else if (pair?.startTs != null && pair.startTs > 0) {
      priceToBeat = strikeFromChainlinkBuffer(symbol, pair.startTs);
    }
    if (client.readyState !== WebSocket.OPEN) return;
    const windowPayload =
      pair && pair.startTs != null && pair.endTs != null
        ? {
            startTs: pair.startTs,
            endTs: pair.endTs,
            windowSlug: pair.windowSlug,
            ...(priceToBeat != null ? { priceToBeat } : {}),
          }
        : null;
    client.send(
      JSON.stringify({
        type: "stream_status",
        updownClob: pair ? "active" : "no_tokens",
        window: windowPayload,
      })
    );
  };

  wss.on("connection", (ws) => {
    clients.set(ws, {});
    if (ws.readyState === WebSocket.OPEN) {
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
        const tf = state.timeframe ?? "15m";
        const sym = state.symbol ?? cfg.symbol;
        const newKey = streamKeyForClient(state, cfg.symbol);
        const oldKey = state.subscribedKey;
        if (oldKey && oldKey !== newKey) {
          detachClientFromStream(ws, oldKey);
        }
        state.subscribedKey = newKey;
        clients.set(ws, state);

        let subs = clobSubscribers.get(newKey);
        if (subs?.has(ws)) {
          ensureRtds(sym);
          void sendClobStreamStatus(ws, tf, sym).then(() => pushClobSnapshotToClient(ws, newKey));
          return;
        }
        if (!subs) {
          subs = new Set();
          clobSubscribers.set(newKey, subs);
        }
        subs.add(ws);

        ensureRtds(sym);

        if (clobStreams.has(newKey)) {
          void sendClobStreamStatus(ws, tf, sym).then(() => pushClobSnapshotToClient(ws, newKey));
          return;
        }

        void getOrCreateClobStream(newKey, tf, sym)
          .then((entry) => {
            if (!entry) {
              subs?.delete(ws);
              if (subs && subs.size === 0) {
                clobSubscribers.delete(newKey);
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "stream_status",
                    updownClob: "no_tokens",
                    window: null,
                  })
                );
              }
              return;
            }
            return sendClobStreamStatus(ws, tf, sym).then(() =>
              pushClobSnapshotToClient(ws, newKey)
            );
          })
          .catch((err) => {
            subs?.delete(ws);
            if (subs && subs.size === 0) {
              clobSubscribers.delete(newKey);
            }
            if (ws.readyState === WebSocket.OPEN) {
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
      if (msg.action === "ping" && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    });
    ws.on("close", () => {
      const st = clients.get(ws);
      if (st?.subscribedKey) detachClientFromStream(ws, st.subscribedKey);
      clients.delete(ws);
      stopRtdsIfIdle();
    });
  });

  return () => {
    rtds?.stop();
    rtds = null;
    rtdsSymbol = null;
    stopAllClobStreams();
    wss.close();
  };
}
