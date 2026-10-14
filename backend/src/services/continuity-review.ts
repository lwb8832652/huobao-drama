import { RequestContext } from '@mastra/core/request-context'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { agentRegistry } from '../agents/index.js'
import { loadBasePromptFile } from '../agents/prompts.js'
import { getContentLanguage } from './app-settings.js'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseDataUrl, readImageAsCompressedDataUrl } from '../utils/storage.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import {
  groupPanels, normalizeTimeline, orderedFrames,
  type ContinuityReview, type ContinuityReviewResult, type Panel, type Timeline,
} from './previs-domain.js'
import { hashContent, PrevisError, versionRow } from './previs.js'
import { readEvaluationSettings, patchLegacyEvaluationSettings } from './task-queue-settings.js'
import { enqueueQueueJob, getQueueJob, getQueueJobById, registerQueueExecutor, updateQueueJob, resetQueueJob, tickTaskQueue, queueJobView, type QueueJob, type QueueOutcome } from './task-queue.js'
import { onQueueSettingsChange } from './task-queue-settings.js'
import { httpErrorStatus, retryRejectedRateLimit } from './task-queue-retry.js'
import { freezeReferenceMedia, readReferenceMedia, mediaDigest } from './previs-reference-media.js'

// 模型输出容错（对齐 storyboard-tools 的 looseBool/looseNum 约定）：
// qwen 等模型偶尔会省略 comment、把 score 返回成数字字符串、或漏给 summary——
// 这些不影响评分本质，回退为默认值而不是让整条评测失败。
const looseNum = <A extends z.ZodTypeAny>(schema: A): A =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v), schema) as unknown as A
const looseComment = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() ? v : '未说明'),
  z.string().trim().min(1).max(1000),
)
const dimensionSchema = z.object({
  score: looseNum(z.number().min(0).max(25)),
  comment: looseComment,
})
export const continuityReviewResultSchema = z.object({
  overallScore: looseNum(z.number().min(0).max(100)),
  confidence: z.preprocess(
    (v) => (['high', 'medium', 'low'].includes(v as string) ? v : 'low'),
    z.enum(['high', 'medium', 'low']),
  ),
  summary: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v : '未提供摘要'),
    z.string().trim().min(1).max(2000),
  ),
  dimensions: z.object({
    subject: dimensionSchema,
    scene: dimensionSchema,
    action: dimensionSchema,
    camera: dimensionSchema,
  }),
  issues: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter(item => typeof item === 'string' && item.trim()) : []),
    z.array(z.string().trim().min(1).max(1000)).max(8),
  ),
  suggestions: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter(item => typeof item === 'string' && item.trim()) : []),
    z.array(z.string().trim().min(1).max(1000)).max(8),
  ),
})

interface ReviewPanelContext {
  group: { id: string; title: string; note: string }
  panel: {
    id: number
    title: string
    description: string
    atmosphere: string
    videoPrompt: string
    scene: string
    shotType: string
    angle: string
    movement: string
  }
  frame: {
    id: string
    title: string
    prompt: string
    url: string
  } | null
  sceneAsset: Record<string, unknown> | null
  characters: Record<string, unknown>[]
  props: Record<string, unknown>[]
}

export interface ContinuityReviewInput {
  transition: {
    type: string
    continuity: string
    allowedChanges: string[]
  }
  from: ReviewPanelContext
  to: ReviewPanelContext
}

interface ReviewOptions {
  revision: number
  toGroupId: string
  configId?: number
  model?: string
  force?: boolean
  expectedInputHash?: string
}

interface ReviewerOptions {
  configId: number
  model: string
  queueJobId?: number
}

export type ContinuityReviewer = (
  input: ContinuityReviewInput,
  options: ReviewerOptions,
) => Promise<ContinuityReviewResult>

export const continuityReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(100),
})
export function getContinuityReviewSettings() {
  const { enabled, threshold } = readEvaluationSettings()
  return { enabled, threshold }
}
export function updateContinuityReviewSettings(input: unknown) {
  return patchLegacyEvaluationSettings(input)
}

