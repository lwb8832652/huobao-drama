import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, dbDialect, getAffectedRows, outsideTransaction, schema } from '../db/index.js'
import { readProductionSettings, readEvaluationSettings, onQueueSettingsChange } from './task-queue-settings.js'

export type QueueKind = 'image' | 'video' | 'evaluation' | 'planning' | 'local'
export type QueueOwner = 'sys_task' | 'continuity_review' | 'production_quality' | 'frame_plan' | 'contact_sheet' | 'video_merge'
export type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
export interface QueueJob {
  id: number; ownerType: QueueOwner; ownerId: number; kind: QueueKind; projectId: number; configId: number
  inputHash: string; snapshotJson: string; source: string; status: QueueStatus; phase: string; ready: boolean
  submitted: boolean; externalTaskId: string | null; upstreamDone: boolean; attempt: number; error: string | null
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null
}
export interface QueueOutcome { status: 'completed' | 'failed' | 'needs_confirmation'; error?: string }
interface Executor {
  execute: (job: QueueJob) => Promise<QueueOutcome>
  recover?: (job: QueueJob) => Promise<QueueOutcome>
  onCancel?: (job: QueueJob) => void | Promise<void>
  onRetry?: (job: QueueJob) => void | Promise<void>
  onReconcile?: (job: QueueJob) => void | Promise<void>
  onRequeue?: (job: QueueJob) => void | Promise<void>
}
interface QueueInput {
  ownerType: QueueOwner; ownerId: number; kind: QueueKind; projectId?: number; configId?: number; inputHash: string
  snapshotJson?: string; source?: string; ready?: boolean; initialStatus?: QueueStatus; initialPhase?: string
  submitted?: boolean; externalTaskId?: string | null; upstreamDone?: boolean
}

type QueueRow = typeof schema.taskQueueJobs.$inferSelect

export class QueueError extends Error {
  constructor(message: string, readonly status = 409) { super(message) }
}

const now = () => new Date().toISOString()
const executors = new Map<QueueOwner, Executor>()
const running = new Map<number, Promise<void>>()
const kinds: QueueKind[] = ['image', 'video', 'evaluation', 'planning', 'local']
let tickPromise: Promise<void> | undefined
let wakePending = false
let workerToken: string | undefined
let workerReady = false

function rowToJob(row: QueueRow | undefined): QueueJob | undefined {
  if (!row) return
  return {
    ...row,
    ownerType: row.ownerType as QueueOwner,
    kind: row.kind as QueueKind,
    status: row.status as QueueStatus,
  }
}

export async function getQueueJobById(id: number) {
  return rowToJob(await db.select().from(schema.taskQueueJobs).where(eq(schema.taskQueueJobs.id, id)).get())
}

export async function getQueueJob(ownerType: QueueOwner, ownerId: number) {
  return rowToJob(await db.select().from(schema.taskQueueJobs).where(and(
    eq(schema.taskQueueJobs.ownerType, ownerType),
    eq(schema.taskQueueJobs.ownerId, ownerId),
  )).get())
}

export function registerQueueExecutor(ownerType: QueueOwner, executor: Executor) {
  executors.set(ownerType, executor)
}

export async function enqueueQueueJob(input: QueueInput): Promise<number> {
  const ts = now()
  await db.insert(schema.taskQueueJobs).values({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    kind: input.kind,
    projectId: input.projectId || 0,
    configId: input.configId || 0,
    inputHash: input.inputHash,
    snapshotJson: input.snapshotJson || '{}',
    source: input.source || 'manual',
    status: input.initialStatus || 'pending',
    phase: input.initialPhase || (input.initialStatus === 'processing' ? 'recovering' : 'queued'),
    ready: input.ready !== false,
    submitted: !!input.submitted,
    externalTaskId: input.externalTaskId || null,
    upstreamDone: !!input.upstreamDone,
    createdAt: ts,
    updatedAt: ts,
  }).onConflictDoNothing().run()
  const job = await getQueueJob(input.ownerType, input.ownerId)
  if (!job) throw new QueueError('任务队列记录创建失败')
  return job.id
}

export async function activateQueueJob(ownerType: QueueOwner, ownerId: number) {
  await db.update(schema.taskQueueJobs).set({ ready: true, updatedAt: now() }).where(and(
    eq(schema.taskQueueJobs.ownerType, ownerType),
    eq(schema.taskQueueJobs.ownerId, ownerId),
    eq(schema.taskQueueJobs.status, 'pending'),
  )).run()
}

