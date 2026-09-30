/**
 * 镜头 → 分镜画面拆分（异步任务）
 *
 * 提交即返回：startFramePlan 只写入 frame_plans 待处理记录，由 worker 逐个调用标准 Agent
 * `frame_splitter`（提示词文件化、只读工具 read_previs_context、多语言、技能）。
 * AI 失败/超时/解析失败自动回退规则拆分。结果只存 frame_plans，不写时间线；
 * 用户确认后由前端走 saveTimeline 写入。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { db, schema } from '../db/index.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { normalizeTimeline, panelImageFallback, type FrameType, type Panel } from './previs-domain.js'
import { hashContent, PrevisError, episodeForPrevis, requireEditable, versionRow } from './previs.js'

export const FRAME_COUNT_MIN = 2
export const FRAME_COUNT_MAX = 6
const FRAME_PLAN_LEASE_MS = 30 * 60 * 1000

export interface FramePlanDraft {
  title: string
  prompt: string
  offsetMs: number
  type: FrameType
}
export interface PanelFramePlan {
  panelId: number
  panelTitle: string
  count: number
  source: 'ai' | 'rule'
  frames: FramePlanDraft[]
}
export interface PlanFramesOptions {
  revision: number
  panelIds: number[]
  count?: number
  configId?: number
  model?: string
  force?: boolean
}
export interface FramePlanStatus {
  id: number
  panelId: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  count: number
  error: string | null
  createdAt: string
}

const planItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(4000),
})
const planResultSchema = z.object({ frames: z.array(planItemSchema).min(1).max(FRAME_COUNT_MAX) })

/** 按时长给出默认画面数：短镜头不必拆太碎，长镜头需要更多中间过程。 */
export function suggestedFrameCount(panel: Panel) {
  const seconds = Math.max(1, Math.round((panel.durationMs || 0) / 1000))
  if (seconds <= 3) return 2
  if (seconds <= 6) return 3
  if (seconds <= 10) return 4
  return 5
}
export function clampCount(value: number | undefined, fallback: number) {
  const next = Math.round(value ?? fallback)
  if (!Number.isFinite(next)) return fallback
  return Math.min(FRAME_COUNT_MAX, Math.max(FRAME_COUNT_MIN, next))
}
function frameTypeAt(index: number, total: number): FrameType {
  if (index === 0) return 'start'
  if (index === total - 1 && total > 1) return 'end'
  if (total === 3 && index === 1) return 'middle'
  return 'beat'
}
function offsetAt(index: number, count: number, durationMs: number) {
  const span = Math.max(1, durationMs - 1)
  return Math.round(index * span / Math.max(1, count))
}
function draftFrames(count: number, durationMs: number, source: { title: string; prompt: string }[]): FramePlanDraft[] {
  return source.slice(0, count).map((item, index) => ({
    title: item.title.trim() || (index === 0 ? '开场画面' : index === count - 1 ? '结束画面' : `画面 ${index + 1}`),
    prompt: item.prompt.trim(),
    offsetMs: offsetAt(index, count, durationMs),
    type: frameTypeAt(index, count),
  })).filter(frame => frame.prompt)
}

/** 规则兜底：描述分句优先，句数不足时用时点提示补足。 */
export function ruleFrames(panel: Panel, count: number): FramePlanDraft[] {
  const source = panel.description?.trim() || panelImageFallback(panel)
  const beats = source.split(/(?<=[。！？；!?;])|\n+/).map(part => part.trim()).filter(Boolean)
  const atmosphere = panel.atmosphere?.trim()
  const items = Array.from({ length: count }, (_, index) => {
    const beat = beats.length >= count
      ? beats[Math.floor(index * beats.length / count)]
      : beats[index] || (beats.length ? beats[beats.length - 1] : source)
    const lead = index === 0 ? '开场：' : index === count - 1 ? '结束：' : `第 ${index + 1} 个瞬间：`
    const prompt = [beat, atmosphere, panel.shotType ? `景别 ${panel.shotType}` : ''].filter(Boolean).join('；')
    return { title: index === 0 ? '开场画面' : index === count - 1 ? '结束画面' : `画面 ${index + 1}`, prompt: `${lead}${prompt}` }
  })
  return draftFrames(count, panel.durationMs, items)
}

