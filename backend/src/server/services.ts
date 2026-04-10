import type { TimeframeKey, TrackedWindow } from "../shared/types.js";

type GammaSeries = { id: string };
type GammaSeriesLookup = GammaSeries | GammaSeries[];

type GammaEvent = {
  slug: string;
  title?: string;
  /** Trading window start (Polymarket UI / Chainlink strike reference). */
  startTime?: string;
  startDate?: string;
  endDate?: string;
  eventMetadata?: { priceToBeat?: number | string; finalPrice?: number | string };
  markets?: Array<{
    conditionId?: string;
    clobTokenIds?: string;
    outcomes?: string;
    /** Actual start of the Up/Down price window (matches site “price to beat” timing). */
    eventStartTime?: string;
    endDate?: string;
  }>;
};

/** Chainlink reference window — prefer `eventStartTime` on the market. */
function windowStartTs(e: GammaEvent): number {
  const m = e.markets?.[0];
  const iso = m?.eventStartTime ?? e.startTime ?? e.startDate;
  return toTs(iso);
}

function windowEndTs(e: GammaEvent): number {
  const m = e.markets?.[0];
  return toTs(e.endDate ?? m?.endDate);
}

function parseJsonArray(raw?: string): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toTs(v?: string): number {
  if (!v) return 0;
  const n = Math.floor(new Date(v).getTime() / 1000);
  return Number.isFinite(n) ? n : 0;
}

async function fetchJson<T>(url: URL, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(id);
  }
}

export async function fetchSeriesId(baseUrl: string, slug: string): Promise<string | null> {
  const url = new URL(`${baseUrl}/series`);
  url.searchParams.set("slug", slug);
  const data = await fetchJson<GammaSeriesLookup>(url, 8000).catch(() => null);
  if (!data) return null;
  if (Array.isArray(data)) return data?.[0]?.id ?? null;
  return typeof data.id === "string" && data.id ? data.id : null;
}

export async function fetchCurrentWindowBySeriesId(opts: {
  gammaBaseUrl: string;
  seriesId: string;
  timeframe: TimeframeKey;
  symbol: string;
}): Promise<TrackedWindow | null> {
  const url = new URL(`${opts.gammaBaseUrl}/events`);
  url.searchParams.set("series_id", opts.seriesId);
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "50");
  url.searchParams.set("offset", "0");
  const events = await fetchJson<GammaEvent[]>(url, 8000).catch(() => null);
  if (!events) return null;
  if (!Array.isArray(events) || events.length === 0) return null;

  const nowTs = Math.floor(Date.now() / 1000);
  const sorted = [...events].sort((a, b) => windowStartTs(a) - windowStartTs(b));
  const candidate =
    sorted.find((e) => {
      const st = windowStartTs(e);
      const et = windowEndTs(e);
      return st <= nowTs && nowTs <= et;
    }) ?? sorted[sorted.length - 1];
  if (!candidate) return null;
  const market = candidate.markets?.[0];
  if (!market?.conditionId || !market.clobTokenIds) return null;
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const outcomes = parseJsonArray(market.outcomes);
  const upIdx = outcomes.findIndex((x) => x.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((x) => x.toLowerCase() === "down");
  if (upIdx < 0 || downIdx < 0) return null;
  return {
    timeframe: opts.timeframe,
    symbol: opts.symbol,
    windowSlug: candidate.slug,
    conditionId: market.conditionId,
    upTokenId: tokenIds[upIdx] ?? "",
    downTokenId: tokenIds[downIdx] ?? "",
    startTs: windowStartTs(candidate),
    endTs: windowEndTs(candidate),
  };
}

function timeframeHints(timeframe: TimeframeKey): string[] {
  if (timeframe === "5m") return ["5m", "5 m", "5min", "5 min", "5-minute", "5 minute"];
  if (timeframe === "15m")
    return ["15m", "15 m", "15min", "15 min", "15-minute", "15 minute"];
  return ["1h", "1 h", "1hr", "1 hr", "1 hour", "hourly", "60m", "60 min"];
}

function includesAny(haystack: string, needles: string[]) {
  return needles.some((n) => haystack.includes(n));
}