const activeReviews = new Map<number, Promise<ContinuityReview>>()
const queueReviewers = new Map<number, ContinuityReviewer>()

function panelContext(
  timeline: Timeline,
  groupId: string,
  panel: Panel,
  framePosition: 'first' | 'last',
): ReviewPanelContext {
  const group = timeline.groups.find(item => item.id === groupId)!
  const frames = orderedFrames(panel).filter(frame => frame.url)
  const frame = framePosition === 'last' ? frames.at(-1) : frames[0]
  const scene = panel.sceneId
    ? db.select().from(schema.scenes).where(eq(schema.scenes.id, panel.sceneId)).get()
    : null
  const characters = panel.characterIds.map(characterId =>
    db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get(),
  ).filter(Boolean)
  const props = panel.propIds.map(propId =>
    db.select().from(schema.props).where(eq(schema.props.id, propId)).get(),
  ).filter(Boolean)
  return {
    group: { id: group.id, title: group.title, note: group.note },
    panel: {
      id: panel.id, title: panel.title, description: panel.description,
      atmosphere: panel.atmosphere, videoPrompt: panel.videoPrompt,
      scene: panel.scene, shotType: panel.shotType, angle: panel.angle, movement: panel.movement,
    },
    frame: frame ? {
      id: frame.id || frame.type, title: frame.title || '', prompt: frame.prompt,
      url: frame.url,
    } : null,
    sceneAsset: scene ? {
      id: scene.id, location: scene.location, time: scene.time, prompt: scene.prompt,
      lighting: scene.lighting, finalPrompt: scene.finalPrompt,
    } : null,
    characters: characters.map(item => ({
      id: item!.id, name: item!.name, appearance: item!.appearance,
      styling: item!.styling, finalPrompt: item!.finalPrompt,
    })),
    props: props.map(item => ({
      id: item!.id, name: item!.name, type: item!.type,
      description: item!.description, finalPrompt: item!.finalPrompt,
    })),
  }
}

function reviewInput(timeline: Timeline, toGroupId: string): ContinuityReviewInput {
  const transition = timeline.transitions.find(item => item.to === toGroupId)
  if (!transition) throw new PrevisError('首个镜头没有上一镜头，无需进行相邻镜头评分')
  const fromGroup = timeline.groups.find(item => item.id === transition.from)
  const toGroup = timeline.groups.find(item => item.id === transition.to)
  const fromPanel = fromGroup && groupPanels(timeline, fromGroup).at(-1)
  const toPanel = toGroup && groupPanels(timeline, toGroup)[0]
  if (!fromGroup || !toGroup || !fromPanel || !toPanel) throw new PrevisError('相邻镜头数据不完整，无法评分')
  return {
    transition: {
      type: transition.type,
      continuity: transition.continuity,
      allowedChanges: transition.allowedChanges,
    },
    from: panelContext(timeline, fromGroup.id, fromPanel, 'last'),
    to: panelContext(timeline, toGroup.id, toPanel, 'first'),
  }
}

function normalizeReview(value: unknown): ContinuityReviewResult {
  const parsed = continuityReviewResultSchema.safeParse(value)
  if (!parsed.success) throw new PrevisError(`AI 连续性评分格式无效：${parsed.error.issues[0]?.message}`)
  const scores = Object.values(parsed.data.dimensions).map(item => Math.round(item.score))
  return {
    ...parsed.data,
    overallScore: scores.reduce((sum, score) => sum + score, 0),
    dimensions: Object.fromEntries(Object.entries(parsed.data.dimensions).map(([key, item]) => [
      key, { ...item, score: Math.round(item.score) },
    ])) as ContinuityReviewResult['dimensions'],
  }
}

function parseReview(text: string): ContinuityReviewResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return normalizeReview(JSON.parse(source))
  } catch (error) {
    if (error instanceof PrevisError) throw error
    throw new PrevisError('AI 未返回可解析的连续性评分，请重试')
  }
}

