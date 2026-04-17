import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ScreenshotRow,
  type SideClobSnapshot,
  type SimHistoryRow,
  type SimSideRule,
  type WindowRow,
} from "../api";
import { LiveChart } from "../components/LiveChart";
import { backendWebSocketUrl } from "../wsUrl";

type LaneConfig = {
  laneIndex: number;
  label: string;
  cents: number;
  timerSec: number;
  shares: number;
  sideRule: SimSideRule;
  tokenDiffLimitCents: number | null;
};

type SimulationMode = "db" | "live";

type LiveWindowState = { startTs: number; endTs: number; windowSlug: string | null };

type LivePendingRun = {
  id: number;
  laneIndex: number;
  threshold: number;
  shares: number;
  sideRule: SimSideRule;
  timerSec: number;
  tokenDiffLimitP: number | null;
  createdAt: number;
};

type LiveRuntime = {
  key: string;
  timeframe: string;
  symbol: string;
  windowSlug: string;
  startTs: number;
  endTs: number;
  up: Array<{ t: number; p: number }>;
  down: Array<{ t: number; p: number }>;
  pending: LivePendingRun[];
};

type ScreenshotLink = { id: number; fileName: string };

const DEFAULT_LANES: LaneConfig[] = [
  { laneIndex: 0, label: "Lane A", cents: 96, timerSec: 0, shares: 1, sideRule: "both", tokenDiffLimitCents: null },
  { laneIndex: 1, label: "Lane B", cents: 97, timerSec: 0, shares: 1, sideRule: "both", tokenDiffLimitCents: null },
  { laneIndex: 2, label: "Lane C", cents: 98, timerSec: 0, shares: 1, sideRule: "both", tokenDiffLimitCents: null },
  { laneIndex: 3, label: "Lane D", cents: 99, timerSec: 0, shares: 1, sideRule: "both", tokenDiffLimitCents: null },
];

function centsToThreshold(cents: number): number {
  const c = Math.round(cents);
  return Math.min(0.99, Math.max(0.01, c / 100));
}

function diffLimitCentsToParam(cents: number | null): number | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  const c = Math.max(0, Math.min(100, cents));
  return c / 100;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function fmtEventTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ts);
  }
}

function fmtAsk(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}¢`;
}

function fmtDiffLimit(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}¢`;
}

/** Inferred winning outcome for settled rows (not stored separately on older rows). */
function inferWinner(row: SimHistoryRow): string {
  if (row.status !== "settled" || !row.entry_side || row.outcome_won == null) return "—";
  if (row.outcome_won === 1) return row.entry_side;
  return row.entry_side === "Up" ? "Down" : "Up";
}

function isFailedPrediction(row: SimHistoryRow): boolean {
  if (row.status === "settled") return row.outcome_won === 0;
  return row.status === "no_cross" || row.status === "inconclusive" || row.status === "error";
}

function liveWindowKey(w: LiveWindowState): string {
  const slug = w.windowSlug?.trim();
  if (slug) return `${slug}:${w.startTs}-${w.endTs}`;
  return `${w.startTs}-${w.endTs}`;
}

function lastSidePrice(series: Array<{ t: number; p: number }>): number | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  return last && Number.isFinite(last.p) ? last.p : null;
}

function latestAtOrBefore(series: Array<{ t: number; p: number }>, t: number): number | null {
  let v: number | null = null;
  for (const row of series) {
    if (!Number.isFinite(row.t) || row.t > t) break;
    if (Number.isFinite(row.p)) v = row.p;
  }
  return v;
}

function isEligibleSide(side: "Up" | "Down", sideRule: SimSideRule): boolean {
  if (sideRule === "both") return true;
  if (sideRule === "up") return side === "Up";
  return side === "Down";
}

