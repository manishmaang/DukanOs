import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { readConfig } from '../config';
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool = new Pool({
    connectionString: readConfig().databaseUrl,
    connectionTimeoutMillis: 2000,
    query_timeout: 10000,
    max: 5,
  });
  constructor() {
    this.pool.on('error', () =>
      console.error('Idle database connection failed'),
    );
  }
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ) {
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
