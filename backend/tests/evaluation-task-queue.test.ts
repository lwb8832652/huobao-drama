import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {eq, sql} from 'drizzle-orm'
import { defaultStrategy, makeFrame } from '../src/services/previs-domain.js'
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'evaluation-queue-')), 'test.sqlite3')
const { db, schema } = await import('../src/db/index.js')

// 还原后的 db 是 drizzle sqlite-proxy 异步封装，不再暴露 better-sqlite3 的 $client；
// 测试里的裸 SQL 改为统一的 raw 执行入口（? 占位按字面量内联，仅测试使用）。
const lit = (v: any) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const build = (text: string, args: any[]) => { let out = text; for (const a of args) out = out.replace('?', lit(a)); return sql.raw(out) }
const rawRun = async (text: string, ...args: any[]) => {
  // 多语句按分号拆分执行（CREATE TRIGGER 这类含 BEGIN...END 的整段执行）
  if (/\bbegin\b/i.test(text) && /\bend\b/i.test(text)) { await db.run(build(text, args)); return }
  let taken = 0
  for (const part of text.split(';')) {
    if (!part.trim()) continue
    const used = (part.match(/\?/g) ?? []).length
    await db.run(build(part.trim(), args.slice(taken, taken + used)))
    taken += used
  }
}
const rawAll = async (text: string, ...args: any[]) => (await db.all(build(text, args))) as any[]
const rawGet = async (text: string, ...args: any[]) => (await db.get(build(text, args))) as any

const service = await import('../src/services/continuity-review.js')
const queue = await import('../src/services/task-queue.js')
const settings = await import('../src/services/task-queue-settings.js')
const ts = new Date().toISOString()
await db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.aiServiceConfigs).values({ id: 1, name: 'test', serviceType: 'text', provider: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'test', model: '["mock"]', isActive: true, createdAt: ts, updatedAt: ts }).run()
let versionNo = 0
async function version() {
  const panels = [1, 2].map(id => ({ id, title: '', description: '【镜头1】人物站在木门旁，望向窗外。', atmosphere: '', imagePrompt: '', videoPrompt: '', durationMs: 4000,
    sceneId: null, scene: '', shotType: '', angle: '', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '',
    frames: [{ ...makeFrame(`${id}`), url: `/static/${id}.png` }] }))
  return Number((await db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: ++versionNo, timelineJson: JSON.stringify({ schemaVersion: 2, panels,
    groups: panels.map(p => ({ id: `g${p.id}`, title: '', note: '', panelIds: [p.id], entry: {}, exit: {} })),
    transitions: [{ from: 'g1', to: 'g2', type: 'cut', continuity: 'normal', allowedChanges: [] }], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run()).lastInsertRowid)
}
const result = { overallScore: 60, confidence: 'high' as const, summary: 'test',
  dimensions: Object.fromEntries(['subject','scene','action','camera'].map(key => [key, { score: 15, comment: 'test' }])) as any, issues: [], suggestions: [] }
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(await check())
}

test('manual evaluation enqueues immediately, deduplicates input, and shares the evaluation ceiling', async () => {
  assert.equal(typeof (service as any).enqueueContinuityReview, 'function', 'evaluation must have a queue admission entry')
  const first = (await version()), second = (await version())
  let calls = 0
  const releases: (() => void)[] = []
  const reviewer = async () => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return result }
  const a = await service.enqueueContinuityReview(first, { revision: 1, toGroupId: 'g2' }, reviewer)
  const duplicate = await service.enqueueContinuityReview(first, { revision: 1, toGroupId: 'g2', force: true }, reviewer)
  const b = await service.enqueueContinuityReview(second, { revision: 1, toGroupId: 'g2' }, reviewer)
  assert.equal(a.id, duplicate.id)
  await queue.tickTaskQueue(); await until(async () => calls === 1)
  assert.equal((await queue.queueStats()).byKind.evaluation.active, 1)
  assert.equal((await queue.getQueueJob('continuity_review', b.id))?.status, 'pending')
  releases.shift()!(); await until(async () => calls === 2)
  releases.shift()!(); await until(async () => (await queue.queueStats()).active === 0)
})