function findFirstCrossLive(
  up: Array<{ t: number; p: number }>,
  down: Array<{ t: number; p: number }>,
  threshold: number,
  sideRule: SimSideRule,
  notBeforeTs: number | null,
  tokenDiffLimitP: number | null
): { side: "Up" | "Down"; t: number; p: number } | null {
  const cands: Array<{ side: "Up" | "Down"; t: number; p: number }> = [];
  for (const row of up) {
    if (
      Number.isFinite(row.p) &&
      row.p >= threshold &&
      isEligibleSide("Up", sideRule) &&
      (notBeforeTs == null || row.t >= notBeforeTs)
    ) {
      cands.push({ side: "Up", t: row.t, p: row.p });
    }
  }
  for (const row of down) {
    if (
      Number.isFinite(row.p) &&
      row.p >= threshold &&
      isEligibleSide("Down", sideRule) &&
      (notBeforeTs == null || row.t >= notBeforeTs)
    ) {
      cands.push({ side: "Down", t: row.t, p: row.p });
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.side.localeCompare(b.side)));
  if (tokenDiffLimitP == null) return cands[0] ?? null;
  for (const c of cands) {
    const upAt = c.side === "Up" ? c.p : latestAtOrBefore(up, c.t);
    const downAt = c.side === "Down" ? c.p : latestAtOrBefore(down, c.t);
    if (upAt == null || downAt == null) continue;
    if (Math.abs(upAt - downAt) <= tokenDiffLimitP) return c;
  }
  return null;
}

function winningOutcomeLive(lastUp: number | null, lastDown: number | null): "Up" | "Down" | null {
  if (lastUp == null || lastDown == null) return null;
  const upHi = lastUp > 0.99;
  const downHi = lastDown > 0.99;
  if (upHi && !downHi) return "Up";
  if (downHi && !upHi) return "Down";
  if (upHi && downHi) return lastUp >= lastDown ? "Up" : "Down";
  return null;
}

