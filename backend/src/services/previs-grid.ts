import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { now } from '../utils/response.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { generateImage, startQueuedPrevisTask, cancelUnsubmittedPrevisTask } from './generation.js'
import { completeRecoveredQueueJob, getQueueJob } from './task-queue.js'
import {
  getVersion,
  hashContent,
  mirrorCurrent,
  PrevisError,
  readBatches,
  requireEditable,
  versionRow,
} from './previs.js'
import { orderedFrames, normalizeTimeline, type Panel, type Timeline } from './previs-domain.js'
import {
  generationGrid,
  gridBounds,
  validateGridTargets,
  type GenerationGrid,
  type GridMode,
} from './previs-grid-domain.js'
import { composeGrid, mergeGridSelection, splitGrid } from './previs-grid-images.js'
import { freezeReferenceMedia, mediaDigest, readReferenceMedia } from './previs-reference-media.js'
import { scheduleContactSheets } from './previs-contact-sheets.js'
import { scheduleContinuityReviews } from './continuity-review.js'
import { chooseGridSize, gridImageCapabilities } from './previs-grid-capabilities.js'
import { getDramaStylePrompt } from './style-preset.js'
import { continuityMatchesTimeline, type PanelContinuity } from './previs-continuity.js'
import { resolvePanelGridReferences, type GridReferenceItem } from './previs-grid-references.js'

export interface GridRequest {
  revision: number
  panelIds: number[]
  mode: GridMode
  configId?: number
  model?: string
  resolution?: '1K' | '2K' | '4K'
  targetFrameIds?: string[]
  instructions?: Record<string, string>
  instruction?: string
  baseCandidateId?: number
}
interface FrozenMedia {
  url: string
  digest: string
}
export interface GridReferenceAsset extends FrozenMedia {
  label: string
  kind: GridReferenceItem['kind']
  required: boolean
  sourceUrl?: string
}
interface GridSnapshot {
  continuity?: PanelContinuity
  revision: number
  panel: Panel
  panelHash: string
  projectAspectRatio: string
  grid: GenerationGrid
  targets: string[]
  adoptTargets: string[]
  configId: number
  configHash: string
  model: string
  size: string
  aspectRatio: number
  resolution: string
  prompt: string
  references: FrozenMedia[]
  referenceAssets?: GridReferenceAsset[]
  currentSources: { frameId: string; sourceUrl: string; frozen: FrozenMedia }[]
  base?: FrozenMedia
  baseCandidateId?: number
  instructions: Record<string, string>
}
type Row = typeof schema.gridCandidates.$inferSelect
const table = schema.gridCandidates
const snapshot = (row: Row): GridSnapshot => JSON.parse(row.snapshotJson)
const activeStatuses = ['pending', 'processing']
/**
 * 候选有效性只依赖画面规划结构（帧 id 及顺序，即切格映射）。
 * 采用/上传只替换画面内容（url/history），不应让旧候选永久失效——否则无法在生成记录间切换。
 * 原画面文件的不可变性由 adopt 时的 currentSources digest 校验兜底。
 */
const panelHash = (p: Panel) => hashContent(orderedFrames(p).map((frame) => frame.id))
/**
 * 候选创建时的有序帧 id 序列（= 切格映射依据）。快照 panel 保存了创建时的完整面板，
 * 旧快照同样可恢复，因此结构校验不依赖 panelHash 的算法——公式更换不会让历史候选失配
 * （2026-10-13 事故：panelHash 公式升级未兼容旧快照，全部旧候选采用即 409）。
 */
const snapshotFrameIds = (s: GridSnapshot) =>
  s.panel ? orderedFrames(s.panel).map((frame) => frame.id) : s.grid.cells.map((c) => c.frameId)
const sameFrameStructure = (p: Panel, s: GridSnapshot) =>
  JSON.stringify(orderedFrames(p).map((frame) => frame.id)) === JSON.stringify(snapshotFrameIds(s))
