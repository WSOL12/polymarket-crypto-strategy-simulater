export type WindowRow = {
  window_slug: string;
  timeframe: string;
  symbol: string;
  start_ts: number;
  end_ts: number;
};

export type PointRow = { side: "Up" | "Down"; t: number; p: number };

export type BookLevel = { price: number; size: number };

export type SideClobSnapshot = {
  orderbook: { bids: BookLevel[]; asks: BookLevel[]; t: number } | null;
  bestBidAsk: {
    bestBid: number;
    bestAsk: number;
    spread?: number;
    t: number;
  } | null;
};

export type ClobSnapshotMsg = {
  type: "clob_snapshot";
  up: SideClobSnapshot;
  down: SideClobSnapshot;
};

export type StreamConfig = {
  defaultWindowSlug: string;
  hasManualClob: boolean;
};

export type ScreenshotRow = {
  id: number;
  window_slug: string;
  timeframe: string;
  symbol: string;
  file_path: string;
  format: string;
  created_at: number;
};

async function j<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  /** Official metadata and/or backend Chainlink tick buffer for window open (slug + symbol). */
  priceToBeat: (slug: string, symbol?: string) =>
    j<{ priceToBeat: number | null }>(
      `/api/price-to-beat?${new URLSearchParams({
        slug,
        ...(symbol ? { symbol } : {}),
      })}`
    ),
  windows: (timeframe?: string, symbol?: string) =>
    j<WindowRow[]>(
      `/api/windows?${new URLSearchParams({
        ...(timeframe ? { timeframe } : {}),
        ...(symbol ? { symbol } : {}),
      })}`
    ),
  series: (windowSlug: string, side?: string) =>
    j<PointRow[]>(
      `/api/windows/${windowSlug}/series?${new URLSearchParams(side ? { side } : {})}`
    ),
  screenshots: (timeframe?: string, symbol?: string) =>
    j<ScreenshotRow[]>(
      `/api/screenshots?${new URLSearchParams({
        ...(timeframe ? { timeframe } : {}),
        ...(symbol ? { symbol } : {}),
      })}`
    ),
  streamConfig: () => j<StreamConfig>("/api/stream-config"),
};
