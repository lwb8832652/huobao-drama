import 'dotenv/config'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2'
import type { MySqlTable } from 'drizzle-orm/mysql-core'
import { drizzle as drizzleSqlite, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { getTableColumns, sql } from 'drizzle-orm'
import mysql from 'mysql2/promise'
import * as sqliteSchema from './schema.js'
import { createMysqlSchema } from './mysql-schema.js'
import { initSqliteSchema } from './sqlite-schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/db → 上三级为仓库根（与 utils/paths.ts 的推断层级一致）
const repoRoot = path.resolve(__dirname, '../../..')

export type DbDialect = 'sqlite' | 'mysql'

function resolveDialect(): DbDialect {
  const configured = process.env.DB_DIALECT?.trim().toLowerCase()
  if (configured && configured !== 'sqlite' && configured !== 'mysql') {
    throw new Error(`Unsupported DB_DIALECT "${process.env.DB_DIALECT}". Expected sqlite or mysql.`)
  }
  // 测试隔离：node --test 的子进程里强制 sqlite。否则 .env 配了远端 MySQL 时，
  // 单测里的 DELETE/INSERT 会直接改写真实库。确需端到端测 MySQL 时显式设
  // DB_DIALECT_ALLOW_REMOTE=1。
  if (process.env.NODE_TEST_CONTEXT && !process.env.DB_DIALECT_ALLOW_REMOTE) return 'sqlite'
  if (configured) return configured as DbDialect
  return process.env.DATABASE_URL?.startsWith('mysql://') || process.env.MYSQL_HOST ? 'mysql' : 'sqlite'
}

export const dbDialect = resolveDialect()
export const schema = dbDialect === 'mysql' ? createMysqlSchema() : sqliteSchema

// 桌面版由 Electron 主进程注入 SQLITE_PATH（userData 下）；dev 默认仓库根 data/。
// MySQL 模式仍导出该路径，供存储空间统计兼容使用，但不会创建或打开此文件。
export const dbPath = process.env.SQLITE_PATH || path.join(repoRoot, 'data', 'huobao.sqlite3')

function mysqlUrlFromEnv(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.MYSQL_HOST || '127.0.0.1'
  const port = process.env.MYSQL_PORT || '3306'
  const user = encodeURIComponent(process.env.MYSQL_USER || 'huobao')
  const password = encodeURIComponent(process.env.MYSQL_PASSWORD || 'huobao')
  const database = process.env.MYSQL_DATABASE || 'huobao_drama'
  return `mysql://${user}:${password}@${host}:${port}/${database}`
}

/**
 * sqlite-proxy makes better-sqlite3 expose the same asynchronous query shape as
 * mysql2. Transactions receive an exclusive scheduler token so no request can
 * interleave SQL between BEGIN and COMMIT while an async callback is running.
 */
class SqliteScheduler {
  private readonly context = new AsyncLocalStorage<symbol>()
  private barrier: Promise<void> = Promise.resolve()
  private owner?: symbol

  async execute<T>(operation: () => T): Promise<T> {
    if (this.owner && this.context.getStore() === this.owner) return operation()
    let previous: Promise<void>
    do {
      previous = this.barrier
      await previous
    } while (previous !== this.barrier)
    return operation()
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.owner && this.context.getStore() === this.owner) return operation()

    const previous = this.barrier
    let release!: () => void
    this.barrier = new Promise<void>(resolve => { release = resolve })
    await previous

    const token = Symbol('sqlite-transaction')
    this.owner = token
    try {
      return await this.context.run(token, operation)
    } finally {
      this.owner = undefined
      release()
    }
  }

  outsideTransaction<T>(operation: () => T): T {
    return this.context.exit(operation)
  }
}

function createSqliteDatabase() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const client = new Database(dbPath)
  client.pragma('journal_mode = WAL')
  client.pragma('busy_timeout = 5000')
  client.pragma('synchronous = NORMAL')
  initSqliteSchema(client)

  const scheduler = new SqliteScheduler()
  const database = drizzleSqlite(async (sql, params, method) => scheduler.execute(() => {
    const statement = client.prepare(sql)
    if (method === 'run') {
      const result = statement.run(...params)
      return { rows: [], changes: result.changes, lastInsertRowid: result.lastInsertRowid } as any
    }
    if (method === 'get') {
      return { rows: statement.raw(true).get(...params) } as any
    }
    return { rows: statement.raw(true).all(...params) }
  }), { schema })

  const transaction = database.transaction.bind(database)
  const transactionContext = new AsyncLocalStorage<any>()
  database.transaction = (async (callback: any, config?: any) => {
    const parent = transactionContext.getStore()
    if (parent) {
      return parent.transaction((nested: any) =>
        transactionContext.run(nested, () => callback(nested)))
    }
    return scheduler.transaction(() => transaction(
      (tx: any) => transactionContext.run(tx, () => callback(tx)),
      config,
    ))
  }) as typeof database.transaction

  return {
    database,
    close: async () => client.close(),
    outsideTransaction: <T>(operation: () => T) =>
      scheduler.outsideTransaction(() => transactionContext.exit(operation)),
  }
}

