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
import { randomUUID } from 'node:crypto'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { db, getAffectedRows, getInsertId, schema } from '../db/index.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { normalizeTimeline, orderedFrames, type FrameType, type Panel } from './previs-domain.js'
import { hashContent, PrevisError, episodeForPrevis, requireEditable, versionRow } from './previs.js'
import { FRAME_COUNT_MIN, FRAME_COUNT_MAX } from './previs-frame-contract.js'
import { parseShotDescription, suggestedVisualCount, invalidVisualPrompt, productionPlanMatchesPanel } from './shot-planning.js'
import { readFramePlanningContext } from '../agents/tools/frame-splitter-tools.js'
import { enqueueQueueJob, getQueueJob, getQueueJobById, registerQueueExecutor, updateQueueJob, resetQueueJob, tickTaskQueue, queueJobView, type QueueJob } from './task-queue.js'
import { httpErrorStatus, retryRejectedRateLimit } from './task-queue-retry.js'

export { FRAME_COUNT_MIN, FRAME_COUNT_MAX, FRAME_COUNT_OPTIONS, FRAME_GRID_LAYOUTS, FRAME_GRID_COUNTS, gridLayoutForCount } from './previs-frame-contract.js'

export interface FramePlanDraft {
  id?: string
  shotId?: string
  title: string
  prompt: string
  offsetMs: number
  type: FrameType
  /** 帧级镜头参数：AI 拆分时逐帧判断，缺省则回退面板值（生图模板已做 `frame.x || panel.x` 兜底）。 */
  shotType?: string
  angle?: string
  composition?: string
  continuity?: string
}
export interface PanelFramePlan {
  taskId: number
  panelId: number
  panelTitle: string
  count: number
  source: 'ai' | 'rule'
  continuityConstraints?: string
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
  id: z.string().trim().min(1).max(200).nullish(),
  shotId: z.string().trim().min(1).max(200).nullish(),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(4000),
  // 三个镜头参数用 nullish 而非 optional：提示词要求「未变化时填 null」，
  // 而 optional 会把 null 判为非法、导致整批解析失败并回退规则拆分。
  shotType: z.string().trim().max(50).nullish(),
  angle: z.string().trim().max(50).nullish(),
  composition: z.string().trim().max(500).nullish(),
  continuity: z.string().trim().max(2000).nullish(),
  offsetMs: z.number().int().nullish(),
})
const planResultSchema = z.object({
  continuityConstraints: z.string().trim().max(4000).nullish(),
  frames: z.array(planItemSchema).min(1).max(FRAME_COUNT_MAX),
})

