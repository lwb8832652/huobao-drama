import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame } from '../src/services/previs-domain.js'
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'evaluation-queue-')), 'test.sqlite3')
const { db, schema } = await import('../src/db/index.js')
const service = await import('../src/services/continuity-review.js')
const queue = await import('../src/services/task-queue.js')
const settings = await import('../src/services/task-queue-settings.js')
const ts = new Date().toISOString()
db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.aiServiceConfigs).values({ id: 1, name: 'test', serviceType: 'text', provider: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'test', model: '["mock"]', isActive: true, createdAt: ts, updatedAt: ts }).run()
let versionNo = 0
function version() {
  const panels = [1, 2].map(id => ({ id, title: '', description: '【镜头1】人物站在木门旁，望向窗外。', atmosphere: '', imagePrompt: '', videoPrompt: '', durationMs: 4000,
    sceneId: null, scene: '', shotType: '', angle: '', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '',
    frames: [{ ...makeFrame(`${id}`), url: `/static/${id}.png` }] }))
  return Number(db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: ++versionNo, timelineJson: JSON.stringify({ schemaVersion: 2, panels,
    groups: panels.map(p => ({ id: `g${p.id}`, title: '', note: '', panelIds: [p.id], entry: {}, exit: {} })),
    transitions: [{ from: 'g1', to: 'g2', type: 'cut', continuity: 'normal', allowedChanges: [] }], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
}
const result = { overallScore: 60, confidence: 'high' as const, summary: 'test',
  dimensions: Object.fromEntries(['subject','scene','action','camera'].map(key => [key, { score: 15, comment: 'test' }])) as any, issues: [], suggestions: [] }
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check())
}

test('manual evaluation enqueues immediately, deduplicates input, and shares the evaluation ceiling', async () => {
  assert.equal(typeof (service as any).enqueueContinuityReview, 'function', 'evaluation must have a queue admission entry')
  const first = version(), second = version()
  let calls = 0
  const releases: (() => void)[] = []
  const reviewer = async () => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return result }
  const a = await service.enqueueContinuityReview(first, { revision: 1, toGroupId: 'g2' }, reviewer)
  const duplicate = await service.enqueueContinuityReview(first, { revision: 1, toGroupId: 'g2', force: true }, reviewer)
  const b = await service.enqueueContinuityReview(second, { revision: 1, toGroupId: 'g2' }, reviewer)
  assert.equal(a.id, duplicate.id)
  await queue.tickTaskQueue(); await until(() => calls === 1)
  assert.equal(queue.queueStats().byKind.evaluation.active, 1)
  assert.equal(queue.getQueueJob('continuity_review', b.id)?.status, 'pending')
  releases.shift()!(); await until(() => calls === 2)
  releases.shift()!(); await until(() => queue.queueStats().active === 0)
})

test('disabling automatic evaluation cancels only queued automatic work; manual work still runs', async () => {
  assert.equal(typeof (service as any).enqueueContinuityReview, 'function')
  const original = settings.readEvaluationSettings()
  settings.saveEvaluationSettings({ ...original, enabled: true, paused: true })
  const auto = version(), manual = version()
  service.scheduleContinuityReviews(auto)
  await service.tickContinuityReviews(async () => result)
  const a = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, auto)).get()!
  const m = await service.enqueueContinuityReview(manual, { revision: 1, toGroupId: 'g2' }, async () => result)
  settings.saveEvaluationSettings({ ...settings.readEvaluationSettings(), enabled: false, paused: false })
  assert.equal(queue.getQueueJob('continuity_review', a.id)?.status, 'cancelled')
  await until(() => queue.getQueueJob('continuity_review', m.id)?.status === 'completed')
  assert.equal(db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, a.id)).get()!.status, 'cancelled')
})

test('AI planning and evaluations cannot bypass the shared global ceiling', async () => {
  const planning = await import('../src/services/previs-frames.js')
  settings.saveProductionSettings({ ...settings.readProductionSettings(), total: 1, paused: true })
  const id = version()
  const submitted = await planning.startFramePlan(id, { revision: 1, panelIds: [1], force: true, count: 3 })
  const row = queue.getQueueJob('frame_plan', submitted.taskIds[0])
  assert.ok(row, 'AI planning must have a durable queue record')
  assert.equal(row.kind, 'planning')
  assert.equal(row.status, 'pending')
  assert.equal(db.select().from(schema.framePlans).where(eq(schema.framePlans.id, submitted.taskIds[0])).get()!.status, 'pending')
})


test('disabling automatic evaluation before its first worker tick cancels pending business records', () => {
  settings.saveEvaluationSettings({ ...settings.readEvaluationSettings(), enabled: true, paused: true })
  const id = version()
  service.scheduleContinuityReviews(id)
  const row = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, id)).get()!
  assert.equal(row.status, 'pending')
  assert.equal(queue.getQueueJob('continuity_review', row.id), undefined)
  settings.saveEvaluationSettings({ ...settings.readEvaluationSettings(), enabled: false })
  assert.equal(db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, row.id)).get()!.status, 'cancelled')
})

test('recovery preserves an already committed evaluation result without resubmitting', async () => {
  settings.saveEvaluationSettings({ ...settings.readEvaluationSettings(), paused: true })
  const id = version()
  const task = await service.enqueueContinuityReview(id, { revision: 1, toGroupId: 'g2' }, async () => result)
  db.update(schema.continuityReviews).set({ status: 'completed', resultJson: JSON.stringify(result), finishedAt: ts }).where(eq(schema.continuityReviews.id, task.id)).run()
  db.$client.prepare("UPDATE task_queue_jobs SET status='processing',submitted=1,upstream_done=1 WHERE owner_type='continuity_review' AND owner_id=?").run(task.id)
  await queue.recoverTaskQueue()
  await until(() => queue.getQueueJob('continuity_review', task.id)?.status === 'completed')
  assert.equal(service.listContinuityReviewTasks(id).summary.completed, 1)
})


test('a planning crash before submission resets its business claim and safely resumes rule planning', async () => {
  const planning = await import('../src/services/previs-frames.js')
  for (const row of db.$client.prepare("SELECT id FROM task_queue_jobs WHERE status='pending'").all() as any[]) queue.cancelQueueJob(row.id)
  const id = version()
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: true })
  const task = await planning.startFramePlan(id, { revision: 1, panelIds: [1], count: 3, force: true })
  const job = queue.getQueueJob('frame_plan', task.taskIds[0])!
  db.update(schema.framePlans).set({ status: 'processing', configId: 0 }).where(eq(schema.framePlans.id, job.ownerId)).run()
  db.$client.prepare("UPDATE task_queue_jobs SET status='processing',submitted=0,config_id=0,snapshot_json='{}' WHERE id=?").run(job.id)
  await queue.recoverTaskQueue()
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: false })
  await until(() => queue.getQueueJobById(job.id)?.status === 'completed')
  assert.equal(db.select().from(schema.framePlans).where(eq(schema.framePlans.id, job.ownerId)).get()!.status, 'completed')
})