export function StrategySimPage() {
  const [simulationMode, setSimulationMode] = useState<SimulationMode>("db");
  const [timeframe, setTimeframe] = useState("15m");
  const [symbol, setSymbol] = useState("BTC");
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [lanes, setLanes] = useState<LaneConfig[]>(() => DEFAULT_LANES.map((l) => ({ ...l })));
  const [history, setHistory] = useState<SimHistoryRow[]>([]);
  const [liveHistory, setLiveHistory] = useState<SimHistoryRow[]>([]);
  const [screenshotByWindow, setScreenshotByWindow] = useState<Record<string, ScreenshotLink>>({});
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [wsError, setWsError] = useState("");
  const [wsStreamNote, setWsStreamNote] = useState("");
  const [tradeOutcome, setTradeOutcome] = useState<"up" | "down">("up");
  const [spotRtds, setSpotRtds] = useState<number | null>(null);
  const [priceToBeat, setPriceToBeat] = useState<number | null>(null);
  const [clobSnap, setClobSnap] = useState<{ up: SideClobSnapshot; down: SideClobSnapshot }>({
    up: { orderbook: null, bestBidAsk: null },
    down: { orderbook: null, bestBidAsk: null },
  });
  const [liveWindow, setLiveWindow] = useState<LiveWindowState | null>(null);
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [historyBusy, setHistoryBusy] = useState(false);
  const [autoArmed, setAutoArmed] = useState<[boolean, boolean, boolean, boolean]>([
    false,
    false,
    false,
    false,
  ]);

  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const simulationModeRef = useRef<SimulationMode>(simulationMode);
  simulationModeRef.current = simulationMode;
  const wsRef = useRef<WebSocket | null>(null);
  const liveResubscribeWindowKeyRef = useRef("");
  const autoRunWindowKeyRef = useRef<string>("");
  const liveRuntimeRef = useRef<LiveRuntime | null>(null);
  const liveIdRef = useRef(-1);
  const latestWindowSlug = windows[0]?.window_slug ?? "";
  const shownHistory = simulationMode === "live" ? liveHistory : history;
  const totalPnlUsdc = shownHistory.reduce((acc, row) => {
    const v = row.pnl_usdc;
    return v != null && Number.isFinite(v) ? acc + v : acc;
  }, 0);

  const loadWindows = useCallback(async () => {
    try {
      const w = await api.windows(timeframe, symbol);
      setWindows(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load windows");
    }
  }, [timeframe, symbol]);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryBusy(true);
      const h = await api.simHistory(timeframe, symbol, 400);
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setHistoryBusy(false);
    }
  }, [timeframe, symbol]);

  const loadScreenshots = useCallback(async () => {
    try {
      const rows = await api.screenshots(timeframe, symbol);
      const map: Record<string, ScreenshotLink> = {};
      for (const r of rows as ScreenshotRow[]) {
        const slug = r.window_slug?.trim();
        if (!slug) continue;
        if (!map[slug] || r.id > map[slug]!.id) {
          map[slug] = { id: r.id, fileName: r.file_name || "screenshot" };
        }
      }
      setScreenshotByWindow(map);
    } catch {
      // Keep page usable even if screenshot list fails.
    }
  }, [timeframe, symbol]);

  const appendLiveRows = useCallback((rows: SimHistoryRow[]) => {
    if (rows.length === 0) return;
    setLiveHistory((prev) => {
      const byId = new Map<number, SimHistoryRow>();
      for (const row of prev) byId.set(row.id, row);
      for (const row of rows) byId.set(row.id, row);
      return [...byId.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 400);
    });
  }, []);

  const settleLiveRuntime = useCallback(
    (rt: LiveRuntime) => {
      if (rt.pending.length === 0) return;
      const up = [...rt.up].sort((a, b) => a.t - b.t);
      const down = [...rt.down].sort((a, b) => a.t - b.t);
      const lastUp = lastSidePrice(up);
      const lastDown = lastSidePrice(down);
      const outRows: SimHistoryRow[] = [];
      for (const run of rt.pending) {
        const timerSec = Math.max(0, Math.floor(run.timerSec));
        const notBeforeTs = timerSec === 0 ? rt.startTs : Math.max(rt.startTs, rt.endTs - timerSec);
        const cross = findFirstCrossLive(
          up,
          down,
          run.threshold,
          run.sideRule,
          notBeforeTs,
          run.tokenDiffLimitP
        );
        let status: SimHistoryRow["status"] = "no_cross";
        let entry_side: string | null = null;
        let entry_price: number | null = null;
        let entry_t: number | null = null;
        let outcome_won: number | null = null;
        let pnl_usdc: number | null = 0;
        let err: string | null = null;
        if (cross) {
          entry_side = cross.side;
          entry_price = Math.min(1, Math.max(0, cross.p));
          entry_t = cross.t;
          const winner = winningOutcomeLive(lastUp, lastDown);
          if (winner == null) {
            status = "inconclusive";
            pnl_usdc = null;
            err = "Neither last Up nor last Down ask ended above 99¢; cannot pick a winner from prices.";
          } else {
            status = "settled";
            const won = entry_side === winner;
            outcome_won = won ? 1 : 0;
            pnl_usdc = won ? run.shares * (1 - entry_price) : -run.shares * entry_price;
          }
        }
        const id = run.id;
        outRows.push({
          id,
          created_at: run.createdAt,
          window_slug: rt.windowSlug,
          timeframe: rt.timeframe,
          symbol: rt.symbol,
          lane_index: run.laneIndex,
          threshold_p: run.threshold,
          shares: run.shares,
          side_rule: run.sideRule,
          timer_sec: timerSec,
          token_diff_limit_p: run.tokenDiffLimitP,
          entry_side,
          entry_price,
          entry_t,
          strike_price: null,
          final_price: null,
          last_up_p: lastUp,
          last_down_p: lastDown,
          outcome_won,
          pnl_usdc,
          status,
          error: err,
        });
      }
      appendLiveRows(outRows);
      setWsStreamNote(
        `Settled ${outRows.length} live run${outRows.length > 1 ? "s" : ""} for window ${rt.windowSlug}.`
      );
      rt.pending = [];
    },
    [appendLiveRows]
  );

  const ensureLiveRuntime = useCallback(
    (w: LiveWindowState): LiveRuntime => {
      const key = liveWindowKey(w);
      const current = liveRuntimeRef.current;
      if (current && current.key === key) return current;
      if (current && current.key !== key) settleLiveRuntime(current);
      const next: LiveRuntime = {
        key,
        timeframe,
        symbol,
        windowSlug: w.windowSlug ?? key,
        startTs: w.startTs,
        endTs: w.endTs,
        up: [],
        down: [],
        pending: [],
      };
      liveRuntimeRef.current = next;
      return next;
    },
    [settleLiveRuntime, timeframe, symbol]
  );

  const queueLiveRuns = useCallback(
    (laneList: LaneConfig[]) => {
      if (!liveWindow) {
        setError("Live WSS window is not available yet. Start live stream first.");
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec > liveWindow.endTs) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "subscribe", timeframe, symbol }));
        }
        setError("Current live window already ended. Wait for next window.");
        return;
      }
      const rt = ensureLiveRuntime(liveWindow);
      const now = Date.now();
      const queuedRows: SimHistoryRow[] = [];
      for (const lane of laneList) {
        const id = liveIdRef.current--;
        rt.pending.push({
          id,
          laneIndex: lane.laneIndex,
          threshold: centsToThreshold(lane.cents),
          shares: lane.shares,
          sideRule: lane.sideRule,
          timerSec: lane.timerSec,
          tokenDiffLimitP: diffLimitCentsToParam(lane.tokenDiffLimitCents),
          createdAt: now,
        });
        queuedRows.push({
          id,
          created_at: now,
          window_slug: rt.windowSlug,
          timeframe: rt.timeframe,
          symbol: rt.symbol,
          lane_index: lane.laneIndex,
          threshold_p: centsToThreshold(lane.cents),
          shares: lane.shares,
          side_rule: lane.sideRule,
          timer_sec: lane.timerSec,
          token_diff_limit_p: diffLimitCentsToParam(lane.tokenDiffLimitCents),
          entry_side: null,
          entry_price: null,
          entry_t: null,
          strike_price: null,
          final_price: null,
          last_up_p: null,
          last_down_p: null,
          outcome_won: null,
          pnl_usdc: null,
          status: "pending_resolution",
          error: null,
        });
      }
      appendLiveRows(queuedRows);
      setWsStreamNote(`Queued ${laneList.length} live run${laneList.length > 1 ? "s" : ""} for current window.`);
    },
    [liveWindow, ensureLiveRuntime, timeframe, symbol, appendLiveRows]
  );

  useEffect(() => {
    void loadWindows();
  }, [loadWindows]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    void loadScreenshots();
  }, [loadScreenshots]);

  useEffect(() => {
    const t = setInterval(() => {
      void loadWindows();
      void loadHistory();
      void loadScreenshots();
    }, 10000);
    return () => clearInterval(t);
  }, [loadWindows, loadHistory, loadScreenshots]);

  useEffect(() => {
    if (!streaming) {
      if (simulationModeRef.current === "live" && liveRuntimeRef.current) {
        settleLiveRuntime(liveRuntimeRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
      setClobSnap({
        up: { orderbook: null, bestBidAsk: null },
        down: { orderbook: null, bestBidAsk: null },
      });
      setLiveWindow(null);
      setWsStreamNote("");
      liveResubscribeWindowKeyRef.current = "";
      setSpotRtds(null);
      setPriceToBeat(null);
      return;
    }

    const url = backendWebSocketUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;
    setWsError("");
    setWsStreamNote("");

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          action: "subscribe",
          timeframe,
          symbol,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (data.type === "stream_status") {
          const u = data.updownClob as string | undefined;
          if (u === "active") setWsStreamNote("Up/Down: CLOB stream active.");
          else if (u === "no_tokens") setWsStreamNote("Up/Down: no outcome token IDs.");
          else setWsStreamNote("Up/Down stream unavailable.");

          const w = data.window as
            | { startTs?: number; endTs?: number; windowSlug?: string | null }
            | null
            | undefined;
          if (
            w &&
            typeof w.startTs === "number" &&
            Number.isFinite(w.startTs) &&
            typeof w.endTs === "number" &&
            Number.isFinite(w.endTs) &&
            w.endTs > w.startTs
          ) {
            setLiveWindow({
              startTs: w.startTs,
              endTs: w.endTs,
              windowSlug: typeof w.windowSlug === "string" ? w.windowSlug : null,
            });
          } else {
            setLiveWindow(null);
          }
          const beat = (data.window as { priceToBeat?: unknown } | null | undefined)?.priceToBeat;
          if (typeof beat === "number" && Number.isFinite(beat)) {
            setPriceToBeat(beat);
          } else if (!w) {
            setPriceToBeat(null);
          }
          return;
        }

        if (data.type === "clob_snapshot") {
          const nextSnap = {
            up: data.up as SideClobSnapshot,
            down: data.down as SideClobSnapshot,
          };
          setClobSnap(nextSnap);
          if (simulationModeRef.current === "live" && liveRuntimeRef.current) {
            const rt = liveRuntimeRef.current;
            const upAsk = nextSnap.up.bestBidAsk?.bestAsk;
            const downAsk = nextSnap.down.bestBidAsk?.bestAsk;
            const upTs = nextSnap.up.bestBidAsk?.t;
            const downTs = nextSnap.down.bestBidAsk?.t;
            if (typeof upAsk === "number" && Number.isFinite(upAsk) && Number.isFinite(upTs)) {
              const tSec = Math.floor((upTs as number) > 1e12 ? (upTs as number) / 1000 : (upTs as number));
              rt.up.push({ t: tSec, p: upAsk });
            }
            if (typeof downAsk === "number" && Number.isFinite(downAsk) && Number.isFinite(downTs)) {
              const tSec = Math.floor(
                (downTs as number) > 1e12 ? (downTs as number) / 1000 : (downTs as number)
              );
              rt.down.push({ t: tSec, p: downAsk });
            }
          }
          return;
        }

        if (data.type === "rtds") {
          const payload = data.payload as { value?: number | string } | undefined;
          if (!payload) return;
          const raw = payload.value;
          const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
          if (Number.isFinite(num)) setSpotRtds(num);
        }
      } catch {
        // ignore malformed message
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) setWsError("WebSocket disconnected");
    };

    ws.onerror = () => {
      if (wsRef.current === ws) setWsError(`WebSocket failed (${url})`);
    };

    return () => {
      if (wsRef.current === ws) wsRef.current = null;
      ws.close();
    };
  }, [streaming, timeframe, symbol]);

  useEffect(() => {
    if (!streaming || !liveWindow) return;
    const key = `${liveWindow.startTs}-${liveWindow.endTs}`;
    const refreshWindow = () => {
      if (liveResubscribeWindowKeyRef.current === key) return;
      liveResubscribeWindowKeyRef.current = key;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          action: "subscribe",
          timeframe,
          symbol,
        })
      );
      setWsStreamNote("Refreshing live window subscription…");
    };
    const delayMs = liveWindow.endTs * 1000 - Date.now();
    if (delayMs <= 0) {
      refreshWindow();
      return;
    }
    const timer = setTimeout(refreshWindow, delayMs + 100);
    return () => clearTimeout(timer);
  }, [streaming, liveWindow?.startTs, liveWindow?.endTs, timeframe, symbol, liveWindow]);

  useEffect(() => {
    if (simulationMode !== "live") return;
    const timer = setInterval(() => {
      const rt = liveRuntimeRef.current;
      if (!rt || rt.pending.length === 0) return;
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec <= rt.endTs) return;
      settleLiveRuntime(rt);
    }, 1000);
    return () => clearInterval(timer);
  }, [simulationMode, settleLiveRuntime]);

  useEffect(() => {
    if (simulationMode !== "live") return;
    if (!liveWindow) return;
    void ensureLiveRuntime(liveWindow);
  }, [simulationMode, liveWindow, ensureLiveRuntime]);

  useEffect(() => {
    if (!streaming || !liveWindow) return;
    const key = `${timeframe}:${symbol}:${liveWindowKey(liveWindow)}`;
    if (autoRunWindowKeyRef.current === key) return;
    autoRunWindowKeyRef.current = key;

    const run = async () => {
      try {
        const toRun = lanesRef.current.filter((_, i) => autoArmed[i]);
        if (toRun.length === 0) return;
        if (simulationMode === "live") {
          queueLiveRuns(toRun);
          return;
        }
        for (const lane of toRun) {
          await api.simRunPending({
            timeframe,
            symbol,
            laneIndex: lane.laneIndex,
            threshold: centsToThreshold(lane.cents),
            shares: lane.shares,
            sideRule: lane.sideRule,
            entryDelaySec: lane.timerSec,
            tokenDiffLimitP: diffLimitCentsToParam(lane.tokenDiffLimitCents),
            settleAfterSec: 5,
            maxRuns: 6,
          });
        }
        await loadHistory();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Auto-run failed");
      }
    };

    void run();
  }, [autoArmed, streaming, liveWindow, timeframe, symbol, loadHistory, simulationMode, queueLiveRuns]);

  const setLane = (i: number, patch: Partial<LaneConfig>) => {
    setLanes((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const runLane = async (i: number) => {
    if (simulationMode === "live") {
      if (!streaming) {
        setError("Live WSS simulation requires live stream ON.");
        return;
      }
      const lane = lanes[i];
      queueLiveRuns([lane]);
      return;
    }
    const L = lanes[i];
    setBusy((b) => ({ ...b, [L.laneIndex]: true }));
    setError("");
    try {
      const out = await api.simRunPending({
        timeframe,
        symbol,
        laneIndex: L.laneIndex,
        threshold: centsToThreshold(L.cents),
        shares: L.shares,
        sideRule: L.sideRule,
        entryDelaySec: L.timerSec,
        tokenDiffLimitP: diffLimitCentsToParam(L.tokenDiffLimitCents),
        settleAfterSec: 0,
        maxRuns: 0,
        fromOldest: true,
      });
      await loadHistory();
      if (!out.ran) {
        setError("No pending settled windows to simulate for this lane.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusy((b) => ({ ...b, [L.laneIndex]: false }));
    }
  };

  const toggleAuto = (i: number) => {
    setAutoArmed((a) => {
      const n: [boolean, boolean, boolean, boolean] = [...a] as [boolean, boolean, boolean, boolean];
      n[i] = !n[i];
      return n;
    });
  };

  const deleteRow = async (id: number) => {
    if (simulationMode === "live") {
      const rt = liveRuntimeRef.current;
      if (rt) rt.pending = rt.pending.filter((p) => p.id !== id);
      setLiveHistory((prev) => prev.filter((r) => r.id !== id));
      return;
    }
    try {
      await api.simDelete(id);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const clearAll = async () => {
    if (simulationMode === "live") {
      if (!window.confirm("Clear all UI live simulation rows?")) return;
      const rt = liveRuntimeRef.current;
      if (rt) rt.pending = [];
      setLiveHistory([]);
      setError("");
      return;
    }
    if (!window.confirm("Delete all simulation history rows from the database?")) return;
    try {
      await api.simClearAll();
      setError("");
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clear failed");
    }
  };

  return (
    <main className="container strategyPage">
      <header className="strategyPageHeader">
        <h1 className="pageTitle">Strategy simulation</h1>
        <p className="pageLead">
          Four <strong>independent</strong> lanes. Each buys when its threshold is first hit (best-ask
          series): <em>Up only</em>, <em>Down only</em>, or <em>both</em> (whichever crosses first). Entry
          timer uses the reverse countdown clock: checks start at <code>window end − timerSec</code>{" "}
          (<code>0s</code> means check the <strong>full window</strong>) and optional{" "}
          <strong>token price diff limit</strong> only allows entry when{" "}
          <code>|Up ask − Down ask| ≤ limit</code> at that moment.{" "}
          (so <code>200s</code> means only the last 200s of the window).{" "}
          <strong>Winner</strong> is decided from the <strong>last</strong> Up and Down asks in that
          window: <strong>Up</strong> wins if last Up is <strong>above 99¢</strong> and last Down is not;
          <strong>Down</strong> wins if last Down is <strong>above 99¢</strong> and last Up is not; if
          both are above 99¢, the side with the <strong>higher</strong> last ask wins. If neither is
          above 99¢, the run is <strong>inconclusive</strong> (no PnL). Payout math: win{" "}
          <code>shares × (1 − entry)</code>, lose <code>−shares × entry</code>.
        </p>
      </header>

      <section className="panel strategyMarketPanel">
        <h2 className="strategySectionTitle">Market & window</h2>
        <div className="strategyMarketRow">
          <label>
            Timeframe
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
            </select>
          </label>
          <label>
            Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="SOL">SOL</option>
            </select>
          </label>
          <label>
            Simulation source
            <select
              value={simulationMode}
              onChange={(e) => {
                const next = e.target.value as SimulationMode;
                setSimulationMode(next);
                autoRunWindowKeyRef.current = "";
              }}
            >
              <option value="db">SQLite DB (backend)</option>
              <option value="live">Live WSS (UI runtime)</option>
            </select>
          </label>
          <div className="strategyWindowSelect">
            <span className="muted small">Latest window (auto)</span>
            <code title={latestWindowSlug || "No window yet"}>
              {latestWindowSlug
                ? latestWindowSlug.length > 56
                  ? `${latestWindowSlug.slice(0, 56)}…`
                  : latestWindowSlug
                : "— waiting for latest window —"}
            </code>
          </div>
          <div className="strategyMarketActions">
            <button
              type="button"
              className={streaming ? "btn btnStop" : "btn btnStart"}
              onClick={() => setStreaming((v) => !v)}
            >
              {streaming ? "Stop live stream" : "Start live stream"}
            </button>
          </div>
        </div>
        <p className="muted small">
          {simulationMode === "db"
            ? "DB mode: windows/history auto-refresh every 10s; Run simulation backfills settled windows from oldest to newest."
            : "Live mode: lane runs are queued for the current WSS window and settled when that window rolls."}
        </p>
        {wsStreamNote ? <p className="muted small">{wsStreamNote}</p> : null}
        {wsError ? <div className="error">{wsError}</div> : null}
      </section>

      <LiveChart
        up={clobSnap.up}
        down={clobSnap.down}
        tradeOutcome={tradeOutcome}
        onTradeOutcomeChange={setTradeOutcome}
        streaming={streaming}
        liveChartWindowKey={
          liveWindow ? `${liveWindow.startTs}-${liveWindow.endTs}` : streaming ? "pending" : ""
        }
        windowStartTs={liveWindow?.startTs ?? null}
        windowEndTs={liveWindow?.endTs ?? null}
        tokenDiffUsd={
          priceToBeat != null &&
          spotRtds != null &&
          Number.isFinite(priceToBeat) &&
          Number.isFinite(spotRtds)
            ? priceToBeat - spotRtds
            : null
        }
      />

      <section className="strategyLaneGrid" aria-label="Four independent strategy lanes">
        {lanes.map((lane, i) => (
          <article key={lane.laneIndex} className="panel strategyLaneCard">
            <header className="strategyLaneHead">
              <h3>{lane.label}</h3>
              <span className="muted small">lane_index={lane.laneIndex}</span>
            </header>
            <div className="strategyLaneFields">
              <label>
                Entry threshold (¢)
                <input
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  value={lane.cents}
                  onChange={(e) => setLane(i, { cents: Number(e.target.value) || 1 })}
                />
              </label>
              <label>
                Shares
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={lane.shares}
                  onChange={(e) => setLane(i, { shares: Math.max(0.01, Number(e.target.value) || 1) })}
                />
              </label>
              <label>
                Entry timer (countdown s)
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={lane.timerSec}
                  onChange={(e) => setLane(i, { timerSec: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                />
                <small className="muted">0 = full window</small>
              </label>
              <label>
                Token price diff limit (¢)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  placeholder="disabled"
                  value={lane.tokenDiffLimitCents ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (!raw) {
                      setLane(i, { tokenDiffLimitCents: null });
                      return;
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n)) return;
                    setLane(i, { tokenDiffLimitCents: Math.max(0, Math.min(100, n)) });
                  }}
                />
              </label>
              <label>
                Side rule
                <select
                  value={lane.sideRule}
                  onChange={(e) => setLane(i, { sideRule: e.target.value as SimSideRule })}
                >
                  <option value="both">Both — first to cross</option>
                  <option value="up">Up only</option>
                  <option value="down">Down only</option>
                </select>
              </label>
            </div>
            <div className="strategyLaneActions">
              <button
                type="button"
                className="btn btnStart"
                disabled={!!busy[lane.laneIndex]}
                onClick={() => void runLane(i)}
              >
                {simulationMode === "live" ? "Queue live run" : "Run simulation"}
              </button>
              <button
                type="button"
                className={autoArmed[i] ? "btn btnStop" : "btn"}
                onClick={() => toggleAuto(i)}
              >
                {autoArmed[i] ? "Stop auto" : "Start auto"}
              </button>
            </div>
            <p className="muted small strategyLaneHint">
              {simulationMode === "db" ? (
                <>
                  <strong>Run</strong> backfills this lane across settled windows from oldest to newest.
                  <strong> Start auto</strong> waits for live WSS window updates, then runs settled windows
                  missing a row for this lane (same threshold/timer/shares/rule/diff limit).
                </>
              ) : (
                <>
                  <strong>Queue live run</strong> registers this lane on the current WSS window.
                  <strong> Start auto</strong> registers runs for each new live window.
                </>
              )}
            </p>
          </article>
        ))}
      </section>

      {error ? <div className="error strategyError">{error}</div> : null}

      <section className="panel simHistoryPanel">
        <div className="simHistoryToolbar">
          <h2 className="strategySectionTitle">
            {simulationMode === "db" ? "Simulation history (SQLite)" : "Simulation history (Live WSS, UI)"}
          </h2>
          <span className={totalPnlUsdc >= 0 ? "pnlPos" : "pnlNeg"}>Total PnL: {fmtUsd(totalPnlUsdc)}</span>
          <button type="button" className="btn btnStop" onClick={() => void clearAll()}>
            Clear all…
          </button>
        </div>
        <div className="tableScroll">
          <table className="simHistoryTable">
            <thead>
              <tr>
                <th>No</th>
                <th>When</th>
                <th>Lane</th>
                <th>Window</th>
                <th>Thr</th>
                <th>Timer</th>
                <th>Diff limit</th>
                <th>Shares</th>
                <th>Rule</th>
                <th>Entry</th>
                <th>Buy time</th>
                <th>Last Up</th>
                <th>Last Down</th>
                <th>Winner</th>
                <th>Status</th>
                <th>PnL</th>
                <th>Shot</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shownHistory.length === 0 ? (
                <tr>
                  <td colSpan={18} className="muted">
                    {simulationMode === "db"
                      ? "No rows yet. Run a lane above (backend needs price_events for that window)."
                      : "No rows yet. Start live stream, then queue lane runs for the current window."}
                  </td>
                </tr>
              ) : (
                shownHistory.map((row, idx) => (
                  <tr key={row.id}>
                    <td>{shownHistory.length - idx}</td>
                    <td>{fmtTime(row.created_at)}</td>
                    <td>{row.lane_index}</td>
                    <td className="simSlugCell" title={row.window_slug}>
                      {row.window_slug.length > 36 ? `${row.window_slug.slice(0, 36)}…` : row.window_slug}
                    </td>
                    <td>
                      {row.threshold_p != null ? `${(row.threshold_p * 100).toFixed(0)}¢` : "—"}
                    </td>
                    <td>{row.timer_sec != null ? `${Math.max(0, Math.floor(row.timer_sec))}s` : "0s"}</td>
                    <td>{fmtDiffLimit(row.token_diff_limit_p)}</td>
                    <td>{row.shares ?? "—"}</td>
                    <td>{row.side_rule}</td>
                    <td>
                      {row.entry_side
                        ? `${row.entry_side} ${row.entry_price != null ? `@ ${(row.entry_price * 100).toFixed(1)}¢` : ""}`
                        : "—"}
                    </td>
                    <td>{fmtEventTime(row.entry_t)}</td>
                    <td>{fmtAsk(row.last_up_p)}</td>
                    <td>{fmtAsk(row.last_down_p)}</td>
                    <td>{inferWinner(row)}</td>
                    <td>{row.status}</td>
                    <td className={row.pnl_usdc != null && row.pnl_usdc >= 0 ? "pnlPos" : "pnlNeg"}>
                      {row.pnl_usdc != null ? fmtUsd(row.pnl_usdc) : "—"}
                    </td>
                    <td>
                      {(() => {
                        const shot = screenshotByWindow[row.window_slug];
                        if (!shot) return "—";
                        const failed = isFailedPrediction(row);
                        return (
                          <a
                            href={`/api/screenshots/${shot.id}/file`}
                            target="_blank"
                            rel="noreferrer"
                            className={failed ? "failShotLink" : undefined}
                          >
                            {failed ? "Fail shot" : "Open"}
                          </a>
                        );
                      })()}
                    </td>
                    <td>
                      <button type="button" className="btn btnSmall" onClick={() => void deleteRow(row.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
