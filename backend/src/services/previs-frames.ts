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
import { db, schema } from '../db/index.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { normalizeTimeline, orderedFrames, panelImageFallback, type FrameType, type Panel } from './previs-domain.js'
import { hashContent, PrevisError, episodeForPrevis, requireEditable, versionRow } from './previs.js'
import { FRAME_COUNT_MIN, FRAME_COUNT_MAX } from './previs-frame-contract.js'
import { readFramePlanningContext } from '../agents/tools/frame-splitter-tools.js'

export { FRAME_COUNT_MIN, FRAME_COUNT_MAX, FRAME_COUNT_OPTIONS } from './previs-frame-contract.js'
const FRAME_PLAN_LEASE_MS = 30 * 60 * 1000

export interface FramePlanDraft {
  id?: string
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
function draftFrames(panel: Panel, count: number, source: DraftSource[]): FramePlanDraft[] {
  const items = source.slice(0, count)
  const existingFrames = orderedFrames(panel)
  const existingOffsets = existingFrames.map(frame => frame.offsetMs)
  const proposedOffsets = items.map(item => item.offsetMs)
  const offsets = validOffsets(existingOffsets, count, panel.durationMs) ? existingOffsets
    : validOffsets(proposedOffsets, count, panel.durationMs) ? proposedOffsets
    : items.map((_, index) => offsetAt(index, count, panel.durationMs))
  return items.map((item, index) => ({
    id: existingFrames[index]?.id || randomUUID(),
    title: item.title.trim() || (index === 0 ? '开场画面' : index === count - 1 ? '结束画面' : `画面 ${index + 1}`),
    prompt: item.prompt.trim(),
    offsetMs: offsets[index],
    type: frameTypeAt(index, count),
    shotType: optionalText(item.shotType),
    angle: optionalText(item.angle),
    composition: optionalText(item.composition),
    continuity: optionalText(item.continuity),
  })).filter(frame => frame.prompt)
}

/** Old plan fields remain readable; AI generation separately requires the continuity contract. */
export function normalizeFramePlan(panel: Panel, count: number, input: unknown): { frames: FramePlanDraft[]; continuityConstraints?: string } | null {
  const parsed = planResultSchema.safeParse(input)
  if (!parsed.success || parsed.data.frames.length !== count) return null
  return { frames: draftFrames(panel, count, parsed.data.frames), continuityConstraints: optionalText(parsed.data.continuityConstraints) }
}

/** 规则兜底：描述分句优先，句数不足时用时点提示补足。 */
export function ruleFrames(panel: Panel, count: number): FramePlanDraft[] {
  const source = panel.description?.trim() || panelImageFallback(panel)
  const beats = source.split(/(?<=[。！？；!?;])|\n+/).map(part => part.trim()).filter(Boolean)
  const atmosphere = panel.atmosphere?.trim()
  const items = Array.from({ length: count }, (_, index) => {
    const beat = count === 1 ? source : beats.length >= count
      ? beats[Math.floor(index * beats.length / count)]
      : beats[index] || (beats.length ? beats[beats.length - 1] : source)
    const lead = count === 1 ? '关键状态：' : index === 0 ? '开场：' : index === count - 1 ? '结束：' : `第 ${index + 1} 个瞬间：`
    // 景别不再拼进 prompt：它由 frame.shotType 承载，生图模板会单独成句，
    // 两处都写会让提示词出现「景别 中景 … 景别：中景」这种重复矛盾描述。
    const prompt = [beat, atmosphere].filter(Boolean).join('；')
    return {
      title: count === 1 ? '关键画面' : index === 0 ? '开场画面' : index === count - 1 ? '结束画面' : `画面 ${index + 1}`,
      prompt: `${lead}${prompt}`,
      // 规则兜底没有逐帧判断能力，直接继承面板级参数（生图模板本就会回退到面板值，
      // 这里显式写出只是让确认弹窗能看到可编辑的取值）。
      shotType: panel.shotType,
      angle: panel.angle,
    }
  })
  return draftFrames(panel, count, items.map((item, index) => ({
    ...item,
    continuity: index === 0 ? `规则草稿：起始静态状态「${item.prompt}」，请人工核对动作阶段。`
      : `规则草稿：上一格「${items[index - 1].prompt}」→变化需人工核对→当前格「${item.prompt}」。`,
  })))
}

export function planInputHash(panel: Panel, context?: unknown) {
  return hashContent({
    description: panel.description, videoPrompt: panel.videoPrompt, imagePrompt: panel.imagePrompt,
    atmosphere: panel.atmosphere, durationMs: panel.durationMs,
    shotType: panel.shotType, angle: panel.angle, movement: panel.movement,
    scene: panel.scene, characterIds: panel.characterIds, propIds: panel.propIds,
    frames: orderedFrames(panel).map(frame => ({ id: frame.id, title: frame.title, prompt: frame.prompt, offsetMs: frame.offsetMs, url: frame.url, source: frame.source,
      type: frame.type, shotType: frame.shotType, angle: frame.angle, composition: frame.composition, continuity: frame.continuity })),
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
    '来源优先级：description 决定事件与切镜；videoPrompt 决定动作顺序与时间；imagePrompt 锚定视觉状态；资产元数据与 referenceManifest 锚定身份、服装、场景、道具；style 决定风格。',
    '先识别开始→转折点→结束，再按时间选取指定数量的静态瞬间。多张包含起止锚点，单张选代表状态；不新增情节。每格只呈现当前姿态、位置、手部与持物、视线，不复制整段动作。',
    JSON.stringify(input),
  ].join('\n')
}

async function aiFrames(row: PlanRow, panel: Panel, context: PlanningContext): Promise<ReturnType<typeof normalizeFramePlan>> {
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
      content: buildFramePlanningRequestContent({ versionId: version.id, panelId: panel.id, count: row.count, context }),
    }], { maxSteps: 3, requestContext })
    const parsed = planResultSchema.safeParse(parseJsonObject(response.text))
    if (!parsed.success || !parsed.data.continuityConstraints || parsed.data.frames.some(frame => !frame.continuity)) return null
    return normalizeFramePlan(panel, row.count, parsed.data)
  } catch {
    return null
  }
}

