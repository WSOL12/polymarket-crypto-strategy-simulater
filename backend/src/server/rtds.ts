import WebSocket from "ws";

const DEFAULT_RTDS_URL = "wss://ws-live-data.polymarket.com";

/**
 * Polymarket Up/Down markets resolve on **Chainlink** BTC/USD (etc.), not Binance.
 * RTDS topic `crypto_prices_chainlink` — slash-separated pairs per docs.
 * @see https://docs.polymarket.com/market-data/websocket/rtds
 */
export function symbolToChainlinkPair(symbol: string): string {
  const m: Record<string, string> = {
    BTC: "btc/usd",
    ETH: "eth/usd",
    SOL: "sol/usd",
    XRP: "xrp/usd",
  };
  return m[symbol.toUpperCase()] ?? "btc/usd";
}

export type RtdsMessage = {
  topic: string;
  type: string;
  timestamp?: number;
  payload?: {
    symbol?: string;
    value?: number;
    timestamp?: number;
  };
};

export type RtdsClientOptions = {
  url?: string;
  symbol: string;
  onMessage: (msg: RtdsMessage) => void;
  onStatus?: (s: "open" | "close" | "error") => void;
};

/**
 * Polymarket RTDS — **Chainlink** crypto prices (matches Up/Down resolution source).
 * @see https://docs.polymarket.com/market-data/websocket/rtds
 */
export class RtdsClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly url: string;
  /** e.g. `btc/usd` — must match `payload.symbol` from RTDS. */
  private readonly chainlinkPair: string;

  constructor(private readonly opts: RtdsClientOptions) {
    this.url = opts.url ?? DEFAULT_RTDS_URL;
    this.chainlinkPair = symbolToChainlinkPair(opts.symbol);
  }

  start() {
    if (this.ws) return;
    this.ws = new WebSocket(this.url);
    this.ws.on("open", () => {
      this.opts.onStatus?.("open");
      const subscribe = {
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: this.chainlinkPair }),
          },
        ],
      };
      this.ws?.send(JSON.stringify(subscribe));
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
      }, 5000);
    });
    this.ws.on("message", (data) => {
      const raw = String(data);
      if (raw === "PONG" || raw === '"PONG"') return;
      try {
        const msg = JSON.parse(raw) as RtdsMessage;
        if (!msg.topic) return;
        if (msg.topic !== "crypto_prices_chainlink") return;
        const payloadSymbol = String(msg.payload?.symbol ?? "").toLowerCase();
        if (payloadSymbol && payloadSymbol !== this.chainlinkPair.toLowerCase()) return;
        this.opts.onMessage(msg);
      } catch {
        // ignore
      }
    });
    this.ws.on("close", () => {
      this.opts.onStatus?.("close");
      this.cleanup();
    });
    this.ws.on("error", () => {
      this.opts.onStatus?.("error");
      this.cleanup();
    });
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
}