function planInputHash(panel: Panel) {
  return hashContent({
    description: panel.description, atmosphere: panel.atmosphere, durationMs: panel.durationMs,
    shotType: panel.shotType, angle: panel.angle, movement: panel.movement,
    scene: panel.scene, characterIds: panel.characterIds, propIds: panel.propIds,
  })
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  return JSON.parse(source)
}

type PlanRow = typeof schema.framePlans.$inferSelect

async function aiFrames(row: PlanRow, panel: Panel): Promise<FramePlanDraft[] | null> {
  try {
    const version = versionRow(row.versionId)
    const episode = episodeForPrevis(version.episodeId)
    const agent = mastra.getAgent('frame_splitter')
    if (!agent) return null
    const requestContext = buildAgentRequestContext({
      episodeId: episode.id,
      dramaId: episode.dramaId,
      modelOverride: row.model || undefined,
      textConfigId: row.configId || undefined,
    })
    const response = await agent.generate([{
      role: 'user',
      content: `请把镜头「${panel.title}」（panelId=${panel.id}）拆成 ${row.count} 张画面。先调用 read_previs_context 读取 versionId=${version.id} 的镜头资料。`,
    }], { maxSteps: 3, requestContext })
    const parsed = planResultSchema.safeParse(parseJsonObject(response.text))
    if (!parsed.success || !parsed.data.frames.length) return null
    const frames = draftFrames(Math.min(row.count, parsed.data.frames.length), panel.durationMs, parsed.data.frames)
    return frames.length ? frames : null
  } catch {
    return null
  }
}

/** 提交拆分任务：写入/复用 frame_plans 记录后立即返回，不等待模型。 */
export async function startFramePlan(versionId: number, options: PlanFramesOptions): Promise<{ queued: number }> {
  const row = requireEditable(versionId, options.revision)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const panels = timeline.panels.filter(panel => options.panelIds.includes(panel.id))
  if (!panels.length) throw new PrevisError('所选镜头不属于当前版本')
  const targets = panels.filter(panel => options.force || !panel.frames.length)
  if (!targets.length) {
    throw new PrevisError(options.force ? '所选镜头不属于当前版本' : '所选镜头都已有画面；如需重拆请确认覆盖')
  }

  const configId = options.configId || await getActiveConfigId('text') || 0
  const config = configId ? await getConfigById(configId) : null
  const model = options.model || config?.model || ''
  const ts = new Date().toISOString()
  let queued = 0

  for (const panel of targets) {
    const inputHash = planInputHash(panel)
    const count = clampCount(options.count, suggestedFrameCount(panel))
    const existing = db.select().from(schema.framePlans)
      .where(and(
        eq(schema.framePlans.versionId, versionId),
        eq(schema.framePlans.panelId, panel.id),
        eq(schema.framePlans.inputHash, inputHash),
      )).get()
    if (existing?.status === 'completed' && !options.force) continue
    if (existing) {
      db.update(schema.framePlans).set({ status: 'pending', error: null, count, configId, model, createdAt: ts })
        .where(eq(schema.framePlans.id, existing.id)).run()
    } else {
      db.insert(schema.framePlans).values({
        versionId, panelId: panel.id, inputHash, configId, model, count,
        status: 'pending', resultJson: '', createdAt: ts,
      }).run()
    }
    queued++
  }
  void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message))
  return { queued }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

const activePlans = new Map<number, Promise<void>>()

