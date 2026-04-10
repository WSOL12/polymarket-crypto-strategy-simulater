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

  getSeries(windowSlug: string, side?: string) {
    this.assertReady();
    const parts = ["window_slug=?"];
    const params: unknown[] = [windowSlug];
    if (side) {
      parts.push("side=?");
      params.push(side);
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
      parts.push("timeframe=?");
      params.push(filters.timeframe);
    }
    if (filters.symbol) {
      parts.push("symbol=?");
      params.push(filters.symbol);
    }
    this.assertReady();
    return this.query(
      `SELECT * FROM screenshots WHERE ${parts.join(
        " AND "
      )} ORDER BY created_at DESC LIMIT 2000`,
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
