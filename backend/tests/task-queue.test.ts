import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { test, beforeEach, after } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'global-queue-')), 'test.sqlite3')
const { db } = await import('../src/db/index.js')

// 还原后的 db 是 drizzle sqlite-proxy 异步封装，不再暴露 better-sqlite3 的 $client；
// 测试里的裸 SQL 改为统一的 raw 执行入口（? 占位按字面量内联，仅测试使用）。
const lit = (v: any) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const build = (text: string, args: any[]) => { let out = text; for (const a of args) out = out.replace('?', lit(a)); return sql.raw(out) }
const rawRun = async (text: string, ...args: any[]) => {
  // 多语句按分号拆分执行（CREATE TRIGGER 这类含 BEGIN...END 的整段执行）
  if (/\bbegin\b/i.test(text) && /\bend\b/i.test(text)) { await db.run(build(text, args)); return }
  for (const part of text.split(';')) { if (part.trim()) await db.run(build(part.trim(), args)) }
}
const rawAll = async (text: string, ...args: any[]) => (await db.all(build(text, args))) as any[]
const rawGet = async (text: string, ...args: any[]) => (await db.get(build(text, args))) as any

const queue = await import('../src/services/task-queue.js').catch(() => null)
const settings = await import('../src/services/task-queue-settings.js').catch(() => null)
const started: number[] = [], releases = new Map<number, () => void>()
let cancelled = 0
// 执行器先写库（await）再登记 release，started 到达后需等 release 就绪才能放行
const release = async (id: number) => {
  await until(async () => releases.has(id))
  releases.get(id)!()
}
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(await check(), 'queue did not reach expected state')
}
if (queue) queue.registerQueueExecutor('sys_task', {
  execute: async job => {
    started.push(job.id)
    await queue.updateQueueJob(job.id, { submitted: true, phase: 'upstream' })
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
  await rawRun("UPDATE task_queue_jobs SET status='cancelled' WHERE status='pending'")
  for (const release of releases.values()) release()
  await until(async () => releases.size === 0)
  await rawRun('DELETE FROM task_queue_jobs; DELETE FROM task_queue_cursors; DELETE FROM app_settings')
  started.length = 0; cancelled = 0
  await settings.saveProductionSettings({ revision: 0, total: 2, image: 2, video: 2, planning: 1, local: 1, paused: false, quotaGroups: [] })
})
after(() => { for (const release of releases.values()) release() })

async function add(ownerId: number, kind: 'image' | 'video' | 'evaluation' = 'image', projectId = 1, configId = 1) {
  assert.ok(queue, 'persistent queue is not implemented')
  return queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId, kind, projectId, configId, inputHash: `input-${ownerId}` })
}

test('global ceiling applies across projects and job types; finishing starts the queued job', async () => {
  assert.ok(queue, 'persistent queue is not implemented')
  const first = await add(1), second = await add(2, 'video', 2), third = await add(3, 'evaluation', 3)
  await queue.tickTaskQueue()
  await until(async () => started.length === 2)
  assert.equal((await queue.queueStats()).active, 2)
  assert.equal((await queue.queueStats()).pending, 1)
  const queued = await Promise.all([first, second, third].map(async id => await queue.getQueueJobById(id)))
  assert.ok(queued.some(job => job?.status === 'pending'))
  await release(started[0])
  await until(async () => started.length === 3)
  assert.equal((await queue.queueStats()).active, 2)
})

test('blocked videos at the head do not block an image in another project', async () => {
  assert.ok(queue && settings)
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), total: 2, video: 1 })
  await add(1, 'video'); await add(2, 'video'); const image = await add(3, 'image', 2)
  await queue.tickTaskQueue(); await until(async () => started.length === 2)
  assert.ok(started.includes(image))
  assert.equal((await queue.getQueueJob('sys_task', 2))?.status, 'pending')
})

