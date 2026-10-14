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
}

export type ContinuityReviewer = (
  input: ContinuityReviewInput,
  options: ReviewerOptions,
) => Promise<ContinuityReviewResult>

export const continuityReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(0).max(100),
})
const SETTINGS_KEY = 'continuity_review_settings'
export function getContinuityReviewSettings() {
  const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, SETTINGS_KEY)).get()
  const parsed = continuityReviewSettingsSchema.safeParse(row ? JSON.parse(row.value) : null)
  return parsed.success ? parsed.data : { enabled: false, threshold: 70 }
}
export function updateContinuityReviewSettings(input: unknown) {
  const settings = continuityReviewSettingsSchema.parse(input)
  db.insert(schema.appSettings).values({ key: SETTINGS_KEY, value: JSON.stringify(settings), updatedAt: now() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(settings), updatedAt: now() } }).run()
  return settings
}

const activeReviews = new Map<number, Promise<ContinuityReview>>()
const REVIEW_LEASE_MS = 30 * 60 * 1000

function reviewClaimExpired(row: typeof schema.continuityReviews.$inferSelect) {
  const claimedAt = Date.parse(row.startedAt || row.createdAt)
  return !Number.isFinite(claimedAt) || Date.now() - claimedAt >= REVIEW_LEASE_MS
}

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
  const response = await agent.generate([{ role: 'user', content }], { maxSteps: 1, requestContext })
  return parseReview(response.text)
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
})

export function listContinuityReviewTasks(versionId: number, pagination: unknown = {}) {
  const { page, pageSize } = continuityReviewTaskPageSchema.parse(pagination)
  const timeline = normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson))
  const settings = getContinuityReviewSettings()
  const inputs = new Map<string, ContinuityReviewInput>()
  for (const edge of timeline.transitions) {
    try {
      const input = reviewInput(timeline, edge.to)
      inputs.set(`${edge.from}:${edge.to}:${hashContent(input)}`, input)
    } catch { /* 已删除或不完整的边界没有有效输入。 */ }
  }
  const rows = db.select().from(schema.continuityReviews)
    .where(eq(schema.continuityReviews.versionId, versionId))
    .orderBy(desc(schema.continuityReviews.id)).all()
  const currentInput = (row: typeof schema.continuityReviews.$inferSelect) =>
    inputs.get(`${row.fromGroupId}:${row.toGroupId}:${row.inputHash}`)
  const resultOf = (row: typeof schema.continuityReviews.$inferSelect) => {
    if (!row.resultJson) return null
    try {
      const parsed = continuityReviewResultSchema.safeParse(JSON.parse(row.resultJson))
      return parsed.success ? parsed.data : null
    } catch { return null }
  }
  return {
    type: 'continuity' as const, page, pageSize, total: rows.length,
    activeCount: rows.filter(row => row.status === 'pending' || row.status === 'processing').length,
    lowScore: rows.filter(row => currentInput(row) && row.status === 'completed'
      && (resultOf(row)?.overallScore ?? 100) < settings.threshold).length,
    items: rows.slice((page - 1) * pageSize, page * pageSize).map(row => {
      const current = currentInput(row)
      let input: ContinuityReviewInput | undefined = current
      if (row.inputJson) {
        try { input = JSON.parse(row.inputJson) } catch { /* 旧记录仍可读取状态和错误。 */ }
      }
      return {
        id: row.id, type: 'continuity' as const, versionId: row.versionId,
        status: row.status, current: !!current, inputHash: row.inputHash,
        result: resultOf(row), error: row.error, configId: row.configId, model: row.model,
        createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
        fromGroupId: row.fromGroupId, toGroupId: row.toGroupId,
        fromGroupTitle: input?.from?.group?.title ?? null,
        toGroupTitle: input?.to?.group?.title ?? null,
        images: { from: input?.from?.frame?.url ?? null, to: input?.to?.frame?.url ?? null },
      }
    }),
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
  }
}

export function readContinuityReviewStatus(versionId: number) {
  const settings = getContinuityReviewSettings()
  const timeline = normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson))
  const rows = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, versionId)).all()
  return { settings, items: timeline.transitions.map(edge => {
    const input = reviewInput(timeline, edge.to), inputHash = hashContent(input)
    const row = rows.find(row => row.fromGroupId === edge.from && row.toGroupId === edge.to && row.inputHash === inputHash)
    const result = row?.status === 'completed' ? continuityReviewResultSchema.parse(JSON.parse(row.resultJson)) : null
    return { id: row?.id ?? null, fromGroupId: edge.from, toGroupId: edge.to, inputHash,
      status: row?.status ?? (input.from.frame?.url && input.to.frame?.url ? 'idle' : 'missing_images'),
      result, error: row?.error ?? null, lowScore: !!result && result.overallScore < settings.threshold }
  }) }
}

let autoReviewTick: Promise<void> | undefined
export function tickContinuityReviews(reviewer: ContinuityReviewer = runContinuityReviewer): Promise<void> {
  if (autoReviewTick) return autoReviewTick
  autoReviewTick = (async () => {
    if (!getContinuityReviewSettings().enabled) return
    const pending = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.status, 'pending'))
      .orderBy(schema.continuityReviews.id).all()
    for (const row of pending) {
      if (!getContinuityReviewSettings().enabled) break
      try {
        const version = versionRow(row.versionId)
        await reviewContinuity(row.versionId, { revision: version.revision, toGroupId: row.toGroupId,
          expectedInputHash: row.inputHash }, reviewer)
      } catch (error: any) {
        db.update(schema.continuityReviews).set({ status: 'failed', error: error?.message || '连续性评分失败', finishedAt: now() })
          .where(and(eq(schema.continuityReviews.id, row.id), eq(schema.continuityReviews.status, 'pending'))).run()
      }
    }
  })().finally(() => { autoReviewTick = undefined })
  return autoReviewTick
}

