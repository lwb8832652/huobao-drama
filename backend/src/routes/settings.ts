/**
 * 应用设置路由 — 全局配置的读写入口（当前：AI 内容语言）
 */
import { Hono } from 'hono'
import { getContentLanguage, setContentLanguage, getToursSeen, setToursSeen, CONTENT_LANGUAGES, type ContentLanguage } from '../services/app-settings.js'
import { success, badRequest } from '../utils/response.js'
import { readProductionSettings, saveProductionSettings, readEvaluationSettings, saveEvaluationSettings, QueueSettingsError } from '../services/task-queue-settings.js'
import { queueStats } from '../services/task-queue.js'

const app = new Hono()

app.get('/task-queue', c => success(c, { ...readProductionSettings(), stats: queueStats() }))
app.put('/task-queue', async c => {
  try { return success(c, { ...saveProductionSettings(await c.req.json()), stats: queueStats() }) }
  catch (error: any) {
    return c.json({ code: error instanceof QueueSettingsError ? error.status : 400, message: error.message || '任务设置无效' }, error instanceof QueueSettingsError && error.status === 409 ? 409 : 400)
  }
})
app.get('/evaluation-tasks', c => success(c, { ...readEvaluationSettings(), globalTotal: readProductionSettings().total, stats: queueStats() }))
app.put('/evaluation-tasks', async c => {
  try { return success(c, { ...saveEvaluationSettings(await c.req.json()), globalTotal: readProductionSettings().total, stats: queueStats() }) }
  catch (error: any) {
    return c.json({ code: error instanceof QueueSettingsError ? error.status : 400, message: error.message || '评测设置无效' }, error instanceof QueueSettingsError && error.status === 409 ? 409 : 400)
  }
})

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

export default app