async function imagePart(url: string) {
  if (/^https?:\/\//.test(url)) return { type: 'image' as const, image: new URL(url) }
  const dataUrl = url.startsWith('data:')
    ? url
    : await readImageAsCompressedDataUrl(url.replace(/^\/+/, ''), {
      maxWidth: 1024, maxHeight: 1024, quality: 76,
    })
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) throw new PrevisError('连续性评分图片格式无效')
  return {
    type: 'image' as const,
    image: Buffer.from(parsed.data, 'base64'),
    mimeType: parsed.mimeType,
  }
}

export const runContinuityReviewer: ContinuityReviewer = async (input, options) => {
  const agent = agentRegistry['continuity-reviewer']
  const requestContext = new RequestContext()
  requestContext.set('modelOverride', options.model)
  requestContext.set('textConfigId', options.configId)
  requestContext.set('language', getContentLanguage())
  const content: any[] = [{
    type: 'text',
    text: `请评估以下相邻镜头。结构化资料：\n${JSON.stringify(input, null, 2)}`,
  }]
  if (input.from.frame?.url) {
    content.push({ type: 'text', text: '上一镜头的最后一张可用画面：' })
    content.push(await imagePart(input.from.frame.url))
  }
  if (input.to.frame?.url) {
    content.push({ type: 'text', text: '当前镜头的第一张可用画面：' })
    content.push(await imagePart(input.to.frame.url))
  }
  const response = await retryRejectedRateLimit(async () => {
    if (options.queueJobId) {
      const job = getQueueJobById(options.queueJobId)
      if (job?.status !== 'processing') throw new PrevisError('评测已取消')
      const snapshot = JSON.parse(job.snapshotJson)
      const config = await getConfigById(options.configId)
      if (!config || hashContent(config) !== snapshot.configHash) throw new PrevisError('评测模型配置已变化，请重新提交')
      if (getQueueJobById(job.id)?.status !== 'processing') throw new PrevisError('评测已取消')
      updateQueueJob(job.id, { submitted: true, phase: 'upstream' })
    }
    return agent.generate([{ role: 'user', content }], { maxSteps: 1, requestContext })
  }, () => {
    if (options.queueJobId) updateQueueJob(options.queueJobId, { submitted: false, phase: 'retry_wait' })
  })
  if (options.queueJobId) updateQueueJob(options.queueJobId, { upstreamDone: true, phase: 'saving' })
  try { return parseReview(response.text) }
  catch (error: any) { error.upstreamDone = true; throw error }
}

function serializeReview(
  row: typeof schema.continuityReviews.$inferSelect,
  input: ContinuityReviewInput,
  cached: boolean,
): ContinuityReview {
  return {
    id: row.id,
    versionId: row.versionId,
    fromGroupId: row.fromGroupId,
    toGroupId: row.toGroupId,
    inputHash: row.inputHash,
    configId: row.configId,
    model: row.model,
    result: continuityReviewResultSchema.parse(JSON.parse(row.resultJson)),
    images: { from: !!input.from.frame?.url, to: !!input.to.frame?.url },
    createdAt: row.createdAt,
    cached,
  }
}

export function listContinuityReviews(versionId: number): ContinuityReview[] {
  const row = versionRow(versionId)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const rows = db.select().from(schema.continuityReviews)
    .where(eq(schema.continuityReviews.versionId, versionId))
    .orderBy(desc(schema.continuityReviews.id)).all()
  const currentInputs = new Map(timeline.transitions.map(transition => {
    const input = reviewInput(timeline, transition.to)
    return [`${transition.from}:${transition.to}:${hashContent(input)}`, input] as const
  }))
  return rows.flatMap(review => {
    if (review.status !== 'completed') return []
    const input = currentInputs.get(`${review.fromGroupId}:${review.toGroupId}:${review.inputHash}`)
    if (!input) return []
    try { return [serializeReview(review, input, true)] }
    catch { return [] }
  })
}

export const continuityReviewTaskPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['all', 'active', 'completed', 'failed']).default('all'),
  keyword: z.string().trim().max(200).default(''),
})

function currentReviewInputs(timeline: Timeline) {
  const inputs = new Map<string, ContinuityReviewInput>()
  for (const edge of timeline.transitions) {
    try {
      const input = reviewInput(timeline, edge.to)
      inputs.set(`${edge.from}:${edge.to}:${hashContent(input)}`, input)
    } catch { /* 已删除或不完整的边界没有有效输入。 */ }
  }
  return inputs
}

