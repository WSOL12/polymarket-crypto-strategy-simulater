import { useMemo } from "react";
import type { BookLevel, SideClobSnapshot } from "../api";
import type { TradeOutcomeSide } from "./OutcomeAskStrip";
import { LivePriceChart } from "./LivePriceChart";

type Props = {
  up: SideClobSnapshot;
  down: SideClobSnapshot;
  tradeOutcome: TradeOutcomeSide;
  onTradeOutcomeChange: (side: TradeOutcomeSide) => void;
  streaming: boolean;
  /** Clears the live price series when the market window changes. */
  liveChartWindowKey: string;
  windowStartTs?: number | null;
  windowEndTs?: number | null;
};

function formatTs(t: number) {
  try {
    return new Date(t).toISOString();
  } catch {
    return String(t);
  }
}

function notionalUsd(price: number, size: number) {
  const n = price * size;
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n: number) {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** CLOB prices are 0–1 USDC/share; keep sub-cent precision for tiny quotes. */
function fmtPriceAsCents(price: number): string {
  if (!Number.isFinite(price) || price < 0) return "—";
  const cents = price * 100;
  if (cents >= 1) return `${Math.round(cents)}¢`;
  if (cents >= 0.1) return `${cents.toFixed(1)}¢`;
  return `${cents.toFixed(2)}¢`;
}

function depthMax(levels: BookLevel[], key: "size" | "total"): number {
  if (levels.length === 0) return 1;
  const vals =
    key === "size"
      ? levels.map((r) => r.size)
      : levels.map((r) => notionalUsd(r.price, r.size));
  const m = Math.max(...vals, 0);
  return m > 0 ? m : 1;
}

function PolymarketOrderbook({ side }: { side: SideClobSnapshot }) {
  const ob = side.orderbook;
  const bids = ob?.bids ?? [];
  const asks = ob?.asks ?? [];
  /** API sends asks ascending (best/low first). Polymarket shows worst/high at top, best at bottom near spread. */
  const askRows = useMemo(() => [...asks].reverse(), [asks]);
  const bba = side.bestBidAsk;

  const askDepthMax = useMemo(() => depthMax(asks, "size"), [asks]);
  const bidDepthMax = useMemo(() => depthMax(bids, "size"), [bids]);

  const lastPrice = useMemo(() => {
    if (bba) {
      const mid = (bba.bestBid + bba.bestAsk) / 2;
      return mid;
    }
    if (bids[0] && asks[0]) {
      const mid = (bids[0].price + asks[0].price) / 2;
      return mid;
    }
    return null;
  }, [bba, bids, asks]);

  const spreadPrice = useMemo(() => {
    if (bba?.spread !== undefined && Number.isFinite(bba.spread)) {
      return bba.spread;
    }
    if (bba) return bba.bestAsk - bba.bestBid;
    if (bids[0] && asks[0]) return asks[0].price - bids[0].price;
    return null;
  }, [bba, bids, asks]);

  return (
    <div className="obPm">
      <table className="obPmTable">
        <thead>
          <tr>
            <th className="obPmThBadge" aria-hidden />
            <th className="obPmThNum">PRICE</th>
            <th className="obPmThNum">SHARES</th>
            <th className="obPmThNum">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {askRows.length === 0 ? (
            <tr className="obPmRow obPmRowAsk">
              <td className="obPmBadgeCell" rowSpan={1}>
                <span className="obPmBadge obPmBadgeAsk">Asks</span>
              </td>
              <td colSpan={3} className="obPmEmpty">
                —
              </td>
            </tr>
          ) : (
            askRows.map((row, i) => {
              const total = notionalUsd(row.price, row.size);
              const pct = (row.size / askDepthMax) * 100;
              return (
                <tr key={`a-${i}`} className="obPmRow obPmRowAsk">
                  {i === 0 ? (
                    <td className="obPmBadgeCell" rowSpan={askRows.length}>
                      <span className="obPmBadge obPmBadgeAsk">Asks</span>
                    </td>
                  ) : null}
                  <td className="obPmCell obPmCellPrice obPmPriceAsk">
                    <span className="obPmDepthTrack">
                      <span className="obPmDepthFill obPmDepthFillAsk" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="obPmCellText">{fmtPriceAsCents(row.price)}</span>
                  </td>
                  <td className="obPmCell obPmCellNum">{row.size.toFixed(2)}</td>
                  <td className="obPmCell obPmCellNum">{fmtUsd(total)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <div className="obPmMidBar">
        <span className="obPmMidItem">
          Last:{" "}
          {lastPrice != null ? (
            <strong className="obPmMidStrong">{fmtPriceAsCents(lastPrice)}</strong>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
        <span className="obPmMidItem obPmMidSpread">
          Spread:{" "}
          {spreadPrice != null ? (
            <strong className="obPmMidStrong">{fmtPriceAsCents(spreadPrice)}</strong>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
      </div>

      <table className="obPmTable obPmTableBids">
        <tbody>
          {bids.length === 0 ? (
            <tr className="obPmRow obPmRowBid">
              <td className="obPmBadgeCell" rowSpan={1}>
                <span className="obPmBadge obPmBadgeBid">Bids</span>
              </td>
              <td colSpan={3} className="obPmEmpty">
                —
              </td>
            </tr>
          ) : (
            bids.map((row, i) => {
              const total = notionalUsd(row.price, row.size);
              const pct = (row.size / bidDepthMax) * 100;
              const best = i === 0;
              return (
                <tr
                  key={`b-${i}`}
                  className={`obPmRow obPmRowBid${best ? " obPmRowBidBest" : ""}`}
                >
                  {i === 0 ? (
                    <td className="obPmBadgeCell" rowSpan={bids.length}>
                      <span className="obPmBadge obPmBadgeBid">Bids</span>
                    </td>
                  ) : null}
                  <td className="obPmCell obPmCellPrice obPmPriceBid">
                    <span className="obPmDepthTrack">
                      <span className="obPmDepthFill obPmDepthFillBid" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="obPmCellText">{fmtPriceAsCents(row.price)}</span>
                  </td>
                  <td className="obPmCell obPmCellNum">{row.size.toFixed(2)}</td>
                  <td className="obPmCell obPmCellNum">{fmtUsd(total)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <p className="obPmFooter muted small">
        Book snapshot: {ob ? formatTs(ob.t) : "—"}
      </p>
    </div>
  );
}

export function LiveChart({
  up,
  down,
  tradeOutcome,
  onTradeOutcomeChange,
  streaming,
  liveChartWindowKey,
  windowStartTs,
  windowEndTs,
}: Props) {
  const side = tradeOutcome === "up" ? up : down;

  return (
    <div className="panel">
      <h3>Live market data</h3>

      <LivePriceChart
        up={up}
        down={down}
        streaming={streaming}
        windowKey={liveChartWindowKey}
        windowStartTs={windowStartTs}
        windowEndTs={windowEndTs}
      />

      <form className="formPanel" onSubmit={(e) => e.preventDefault()}>
        <fieldset>
          <legend>Order book (CLOB)</legend>
          <div className="obPmWrap">
            <div className="obPmToolbar">
              <div className="obPmTabs" role="tablist" aria-label="Outcome">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tradeOutcome === "up"}
                  className={`obPmTab${tradeOutcome === "up" ? " obPmTabActive" : ""}`}
                  onClick={() => onTradeOutcomeChange("up")}
                >
                  Trade Up
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tradeOutcome === "down"}
                  className={`obPmTab${tradeOutcome === "down" ? " obPmTabActive" : ""}`}
                  onClick={() => onTradeOutcomeChange("down")}
                >
                  Trade Down
                </button>
              </div>
            </div>
            <PolymarketOrderbook side={side} />
          </div>
        </fieldset>
      </form>

    </div>
  );
}
