import type { AppDb } from "./db.js";

export type SideRule = "up" | "down" | "both";

export type PointLike = { side: "Up" | "Down"; t: number; p: number };

/** Last recorded best-ask style price for that side in the window (series sorted by `t` ascending). */
export function lastSeriesPrice(series: PointLike[]): number | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  return Number.isFinite(last.p) ? last.p : null;
}

function eligible(side: "Up" | "Down", sideRule: SideRule): boolean {
  if (sideRule === "both") return true;
  if (sideRule === "up") return side === "Up";
  return side === "Down";
}

function latestAtOrBefore(series: PointLike[], t: number): number | null {
  let v: number | null = null;
  for (const row of series) {
    if (!Number.isFinite(row.t) || row.t > t) break;
    if (Number.isFinite(row.p)) v = row.p;
  }
  return v;
}

/**
 * First time an eligible side's price is at or above threshold (best-ask style series),
 * constrained to rows at/after `notBeforeTs` when provided.
 * Tie-break: earlier `t`, then side name ascending (deterministic).
 */
export function findFirstCross(
  up: PointLike[],
  down: PointLike[],
  threshold: number,
  sideRule: SideRule,
  notBeforeTs: number | null = null,
  tokenDiffLimitP: number | null = null
): PointLike | null {
  const cands: PointLike[] = [];
  for (const row of up) {
    if (
      Number.isFinite(row.p) &&
      row.p >= threshold &&
      eligible("Up", sideRule) &&
      (notBeforeTs == null || row.t >= notBeforeTs)
    ) {
      cands.push({ side: "Up", t: row.t, p: row.p });
    }
  }
  for (const row of down) {
    if (
      Number.isFinite(row.p) &&
      row.p >= threshold &&
      eligible("Down", sideRule) &&
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

/** Strictly above 99¢ (0.99). */
const ABOVE_99C = 0.99;

/**
 * Winning outcome from **last** Up/Down asks in the series:
 * - Up wins if last Up > 99¢ and last Down is not.
 * - Down wins if last Down > 99¢ and last Up is not.
 * - If both > 99¢, the side with the **higher** last ask wins (tie → Up).
 * - If neither > 99¢, inconclusive (`null`).
 */
export function winningOutcomeFromLastAsks(
  lastUp: number | null,
  lastDown: number | null
): "Up" | "Down" | null {
  if (lastUp == null || lastDown == null) return null;
  const upHi = lastUp > ABOVE_99C;
  const downHi = lastDown > ABOVE_99C;
  if (upHi && !downHi) return "Up";
  if (downHi && !upHi) return "Down";
  if (upHi && downHi) return lastUp >= lastDown ? "Up" : "Down";
  return null;
}

export function pnlForWinningOutcome(
  entrySide: "Up" | "Down",
  entryPrice: number,
  shares: number,
  winningOutcome: "Up" | "Down"
): { won: boolean; pnlUsdc: number } {
  const won = entrySide === winningOutcome;
  const pnlUsdc = won ? shares * (1 - entryPrice) : -shares * entryPrice;
  return { won, pnlUsdc };
}

export type SimRunInput = {
  windowSlug: string;
  timeframe: string;
  symbol: string;
  laneIndex: number;
  threshold: number;
  shares: number;
  sideRule: SideRule;
  entryDelaySec: number;
  tokenDiffLimitP: number | null;
};

export type SimRunOutput = {
  id: number;
  status: "settled" | "no_cross" | "inconclusive" | "error";
  windowSlug: string;
  timeframe: string;
  symbol: string;
  laneIndex: number;
  threshold: number;
  shares: number;
  sideRule: SideRule;
  entryDelaySec: number;
  tokenDiffLimitP: number | null;
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

export function executeSimulation(db: AppDb, input: SimRunInput): SimRunOutput {
  const sym = input.symbol.toUpperCase();
  const baseErr = (msg: string): SimRunOutput => ({
    id: 0,
    status: "error",
    windowSlug: input.windowSlug,
    timeframe: input.timeframe,
    symbol: sym,
    laneIndex: input.laneIndex,
    threshold: input.threshold,
    shares: input.shares,
    sideRule: input.sideRule,
    entryDelaySec: input.entryDelaySec,
    tokenDiffLimitP: input.tokenDiffLimitP,
    entrySide: null,
    entryPrice: null,
    entryT: null,
    lastUpP: null,
    lastDownP: null,
    winningOutcome: null,
    outcomeWon: null,
    pnlUsdc: null,
    error: msg,
  });

  if (!Number.isFinite(input.threshold) || input.threshold <= 0 || input.threshold >= 1) {
    return baseErr("threshold must be between 0 and 1 (e.g. 0.86)");
  }
  if (!Number.isFinite(input.shares) || input.shares <= 0) {
    return baseErr("shares must be positive");
  }
  if (!["up", "down", "both"].includes(input.sideRule)) {
    return baseErr("sideRule must be up, down, or both");
  }
  if (!Number.isFinite(input.entryDelaySec) || input.entryDelaySec < 0) {
    return baseErr("entryDelaySec must be >= 0");
  }
  if (
    input.tokenDiffLimitP != null &&
    (!Number.isFinite(input.tokenDiffLimitP) || input.tokenDiffLimitP < 0 || input.tokenDiffLimitP > 1)
  ) {
    return baseErr("tokenDiffLimitP must be between 0 and 1 (or null to disable)");
  }

  const up = db.getSeries(input.windowSlug, "Up") as PointLike[];
  const down = db.getSeries(input.windowSlug, "Down") as PointLike[];
  const lastUpP = lastSeriesPrice(up);
  const lastDownP = lastSeriesPrice(down);
  const w = db.getWindowBySlug(input.windowSlug);
  const startTsRaw = w?.start_ts;
  const endTsRaw = w?.end_ts;
  const startTs =
    typeof startTsRaw === "number"
      ? startTsRaw
      : typeof startTsRaw === "string"
        ? Number(startTsRaw)
        : NaN;
  const endTs =
    typeof endTsRaw === "number"
      ? endTsRaw
      : typeof endTsRaw === "string"
        ? Number(endTsRaw)
        : NaN;
  // Timer is based on reverse countdown: unlock when remaining time <= entryDelaySec.
  // Example: 200s means begin checking entries from (window_end - 200s).
  // Special case: 0 means no timer restriction (check full window), which is
  // the expected "default immediate" behavior in the UI.
  let notBeforeTs: number | null = null;
  const delaySec = Math.max(0, Math.floor(input.entryDelaySec));
  if (Number.isFinite(endTs)) {
    if (delaySec === 0) {
      notBeforeTs = Number.isFinite(startTs) ? Math.floor(startTs) : null;
    } else {
      notBeforeTs = Math.floor(endTs - delaySec);
      if (Number.isFinite(startTs)) notBeforeTs = Math.max(Math.floor(startTs), notBeforeTs);
    }
  } else if (Number.isFinite(startTs)) {
    // Fallback when end timestamp is unavailable.
    notBeforeTs = delaySec === 0 ? Math.floor(startTs) : Math.floor(startTs + delaySec);
  }
  const cross = findFirstCross(
    up,
    down,
    input.threshold,
    input.sideRule,
    notBeforeTs,
    input.tokenDiffLimitP
  );

  const rowBase = {
    windowSlug: input.windowSlug,
    timeframe: input.timeframe,
    symbol: sym,
    laneIndex: input.laneIndex,
    thresholdP: input.threshold,
    shares: input.shares,
    sideRule: input.sideRule,
    timerSec: Math.floor(input.entryDelaySec),
    tokenDiffLimitP: input.tokenDiffLimitP,
    strikePrice: null as number | null,
    finalPrice: null as number | null,
    lastUpP,
    lastDownP,
  };

  if (!cross) {
    const id = db.insertSimResult({
      ...rowBase,
      entrySide: null,
      entryPrice: null,
      entryT: null,
      outcomeWon: null,
      pnlUsdc: 0,
      status: "no_cross",
      error: null,
    });
    return {
      id,
      status: "no_cross",
      windowSlug: input.windowSlug,
      timeframe: input.timeframe,
      symbol: sym,
      laneIndex: input.laneIndex,
      threshold: input.threshold,
      shares: input.shares,
      sideRule: input.sideRule,
      entryDelaySec: input.entryDelaySec,
      tokenDiffLimitP: input.tokenDiffLimitP,
      entrySide: null,
      entryPrice: null,
      entryT: null,
      lastUpP,
      lastDownP,
      winningOutcome: winningOutcomeFromLastAsks(lastUpP, lastDownP),
      outcomeWon: null,
      pnlUsdc: 0,
      error: null,
    };
  }

  const entryPrice = Math.min(1, Math.max(0, cross.p));
  const entrySide = cross.side;
  const winner = winningOutcomeFromLastAsks(lastUpP, lastDownP);

  if (winner == null) {
    const id = db.insertSimResult({
      ...rowBase,
      entrySide,
      entryPrice,
      entryT: cross.t,
      outcomeWon: null,
      pnlUsdc: null,
      status: "inconclusive",
      error: "Neither last Up nor last Down ask ended above 99¢; cannot pick a winner from prices.",
    });
    return {
      id,
      status: "inconclusive",
      windowSlug: input.windowSlug,
      timeframe: input.timeframe,
      symbol: sym,
      laneIndex: input.laneIndex,
      threshold: input.threshold,
      shares: input.shares,
      sideRule: input.sideRule,
      entryDelaySec: input.entryDelaySec,
      tokenDiffLimitP: input.tokenDiffLimitP,
      entrySide,
      entryPrice,
      entryT: cross.t,
      lastUpP,
      lastDownP,
      winningOutcome: null,
      outcomeWon: null,
      pnlUsdc: null,
      error:
        "Neither last Up nor last Down ask ended above 99¢; cannot pick a winner from prices.",
    };
  }

  const { won, pnlUsdc } = pnlForWinningOutcome(entrySide, entryPrice, input.shares, winner);
  const id = db.insertSimResult({
    ...rowBase,
    entrySide,
    entryPrice,
    entryT: cross.t,
    outcomeWon: won,
    pnlUsdc,
    status: "settled",
    error: null,
  });

  return {
    id,
    status: "settled",
    windowSlug: input.windowSlug,
    timeframe: input.timeframe,
    symbol: sym,
    laneIndex: input.laneIndex,
    threshold: input.threshold,
    shares: input.shares,
    sideRule: input.sideRule,
    entryDelaySec: input.entryDelaySec,
    tokenDiffLimitP: input.tokenDiffLimitP,
    entrySide,
    entryPrice,
    entryT: cross.t,
    lastUpP,
    lastDownP,
    winningOutcome: winner,
    outcomeWon: won,
    pnlUsdc,
    error: null,
  };
}
