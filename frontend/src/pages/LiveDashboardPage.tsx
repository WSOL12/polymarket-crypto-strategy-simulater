import { useEffect, useRef, useState } from "react";
import type { SideClobSnapshot, ScreenshotRow } from "../api";
import type { TradeOutcomeSide } from "../components/OutcomeAskStrip";
import { api } from "../api";
import { DashboardForm } from "../components/DashboardForm";
import { LiveChart } from "../components/LiveChart";
import type { MarketWindowInfo } from "../components/MarketHeader";
import { MarketHeader } from "../components/MarketHeader";
import { ScreenshotList } from "../components/ScreenshotList";
import { backendWebSocketUrl } from "../wsUrl";

function timeframeDurationSec(tf: string): number {
  if (tf === "5m") return 5 * 60;
  if (tf === "15m") return 15 * 60;
  if (tf === "1h") return 60 * 60;
  return 0;
}

function normalizedEndTs(startTs: number, endTs: number, tf: string): number {
  const expected = timeframeDurationSec(tf);
  if (expected <= 0) return endTs;
  const actual = endTs - startTs;
  const drift = actual - expected;
  // Gamma/event timestamps can include small offset seconds; normalize when clearly drifted.
  if (drift > 1 && drift <= 30) return endTs - drift;
  return endTs;
}

