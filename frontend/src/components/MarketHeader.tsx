import { useEffect, useState } from "react";
import type { SideClobSnapshot } from "../api";
import { OutcomeAskStrip, type TradeOutcomeSide } from "./OutcomeAskStrip";

export type MarketWindowInfo = {
  startTs: number;
  endTs: number;
  /** Gamma event slug — used to poll official strike. */
  windowSlug?: string;
};

type Props = {
  symbol: string;
  timeframe: string;
  streaming: boolean;
  windowInfo: MarketWindowInfo | null;
  /** WS server/client clock offset (ms): serverNow ~= Date.now() + offset. */
  clockOffsetMs: number;
  currentPrice: number | null;
  priceToBeat: number | null;
  clobUp: SideClobSnapshot;
  clobDown: SideClobSnapshot;
  tradeOutcome: TradeOutcomeSide;
  onTradeOutcomeChange: (side: TradeOutcomeSide) => void;
};

const ASSET_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
};

function timeframeTitle(tf: string): string {
  if (tf === "5m") return "5 Minutes";
  if (tf === "15m") return "15 Minutes";
  if (tf === "1h") return "1 Hour";
  return tf;
}

function formatWindowSubtitleEt(startTs: number, endTs: number): string {
  const start = new Date(startTs * 1000);
  const end = new Date(endTs * 1000);
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
  }).format(start);
  const t1 = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(start);
  const t2 = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(end);
  return `${datePart}, ${t1}–${t2} ET`;
}

function formatUsd(symbol: string, v: number): string {
  const s = symbol.toUpperCase();
  const maxFrac = s === "BTC" || s === "ETH" ? 2 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: maxFrac,
    maximumFractionDigits: maxFrac,
  }).format(v);
}

function IconBtc() {
  return (
    <span className="mhIcon mhIconBtc" aria-hidden>
      ₿
    </span>
  );
}
function IconEth() {
  return (
    <span className="mhIcon mhIconEth" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
        <path fill="currentColor" d="M16 4l9.8 16-9.8-6.2L6.2 20 16 4zm0 24l9.8-8-9.8 6.2L6.2 20 16 28z" />
      </svg>
    </span>
  );
}
function IconSol() {
  return (
    <span className="mhIcon mhIconSol" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 32 32">
        <defs>
          <linearGradient id="solG" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#9945ff" />
            <stop offset="100%" stopColor="#14f195" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="6" fill="url(#solG)" opacity="0.35" />
        <path
          fill="url(#solG)"
          d="M9 11h6l-2 3h8l-2 3H11l-2 3h14l2-3-6-6H9l2-3z"
        />
      </svg>
    </span>
  );
}

function AssetIcon({ symbol }: { symbol: string }) {
  const s = symbol.toUpperCase();
  if (s === "ETH") return <IconEth />;
  if (s === "SOL") return <IconSol />;
  return <IconBtc />;
}

export function Countdown({ endTs, clockOffsetMs }: { endTs: number; clockOffsetMs: number }) {
  const [left, setLeft] = useState(() =>
    Math.max(0, endTs * 1000 - (Date.now() + clockOffsetMs))
  );

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, endTs * 1000 - (Date.now() + clockOffsetMs)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endTs, clockOffsetMs]);

  const totalSec = Math.floor(left / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;

  return (
    <div className="mhCountdown" aria-live="polite">
      <div className="mhCdBlock">
        <span className="mhCdNum">{String(mins).padStart(2, "0")}</span>
        <span className="mhCdLbl">MINS</span>
      </div>
      <div className="mhCdBlock">
        <span className="mhCdNum">{String(secs).padStart(2, "0")}</span>
        <span className="mhCdLbl">SECS</span>
      </div>
    </div>
  );
}

export function MarketHeader(props: Props) {
  const sym = props.symbol.toUpperCase();
  const name = ASSET_NAMES[sym] ?? sym;
  const accent = `mhAccent${sym}`;

  const beat = props.priceToBeat;
  const cur = props.currentPrice;
  const delta =
    beat != null && cur != null && Number.isFinite(beat) && Number.isFinite(cur)
      ? beat - cur
      : null;

  const deltaAbsFmt =
    delta != null
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(Math.abs(delta))
      : null;

  return (
    <header className={`marketHeader ${accent}`}>
      <div className="mhTop">
        <div className="mhTitleRow">
          <AssetIcon symbol={sym} />
          <div className="mhTitles">
            <h1 className="mhHeadline">
              {name} Up or Down - {timeframeTitle(props.timeframe)}
            </h1>
            {props.windowInfo ? (
              <p className="mhSub">
                {formatWindowSubtitleEt(
                  props.windowInfo.startTs,
                  props.windowInfo.endTs
                )}
              </p>
            ) : (
              <p className="mhSub muted">
                {props.streaming
                  ? "Window times unavailable (manual tokens or Gamma)"
                  : "Start live to load market window"}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mhBottom">
        <div className="mhPrices">
          <div className="mhPriceCol">
            <span className="mhLbl">Price To Beat</span>
            <span className="mhBig mhBeat">
              {beat != null ? formatUsd(sym, beat) : "—"}
            </span>
          </div>
          <div className="mhDivider" aria-hidden />
          <div className="mhPriceCol mhCurrentCol">
            <div className="mhCurLblRow">
              <span className="mhLbl mhLblAccent">Current Price</span>
              {delta != null && deltaAbsFmt ? (
                <span
                  className={`mhDelta ${delta >= 0 ? "mhDeltaUp" : "mhDeltaDown"}`}
                >
                  {delta >= 0 ? "▲" : "▼"} {deltaAbsFmt}
                </span>
              ) : null}
            </div>
            <span className="mhBig mhCur">
              {cur != null ? formatUsd(sym, cur) : "—"}
            </span>
          </div>
        </div>
        <div className="mhAsks">
          <OutcomeAskStrip
            up={props.clobUp}
            down={props.clobDown}
            streaming={props.streaming}
            variant="header"
            selected={props.tradeOutcome}
            onSelect={props.onTradeOutcomeChange}
          />
        </div>
        {props.windowInfo ? (
          <Countdown endTs={props.windowInfo.endTs} clockOffsetMs={props.clockOffsetMs} />
        ) : (
          <div className="mhCountdown mhCountdownPlaceholder">
            <span className="muted small">—</span>
          </div>
        )}
      </div>
    </header>
  );
}