test('project rotation gives another project a turn before the first project batch drains', async () => {
  assert.ok(queue && settings)
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), total: 1 })
  const first = await add(1); await add(2); await add(3); const other = await add(4, 'image', 2)
  await queue.tickTaskQueue(); await until(async () => started.length === 1)
  assert.equal(started[0], first)
  await release(first); await until(async () => started.length === 2)
  assert.equal(started[1], other)
})

test('production pause is independent of evaluation pause and settings are saved separately', async () => {
  assert.ok(queue && settings)
  const originalEval = (await settings.readEvaluationSettings())
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), paused: true })
  assert.deepEqual((await settings.readEvaluationSettings()), originalEval)
  await add(1); const evaluation = await add(2, 'evaluation')
  await queue.tickTaskQueue(); await until(async () => started.length === 1)
  assert.equal(started[0], evaluation)
  const production = (await settings.readProductionSettings())
  await settings.saveEvaluationSettings({ ...originalEval, concurrency: 2, threshold: 80 })
  assert.deepEqual((await settings.readProductionSettings()), production)
})

test('saving stale settings rejects conflicts and cross-panel fields', async () => {
  assert.ok(settings)
  const original = (await settings.readProductionSettings())
  await settings.saveProductionSettings({ ...original, total: 3 })
  await assert.rejects(async () => settings.saveProductionSettings({ ...original, total: 4 }), /设置已更新/)
  await assert.rejects(async () => settings.saveProductionSettings({ ...(await settings.readProductionSettings()), concurrency: 2 }), /字段|Unrecognized/)
  await assert.rejects(async () => settings.saveEvaluationSettings({ ...(await settings.readEvaluationSettings()), image: 2 }), /字段|Unrecognized/)
  await assert.rejects(async () => settings.saveProductionSettings({ ...(await settings.readProductionSettings()), total: 0 }))
})

test('one provider quota group limits multiple configurations, including video tasks', async () => {
  assert.ok(queue && settings)
  for (const id of [11, 12]) await rawRun(`INSERT OR IGNORE INTO ai_service_configs
    (id,service_type,name,base_url,api_key,model,is_active,created_at,updated_at) VALUES (?,'image','test','http://127.0.0.1','test','mock',1,'now','now')`, id)
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), quotaGroups: [{ id: 'account', name: '账号', limit: 1, configIds: [11, 12] }] })
  await add(1, 'image', 1, 11); await add(2, 'video', 2, 12)
  await queue.tickTaskQueue(); await until(async () => started.length === 1)
  assert.equal((await queue.queueStats()).active, 1)
  assert.match((await queue.queueJobView('sys_task', 2)).queueReason || '', /服务商配额/)
})

test('cancel queued work never executes it; submitted jobs remain tracked and count towards limits', async () => {
  assert.ok(queue && settings)
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), total: 1 })
  const first = await add(1), second = await add(2)
  await queue.tickTaskQueue(); await until(async () => started.length === 1)
  await assert.rejects(async () => queue.cancelQueueJob(first), /已提交|追踪/)
  assert.equal((await queue.cancelQueueJob(second)).status, 'cancelled')
  assert.equal(cancelled, 1)
  await release(first); await until(async () => (await queue.queueStats()).active === 0)
  assert.deepEqual(started, [first])
})

test('legacy submitted jobs without external ID are held for confirmation; known IDs recover without a new submission', async () => {
  assert.ok(queue)
  const unknown = await queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId: 1, kind: 'image', projectId: 1, configId: 1,
    inputHash: 'old', initialStatus: 'processing', submitted: true })
  const known = await queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId: 2, kind: 'video', projectId: 1, configId: 1,
    inputHash: 'old2', initialStatus: 'processing', submitted: true, externalTaskId: 'accepted-id' })
  await queue.recoverTaskQueue()
  await until(async () => (await queue.getQueueJobById(unknown))?.phase === 'needs_confirmation' && started.length === 1)
  assert.deepEqual(started, [known])
  assert.equal((await queue.queueStats()).active, 2)
  await assert.rejects(async () => queue.retryQueueJob(unknown), /确认|失败/)
})


