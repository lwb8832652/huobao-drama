import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'global-queue-')), 'test.sqlite3')
const { db } = await import('../src/db/index.js')
const queue = await import('../src/services/task-queue.js').catch(() => null)
const settings = await import('../src/services/task-queue-settings.js').catch(() => null)
const started: number[] = [], releases = new Map<number, () => void>()
let cancelled = 0
const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), 'queue did not reach expected state')
}
if (queue) queue.registerQueueExecutor('sys_task', {
  execute: async job => {
    started.push(job.id)
    queue.updateQueueJob(job.id, { submitted: true, phase: 'upstream' })
    await new Promise<void>(resolve => releases.set(job.id, resolve))
    releases.delete(job.id)
    return { status: 'completed' }
  },
  recover: async job => {
    if (!job.externalTaskId) return { status: 'needs_confirmation' }
    started.push(job.id)
    await new Promise<void>(resolve => releases.set(job.id, resolve))
    releases.delete(job.id)
    return { status: 'completed' }
  },
  onCancel: () => { cancelled++ },
})
beforeEach(async () => {
  if (!queue || !settings) return
  db.$client.prepare("UPDATE task_queue_jobs SET status='cancelled' WHERE status='pending'").run()
  for (const release of releases.values()) release()
  await until(() => releases.size === 0)
  db.$client.exec('DELETE FROM task_queue_jobs; DELETE FROM task_queue_cursors; DELETE FROM app_settings')
  started.length = 0; cancelled = 0
  settings.saveProductionSettings({ revision: 0, total: 2, image: 2, video: 2, planning: 1, local: 1, paused: false, quotaGroups: [] })
})
after(() => { for (const release of releases.values()) release() })

function add(ownerId: number, kind: 'image' | 'video' | 'evaluation' = 'image', projectId = 1, configId = 1) {
  assert.ok(queue, 'persistent queue is not implemented')
  return queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId, kind, projectId, configId, inputHash: `input-${ownerId}` })
}

test('global ceiling applies across projects and job types; finishing starts the queued job', async () => {
  assert.ok(queue, 'persistent queue is not implemented')
  const first = add(1), second = add(2, 'video', 2), third = add(3, 'evaluation', 3)
  await queue.tickTaskQueue()
  await until(() => started.length === 2)
  assert.equal(queue.queueStats().active, 2)
  assert.equal(queue.queueStats().pending, 1)
  assert.ok([first, second, third].some(id => queue.getQueueJobById(id)?.status === 'pending'))
  releases.get(started[0])!()
  await until(() => started.length === 3)
  assert.equal(queue.queueStats().active, 2)
})

test('blocked videos at the head do not block an image in another project', async () => {
  assert.ok(queue && settings)
  settings.saveProductionSettings({ ...settings.readProductionSettings(), total: 2, video: 1 })
  add(1, 'video'); add(2, 'video'); const image = add(3, 'image', 2)
  await queue.tickTaskQueue(); await until(() => started.length === 2)
  assert.ok(started.includes(image))
  assert.equal(queue.getQueueJob('sys_task', 2)?.status, 'pending')
})

test('project rotation gives another project a turn before the first project batch drains', async () => {
  assert.ok(queue && settings)
  settings.saveProductionSettings({ ...settings.readProductionSettings(), total: 1 })
  const first = add(1); add(2); add(3); const other = add(4, 'image', 2)
  await queue.tickTaskQueue(); await until(() => started.length === 1)
  assert.equal(started[0], first)
  releases.get(first)!(); await until(() => started.length === 2)
  assert.equal(started[1], other)
})

test('production pause is independent of evaluation pause and settings are saved separately', async () => {
  assert.ok(queue && settings)
  const originalEval = settings.readEvaluationSettings()
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: true })
  assert.deepEqual(settings.readEvaluationSettings(), originalEval)
  add(1); const evaluation = add(2, 'evaluation')
  await queue.tickTaskQueue(); await until(() => started.length === 1)
  assert.equal(started[0], evaluation)
  const production = settings.readProductionSettings()
  settings.saveEvaluationSettings({ ...originalEval, concurrency: 2, threshold: 80 })
  assert.deepEqual(settings.readProductionSettings(), production)
})

test('saving stale settings rejects conflicts and cross-panel fields', () => {
  assert.ok(settings)
  const original = settings.readProductionSettings()
  settings.saveProductionSettings({ ...original, total: 3 })
  assert.throws(() => settings.saveProductionSettings({ ...original, total: 4 }), /设置已更新/)
  assert.throws(() => settings.saveProductionSettings({ ...settings.readProductionSettings(), concurrency: 2 }), /字段|Unrecognized/)
  assert.throws(() => settings.saveEvaluationSettings({ ...settings.readEvaluationSettings(), image: 2 }), /字段|Unrecognized/)
  assert.throws(() => settings.saveProductionSettings({ ...settings.readProductionSettings(), total: 0 }))
})

test('one provider quota group limits multiple configurations, including video tasks', async () => {
  assert.ok(queue && settings)
  for (const id of [11, 12]) db.$client.prepare(`INSERT OR IGNORE INTO ai_service_configs
    (id,service_type,name,base_url,api_key,model,is_active,created_at,updated_at) VALUES (?,'image','test','http://127.0.0.1','test','mock',1,'now','now')`).run(id)
  settings.saveProductionSettings({ ...settings.readProductionSettings(), quotaGroups: [{ id: 'account', name: '账号', limit: 1, configIds: [11, 12] }] })
  add(1, 'image', 1, 11); add(2, 'video', 2, 12)
  await queue.tickTaskQueue(); await until(() => started.length === 1)
  assert.equal(queue.queueStats().active, 1)
  assert.match(queue.queueJobView('sys_task', 2).queueReason || '', /服务商配额/)
})