/** Content determines coverage; duration alone must not manufacture additional pictures. */
export function suggestedFrameCount(panel: Panel) {
  return panel.productionPlan && productionPlanMatchesPanel(panel.productionPlan, panel)
    ? Math.min(FRAME_COUNT_MAX, Math.max(1, panel.productionPlan.shots.length)) : suggestedVisualCount(panel)
}
function hasVisual(text: string) {
  const source = text.replace(/^(?:开场|结束|关键状态|第\s*\d+\s*个瞬间)[：:]\s*/, '')
  return !invalidVisualPrompt(source) && parseShotDescription(source).some(shot => !invalidVisualPrompt(shot.visual))
}
function planningShots(panel: Panel) {
  if (panel.productionPlan && !productionPlanMatchesPanel(panel.productionPlan, panel)) throw new PrevisError('统一镜头计划已变化，请先更新计划后重新规划画面')
  const source = panel.productionPlan?.shots || parseShotDescription(panel.description)
  const fallback = parseShotDescription(panel.imagePrompt || '').find(shot => hasVisual(shot.visual))?.visual
  const firstVisual = source.find(shot => hasVisual(shot.visual))?.visual || fallback
  if (!firstVisual) throw new PrevisError('请先补充可视画面描述，再规划画面')
  let previous = firstVisual
  return (source.length ? source : [{ id: 's1', visual: firstVisual, dialogue: [] }]).map((shot, index, all) => {
    const visual = hasVisual(shot.visual) ? shot.visual : previous
    previous = visual
    return { ...shot, visual,
      startMs: 'startMs' in shot ? Number(shot.startMs) : Math.floor(index * panel.durationMs / all.length),
      endMs: 'endMs' in shot ? Number(shot.endMs) : Math.floor((index + 1) * panel.durationMs / all.length) }
  })
}
function requireCoverage(panel: Panel, count: number) {
  const shots = planningShots(panel)
  if (shots.length > FRAME_COUNT_MAX) throw new PrevisError('子镜头超过 9 个，请先拆分段落再规划画面')
  if (count < shots.length) throw new PrevisError(`至少需要 ${shots.length} 张画面才能覆盖全部子镜头`)
  return shots
}
function defaultFrameMapping(panel: Panel, count: number) {
  const shots = requireCoverage(panel, count)
  const allocations = shots.map((_, i) => Math.floor((i + 1) * count / shots.length) - Math.floor(i * count / shots.length))
  return shots.flatMap((shot, i) => Array.from({ length: allocations[i] }, (_, index) => ({
    shotId: shot.id, visual: shot.visual,
    offsetMs: shot.startMs + offsetAt(index, allocations[i], shot.endMs - shot.startMs),
  })))
}
export function clampCount(value: number | undefined, fallback: number) {
  const next = Math.round(value ?? fallback)
  if (!Number.isFinite(next)) return fallback
  return Math.min(FRAME_COUNT_MAX, Math.max(FRAME_COUNT_MIN, next))
}
function frameTypeAt(index: number, total: number): FrameType {
  if (total === 1) return 'beat'
  if (index === 0) return 'start'
  if (index === total - 1 && total > 1) return 'end'
  if (total === 3 && index === 1) return 'middle'
  return 'beat'
}
/**
 * 画面时间点按等距铺满整个镜头：首帧 0、末帧 durationMs-1。
 * 除数必须是 count-1，用 count 会让末帧停在 durationMs * (count-1)/count，
 * 结束画面与镜头结束之间留出一整段空白（10s/5 张时末帧落在 8s 而非 9.999s）。
 */
function offsetAt(index: number, count: number, durationMs: number) {
  const span = Math.max(1, durationMs - 1)
  if (count <= 1) return 0
  return Math.round(index * span / (count - 1))
}
/** 空串按「未指定」处理，避免用空值覆盖生图模板里的面板级回退。 */
function optionalText(value: unknown): string | undefined {
  const text = String(value ?? '').trim()
  return text || undefined
}
type DraftSource = z.infer<typeof planItemSchema>
function validOffsets(offsets: unknown[], count: number, durationMs: number): offsets is number[] {
  return offsets.length === count && offsets.every((offset, index) => typeof offset === 'number'
    && Number.isInteger(offset) && offset >= 0 && offset < durationMs && (index === 0 || offset > Number(offsets[index - 1])))
}
function draftFrames(panel: Panel, count: number, source: DraftSource[]): FramePlanDraft[] | null {
  const items = source.slice(0, count)
  if (items.some(item => !hasVisual(item.prompt))) return null
  let mapping: ReturnType<typeof defaultFrameMapping>
  let shots: ReturnType<typeof requireCoverage>
  try { mapping = defaultFrameMapping(panel, count); shots = requireCoverage(panel, count) } catch { return null }
  const existingFrames = orderedFrames(panel)
  const existingOffsets = existingFrames.map(frame => frame.offsetMs)
  const proposedOffsets = items.map(item => item.offsetMs)
  const offsets = validOffsets(proposedOffsets, count, panel.durationMs) ? proposedOffsets
    : validOffsets(existingOffsets, count, panel.durationMs) ? existingOffsets
    : mapping.map(item => item.offsetMs)
  const shotIds = items.map((item, index) => item.shotId || (panel.productionPlan
    ? shots.find(shot => offsets[index] >= shot.startMs && offsets[index] < shot.endMs)?.id : mapping[index].shotId))
  if (shots.some(shot => !shotIds.includes(shot.id)) || shotIds.some((id, index) => {
    const shot = shots.find(shot => shot.id === id)
    return !shot || (index > 0 && shots.findIndex(shot => shot.id === id) < shots.findIndex(shot => shot.id === shotIds[index - 1]))
      || (panel.productionPlan && (offsets[index] < shot.startMs || offsets[index] >= shot.endMs))
  })) return null
  return items.map((item, index) => ({
    id: existingFrames[index]?.id || randomUUID(), shotId: shotIds[index],
    title: item.title.trim() || (index === 0 ? '开场画面' : index === count - 1 ? '结束画面' : `画面 ${index + 1}`),
    prompt: item.prompt.trim(), offsetMs: offsets[index], type: frameTypeAt(index, count),
    shotType: optionalText(item.shotType), angle: optionalText(item.angle),
    composition: optionalText(item.composition), continuity: optionalText(item.continuity),
  }))
}

