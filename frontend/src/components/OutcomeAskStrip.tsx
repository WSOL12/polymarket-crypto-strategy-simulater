import type { SideClobSnapshot } from "../api";

export type TradeOutcomeSide = "up" | "down";

type Props = {
  up: SideClobSnapshot;
  down: SideClobSnapshot;
  /** When false, show muted placeholders (no CLOB yet). */
  streaming: boolean;
  /** `header` = inline in market bar (no caption); `standalone` = full-width block below header. */
  variant?: "standalone" | "header";
  /** Which outcome is active (green). */
  selected: TradeOutcomeSide;
  /** Header buttons call this; omit for non-interactive standalone display. */
  onSelect?: (side: TradeOutcomeSide) => void;
};

/** CLOB 0–1 USDC/share; keep sub-cent precision for very small quotes. */
function fmtPriceAsCents(price: number): string {
  if (!Number.isFinite(price) || price < 0) return "—";
  const cents = price * 100;
  if (cents >= 0.1) return `${cents.toFixed(1)}¢`;
  return `${cents.toFixed(2)}¢`;
}

function bestAskPrice(side: SideClobSnapshot): number | null {
  const bba = side.bestBidAsk;
  if (bba && Number.isFinite(bba.bestAsk)) return bba.bestAsk;
  const a0 = side.orderbook?.asks?.[0];
  if (a0 && Number.isFinite(a0.price)) return a0.price;
  return null;
}

function pillClass(side: TradeOutcomeSide, selected: TradeOutcomeSide): string {
  const tone = selected === side ? "askStripPillSelected" : "askStripPillMuted";
  return `askStripPill ${tone}`;
}

export function OutcomeAskStrip({
  up,
  down,
  streaming,
  variant = "standalone",
  selected,
  onSelect,
}: Props) {
  const upAsk = bestAskPrice(up);
  const downAsk = bestAskPrice(down);
  const upLabel =
    streaming && upAsk != null ? fmtPriceAsCents(upAsk) : "—";
  const downLabel =
    streaming && downAsk != null ? fmtPriceAsCents(downAsk) : "—";

  const rootClass =
    variant === "header" ? "askStrip askStripHeader" : "askStrip";

  const interactive = Boolean(onSelect);
  const tablist = variant === "header" && interactive;

  const upEl = interactive ? (
    <button
      type="button"
      className={`askStripBtn ${pillClass("up", selected)}`}
      role={tablist ? "tab" : undefined}
      aria-selected={tablist ? selected === "up" : selected === "up"}
      onClick={() => onSelect!("up")}
    >
      <span className="askStripLabel">Up</span>
      <span className="askStripPrice">{upLabel}</span>
    </button>
  ) : (
    <div className={pillClass("up", selected)}>
      <span className="askStripLabel">Up</span>
      <span className="askStripPrice">{upLabel}</span>
    </div>
  );

  const downEl = interactive ? (
    <button
      type="button"
      className={`askStripBtn ${pillClass("down", selected)}`}
      aria-pressed={selected === "down"}
      role={tablist ? "tab" : undefined}
      aria-selected={tablist ? selected === "down" : undefined}
      onClick={() => onSelect!("down")}
    >
      <span className="askStripLabel">Down</span>
      <span className="askStripPrice">{downLabel}</span>
    </button>
  ) : (
    <div className={pillClass("down", selected)}>
      <span className="askStripLabel">Down</span>
      <span className="askStripPrice">{downLabel}</span>
    </div>
  );

  return (
    <div className={rootClass} aria-label="Best ask prices per outcome">
      <div
        className="askStripInner"
        role={tablist ? "tablist" : undefined}
        aria-label={tablist ? "Choose outcome order book" : undefined}
      >
        {upEl}
        {downEl}
      </div>
      {variant === "standalone" ? (
        <p className="askStripHint muted small">
          Best ask (lowest sell) per outcome — same source as the CLOB book.
        </p>
      ) : null}
    </div>
  );
}
