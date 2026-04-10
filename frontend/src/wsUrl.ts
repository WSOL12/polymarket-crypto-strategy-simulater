/**
 * WebSocket runs on a dedicated backend port (default 3001) — not the Express API port (3000),
 * so upgrades never fight the HTTP stack on Windows.
 */
export function backendWebSocketUrl(): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const explicit = import.meta.env.VITE_WS_URL;
  if (explicit) return explicit;
  if (import.meta.env.DEV) {
    const port = import.meta.env.VITE_WS_PORT ?? "3001";
    return `${wsProtocol}://${window.location.hostname}:${port}/ws`;
  }
  return `${wsProtocol}://${window.location.host}/ws`;
}