export async function discoverCurrentWindow(opts: {
  gammaBaseUrl: string;
  timeframe: TimeframeKey;
  symbol: string;
}): Promise<TrackedWindow | null> {
  const symbolLc = opts.symbol.toLowerCase();
  const nowTs = Math.floor(Date.now() / 1000);
  const desiredMinutes = opts.timeframe === "5m" ? 5 : opts.timeframe === "15m" ? 15 : 60;
  const symbolHints = [
    symbolLc,
    symbolLc === "btc"
      ? "bitcoin"
      : symbolLc === "eth"
        ? "ethereum"
        : symbolLc === "sol"
          ? "solana"
          : "",
  ].filter(Boolean);

  const candidates: TrackedWindow[] = [];
  let best: TrackedWindow | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  // Prefer server-side filtering; Gamma supports slug_contains + active/closed.
  const slugQueries = symbolHints.length ? symbolHints : [symbolLc];
  for (const slug_contains of slugQueries) {
    const url = new URL(`${opts.gammaBaseUrl}/events`);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("slug_contains", slug_contains);
    url.searchParams.set("limit", "200");
    url.searchParams.set("offset", "0");
    const events = await fetchJson<GammaEvent[]>(url, 6000).catch(() => null);
    if (!events) continue;
    if (!Array.isArray(events) || events.length === 0) break;

    for (const e of events) {
      const search = `${e.slug ?? ""} ${e.title ?? ""}`.toLowerCase();
      const market = e.markets?.[0];
      if (!market?.conditionId || !market.clobTokenIds) continue;
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const outcomes = parseJsonArray(market.outcomes).map((x) => x.toLowerCase());
      const upIdx = outcomes.findIndex((x) => x === "up");
      const downIdx = outcomes.findIndex((x) => x === "down");
      const hasUpDown = upIdx >= 0 && downIdx >= 0;
      if (!hasUpDown) continue;
      const hasSymbol = symbolHints.some((h) => search.includes(h));
      if (!hasSymbol) continue;

      const st = windowStartTs(e);
      const et = windowEndTs(e);
      const mins =
        st > 0 && et > 0 && et >= st ? Math.round((et - st) / 60) : desiredMinutes;
      // Filter by duration closeness to requested timeframe.
      if (Math.abs(mins - desiredMinutes) > Math.max(10, desiredMinutes)) continue;

      const candidate: TrackedWindow = {
        timeframe: opts.timeframe,
        symbol: opts.symbol,
        windowSlug: e.slug,
        conditionId: market.conditionId,
        upTokenId: tokenIds[upIdx] ?? "",
        downTokenId: tokenIds[downIdx] ?? "",
        startTs: st,
        endTs: et,
      };
      candidates.push(candidate);

      const active =
        candidate.startTs > 0 &&
        candidate.endTs > 0 &&
        candidate.startTs <= nowTs &&
        nowTs <= candidate.endTs;
      const dur = Math.abs(mins - desiredMinutes);
      const score = (active ? 0 : 1000) + dur;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    // Early stop if we already have an active, near-duration match.
    if (best && bestScore <= 2) break;
  }

  if (!best && candidates.length === 0) return null;
  const score = (x: TrackedWindow) => {
    const active = x.startTs > 0 && x.endTs > 0 && x.startTs <= nowTs && nowTs <= x.endTs ? 0 : 1;
    const mins =
      x.startTs > 0 && x.endTs > 0 && x.endTs >= x.startTs
        ? Math.round((x.endTs - x.startTs) / 60)
        : desiredMinutes;
    const dur = Math.abs(mins - desiredMinutes);
    return active * 1000 + dur;
  };
  return best ?? [...candidates].sort((a, b) => score(a) - score(b))[0] ?? null;
}

export type DataApiTrade = {
  transactionHash: string;
  asset: string;
  price: number;
  timestamp: number;
};

export async function fetchRecentTrades(opts: {
  dataApiBaseUrl: string;
  conditionId: string;
  limit: number;
}): Promise<DataApiTrade[]> {
  const url = new URL(`${opts.dataApiBaseUrl}/trades`);
  url.searchParams.set("market", opts.conditionId);
  url.searchParams.set("takerOnly", "false");
  url.searchParams.set("limit", String(opts.limit));
  url.searchParams.set("offset", "0");
  const data = await fetchJson<
    Array<{
    transactionHash?: unknown;
    asset?: unknown;
    price?: unknown;
    timestamp?: unknown;
  }>
  >(url, 8000).catch(() => []);
  return (Array.isArray(data) ? data : [])
    .map((d) => ({
      transactionHash: String(d.transactionHash ?? ""),
      asset: String(d.asset ?? ""),
      price: Number(d.price),
      timestamp: Number(d.timestamp),
    }))
    .filter(
      (d) =>
        d.transactionHash &&
        d.asset &&
        Number.isFinite(d.price) &&
        Number.isFinite(d.timestamp)
    );
}

export type GammaStrikeContext = {
  /** From `eventMetadata.priceToBeat` when present (often only after resolution). */
  metadataStrike: number | null;
  /** Window open (unix seconds), from `markets[0].eventStartTime` / `startTime` / `startDate`. */
  startTs: number;
};

function parseMetadataStrike(
  raw: number | string | undefined
): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Gamma event row for slug: metadata strike (if any) and window start for Chainlink buffer lookup.
 */
export async function fetchGammaStrikeContext(
  gammaBaseUrl: string,
  windowSlug: string | null | undefined
): Promise<GammaStrikeContext> {
  if (!windowSlug) return { metadataStrike: null, startTs: 0 };
  const url = new URL(`${gammaBaseUrl}/events`);
  url.searchParams.set("slug", windowSlug);
  const events = await fetchJson<GammaEvent[]>(url, 8000).catch(() => null);
  const e = events?.[0];
  if (!e) return { metadataStrike: null, startTs: 0 };
  const st = windowStartTs(e);
  const raw = e.eventMetadata?.priceToBeat;
  return { metadataStrike: parseMetadataStrike(raw), startTs: st > 0 ? st : 0 };
}

/**
 * Official “price to beat” when Polymarket exposes it on the event (may appear after window opens).
 */
export async function fetchEventPriceToBeatFromGamma(
  gammaBaseUrl: string,
  windowSlug: string | null | undefined
): Promise<number | null> {
  const ctx = await fetchGammaStrikeContext(gammaBaseUrl, windowSlug);
  return ctx.metadataStrike;
}