const updateColumns = {
  phase: true,
  submitted: true,
  externalTaskId: true,
  upstreamDone: true,
  error: true,
  source: true,
  snapshotJson: true,
} as const

export async function updateQueueJob(
  id: number,
  update: Partial<Pick<QueueJob, keyof typeof updateColumns>>,
) {
  const values: Record<string, unknown> = { updatedAt: now() }
  for (const [key, value] of Object.entries(update)) {
    if (key in updateColumns) values[key] = value ?? null
  }
  if (Object.keys(values).length === 1) return
  await db.update(schema.taskQueueJobs).set(values).where(eq(schema.taskQueueJobs.id, id)).run()
}

function wake() {
  if (wakePending) return
  wakePending = true
  outsideTransaction(() => queueMicrotask(() => {
    wakePending = false
    void tickTaskQueue().catch(error => console.error('Task queue:', error.message))
  }))
}

export async function finishQueueJob(id: number, outcome: QueueOutcome) {
  const job = await getQueueJobById(id)
  if (!job || job.status === 'cancelled') return
  const uncertain = outcome.status === 'needs_confirmation'
  await db.update(schema.taskQueueJobs).set({
    status: uncertain ? 'processing' : outcome.status,
    phase: uncertain ? 'needs_confirmation' : outcome.status,
    error: outcome.error || null,
    updatedAt: now(),
    finishedAt: uncertain ? null : now(),
  }).where(and(
    eq(schema.taskQueueJobs.id, id),
    inArray(schema.taskQueueJobs.status, ['pending', 'processing']),
  )).run()
  wake()
}

export async function completeRecoveredQueueJob(id: number) {
  const job = await getQueueJobById(id)
  if (!job || job.status !== 'failed' || !job.upstreamDone) return
  await db.update(schema.taskQueueJobs).set({
    status: 'completed',
    phase: 'completed',
    error: null,
    updatedAt: now(),
    finishedAt: now(),
  }).where(and(eq(schema.taskQueueJobs.id, id), eq(schema.taskQueueJobs.status, 'failed'))).run()
  wake()
}

export async function cancelQueueJob(id: number): Promise<QueueJob> {
  const result = await db.transaction(async tx => {
    const job = rowToJob(await tx.select().from(schema.taskQueueJobs).where(eq(schema.taskQueueJobs.id, id)).get())
    if (!job) throw new QueueError('任务不存在', 404)
    if (job.status === 'cancelled') return job
    if (job.kind === 'local' && job.status === 'processing') throw new QueueError('本地任务正在执行，请等待任务结束')
    if (job.submitted || job.externalTaskId) throw new QueueError('任务已提交，需继续追踪服务商结果，无法取消')
    if (!['pending', 'processing'].includes(job.status)) throw new QueueError('任务已结束，无法取消')
    await executors.get(job.ownerType)?.onCancel?.(job)
    await tx.update(schema.taskQueueJobs).set({
      status: 'cancelled',
      phase: 'cancelled',
      updatedAt: now(),
      finishedAt: now(),
    }).where(eq(schema.taskQueueJobs.id, id)).run()
    return rowToJob(await tx.select().from(schema.taskQueueJobs).where(eq(schema.taskQueueJobs.id, id)).get())!
  })
  wake()
  return result
}

export async function retryQueueJob(id: number): Promise<QueueJob> {
  const result = await db.transaction(async tx => {
    const job = rowToJob(await tx.select().from(schema.taskQueueJobs).where(eq(schema.taskQueueJobs.id, id)).get())
    if (!job) throw new QueueError('任务不存在', 404)
    if (job.status !== 'failed' || (job.submitted && !job.upstreamDone)) {
      throw new QueueError('仅可重试已确认结束的失败任务；请先核对提交状态')
    }
    await executors.get(job.ownerType)?.onRetry?.(job)
    await tx.update(schema.taskQueueJobs).set({
      status: 'pending',
      phase: 'queued',
      error: null,
      ready: true,
      updatedAt: now(),
      finishedAt: null,
    }).where(eq(schema.taskQueueJobs.id, id)).run()
    return rowToJob(await tx.select().from(schema.taskQueueJobs).where(eq(schema.taskQueueJobs.id, id)).get())!
  })
  wake()
  return result
}

