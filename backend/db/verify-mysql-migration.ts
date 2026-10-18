import 'dotenv/config'
/**
 * 校验 SQLite 与 MySQL 的数据一致性（npm run db:verify:mysql）。
 * 复用 migrate-sqlite-to-mysql 的校验逻辑：逐表行数 + 逐列字符总长度。
 */
import Database from 'better-sqlite3'
import mysql from 'mysql2/promise'
import path from 'node:path'
import { verify } from './migrate-sqlite-to-mysql.js'

// 脚本由 npm 在 backend 目录执行，故用 cwd 定位仓库根（ESM 作用域没有 __dirname）
const sqlitePath = process.env.SQLITE_PATH || path.resolve(process.cwd(), '../data/huobao.sqlite3')
const database = process.env.MYSQL_DATABASE || 'huobao_drama'

function mysqlUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.MYSQL_HOST || '127.0.0.1'
  const port = process.env.MYSQL_PORT || '3306'
  const user = encodeURIComponent(process.env.MYSQL_USER || 'huobao')
  const password = encodeURIComponent(process.env.MYSQL_PASSWORD || 'huobao')
  return `mysql://${user}:${password}@${host}:${port}/${database}`
}

async function main() {
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true })
  const pool = mysql.createPool({ uri: mysqlUrl(), connectionLimit: 2, charset: 'utf8mb4' })
  const problems = await verify(sqlite, pool)
  console.log(problems.length ? `发现 ${problems.length} 处不一致：\n` + problems.join('\n') : 'SQLite 与 MySQL 数据一致 ✅')
  await pool.end(); sqlite.close()
  if (problems.length) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