function reviewTaskResult(row: typeof schema.continuityReviews.$inferSelect) {
  if (!row.resultJson) return null
  try {
    const parsed = continuityReviewResultSchema.safeParse(JSON.parse(row.resultJson))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

function serializeReviewTask(
  row: typeof schema.continuityReviews.$inferSelect,
  current: ContinuityReviewInput | undefined,
) {
  let input: ContinuityReviewInput | undefined = current
  if (row.inputJson) {
    try { input = JSON.parse(row.inputJson) } catch { /* 旧记录仍可读取状态和错误。 */ }
  }
  return {
    id: row.id, type: 'continuity' as const, versionId: row.versionId,
    status: row.status, current: !!current, inputHash: row.inputHash,
    result: reviewTaskResult(row), error: row.error, configId: row.configId, model: row.model,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    fromGroupId: row.fromGroupId, toGroupId: row.toGroupId,
    fromGroupTitle: input?.from?.group?.title ?? null,
    toGroupTitle: input?.to?.group?.title ?? null,
    images: { from: input?.from?.frame?.url ?? null, to: input?.to?.frame?.url ?? null },
    ...queueJobView('continuity_review', row.id),
  }
}

export function getContinuityReviewTask(versionId: number, taskId: number) {
  const version = versionRow(versionId)
  const row = db.select().from(schema.continuityReviews).where(and(
    eq(schema.continuityReviews.versionId, versionId), eq(schema.continuityReviews.id, taskId),
  )).get()
  if (!row) throw new PrevisError('评测任务不存在', 404)
  const timeline = normalizeTimeline(JSON.parse(version.timelineJson))
  const current = currentReviewInputs(timeline).get(`${row.fromGroupId}:${row.toGroupId}:${row.inputHash}`)
  return serializeReviewTask(row, current)
}

export function listContinuityReviewTasks(versionId: number, pagination: unknown = {}) {
  const { page, pageSize, status, keyword } = continuityReviewTaskPageSchema.parse(pagination)
  const timeline = normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson))
  const settings = getContinuityReviewSettings()
  const inputs = currentReviewInputs(timeline)
  const rows = db.select().from(schema.continuityReviews)
    .where(eq(schema.continuityReviews.versionId, versionId))
    .orderBy(desc(schema.continuityReviews.id)).all()
  const currentInput = (row: typeof schema.continuityReviews.$inferSelect) =>
    inputs.get(`${row.fromGroupId}:${row.toGroupId}:${row.inputHash}`)
  const summary = {
    total: rows.length,
    active: rows.filter(row => row.status === 'pending' || row.status === 'processing').length,
    pending: rows.filter(row => row.status === 'pending').length,
    processing: rows.filter(row => row.status === 'processing').length,
    completed: rows.filter(row => row.status === 'completed').length,
    failed: rows.filter(row => row.status === 'failed').length,
  }
  const query = keyword.toLowerCase()
  const items = rows.map(row => serializeReviewTask(row, currentInput(row))).filter(item => {
    const matchesStatus = status === 'all' || (status === 'active'
      ? item.status === 'pending' || item.status === 'processing'
      : item.status === status)
    const matchesKeyword = !query || [String(item.id), item.fromGroupTitle ?? '', item.toGroupTitle ?? '', item.model]
      .some(value => value.toLowerCase().includes(query))
    return matchesStatus && matchesKeyword
  })
  return {
    type: 'continuity' as const, page, pageSize, total: items.length, summary,
    activeCount: summary.active,
    lowScore: rows.filter(row => currentInput(row) && row.status === 'completed'
      && (reviewTaskResult(row)?.overallScore ?? 100) < settings.threshold).length,
    items: items.slice((page - 1) * pageSize, page * pageSize),
  }
}

