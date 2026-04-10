import type { AppDb } from "./db.js";
import type { ServerConfig } from "./config.js";
import type { PriceEvent, TimeframeKey, TrackedWindow } from "../shared/types.js";
import {
  discoverCurrentWindow,
  fetchCurrentWindowBySeriesId,
  fetchRecentTrades,
  fetchSeriesId,
} from "./services.js";

export class RealtimeCollector {
  private timer?: NodeJS.Timeout;
  private readonly trackedByHorizon = new Map<TimeframeKey, TrackedWindow>();
  private readonly seriesIdByHorizon = new Map<TimeframeKey, string>();

  constructor(private readonly cfg: ServerConfig, private readonly db: AppDb) {}

  async start() {
    try {
      await this.ensureSeriesIds();
      await this.tick();
    } catch (err) {
      console.error("[collector] initial start failed:", err);
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error("[collector] tick failed:", err);
      });
    }, this.cfg.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async ensureSeriesIds() {
    for (const h of this.cfg.horizons) {
      const slug = this.cfg.seriesByHorizon[h];
      if (!slug) continue;
      const id = await fetchSeriesId(this.cfg.gammaBaseUrl, slug);
      if (id) this.seriesIdByHorizon.set(h, id);
    }
  }

  private async tick() {
    for (const h of this.cfg.horizons) {
      const seriesId = this.seriesIdByHorizon.get(h);
      const current = seriesId
        ? await fetchCurrentWindowBySeriesId({
            gammaBaseUrl: this.cfg.gammaBaseUrl,
            seriesId,
            timeframe: h,
            symbol: this.cfg.symbol,
          })
        : await discoverCurrentWindow({
            gammaBaseUrl: this.cfg.gammaBaseUrl,
            timeframe: h,
            symbol: this.cfg.symbol,
          });
      if (!current || !current.upTokenId || !current.downTokenId) continue;
      this.trackedByHorizon.set(h, current);
      this.db.upsertWindow(current);
      await this.ingestTrades(current);
    }
  }

  private async ingestTrades(window: TrackedWindow) {
    const trades = await fetchRecentTrades({
      dataApiBaseUrl: this.cfg.dataApiBaseUrl,
      conditionId: window.conditionId,
      limit: 1000,
    });
    for (const tr of trades) {
      let side: "Up" | "Down" | null = null;
      if (tr.asset === window.upTokenId) side = "Up";
      if (tr.asset === window.downTokenId) side = "Down";
      if (!side) continue;
      const evt: PriceEvent = {
        windowSlug: window.windowSlug,
        timeframe: window.timeframe,
        symbol: window.symbol,
        side,
        tokenId: tr.asset,
        t: tr.timestamp,
        p: tr.price,
        source: "trade",
        sourceId: tr.transactionHash,
      };
      this.db.insertPriceEvent(evt);
    }
  }
}