/** Old plan fields remain readable; AI generation separately requires the continuity contract. */
export function normalizeFramePlan(panel: Panel, count: number, input: unknown): { frames: FramePlanDraft[]; continuityConstraints?: string } | null {
  const parsed = planResultSchema.safeParse(input)
  if (!parsed.success || parsed.data.frames.length !== count) return null
  const frames = draftFrames(panel, count, parsed.data.frames)
  return frames ? { frames, continuityConstraints: optionalText(parsed.data.continuityConstraints) } : null
}

/** Rule drafts retain complete visual subshot coverage and never turn spoken clauses into pictures. */
export function ruleFrames(panel: Panel, count: number): FramePlanDraft[] {
  const mapping = defaultFrameMapping(panel, count)
  const items = mapping.map((shot, index) => ({
    shotId: shot.shotId, offsetMs: shot.offsetMs,
    title: count === 1 ? '关键画面' : `画面 ${index + 1}`,
    prompt: [shot.visual, panel.atmosphere?.trim()].filter(Boolean).join('；'),
    shotType: panel.shotType, angle: panel.angle,
    continuity: index === 0 ? '规则草稿：请核对起始静态状态、身份与持物。'
      : `规则草稿：从 ${mapping[index - 1].shotId} 到 ${shot.shotId}，请核对当前姿态和动作衔接。`,
  }))
  const frames = draftFrames(panel, count, items)
  if (!frames) throw new PrevisError('规则画面草稿缺少有效可视描述或子镜头覆盖')
  return frames
}

export function planInputHash(panel: Panel, context?: unknown) {
  return hashContent({
    productionPlan: panel.productionPlan, description: panel.description, videoPrompt: panel.videoPrompt, imagePrompt: panel.imagePrompt,
    atmosphere: panel.atmosphere, durationMs: panel.durationMs,
    shotType: panel.shotType, angle: panel.angle, movement: panel.movement,
    scene: panel.scene, characterIds: panel.characterIds, propIds: panel.propIds,
    frames: orderedFrames(panel).map(frame => ({ id: frame.id, title: frame.title, prompt: frame.prompt, offsetMs: frame.offsetMs, url: frame.url, source: frame.source,
      type: frame.type, shotId: frame.shotId, shotType: frame.shotType, angle: frame.angle, composition: frame.composition, continuity: frame.continuity })),
    continuityConstraints: panel.continuityConstraints, context,
  })
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  return JSON.parse(source)
}

type PlanRow = typeof schema.framePlans.$inferSelect
type PlanningContext = Awaited<ReturnType<typeof readFramePlanningContext>>