export function scheduleContinuityReviews(versionId: number, panelIds?: number[]) {
  if (!getContinuityReviewSettings().enabled) return
  const timeline = normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson))
  for (const edge of timeline.transitions) {
    const input = reviewInput(timeline, edge.to)
    if (panelIds && !panelIds.includes(input.from.panel.id) && !panelIds.includes(input.to.panel.id)) continue
    if (!input.from.frame?.url || !input.to.frame?.url) continue
    db.insert(schema.continuityReviews).values({
      versionId, fromGroupId: edge.from, toGroupId: edge.to, inputHash: hashContent(input),
      configId: 0, model: '', status: 'pending', resultJson: '', inputJson: JSON.stringify(input), createdAt: now(),
    }).onConflictDoNothing().run()
    const row = db.select().from(schema.continuityReviews).where(and(eq(schema.continuityReviews.versionId, versionId),
      eq(schema.continuityReviews.fromGroupId, edge.from), eq(schema.continuityReviews.toGroupId, edge.to),
      eq(schema.continuityReviews.inputHash, hashContent(input)))).get()
    const job = row && getQueueJob('continuity_review', row.id)
    if (row?.status === 'cancelled' && (!job || job.source === 'automatic')) db.update(schema.continuityReviews)
      .set({ status: 'pending', error: null, finishedAt: null }).where(eq(schema.continuityReviews.id, row.id)).run()
  }
}

onQueueSettingsChange(() => {
  if (readEvaluationSettings().enabled) return
  // These records were scheduled automatically and have not yet been linked by
  // the worker. Manual admission creates the business record and link together.
  for (const row of db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.status, 'pending')).all()) {
    if (!getQueueJob('continuity_review', row.id)) db.update(schema.continuityReviews)
      .set({ status: 'cancelled', error: '自动评测已关闭', finishedAt: now() }).where(eq(schema.continuityReviews.id, row.id)).run()
  }
})

export function readContinuityReviewStatus(versionId: number) {
  const settings = getContinuityReviewSettings()
  const timeline = normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson))
  const rows = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, versionId)).all()
  return { settings, items: timeline.transitions.map(edge => {
    const input = reviewInput(timeline, edge.to), inputHash = hashContent(input)
    const row = rows.find(row => row.fromGroupId === edge.from && row.toGroupId === edge.to && row.inputHash === inputHash)
    const result = row?.status === 'completed' ? continuityReviewResultSchema.parse(JSON.parse(row.resultJson)) : null
    return { id: row?.id ?? null, fromGroupId: edge.from, toGroupId: edge.to, inputHash,
      hasImages: !!(input.from.frame?.url && input.to.frame?.url),
      status: row?.status ?? (input.from.frame?.url && input.to.frame?.url ? 'idle' : 'missing_images'),
      result, error: row?.error ?? null, lowScore: !!result && result.overallScore < settings.threshold,
      ...(row ? queueJobView('continuity_review', row.id) : {}) }
  }) }
}

let autoReviewTick: Promise<void> | undefined

function pendingReview(row: typeof schema.continuityReviews.$inferSelect) {
  return { id: row.id, status: row.status, ...queueJobView('continuity_review', row.id) }
}

