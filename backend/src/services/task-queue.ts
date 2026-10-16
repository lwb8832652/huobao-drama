import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
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
  onCancel?: (job: QueueJob) => void
  onRetry?: (job: QueueJob) => void
  onReconcile?: (job: QueueJob) => void
  onRequeue?: (job: QueueJob) => void
}
interface QueueInput {
  ownerType: QueueOwner; ownerId: number; kind: QueueKind; projectId?: number; configId?: number; inputHash: string
  snapshotJson?: string; source?: string; ready?: boolean; initialStatus?: QueueStatus; initialPhase?: string
  submitted?: boolean; externalTaskId?: string | null; upstreamDone?: boolean
}
export class QueueError extends Error { constructor(message: string, readonly status = 409) { super(message) } }
const now = () => new Date().toISOString()
const client = db.$client
const executors = new Map<QueueOwner, Executor>()
const running = new Map<number, Promise<void>>()
const kinds: QueueKind[] = ['image', 'video', 'evaluation', 'planning', 'local']
let tickPromise: Promise<void> | undefined, wakePending = false
let workerToken: string | undefined
let workerReady = false
function leaseRecord(): { token?: string; expires?: number; pid?: number } {
  try { return JSON.parse(cursor('worker') || '{}') } catch { return {} }
}
function canDispatch() {
  const lease = leaseRecord()
  if (!lease.token) return !workerToken
  if (lease.token === workerToken) return workerReady
  if (lease.pid) {
    try { process.kill(lease.pid, 0); return false } catch { return false }
  }
  return !lease.expires || lease.expires <= Date.now()
}
function rowToJob(row: any): QueueJob | undefined {
  if (!row) return
  return { id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, kind: row.kind, projectId: row.project_id,
    configId: row.config_id, inputHash: row.input_hash, snapshotJson: row.snapshot_json, source: row.source,
    status: row.status, phase: row.phase, ready: !!row.ready, submitted: !!row.submitted,
    externalTaskId: row.external_task_id, upstreamDone: !!row.upstream_done, attempt: row.attempt,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at }
}
export function getQueueJobById(id: number) { return rowToJob(client.prepare('SELECT * FROM task_queue_jobs WHERE id=?').get(id)) }
export function getQueueJob(ownerType: QueueOwner, ownerId: number) {
  return rowToJob(client.prepare('SELECT * FROM task_queue_jobs WHERE owner_type=? AND owner_id=?').get(ownerType, ownerId))
}
export function registerQueueExecutor(ownerType: QueueOwner, executor: Executor) { executors.set(ownerType, executor) }
export function enqueueQueueJob(input: QueueInput): number {
  const ts = now()
  client.prepare(`INSERT INTO task_queue_jobs
    (owner_type,owner_id,kind,project_id,config_id,input_hash,snapshot_json,source,status,phase,ready,submitted,external_task_id,upstream_done,created_at,updated_at)
    VALUES (@ownerType,@ownerId,@kind,@projectId,@configId,@inputHash,@snapshotJson,@source,@status,@phase,@ready,@submitted,@externalTaskId,@upstreamDone,@ts,@ts)
    ON CONFLICT(owner_type,owner_id) DO NOTHING`).run({ ownerType: input.ownerType, ownerId: input.ownerId,
      kind: input.kind, projectId: input.projectId || 0, configId: input.configId || 0, inputHash: input.inputHash,
      snapshotJson: input.snapshotJson || '{}', source: input.source || 'manual', status: input.initialStatus || 'pending',
      phase: input.initialPhase || (input.initialStatus === 'processing' ? 'recovering' : 'queued'), ready: Number(input.ready !== false),
      submitted: Number(!!input.submitted), externalTaskId: input.externalTaskId || null, upstreamDone: Number(!!input.upstreamDone), ts })
  return getQueueJob(input.ownerType, input.ownerId)!.id
}
export function activateQueueJob(ownerType: QueueOwner, ownerId: number) {
  client.prepare(`UPDATE task_queue_jobs SET ready=1,updated_at=? WHERE owner_type=? AND owner_id=? AND status='pending'`).run(now(), ownerType, ownerId)
}
const updateColumns = { phase: 'phase', submitted: 'submitted', externalTaskId: 'external_task_id', upstreamDone: 'upstream_done', error: 'error', source: 'source' } as const
export function updateQueueJob(id: number, update: Partial<Pick<QueueJob, keyof typeof updateColumns>>) {
  const entries = Object.entries(update).filter(([key]) => key in updateColumns)
  if (!entries.length) return
  client.prepare(`UPDATE task_queue_jobs SET ${entries.map(([key]) => `${updateColumns[key as keyof typeof updateColumns]}=?`).join(',')},updated_at=? WHERE id=?`)
    .run(...entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value ?? null), now(), id)
}
function wake() {
  if (wakePending) return
  wakePending = true
  queueMicrotask(() => { wakePending = false; void tickTaskQueue().catch(error => console.error('Task queue:', error.message)) })
}
export function finishQueueJob(id: number, outcome: QueueOutcome) {
  const job = getQueueJobById(id)
  if (!job || job.status === 'cancelled') return
  const uncertain = outcome.status === 'needs_confirmation'
  client.prepare(`UPDATE task_queue_jobs SET status=?,phase=?,error=?,updated_at=?,finished_at=? WHERE id=? AND status IN ('pending','processing')`)
    .run(uncertain ? 'processing' : outcome.status, uncertain ? 'needs_confirmation' : outcome.status,
      outcome.error || null, now(), uncertain ? null : now(), id)
  wake()
}
export function completeRecoveredQueueJob(id: number) {
  const job = getQueueJobById(id)
  if (!job || job.status !== 'failed' || !job.upstreamDone) return
  client.prepare("UPDATE task_queue_jobs SET status='completed',phase='completed',error=NULL,updated_at=?,finished_at=? WHERE id=? AND status='failed'").run(now(), now(), id)
  wake()
}
export function cancelQueueJob(id: number): QueueJob {
  return client.transaction(() => {
    const job = getQueueJobById(id)
    if (!job) throw new QueueError('任务不存在', 404)
    if (job.status === 'cancelled') return job
    if (job.kind === 'local' && job.status === 'processing') throw new QueueError('本地任务正在执行，请等待任务结束')
    if (job.submitted || job.externalTaskId) throw new QueueError('任务已提交，需继续追踪服务商结果，无法取消')
    if (!['pending', 'processing'].includes(job.status)) throw new QueueError('任务已结束，无法取消')
    executors.get(job.ownerType)?.onCancel?.(job)
    client.prepare(`UPDATE task_queue_jobs SET status='cancelled',phase='cancelled',updated_at=?,finished_at=? WHERE id=?`).run(now(), now(), id)
    wake()
    return getQueueJobById(id)!
  }).immediate()
}
export function retryQueueJob(id: number): QueueJob {
  const result = client.transaction(() => {
    const job = getQueueJobById(id)
    if (!job) throw new QueueError('任务不存在', 404)
    if (job.status !== 'failed' || (job.submitted && !job.upstreamDone)) throw new QueueError('仅可重试已确认结束的失败任务；请先核对提交状态')
    executors.get(job.ownerType)?.onRetry?.(job)
    client.prepare(`UPDATE task_queue_jobs SET status='pending',phase='queued',error=NULL,ready=1,updated_at=?,finished_at=NULL WHERE id=?`).run(now(), id)
    return getQueueJobById(id)!
  }).immediate()
  wake(); return result
}
export function resetQueueJob(ownerType: QueueOwner, ownerId: number, input: Partial<QueueInput> = {}) {
  const job = getQueueJob(ownerType, ownerId)
  if (!job) return
  if (job.status === 'processing' || job.status === 'pending') return job.id
  client.prepare(`UPDATE task_queue_jobs SET status='pending',phase='queued',submitted=0,external_task_id=NULL,upstream_done=0,
    error=NULL,ready=?,input_hash=?,snapshot_json=?,config_id=?,source=?,updated_at=?,finished_at=NULL WHERE id=?`)
    .run(Number(input.ready !== false), input.inputHash ?? job.inputHash, input.snapshotJson ?? job.snapshotJson, input.configId ?? job.configId, input.source ?? job.source, now(), job.id)
  return job.id
}
export function reconcileQueueJob(id: number, confirmedStopped: boolean) {
  return client.transaction(() => {
    const job = getQueueJobById(id)
    if (!job || job.status !== 'processing' || job.phase !== 'needs_confirmation') throw new QueueError('任务不需要人工核对')
    if (!confirmedStopped) throw new QueueError('请先确认服务商任务已经结束或未被接受', 400)
    updateQueueJob(id, { upstreamDone: true })
    executors.get(job.ownerType)?.onReconcile?.(getQueueJobById(id)!)
    finishQueueJob(id, { status: 'failed', error: '已人工确认上游任务结束，可根据需要重新提交' })
    return getQueueJobById(id)!
  }).immediate()
}
export function queueStats() {
  const byKind = Object.fromEntries(kinds.map(kind => [kind, { active: 0, pending: 0 }])) as Record<QueueKind, { active: number; pending: number }>
  let active = 0, pending = 0
  const rows = client.prepare(`SELECT kind,status,COUNT(*) AS count FROM task_queue_jobs WHERE status IN ('pending','processing') GROUP BY kind,status`).all() as any[]
  for (const row of rows) {
    if (!byKind[row.kind as QueueKind]) continue
    if (row.status === 'processing') { active += row.count; byKind[row.kind as QueueKind].active += row.count }
    else { pending += row.count; byKind[row.kind as QueueKind].pending += row.count }
  }
  return { active, pending, byKind }
}
function blockingReason(job: QueueJob, active: QueueJob[], production = readProductionSettings(), evaluation = readEvaluationSettings()) {
  if (!job.ready) return '等待前置任务'
  if (job.kind === 'evaluation' ? evaluation.paused : production.paused) return job.kind === 'evaluation' ? '评测队列已暂停' : '制作队列已暂停'
  if (active.length >= production.total) return '后台任务总并发已满'
  const limit = job.kind === 'evaluation' ? evaluation.concurrency : production[job.kind]
  const names = { image: '图片', video: '视频', evaluation: '评测', planning: 'AI 规划', local: '本地处理' }
  if (active.filter(item => item.kind === job.kind).length >= limit) return `${names[job.kind]}并发已满`
  if (!job.upstreamDone) {
    const group = production.quotaGroups.find(item => item.configIds.includes(job.configId))
    if (group && active.filter(item => !item.upstreamDone && group.configIds.includes(item.configId)).length >= group.limit) return `服务商配额已满 · ${group.name}`
  }
  return ''
}
export function queueJobView(ownerType: QueueOwner, ownerId: number) {
  const job = getQueueJob(ownerType, ownerId)
  if (!job) return {}
  const active = (client.prepare("SELECT * FROM task_queue_jobs WHERE status='processing'").all() as any[]).map(row => rowToJob(row)!)
  return { queueJobId: job.id, phase: job.phase,
    queueReason: job.status === 'pending' ? blockingReason(job, active) || '等待调度' : job.phase === 'needs_confirmation' ? job.error || '请核对服务商提交状态' : null,
    canCancel: ['pending', 'processing'].includes(job.status) && !(job.kind === 'local' && job.status === 'processing') && !job.submitted && !job.externalTaskId,
    canRetry: job.status === 'failed' && (!job.submitted || job.upstreamDone), startedAt: job.startedAt }
}
function cursor(key: string) { return (client.prepare('SELECT value FROM task_queue_cursors WHERE key=?').get(key) as any)?.value || '' }
function setCursor(key: string, value: string) { client.prepare('INSERT INTO task_queue_cursors(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
function claimNext(): QueueJob | undefined {
  return client.transaction(() => {
    if (!canDispatch()) return
    const production = readProductionSettings(), evaluation = readEvaluationSettings()
    const active = (client.prepare("SELECT * FROM task_queue_jobs WHERE status='processing'").all() as any[]).map(row => rowToJob(row)!)
    if (active.length >= production.total) return
    const pending = (client.prepare("SELECT * FROM task_queue_jobs WHERE status='pending' AND ready=1 ORDER BY id").all() as any[])
      .map(row => rowToJob(row)!).filter(job => executors.has(job.ownerType) && !running.has(job.id) && !blockingReason(job, active, production, evaluation))
    const lastKind = kinds.indexOf(cursor('kind') as QueueKind)
    for (let offset = 1; offset <= kinds.length; offset++) {
      const kind = kinds[(lastKind + offset) % kinds.length]
      const candidates = pending.filter(job => job.kind === kind)
      if (!candidates.length) continue
      const projects = [...new Set(candidates.map(job => job.projectId))].sort((a,b) => a-b)
      const lastProject = Number(cursor(`project:${kind}`) || -1)
      const project = projects.find(value => value > lastProject) ?? projects[0]
      const chosen = candidates.find(job => job.projectId === project)!
      const updated = client.prepare(`UPDATE task_queue_jobs SET status='processing',phase='preparing',attempt=attempt+1,started_at=?,updated_at=? WHERE id=? AND status='pending'`).run(now(), now(), chosen.id)
      if (!updated.changes) continue
      setCursor('kind', kind); setCursor(`project:${kind}`, String(project))
      return getQueueJobById(chosen.id)
    }
  }).immediate()
}
function execute(job: QueueJob, recover = false) {
  if (running.has(job.id)) return
  const executor = executors.get(job.ownerType)
  if (!executor) return
  const promise = Promise.resolve().then(async () => {
    const current = getQueueJobById(job.id)
    if (!current || current.status !== 'processing') return
    try {
      const outcome = await (recover && executor.recover ? executor.recover(current) : executor.execute(current))
      finishQueueJob(job.id, outcome)
    } catch (error: any) {
      const latest = getQueueJobById(job.id)!
      finishQueueJob(job.id, { status: latest.submitted && !latest.upstreamDone ? 'needs_confirmation' : 'failed', error: error?.message || '任务执行失败' })
    }
  }).finally(() => { running.delete(job.id); wake() })
  running.set(job.id, promise)
}
export function tickTaskQueue(): Promise<void> {
  if (tickPromise) return tickPromise
  tickPromise = Promise.resolve().then(() => {
    for (let i = 0; i < 32; i++) { const job = claimNext(); if (!job) break; execute(job) }
  }).finally(() => { tickPromise = undefined })
  return tickPromise
}
export async function recoverTaskQueue() {
  if (!canDispatch()) return
  for (const row of client.prepare("SELECT * FROM task_queue_jobs WHERE status='processing'").all()) {
    const job = rowToJob(row)!
    if (running.has(job.id) || (job.phase === 'needs_confirmation' && !job.externalTaskId)) continue
    if (!job.submitted && !job.externalTaskId) {
      client.transaction(() => {
        executors.get(job.ownerType)?.onRequeue?.(job)
        client.prepare("UPDATE task_queue_jobs SET status='pending',phase='queued',updated_at=? WHERE id=?").run(now(), job.id)
      }).immediate()
    } else if (executors.has(job.ownerType)) execute(job, true)
    else finishQueueJob(job.id, { status: 'needs_confirmation', error: '未找到恢复执行器，请核对服务商任务状态' })
  }
}
let stopWorker: (() => void) | undefined
export async function startTaskQueueWorker(prepare?: () => Promise<void>) {
  if (stopWorker) return stopWorker
  const token = randomUUID(), leaseMs = 30_000
  const hold = client.transaction(() => {
    const previous = leaseRecord()
    // 持锁进程已死 → 锁失效，必须允许接管：否则僵尸 PID 会让后端永远无法启动
    // （2026-10-14 实证：旧后端被回收后锁里留死 PID，新后端一律 QueueError 拒起）。
    if (previous.pid) {
      let alive = false
      try { process.kill(previous.pid, 0); alive = true } catch {}
      if (alive) return false
    } else if (previous.expires && previous.expires > Date.now()) return false
    setCursor('worker', JSON.stringify({ token, pid: process.pid, expires: Date.now() + leaseMs })); return true
  }).immediate()
  if (!hold) throw new QueueError('已有任务队列执行器运行，请勿重复启动后端服务')
  workerToken = token
  try {
    await prepare?.()
    workerReady = true
    await recoverTaskQueue()
  } catch (error) {
    if (leaseRecord().token === token) client.prepare("DELETE FROM task_queue_cursors WHERE key='worker'").run()
    workerToken = undefined
    workerReady = false
    throw error
  }
  const timer = setInterval(() => {
    const lease = client.transaction(() => {
      let previous: { token?: string } = {}
      try { previous = JSON.parse(cursor('worker')) } catch {}
      if (previous.token !== token) return false
      setCursor('worker', JSON.stringify({ token, pid: process.pid, expires: Date.now() + leaseMs })); return true
    }).immediate()
    if (lease) void tickTaskQueue().catch(error => console.error('Task queue:', error.message))
  }, 1000)
  timer.unref()
  stopWorker = () => { clearInterval(timer); if (leaseRecord().token === token) client.prepare("DELETE FROM task_queue_cursors WHERE key='worker'").run(); stopWorker = undefined; workerToken = undefined; workerReady = false }
  await tickTaskQueue()
  return stopWorker
}
onQueueSettingsChange(() => {
  if (!readEvaluationSettings().enabled) {
    for (const row of client.prepare("SELECT id FROM task_queue_jobs WHERE kind='evaluation' AND source='automatic' AND status='pending'").all() as any[]) cancelQueueJob(row.id)
  }
  wake()
})
