/**
 * Quick check: node scripts/test-ws.mjs
 * Expect: "open" then a JSON line with type "connected"
 */
import WebSocket from "ws";

const url = process.env.WS_TEST_URL ?? "ws://127.0.0.1:3001/ws";
const ws = new WebSocket(url);

ws.on("open", () => {
  console.log("open", url);
  ws.send(JSON.stringify({ action: "subscribe", timeframe: "15m", symbol: "BTC", windowSlug: "" }));
});
ws.on("message", (d) => console.log("message", String(d).slice(0, 200)));
ws.on("close", (code, reason) => console.log("close", code, String(reason)));
ws.on("error", (e) => console.error("error", e.message));

setTimeout(() => {
  ws.close();
  process.exit(0);
}, 4000);