export async function enqueueContinuityReview(
  versionId: number, options: ReviewOptions, reviewer: ContinuityReviewer = runContinuityReviewer,
  source: 'manual' | 'automatic' = 'manual',
) {
  const version = versionRow(versionId)
  if (!options.expectedInputHash && version.revision !== options.revision) throw new PrevisError('版本已更新，请刷新后重新评分', 409)
  const input = reviewInput(normalizeTimeline(JSON.parse(version.timelineJson)), options.toGroupId)
  const inputHash = hashContent(input)
  if (options.expectedInputHash && options.expectedInputHash !== inputHash) throw new PrevisError('评测输入已过期', 409)
  const identity = and(eq(schema.continuityReviews.versionId, versionId),
    eq(schema.continuityReviews.fromGroupId, input.from.group.id), eq(schema.continuityReviews.toGroupId, input.to.group.id),
    eq(schema.continuityReviews.inputHash, inputHash))
  const prior = db.select().from(schema.continuityReviews).where(identity).get()
  const priorJob = prior && getQueueJob('continuity_review', prior.id)
  if (prior && (priorJob?.status === 'pending' || priorJob?.status === 'processing')) {
    if (source === 'manual' && priorJob.source === 'automatic') updateQueueJob(priorJob.id, { source: 'manual' })
    if (reviewer !== runContinuityReviewer) queueReviewers.set(prior.id, reviewer)
    return pendingReview(prior)
  }
  if (prior?.status === 'completed' && !options.force) return pendingReview(prior)
  if (prior?.status === 'processing' && !priorJob) throw new PrevisError('该镜头边界正在评分，请核对提交状态', 409)
  const configId = options.configId || await getActiveConfigId('text')
  if (!configId) throw new PrevisError('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  const configRow = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).get()
  const config = configRow?.isActive && configRow.serviceType === 'text' ? await getConfigById(configId) : null
  if (!config) throw new PrevisError('所选文本模型配置不可用')
  const promptFile = await loadBasePromptFile('continuity-reviewer')
  const model = options.model || promptFile?.model || config.model
  if (!model) throw new PrevisError('所选文本模型没有可用模型')
  const frozenInput = structuredClone(input)
  const references: { url: string; digest: string }[] = []
  if (reviewer === runContinuityReviewer) {
    for (const side of [frozenInput.from, frozenInput.to]) {
      if (!side.frame?.url) continue
      const frozen = await freezeReferenceMedia(side.frame.url)
      references.push(frozen)
      side.frame.url = frozen.url
    }
  }
  if (hashContent(reviewInput(normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson)), options.toGroupId)) !== inputHash)
    throw new PrevisError('评测输入已过期', 409)
  const result = db.transaction(tx => {
    if (source === 'automatic' && !readEvaluationSettings().enabled) throw new PrevisError('自动评测已关闭', 409)
    const current = tx.select().from(schema.continuityReviews).where(identity).get()
    const currentJob = current && getQueueJob('continuity_review', current.id)
    if (currentJob && ['pending', 'processing'].includes(currentJob.status)) {
      if (source === 'manual' && currentJob.source === 'automatic') updateQueueJob(currentJob.id, { source: 'manual' })
      return current!
    }
    if (current?.status === 'completed' && !options.force) return current
    const values = { versionId, fromGroupId: input.from.group.id, toGroupId: input.to.group.id, inputHash,
      configId, model, status: 'pending', error: null, resultJson: '', inputJson: JSON.stringify(frozenInput),
      startedAt: null, finishedAt: null, createdAt: current?.createdAt || now() }
    const id = current?.id ?? Number(tx.insert(schema.continuityReviews).values(values).run().lastInsertRowid)
    if (current) tx.update(schema.continuityReviews).set(values).where(eq(schema.continuityReviews.id, id)).run()
    const episode = tx.select().from(schema.episodes).where(eq(schema.episodes.id, version.episodeId)).get()
    const snapshotJson = JSON.stringify({ configHash: hashContent(config), input: frozenInput, references, model })
    if (currentJob) resetQueueJob('continuity_review', id, { inputHash, configId, snapshotJson, source })
    else enqueueQueueJob({ ownerType: 'continuity_review', ownerId: id, kind: 'evaluation', projectId: episode?.dramaId,
      configId, inputHash, snapshotJson, source })
    return tx.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, id)).get()!
  })
  queueReviewers.set(result.id, reviewer)
  // No model work is awaited by an HTTP submission. The durable worker starts it.
  return pendingReview(result)
}

