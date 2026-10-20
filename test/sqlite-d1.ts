import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * D1Database over Node's built-in SQLite, loaded with the real migrations. Every call
 * yields to the event loop first, so concurrent requests interleave the way they do
 * against D1, and conditional UPDATEs, CHECK constraints and triggers behave for real.
 */
class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values as SQLInputValue[]);
  }

  allSync<T>(): T[] {
    return this.db.prepare(this.sql).all(...this.params) as T[];
  }

  runSync() {
    const res = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(res.changes) } };
  }

  async first<T>(): Promise<T | null> {
    await tick();
    return (this.allSync<T>()[0] as T | undefined) ?? null;
  }

  async all<T>() {
    await tick();
    return { success: true, results: this.allSync<T>(), meta: {} };
  }

  async run() {
    await tick();
    return this.runSync();
  }
}

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function createSqliteD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(import.meta.dirname, '..', 'migrations');
  for (const file of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));

  const d1 = {
    raw: db,
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      await tick();
      db.exec('BEGIN');
      try {
        const out = statements.map(s =>
          /^\s*select/i.test(s.sql) ? { success: true, results: s.allSync(), meta: {} } : s.runSync()
        );
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return d1 as unknown as D1Database;
}

export function rawSqlite(d1: D1Database): DatabaseSync {
  return (d1 as unknown as { raw: DatabaseSync }).raw;
}