function createMysqlDatabase() {
  const pool = mysql.createPool({
    uri: mysqlUrlFromEnv(),
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  })
  // MySQL receives native MySQL table/column objects with the same logical keys.
  const mysqlDatabase = drizzleMysql(pool, { schema: schema as any, mode: 'default' })
  const wrapped = new WeakMap<object, object>()
  const transactionContext = new AsyncLocalStorage<any>()

  const wrapBuilder = (builder: any): any => {
    if (!builder || (typeof builder !== 'object' && typeof builder !== 'function')) return builder
    const cached = wrapped.get(builder)
    if (cached) return cached
    const proxy = new Proxy(builder, {
      get(target, property) {
        if (property === 'get') return async () =>
          (await (typeof target.limit === 'function' ? target.limit(1) : target))[0]
        if (property === 'all') return async () => await target
        if (property === 'run') return async () => {
          const result = await target
          const header = Array.isArray(result) ? result[0] : result
          if (header && typeof header === 'object' && 'affectedRows' in header) {
            return { ...header, changes: header.affectedRows }
          }
          return result
        }
        if (property === 'onConflictDoUpdate' && !Reflect.has(target, property)) {
          return (config: { set: Record<string, unknown> }) =>
            wrapBuilder(target.onDuplicateKeyUpdate({ set: config.set }))
        }
        if (property === 'onConflictDoNothing' && !Reflect.has(target, property)) {
          return () => {
            const columns = Object.entries(getTableColumns(target.config.table as MySqlTable))
            const [key, column] = columns.find(([, column]) => column.primary) ?? columns[0]
            return wrapBuilder(target.onDuplicateKeyUpdate({ set: { [key]: sql`${column}` } }))
          }
        }
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (property === 'then' || property === 'catch' || property === 'finally') return value.bind(target)
        return (...args: unknown[]) => wrapBuilder(value.apply(target, args))
      },
    })
    wrapped.set(builder, proxy)
    return proxy
  }

  const wrapDatabase = (database: any, root = false): any => new Proxy(database, {
    get(target, property) {
      const source = root ? transactionContext.getStore() ?? target : target
      if (property === 'transaction') {
        return (callback: (tx: DB) => Promise<unknown>, config?: unknown) =>
          source.transaction(
            (tx: unknown) => transactionContext.run(tx, () => callback(wrapDatabase(tx))),
            config,
          )
      }
      const value = Reflect.get(source, property, source)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => wrapBuilder(value.apply(source, args))
    },
  })

  const database = wrapDatabase(mysqlDatabase, true)
  return {
    database,
    close: async () => pool.end(),
    pool,
    outsideTransaction: <T>(operation: () => T) => transactionContext.exit(operation),
  }
}

const runtime = dbDialect === 'mysql' ? createMysqlDatabase() : createSqliteDatabase()

export type DB = SqliteRemoteDatabase<typeof schema>
export const db = runtime.database as unknown as DB
export const mysqlPool = 'pool' in runtime ? runtime.pool : undefined

if (dbDialect === 'mysql') {
  await mysqlPool!.query('SELECT 1')
}

export async function closeDb() {
  await runtime.close()
}

/** Background work must not inherit the transaction of the request scheduling it. */
export function outsideTransaction<T>(operation: () => T): T {
  return runtime.outsideTransaction(operation)
}

/** Normalize the insert metadata returned by sqlite-proxy and mysql2. */
export function getInsertId(result: unknown) {
  const raw = Array.isArray(result) ? result[0] : result
  const res = raw as { lastInsertRowid?: number | bigint; insertId?: number | bigint } | undefined
  const value = res?.insertId ?? res?.lastInsertRowid
  if (value === undefined || value === null) {
    throw new Error(`Database insert did not return an insert id (${dbDialect})`)
  }
  return Number(value)
}

export function getAffectedRows(result: unknown) {
  const raw = Array.isArray(result) ? result[0] : result
  const res = raw as { changes?: number; affectedRows?: number } | undefined
  return Number(res?.changes ?? res?.affectedRows ?? 0)
}
