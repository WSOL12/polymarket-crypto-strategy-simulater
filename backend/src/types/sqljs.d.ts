declare module "sql.js" {
  export type QueryExecResult = {
    columns: string[];
    values: unknown[][];
  };

  export class Database {
    constructor(data?: Uint8Array);
    run(sql: string, params?: Record<string, unknown> | unknown[]): void;
    prepare(sql: string, params?: Record<string, unknown> | unknown[]): Statement;
    exec(sql: string): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export class Statement {
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  type InitSqlJs = (opts?: {
    locateFile?: (file: string) => string;
  }) => Promise<{ Database: typeof Database }>;

  const initSqlJs: InitSqlJs;
  export default initSqlJs;
}