/** The model receives the complete server-read context even if it never calls a tool. */
export function buildFramePlanningRequestContent(input: {
  versionId: number; panelId: number; count: number; context: PlanningContext
}) {
  return [
    `请规划同一分镜的静态关键画面，versionId=${input.versionId}，panelId=${input.panelId}。目标画面数：${input.count}。`,
    '以下是服务端已读取的完整资料，优先直接使用；仅在缺少补充资料时调用 read_previs_context。',
    '存在 productionPlan 时，以它的 shots、shotId、startMs/endMs、完整对白时间为唯一时序依据，覆盖每个子镜头；description、videoPrompt 用于核对原文，不能另造一套切镜或时间。无统一计划时按 visualShots 覆盖可视子镜头。imagePrompt、资产与 referenceManifest 锚定视觉身份和环境；style 决定风格。',
    '每格返回对应 shotId 和该子镜头时间范围内的 offsetMs；每个子镜头至少一格。每格只呈现当前姿态、位置、手部与持物、视线，不复制对白、标点或整段动作。保留现有 ID 与媒体；有明确时序依据时可以修正旧 offsetMs。',
    JSON.stringify(input),
  ].join('\n')
}

async function aiFrames(row: PlanRow, panel: Panel, context: PlanningContext): Promise<ReturnType<typeof normalizeFramePlan>> {
  if (!row.configId) return null
  try {
    const version = (await versionRow(row.versionId))
    const episode = (await episodeForPrevis(version.episodeId))
    const agent = mastra.getAgent('frame_splitter')
    if (!agent) return null
    const requestContext = (await buildAgentRequestContext({
      episodeId: episode.id,
      dramaId: episode.dramaId,
      modelOverride: row.model || undefined,
      textConfigId: row.configId || undefined,
    }))
    const job = (await getQueueJob('frame_plan', row.id))
    const response = await retryRejectedRateLimit(async () => {
      if (job) {
        if ((await getQueueJobById(job.id))?.status !== 'processing') throw new Error('规划已取消')
        await currentPlanInput(row)
        const snapshot = JSON.parse(job.snapshotJson), config = await getConfigById(row.configId)
        if (snapshot.configHash && (!config || hashContent(config) !== snapshot.configHash)) throw new Error('规划模型配置已变化，请重新提交')
        if ((await getQueueJobById(job.id))?.status !== 'processing') throw new Error('规划已取消')
        await updateQueueJob(job.id, { submitted: true, phase: 'upstream' })
      }
      return agent.generate([{
        role: 'user',
        content: buildFramePlanningRequestContent({ versionId: version.id, panelId: panel.id, count: row.count, context }),
      }], { maxSteps: 3, requestContext })
    }, async () => { if (job) (await updateQueueJob(job.id, { submitted: false, phase: 'retry_wait' })) })
    if (job) (await updateQueueJob(job.id, { upstreamDone: true, phase: 'saving' }))
    const parsed = planResultSchema.safeParse(parseJsonObject(response.text))
    if (!parsed.success || !parsed.data.continuityConstraints || parsed.data.frames.some(frame => !frame.continuity)) return null
    return normalizeFramePlan(panel, row.count, parsed.data)
  } catch (error: any) {
    const job = (await getQueueJob('frame_plan', row.id))
    const status = httpErrorStatus(error)
    if (job && status === 429) {
      (await updateQueueJob(job.id, { submitted: false }))
      throw error
    }
    if (job && !job.submitted && !job.upstreamDone) throw error
    if (job?.submitted && !job.upstreamDone && (!Number.isInteger(status) || status! >= 500 || status === 408)) throw error
    if (job?.submitted) (await updateQueueJob(job.id, { upstreamDone: true }))
    return null
  }
}

