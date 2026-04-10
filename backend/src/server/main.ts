import { loadServerConfig } from "./config.js";
import { AppDb } from "./db.js";
import { RealtimeCollector } from "./collector.js";
import { ScreenshotWorker } from "./screenshotWorker.js";
import { createApi } from "./api.js";
import { createServer } from "node:http";
import { attachRealtimeWs } from "./wsHub.js";

async function main() {
  const cfg = loadServerConfig();
  const db = new AppDb(cfg.dbPath);
  await db.init();
  const collector = new RealtimeCollector(cfg, db);
  const screenshotWorker = new ScreenshotWorker(cfg, db);
  const app = createApi(db, cfg);
  const apiServer = createServer(app);
  const wsHttpServer = createServer((_req, res) => {
    res.writeHead(404).end();
  });

  await collector.start();
  await screenshotWorker.start();
  attachRealtimeWs(wsHttpServer, db, cfg);
  apiServer.on("error", (err) => {
    console.error(`[HTTP API] port ${cfg.port}:`, err.message);
    process.exit(1);
  });
  wsHttpServer.on("error", (err) => {
    console.error(`[WebSocket] port ${cfg.wsPort}:`, err.message);
    process.exit(1);
  });
  apiServer.listen(cfg.port, () => {
    console.log(`API listening at http://localhost:${cfg.port}`);
  });
  wsHttpServer.listen(cfg.wsPort, () => {
    console.log(`WebSocket listening at ws://localhost:${cfg.wsPort}/ws`);
  });
  setInterval(() => db.flush(), 5000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