/** 提交拆分任务：写入/复用 frame_plans 记录后立即返回，不等待模型。 */
export async function startFramePlan(versionId: number, options: PlanFramesOptions): Promise<{ queued: number; taskIds: number[] }> {
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
  const episode = episodeForPrevis(row.episodeId)
  const prepared: { panelId: number; inputHash: string; count: number }[] = []
  for (const panel of targets) {
    const context = await readFramePlanningContext(versionId, [panel.id], episode.id, episode.dramaId)
    if ('error' in context) throw new PrevisError(context.error || '镜头资料不可用')
    const inputHash = planInputHash(panel, context)
    const count = clampCount(options.count, suggestedFrameCount(panel))
    prepared.push({ panelId: panel.id, inputHash, count })
  }
  // Resolve every target first, then reuse/queue atomically after async context reads.
  requireEditable(versionId, options.revision)
  const result = db.transaction(tx => {
    const ts = new Date().toISOString()
    let queued = 0
    const taskIds: number[] = []
    for (const { panelId, inputHash, count } of prepared) {
      const active = tx.select().from(schema.framePlans).where(and(
        eq(schema.framePlans.versionId, versionId), eq(schema.framePlans.panelId, panelId),
        inArray(schema.framePlans.status, ['pending', 'processing']),
      )).get()
      if (active) {
        if (active.inputHash !== inputHash || active.count !== count || active.configId !== configId || active.model !== model)
          throw new PrevisError('请等待当前画面规划结束，再修改资料或规划选项', 409)
        taskIds.push(active.id)
        continue
      }
      const existing = tx.select().from(schema.framePlans)
        .where(and(
          eq(schema.framePlans.versionId, versionId),
          eq(schema.framePlans.panelId, panelId),
          eq(schema.framePlans.inputHash, inputHash),
        )).get()
      if (existing) taskIds.push(existing.id)
      if (existing?.status === 'completed' && !options.force && existing.count === count && existing.configId === configId && existing.model === model) continue
      if (existing) {
        tx.update(schema.framePlans).set({ status: 'pending', error: null, resultJson: '', count, configId, model, createdAt: ts })
          .where(eq(schema.framePlans.id, existing.id)).run()
      } else {
        const inserted = tx.insert(schema.framePlans).values({
          versionId, panelId, inputHash, configId, model, count,
          status: 'pending', resultJson: '', createdAt: ts,
        }).run()
        taskIds.push(Number(inserted.lastInsertRowid))
      }
      queued++
    }
    return { queued, taskIds }
  })
  void tickFramePlans().catch(err => console.error('Frame plan worker:', err?.message))
  return result
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

async function currentPlanInput(row: PlanRow) {
  const version = versionRow(row.versionId)
  const episode = episodeForPrevis(version.episodeId)
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
  const claim = db.update(schema.framePlans)
    .set({ status: 'processing', createdAt: claimedAt })
    .where(and(eq(schema.framePlans.id, row.id), eq(schema.framePlans.status, 'pending'),
      eq(schema.framePlans.inputHash, row.inputHash), eq(schema.framePlans.count, row.count),
      eq(schema.framePlans.configId, row.configId), eq(schema.framePlans.model, row.model))).run()
  if (!claim.changes) return
  const execution = (async () => {
    try {
      const { panel, context } = await currentPlanInput(row)
      const ai = await aiFrames(row, panel, context)
      await currentPlanInput(row)
      const frames = ai?.frames || ruleFrames(panel, row.count)
      const continuityConstraints = ai?.continuityConstraints || panel.continuityConstraints
        || '规则草稿：人物身份与服装、场景空间、光源和道具外观须由用户审阅确认；动作衔接尚未通过 AI 连续性审查。'
      db.update(schema.framePlans).set({
        status: 'completed',
        resultJson: JSON.stringify({ source: ai ? 'ai' : 'rule', continuityConstraints, frames }),
        error: null,
        createdAt: new Date().toISOString(),
      }).where(claimedRow).run()
    } catch (error: any) {
      db.update(schema.framePlans).set({ status: 'failed', resultJson: '', error: error?.message || '拆分失败' })
        .where(claimedRow).run()
    }
  })().finally(() => activePlans.delete(row.id))
  activePlans.set(row.id, execution)
  await execution
}

/** 处理一轮待拆分任务：先把超时未完成的 processing 重置，再并发 4 处理 pending。 */
export async function tickFramePlans() {
  const stuck = db.select().from(schema.framePlans)
    .where(eq(schema.framePlans.status, 'processing')).all()
    .filter(row => !activePlans.has(row.id) && Date.now() - Date.parse(row.createdAt) >= FRAME_PLAN_LEASE_MS)
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
      const parsed = JSON.parse(item.resultJson) as { source: 'ai' | 'rule'; continuityConstraints?: string; frames: FramePlanDraft[] }
      plans.push({ taskId: item.id, panelId: item.panelId, panelTitle: titleOf(item.panelId), count: parsed.frames.length,
        source: parsed.source, continuityConstraints: parsed.continuityConstraints, frames: parsed.frames })
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