export async function startContinuityReviewWorker() {
  // 中断的付费请求可能已执行，不自动重试，以免重复计费；可通过手动评分重试。
  db.update(schema.continuityReviews).set({ status: 'failed', error: '服务重启中断评分，请手动重试', finishedAt: now() })
    .where(eq(schema.continuityReviews.status, 'processing')).run()
  await tickContinuityReviews()
  setInterval(() => { void tickContinuityReviews().catch(error => console.error('Continuity review worker:', error.message)) }, 1500).unref()
}

export async function reviewContinuity(
  versionId: number,
  options: ReviewOptions,
  reviewer: ContinuityReviewer = runContinuityReviewer,
): Promise<ContinuityReview> {
  const row = versionRow(versionId)
  if (!options.expectedInputHash && row.revision !== options.revision) throw new PrevisError('版本已更新，请刷新后重新评分', 409)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const input = reviewInput(timeline, options.toGroupId)
  const inputHash = hashContent(input)
  if (options.expectedInputHash && options.expectedInputHash !== inputHash) throw new PrevisError('评测输入已过期', 409)
  const identity = and(
    eq(schema.continuityReviews.versionId, versionId),
    eq(schema.continuityReviews.fromGroupId, input.from.group.id),
    eq(schema.continuityReviews.toGroupId, input.to.group.id),
    eq(schema.continuityReviews.inputHash, inputHash),
  )
  const prior = db.select().from(schema.continuityReviews).where(identity).get()
  if (prior?.status === 'completed' && !options.force) return serializeReview(prior, input, true)
  if (prior?.status === 'processing') {
    const running = activeReviews.get(prior.id)
    if (running) return { ...await running, cached: true }
    if (!reviewClaimExpired(prior)) throw new PrevisError('该镜头边界正在评分，请稍后刷新结果', 409)
  }

  const configId = options.configId || await getActiveConfigId('text')
  if (!configId) throw new PrevisError('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  const configRow = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId)).get()
  if (!configRow?.isActive || configRow.serviceType !== 'text') throw new PrevisError('所选文本模型配置不可用')
  const config = await getConfigById(configId)
  if (!config) throw new PrevisError('所选文本模型配置不可用')
  const promptFile = await loadBasePromptFile('continuity-reviewer')
  const model = options.model || promptFile?.model || config.model
  if (!model) throw new PrevisError('所选文本模型没有可用模型')
  if (hashContent(reviewInput(normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson)), options.toGroupId)) !== inputHash) {
    throw new PrevisError('评测输入已过期', 409)
  }

  const claim = db.transaction(tx => {
    const current = tx.select().from(schema.continuityReviews).where(identity).get()
    if (current?.status === 'processing' && !reviewClaimExpired(current)) {
      return { id: current.id, owner: false, row: current }
    }
    if (current?.status === 'completed' && !options.force) return { id: current.id, owner: false, row: current }
    const values = {
      versionId,
      fromGroupId: input.from.group.id,
      toGroupId: input.to.group.id,
      inputHash,
      configId,
      model,
      status: 'processing',
      error: null,
      resultJson: '',
      inputJson: JSON.stringify(input),
      startedAt: now(),
      finishedAt: null,
      createdAt: current?.createdAt || now(),
    }
    if (current) {
      tx.update(schema.continuityReviews).set(values)
        .where(eq(schema.continuityReviews.id, current.id)).run()
      return { id: current.id, owner: true, row: null }
    }
    const id = Number(tx.insert(schema.continuityReviews).values(values).run().lastInsertRowid)
    return { id, owner: true, row: null }
  })
  if (!claim.owner) {
    if (claim.row?.status === 'completed') return serializeReview(claim.row, input, true)
    const running = activeReviews.get(claim.id)
    if (running) return { ...await running, cached: true }
    throw new PrevisError('该镜头边界正在评分，请稍后刷新结果', 409)
  }

  const execution = (async () => {
    try {
      const result = normalizeReview(await reviewer(input, { configId, model }))
      if (!input.from.frame?.url || !input.to.frame?.url) {
        result.confidence = 'low'
        if (!/图片|画面|文字/.test(result.summary)) result.summary = `边界画面不完整；${result.summary}`
      }
      const currentTimeline = normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson))
      let currentHash: string | undefined
      try { currentHash = hashContent(reviewInput(currentTimeline, options.toGroupId)) } catch { /* 边界可能已删除。 */ }
      if (currentHash !== inputHash) {
        db.update(schema.continuityReviews).set({ resultJson: JSON.stringify(result) })
          .where(eq(schema.continuityReviews.id, claim.id)).run()
        throw new PrevisError('评分期间输入已变化，本次结果仅保留在历史中，请重新评分', 409)
      }
      db.update(schema.continuityReviews).set({
        status: 'completed', resultJson: JSON.stringify(result), error: null, finishedAt: now(),
      }).where(eq(schema.continuityReviews.id, claim.id)).run()
      const saved = db.select().from(schema.continuityReviews)
        .where(eq(schema.continuityReviews.id, claim.id)).get()!
      return serializeReview(saved, input, false)
    } catch (error: any) {
      db.update(schema.continuityReviews).set({
        status: 'failed', error: error?.message || '连续性评分失败', finishedAt: now(),
      }).where(eq(schema.continuityReviews.id, claim.id)).run()
      throw error
    }
  })()
  activeReviews.set(claim.id, execution)
  try {
    return await execution
  } finally {
    if (activeReviews.get(claim.id) === execution) activeReviews.delete(claim.id)
  }
}
