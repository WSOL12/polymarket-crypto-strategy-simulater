import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database } from "sql.js";
import type { PriceEvent, TrackedWindow } from "../shared/types.js";

export class AppDb {
  private db!: Database;
  private initialized = false;
  private dirty = false;
  private readonly wasmPath = path.resolve(
    "node_modules/sql.js/dist/sql-wasm.wasm"
  );

  constructor(private readonly dbPath: string) {}

  async init() {
    if (this.initialized) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => this.wasmPath });
    if (fs.existsSync(this.dbPath)) {
      const data = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(data);
    } else {
      this.db = new SQL.Database();
    }
    this.migrate();
    this.initialized = true;
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS windows (
        window_slug TEXT PRIMARY KEY,
        timeframe TEXT NOT NULL,
        symbol TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        up_token_id TEXT NOT NULL,
        down_token_id TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS price_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_slug TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        token_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        p REAL NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        UNIQUE(source, source_id, token_id)
      );
      CREATE INDEX IF NOT EXISTS idx_price_events_window_side_t
        ON price_events(window_slug, side, t);
      CREATE TABLE IF NOT EXISTS sim_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        window_slug TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        symbol TEXT NOT NULL,
        lane_index INTEGER NOT NULL,
        threshold_p REAL NOT NULL,
        shares REAL NOT NULL,
        side_rule TEXT NOT NULL,
        timer_sec INTEGER NOT NULL DEFAULT 0,
        entry_side TEXT,
        entry_price REAL,
        entry_t INTEGER,
        strike_price REAL,
        final_price REAL,
        last_up_p REAL,
        last_down_p REAL,
        outcome_won INTEGER,
        pnl_usdc REAL,
        status TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sim_results_created ON sim_results(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sim_results_window_lane ON sim_results(window_slug, lane_index);
      CREATE TABLE IF NOT EXISTS screenshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_slug TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        symbol TEXT NOT NULL,
        file_path TEXT NOT NULL,
        format TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(window_slug, format)
      );
    `);
    this.migrateSimResultsColumns();
  }

  /** Older DBs: add newly introduced sim_results columns. */
  private migrateSimResultsColumns() {
    try {
      const cols = this.query(`PRAGMA table_info(sim_results)`, []) as Record<string, unknown>[];
      const names = new Set(cols.map((c) => String(c.name ?? "").toLowerCase()));
      if (!names.has("timer_sec")) {
        this.db.run(`ALTER TABLE sim_results ADD COLUMN timer_sec INTEGER NOT NULL DEFAULT 0`);
        this.dirty = true;
      }
      if (!names.has("last_up_p")) {
        this.db.run(`ALTER TABLE sim_results ADD COLUMN last_up_p REAL`);
        this.dirty = true;
      }
      if (!names.has("last_down_p")) {
        this.db.run(`ALTER TABLE sim_results ADD COLUMN last_down_p REAL`);
        this.dirty = true;
      }
    } catch {
      /* sim_results not created yet */
    }
  }

  upsertWindow(w: TrackedWindow) {
    this.assertReady();
    this.db.run(
      `INSERT INTO windows (
        window_slug,timeframe,symbol,condition_id,up_token_id,down_token_id,start_ts,end_ts,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(window_slug) DO UPDATE SET
        timeframe=excluded.timeframe,
        symbol=excluded.symbol,
        condition_id=excluded.condition_id,
        up_token_id=excluded.up_token_id,
        down_token_id=excluded.down_token_id,
        start_ts=excluded.start_ts,
        end_ts=excluded.end_ts`,
      [
        w.windowSlug,
        w.timeframe,
        w.symbol,
        w.conditionId,
        w.upTokenId,
        w.downTokenId,
        w.startTs,
        w.endTs,
        Date.now(),
      ]
    );
    this.dirty = true;
  }

  insertPriceEvent(e: PriceEvent) {
    this.assertReady();
    this.db.run(
      `INSERT OR IGNORE INTO price_events (
        window_slug,timeframe,symbol,side,token_id,t,p,source,source_id
      ) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        e.windowSlug,
        e.timeframe,
        e.symbol,
        e.side,
        e.tokenId,
        e.t,
        e.p,
        e.source,
        e.sourceId,
      ]
    );
    this.dirty = true;
  }

  getLatestWindows(timeframe?: string, symbol?: string) {
    this.assertReady();
    const parts = ["1=1"];
    const params: unknown[] = [];
    if (timeframe) {
      parts.push("timeframe=?");
      params.push(timeframe);
    }
    if (symbol) {
      parts.push("symbol=?");
      params.push(symbol);
    }
    return this.query(
      `SELECT * FROM windows WHERE ${parts.join(
        " AND "
      )} ORDER BY start_ts DESC LIMIT 200`,
      params
    );
  }

  getSeries(windowSlug: string, side?: string, source?: string) {
    this.assertReady();
    const parts = ["window_slug=?"];
    const params: unknown[] = [windowSlug];
    if (side) {
      parts.push("side=?");
      params.push(side);
    }
    if (source) {
      parts.push("source=?");
      params.push(source);
    }
    return this.query(
      `SELECT side, t, p FROM price_events WHERE ${parts.join(
        " AND "
      )} ORDER BY t ASC`,
      params
    );
  }

  getWindowBySlug(windowSlug: string) {
    this.assertReady();
    const rows = this.query(`SELECT * FROM windows WHERE window_slug=? LIMIT 1`, [windowSlug]);
    return (rows[0] ?? null) as Record<string, unknown> | null;
  }

  getOpenWindowsNeedingScreenshot(nowTs: number) {
    this.assertReady();
    return this.query(
      `
        SELECT w.*
        FROM windows w
        LEFT JOIN screenshots s ON s.window_slug = w.window_slug
        WHERE w.end_ts <= ? AND s.id IS NULL
        ORDER BY w.end_ts ASC
        LIMIT 50
      `,
      [nowTs]
    );
  }

  insertSimResult(row: {
    windowSlug: string;
    timeframe: string;
    symbol: string;
    laneIndex: number;
    thresholdP: number;
    shares: number;
    sideRule: string;
    timerSec: number;
    entrySide: string | null;
    entryPrice: number | null;
    entryT: number | null;
    strikePrice: number | null;
    finalPrice: number | null;
    lastUpP: number | null;
    lastDownP: number | null;
    outcomeWon: boolean | null;
    pnlUsdc: number | null;
    status: string;
    error: string | null;
  }): number {
    this.assertReady();
    const now = Date.now();
    this.db.run(
      `INSERT INTO sim_results (
        created_at, window_slug, timeframe, symbol, lane_index, threshold_p, shares, side_rule,
        timer_sec,
        entry_side, entry_price, entry_t, strike_price, final_price, last_up_p, last_down_p,
        outcome_won, pnl_usdc, status, error
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        now,
        row.windowSlug,
        row.timeframe,
        row.symbol,
        row.laneIndex,
        row.thresholdP,
        row.shares,
        row.sideRule,
        Math.max(0, Math.floor(row.timerSec)),
        row.entrySide,
        row.entryPrice,
        row.entryT,
        row.strikePrice,
        row.finalPrice,
        row.lastUpP,
        row.lastDownP,
        row.outcomeWon == null ? null : row.outcomeWon ? 1 : 0,
        row.pnlUsdc,
        row.status,
        row.error,
      ]
    );
    this.dirty = true;
    const r = this.db.exec("SELECT last_insert_rowid() AS id");
    const id = r[0]?.values[0]?.[0];
    return typeof id === "number" ? id : Number(id);
  }

  listSimResults(filters: { timeframe?: string; symbol?: string; limit?: number }) {
    const parts = ["1=1"];
    const params: unknown[] = [];
    if (filters.timeframe) {
      parts.push("timeframe=?");
      params.push(filters.timeframe);
    }
    if (filters.symbol) {
      parts.push("symbol=?");
      params.push(filters.symbol);
    }
    const lim = Math.floor(Math.min(2000, Math.max(1, filters.limit ?? 500)));
    this.assertReady();
    return this.query(
      `SELECT * FROM sim_results WHERE ${parts.join(
        " AND "
      )} ORDER BY created_at DESC LIMIT ?`,
      [...params, lim]
    );
  }

  deleteSimResult(id: number): boolean {
    this.assertReady();
    const rows = this.query(`SELECT id FROM sim_results WHERE id=? LIMIT 1`, [id]);
    if (rows.length === 0) return false;
    this.db.run(`DELETE FROM sim_results WHERE id=?`, [id]);
    this.dirty = true;
    return true;
  }

  deleteAllSimResults(): number {
    this.assertReady();
    const countRows = this.query(`SELECT COUNT(*) AS c FROM sim_results`, []);
    const raw = countRows[0] as Record<string, unknown> | undefined;
    const n = Number(raw?.c ?? raw?.C ?? 0);
    this.db.run(`DELETE FROM sim_results`);
    this.dirty = true;
    return Number.isFinite(n) ? n : 0;
  }

  hasSimResult(windowSlug: string, laneIndex: number): boolean {
    this.assertReady();
    const rows = this.query(
      `SELECT 1 AS x FROM sim_results WHERE window_slug=? AND lane_index=? LIMIT 1`,
      [windowSlug, laneIndex]
    );
    return rows.length > 0;
  }

  addScreenshot(row: {
    windowSlug: string;
    timeframe: string;
    symbol: string;
    filePath: string;
    format: string;
  }) {
    this.assertReady();
    this.db.run(
      `INSERT OR IGNORE INTO screenshots(window_slug,timeframe,symbol,file_path,format,created_at)
       VALUES (?,?,?,?,?,?)`,
      [
        row.windowSlug,
        row.timeframe,
        row.symbol,
        row.filePath,
        row.format,
        Date.now(),
      ]
    );
    this.dirty = true;
  }

  listScreenshots(filters: { timeframe?: string; symbol?: string }) {
    const parts = ["1=1"];
    const params: unknown[] = [];
    if (filters.timeframe) {
      parts.push("s.timeframe=?");
      params.push(filters.timeframe);
    }
    if (filters.symbol) {
      parts.push("s.symbol=?");
      params.push(filters.symbol);
    }
    this.assertReady();
    return this.query(
      `SELECT s.id, s.window_slug, s.timeframe, s.symbol, s.file_path, s.format, s.created_at,
              w.start_ts AS start_ts, w.end_ts AS end_ts
       FROM screenshots s
       LEFT JOIN windows w ON w.window_slug = s.window_slug
       WHERE ${parts.join(" AND ")}
       ORDER BY s.created_at DESC
       LIMIT 2000`,
      params
    );
  }

  flush() {
    this.assertReady();
    if (!this.dirty) return;
    const bytes = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(bytes));
    this.dirty = false;
  }

  close() {
    if (!this.initialized) return;
    this.flush();
    this.db.close();
  }

  private assertReady() {
    if (!this.initialized) throw new Error("DB not initialized. Call init().");
  }

  private query(sql: string, params: unknown[]) {
    const stmt = this.db.prepare(sql, params);
    const out: Record<string, unknown>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }
}
