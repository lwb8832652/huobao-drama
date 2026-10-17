import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

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
const listeners = new Set<() => void | Promise<void>>()
export class QueueSettingsError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
export function onQueueSettingsChange(listener: () => void | Promise<void>) { listeners.add(listener); return () => listeners.delete(listener) }
async function changed() {
  for (const listener of listeners) {
    try { await listener() } catch (error: any) { console.error('Queue settings notification:', error.message) }
  }
}
async function readJson(key: string) {
  const row = await db.select({ value: schema.appSettings.value }).from(schema.appSettings)
    .where(eq(schema.appSettings.key, key)).get()
  try { return row ? JSON.parse(row.value) : {} } catch { return {} }
}
export async function readProductionSettings(): Promise<ProductionQueueSettings> {
  const parsed = productionSchema.safeParse({ ...productionDefaults, ...await readJson(PRODUCTION_KEY) })
  return parsed.success ? parsed.data : structuredClone(productionDefaults)
}
export async function readEvaluationSettings(): Promise<EvaluationQueueSettings> {
  const parsed = evaluationSchema.safeParse({ ...evaluationDefaults, ...await readJson(EVALUATION_KEY) })
  return parsed.success ? parsed.data : { ...evaluationDefaults }
}
async function save(key: string, input: ProductionQueueSettings | EvaluationQueueSettings, current: () => Promise<{ revision: number }>) {
  const result = await db.transaction(async tx => {
    // Insert/upsert locks this settings row before the revision read on MySQL,
    // including the first save when no row exists yet.
    await tx.insert(schema.appSettings).values({
      key, value: '{}', updatedAt: new Date().toISOString(),
    }).onConflictDoNothing().run()
    if ((await current()).revision !== input.revision) throw new QueueSettingsError('设置已更新，请重新读取后保存', 409)
    const value = { ...input, revision: input.revision + 1 }
    await tx.update(schema.appSettings).set({
      value: JSON.stringify(value), updatedAt: new Date().toISOString(),
    }).where(eq(schema.appSettings.key, key)).run()
    return value
  })
  await changed()
  return result
}
export async function saveProductionSettings(input: unknown): Promise<ProductionQueueSettings> {
  const parsed = productionSchema.safeParse(input)
  if (!parsed.success) throw new QueueSettingsError(`任务设置字段无效：${parsed.error.issues.map(i => i.message).join('；')}`)
  const seen = new Set<number>(), groups = new Set<string>()
  for (const group of parsed.data.quotaGroups) {
    if (groups.has(group.id)) throw new QueueSettingsError('服务商配额组编号不能重复')
    groups.add(group.id)
    for (const id of group.configIds) {
      if (seen.has(id)) throw new QueueSettingsError('一个模型配置只能属于一个配额组')
      seen.add(id)
    }
  }
  if (seen.size) {
    const rows = await db.select({ id: schema.aiServiceConfigs.id }).from(schema.aiServiceConfigs)
      .where(inArray(schema.aiServiceConfigs.id, [...seen])).all()
    const existing = new Set(rows.map(row => row.id))
    if ([...seen].some(id => !existing.has(id))) throw new QueueSettingsError('配额组包含不存在的模型配置')
  }
  return (await save(PRODUCTION_KEY, parsed.data, readProductionSettings)) as ProductionQueueSettings
}
export async function saveEvaluationSettings(input: unknown): Promise<EvaluationQueueSettings> {
  const parsed = evaluationSchema.safeParse(input)
  if (!parsed.success) throw new QueueSettingsError(`评测设置字段无效：${parsed.error.issues.map(i => i.message).join('；')}`)
  return (await save(EVALUATION_KEY, parsed.data, readEvaluationSettings)) as EvaluationQueueSettings
}
export async function patchLegacyEvaluationSettings(input: unknown) {
  const parsed = z.object({ enabled: z.boolean(), threshold: z.number().int().min(0).max(100) }).strict().parse(input)
  const saved = await saveEvaluationSettings({ ...await readEvaluationSettings(), ...parsed })
  return { enabled: saved.enabled, threshold: saved.threshold }
}
