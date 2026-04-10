# polymarket-crypto-strategy-simulater

Dashboard and tooling to observe **Polymarket crypto up/down** markets: live CLOB order book snapshots, best bid/ask, optional spot (RTDS) feed, and periodic Polymarket page screenshots—useful for simulating or validating trading strategies without placing real orders.

## Structure

| Path | Role |
|------|------|
| `backend/` | Express API, WebSocket hub, realtime collector, screenshot worker (see `backend/README.md`) |
| `frontend/` | React + Vite UI (see `frontend/README.md`) |

## Prerequisites

- Node.js (LTS recommended)
- A `.env` file at the **repository root** (used by the backend; see backend source / env expectations)

## Quick start

**Backend** (from repo root):

```bash
cd backend
npm install
npm run dev
```

**Frontend** (separate terminal):

```bash
cd frontend
npm install
npm run dev
```

Open the Vite dev URL printed in the terminal. Point the frontend at your backend if URLs differ (see `frontend` WebSocket/API config).

## Scripts

- **Backend:** `npm run dev` · `npm run build` · `npm run start`
- **Frontend:** `npm run dev` · `npm run build` · `npm run preview`

## Disclaimer

This project is for **research and simulation**. It is not financial advice. Polymarket and crypto markets involve risk; use at your own discretion.
