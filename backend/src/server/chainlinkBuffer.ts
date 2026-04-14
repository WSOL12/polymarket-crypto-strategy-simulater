/**
 * In-memory Chainlink ticks from RTDS (same source as Polymarket Up/Down resolution).
 * Used to approximate “price to beat” when Gamma omits `eventMetadata.priceToBeat` on live events.
 */

type Tick = { ts: number; value: number };

const buffers = new Map<string, Tick[]>();
const MAX_TICKS_PER_SYMBOL = 5000;
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

export function recordChainlinkTick(symbol: string, ts: number, value: number): void {
  if (!Number.isFinite(ts) || !Number.isFinite(value)) return;
  const sym = symbol.toUpperCase();
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;
  let arr = buffers.get(sym) ?? [];
  arr.push({ ts, value });
  arr = arr.filter((t) => t.ts >= cutoff);
  if (arr.length > MAX_TICKS_PER_SYMBOL) arr = arr.slice(-MAX_TICKS_PER_SYMBOL);
  buffers.set(sym, arr);
}

/**
 * Strike ≈ Chainlink price at window open: first tick at/shortly after `openSec`, else last tick shortly before.
 */
export function strikeFromChainlinkBuffer(symbol: string, openSec: number): number | null {
  if (openSec <= 0) return null;
  const openMs = openSec * 1000;
  const arr = buffers.get(symbol.toUpperCase()) ?? [];
  if (arr.length === 0) return null;

  const AFTER_MS = 6 * 60 * 1000;
  const BEFORE_MS = 30 * 60 * 1000;

  let firstAfter: Tick | null = null;
  for (const t of arr) {
    if (t.ts >= openMs && t.ts <= openMs + AFTER_MS) {
      if (!firstAfter || t.ts < firstAfter.ts) firstAfter = t;
    }
  }
  if (firstAfter) return firstAfter.value;

  let lastBefore: Tick | null = null;
  for (const t of arr) {
    if (t.ts < openMs && t.ts >= openMs - BEFORE_MS) {
      if (!lastBefore || t.ts > lastBefore.ts) lastBefore = t;
    }
  }
  return lastBefore?.value ?? null;
}

/** Read buffered Chainlink ticks inside [startSec, endSec] (unix seconds). */
export function chainlinkTicksInRange(
  symbol: string,
  startSec: number,
  endSec: number
): Array<{ ts: number; value: number }> {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return [];
  const startMs = startSec * 1000;
  const endMs = endSec * 1000;
  const arr = buffers.get(symbol.toUpperCase()) ?? [];
  return arr
    .filter((t) => t.ts >= startMs && t.ts <= endMs)
    .map((t) => ({ ts: t.ts, value: t.value }));
}
