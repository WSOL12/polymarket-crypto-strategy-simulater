import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SideClobSnapshot, type SimHistoryRow, type SimSideRule, type WindowRow } from "../api";
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

export function StrategySimPage() {
  const [timeframe, setTimeframe] = useState("15m");
  const [symbol, setSymbol] = useState("BTC");
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [lanes, setLanes] = useState<LaneConfig[]>(() => DEFAULT_LANES.map((l) => ({ ...l })));
  const [history, setHistory] = useState<SimHistoryRow[]>([]);
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
  const [liveWindow, setLiveWindow] = useState<{ startTs: number; endTs: number } | null>(null);
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
  const wsRef = useRef<WebSocket | null>(null);
  const autoRunWindowKeyRef = useRef<string>("");
  const latestWindowSlug = windows[0]?.window_slug ?? "";

  const loadWindows = useCallback(async () => {
    try {
      setError("");
      const w = await api.windows(timeframe, symbol);
      setWindows(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load windows");
    }
  }, [timeframe, symbol]);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryBusy(true);
      setError("");
      const h = await api.simHistory(timeframe, symbol, 400);
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setHistoryBusy(false);
    }
  }, [timeframe, symbol]);

  useEffect(() => {
    void loadWindows();
  }, [loadWindows]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const t = setInterval(() => {
      void loadWindows();
      void loadHistory();
    }, 10000);
    return () => clearInterval(t);
  }, [loadWindows, loadHistory]);

  useEffect(() => {
    if (!streaming) {
      wsRef.current?.close();
      wsRef.current = null;
      setClobSnap({
        up: { orderbook: null, bestBidAsk: null },
        down: { orderbook: null, bestBidAsk: null },
      });
      setLiveWindow(null);
      setWsStreamNote("");
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

          const w = data.window as { startTs?: number; endTs?: number } | null | undefined;
          if (
            w &&
            typeof w.startTs === "number" &&
            Number.isFinite(w.startTs) &&
            typeof w.endTs === "number" &&
            Number.isFinite(w.endTs) &&
            w.endTs > w.startTs
          ) {
            setLiveWindow({ startTs: w.startTs, endTs: w.endTs });
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
          setClobSnap({
            up: data.up as SideClobSnapshot,
            down: data.down as SideClobSnapshot,
          });
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
    const key = `${timeframe}:${symbol}:${liveWindow.startTs}-${liveWindow.endTs}`;
    if (autoRunWindowKeyRef.current === key) return;
    autoRunWindowKeyRef.current = key;

    const run = async () => {
      try {
        const toRun = lanesRef.current.filter((_, i) => autoArmed[i]);
        if (toRun.length === 0) return;
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
            settleAfterSec: 120,
            maxRuns: 6,
          });
        }
        await loadHistory();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Auto-run failed");
      }
    };

    void run();
  }, [autoArmed, streaming, liveWindow, timeframe, symbol, loadHistory]);

  const setLane = (i: number, patch: Partial<LaneConfig>) => {
    setLanes((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  };

  const runLane = async (i: number) => {
    const runSlug = latestWindowSlug.trim();
    if (!runSlug) {
      setError("No latest window available yet for this timeframe/symbol.");
      return;
    }
    const L = lanes[i];
    setBusy((b) => ({ ...b, [L.laneIndex]: true }));
    setError("");
    try {
      await api.simRun({
        windowSlug: runSlug,
        timeframe,
        symbol,
        laneIndex: L.laneIndex,
        threshold: centsToThreshold(L.cents),
        shares: L.shares,
        sideRule: L.sideRule,
        entryDelaySec: L.timerSec,
        tokenDiffLimitP: diffLimitCentsToParam(L.tokenDiffLimitCents),
      });
      await loadHistory();
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
    try {
      await api.simDelete(id);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const clearAll = async () => {
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
          and optional <strong>token price diff limit</strong> only allows entry when{" "}
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
          Windows and history auto-refresh every 10s. Lane runs always target the latest window.
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
            ? spotRtds - priceToBeat
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
                Run simulation
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
              <strong>Run</strong> evaluates the selected window once. <strong>Start auto</strong> waits for
              live WSS window updates, then runs settled windows missing a row for this lane (same
              threshold/timer/shares/rule/diff limit).
            </p>
          </article>
        ))}
      </section>

      {error ? <div className="error strategyError">{error}</div> : null}

      <section className="panel simHistoryPanel">
        <div className="simHistoryToolbar">
          <h2 className="strategySectionTitle">Simulation history (SQLite)</h2>
          <button type="button" className="btn btnStop" onClick={() => void clearAll()}>
            Clear all…
          </button>
        </div>
        <div className="tableScroll">
          <table className="simHistoryTable">
            <thead>
              <tr>
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
                <th />
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={16} className="muted">
                    No rows yet. Run a lane above (backend needs <code>price_events</code> for that window).
                  </td>
                </tr>
              ) : (
                history.map((row) => (
                  <tr key={row.id}>
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
