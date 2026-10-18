import 'dotenv/config'
/**
 * 从现有 SQLite 结构生成 MySQL DDL 并执行（npm run db:migrate:mysql）。
 *
 * 为什么不是 drizzle-kit：项目只维护一份 sqlite schema，MySQL 侧由结构推导，
 * 避免两份手写 schema 漂移。映射规则：
 *  - INTEGER → INT（主键自增），REAL → DOUBLE，BLOB → LONGBLOB
 *  - TEXT → LONGTEXT（MySQL 的 TEXT 只有 64KB，且实例 sql_mode 非严格时会静默截断）
 *  - 参与索引/唯一键/主键的 TEXT → VARCHAR(191)（MySQL 要求索引列定长）
 *  - 表级 UNIQUE(...) 原样保留
 *  - 部分唯一索引（SQLite 的 WHERE 条件）用「生成列 + 唯一索引」复刻，
 *    因为 MySQL 不支持部分索引；NULL 不参与唯一，语义等价
 *  - 索引列方向（DESC）忽略（升序索引可反向扫描，部分兼容实现不接受列方向声明）
 */
import Database from 'better-sqlite3'
import mysql from 'mysql2/promise'
import path from 'node:path'

// 脚本由 npm 在 backend 目录执行，故用 cwd 定位仓库根（ESM 作用域没有 __dirname）
const sqlitePath = process.env.SQLITE_PATH || path.resolve(process.cwd(), '../data/huobao.sqlite3')
const database = process.env.MYSQL_DATABASE || 'huobao_drama'
const shouldDrop = process.argv.includes('--drop')

function mysqlUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const host = process.env.MYSQL_HOST || '127.0.0.1'
  const port = process.env.MYSQL_PORT || '3306'
  const user = encodeURIComponent(process.env.MYSQL_USER || 'huobao')
  const password = encodeURIComponent(process.env.MYSQL_PASSWORD || 'huobao')
  return `mysql://${user}:${password}@${host}:${port}/${database}`
}