function candidateRow(versionId: number, id: number) {
  versionRow(versionId)
  const row = db
    .select()
    .from(table)
    .where(and(eq(table.versionId, versionId), eq(table.id, id)))
    .get()
  if (!row) throw new PrevisError('宫格候选不存在', 404)
  return row
}
function view(row: Row) {
  const s = snapshot(row)
  const timeline = normalizeTimeline(JSON.parse(versionRow(row.versionId).timelineJson))
  const continuityStale = s.continuity ? !continuityMatchesTimeline(s.continuity, timeline) : false
  return {
    continuity: s.continuity,
    continuityStale,
    continuityStaleReason: continuityStale ? '前序边界或转场已变化；此候选保留原生成输入。' : undefined,
    id: row.id,
    versionId: row.versionId,
    panelId: row.panelId,
    mode: row.mode,
    status: row.status,
    taskId: row.taskId,
    rawUrl: row.rawUrl,
    previewUrl: row.previewUrl,
    baseUrl: s.base?.url || null,
    referenceAssets: s.referenceAssets,
    width: row.width,
    height: row.height,
    /** 上游原图尺寸；非空表示这张宫格的画布比例与冻结布局不符、已中心裁切适配 */
    sourceWidth: row.sourceWidth,
    sourceHeight: row.sourceHeight,
    error: row.error,
    batchNo: row.batchNo,
    grid: s.grid,
    targetFrameIds: s.targets,
    adoptFrameIds: s.adoptTargets,
    model: s.model,
    resolution: s.resolution,
    size: s.size,
    cellWidth: row.width ? Math.floor(row.width / (row.mode === 'frame_edit' ? 1 : s.grid.columns)) : null,
    cellHeight: row.height ? Math.floor(row.height / (row.mode === 'frame_edit' ? 1 : s.grid.rows)) : null,
    createdAt: row.createdAt,
    baseCandidateId: s.baseCandidateId || null,
  }
}
export function listGridCandidates(versionId: number, panelId?: number) {
  versionRow(versionId)
  return db
    .select()
    .from(table)
    .where(
      panelId
        ? and(eq(table.versionId, versionId), eq(table.panelId, panelId))
        : eq(table.versionId, versionId),
    )
    .orderBy(desc(table.id))
    .limit(100)
    .all()
    .map(view)
}
export async function gridCapabilities(configId?: number, model?: string) {
  const id = configId || (await getActiveConfigId('image')),
    config = id ? await getConfigById(id) : null
  if (!config)
    return {
      enabled: false,
      reason: '请先配置并启用图片模型',
      resolutions: [],
      aspectRatios: [],
      maxReferences: 0,
    }
  return gridImageCapabilities(config, model || config.model)
}
async function saveArtifact(buffer: Buffer, tag: string) {
  const dir = path.join(STORAGE_ROOT, 'previs-grids')
  await mkdir(dir, { recursive: true })
  const name = `${tag}-${mediaDigest(buffer)}.png`
  await writeFile(path.join(dir, name), buffer, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return `/static/previs-grids/${name}`
}
export function promptFor(
  p: Panel,
  grid: GenerationGrid,
  mode: GridMode,
  targets: string[],
  instructions: Record<string, string>,
  references: GridReferenceItem[],
) {
  const frames = orderedFrames(p),
    assetStart = mode === 'generate' ? 1 : 2
  const identity = references
    .map(
      (item, i) => `参考图片${assetStart + i}：${item.label}。`,
    )
    .join('\n')
  const invariants =
    p.continuityConstraints ||
    '沿用参考素材中的人物身份与服装、道具外观；位置、光源与持物状态依据原描述和逐格规划延续。原剧本明确的场景或镜头变化可以发生，不强制不同场景使用相同背景。'
  const geometry = `整图严格分为 ${grid.rows} 行 ${grid.columns} 列，等大无间隙画格，按从左到右、从上到下阅读。多余 ${grid.columns * grid.rows - frames.length} 格为纯中性灰背景，无物体。不要绘制文字、序号角标、水印、分隔线或边框；角标只用于界面引用，不能进入成片。`
  const planSource = p.productionPlan
    ? `统一镜头与对白时间计划（唯一时序依据）：${JSON.stringify(p.productionPlan)}\n画格的 shotId 和 offsetMs 必须对应计划中的同一子镜头；对白只用于理解表演，不绘制对白文字。`
    : `原分镜描述：${p.description}\n原视频动作与时间：${p.videoPrompt}`
  const source = `${planSource}\n视觉状态锚点：${p.imagePrompt}\n分镜场景：${p.scene}；氛围：${p.atmosphere}。只呈现原资料和规划已有的参与者与物体；不新增叙事、角色、场景、镜头或风格。每格一个静态状态，明确当前姿态、位置、手部持物和视线，不在一格画完整动作序列。`
  const states = frames
    .flatMap(
      (f, i) =>
        mode === 'frame_edit' && !targets.includes(f.id!) ? [] :
          [`画格${i + 1}（第${Math.floor(i / grid.columns) + 1}行，第${(i % grid.columns) + 1}列，子镜头 ${f.shotId || '按画格规划'}，${(f.offsetMs || 0) / 1000}s）：${f.prompt || p.description}\n景别：${f.shotType || p.shotType}；机位：${f.angle || p.angle}；构图：${f.composition || ''}；衔接：${f.continuity || '按相邻状态自然推进，同一格只呈现一个静态关键状态。'}`],
    )
    .join('\n')
  if (mode === 'frame_edit')
    return [
      `参考图片1是当前需要精修的唯一原图。只输出该画格的完整单张画面，不绘制宫格。`,
      identity,
      invariants,
      source,
      `修改：${instructions[targets[0]]}。用户明确要求的修改优先；其他身份、服装、背景布局、机位、光色、动作阶段保持原图。`,
      states.split('\n').filter(Boolean).join('\n'),
      '附加相邻图片只供动作连续性参考，不能把相邻画面重画为编辑对象。',
    ].join('\n')
  return [
    mode === 'generate'
      ? '一次生成同一分镜的完整关键状态序列宫格。'
      : '参考图片1是最新完整编辑宫格。只修改下面指定格，其他画格内容保持；返回同样布局的完整宫格。',
    geometry,
    identity,
    invariants,
    source,
    states,
    mode === 'grid_edit'
      ? targets
          .map(
            (id) => `只编辑画格${grid.cells.find((c) => c.frameId === id)!.index + 1}：${instructions[id]}`,
          )
          .join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
function assertNoLegacyConflict(versionId: number, panelId: number) {
  if (
    readBatches(versionId).some(
      (b) =>
        b.type === 'image' && b.items.some((i) => i.panelId === panelId && activeStatuses.includes(i.status)),
    )
  ) {
    throw new PrevisError('该分镜仍有逐张生图任务，请完成或取消后再生成宫格', 409)
  }
}
/** 宫格任务要进任务面板，必须带上所属剧集：sys_task 无 episode_id，靠 drama_id 聚合 */
function dramaIdOfVersion(versionId: number): number | undefined {
  const version = versionRow(versionId)
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, version.episodeId)).get()?.dramaId
}

export function hasGridTask(versionId: number, panelIds?: number[]) {
  return db
    .select()
    .from(table)
    .where(and(eq(table.versionId, versionId), inArray(table.status, activeStatuses)))
    .all()
    .some((c) => !panelIds || panelIds.includes(c.panelId))
}
export async function startGridCandidates(versionId: number, request: GridRequest) {
  const row = requireEditable(versionId, request.revision),
    t = normalizeTimeline(JSON.parse(row.timelineJson))
  if (!request.panelIds.length || new Set(request.panelIds).size !== request.panelIds.length)
    throw new PrevisError('请选择不重复的分镜')
  if (request.mode !== 'generate' && request.panelIds.length !== 1)
    throw new PrevisError('每次微调只能操作一个分镜')
  const panels = request.panelIds.map((id) => {
    const p = t.panels.find((p) => p.id === id)
    if (!p) throw new PrevisError('所选分镜不属于当前版本')
    if (p.framePlanNeedsReview) throw new PrevisError(`「${p.title}」时序已调整，请先重新规划并审阅画面后生成宫格`)
    return p
  })
  const configId = request.configId || (await getActiveConfigId('image')),
    config = configId ? await getConfigById(configId) : null
  if (!config || !configId) throw new PrevisError('请先配置并启用图片模型')
  const configRow = db
    .select()
    .from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId))
    .get()
  if (configRow?.serviceType !== 'image') throw new PrevisError('所选配置不是图片服务')
  const model = request.model || config.model,
    caps = gridImageCapabilities(config, model)
  if (!caps.enabled || !caps.supportsReferences || (request.mode !== 'generate' && !caps.supportsEdit))
    throw new PrevisError(caps.reason || '当前模型不支持参考生图或图片微调')
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get()!
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).get()
  const style = await getDramaStylePrompt(ep.dramaId)
  const size = chooseGridSize(
    caps,
    drama?.aspectRatio || '16:9',
    request.resolution || caps.resolutions[0] || '1K',
  )
  // Validate all manifests and counts before reading/freezing any source, including remote uploads.
  const assetsByPanel = new Map(panels.map(p => {
    const firstId = orderedFrames(p)[0]?.id
    const manifest = resolvePanelGridReferences(p, ep.dramaId, { timeline: t, versionId,
      includeBoundary: request.mode === 'generate' || Boolean(firstId && request.targetFrameIds?.includes(firstId)) })
    if (manifest.items.some(item => item.required && !item.url) || (request.mode === 'generate' && !manifest.ready))
      throw new PrevisError(manifest.error)
    const assets = manifest.items.filter((item): item is GridReferenceItem & { url: string } => Boolean(item.url))
    const referenceSlots = assets.length + (request.mode === 'generate' ? 0 : 1)
    if (referenceSlots > caps.maxReferences)
      throw new PrevisError(
        `需要 ${referenceSlots} 张参考图片，当前模型上限 ${caps.maxReferences}；请调整资产或更换模型`,
      )
    return [p.id, { assets, continuity: manifest.continuity }] as const
  }))
  // Freeze every unit first: an invalid later unit cannot create partial paid tasks.
  const prepared: { panelId: number; inputHash: string; s: GridSnapshot }[] = []
  for (const p of panels) {
    assertNoLegacyConflict(versionId, p.id)
    const frames = orderedFrames(p),
      grid = generationGrid(frames.map((f) => f.id!), drama?.aspectRatio || '16:9')
    const requestedTargets =
      request.mode === 'generate' ? grid.cells.map((c) => c.frameId) : request.targetFrameIds || []
    validateGridTargets(grid, requestedTargets)
    const targets = grid.cells.filter((c) => requestedTargets.includes(c.frameId)).map((c) => c.frameId)
    if (request.mode === 'frame_edit' && targets.length !== 1)
      throw new PrevisError('单格精修一次只能选择一个画面')
    if (frames.some((f) => targets.includes(f.id!) && f.locked)) throw new PrevisError('目标画面已锁定', 409)
    const instructions = Object.fromEntries(
      targets.map((id) => [id, request.instructions?.[id]?.trim() || request.instruction?.trim() || '']),
    )
    if (request.mode !== 'generate' && Object.values(instructions).some((v) => !v))
      throw new PrevisError('请为每个选中画面填写修改指令')
    const { assets, continuity } = assetsByPanel.get(p.id)!
    const frozenContinuity = continuity && structuredClone(continuity)
    const referenceAssets: GridReferenceAsset[] = await Promise.all(assets.map(async item => ({
      ...await freezeReferenceMedia(item.url), label: item.label, kind: item.kind,
      required: item.required, sourceUrl: item.url,
    })))
    if (frozenContinuity?.previous) {
      const boundary = referenceAssets.find(item => item.sourceUrl === frozenContinuity.previous!.sourceUrl || item.sourceUrl === `/${frozenContinuity.previous!.sourceUrl}`)
      if (boundary) Object.assign(frozenContinuity.previous, { frozenUrl: boundary.url, digest: boundary.digest })
    }
    const references: FrozenMedia[] = referenceAssets.map(({ url, digest }) => ({ url, digest }))
    const currentSources: GridSnapshot['currentSources'] = []
    let base: FrozenMedia | undefined,
      adoptTargets = targets
    if (request.mode === 'generate')
      for (const f of frames.filter((f) => f.url))
        currentSources.push({ frameId: f.id!, sourceUrl: f.url, frozen: await freezeReferenceMedia(f.url) })
    if (request.mode !== 'generate') {
      if (request.baseCandidateId) {
        if (request.mode === 'frame_edit') throw new PrevisError('请先采用并切分宫格，再进行单格精修')
        const prior = candidateRow(versionId, request.baseCandidateId),
          s = snapshot(prior)
        if (
          prior.panelId !== p.id ||
          prior.mode === 'frame_edit' ||
          prior.status !== 'ready' ||
          !prior.previewUrl ||
          !sameFrameStructure(p, s)
        )
          throw new PrevisError('原候选不可编辑或规划已变化', 409)
        base = await freezeReferenceMedia(prior.previewUrl)
        adoptTargets = [...new Set([...s.adoptTargets, ...targets])]
        currentSources.push(...s.currentSources)
        if (Math.abs(s.aspectRatio - size.width / size.height) > 0.05)
          throw new PrevisError('编辑尺寸比例与原候选不一致')
      } else {
        if (request.mode === 'grid_edit' && frames.some((f) => !f.url))
          throw new PrevisError('请先生成并采用整组宫格；微调需要当前完整画面')
        const needed = request.mode === 'frame_edit' ? frames.filter((f) => targets.includes(f.id!)) : frames
        if (needed.some((f) => !f.url)) throw new PrevisError('选中画面尚未采用，请先生成并切分')
        for (const f of needed)
          currentSources.push({ frameId: f.id!, sourceUrl: f.url, frozen: await freezeReferenceMedia(f.url) })
        if (request.mode === 'frame_edit') base = currentSources.find((f) => f.frameId === targets[0])!.frozen
        else {
          const canvas = await composeGrid(
            await Promise.all(currentSources.map((f) => readReferenceMedia(f.frozen.url))),
            grid,
            size.width,
            size.height,
          )
          base = await freezeReferenceMedia(await saveArtifact(canvas, 'input'))
        }
      }
    }
    // Add neighbors only after the editing source and all mandatory identity assets.
    if (request.mode === 'frame_edit') {
      const i = frames.findIndex((f) => f.id === targets[0])
      for (const neighbor of [frames[i - 1], frames[i + 1]].filter((f) => f?.url)) {
        if (references.length + 1 >= caps.maxReferences) break
        const frozen = await freezeReferenceMedia(neighbor.url)
        currentSources.push({ frameId: neighbor.id!, sourceUrl: neighbor.url, frozen })
        references.push(frozen)
      }
    }
    const allReferences = [...(base ? [base] : []), ...references]
    const totalBytes = (
      await Promise.all(allReferences.map(async (r) => (await readReferenceMedia(r.url)).length))
    ).reduce((a, b) => a + b, 0)
    if (totalBytes > 40 * 1024 * 1024)
      throw new PrevisError('参考图片总大小超过 40MB，请压缩资产或减少参考图片')
    const neighborLegend =
      request.mode === 'frame_edit'
        ? references
            .slice(assets.length)
            .map((_, i) => `参考图片${assets.length + 2 + i}为相邻画面，仅用于连续性参考。`)
            .join('\n')
        : ''
    const s: GridSnapshot = {
      revision: request.revision,
      continuity: frozenContinuity,
      panel: structuredClone(p),
      panelHash: panelHash(p),
      projectAspectRatio: drama?.aspectRatio || '16:9',
      grid,
      targets,
      adoptTargets,
      configId,
      configHash: hashContent(config),
      model,
      size: size.size,
      aspectRatio: size.width / size.height,
      resolution: request.resolution || caps.resolutions[0],
      prompt: [
        style,
        frozenContinuity?.previous?.digest ? `前序末画面只约束当前首个静态状态的动作阶段与空间关系，不要在每格重复前序完整动作。人物身份、服装、道具和场景以当前绑定资产为准，资产身份参考优先于前序漂移。${frozenContinuity.reason}` : '',
        promptFor(p, grid, request.mode, targets, instructions, assets),
        neighborLegend,
      ]
        .filter(Boolean)
        .join('\n'),
      references,
      referenceAssets,
      currentSources,
      base,
      baseCandidateId: request.baseCandidateId,
      instructions,
    }
    const inputHash = hashContent({ mode: request.mode, ...s, revision: undefined })
    prepared.push({ panelId: p.id, inputHash, s })
  }
  requireEditable(versionId, request.revision)
  const items = db.transaction((tx) =>
    prepared.map(({ panelId, inputHash, s }) => {
      assertNoLegacyConflict(versionId, panelId)
      const active = tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.versionId, versionId),
            eq(table.panelId, panelId),
            inArray(table.status, activeStatuses),
          ),
        )
        .get()
      if (active) {
        if (active.inputHash === inputHash) return view(active)
        throw new PrevisError('该分镜已有宫格任务，请等待或取消后再提交', 409)
      }
      // 批次（代际）：整组生成开新批；微调跟随基准候选（跨 panel 的基准不继承），
      // 无基准的微调跟随当前采用结果；都没有（含历史 batch_no=0）才开新批
      const batchNo = (() => {
        if (request.baseCandidateId) {
          const base = tx.select({ batchNo: table.batchNo, panelId: table.panelId }).from(table)
            .where(and(eq(table.versionId, versionId), eq(table.id, request.baseCandidateId))).get()
          if (base && base.panelId === panelId && base.batchNo) return base.batchNo
        }
        if (request.mode !== 'generate') {
          const adopted = tx.select({ batchNo: table.batchNo }).from(table)
            .where(and(eq(table.versionId, versionId), eq(table.panelId, panelId), eq(table.status, 'adopted'))).get()
          if (adopted?.batchNo) return adopted.batchNo
        }
        const latest = tx.select({ batchNo: table.batchNo }).from(table)
          .where(and(eq(table.versionId, versionId), eq(table.panelId, panelId)))
          .orderBy(desc(table.batchNo)).limit(1).get()
        return (latest?.batchNo || 0) + 1
      })()
      const inserted = tx
        .insert(table)
        .values({
          versionId,
          panelId,
          mode: request.mode,
          inputHash,
          batchNo,
          snapshotJson: JSON.stringify(s),
          createdAt: now(),
          updatedAt: now(),
        })
        .returning()
        .get()
      return view(inserted)
    }),
  )
  return { items }
}
async function processResult(row: Row, url: string) {
  const s = snapshot(row),
    raw = await freezeReferenceMedia(url)
  const buffer = await sharp(await readReferenceMedia(raw.url), { limitInputPixels: 80_000_000 })
    .rotate()
    .png()
    .toBuffer()
  const rawMetadata = await sharp(buffer).metadata()
  db.update(table)
    .set({ rawUrl: raw.url, width: rawMetadata.width, height: rawMetadata.height })
    .where(eq(table.id, row.id))
    .run()
  let preview: Buffer, width: number, height: number, cropped: { width: number; height: number } | undefined
  if (row.mode === 'frame_edit') {
    const single = await splitGrid(buffer, generationGrid([s.targets[0]]), s.aspectRatio)
    preview = single.tiles[0]
    width = single.width
    height = single.height
    if (single.sourceWidth) cropped = { width: single.sourceWidth, height: single.sourceHeight! }
  } else {
    const result = await splitGrid(buffer, s.grid, s.aspectRatio)
    width = result.width
    height = result.height
    if (result.sourceWidth) cropped = { width: result.sourceWidth, height: result.sourceHeight! }
    preview =
      row.mode === 'grid_edit'
        ? await mergeGridSelection(
            await readReferenceMedia(s.base!.url),
            buffer,
            s.grid,
            s.targets,
            s.aspectRatio,
          )
        : buffer
  }
  const metadata = await sharp(preview).metadata()
  width = metadata.width!
  height = metadata.height!
  const previewUrl = await saveArtifact(preview, `candidate-${row.id}`)
  db.update(table)
    .set({
      status: 'ready', rawUrl: raw.url, previewUrl, width, height,
      sourceWidth: cropped?.width ?? null, sourceHeight: cropped?.height ?? null,
      error: null, updatedAt: now(),
    })
    .where(and(eq(table.id, row.id), inArray(table.status, ['processing', 'failed'])))
    .run()
  // 整组生成免审核：就绪即自动切分写入画面，行为与资产制作一致
  if (row.mode === 'generate') await autoAdoptGridCandidate(row.id)
}