async function executeQueuedReview(job: QueueJob): Promise<QueueOutcome> {
  const row = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, job.ownerId)).get()
  if (!row) return { status: 'failed', error: '评测记录不存在' }
  if (job.submitted && !job.upstreamDone) return { status: 'needs_confirmation', error: '评分请求曾提交，请核对服务商记录后结束追踪' }
  let upstreamFinished = false
  try {
    const snapshot = JSON.parse(job.snapshotJson)
    const input = snapshot.input as ContinuityReviewInput
    const current = reviewInput(normalizeTimeline(JSON.parse(versionRow(row.versionId).timelineJson)), row.toGroupId)
    if (hashContent(current) !== row.inputHash) throw new Error('评测输入已过期')
    const config = await getConfigById(row.configId)
    if (!config || hashContent(config) !== snapshot.configHash) throw new Error('评测模型配置已变化，请重新提交')
    for (const reference of snapshot.references || []) {
      if (mediaDigest(await readReferenceMedia(reference.url)) !== reference.digest) throw new Error('评测参考画面文件已变化，请重新提交')
    }
    const currentJob = getQueueJobById(job.id)
    if (currentJob?.status !== 'processing') return { status: 'failed', error: '评测已取消' }
    db.update(schema.continuityReviews).set({ status: 'processing', startedAt: now(), error: null })
      .where(eq(schema.continuityReviews.id, row.id)).run()
    const reviewer = queueReviewers.get(row.id) || runContinuityReviewer
    if (reviewer !== runContinuityReviewer) updateQueueJob(job.id, { submitted: true, phase: 'upstream' })
    const result = normalizeReview(await reviewer(input, { configId: row.configId, model: row.model, queueJobId: job.id }))
    upstreamFinished = true
    updateQueueJob(job.id, { upstreamDone: true, phase: 'saving' })
    if (!input.from.frame?.url || !input.to.frame?.url) {
      result.confidence = 'low'
      if (!/图片|画面|文字/.test(result.summary)) result.summary = `边界画面不完整；${result.summary}`
    }
    let currentHash = ''
    try { currentHash = hashContent(reviewInput(normalizeTimeline(JSON.parse(versionRow(row.versionId).timelineJson)), row.toGroupId)) } catch {}
    if (currentHash !== row.inputHash) {
      db.update(schema.continuityReviews).set({ resultJson: JSON.stringify(result) }).where(eq(schema.continuityReviews.id, row.id)).run()
      throw new Error('评分期间输入已变化，本次结果仅保留在历史中，请重新评分')
    }
    db.update(schema.continuityReviews).set({ status: 'completed', resultJson: JSON.stringify(result), error: null, finishedAt: now() })
      .where(eq(schema.continuityReviews.id, row.id)).run()
    return { status: 'completed' }
  } catch (error: any) {
    const state = getQueueJobById(job.id)!
    if (state.status === 'cancelled') return { status: 'failed', error: '评测已取消' }
    // Injected reviewers are local tests; unknown network outcomes in real paid requests remain held.
    const injected = queueReviewers.get(row.id) && queueReviewers.get(row.id) !== runContinuityReviewer
    const status = httpErrorStatus(error)
    const uncertain = state.submitted && !state.upstreamDone && !upstreamFinished && !error?.upstreamDone && !injected && (!Number.isInteger(status) || status! >= 500 || status === 408)
    if (uncertain) {
      db.update(schema.continuityReviews).set({ status: 'processing', error: `请求结果不确定，请核对服务商记录：${error.message}` })
        .where(eq(schema.continuityReviews.id, row.id)).run()
      return { status: 'needs_confirmation', error: error.message }
    }
    if (state.submitted) updateQueueJob(job.id, { upstreamDone: true })
    db.update(schema.continuityReviews).set({ status: 'failed', error: error?.message || '连续性评分失败', finishedAt: now() })
      .where(eq(schema.continuityReviews.id, row.id)).run()
    return { status: 'failed', error: error?.message }
  } finally { queueReviewers.delete(row.id) }
}
registerQueueExecutor('continuity_review', {
  execute: executeQueuedReview,
  recover: async job => {
    const row = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, job.ownerId)).get()
    if (row?.status === 'completed') return { status: 'completed' }
    if (job.upstreamDone) {
      db.update(schema.continuityReviews).set({ status: 'failed', error: '评分结果未保存完整，请重新评测', finishedAt: now() }).where(eq(schema.continuityReviews.id, job.ownerId)).run()
      return { status: 'failed', error: '评分结果未保存完整，请重新评测' }
    }
    return { status: 'needs_confirmation', error: '服务重启，评分可能已提交，请核对服务商记录' }
  },
  onRequeue: job => { db.update(schema.continuityReviews).set({ status: 'pending', startedAt: null, error: null }).where(eq(schema.continuityReviews.id, job.ownerId)).run() },
  onCancel: job => { db.update(schema.continuityReviews).set({ status: 'cancelled', error: '已取消排队', finishedAt: now() }).where(eq(schema.continuityReviews.id, job.ownerId)).run() },
  onRetry: job => {
    updateQueueJob(job.id, { submitted: false, upstreamDone: false, externalTaskId: null })
    db.update(schema.continuityReviews).set({ status: 'pending', error: null, startedAt: null, finishedAt: null }).where(eq(schema.continuityReviews.id, job.ownerId)).run()
  },
  onReconcile: job => { db.update(schema.continuityReviews).set({ status: 'failed', error: '已人工确认服务商任务结束', finishedAt: now() }).where(eq(schema.continuityReviews.id, job.ownerId)).run() },
})