/** 提交拆分任务：写入/复用 frame_plans 记录后立即返回，不等待模型。 */
export async function startFramePlan(versionId: number, options: PlanFramesOptions): Promise<{ queued: number; taskIds: number[] }> {
  const row = (await requireEditable(versionId, options.revision))
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
  const episode = (await episodeForPrevis(row.episodeId))
  const prepared: { panelId: number; inputHash: string; count: number }[] = []
  for (const panel of targets) {
    const context = await readFramePlanningContext(versionId, [panel.id], episode.id, episode.dramaId)
    if ('error' in context) throw new PrevisError(context.error || '镜头资料不可用')
    const inputHash = planInputHash(panel, context)
    const count = clampCount(options.count, suggestedFrameCount(panel))
    requireCoverage(panel, count)
    prepared.push({ panelId: panel.id, inputHash, count })
  }
  // Resolve every target first, then reuse/queue atomically after async context reads.
  ;await requireEditable(versionId, options.revision)
  const result = (await db.transaction(async tx => {
    const ts = new Date().toISOString()
    let queued = 0
    const taskIds: number[] = []
    for (const { panelId, inputHash, count } of prepared) {
      const active = (await tx.select().from(schema.framePlans).where(and(
        eq(schema.framePlans.versionId, versionId), eq(schema.framePlans.panelId, panelId),
        inArray(schema.framePlans.status, ['pending', 'processing']),
      )).get())
      if (active) {
        if (active.inputHash !== inputHash || active.count !== count || active.configId !== configId || active.model !== model)
          throw new PrevisError('请等待当前画面规划结束，再修改资料或规划选项', 409)
        taskIds.push(active.id)
        continue
      }
      const existing = (await tx.select().from(schema.framePlans)
        .where(and(
          eq(schema.framePlans.versionId, versionId),
          eq(schema.framePlans.panelId, panelId),
          eq(schema.framePlans.inputHash, inputHash),
        )).get())
      if (existing) taskIds.push(existing.id)
      if (existing?.status === 'completed' && !options.force && existing.count === count && existing.configId === configId && existing.model === model) continue
      if (existing) {
        await tx.update(schema.framePlans).set({ status: 'pending', error: null, resultJson: '', count, configId, model, createdAt: ts })
          .where(eq(schema.framePlans.id, existing.id)).run()
      } else {
        const inserted = (await tx.insert(schema.framePlans).values({
          versionId, panelId, inputHash, configId, model, count,
          status: 'pending', resultJson: '', createdAt: ts,
        }).run())
        taskIds.push(getInsertId(inserted))
      }
      const id = taskIds.at(-1)!
      const snapshotJson = JSON.stringify({ configHash: config ? hashContent(config) : null })
      const queueInput = { ownerType: 'frame_plan' as const, ownerId: id, kind: 'planning' as const,
        projectId: episode.dramaId, configId, inputHash, snapshotJson }
      if ((await getQueueJob('frame_plan', id))) (await resetQueueJob('frame_plan', id, queueInput))
      else (await enqueueQueueJob(queueInput))
      queued++
    }
    return { queued, taskIds }
  }))
  void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message))
  return result
}

const activePlans = new Map<number, Promise<void>>()

async function currentPlanInput(row: PlanRow) {
  const version = (await versionRow(row.versionId))
  const episode = (await episodeForPrevis(version.episodeId))
  const panel = normalizeTimeline(JSON.parse(version.timelineJson)).panels.find(item => item.id === row.panelId)
  if (!panel) throw new Error('镜头资料已变化，请重新提交画面规划')
  const context = await readFramePlanningContext(row.versionId, [row.panelId], episode.id, episode.dramaId)
  if ('error' in context || planInputHash(panel, context) !== row.inputHash)
    throw new Error('镜头资料已变化，请重新提交画面规划')
  return { panel, context }
}