test('disabling automatic evaluation cancels only queued automatic work; manual work still runs', async () => {
  assert.equal(typeof (service as any).enqueueContinuityReview, 'function')
  const original = (await settings.readEvaluationSettings())
  await settings.saveEvaluationSettings({ ...original, enabled: true, paused: true })
  const auto = (await version()), manual = (await version())
  await service.scheduleContinuityReviews(auto)
  await service.tickContinuityReviews(async () => result)
  const a = await db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, auto)).get()!
  const m = await service.enqueueContinuityReview(manual, { revision: 1, toGroupId: 'g2' }, async () => result)
  await settings.saveEvaluationSettings({ ...(await settings.readEvaluationSettings()), enabled: false, paused: false })
  assert.equal((await queue.getQueueJob('continuity_review', a.id))?.status, 'cancelled')
  await until(async () => (await queue.getQueueJob('continuity_review', m.id))?.status === 'completed')
  assert.equal((await db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, a.id)).get()!).status, 'cancelled')
})

test('AI planning and evaluations cannot bypass the shared global ceiling', async () => {
  const planning = await import('../src/services/previs-frames.js')
  settings.saveProductionSettings({ ...(await settings.readProductionSettings()), total: 1, paused: true })
  const id = (await version())
  const submitted = await planning.startFramePlan(id, { revision: 1, panelIds: [1], force: true, count: 3 })
  const row = await queue.getQueueJob('frame_plan', submitted.taskIds[0])
  assert.ok(row, 'AI planning must have a durable queue record')
  assert.equal(row.kind, 'planning')
  assert.equal(row.status, 'pending')
  assert.equal((await db.select().from(schema.framePlans).where(eq(schema.framePlans.id, submitted.taskIds[0])).get()!).status, 'pending')
})


test('disabling automatic evaluation before its first worker tick cancels pending business records', async () => {
  await settings.saveEvaluationSettings({ ...(await settings.readEvaluationSettings()), enabled: true, paused: true })
  const id = (await version())
  await service.scheduleContinuityReviews(id)
  const row = await db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, id)).get()!
  assert.equal(row.status, 'pending')
  assert.equal(await queue.getQueueJob('continuity_review', row.id), undefined)
  await settings.saveEvaluationSettings({ ...(await settings.readEvaluationSettings()), enabled: false })
  assert.equal((await db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, row.id)).get()!).status, 'cancelled')
})

test('recovery preserves an already committed evaluation result without resubmitting', async () => {
  await settings.saveEvaluationSettings({ ...(await settings.readEvaluationSettings()), paused: true })
  const id = (await version())
  const task = await service.enqueueContinuityReview(id, { revision: 1, toGroupId: 'g2' }, async () => result)
  await db.update(schema.continuityReviews).set({ status: 'completed', resultJson: JSON.stringify(result), finishedAt: ts }).where(eq(schema.continuityReviews.id, task.id)).run()
  await rawRun("UPDATE task_queue_jobs SET status='processing',submitted=1,upstream_done=1 WHERE owner_type='continuity_review' AND owner_id=?", task.id)
  await queue.recoverTaskQueue()
  await until(async () => (await queue.getQueueJob('continuity_review', task.id))?.status === 'completed')
  assert.equal((await service.listContinuityReviewTasks(id)).summary.completed, 1)
})


test('a planning crash before submission resets its business claim and safely resumes rule planning', async () => {
  const planning = await import('../src/services/previs-frames.js')
  // rawAll 走 sqlite-proxy 的 raw 模式，行是位置数组而非对象
  for (const [id] of await rawAll("SELECT id FROM task_queue_jobs WHERE status='pending'") as any[]) await queue.cancelQueueJob(id)
  const id = (await version())
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), paused: true })
  const task = await planning.startFramePlan(id, { revision: 1, panelIds: [1], count: 3, force: true })
  const job = await queue.getQueueJob('frame_plan', task.taskIds[0])!
  await db.update(schema.framePlans).set({ status: 'processing', configId: 0 }).where(eq(schema.framePlans.id, job.ownerId)).run()
  await rawRun("UPDATE task_queue_jobs SET status='processing',submitted=0,config_id=0,snapshot_json='{}' WHERE id=?", job.id)
  await queue.recoverTaskQueue()
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), paused: false })
  await until(async () => (await queue.getQueueJobById(job.id))?.status === 'completed')
  assert.equal((await db.select().from(schema.framePlans).where(eq(schema.framePlans.id, job.ownerId)).get()!).status, 'completed')
})