export async function resetQueueJob(ownerType: QueueOwner, ownerId: number, input: Partial<QueueInput> = {}) {
  const job = await getQueueJob(ownerType, ownerId)
  if (!job) return
  if (job.status === 'processing' || job.status === 'pending') return job.id
  await db.update(schema.taskQueueJobs).set({
    status: 'pending',
    phase: 'queued',
    submitted: false,
    externalTaskId: null,
    upstreamDone: false,
    error: null,
    ready: input.ready !== false,
    inputHash: input.inputHash ?? job.inputHash,
    snapshotJson: input.snapshotJson ?? job.snapshotJson,
    configId: input.configId ?? job.configId,
    source: input.source ?? job.source,
    updatedAt: now(),
    finishedAt: null,
  }).where(eq(schema.taskQueueJobs.id, job.id)).run()
  return job.id
}

export async function reconcileQueueJob(id: number, confirmedStopped: boolean) {
  const result = await db.transaction(async () => {
    const job = await getQueueJobById(id)
    if (!job || job.status !== 'processing' || job.phase !== 'needs_confirmation') {
      throw new QueueError('任务不需要人工核对')
    }
    if (!confirmedStopped) throw new QueueError('请先确认服务商任务已经结束或未被接受', 400)
    await updateQueueJob(id, { upstreamDone: true })
    const latest = (await getQueueJobById(id))!
    await executors.get(job.ownerType)?.onReconcile?.(latest)
    await finishQueueJob(id, { status: 'failed', error: '已人工确认上游任务结束，可根据需要重新提交' })
    return (await getQueueJobById(id))!
  })
  return result
}

export async function queueStats() {
  const rows = await db.select().from(schema.taskQueueJobs)
    .where(inArray(schema.taskQueueJobs.status, ['pending', 'processing'])).all()
  const byKind = Object.fromEntries(kinds.map(kind => [kind, { active: 0, pending: 0 }])) as
    Record<QueueKind, { active: number; pending: number }>
  let active = 0
  let pending = 0
  for (const row of rows) {
    const kind = row.kind as QueueKind
    if (!byKind[kind]) continue
    if (row.status === 'processing') {
      active++
      byKind[kind].active++
    } else {
      pending++
      byKind[kind].pending++
    }
  }
  return { active, pending, byKind }
}

async function blockingReason(
  job: QueueJob,
  active: QueueJob[],
  production?: Awaited<ReturnType<typeof readProductionSettings>>,
  evaluation?: Awaited<ReturnType<typeof readEvaluationSettings>>,
) {
  const productionSettings = production ?? await readProductionSettings()
  const evaluationSettings = evaluation ?? await readEvaluationSettings()
  if (!job.ready) return '等待前置任务'
  if (job.kind === 'evaluation' ? evaluationSettings.paused : productionSettings.paused) {
    return job.kind === 'evaluation' ? '评测队列已暂停' : '制作队列已暂停'
  }
  if (active.length >= productionSettings.total) return '后台任务总并发已满'
  const limit = job.kind === 'evaluation' ? evaluationSettings.concurrency : productionSettings[job.kind]
  const names = { image: '图片', video: '视频', evaluation: '评测', planning: 'AI 规划', local: '本地处理' }
  if (active.filter(item => item.kind === job.kind).length >= limit) return `${names[job.kind]}并发已满`
  if (!job.upstreamDone) {
    const group = productionSettings.quotaGroups.find(item => item.configIds.includes(job.configId))
    if (group && active.filter(item => !item.upstreamDone && group.configIds.includes(item.configId)).length >= group.limit) {
      return `服务商配额已满 · ${group.name}`
    }
  }
  return ''
}

export async function queueJobView(ownerType: QueueOwner, ownerId: number) {
  const job = await getQueueJob(ownerType, ownerId)
  if (!job) return {}
  const active = (await db.select().from(schema.taskQueueJobs)
    .where(eq(schema.taskQueueJobs.status, 'processing')).all())
    .map(row => rowToJob(row)!)
  return {
    queueJobId: job.id,
    phase: job.phase,
    queueReason: job.status === 'pending'
      ? await blockingReason(job, active) || '等待调度'
      : job.phase === 'needs_confirmation' ? job.error || '请核对服务商提交状态' : null,
    canCancel: ['pending', 'processing'].includes(job.status)
      && !(job.kind === 'local' && job.status === 'processing')
      && !job.submitted
      && !job.externalTaskId,
    canRetry: job.status === 'failed' && (!job.submitted || job.upstreamDone),
    startedAt: job.startedAt,
  }
}

