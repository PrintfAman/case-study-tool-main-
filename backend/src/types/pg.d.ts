declare module 'pg' {
  export interface QueryResult {
    rows: unknown[];
    rowCount: number | null;
    fields: Array<{ name: string }>;
  }

  export interface PoolClient {
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
    release(): void;
  }

  export class Pool {
    constructor(options: { connectionString: string; max?: number; ssl?: { rejectUnauthorized?: boolean; ca?: string }; connectionTimeoutMillis?: number; query_timeout?: number });
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}