export function LiveDashboardPage() {
  const [timeframe, setTimeframe] = useState("15m");
  const [symbol, setSymbol] = useState("BTC");
  const [streaming, setStreaming] = useState(false);
  const [spotRtds, setSpotRtds] = useState<{
    symbol: string;
    value: number;
    ts: number;
  } | null>(null);
  const emptyClobSide = (): SideClobSnapshot => ({
    orderbook: null,
    bestBidAsk: null,
  });
  const [clobSnap, setClobSnap] = useState<{
    up: SideClobSnapshot;
    down: SideClobSnapshot;
  }>({ up: emptyClobSide(), down: emptyClobSide() });
  const [shots, setShots] = useState<ScreenshotRow[]>([]);
  const [restError, setRestError] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [wsStreamNote, setWsStreamNote] = useState<string>("");
  const [marketWindow, setMarketWindow] = useState<MarketWindowInfo | null>(null);
  const [priceToBeat, setPriceToBeat] = useState<number | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [tradeOutcome, setTradeOutcome] = useState<TradeOutcomeSide>("up");
  const windowKeyRef = useRef<string>("");
  const rolloverAttemptKeyRef = useRef<string>("");
  const rolloverRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noTokensRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const sendSubscribe = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(
      JSON.stringify({
        action: "subscribe",
        timeframe,
        symbol,
      })
    );
    return true;
  };

  const startLive = () => {
    setStreaming(true);
  };

  const stopLive = (opts?: { keepRolloverKey?: boolean }) => {
    setStreaming(false);
    setSpotRtds(null);
    setMarketWindow(null);
    setPriceToBeat(null);
    windowKeyRef.current = "";
    if (!opts?.keepRolloverKey) rolloverAttemptKeyRef.current = "";
    if (rolloverRestartTimerRef.current) {
      clearTimeout(rolloverRestartTimerRef.current);
      rolloverRestartTimerRef.current = null;
    }
    if (noTokensRetryTimerRef.current) {
      clearTimeout(noTokensRetryTimerRef.current);
      noTokensRetryTimerRef.current = null;
    }
    setClobSnap({ up: emptyClobSide(), down: emptyClobSide() });
    setTradeOutcome("up");
    wsRef.current?.close();
    wsRef.current = null;
  };

  /** Screenshots: plain HTTP. */
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.screenshots(timeframe, symbol);
        if (cancelled) return;
        setRestError("");
        setShots(s);
      } catch (e) {
        if (!cancelled)
          setRestError(e instanceof Error ? e.message : "Failed to load screenshots");
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [timeframe, symbol]);

  /** WebSocket: CLOB orderbook + best bid/ask; optional RTDS spot. */
  useEffect(() => {
    if (!streaming) return;
    let closedByEffectCleanup = false;
    setError("");
    setWsStreamNote("");
    setMarketWindow(null);
    setPriceToBeat(null);
    setTradeOutcome("up");
    windowKeyRef.current = "";
    const url = backendWebSocketUrl();
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setError("");
      sendSubscribe();
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>;
        const serverTsRaw = data.timestamp;
        if (typeof serverTsRaw === "number" && Number.isFinite(serverTsRaw)) {
          const nextOffset = serverTsRaw - Date.now();
          setClockOffsetMs((prev) => Math.round(prev * 0.8 + nextOffset * 0.2));
        }
        if (data.type === "stream_status") {
          const w = data.window as
            | {
                startTs?: number;
                endTs?: number;
                windowSlug?: string;
                priceToBeat?: number;
              }
            | null
            | undefined;
          if (
            w &&
            typeof w.startTs === "number" &&
            typeof w.endTs === "number" &&
            w.endTs > w.startTs
          ) {
            const key = `${w.startTs}-${w.endTs}`;
            if (key !== windowKeyRef.current) {
              windowKeyRef.current = key;
              setPriceToBeat(null);
              // Drop previous-window CLOB immediately while new window stream initializes.
              setClobSnap({ up: emptyClobSide(), down: emptyClobSide() });
            }
            const slug =
              typeof w.windowSlug === "string" && w.windowSlug.length > 0
                ? w.windowSlug
                : undefined;
            const nextWindow: MarketWindowInfo = {
              startTs: w.startTs,
              endTs: normalizedEndTs(w.startTs, w.endTs, timeframe),
              ...(slug ? { windowSlug: slug } : {}),
            };
            setMarketWindow(nextWindow);
            if (typeof w.priceToBeat === "number" && Number.isFinite(w.priceToBeat)) {
              setPriceToBeat(w.priceToBeat);
            }
          } else {
            setMarketWindow(null);
          }
          const u = data.updownClob as string | undefined;
          if (u === "active") {
            setWsStreamNote("Up/Down: CLOB stream active.");
            if (noTokensRetryTimerRef.current) {
              clearTimeout(noTokensRetryTimerRef.current);
              noTokensRetryTimerRef.current = null;
            }
          } else if (u === "no_tokens") {
            setWsStreamNote("Up/Down: no outcome token IDs. Configure MANUAL_*_TOKEN_ID in backend .env.");
            if (!noTokensRetryTimerRef.current) {
              noTokensRetryTimerRef.current = setTimeout(() => {
                noTokensRetryTimerRef.current = null;
                sendSubscribe();
              }, 700);
            }
          } else {
            setWsStreamNote("Up/Down stream unavailable. Configure backend token IDs.");
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
        if (data.type !== "rtds") return;
        const p = data.payload as
          | { symbol?: string; value?: number; timestamp?: number }
          | undefined;
        if (!p) return;
        const v = p.value;
        const num =
          typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        if (Number.isFinite(num)) {
          setSpotRtds({
            symbol: String(p.symbol ?? ""),
            value: num,
            ts: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
          });
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      if (closedByEffectCleanup) return;
      if (wsRef.current !== ws) return;
      setError("WebSocket disconnected");
    };
    ws.onerror = () => {
      if (closedByEffectCleanup) return;
      if (wsRef.current !== ws) return;
      setError(`WebSocket failed (${url}). Backend WS port (3001) running?`);
    };

    return () => {
      closedByEffectCleanup = true;
      if (noTokensRetryTimerRef.current) {
        clearTimeout(noTokensRetryTimerRef.current);
        noTokensRetryTimerRef.current = null;
      }
      if (wsRef.current === ws) wsRef.current = null;
      ws.close();
    };
  }, [streaming, timeframe, symbol]);

  /**
   * Frontend-only rollover:
   * use the exact same flow as manual controls: Stop, then Start Live.
   */
  useEffect(() => {
    if (!streaming || !marketWindow) return;
    const key = `${marketWindow.startTs}-${marketWindow.endTs}`;
    if (rolloverAttemptKeyRef.current === key) return;
    const delayMs = marketWindow.endTs * 1000 - Date.now();

    const restartLikeManual = () => {
      if (rolloverAttemptKeyRef.current === key) return;
      rolloverAttemptKeyRef.current = key;
      stopLive({ keepRolloverKey: true });
      rolloverRestartTimerRef.current = setTimeout(() => {
        rolloverRestartTimerRef.current = null;
        startLive();
      }, 250);
    };

    if (delayMs <= 0) {
      restartLikeManual();
      return;
    }

    const id = setTimeout(restartLikeManual, delayMs + 50);
    return () => clearTimeout(id);
  }, [streaming, marketWindow?.startTs, marketWindow?.endTs, timeframe, symbol]);

  /** Keep beat price synced to official strike endpoint for the active window. */
  useEffect(() => {
    if (!streaming || !marketWindow?.windowSlug) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.priceToBeat(marketWindow.windowSlug!, symbol);
        if (cancelled || r.priceToBeat == null) return;
        setPriceToBeat((prev) => {
          if (prev == null) return r.priceToBeat;
          return Math.abs(prev - r.priceToBeat) > 1e-9 ? r.priceToBeat : prev;
        });
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [streaming, marketWindow?.windowSlug, symbol]);

  return (
    <main className="container">
      <MarketHeader
        symbol={symbol}
        timeframe={timeframe}
        streaming={streaming}
        windowInfo={marketWindow}
        clockOffsetMs={clockOffsetMs}
        currentPrice={spotRtds?.value ?? null}
        priceToBeat={priceToBeat}
        clobUp={clobSnap.up}
        clobDown={clobSnap.down}
        tradeOutcome={tradeOutcome}
        onTradeOutcomeChange={setTradeOutcome}
      />
      <DashboardForm
        timeframe={timeframe}
        symbol={symbol}
        onTimeframeChange={setTimeframe}
        onSymbolChange={setSymbol}
        streaming={streaming}
        onStart={startLive}
        onStop={() => stopLive()}
        wsStreamNote={streaming ? wsStreamNote : ""}
      />
      {error && <div className="error">{error}</div>}
      {restError && <div className="error">{restError}</div>}

      <LiveChart
        up={clobSnap.up}
        down={clobSnap.down}
        tradeOutcome={tradeOutcome}
        onTradeOutcomeChange={setTradeOutcome}
        streaming={streaming}
        liveChartWindowKey={
          marketWindow
            ? `${marketWindow.startTs}-${marketWindow.endTs}`
            : streaming
              ? "pending"
              : ""
        }
        windowStartTs={marketWindow?.startTs ?? null}
        windowEndTs={marketWindow?.endTs ?? null}
        tokenDiffUsd={
          priceToBeat != null &&
          spotRtds?.value != null &&
          Number.isFinite(priceToBeat) &&
          Number.isFinite(spotRtds.value)
            ? spotRtds.value - priceToBeat
            : null
        }
      />
      <ScreenshotList rows={shots} />
    </main>
  );
}