async function cursor(key: string) {
  return (await db.select().from(schema.taskQueueCursors).where(eq(schema.taskQueueCursors.key, key)).get())?.value || ''
}

async function setCursor(key: string, value: string) {
  await db.insert(schema.taskQueueCursors).values({ key, value }).onConflictDoUpdate({
    target: schema.taskQueueCursors.key,
    set: { value },
  }).run()
}

async function leaseRecord(): Promise<{ token?: string; expires?: number; pid?: number }> {
  try { return JSON.parse(await cursor('worker') || '{}') } catch { return {} }
}

async function canDispatch() {
  const lease = await leaseRecord()
  if (!lease.token) return !workerToken
  if (lease.token === workerToken) return workerReady
  if (dbDialect === 'sqlite' && lease.pid) {
    try {
      process.kill(lease.pid, 0)
      return false
    } catch {
      return false
    }
  }
  return !lease.expires || lease.expires <= Date.now()
}

async function claimNext(): Promise<QueueJob | undefined> {
  return db.transaction(async tx => {
    if (!await canDispatch()) return
    const production = await readProductionSettings()
    const evaluation = await readEvaluationSettings()
    const active = (await tx.select().from(schema.taskQueueJobs)
      .where(eq(schema.taskQueueJobs.status, 'processing')).all())
      .map(row => rowToJob(row)!)
    if (active.length >= production.total) return
    const pendingRows = await tx.select().from(schema.taskQueueJobs)
      .where(and(eq(schema.taskQueueJobs.status, 'pending'), eq(schema.taskQueueJobs.ready, true)))
      .orderBy(schema.taskQueueJobs.id).all()
    const pending: QueueJob[] = []
    for (const row of pendingRows) {
      const job = rowToJob(row)!
      if (executors.has(job.ownerType) && !running.has(job.id)
        && !await blockingReason(job, active, production, evaluation)) pending.push(job)
    }
    const lastKind = kinds.indexOf(await cursor('kind') as QueueKind)
    for (let offset = 1; offset <= kinds.length; offset++) {
      const kind = kinds[(lastKind + offset) % kinds.length]
      const candidates = pending.filter(job => job.kind === kind)
      if (!candidates.length) continue
      const projects = [...new Set(candidates.map(job => job.projectId))].sort((a, b) => a - b)
      const lastProject = Number(await cursor(`project:${kind}`) || -1)
      const project = projects.find(value => value > lastProject) ?? projects[0]
      const chosen = candidates.find(job => job.projectId === project)!
      const updated = await tx.update(schema.taskQueueJobs).set({
        status: 'processing',
        phase: 'preparing',
        attempt: chosen.attempt + 1,
        startedAt: now(),
        updatedAt: now(),
      }).where(and(
        eq(schema.taskQueueJobs.id, chosen.id),
        eq(schema.taskQueueJobs.status, 'pending'),
      )).run()
      if (!getAffectedRows(updated)) continue
      await setCursor('kind', kind)
      await setCursor(`project:${kind}`, String(project))
      return getQueueJobById(chosen.id)
    }
  })
}

function execute(job: QueueJob, recover = false) {
  if (running.has(job.id)) return
  const executor = executors.get(job.ownerType)
  if (!executor) return
  const promise = Promise.resolve().then(async () => {
    const current = await getQueueJobById(job.id)
    if (!current || current.status !== 'processing') return
    try {
      const outcome = await (recover && executor.recover ? executor.recover(current) : executor.execute(current))
      await finishQueueJob(job.id, outcome)
    } catch (error: any) {
      const latest = (await getQueueJobById(job.id))!
      await finishQueueJob(job.id, {
        status: latest.submitted && !latest.upstreamDone ? 'needs_confirmation' : 'failed',
        error: error?.message || '任务执行失败',
      })
    }
  }).finally(() => {
    running.delete(job.id)
    wake()
  })
  running.set(job.id, promise)
}

export function tickTaskQueue(): Promise<void> {
  if (tickPromise) return tickPromise
  tickPromise = Promise.resolve().then(async () => {
    for (let i = 0; i < 32; i++) {
      const job = await claimNext()
      if (!job) break
      execute(job)
    }
  }).finally(() => { tickPromise = undefined })
  return tickPromise
}

