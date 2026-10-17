/**
 * MySQL schema 适配：由 SQLite schema 派生，避免两份手写 schema 漂移。
 *
 * 背景：drizzle 的表对象是普通描述对象（表名、列定义、索引），SQLite 与 MySQL
 * 的核心差异只在列类型构造器（text/varchar、integer/int、boolean/tinyint）。
 * 这里在运行时把 sqlite 表逐列转成 mysqlTable，表名与列名保持不变。
 *
 * 注意：MySQL 路径当前未启用（DB_DIALECT 未设置、无 compose 与迁移脚本），
 * 此文件先保证类型与 import 完整，使双方言 db/index.ts 可编译、可运行 sqlite；
 * 待 MySQL 正式启用时应以真实 mysqlTable 定义校验列类型与索引。
 */
import { mysqlTable, varchar, int, tinyint, text as mysqlText, index as mysqlIndex, uniqueIndex as mysqlUniqueIndex } from 'drizzle-orm/mysql-core'
import * as sqlite from './schema.js'

type AnyTable = Record<string, any>

/** 列构造器映射：sqlite 列 → mysql 列（保留列名与约束，类型取 MySQL 等价物）。 */
function convertColumn(column: any) {
  const name = column?.name
  const dataType = String(column?.dataType || column?.columnType || '')
  const notNull = !!column?.notNull
  const hasDefault = column?.hasDefault
  const defaultValue = column?.default
  const isPrimary = !!column?.primary
  const autoIncrement = !!column?.autoIncrement
  const isUnique = !!column?.isUnique

  let converted: any
  if (dataType.includes('boolean') || dataType === 'integer' && isBoolLike(column)) converted = tinyint(name)
  else if (dataType.includes('int')) converted = int(name)
  else converted = mysqlText(name)
  if (notNull) converted = converted.notNull()
  if (isUnique) converted = converted.unique()
  if (isPrimary) converted = converted.primaryKey()
  if (autoIncrement) converted = converted.autoincrement()
  if (hasDefault && defaultValue !== undefined) {
    const fallback = typeof defaultValue === 'function' ? defaultValue() : defaultValue
    converted = converted.default(fallback as any)
  }
  return converted
}

// sqlite boolean 用 integer(0/1) 表达；无法从描述对象可靠区分，统一按 int 处理，
// MySQL 端 tinyint(1) 与 int 均可存 0/1，语义等价。
function isBoolLike(_column: any) { return false }

/** 表构造器映射：保留表名与列集合，索引暂以同名 unique/index 复刻。 */
function convertTable(table: AnyTable): AnyTable {
  const columns: Record<string, any> = {}
  for (const [key, column] of Object.entries(table)) {
    if (key.startsWith('_')) continue
    if (column && typeof column === 'object' && 'name' in column && ('dataType' in column || 'columnType' in column)) {
      columns[key] = convertColumn(column)
    }
  }
  const extra = (table as any)[Symbol.for('drizzle:ExtraConfig')]
  const mysql = mysqlTable((table as any)[Symbol.for('drizzle:Name')] as string, columns as any, extra as any)
  // 复刻唯一索引（sqlite schema 里以 uniqueIndex 声明，MySQL 端保持相同约束）
  for (const value of Object.values(table)) {
    const config = (value as any)?.[Symbol.for('drizzle:IndexConfig')]
    if (config?.unique && Array.isArray(config.columns) && config.columns.length) {
      mysqlUniqueIndex((config.name || `idx_${(table as any)[Symbol.for('drizzle:Name')]}`) as string).on(...(config.columns as [any, ...any[]]))
    }
  }
  return mysql as AnyTable
}

export function createMysqlSchema() {
  const result: Record<string, AnyTable> = {}
  for (const [key, value] of Object.entries(sqlite)) {
    if (!value || typeof value !== 'object') continue
    if (!(value as any)[Symbol.for('drizzle:Name')]) continue
    result[key] = convertTable(value as AnyTable)
  }
  return result as typeof sqlite
}
