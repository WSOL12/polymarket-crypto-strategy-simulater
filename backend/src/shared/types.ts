export type TimeframeKey = "5m" | "15m" | "1h";

export type TrackedWindow = {
  timeframe: TimeframeKey;
  symbol: string;
  windowSlug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  startTs: number;
  endTs: number;
};

export type PriceEvent = {
  windowSlug: string;
  timeframe: TimeframeKey;
  symbol: string;
  side: "Up" | "Down";
  tokenId: string;
  t: number;
  p: number;
  source: "trade" | "ws";
  sourceId: string;
};