export async function recoverTaskQueue() {
  if (!await canDispatch()) return
  const rows = await db.select().from(schema.taskQueueJobs)
    .where(eq(schema.taskQueueJobs.status, 'processing')).all()
  for (const row of rows) {
    const job = rowToJob(row)!
    if (running.has(job.id) || (job.phase === 'needs_confirmation' && !job.externalTaskId)) continue
    if (!job.submitted && !job.externalTaskId) {
      await db.transaction(async tx => {
        await executors.get(job.ownerType)?.onRequeue?.(job)
        await tx.update(schema.taskQueueJobs).set({
          status: 'pending',
          phase: 'queued',
          updatedAt: now(),
        }).where(eq(schema.taskQueueJobs.id, job.id)).run()
      })
    } else if (executors.has(job.ownerType)) {
      execute(job, true)
    } else {
      await finishQueueJob(job.id, { status: 'needs_confirmation', error: '未找到恢复执行器，请核对服务商任务状态' })
    }
  }
}

let stopWorker: (() => void) | undefined

export async function startTaskQueueWorker(prepare?: () => Promise<void>) {
  if (stopWorker) return stopWorker
  // 合并说明：MySQL 适配版（来自 10-16 汇总还原）已内含本仓早前的僵尸锁修复——
  // sqlite 下持锁进程已死时 catch 后不 return false，继续放行接管；
  // MySQL 无进程语义，改靠租约过期 + 行锁防并发准入。
  // （2026-10-14 实证：旧后端被回收后锁里留死 PID，新后端一律 QueueError 拒起。）
  const token = randomUUID()
  const leaseMs = 30_000
  const leaseValue = () => JSON.stringify({
    token, ...(dbDialect === 'sqlite' ? { pid: process.pid } : {}), expires: Date.now() + leaseMs,
  })
  const hold = await db.transaction(async () => {
    // Lock/create the lease row before checking it, so MySQL deployments cannot
    // concurrently admit two workers on different connections.
    await db.insert(schema.taskQueueCursors)
      .values({ key: 'worker', value: '{}' }).onConflictDoNothing().run()
    const previous = await leaseRecord()
    if (dbDialect === 'sqlite' && previous.pid) {
      try {
        process.kill(previous.pid, 0)
        return false
      } catch {}
    } else if (previous.expires && previous.expires > Date.now()) {
      return false
    }
    await setCursor('worker', leaseValue())
    return true
  })
  if (!hold) throw new QueueError('已有任务队列执行器运行，请勿重复启动后端服务')
  workerToken = token
  try {
    await prepare?.()
    workerReady = true
    await recoverTaskQueue()
  } catch (error) {
    if ((await leaseRecord()).token === token) {
      await db.delete(schema.taskQueueCursors).where(eq(schema.taskQueueCursors.key, 'worker')).run()
    }
    workerToken = undefined
    workerReady = false
    throw error
  }

  const timer = setInterval(() => {
    void db.transaction(async () => {
      await db.insert(schema.taskQueueCursors)
        .values({ key: 'worker', value: '{}' }).onConflictDoNothing().run()
      const previous = await leaseRecord()
      if (previous.token !== token) return false
      await setCursor('worker', leaseValue())
      return true
    }).then(lease => {
      if (lease) void tickTaskQueue().catch(error => console.error('Task queue:', error.message))
    }).catch(error => console.error('Task queue lease:', error.message))
  }, 1000)
  timer.unref()

  stopWorker = () => {
    clearInterval(timer)
    void (async () => {
      if ((await leaseRecord()).token === token) {
        await db.delete(schema.taskQueueCursors).where(eq(schema.taskQueueCursors.key, 'worker')).run()
      }
    })().catch(error => console.error('Task queue lease cleanup:', error.message))
    stopWorker = undefined
    workerToken = undefined
    workerReady = false
  }
  await tickTaskQueue()
  return stopWorker
}

onQueueSettingsChange(async () => {
  if (!(await readEvaluationSettings()).enabled) {
    const rows = await db.select({ id: schema.taskQueueJobs.id }).from(schema.taskQueueJobs).where(and(
      eq(schema.taskQueueJobs.kind, 'evaluation'),
      eq(schema.taskQueueJobs.source, 'automatic'),
      eq(schema.taskQueueJobs.status, 'pending'),
    )).all()
    for (const row of rows) await cancelQueueJob(row.id)
  }
  wake()
})