async function processOne(row: PlanRow) {
  if (activePlans.has(row.id)) return
  const claim = db.update(schema.framePlans)
    .set({ status: 'processing', createdAt: new Date().toISOString() })
    .where(and(eq(schema.framePlans.id, row.id), eq(schema.framePlans.status, 'pending'))).run()
  if (!claim.changes) return
  const execution = (async () => {
    try {
      const version = versionRow(row.versionId)
      const timeline = normalizeTimeline(JSON.parse(version.timelineJson))
      const panel = timeline.panels.find(item => item.id === row.panelId)
      if (!panel) throw new Error('镜头不存在，可能已从版本中移除')
      const ai = await aiFrames(row, panel)
      const frames = ai || ruleFrames(panel, row.count)
      db.update(schema.framePlans).set({
        status: 'completed',
        resultJson: JSON.stringify({ source: ai ? 'ai' : 'rule', frames }),
        error: null,
        createdAt: new Date().toISOString(),
      }).where(eq(schema.framePlans.id, row.id)).run()
    } catch (error: any) {
      db.update(schema.framePlans).set({ status: 'failed', error: error?.message || '拆分失败' })
        .where(eq(schema.framePlans.id, row.id)).run()
    }
  })().finally(() => activePlans.delete(row.id))
  activePlans.set(row.id, execution)
  await execution
}

/** 处理一轮待拆分任务：先把超时未完成的 processing 重置，再并发 4 处理 pending。 */
export async function tickFramePlans() {
  const stuck = db.select().from(schema.framePlans)
    .where(eq(schema.framePlans.status, 'processing')).all()
    .filter(row => Date.now() - Date.parse(row.createdAt) >= FRAME_PLAN_LEASE_MS)
  for (const row of stuck) {
    db.update(schema.framePlans).set({ status: 'pending' }).where(eq(schema.framePlans.id, row.id)).run()
  }
  const pending = db.select().from(schema.framePlans)
    .where(eq(schema.framePlans.status, 'pending')).all()
  if (pending.length) await mapLimit(pending, 4, processOne)
}

/** 查询某版本的拆分任务状态与已完成方案。 */
export function listFramePlans(versionId: number) {
  const row = versionRow(versionId)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const titleOf = (panelId: number) => timeline.panels.find(item => item.id === panelId)?.title || ''
  const rows = db.select().from(schema.framePlans)
    .where(eq(schema.framePlans.versionId, versionId)).orderBy(desc(schema.framePlans.id)).all()
  const plans: PanelFramePlan[] = []
  for (const item of rows) {
    if (item.status !== 'completed') continue
    try {
      const parsed = JSON.parse(item.resultJson) as { source: 'ai' | 'rule'; frames: FramePlanDraft[] }
      plans.push({ panelId: item.panelId, panelTitle: titleOf(item.panelId), count: parsed.frames.length, source: parsed.source, frames: parsed.frames })
    } catch { /* 忽略损坏结果 */ }
  }
  const count = (status: string) => rows.filter(item => item.status === status).length
  return {
    items: rows.map(item => ({
      id: item.id, panelId: item.panelId, status: item.status as FramePlanStatus['status'],
      count: item.count, error: item.error, createdAt: item.createdAt,
    })),
    plans,
    summary: { pending: count('pending'), processing: count('processing'), completed: count('completed'), failed: count('failed') },
  }
}

/** 重试指定镜头（或全部失败项）：重置为 pending 并触发处理。 */
export async function retryFramePlans(versionId: number, panelIds?: number[]) {
  const rows = db.select().from(schema.framePlans).where(and(
    eq(schema.framePlans.versionId, versionId),
    eq(schema.framePlans.status, 'failed'),
    ...(panelIds?.length ? [inArray(schema.framePlans.panelId, panelIds)] : []),
  )).all()
  for (const row of rows) {
    db.update(schema.framePlans).set({ status: 'pending', error: null, createdAt: new Date().toISOString() })
      .where(eq(schema.framePlans.id, row.id)).run()
  }
  void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message))
  return { queued: rows.length }
}

/** 启动 worker：恢复残留任务后每 1.5s 轮询处理一次。 */
export async function startFramePlanWorker() {
  await tickFramePlans()
  const timer = setInterval(() => { void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message)) }, 1500)
  timer.unref()
  return () => clearInterval(timer)
}
