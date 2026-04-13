import { useEffect, useMemo, useRef, useState } from "react";
import type { SideClobSnapshot } from "../api";
import { Countdown } from "./MarketHeader";

type Point = { t: number; up: number; down: number };

type Props = {
  up: SideClobSnapshot;
  down: SideClobSnapshot;
  /** When false, series is cleared. */
  streaming: boolean;
  /** Clear history when the prediction window changes (e.g. startTs-endTs). */
  windowKey: string;
  /** Optional prediction window bounds (unix seconds). */
  windowStartTs?: number | null;
  windowEndTs?: number | null;
  /** Current token USD difference (Current Price - Price To Beat). */
  tokenDiffUsd?: number | null;
  /** When false, hide title/help text to save vertical space. */
  showHeader?: boolean;
  /** Same as market header — aligns countdown with server time. */
  clockOffsetMs?: number;
};

const MAX_POINTS = 1500;
const THROTTLE_MS = 280;
const MIN_MOVE = 0.0015;
/** Fixed horizontal time window. New points appear at right, older points scroll left. */
const WINDOW_MS = 90_000;
const TIME_DIVISIONS = 40;
const CHART_W = 960;
const CHART_H = 600;
const PLOT = {
  left: 72,
  right: 900,
  top: 48,
  bottom: 520,
} as const;

function bestAskFromSide(side: SideClobSnapshot): number | null {
  const bba = side.bestBidAsk;
  if (bba && Number.isFinite(bba.bestAsk)) return bba.bestAsk;
  const asks = side.orderbook?.asks ?? [];
  if (asks[0] && Number.isFinite(asks[0].price)) return asks[0].price;
  return null;
}

function fmtCents(p: number): string {
  // Match the header Up/Down pill formatting (OutcomeAskStrip).
  const c = p * 100;
  if (c >= 1) return `${Math.round(c)}¢`;
  if (c >= 0.1) return `${c.toFixed(1)}¢`;
  return `${c.toFixed(2)}¢`;
}

