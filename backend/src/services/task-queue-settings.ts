import { z } from 'zod'
import { db } from '../db/index.js'

const count = z.number().int().min(1).max(32)
const quotaGroup = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(80),
  limit: count, configIds: z.array(z.number().int().positive()).min(1).max(100) }).strict()
const productionSchema = z.object({ revision: z.number().int().nonnegative(), total: count, image: count,
  video: count, planning: count, local: count, paused: z.boolean(), quotaGroups: z.array(quotaGroup).max(100) }).strict()
const evaluationSchema = z.object({ revision: z.number().int().nonnegative(), concurrency: count,
  paused: z.boolean(), enabled: z.boolean(), threshold: z.number().int().min(0).max(100) }).strict()
export type ProductionQueueSettings = z.infer<typeof productionSchema>
export type EvaluationQueueSettings = z.infer<typeof evaluationSchema>
const PRODUCTION_KEY = 'task_queue_settings', EVALUATION_KEY = 'continuity_review_settings'
const productionDefaults: ProductionQueueSettings = { revision: 0, total: 6, image: 2, video: 2,
  planning: 1, local: 1, paused: false, quotaGroups: [] }
const evaluationDefaults: EvaluationQueueSettings = { revision: 0, concurrency: 1, paused: false, enabled: false, threshold: 70 }
const listeners = new Set<() => void>()
export class QueueSettingsError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
export function onQueueSettingsChange(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) }
function changed() {
  for (const listener of listeners) {
    try { listener() } catch (error: any) { console.error('Queue settings notification:', error.message) }
  }
}
function readJson(key: string) {
  const row = db.$client.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  try { return row ? JSON.parse(row.value) : {} } catch { return {} }
}
export function readProductionSettings(): ProductionQueueSettings {
  const parsed = productionSchema.safeParse({ ...productionDefaults, ...readJson(PRODUCTION_KEY) })
  return parsed.success ? parsed.data : structuredClone(productionDefaults)
}
export function readEvaluationSettings(): EvaluationQueueSettings {
  const parsed = evaluationSchema.safeParse({ ...evaluationDefaults, ...readJson(EVALUATION_KEY) })
  return parsed.success ? parsed.data : { ...evaluationDefaults }
}
function save(key: string, input: ProductionQueueSettings | EvaluationQueueSettings, current: () => { revision: number }) {
  const result = db.$client.transaction(() => {
    if (current().revision !== input.revision) throw new QueueSettingsError('设置已更新，请重新读取后保存', 409)
    const value = { ...input, revision: input.revision + 1 }
    db.$client.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString())
    return value
  }).immediate()
  changed()
  return result
}
export function saveProductionSettings(input: unknown): ProductionQueueSettings {
  const parsed = productionSchema.safeParse(input)
  if (!parsed.success) throw new QueueSettingsError(`任务设置字段无效：${parsed.error.issues.map(i => i.message).join('；')}`)
  const seen = new Set<number>(), groups = new Set<string>()
  for (const group of parsed.data.quotaGroups) {
    if (groups.has(group.id)) throw new QueueSettingsError('服务商配额组编号不能重复')
    groups.add(group.id)
    for (const id of group.configIds) {
      if (seen.has(id)) throw new QueueSettingsError('一个模型配置只能属于一个配额组')
      seen.add(id)
      if (!db.$client.prepare('SELECT id FROM ai_service_configs WHERE id=?').get(id)) throw new QueueSettingsError('配额组包含不存在的模型配置')
    }
  }
  return save(PRODUCTION_KEY, parsed.data, readProductionSettings) as ProductionQueueSettings
}
export function saveEvaluationSettings(input: unknown): EvaluationQueueSettings {
  const parsed = evaluationSchema.safeParse(input)
  if (!parsed.success) throw new QueueSettingsError(`评测设置字段无效：${parsed.error.issues.map(i => i.message).join('；')}`)
  return save(EVALUATION_KEY, parsed.data, readEvaluationSettings) as EvaluationQueueSettings
}
export function patchLegacyEvaluationSettings(input: unknown) {
  const parsed = z.object({ enabled: z.boolean(), threshold: z.number().int().min(0).max(100) }).strict().parse(input)
  const saved = saveEvaluationSettings({ ...readEvaluationSettings(), ...parsed })
  return { enabled: saved.enabled, threshold: saved.threshold }
}
