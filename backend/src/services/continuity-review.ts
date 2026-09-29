import { Agent } from '@mastra/core/agent'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { resolveTextModel } from '../agents/index.js'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseDataUrl, readImageAsCompressedDataUrl } from '../utils/storage.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import {
  groupPanels, normalizeTimeline, orderedFrames,
  type ContinuityReview, type ContinuityReviewResult, type Panel, type Timeline,
} from './previs-domain.js'
import { hashContent, PrevisError, versionRow } from './previs.js'

const dimensionSchema = z.object({
  score: z.number().min(0).max(25),
  comment: z.string().trim().min(1).max(1000),
})
export const continuityReviewResultSchema = z.object({
  overallScore: z.number().min(0).max(100),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string().trim().min(1).max(2000),
  dimensions: z.object({
    subject: dimensionSchema,
    scene: dimensionSchema,
    action: dimensionSchema,
    camera: dimensionSchema,
  }),
  issues: z.array(z.string().trim().min(1).max(1000)).max(8),
  suggestions: z.array(z.string().trim().min(1).max(1000)).max(8),
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
}

interface ReviewerOptions {
  configId: number
  model: string
}

export type ContinuityReviewer = (
  input: ContinuityReviewInput,
  options: ReviewerOptions,
) => Promise<ContinuityReviewResult>

const activeReviews = new Map<number, Promise<ContinuityReview>>()
const REVIEW_LEASE_MS = 30 * 60 * 1000

function reviewClaimExpired(row: typeof schema.continuityReviews.$inferSelect) {
  const claimedAt = Date.parse(row.createdAt)
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

const reviewerInstructions = `你是影视制作中的镜头连续性审核员。请比较上一镜头的结束状态与当前镜头的开始状态。
只依据给定图片和文字资料判断，不得臆造画外信息。场景切换、建立镜头、声音桥及明确允许的变化不应被误判为穿帮。
四项各 0-25 分：subject=人物与关键道具，scene=场景、时间与光线，action=动作、姿态、视线与方向，camera=构图、景别与机位衔接。
overallScore 必须等于四项之和。图片缺失时仍可依据文字评分，但 confidence 必须为 low，并在 summary 中说明依据有限。
issues 只列明确问题，没有则返回空数组；suggestions 给出可直接修改分镜或提示词的建议。
只输出一个 JSON 对象，不要 Markdown，不要代码围栏，不要补充解释。`

export const runContinuityReviewer: ContinuityReviewer = async (input, options) => {
  const model = await resolveTextModel(options.model, options.configId)
  const agent = new Agent({
    id: 'continuity-reviewer',
    name: '镜头连续性审核',
    instructions: reviewerInstructions,
    model,
  })
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
  const response = await agent.generate([{ role: 'user', content }], { maxSteps: 1 })
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

export async function reviewContinuity(
  versionId: number,
  options: ReviewOptions,
  reviewer: ContinuityReviewer = runContinuityReviewer,
): Promise<ContinuityReview> {
  const row = versionRow(versionId)
  if (row.revision !== options.revision) throw new PrevisError('版本已更新，请刷新后重新评分', 409)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const input = reviewInput(timeline, options.toGroupId)
  const inputHash = hashContent(input)
  const identity = and(
    eq(schema.continuityReviews.versionId, versionId),
    eq(schema.continuityReviews.fromGroupId, input.from.group.id),
    eq(schema.continuityReviews.toGroupId, input.to.group.id),
    eq(schema.continuityReviews.inputHash, inputHash),
  )
  const prior = db.select().from(schema.continuityReviews).where(identity).get()
  if (prior?.status === 'completed' && !options.force) return serializeReview(prior, input, true)
  if (prior?.status === 'processing' && !reviewClaimExpired(prior)) {
    const running = activeReviews.get(prior.id)
    if (running) return { ...await running, cached: true }
    throw new PrevisError('该镜头边界正在评分，请稍后刷新结果', 409)
  }

  const configId = options.configId || await getActiveConfigId('text')
  if (!configId) throw new PrevisError('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  const configRow = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId)).get()
  if (!configRow?.isActive || configRow.serviceType !== 'text') throw new PrevisError('所选文本模型配置不可用')
  const config = await getConfigById(configId)
  if (!config) throw new PrevisError('所选文本模型配置不可用')
  const model = options.model || config.model
  if (!model) throw new PrevisError('所选文本模型没有可用模型')

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
      createdAt: now(),
    }
    if (current) {
      tx.update(schema.continuityReviews).set(values)
        .where(eq(schema.continuityReviews.id, current.id)).run()
      return { id: current.id, owner: true, row: null }
    }
    const id = Number(tx.insert(schema.continuityReviews).values({ ...values, resultJson: '' }).run().lastInsertRowid)
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
      if (versionRow(versionId).revision !== options.revision) {
        throw new PrevisError('评分期间版本已更新，本次结果未保存，请重新评分', 409)
      }
      db.update(schema.continuityReviews).set({
        status: 'completed', resultJson: JSON.stringify(result), error: null, createdAt: now(),
      }).where(eq(schema.continuityReviews.id, claim.id)).run()
      const saved = db.select().from(schema.continuityReviews)
        .where(eq(schema.continuityReviews.id, claim.id)).get()!
      return serializeReview(saved, input, false)
    } catch (error: any) {
      db.update(schema.continuityReviews).set({
        status: 'failed', error: error?.message || '连续性评分失败',
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