async function processOne(row: PlanRow) {
  if (activePlans.has(row.id)) return
  const claimedAt = new Date().toISOString()
  const claimedRow = and(eq(schema.framePlans.id, row.id), eq(schema.framePlans.inputHash, row.inputHash),
    eq(schema.framePlans.status, 'processing'), eq(schema.framePlans.createdAt, claimedAt))
  const claim = (await db.update(schema.framePlans)
    .set({ status: 'processing', createdAt: claimedAt })
    .where(and(eq(schema.framePlans.id, row.id), eq(schema.framePlans.status, 'pending'),
      eq(schema.framePlans.inputHash, row.inputHash), eq(schema.framePlans.count, row.count),
      eq(schema.framePlans.configId, row.configId), eq(schema.framePlans.model, row.model))).run())
  if (!getAffectedRows(claim)) return
  const execution = (async () => {
    try {
      const { panel, context } = await currentPlanInput(row)
      const job = (await getQueueJob('frame_plan', row.id))
      const snapshot = JSON.parse(job?.snapshotJson || '{}')
      const config = row.configId ? await getConfigById(row.configId) : null
      if (snapshot.configHash && (!config || snapshot.configHash !== hashContent(config))) throw new Error('规划模型配置已变化，请重新提交')
      const ai = await aiFrames(row, panel, context)
      await currentPlanInput(row)
      const frames = ai?.frames || ruleFrames(panel, row.count)
      const continuityConstraints = ai?.continuityConstraints || panel.continuityConstraints
        || '规则草稿：人物身份与服装、场景空间、光源和道具外观须由用户审阅确认；动作衔接尚未通过 AI 连续性审查。'
      ;await db.update(schema.framePlans).set({
        status: 'completed',
        resultJson: JSON.stringify({ source: ai ? 'ai' : 'rule', continuityConstraints, frames }),
        error: null,
        createdAt: new Date().toISOString(),
      }).where(claimedRow).run()
    } catch (error: any) {
      const job = (await getQueueJob('frame_plan', row.id))
      const uncertain = job?.submitted && !job.upstreamDone
      ;await db.update(schema.framePlans).set({ status: uncertain ? 'processing' : 'failed', resultJson: '',
        error: uncertain ? `请求结果不确定，请核对服务商记录：${error?.message}` : error?.message || '拆分失败' })
        .where(claimedRow).run()
    }
  })().finally(() => activePlans.delete(row.id))
  activePlans.set(row.id, execution)
  await execution
}

registerQueueExecutor('frame_plan', {
  execute: async job => {
    const row = (await db.select().from(schema.framePlans).where(eq(schema.framePlans.id, job.ownerId)).get())
    if (!row) return { status: 'failed', error: '画面规划不存在' }
    await processOne(row)
    const saved = (await db.select().from(schema.framePlans).where(eq(schema.framePlans.id, job.ownerId)).get())!
    const current = (await getQueueJobById(job.id))!
    return { status: saved.status === 'completed' ? 'completed' : current.submitted && !current.upstreamDone ? 'needs_confirmation' : 'failed', error: saved.error || undefined }
  },
  recover: async job => {
    const row = (await db.select().from(schema.framePlans).where(eq(schema.framePlans.id, job.ownerId)).get())
    if (row?.status === 'completed') return { status: 'completed' }
    if (job.upstreamDone) {
      await db.update(schema.framePlans).set({ status: 'failed', error: '规划结果未保存完整，请重新规划' }).where(eq(schema.framePlans.id, job.ownerId)).run()
      return { status: 'failed', error: '规划结果未保存完整，请重新规划' }
    }
    return { status: 'needs_confirmation', error: '服务重启，画面规划可能已提交，请核对服务商记录' }
  },
  onRequeue: async job => { await db.update(schema.framePlans).set({ status: 'pending', error: null }).where(eq(schema.framePlans.id, job.ownerId)).run() },
  onCancel: async job => { await db.update(schema.framePlans).set({ status: 'cancelled', error: '已取消排队' }).where(eq(schema.framePlans.id, job.ownerId)).run() },
  onRetry: async job => {
    (await updateQueueJob(job.id, { submitted: false, externalTaskId: null, upstreamDone: false }))
    ;await db.update(schema.framePlans).set({ status: 'pending', error: null, resultJson: '', createdAt: new Date().toISOString() }).where(eq(schema.framePlans.id, job.ownerId)).run()
  },
  onReconcile: async job => { await db.update(schema.framePlans).set({ status: 'failed', error: '已人工确认服务商任务结束' }).where(eq(schema.framePlans.id, job.ownerId)).run() },
})
export async function migrateFramePlanQueue() {
  for (const row of (await db.select().from(schema.framePlans).where(inArray(schema.framePlans.status, ['pending', 'processing'])).all())) {
    if ((await getQueueJob('frame_plan', row.id))) continue
    const version = (await versionRow(row.versionId)), episode = (await episodeForPrevis(version.episodeId))
    const config = row.configId ? await getConfigById(row.configId) : null
    await enqueueQueueJob({ ownerType: 'frame_plan', ownerId: row.id, kind: 'planning', projectId: episode.dramaId,
      configId: row.configId, inputHash: row.inputHash, snapshotJson: JSON.stringify({ configHash: config ? hashContent(config) : null }),
      initialStatus: row.status as 'pending' | 'processing', submitted: row.status === 'processing' && !!row.configId })
  }
}
/** 所有规划通过统一调度领取；不再凭本地过期时间重复提交模型。 */
export async function tickFramePlans() {
  await migrateFramePlanQueue()
  await tickTaskQueue()
  // Keep the manual worker helper awaitable for local tests without holding HTTP requests.
  await Promise.all([...activePlans.values()])
}