test('cancel queued work never executes it; submitted jobs remain tracked and count towards limits', async () => {
  assert.ok(queue && settings)
  settings.saveProductionSettings({ ...settings.readProductionSettings(), total: 1 })
  const first = add(1), second = add(2)
  await queue.tickTaskQueue(); await until(() => started.length === 1)
  assert.throws(() => queue.cancelQueueJob(first), /已提交|追踪/)
  assert.equal(queue.cancelQueueJob(second).status, 'cancelled')
  assert.equal(cancelled, 1)
  releases.get(first)!(); await until(() => queue.queueStats().active === 0)
  assert.deepEqual(started, [first])
})

test('legacy submitted jobs without external ID are held for confirmation; known IDs recover without a new submission', async () => {
  assert.ok(queue)
  const unknown = queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId: 1, kind: 'image', projectId: 1, configId: 1,
    inputHash: 'old', initialStatus: 'processing', submitted: true })
  const known = queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId: 2, kind: 'video', projectId: 1, configId: 1,
    inputHash: 'old2', initialStatus: 'processing', submitted: true, externalTaskId: 'accepted-id' })
  await queue.recoverTaskQueue()
  await until(() => queue.getQueueJobById(unknown)?.phase === 'needs_confirmation' && started.length === 1)
  assert.deepEqual(started, [known])
  assert.equal(queue.queueStats().active, 2)
  assert.throws(() => queue.retryQueueJob(unknown), /确认|失败/)
})


test('finished upstream frees its quota group while saving still occupies global capacity', async () => {
  assert.ok(queue && settings)
  db.$client.prepare("INSERT INTO ai_service_configs (id,name,service_type,provider,base_url,api_key,model,is_active,created_at,updated_at) VALUES (9,'quota','image','mock','mock','test','mock',1,'now','now')").run()
  settings.saveProductionSettings({ ...settings.readProductionSettings(), total: 2, quotaGroups: [{ id: 'quota', name: 'test', limit: 1, configIds: [9] }] })
  const a = add(100, 'image', 1, 9), b = add(101, 'video', 2, 9)
  await queue.tickTaskQueue(); await until(() => started.length === 1)
  assert.equal(queue.getQueueJobById(b)?.status, 'pending')
  queue.updateQueueJob(a, { upstreamDone: true, phase: 'saving' })
  await queue.tickTaskQueue(); await until(() => started.length === 2)
  assert.equal(queue.getQueueJobById(a)?.status, 'processing')
  assert.equal(queue.queueStats().active, 2)
})

test('a second queue worker cannot run preparation or claim work while the owner is alive', async () => {
  assert.ok(queue)
  db.$client.prepare("INSERT INTO task_queue_cursors (key,value) VALUES ('worker',?)").run(JSON.stringify({ token: 'other', pid: process.pid, expires: Date.now() - 1 }))
  let prepared = false
  await assert.rejects(() => queue.startTaskQueueWorker(async () => { prepared = true }), /已有任务队列/)
  assert.equal(prepared, false)
  const job = add(200)
  await queue.tickTaskQueue()
  assert.equal(queue.getQueueJobById(job)?.status, 'pending')
})

test('known external task IDs resume polling after restart even if earlier polling exhausted', async () => {
  assert.ok(queue)
  const id = queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId: 201, kind: 'video', inputHash: 'mock',
    initialStatus: 'processing', initialPhase: 'needs_confirmation', submitted: true, externalTaskId: 'known-id' })
  await queue.recoverTaskQueue()
  await until(() => started.includes(id))
  assert.equal(queue.getQueueJobById(id)?.status, 'processing')
})

test('持锁进程已死时新后端能接管，僵尸 PID 不会永久挡住启动', async () => {
  assert.ok(queue)
  // 复现线上故障：旧后端被回收后锁里留下不存在的 PID，新后端一律 QueueError 拒起
  db.$client.prepare("INSERT INTO task_queue_cursors (key, value) VALUES ('worker', ?)")
    .run(JSON.stringify({ token: 'dead', pid: 2147483646, expires: Date.now() + 600_000 }))
  const stop = await queue.startTaskQueueWorker()
  try {
    assert.equal(queue.getQueueWorkerReady?.() ?? true, true)
    const row = db.$client.prepare("SELECT value FROM task_queue_cursors WHERE key='worker'").get() as any
    assert.equal(JSON.parse(row.value).pid, process.pid)   // 锁已转交给本进程
  } finally { stop() }
  // 持锁进程仍活着时，第二个 worker 拿不到锁（复用同进程在途 worker，不抛错）
  const first = await queue.startTaskQueueWorker()
  try { assert.equal(await queue.startTaskQueueWorker(), first) } finally { first() }
})

test('worker admission stays closed until all startup migrations have finished', async () => {
  assert.ok(queue)
  let id = 0
  const stop = await queue.startTaskQueueWorker(async () => {
    id = add(202)
    await queue.tickTaskQueue()
    assert.equal(queue.getQueueJobById(id)?.status, 'pending')
    assert.equal(started.length, 0)
  })
  try {
    await until(() => started.includes(id))
    releases.get(id)!()
    await until(() => queue.getQueueJobById(id)?.status === 'completed')
  } finally { stop() }
})