function fmtUsdAbs(n: number): string {
  return `$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatElapsed(secTotal: number): string {
  const s = Math.max(0, Math.round(secTotal));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (r === 0) return `${m}m`;
  return `${m}m ${r}s`;
}

function formatTimeStep(stepSec: number): string {
  if (!Number.isFinite(stepSec) || stepSec <= 0) return "—";
  const s = Math.round(stepSec * 100) / 100;
  if (s < 60) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round((s - m * 60) * 100) / 100;
  if (r <= 0) return `${m}m`;
  const rStr = Number.isInteger(r) ? `${r}` : `${r.toFixed(1)}`;
  return `${m}m ${rStr}s`;
}

export function LivePriceChart({
  up,
  down,
  streaming,
  windowKey,
  windowStartTs,
  windowEndTs,
  tokenDiffUsd = null,
  showHeader = true,
  clockOffsetMs = 0,
}: Props) {
  const [points, setPoints] = useState<Point[]>([]);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const lastPushRef = useRef(0);
  const prevWindowKeyRef = useRef(windowKey);

  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setClockMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [streaming]);

  useEffect(() => {
    if (!streaming) {
      setPoints([]);
      lastPushRef.current = 0;
      prevWindowKeyRef.current = "";
      return;
    }
    if (windowKey !== prevWindowKeyRef.current) {
      prevWindowKeyRef.current = windowKey;
      setPoints([]);
      lastPushRef.current = 0;
    }
  }, [streaming, windowKey]);

  useEffect(() => {
    if (!streaming) return;

    const uRaw = bestAskFromSide(up);
    const dRaw = bestAskFromSide(down);
    if (uRaw == null && dRaw == null) return;

    setPoints((prev) => {
      const now = Date.now();
      const last = prev.length ? prev[prev.length - 1] : null;

      const nu = uRaw ?? last?.up ?? (dRaw != null ? 1 - dRaw : 0.5);
      const nd = dRaw ?? last?.down ?? (uRaw != null ? 1 - uRaw : 0.5);

      if (last) {
        const elapsed = now - lastPushRef.current;
        const moved =
          Math.abs(nu - last.up) >= MIN_MOVE || Math.abs(nd - last.down) >= MIN_MOVE;
        if (elapsed < THROTTLE_MS && !moved) return prev;
      }

      lastPushRef.current = now;
      const next: Point[] = [
        ...prev,
        {
          t: now,
          up: Math.max(0, Math.min(1, nu)),
          down: Math.max(0, Math.min(1, nd)),
        },
      ];
      return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
    });
  }, [up, down, streaming]);

  const svgPaths = useMemo(() => {
    if (points.length < 2) return null;

    const W = CHART_W;
    const H = CHART_H;
    const innerW = PLOT.right - PLOT.left;
    const innerH = PLOT.bottom - PLOT.top;

    const hasWindowRange =
      typeof windowStartTs === "number" &&
      typeof windowEndTs === "number" &&
      Number.isFinite(windowStartTs) &&
      Number.isFinite(windowEndTs) &&
      windowEndTs > windowStartTs;

    const maxT = points[points.length - 1].t;
    const minT = hasWindowRange ? windowStartTs * 1000 : Math.max(points[0].t, maxT - WINDOW_MS);
    const maxBoundT = hasWindowRange ? windowEndTs * 1000 : maxT;
    const spanT = Math.max(1, maxBoundT - minT);
    const visible = points.filter((pt) => pt.t >= minT && pt.t <= maxBoundT);
    if (visible.length < 2) return null;

    const xAt = (t: number) => {
      const clamped = Math.max(minT, Math.min(maxBoundT, t));
      return PLOT.left + ((clamped - minT) / spanT) * innerW;
    };
    const yAt = (p: number) =>
      PLOT.top + (1 - Math.max(0, Math.min(1, p))) * innerH;

    let upSeries = visible;
    let downSeries = visible;
    if (hasWindowRange && visible.length > 0) {
      // Keep the line moving toward the right edge as time advances.
      const targetT = Math.max(minT, Math.min(maxBoundT, clockMs));
      const last = visible[visible.length - 1];
      if (targetT > last.t) {
        upSeries = [...visible, { t: targetT, up: last.up, down: last.down }];
        downSeries = upSeries;
      }
    }

    const upPts = upSeries
      .map((pt) => `${xAt(pt.t).toFixed(1)},${yAt(pt.up).toFixed(1)}`)
      .join(" ");
    const downPts = downSeries
      .map((pt) => `${xAt(pt.t).toFixed(1)},${yAt(pt.down).toFixed(1)}`)
      .join(" ");

    const yTicks = Array.from({ length: 51 }, (_, i) => i * 2).map((cents) => {
      const p = cents / 100;
      return { cents, y: yAt(p) };
    });

    const stepMs = spanT / TIME_DIVISIONS;
    const xTicks = Array.from({ length: TIME_DIVISIONS + 1 }, (_, i) => {
      const elapsedSec = (i * stepMs) / 1000;
      const tAbs = minT + i * stepMs;
      return { x: xAt(tAbs), label: formatElapsed(elapsedSec) };
    });

    return {
      up: upPts,
      down: downPts,
      W,
      H,
      innerW,
      innerH,
      yTicks,
      xTicks,
      stepLabel: formatTimeStep(stepMs / 1000),
    };
  }, [points, clockMs, windowStartTs, windowEndTs]);

  const last = points.length ? points[points.length - 1] : null;

  return (
    <div className="liveMidChart">
      {showHeader ? (
        <>
          <h3>Live mid price</h3>
          <p className="liveMidChartLead muted small">
            Same axis system as saved image: Y in 2¢ steps, X in 40 equal time divisions.
          </p>
        </>
      ) : null}
      {!streaming ? (
        <p className="muted small">Start live to record this window.</p>
      ) : points.length < 2 || !svgPaths ? (
        <p className="muted small">Waiting for CLOB best asks…</p>
      ) : (
        <div className="liveMidChartSvgWrap">
          {last && (
            <div className="liveMidChartLegend">
              <span className="liveMidChartLegUp">Up {fmtCents(last.up)}</span>
              <span className="liveMidChartLegDown">Down {fmtCents(last.down)}</span>
              {typeof tokenDiffUsd === "number" && Number.isFinite(tokenDiffUsd) ? (
                <span
                  className={
                    tokenDiffUsd >= 0
                      ? "liveMidChartTokenDelta liveMidChartTokenDeltaUp"
                      : "liveMidChartTokenDelta liveMidChartTokenDeltaDown"
                  }
                >
                  {tokenDiffUsd >= 0 ? "▲" : "▼"} {fmtUsdAbs(tokenDiffUsd)}
                </span>
              ) : null}
              {typeof windowEndTs === "number" &&
              windowEndTs > 0 &&
              Number.isFinite(windowEndTs) ? (
                <div className="liveMidChartCdWrap" aria-label="Time until window ends">
                  <Countdown endTs={windowEndTs} clockOffsetMs={clockOffsetMs} />
                </div>
              ) : null}
            </div>
          )}
          <svg
            className="liveMidChartSvg"
            viewBox={`0 0 ${svgPaths.W} ${svgPaths.H}`}
            preserveAspectRatio="xMidYMid meet"
            aria-label="Up and Down best ask over time"
          >
            <rect x="0" y="0" width={svgPaths.W} height={svgPaths.H} fill="#14161a" rx="6" />
            {svgPaths.yTicks.map((tick) => {
              return (
                <g key={tick.cents}>
                  <line
                    x1={PLOT.left}
                    y1={tick.y}
                    x2={PLOT.right}
                    y2={tick.y}
                    stroke="#2a2d35"
                    strokeWidth="1"
                  />
                  <text
                    x={PLOT.left - 8}
                    y={tick.y + 4}
                    fill="#8a909c"
                    fontSize="10"
                    textAnchor="end"
                  >
                    {tick.cents}¢
                  </text>
                </g>
              );
            })}
            {svgPaths.xTicks.map((tick, i) => (
              <g key={`x-${i}`}>
                <line
                  x1={tick.x}
                  y1={PLOT.top}
                  x2={tick.x}
                  y2={PLOT.bottom}
                  stroke="#2a2d35"
                  strokeWidth="1"
                />
                <text x={tick.x} y={PLOT.bottom + 16} fill="#aaa" fontSize="9" textAnchor="middle">
                  {tick.label}
                </text>
              </g>
            ))}
            <polyline
              fill="none"
              stroke="#21d07a"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={svgPaths.up}
            />
            <polyline
              fill="none"
              stroke="#ff5a5f"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={svgPaths.down}
            />
            <line
              x1={PLOT.left}
              y1={PLOT.bottom}
              x2={PLOT.right}
              y2={PLOT.bottom}
              stroke="#444"
              strokeWidth="1.5"
            />
            <line
              x1={PLOT.left}
              y1={PLOT.top}
              x2={PLOT.left}
              y2={PLOT.bottom}
              stroke="#444"
              strokeWidth="1.5"
            />
            <text
              x={(PLOT.left + PLOT.right) / 2}
              y={PLOT.bottom + 40}
              fill="#888"
              fontSize="12"
              textAnchor="middle"
            >
              Time from window start — {TIME_DIVISIONS} equal parts, one tick every {svgPaths.stepLabel}
            </text>
            <text
              transform={`translate(22,${(PLOT.top + PLOT.bottom) / 2}) rotate(-90)`}
              fill="#888"
              fontSize="12"
              textAnchor="middle"
            >
              Price (¢)
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