function splitTopLevel(body: string) {
  const parts: string[] = []
  let depth = 0, quote: string | null = null, cur = ''
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

export function buildMysqlDdl(sqlitePath: string): { statements: string[]; tables: number; indexes: number } {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true })
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
  const indexes = db.prepare("SELECT name, tbl_name AS tblName, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name").all() as { name: string; tblName: string; sql: string }[]

  const indexed = new Set<string>()
  const tableDefs: { name: string; defs: string[] }[] = []
  for (const t of tables) {
    const body = t.sql.slice(t.sql.indexOf('(') + 1, t.sql.lastIndexOf(')'))
    const defs = splitTopLevel(body)
    tableDefs.push({ name: t.name, defs })
    for (const d of defs) {
      const unique = /^UNIQUE\s*\(([^)]*)\)/i.exec(d)
      if (unique) for (const c of unique[1].split(',')) indexed.add(`${t.name}.${c.trim()}`)
      const colDef = /^["`]?(\w+)["`]?\s+(INTEGER|REAL|TEXT|BLOB)\b(.*)$/i.exec(d)
      if (colDef && /\b(UNIQUE|PRIMARY\s+KEY)\b/i.test(colDef[3])) indexed.add(`${t.name}.${colDef[1]}`)
    }
  }
  for (const ix of indexes) {
    const m = /\(([^)]*)\)/.exec(ix.sql)
    if (m) for (const c of m[1].split(',')) indexed.add(`${ix.tblName}.${c.trim().replace(/\s+(ASC|DESC)$/i, '')}`)
  }

  const statements: string[] = []
  for (const { name: table, defs } of tableDefs) {
    const cols: string[] = []
    const uniques: string[] = []
    for (const line of defs) {
      if (/^UNIQUE\s*\(/i.test(line)) { uniques.push(line); continue }
      if (/^(FOREIGN|CONSTRAINT|PRIMARY KEY\s*\()/i.test(line)) continue
      const m = /^["`]?(\w+)["`]?\s+(INTEGER|REAL|TEXT|BLOB)(.*)$/i.exec(line)
      if (!m) throw new Error(`无法解析 ${table} 的列定义：${line}`)
      const [, col, type, rest] = m
      const autoIncrement = /PRIMARY KEY AUTOINCREMENT/i.test(rest)
      const primary = /PRIMARY KEY/i.test(rest) && !autoIncrement
      const notNull = /NOT NULL/i.test(rest) || autoIncrement || primary
      const def = /DEFAULT\s+('(?:[^']|'')*'|[\d.]+)/i.exec(rest)
      const mysqlType = /INTEGER/i.test(type) ? 'INT'
        : /REAL/i.test(type) ? 'DOUBLE'
          : /BLOB/i.test(type) ? 'LONGBLOB'
            : indexed.has(`${table}.${col}`) ? 'VARCHAR(191)' : 'LONGTEXT'
      let colSql = `  \`${col}\` ${mysqlType}`
      if (notNull) colSql += ' NOT NULL'
      if (def) colSql += (mysqlType === 'LONGTEXT' || mysqlType === 'LONGBLOB') ? ` DEFAULT (${def[1]})` : ` DEFAULT ${def[1]}`
      if (autoIncrement) colSql += ' AUTO_INCREMENT'
      if (autoIncrement || primary) colSql += ' PRIMARY KEY'
      cols.push(colSql)
    }
    for (const u of uniques) cols.push(`  ${u.replace(/^UNIQUE/i, 'UNIQUE KEY')}`)
    statements.push(`CREATE TABLE IF NOT EXISTS \`${table}\` (\n${cols.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`)
  }
  for (const ix of indexes) {
    const m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)(\s+WHERE\s+(.+))?$/is.exec(ix.sql.trim())
    if (!m) throw new Error(`无法解析索引 ${ix.name}：${ix.sql}`)
    const [, unique, name, table, colsRaw, , where] = m
    const cols = colsRaw.split(',').map(c => c.trim().replace(/\s+(ASC|DESC)$/i, ''))
    const colList = cols.map(c => `\`${c}\``).join(', ')
    if (unique && where) {
      const cond = where.trim()
      const isNotNull = /^(\w+)\s+IS\s+NOT\s+NULL$/i.exec(cond)
      if (isNotNull && cols.length === 1 && cols[0] === isNotNull[1]) {
        statements.push(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${name}\` (${colList});`)
      } else {
        statements.push(`ALTER TABLE \`${table}\` ADD COLUMN \`_${name}_key\` VARCHAR(255) GENERATED ALWAYS AS (IF(${cond}, CONCAT_WS('|', ${cols.map(c => `\`${c}\``).join(', ')}), NULL)) VIRTUAL, ADD UNIQUE INDEX \`${name}\` (\`_${name}_key\`);`)
      }
      continue
    }
    statements.push(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${colList});`)
  }
  db.close()
  return { statements, tables: tables.length, indexes: indexes.length }
}

async function main() {
  const { statements, tables, indexes } = buildMysqlDdl(sqlitePath)
  const pool = mysql.createPool({ uri: mysqlUrl(), connectionLimit: 2, charset: 'utf8mb4' })
  if (shouldDrop) await pool.query(`DROP DATABASE IF EXISTS \`${database}\``)
  await pool.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
  await pool.query(`USE \`${database}\``)
  let ok = 0
  const failures: string[] = []
  for (const statement of statements) {
    try { await pool.query(statement); ok++ }
    catch (error: any) { failures.push(`[${error.code}] ${error.message} :: ${statement.slice(0, 60).replace(/\n/g, ' ')}`) }
  }
  console.log(`MySQL 结构: ${ok}/${statements.length} 条语句成功（表 ${tables}、索引 ${indexes}，库 ${database}）`)
  if (failures.length) { console.error('失败：\n' + failures.join('\n')); await pool.end(); process.exit(1) }
  await pool.end()
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1) })