test('finished upstream frees its quota group while saving still occupies global capacity', async () => {
  assert.ok(queue && settings)
  await rawRun("INSERT INTO ai_service_configs (id,name,service_type,provider,base_url,api_key,model,is_active,created_at,updated_at) VALUES (9,'quota','image','mock','mock','test','mock',1,'now','now')")
  await settings.saveProductionSettings({ ...(await settings.readProductionSettings()), total: 2, quotaGroups: [{ id: 'quota', name: 'test', limit: 1, configIds: [9] }] })
  const a = await add(100, 'image', 1, 9), b = await add(101, 'video', 2, 9)
  await queue.tickTaskQueue(); await until(async () => started.length === 1)
  assert.equal((await queue.getQueueJobById(b))?.status, 'pending')
  await queue.updateQueueJob(a, { upstreamDone: true, phase: 'saving' })
  await queue.tickTaskQueue(); await until(async () => started.length === 2)
  assert.equal((await queue.getQueueJobById(a))?.status, 'processing')
  assert.equal((await queue.queueStats()).active, 2)
})

test('a second queue worker cannot run preparation or claim work while the owner is alive', async () => {
  assert.ok(queue)
  await rawRun("INSERT INTO task_queue_cursors (key,value) VALUES ('worker',?)", JSON.stringify({ token: 'other', pid: process.pid, expires: Date.now() - 1 }))
  let prepared = false
  await assert.rejects(async () => queue.startTaskQueueWorker(async () => { prepared = true }), /已有任务队列/)
  assert.equal(prepared, false)
  const job = await add(200)
  await queue.tickTaskQueue()
  assert.equal((await queue.getQueueJobById(job))?.status, 'pending')
})

test('known external task IDs resume polling after restart even if earlier polling exhausted', async () => {
  assert.ok(queue)
  const id = await queue.enqueueQueueJob({ ownerType: 'sys_task', ownerId: 201, kind: 'video', inputHash: 'mock',
    initialStatus: 'processing', initialPhase: 'needs_confirmation', submitted: true, externalTaskId: 'known-id' })
  await queue.recoverTaskQueue()
  await until(async () => started.includes(id))
  assert.equal((await queue.getQueueJobById(id))?.status, 'processing')
})

test('持锁进程已死时新后端能接管，僵尸 PID 不会永久挡住启动', async () => {
  assert.ok(queue)
  // 复现线上故障：旧后端被回收后锁里留下不存在的 PID，新后端一律 QueueError 拒起
  await rawRun("INSERT INTO task_queue_cursors (key, value) VALUES ('worker', ?)", JSON.stringify({ token: 'dead', pid: 2147483646, expires: Date.now() + 600_000 }))
  const stop = await queue.startTaskQueueWorker()
  try {
    assert.equal(queue.getQueueWorkerReady?.() ?? true, true)
    const [value] = await rawGet("SELECT value FROM task_queue_cursors WHERE key='worker'") as any[]
    assert.equal(JSON.parse(value).pid, process.pid)   // 锁已转交给本进程
  } finally { stop() }
  // stop() 的租约清理是异步的，等锁行真正删除后再谈“持锁进程仍活着”
  await until(async () => (await rawGet("SELECT value FROM task_queue_cursors WHERE key='worker'")) === undefined)
  // 持锁进程仍活着时，第二个 worker 拿不到锁（复用同进程在途 worker，不抛错）
  const first = await queue.startTaskQueueWorker()
  try { assert.equal(await queue.startTaskQueueWorker(), first) } finally { first() }
})

test('worker admission stays closed until all startup migrations have finished', async () => {
  assert.ok(queue)
  let id = 0
  const stop = await queue.startTaskQueueWorker(async () => {
    id = await add(202)
    await queue.tickTaskQueue()
    assert.equal((await queue.getQueueJobById(id))?.status, 'pending')
    assert.equal(started.length, 0)
  })
  try {
    await until(async () => started.includes(id))
    await release(id)
    await until(async () => (await queue.getQueueJobById(id))?.status === 'completed')
  } finally { stop() }
})