/**
 * 生成即采用：整组宫格（AI 生成 / 上传替换 / 本地重处理）就绪后自动切分并写入画面，
 * 不经过人工审核。采用失败（版本已更新、原图被改写、画面锁定等）时保留 ready 候选
 * 并记录原因，用户仍可在「生成记录」中打开候选手动采用。
 */
async function autoAdoptGridCandidate(candidateId: number) {
  const row = db.select().from(table).where(eq(table.id, candidateId)).get()
  if (!row || row.mode !== 'generate' || row.status !== 'ready') return
  try {
    await adoptGridCandidate(row.versionId, row.id, snapshot(row).revision)
  } catch (error) {
    db.update(table)
      .set({ error: `已生成，自动采用失败：${(error as Error).message}。请在生成记录中打开并手动采用。`, updatedAt: now() })
      .where(and(eq(table.id, row.id), eq(table.status, 'ready')))
      .run()
  }
}
let ticking = false
export async function tickGridCandidates() {
  if (ticking) return
  ticking = true
  try {
    const rows = db
      .select()
      .from(table)
      .where(inArray(table.status, activeStatuses))
      .orderBy(table.id)
      .limit(20)
      .all()
    for (let row of rows)
      try {
        const s = snapshot(row)
        if (row.status === 'pending' && !row.taskId) {
          // 任务面板按剧集聚合 sys_task，需要 drama_id + storyboard_id 才能归属到当前集，
          // 生成完成后任务行会直接展示模型返回的原始宫格图。
          const current = await getConfigById(s.configId)
          if (!current || hashContent(current) !== s.configHash)
            throw new Error('图片配置已变化，请核对后重新提交')
          const existing = db.select().from(schema.sysTask).where(eq(schema.sysTask.previsItemKey, `grid-${row.id}`)).get()
          const taskId = existing?.id || await generateImage({
            previs: { versionId: row.versionId, itemKey: `grid-${row.id}` },
            storyboardId: row.panelId,
            dramaId: dramaIdOfVersion(row.versionId),
            prompt: s.prompt,
            model: s.model,
            size: s.size,
            referenceImages: [...(s.base ? [s.base.url] : []), ...s.references.map((r) => r.url)],
            configId: s.configId,
            frozenConfigHash: s.configHash,
            frozenReferences: [...(s.base ? [s.base] : []), ...s.references],
          })
          db.update(table).set({ taskId }).where(eq(table.id, row.id)).run()
          row = { ...row, taskId }
        }
        let task = row.taskId
          ? db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.taskId)).get()
          : db
              .select()
              .from(schema.sysTask)
              .where(eq(schema.sysTask.previsItemKey, `grid-${row.id}`))
              .get()
        if (!task) throw new Error('任务提交状态不明，请核对服务商记录后显式重新提交，避免重复扣费')
        if (!row.taskId) db.update(table).set({ taskId: task.id }).where(eq(table.id, row.id)).run()
        if (!activeStatuses.includes(candidateRow(row.versionId, row.id).status)) {
          cancelUnsubmittedPrevisTask(task.id)
          continue
        }
        if (task.status === 'pending') await startQueuedPrevisTask(task.id)
        else if (task.status === 'completed') {
          const url = task.localPath || task.resultUrl
          if (!url) throw new Error('任务已完成但缺少图片结果')
          await processResult(row, url)
        } else if (['failed', 'cancelled'].includes(task.status || ''))
          throw new Error(task.errorMsg || '图片任务失败或已取消')
      } catch (error) {
        db.update(table)
          .set({ status: 'failed', error: (error as Error).message, updatedAt: now() })
          .where(and(eq(table.id, row.id), inArray(table.status, activeStatuses)))
          .run()
      }
  } finally {
    ticking = false
  }
}
export async function retryGridProcessing(versionId: number, id: number) {
  const row = candidateRow(versionId, id),
    task = row.taskId ? db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.taskId)).get() : null
  if (row.status !== 'failed' || !task || !(task.localPath || task.resultUrl))
    throw new PrevisError('没有可重新处理的已完成图片；需要重新提交生成')
  await processResult(row, task.localPath || task.resultUrl!)
  db.update(schema.sysTask)
    .set({ status: 'completed', errorMsg: null, updatedAt: now(), completedAt: now() })
    .where(eq(schema.sysTask.id, task.id))
    .run()
  const job = getQueueJob('sys_task', task.id)
  if (job?.status === 'failed' && job.upstreamDone) completeRecoveredQueueJob(job.id)
  return view(candidateRow(versionId, id))
}
export async function uploadGridCandidate(versionId: number, revision: number, panelId: number, url: string) {
  const row = requireEditable(versionId, revision),
    t = normalizeTimeline(JSON.parse(row.timelineJson)),
    p = t.panels.find((p) => p.id === panelId)
  if (!p) throw new PrevisError('分镜不属于当前版本')
  assertNoLegacyConflict(versionId, panelId)
  if (hasGridTask(versionId, [panelId])) throw new PrevisError('请先完成或取消宫格任务', 409)
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get()!
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).get()
  const grid = generationGrid(orderedFrames(p).map((f) => f.id!), drama?.aspectRatio || '16:9')
  if (p.frames.some((f) => f.locked)) throw new PrevisError('画面已锁定', 409)
  const ratio = (drama?.aspectRatio || '16:9').split(':').map(Number)
  const base = await freezeReferenceMedia(url),
    buffer = await readReferenceMedia(base.url)
  const decoded = await splitGrid(buffer, grid, ratio[0] / ratio[1])
  requireEditable(versionId, revision)
  // 上传替换 = 一次新的整组生成，开新批
  const latestBatch = db.select({ batchNo: table.batchNo }).from(table)
    .where(and(eq(table.versionId, versionId), eq(table.panelId, panelId)))
    .orderBy(desc(table.batchNo)).limit(1).get()
  const currentSources = await Promise.all(
    p.frames
      .filter((f) => f.url)
      .map(async (f) => ({ frameId: f.id!, sourceUrl: f.url, frozen: await freezeReferenceMedia(f.url) })),
  )
  requireEditable(versionId, revision)
  const s: GridSnapshot = {
    revision,
    panel: p,
    panelHash: panelHash(p),
    projectAspectRatio: drama?.aspectRatio || '16:9',
    grid,
    targets: grid.cells.map((c) => c.frameId),
    adoptTargets: grid.cells.map((c) => c.frameId),
    configId: 0,
    configHash: '',
    model: '用户上传',
    size: `${decoded.width}x${decoded.height}`,
    aspectRatio: ratio[0] / ratio[1],
    resolution: '原图',
    prompt: '',
    references: [],
    currentSources,
    instructions: {},
  }
  const inserted = db
    .insert(table)
    .values({
      versionId,
      panelId,
      mode: 'generate',
      status: 'ready',
      inputHash: hashContent(s),
      batchNo: (latestBatch?.batchNo || 0) + 1,
      snapshotJson: JSON.stringify(s),
      rawUrl: base.url,
      previewUrl: base.url,
      width: decoded.width,
      height: decoded.height,
      sourceWidth: decoded.sourceWidth ?? null,
      sourceHeight: decoded.sourceHeight ?? null,
      createdAt: now(),
      updatedAt: now(),
    })
    .returning()
    .get()
  // 上传替换同样免审核：就绪即自动切分写入画面
  await autoAdoptGridCandidate(inserted.id)
  return view(candidateRow(versionId, inserted.id))
}
export function discardGridCandidate(versionId: number, id: number) {
  const row = candidateRow(versionId, id)
  if (row.status === 'adopted') throw new PrevisError('已采用结果请通过画面历史回退')
  db.transaction((tx) => {
    tx.update(table).set({ status: 'discarded', updatedAt: now() }).where(eq(table.id, id)).run()
    if (row.taskId) cancelUnsubmittedPrevisTask(row.taskId)
  })
  return view(candidateRow(versionId, id))
}
export async function adoptGridCandidate(versionId: number, id: number, revision: number) {
  const row = candidateRow(versionId, id),
    s = snapshot(row)
  if (row.status !== 'ready' || !row.previewUrl) throw new PrevisError('候选画面尚未就绪或已处理', 409)
  requireEditable(versionId, revision)
  assertNoLegacyConflict(versionId, row.panelId)
  if (hasGridTask(versionId, [row.panelId]))
    throw new PrevisError('该分镜仍有宫格任务，请完成或取消后采用', 409)
  // Output files are immutable, fully decode/stage before entering the synchronous transaction.
  const buffer = await readReferenceMedia(row.previewUrl)
  const decoded = await splitGrid(
    buffer,
    row.mode === 'frame_edit' ? generationGrid(s.targets) : s.grid,
    s.aspectRatio,
  )
  for (const source of s.currentSources)
    if (mediaDigest(await readReferenceMedia(source.sourceUrl)) !== source.frozen.digest)
      throw new PrevisError('原画面文件已变化，请重新微调', 409)
  type Replacement = { url: string; taskId?: number; source: import('./previs-domain.js').FrameSource }
  const replacements = new Map<string, Replacement[]>()
  const lineage: Row[] = [row]
  let ancestor = row
  while (snapshot(ancestor).baseCandidateId) {
    if (lineage.length >= 100) throw new PrevisError('候选历史链过长，请采用当前结果后继续微调')
    ancestor = candidateRow(versionId, snapshot(ancestor).baseCandidateId!)
    if (lineage.some((c) => c.id === ancestor.id)) throw new PrevisError('候选来源链无效')
    lineage.unshift(ancestor)
  }
  // Keep each selected cell's initial split and every adopted draft refinement as distinct history.
  for (const origin of lineage) {
    const originSnapshot = snapshot(origin)
    if (!origin.previewUrl) throw new PrevisError('候选来源图片不可用')
    const originGrid =
      origin.mode === 'frame_edit' ? generationGrid(originSnapshot.targets) : originSnapshot.grid
    const originDecoded =
      origin.id === row.id
        ? decoded
        : await splitGrid(await readReferenceMedia(origin.previewUrl), originGrid, originSnapshot.aspectRatio)
    const affected = origin.mode === 'generate' ? originSnapshot.adoptTargets : originSnapshot.targets
    for (const target of s.adoptTargets.filter((id) => affected.includes(id))) {
      const index = originGrid.cells.findIndex((c) => c.frameId === target)
      if (index < 0 || !originDecoded.tiles[index]) throw new PrevisError('候选切格映射无效')
      const url = await saveArtifact(originDecoded.tiles[index], `frame-${origin.id}-${index}`)
      const source = {
        candidateId: origin.id,
        mode: origin.mode as GridMode,
        gridIndex: s.grid.cells.find((c) => c.frameId === target)!.index,
        bounds: gridBounds(index, originGrid, originDecoded.width, originDecoded.height),
        inputDigest: originSnapshot.base?.digest,
      }
      const history = replacements.get(target) || []
      history.push({ url, taskId: origin.taskId || undefined, source })
      replacements.set(target, history)
    }
  }
  db.transaction((tx) => {
    assertNoLegacyConflict(versionId, row.panelId)
    if (hasGridTask(versionId, [row.panelId]))
      throw new PrevisError('该分镜仍有宫格任务，请完成或取消后采用', 409)
    const latest = requireEditable(versionId, revision)
    const episode = tx.select().from(schema.episodes).where(eq(schema.episodes.id, latest.episodeId)).get()!
    const drama = tx.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
    if ((drama?.aspectRatio || '16:9') !== s.projectAspectRatio)
      throw new PrevisError('项目画幅比例已变化，请重新生成', 409)
    const t: Timeline = normalizeTimeline(JSON.parse(latest.timelineJson)),
      p = t.panels.find((p) => p.id === row.panelId)
    if (candidateRow(versionId, id).status !== 'ready') throw new PrevisError('候选已经处理，请刷新', 409)
    // 画面规划结构（帧 id 及顺序）必须与候选创建时一致，否则切格映射错位。
    // 比较序列而非 panelHash：旧快照的哈希是旧公式算的，逐位比较会让历史候选全部失配。
    if (!p || !sameFrameStructure(p, s))
      throw new PrevisError('画面规划结构已变化，该候选的切格映射不再适用，请重新生成', 409)
    if (p.frames.some((f) => s.adoptTargets.includes(f.id!) && f.locked))
      throw new PrevisError('目标画面已锁定，无法采用', 409)
    for (const f of p.frames) {
      const history = replacements.get(f.id!)
      if (!history?.length) continue
      const replacement = history[history.length - 1]
      f.history = [
        ...(f.history || []),
        ...(f.url && !f.history?.some((h) => h.url === f.url)
          ? [{ url: f.url, taskId: f.taskId, source: f.source }]
          : []),
        ...history,
      ]
        .filter((h, i, all) => all.findIndex((v) => v.url === h.url) === i)
        .slice(-200)
      f.url = replacement.url
      f.taskId = replacement.taskId
      f.source = replacement.source
    }
    p.coverFrameId ||= p.frames[0]?.id
    tx.update(schema.animaticVersions)
      .set({
        timelineJson: JSON.stringify(t),
        revision: revision + 1,
        status: 'draft',
        contentHash: null,
        updatedAt: now(),
      })
      .where(and(eq(schema.animaticVersions.id, versionId), eq(schema.animaticVersions.revision, revision)))
      .run()
    // 同一分镜同一时间只允许一个采用结果：旧采用记录回退为待采用，便于再次切换
    tx.update(table)
      .set({ status: 'ready', updatedAt: now() })
      .where(and(eq(table.versionId, versionId), eq(table.panelId, row.panelId), eq(table.status, 'adopted'), ne(table.id, id)))
      .run()
    tx.update(table).set({ status: 'adopted', updatedAt: now() }).where(eq(table.id, id)).run()
    mirrorCurrent(versionId, t)
  })
  scheduleContactSheets(versionId, [row.panelId])
  scheduleContinuityReviews(versionId, [row.panelId])
  return getVersion(versionId)
}
export async function startGridWorker() {
  await tickGridCandidates()
  setInterval(() => void tickGridCandidates().catch(console.error), 1200).unref()
}