/** 查询某版本的拆分任务状态与已完成方案。 */
export async function listFramePlans(versionId: number) {
  const row = (await versionRow(versionId))
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const titleOf = (panelId: number) => timeline.panels.find(item => item.id === panelId)?.title || ''
  const rows = (await db.select().from(schema.framePlans)
    .where(eq(schema.framePlans.versionId, versionId)).orderBy(desc(schema.framePlans.id)).all())
  const plans: PanelFramePlan[] = []
  for (const item of rows) {
    if (item.status !== 'completed') continue
    try {
      const parsed = JSON.parse(item.resultJson) as { source: 'ai' | 'rule'; continuityConstraints?: string; frames: FramePlanDraft[] }
      plans.push({ taskId: item.id, panelId: item.panelId, panelTitle: titleOf(item.panelId), count: parsed.frames.length,
        source: parsed.source, continuityConstraints: parsed.continuityConstraints, frames: parsed.frames })
    } catch { /* 忽略损坏结果 */ }
  }
  const count = (status: string) => rows.filter(item => item.status === status).length
  return {
    items: await Promise.all(rows.map(async item => ({
      id: item.id, panelId: item.panelId, status: item.status as FramePlanStatus['status'],
      count: item.count, error: item.error, createdAt: item.createdAt, ...(await queueJobView('frame_plan', item.id)),
    }))),
    plans,
    summary: { pending: count('pending'), processing: count('processing'), completed: count('completed'), failed: count('failed') },
  }
}

/** 重试指定镜头（或全部失败项）：重置为 pending 并触发处理。 */
export async function retryFramePlans(versionId: number, panelIds?: number[]) {
  const rows = (await db.select().from(schema.framePlans).where(and(
    eq(schema.framePlans.versionId, versionId),
    eq(schema.framePlans.status, 'failed'),
    ...(panelIds?.length ? [inArray(schema.framePlans.panelId, panelIds)] : []),
  )).all())
  for (const row of rows) {
    await db.update(schema.framePlans).set({ status: 'pending', error: null, createdAt: new Date().toISOString() })
      .where(eq(schema.framePlans.id, row.id)).run()
  }
  for (const row of rows) (await resetQueueJob('frame_plan', row.id))
  void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message))
  return { queued: rows.length }
}

/** 启动 worker：恢复残留任务后每 1.5s 轮询处理一次。 */
export async function startFramePlanWorker() {
  await migrateFramePlanQueue()
  void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message))
  const timer = setInterval(() => { void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message)) }, 1500)
  timer.unref()
  return () => clearInterval(timer)
}
