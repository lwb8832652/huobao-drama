import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { now } from '../utils/response.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { generateImage, startQueuedPrevisTask, cancelUnsubmittedPrevisTask } from './generation.js'
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
import { chooseGridSize, gridImageCapabilities } from './previs-grid-capabilities.js'

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
interface GridSnapshot {
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
  currentSources: { frameId: string; sourceUrl: string; frozen: FrozenMedia }[]
  base?: FrozenMedia
  baseCandidateId?: number
  instructions: Record<string, string>
}
type Row = typeof schema.gridCandidates.$inferSelect
const table = schema.gridCandidates
const snapshot = (row: Row): GridSnapshot => JSON.parse(row.snapshotJson)
const activeStatuses = ['pending', 'processing']
const panelHash = (p: Panel) => hashContent(p)
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
  return {
    id: row.id,
    versionId: row.versionId,
    panelId: row.panelId,
    mode: row.mode,
    status: row.status,
    taskId: row.taskId,
    rawUrl: row.rawUrl,
    previewUrl: row.previewUrl,
    baseUrl: s.base?.url || null,
    width: row.width,
    height: row.height,
    error: row.error,
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
function promptFor(
  p: Panel,
  grid: GenerationGrid,
  mode: GridMode,
  targets: string[],
  instructions: Record<string, string>,
  references: string[],
) {
  const frames = orderedFrames(p),
    assetStart = mode === 'generate' ? 1 : 2
  const identity = references
    .map(
      (url, i) =>
        `参考图片${assetStart + i}：${p.referenceLabels?.[p.referenceImages.indexOf(url)] || '人物/场景/道具资产'}。`,
    )
    .join('\n')
  const invariants =
    p.continuityConstraints ||
    '全组保持人物身份与服装、场景空间和光照方向、道具外观一致；镜头按规划，不强制每格更换景别。'
  const geometry = `整图严格分为 ${grid.rows} 行 ${grid.columns} 列，等大无间隙画格，按从左到右、从上到下阅读。多余 ${grid.columns * grid.rows - frames.length} 格为纯中性灰背景，无物体。不要绘制文字、序号角标、水印、分隔线或边框；角标只用于界面引用，不能进入成片。`
  const states = frames
    .map(
      (f, i) =>
        `画格${i + 1}（第${Math.floor(i / grid.columns) + 1}行，第${(i % grid.columns) + 1}列，${(f.offsetMs || 0) / 1000}s）：${f.prompt || p.description}\n景别：${f.shotType || p.shotType}；机位：${f.angle || p.angle}；构图：${f.composition || ''}；衔接：${f.continuity || '按相邻状态自然推进，同一格只呈现一个静态关键状态。'}`,
    )
    .join('\n')
  if (mode === 'frame_edit')
    return [
      `参考图片1是当前需要精修的唯一原图。只输出该画格的完整单张画面，不绘制宫格。`,
      identity,
      invariants,
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
    `分镜场景：${p.scene}；氛围：${p.atmosphere}；原视频动作：${p.videoPrompt}`,
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
function requiredAssets(p: Panel, dramaId: number): { url: string; label: string }[] {
  const assets: { url: string; label: string }[] = []
  const add = (
    row: { imageUrl: string | null; deletedAt: string | null; dramaId: number } | undefined,
    label: string,
  ) => {
    if (!row || row.deletedAt || row.dramaId !== dramaId || !row.imageUrl)
      throw new PrevisError(`${label}缺少可用参考图片，请先生成资产`)
    assets.push({ url: row.imageUrl, label })
  }
  if (p.sceneId) {
    const row = db.select().from(schema.scenes).where(eq(schema.scenes.id, p.sceneId)).get()
    add(row, `场景「${row?.location || p.scene}」`)
  }
  for (const id of p.characterIds) {
    const row = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    add(row, `人物「${row?.name || id}」`)
  }
  for (const id of p.propIds) {
    const row = db.select().from(schema.props).where(eq(schema.props.id, id)).get()
    add(row, `道具「${row?.name || id}」`)
  }
  return assets
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
  const size = chooseGridSize(
    caps,
    drama?.aspectRatio || '16:9',
    request.resolution || caps.resolutions[0] || '1K',
  )
  // Freeze every unit first: an invalid later unit cannot create partial paid tasks.
  const prepared: { panelId: number; inputHash: string; s: GridSnapshot }[] = []
  for (const p of panels) {
    assertNoLegacyConflict(versionId, p.id)
    const frames = orderedFrames(p),
      grid = generationGrid(frames.map((f) => f.id!))
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
    const mandatory = requiredAssets(p, ep.dramaId)
    const assets = [
      ...new Set([
        ...mandatory.map((a) => a.url),
        ...frames.flatMap((f) => f.referenceImages ?? p.referenceImages),
      ]),
    ]
    const promptPanel = {
      ...p,
      referenceImages: assets,
      referenceLabels: assets.map(
        (url) =>
          mandatory.find((a) => a.url === url)?.label ||
          p.referenceLabels?.[p.referenceImages.indexOf(url)] ||
          '共同参考资产',
      ),
    }
    if (
      !assets.length &&
      request.mode === 'generate' &&
      (p.characterIds.length || p.propIds.length || p.sceneId)
    )
      throw new PrevisError('共同人物、场景或道具缺少参考图片')
    const referenceSlots = assets.length + (request.mode === 'generate' ? 0 : 1)
    if (referenceSlots > caps.maxReferences)
      throw new PrevisError(
        `需要 ${referenceSlots} 张参考图片，当前模型上限 ${caps.maxReferences}；请调整资产或更换模型`,
      )
    const references = await Promise.all(assets.map(freezeReferenceMedia))
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
          s.panelHash !== panelHash(p)
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
        drama?.style,
        promptFor(promptPanel, grid, request.mode, targets, instructions, assets),
        neighborLegend,
      ]
        .filter(Boolean)
        .join('\n'),
      references,
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
      const inserted = tx
        .insert(table)
        .values({
          versionId,
          panelId,
          mode: request.mode,
          inputHash,
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
  let preview: Buffer, width: number, height: number
  if (row.mode === 'frame_edit') {
    const single = await splitGrid(buffer, generationGrid([s.targets[0]]), s.aspectRatio)
    preview = single.tiles[0]
    width = single.width
    height = single.height
  } else {
    const result = await splitGrid(buffer, s.grid, s.aspectRatio)
    width = result.width
    height = result.height
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
    .set({ status: 'ready', rawUrl: raw.url, previewUrl, width, height, error: null, updatedAt: now() })
    .where(and(eq(table.id, row.id), inArray(table.status, ['processing', 'failed'])))
    .run()
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
        if (row.status === 'pending') {
          const claim = db
            .update(table)
            .set({ status: 'processing', updatedAt: now() })
            .where(and(eq(table.id, row.id), eq(table.status, 'pending')))
            .run()
          if (!claim.changes) continue
          const current = await getConfigById(s.configId)
          if (!current || hashContent(current) !== s.configHash)
            throw new Error('图片配置已变化，请核对后重新提交')
          const taskId = await generateImage({
            previs: { versionId: row.versionId, itemKey: `grid-${row.id}` },
            prompt: s.prompt,
            model: s.model,
            size: s.size,
            referenceImages: [...(s.base ? [s.base.url] : []), ...s.references.map((r) => r.url)],
            configId: s.configId,
            frozenConfigHash: s.configHash,
            frozenReferences: [...(s.base ? [s.base] : []), ...s.references],
          })
          db.update(table).set({ taskId }).where(eq(table.id, row.id)).run()
          row = { ...row, taskId, status: 'processing' }
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
        if (candidateRow(row.versionId, row.id).status !== 'processing') {
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
  return view(candidateRow(versionId, id))
}
export async function uploadGridCandidate(versionId: number, revision: number, panelId: number, url: string) {
  const row = requireEditable(versionId, revision),
    t = normalizeTimeline(JSON.parse(row.timelineJson)),
    p = t.panels.find((p) => p.id === panelId)
  if (!p) throw new PrevisError('分镜不属于当前版本')
  assertNoLegacyConflict(versionId, panelId)
  if (hasGridTask(versionId, [panelId])) throw new PrevisError('请先完成或取消宫格任务', 409)
  const grid = generationGrid(orderedFrames(p).map((f) => f.id!))
  if (p.frames.some((f) => f.locked)) throw new PrevisError('画面已锁定', 409)
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get()!
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).get(),
    ratio = (drama?.aspectRatio || '16:9').split(':').map(Number)
  const base = await freezeReferenceMedia(url),
    buffer = await readReferenceMedia(base.url)
  const decoded = await splitGrid(buffer, grid, ratio[0] / ratio[1])
  requireEditable(versionId, revision)
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
  return view(
    db
      .insert(table)
      .values({
        versionId,
        panelId,
        mode: 'generate',
        status: 'ready',
        inputHash: hashContent(s),
        snapshotJson: JSON.stringify(s),
        rawUrl: base.url,
        previewUrl: base.url,
        width: decoded.width,
        height: decoded.height,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning()
      .get(),
  )
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
    if (!p || panelHash(p) !== s.panelHash)
      throw new PrevisError('原图或画面规划已变化，保留旧候选供查看，请重新生成', 409)
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
    tx.update(table).set({ status: 'adopted', updatedAt: now() }).where(eq(table.id, id)).run()
    mirrorCurrent(versionId, t)
  })
  scheduleContactSheets(versionId, [row.panelId])
  return getVersion(versionId)
}
export async function startGridWorker() {
  await tickGridCandidates()
  setInterval(() => void tickGridCandidates().catch(console.error), 1200).unref()
}