async function waitReview(id: number): Promise<ContinuityReview> {
  for (;;) {
    const row = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.id, id)).get()!
    const job = getQueueJob('continuity_review', id)
    if (row.status === 'completed') return serializeReview(row, JSON.parse(row.inputJson || '{}'), false)
    if (['failed', 'cancelled'].includes(row.status) || job?.phase === 'needs_confirmation') throw new PrevisError(row.error || job?.error || '连续性评分失败', 409)
    await tickTaskQueue()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
export async function reviewContinuity(versionId: number, options: ReviewOptions, reviewer: ContinuityReviewer = runContinuityReviewer): Promise<ContinuityReview> {
  const task = await enqueueContinuityReview(versionId, options, reviewer)
  const running = activeReviews.get(task.id)
  if (running) return { ...await running, cached: true }
  const execution = waitReview(task.id)
  activeReviews.set(task.id, execution)
  try { return await execution } finally { if (activeReviews.get(task.id) === execution) activeReviews.delete(task.id) }
}
export function tickContinuityReviews(reviewer: ContinuityReviewer = runContinuityReviewer): Promise<void> {
  if (autoReviewTick) return autoReviewTick
  autoReviewTick = (async () => {
    if (!getContinuityReviewSettings().enabled) return
    const pending = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.status, 'pending')).orderBy(schema.continuityReviews.id).all()
    const ids: number[] = []
    for (const row of pending) {
      const job = getQueueJob('continuity_review', row.id)
      if (job && ['pending', 'processing'].includes(job.status)) continue
      try {
        const version = versionRow(row.versionId)
        const task = await enqueueContinuityReview(row.versionId, { revision: version.revision, toGroupId: row.toGroupId,
          expectedInputHash: row.inputHash }, reviewer, 'automatic')
        ids.push(task.id)
      } catch (error: any) {
        db.update(schema.continuityReviews).set({ status: 'failed', error: error.message, finishedAt: now() })
          .where(and(eq(schema.continuityReviews.id, row.id), eq(schema.continuityReviews.status, 'pending'))).run()
      }
    }
    await tickTaskQueue()
    // Tests injecting a local reviewer can await their own work without changing the HTTP contract.
    if (reviewer !== runContinuityReviewer && !readEvaluationSettings().paused)
      await Promise.all(ids.map(id => waitReview(id).catch(() => undefined)))
  })().finally(() => { autoReviewTick = undefined })
  return autoReviewTick
}
export async function migrateContinuityQueue() {
  for (const row of db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.status, 'processing')).all()) {
    if (getQueueJob('continuity_review', row.id)) continue
    const version = versionRow(row.versionId)
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, version.episodeId)).get()
    enqueueQueueJob({ ownerType: 'continuity_review', ownerId: row.id, kind: 'evaluation', projectId: episode?.dramaId,
      configId: row.configId, inputHash: row.inputHash, initialStatus: 'processing', submitted: true })
  }
}
export async function startContinuityReviewWorker() {
  await migrateContinuityQueue()
  void tickContinuityReviews().catch(error => console.error('Continuity review worker:', error.message))
  const timer = setInterval(() => { void tickContinuityReviews().catch(error => console.error('Continuity review worker:', error.message)) }, 1500)
  timer.unref()
  return () => clearInterval(timer)
}
