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
  /** Eastern Time range when window row joins; else file stem / slug */
  label_et: string;
  /** Saved image file name (e.g. BTC-5m-2026-04-07_0400-0405-ET.png) */
  file_name: string;
  timeframe: string;
  symbol: string;
  file_path: string;
  format: string;
  created_at: number;
};

/** Avoid opaque `Unexpected token '<'` when the server returns HTML (SPA fallback, 502 page, etc.). */
async function readJsonBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  const start = text.trimStart();
  if (start.startsWith("<") || start.startsWith("<!")) {
    throw new Error(
      "API returned HTML instead of JSON. Start the backend on port 3000 (default), keep `npm run dev` for the frontend so /api is proxied, or use `vite preview` only after adding the same proxy (already in vite.config). If PORT in .env is not 3000, set Vite proxy targets to match."
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`API response was not JSON (first 120 chars): ${text.slice(0, 120)}`);
  }
}

async function j<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await readJsonBody<T & { error?: string }>(res);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

async function jPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJsonBody<T & { error?: string }>(res);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

async function jDelete<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  const data = await readJsonBody<T & { error?: string }>(res);
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export type SimSideRule = "up" | "down" | "both";

export type SimRunRequest = {
  windowSlug: string;
  timeframe: string;
  symbol: string;
  laneIndex: number;
  threshold: number;
  shares: number;
  sideRule: SimSideRule;
  entryDelaySec: number;
};

export type SimRunResponse = {
  id: number;
  status: "settled" | "no_cross" | "inconclusive" | "pending_resolution" | "error";
  windowSlug: string;
  timeframe: string;
  symbol: string;
  laneIndex: number;
  threshold: number;
  shares: number;
  sideRule: SimSideRule;
  entryDelaySec: number;
  entrySide: "Up" | "Down" | null;
  entryPrice: number | null;
  entryT: number | null;
  lastUpP: number | null;
  lastDownP: number | null;
  winningOutcome: "Up" | "Down" | null;
  outcomeWon: boolean | null;
  pnlUsdc: number | null;
  error: string | null;
};

export type SimHistoryRow = {
  id: number;
  created_at: number;
  window_slug: string;
  timeframe: string;
  symbol: string;
  lane_index: number;
  threshold_p: number | null;
  shares: number | null;
  side_rule: string;
  timer_sec: number | null;
  entry_side: string | null;
  entry_price: number | null;
  entry_t: number | null;
  strike_price: number | null;
  final_price: number | null;
  last_up_p: number | null;
  last_down_p: number | null;
  outcome_won: number | null;
  pnl_usdc: number | null;
  status: string;
  error: string | null;
};

export type SimRunPendingResponse = { ran: number; results: SimRunResponse[] };

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

  simRun: (body: SimRunRequest) => jPost<SimRunResponse>("/api/sim/run", body),

  simRunPending: (body: {
    timeframe: string;
    symbol: string;
    laneIndex: number;
    threshold: number;
    shares: number;
    sideRule: SimSideRule;
    entryDelaySec?: number;
    settleAfterSec?: number;
    maxRuns?: number;
  }) => jPost<SimRunPendingResponse>("/api/sim/run-pending", body),

  simHistory: (timeframe?: string, symbol?: string, limit?: number) =>
    j<SimHistoryRow[]>(
      `/api/sim/history?${new URLSearchParams({
        ...(timeframe ? { timeframe } : {}),
        ...(symbol ? { symbol } : {}),
        ...(limit != null ? { limit: String(limit) } : {}),
      })}`
    ),

  simDelete: (id: number) => jDelete<{ ok: boolean }>(`/api/sim/history/${id}`),

  simClearAll: () => jDelete<{ ok: boolean; deleted: number }>("/api/sim/history?confirm=yes"),
};
