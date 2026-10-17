/**
 * 应用级全局设置（app_settings key-value 表）
 * AI 内容语言：所有 Agent 产出（剧本/提取/分镜/提示词）统一使用的目标语言
 * 层次约束：本模块只依赖 db，严禁反向 import agents/*（agents/context.ts 会引用本模块）
 *
 * 所有数据库访问统一为异步 API，以兼容 SQLite 与 MySQL。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export const CONTENT_LANGUAGES = ['zh', 'en', 'ja', 'ko'] as const
export type ContentLanguage = typeof CONTENT_LANGUAGES[number]

const CONTENT_LANGUAGE_KEY = 'content_language'

function isContentLanguage(v: unknown): v is ContentLanguage {
  return typeof v === 'string' && (CONTENT_LANGUAGES as readonly string[]).includes(v)
}

/** 读取全局内容语言；未设置或值非法时回退 'zh'（保持历史默认行为） */
export async function getContentLanguage(): Promise<ContentLanguage> {
  const row = (await db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONTENT_LANGUAGE_KEY))
    .get())
  return isContentLanguage(row?.value) ? row.value : 'zh'
}

/** 写入全局内容语言（upsert） */
export async function setContentLanguage(lang: ContentLanguage): Promise<ContentLanguage> {
  if (!isContentLanguage(lang)) throw new Error(`Invalid content language: ${lang}`)
  ;await db.insert(schema.appSettings)
    .values({ key: CONTENT_LANGUAGE_KEY, value: lang, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: lang, updatedAt: now() },
    })
    .run()
  return lang
}

const TOURS_SEEN_KEY = 'tours_seen'
const MAX_TOURS_SEEN = 64

function sanitizeTourIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter(v => typeof v === 'string' && v.length > 0 && v.length <= 100))].slice(0, MAX_TOURS_SEEN)
}

/** 已看过的引导漫游 id 列表（JSON 数组存储）；桌面端端口随启动变化，localStorage 不可靠，故落库 */
export async function getToursSeen(): Promise<string[]> {
  const row = (await db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, TOURS_SEEN_KEY))
    .get())
  try { return sanitizeTourIds(JSON.parse(row?.value || '[]')) } catch { return [] }
}

/** 写入已看过的引导漫游 id 列表（upsert） */
export async function setToursSeen(ids: unknown): Promise<string[]> {
  const clean = sanitizeTourIds(ids)
  const value = JSON.stringify(clean)
  ;await db.insert(schema.appSettings)
    .values({ key: TOURS_SEEN_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return clean
}
