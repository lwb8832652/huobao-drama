import 'dotenv/config'
/**
 * 把 SQLite 全量数据迁入 MySQL（npm run db:migrate:sqlite-to-mysql）。
 *
 * 设计要点：
 *  - 只读打开 SQLite（不影响正在运行的服务）
 *  - 列清单取自 SQLite（MySQL 列名与之 1:1 对应；生成列不在其中，不会误写）
 *  - 按列数计算批量大小，避免超过 20000 个占位符
 *  - 迁完逐表校验「行数」与「每列字符总长度」——后者能抓到静默截断
 *    （MySQL 实例 sql_mode 常为 IGNORE_SPACE 等非严格模式，超长会截断而不是报错）
 *
 * 参数：--verify-only 只校验不写入；--truncate 迁移前清空目标表（默认按表 DELETE）
 */
import Database from 'better-sqlite3'
import mysql from 'mysql2/promise'
import path from 'node:path'

// 脚本由 npm 在 backend 目录执行，故用 cwd 定位仓库根（ESM 作用域没有 __dirname）
const sqlitePath = process.env.SQLITE_PATH || path.resolve(process.cwd(), '../data/huobao.sqlite3')
const database = process.env.MYSQL_DATABASE || 'huobao_drama'
const verifyOnly = process.argv.includes('--verify-only')
const skipTruncate = process.argv.includes('--keep-existing')

function mysqlUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.MYSQL_HOST || '127.0.0.1'
  const port = process.env.MYSQL_PORT || '3306'
  const user = encodeURIComponent(process.env.MYSQL_USER || 'huobao')
  const password = encodeURIComponent(process.env.MYSQL_PASSWORD || 'huobao')
  return `mysql://${user}:${password}@${host}:${port}/${database}`
}

export async function verify(sqlite: Database.Database, pool: mysql.Pool): Promise<string[]> {
  const problems: string[] = []
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name)
  for (const table of tables) {
    // task_queue_cursors 是 worker 租约（token/pid/expires），服务运行时会持续改写，不参与一致性比对
    if (table === 'task_queue_cursors') continue
    const cols = (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(c => c.name)
    const [countRows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``) as any
    const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
    if (Number(countRows[0].n) !== sqliteCount) problems.push(`${table} 行数 sqlite=${sqliteCount} mysql=${countRows[0].n}`)
    for (const col of cols) {
      const sqliteLen = (sqlite.prepare(`SELECT COALESCE(SUM(LENGTH("${col}")),0) AS n FROM "${table}"`).get() as { n: number }).n
      const [mysqlLen] = await pool.query(`SELECT COALESCE(SUM(CHAR_LENGTH(\`${col}\`)),0) AS n FROM \`${table}\``) as any
      if (sqliteLen !== Number(mysqlLen[0].n)) problems.push(`${table}.${col} 内容长度 sqlite=${sqliteLen} mysql=${Number(mysqlLen[0].n)}`)
    }
  }
  return problems
}

async function main() {
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true })
  const pool = mysql.createPool({ uri: mysqlUrl(), connectionLimit: 4, charset: 'utf8mb4', supportBigNumbers: true })
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name)

  if (!verifyOnly) {
    let migrated = 0
    for (const table of tables) {
      const cols = (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(c => c.name)
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
      if (!skipTruncate) await pool.query(`DELETE FROM \`${table}\``)
      const perBatch = Math.max(1, Math.floor(20000 / cols.length))
      for (let i = 0; i < rows.length; i += perBatch) {
        const values = rows.slice(i, i + perBatch).map(row => cols.map(c => row[c] === undefined ? null : row[c]))
        await pool.query(`INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES ?`, [values])
      }
      migrated += rows.length
    }
    console.log(`已迁移 ${migrated} 行到 ${database}`)
  }

  const problems = await verify(sqlite, pool)
  console.log(problems.length ? `校验失败（${problems.length} 项）：\n` + problems.join('\n') : '校验通过：行数与所有列内容长度一致 ✅')
  await pool.end(); sqlite.close()
  if (problems.length) process.exit(1)
}

// 该文件既可作为入口执行，也被 verify 脚本 import；用 argv 判断，避免 ESM 下没有 require.main
if (/migrate-sqlite-to-mysql\.(ts|js)$/.test(process.argv[1] || '')) main().catch(error => { console.error(error); process.exit(1) })
