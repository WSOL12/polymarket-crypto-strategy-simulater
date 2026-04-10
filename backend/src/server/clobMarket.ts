import WebSocket from "ws";

const CLOB_MARKET_WSS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const MAX_LEVELS = 5;

export type BookLevel = { price: number; size: number };

export type ClobBookEvent = {
  kind: "book";
  assetId: string;
  market: string;
  bids: BookLevel[];
  asks: BookLevel[];
  timestamp: number;
};

export type ClobBestBidAskEvent = {
  kind: "best_bid_ask";
  assetId: string;
  market: string;
  bestBid: number;
  bestAsk: number;
  spread?: number;
  timestamp: number;
};

export type ClobMarketEvent = ClobBookEvent | ClobBestBidAskEvent;

function parsePrice(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseSize(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseLevel(raw: unknown): BookLevel | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const price = parsePrice(o.price);
  const size = parseSize(o.size);
  if (price === undefined || size === undefined) return null;
  return { price, size };
}

/** Best bids first (highest price), best asks first (lowest price); cap at MAX_LEVELS. */
function normalizeBookLevels(
  bidsRaw: unknown,
  asksRaw: unknown
): { bids: BookLevel[]; asks: BookLevel[] } {
  const bids = (Array.isArray(bidsRaw) ? bidsRaw : [])
    .map(parseLevel)
    .filter((x): x is BookLevel => x !== null)
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_LEVELS);
  const asks = (Array.isArray(asksRaw) ? asksRaw : [])
    .map(parseLevel)
    .filter((x): x is BookLevel => x !== null)
    .sort((a, b) => a.price - b.price)
    .slice(0, MAX_LEVELS);
  return { bids, asks };
}

export class ClobMarketClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly assetIds: string[],
    private readonly onEvent: (ev: ClobMarketEvent) => void
  ) {}

  start() {
    if (this.ws || this.assetIds.length === 0) return;
    this.ws = new WebSocket(CLOB_MARKET_WSS);
    this.ws.on("open", () => {
      this.ws?.send(
        JSON.stringify({
          assets_ids: this.assetIds,
          type: "market",
          custom_feature_enabled: true,
        })
      );
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
      }, 10000);
    });
    this.ws.on("message", (buf) => {
      this.handleMessage(String(buf));
    });
    this.ws.on("close", () => this.cleanup());
    this.ws.on("error", () => this.cleanup());
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private cleanup() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws = null;
  }

  private handleMessage(raw: string) {
    if (raw === "PONG" || raw === '"PONG"') return;
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      const eventType = String(msg.event_type ?? "");
      const ts = Number(msg.timestamp ?? Date.now());
      const t = Number.isFinite(ts) ? ts : Date.now();

      if (eventType === "book") {
        const assetId = String(msg.asset_id ?? "");
        const market = String(msg.market ?? "");
        if (!assetId) return;
        const { bids, asks } = normalizeBookLevels(msg.bids, msg.asks);
        this.onEvent({
          kind: "book",
          assetId,
          market,
          bids,
          asks,
          timestamp: t,
        });
        return;
      }

      if (eventType === "best_bid_ask") {
        const assetId = String(msg.asset_id ?? "");
        const market = String(msg.market ?? "");
        const bestBid = parsePrice(msg.best_bid);
        const bestAsk = parsePrice(msg.best_ask);
        if (!assetId || bestBid === undefined || bestAsk === undefined) return;
        const spread =
          msg.spread !== undefined ? parsePrice(msg.spread) : bestAsk - bestBid;
        this.onEvent({
          kind: "best_bid_ask",
          assetId,
          market,
          bestBid,
          bestAsk,
          ...(spread !== undefined && Number.isFinite(spread) ? { spread } : {}),
          timestamp: t,
        });
      }
    } catch {
      // ignore non-json frames
    }
  }
}
