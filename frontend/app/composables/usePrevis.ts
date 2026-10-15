import { computed, onUnmounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { QueueMetadata } from './useTaskQueue'
import { withNetworkRetry } from '~/composables/useApi'
import type { AnimaticVersion, Timeline, FrameType, Panel, Keyframe } from '../../../backend/src/services/previs-domain'
import { frameKey, makeFrame, orderedFrames, retimeBoundAudio } from '../../../backend/src/services/previs-domain'
import { FRAME_COUNT_MAX } from '../../../backend/src/services/previs-frame-contract'
import type { ContactSheetView } from '../../../backend/src/services/previs-contact-sheet-domain'
import { selectVideoReferenceStrategy, type VideoReferenceInputStrategy } from '../../../backend/src/services/previs-video-reference-domain'
export type { ContactSheetView, ContactSheetCell } from '../../../backend/src/services/previs-contact-sheet-domain'
export type { VideoReferenceInputStrategy } from '../../../backend/src/services/previs-video-reference-domain'
export { FRAME_COUNT_MIN, FRAME_COUNT_MAX, FRAME_COUNT_OPTIONS, FRAME_GRID_LAYOUTS, FRAME_GRID_COUNTS, gridLayoutForCount, gridLayoutsForRatio, isPortraitRatio, frameCountChangeAllowed } from '../../../backend/src/services/previs-frame-contract'
export type { FrameGridLayout } from '../../../backend/src/services/previs-frame-contract'
export {
  autoGroup, checkContinuity, durationMs, formatTime, frameKey, groupPanels, makeFrame, mediaUrl,
  orderedFrames, panelImageFallback, planFrames, rebuildTransitions, timelineSegments,
} from '../../../backend/src/services/previs-domain'
export type {
  AnimaticVersion, AudioClip, BatchItem, BatchRun, ContinuityIssue, ContinuityReview, ContinuityReviewResult,
  FrameType, GenerationStrategy, Keyframe, Panel, PanelGeneration, StoryboardGroup, Timeline, Transition,
  VideoConstraint, VideoGenerationMode, VideoOutput,
} from '../../../backend/src/services/previs-domain'

// Timeline prompts and provider credentials must not be logged by the client.
export async function previsRequest<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  // 幂等请求套一层网络抖动重试：切换镜头会并发打多个接口，单条连接抖动不该让整屏报「Failed to fetch」。
  return withNetworkRetry(async () => {
    const response = await fetch(`/api/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result.message || `请求失败 (${response.status})`), { status: response.status })
    return result.data ?? result
  }, method)
}
export interface FramePlanDraft {
  id?: string
  title: string
  prompt: string
  offsetMs: number
  type: FrameType
  /** 帧级镜头参数；AI 未给出时留空，由生图模板回退面板级取值。 */
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
export interface FramePlanPayload {
  revision: number
  panelIds: number[]
  count?: number
  configId?: number
  model?: string
  force?: boolean
}
export interface FramePlanSummary {
  pending: number
  processing: number
  completed: number
  failed: number
}
export interface FramePlansResult {
  items: (QueueMetadata & { id: number; panelId: number; status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'; count: number; error: string | null; createdAt: string })[]
  plans: PanelFramePlan[]
  summary: FramePlanSummary
}
/** 提交拆分任务：立即返回，进度经轮询 state.framePlans 获取。 */
export async function submitFramePlan(versionId: number, payload: FramePlanPayload) {
  return previsRequest<{ queued: number; taskIds: number[] }>(`/animatic-versions/${versionId}/frames/plan`, 'POST', payload)
}
/** 查询拆分任务状态与已完成方案。 */
export async function fetchFramePlans(versionId: number) {
  return previsRequest<FramePlansResult>(`/animatic-versions/${versionId}/frames/plan`)
}
export type { PanelContinuity } from '../../../backend/src/services/previs-continuity'
export type { GridReferenceManifest } from '../../../backend/src/services/previs-grid-references'
export type { GridReferenceAsset } from '../../../backend/src/services/previs-grid'
export type { VideoContinuityMode, VideoContinuitySnapshot } from '../../../backend/src/services/previs-video-continuity'
import type { VideoContinuityMode } from '../../../backend/src/services/previs-video-continuity'
import { timelineSegments as orderedSegments } from '../../../backend/src/services/previs-domain'
export type GridMode = 'generate' | 'grid_edit' | 'frame_edit'
export interface GridCapabilities {
  enabled: boolean
  supportsReferences: boolean
  supportsEdit: boolean
  maxReferences: number
  aspectRatios: string[]
  resolutions: string[]
  sizes: { width: number; height: number; aspectRatio: string; resolution: string; size: string }[]
  reason?: string
}
export interface GridCandidate {
  id: number
  versionId: number
  panelId: number
  mode: GridMode
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'adopted' | 'discarded'
  /** 所属版本（代际，UI 展示为 V1/V2…）：一次整组生成/上传 = 一个新版本，微调跟随基准；0 = 版本概念上线前的历史候选 */
  batchNo: number
  taskId?: number | null
  rawUrl?: string | null
  previewUrl?: string | null
  baseUrl?: string | null
  width?: number | null
  height?: number | null
  /** 上游返回的原始画布尺寸；仅当它与冻结布局比例不符、服务端已中心裁切适配时才有值 */
  sourceWidth?: number | null
  sourceHeight?: number | null
  error?: string | null
  grid: { columns: number; rows: number; cells: { frameId: string; index: number }[] }
  targetFrameIds: string[]
  adoptFrameIds: string[]
  model: string
  resolution: string
  size: string
  cellWidth?: number | null
  cellHeight?: number | null
  createdAt: string
  baseCandidateId?: number | null
  referenceAssets?: import('../../../backend/src/services/previs-grid').GridReferenceAsset[]
  continuity?: import('../../../backend/src/services/previs-continuity').PanelContinuity
  continuityStale?: boolean
  continuityStaleReason?: string
}

/** Keep stable slots and their media when reviewing a revised frame plan. */
export function applyFramePlanToPanel(panel: Panel, plan: PanelFramePlan) {
  if (panel.frames.some(frame => frame.locked)) return false
  const previous = orderedFrames(panel), used = new Set<string>()
  const reserved = new Set(plan.frames.map(frame => frame.id).filter(id => previous.some(frame => frame.id === id)))
  panel.frames = plan.frames.map((draft, index): Keyframe => {
    const exact = draft.id && previous.find(frame => frame.id === draft.id && !used.has(frameKey(frame)))
    const positional = previous[index] && !used.has(frameKey(previous[index])) && !reserved.has(previous[index].id) ? previous[index] : undefined
    const old = exact || positional
    if (old) used.add(frameKey(old))
    const history = [...(old?.history || []), ...(old?.url ? [{ url: old.url, taskId: old.taskId, source: old.source }] : [])]
      .filter((entry, index, all) => all.findIndex(item => item.url === entry.url) === index)
    return {
      ...(old || makeFrame(draft.id || createFrameId())),
      title: draft.title, type: draft.type, prompt: draft.prompt, history,
      offsetMs: Math.max(0, Math.min(draft.offsetMs, Math.max(0, panel.durationMs - 1))),
      ...(draft.shotType ? { shotType: draft.shotType } : {}),
      ...(draft.angle ? { angle: draft.angle } : {}),
      ...(draft.composition ? { composition: draft.composition } : {}),
      ...(draft.continuity !== undefined ? { continuity: draft.continuity } : {}),
    }
  })
  if (plan.continuityConstraints !== undefined) panel.continuityConstraints = plan.continuityConstraints
  if (!panel.frames.some(frame => frame.id === panel.coverFrameId)) panel.coverFrameId = panel.frames[0]?.id
  return true
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const VIDEO_GENERATION_MODE_KEY = 'huobao:video-generation-mode'
let frameIdSequence = 0

/** Frame IDs only need uniqueness; randomUUID is unavailable on ordinary HTTP origins. */
export function createFrameId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `frame-${Date.now().toString(36)}-${(++frameIdSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A cached sheet only represents the exact frame sequence used to compose it. */
export function contactSheetForPanel(panel: Panel, sheet?: ContactSheetView): ContactSheetView | undefined {
  if (!sheet) return undefined
  if (!sheet.descriptor && sheet.status === 'none') return sheet
  const frames = orderedFrames(panel), cells = sheet.descriptor?.cells
  const matches = sheet.panelId === panel.id && cells?.length === frames.length
    && frames.every((frame, index) => frame.id === cells[index].frameId && frame.url === cells[index].url
      && (frame.offsetMs || 0) === cells[index].offsetMs)
  return matches ? sheet : { ...sheet, status: 'stale', annotatedUrl: null, cleanUrl: null, thumbnailUrl: null,
    readyFrames: frames.filter(frame => frame.url).length, totalFrames: frames.length }
}
export type VideoGenerationScope = 'storyboard' | 'group'
export function videoGenerationScopeError(panels: Panel[], scope: VideoGenerationScope, capability?: { group: boolean; minSeconds: number; maxSeconds: number }) {
  if (scope !== 'group') return ''
  if (!capability?.group) return '当前服务不支持按组生成，请改用按分镜生成'
  const seconds = panels.reduce((sum, panel) => sum + panel.durationMs, 0) / 1000
  if (!Number.isInteger(seconds) || seconds < capability.minSeconds || seconds > capability.maxSeconds) {
    return `整组时长 ${seconds} 秒；当前模型要求 ${capability.minSeconds}–${capability.maxSeconds} 的整数秒，请调整范围或时长`
  }
  return ''
}
export function videoReferenceReadiness(panels: Panel[], requested: VideoReferenceInputStrategy, maxImages: number, sheets: ContactSheetView[] = [], generationScope: VideoGenerationScope = 'storyboard') {
  try {
    const effective = selectVideoReferenceStrategy(panels, requested, maxImages, generationScope)
    if (effective === 'contact_sheet') {
      const unavailable = panels.find(panel => {
        const sheet = contactSheetForPanel(panel, sheets.find(sheet => sheet.panelId === panel.id))
        return sheet?.status !== 'ready' || !sheet.cleanUrl || sheet.readyFrames !== sheet.totalFrames
      })
      if (unavailable) return { ready: false, effective, error: `「${unavailable.title}」宫格尚未就绪，请等待合成、重试或选择逐张参考` }
    }
    return { ready: true, effective, error: '' }
  } catch (cause: any) { return { ready: false, effective: undefined, error: cause.message || '分镜画面尚未就绪' } }
}
export interface VideoContinuityCapabilities {
  firstLast: boolean; reference: boolean; reason?: string; maxImages?: number
}
export function videoContinuityReadiness(panels: Panel[], mode: VideoContinuityMode, caps: VideoContinuityCapabilities | undefined,
  referenceStrategy: VideoReferenceInputStrategy, maxImages: number, sheets: ContactSheetView[] = [], scope: VideoGenerationScope = 'storyboard') {
  if (!caps) return { ready: false, error: '正在读取视频模型能力', actual: undefined }
  if (!panels.length || panels.some(p => !p.frames.length || p.frames.length > FRAME_COUNT_MAX || p.frames.some(f => !f.url))) return { ready: false, error: '请先完成全部分镜画面', actual: undefined }
  const fallbackReason = !caps.firstLast ? caps.reason || '当前模型使用参考图模式' : scope === 'group' || panels.length !== 1
    ? '按组生成使用画面参考' : panels[0].frames.length < 2 ? '单张画面使用参考图模式' : ''
  if (mode === 'first_last' && fallbackReason) return { ready: false, error: fallbackReason, actual: undefined }
  if (mode !== 'reference' && !fallbackReason) return { ready: true, error: '', actual: 'first_last' as const, effective: undefined }
  if (!caps.reference) return { ready: false, error: caps.reason || '当前模型不支持画面参考', actual: undefined }
  return { ...videoReferenceReadiness(panels, referenceStrategy, maxImages, sheets, scope), actual: 'reference' as const,
    fallbackReason: mode === 'auto' ? fallbackReason : '' }
}
export function useVideoContinuityMode() {
  const key = 'huobao:video-continuity-mode'
  let initial: VideoContinuityMode = 'auto'
  if (import.meta.client) { try { const stored = localStorage.getItem(key); if (stored === 'reference' || stored === 'first_last') initial = stored } catch {} }
  const mode = ref<VideoContinuityMode>(initial)
  watch(mode, value => { try { localStorage.setItem(key, value) } catch {} })
  return mode
}
export function useVideoContinuityCapabilities(choice: () => { configId?: number; model?: string } | undefined) {
  const capability = ref<VideoContinuityCapabilities>(), loading = ref(false), error = ref('')
  let token = 0
  watch(() => { const c = choice(); return `${c?.configId || ''}:${c?.model || ''}` }, async () => {
    const current = ++token, c = choice(); capability.value = undefined; error.value = ''
    if (!c?.configId) { error.value = '请先选择视频模型'; return }
    loading.value = true
    try {
      const q = new URLSearchParams({ config_id: String(c.configId) }); if (c.model) q.set('model', c.model)
      const result = await previsRequest<VideoContinuityCapabilities>(`/previs/video-continuity-capabilities?${q}`)
      if (current === token) capability.value = result
    } catch (cause: any) { if (current === token) error.value = cause.message || '模型能力读取失败' }
    finally { if (current === token) loading.value = false }
  }, { immediate: true })
  onUnmounted(() => { token++ })
  return { capability, loading, error }
}
export function panelIncomingTransition(timeline: Timeline | undefined, panelId: number) {
  if (!timeline) return undefined
  const segments = orderedSegments(timeline), index = segments.findIndex(s => s.panel.id === panelId)
  if (index < 1) return undefined
  return timeline.transitions.find(e => e.from === segments[index - 1].groupId && e.to === segments[index].groupId)
}

export function useVideoReferenceInputStrategy() {
  const key = 'huobao:video-reference-input-strategy'
  let initial: VideoReferenceInputStrategy = 'auto'
  if (import.meta.client) {
    try {
      const stored = localStorage.getItem(key)
      if (stored === 'auto' || stored === 'individual' || stored === 'contact_sheet') initial = stored
    } catch {}
  }
  const strategy = ref<VideoReferenceInputStrategy>(initial)
  watch(strategy, value => { try { localStorage.setItem(key, value) } catch {} })
  return strategy
}

/**
 * 视频生成统一走「分镜画面」模式：视频制作不再提供「直接生成 / 分镜画面」切换入口，
 * 模式恒为 storyboard_frames。保留该 composable 是为了让调用方继续以响应式引用读取模式，
 * 也便于以后需要时扩展；旧版本地存储的 'direct' 偏好在初始化时清除，避免影响后续判断。
 */
export function useVideoGenerationMode() {
  if (import.meta.client) {
    try { localStorage.removeItem(VIDEO_GENERATION_MODE_KEY) } catch {}
  }
  return ref<'direct' | 'storyboard_frames'>('storyboard_frames')
}

export function usePrevis() {
  const version = ref<AnimaticVersion | null>(null)
  const versions = ref<{ id: number; versionNo: number; status: string }[]>([])
  const framePlans = ref<FramePlanSummary>({ pending: 0, processing: 0, completed: 0, failed: 0 })
  const workingState = ref(false), gridAdopting = ref(false)
  const working = computed({ get: () => workingState.value || gridAdopting.value, set: (value: boolean) => { workingState.value = value } })
  const dirty = ref(false), saveError = ref(''), pollError = ref('')
  const undoStack = ref<Timeline[]>([]), redoStack = ref<Timeline[]>([])
  const editable = computed(() => !!version.value && version.value.status !== 'locked' && !version.value.busy && !working.value)
  // 生成提交只依赖版本未锁定：后台任务完成写回会把 revision 推高，但 createBatch 的事务内
  // 校验能挡住过期提交，所以一个画面生成中不应连带禁用其他画面的生成入口（与资产制作一致）。
  const generatable = computed(() => !!version.value && version.value.status !== 'locked')
  const timeline = computed(() => version.value?.timeline)
  let episodeId = 0, polling: ReturnType<typeof setInterval> | undefined
  let autosave: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<boolean> | undefined
  let pollingNow = false, disposed = false
  const requestedSheets = new Set<string>()

  async function composeContactSheets(panelIds?: number[], force = false) {
    const current = version.value
    if (!current || dirty.value || disposed) return
    const result = await previsRequest<{ items: ContactSheetView[] }>(`/animatic-versions/${current.id}/contact-sheets`, 'POST',
      { revision: current.revision, panelIds, force })
    if (!disposed && !dirty.value && version.value?.id === current.id && version.value.revision === current.revision) {
      version.value.contactSheets = result.items
    }
  }
  function ensureContactSheets() {
    const current = version.value
    if (!current?.contactSheets || dirty.value || disposed) return
    const missing = current.contactSheets.filter(sheet => {
      const panel = current.timeline.panels.find(panel => panel.id === sheet.panelId)
      const key = `${current.id}:${sheet.panelId}:${sheet.sourceHash}`
      if (!panel?.frames.length || panel.frames.length > FRAME_COUNT_MAX || !['none', 'stale'].includes(sheet.status) || requestedSheets.has(key)) return false
      requestedSheets.add(key)
      return true
    })
    if (missing.length) void composeContactSheets(missing.map(sheet => sheet.panelId)).catch(() => { pollError.value = '宫格请求中断，可手动重试' })
  }
  async function retryContactSheet(panelId: number) {
    if (!await save() || !version.value) return
    const current = version.value
    try {
      const result = await previsRequest<{ items: ContactSheetView[] }>(`/animatic-versions/${current.id}/contact-sheets/${panelId}/retry`, 'POST',
        { revision: current.revision })
      if (!disposed && !dirty.value && version.value?.id === current.id && version.value.revision === current.revision) version.value.contactSheets = result.items
    } catch (cause: any) { toast.error(cause.message || '宫格重试失败') }
  }

  function accept(value: AnimaticVersion, clearHistory = false) {
    version.value = value; dirty.value = false; saveError.value = ''
    if (clearHistory) { undoStack.value = []; redoStack.value = [] }
    ensureContactSheets()
  }
  function acceptGridVersion(value: AnimaticVersion) {
    if (disposed || version.value?.id !== value.id) return false
    if (dirty.value || version.value.revision > value.revision) {
      if (dirty.value) {
        clearTimeout(autosave)
        saveError.value = '候选已在服务端采用，但出现新的本地修改，已保留本地内容；请先导出草稿再刷新工作版。'
        toast.error(saveError.value)
      }
      return false
    }
    clearTimeout(autosave)
    accept(value, true)
    return true
  }
  /** A write lease belongs to the workspace, so leaving its review UI cannot lose the result. */
  async function adoptGridCandidate(versionId: number, candidateId: number, revision: number): Promise<AnimaticVersion | false> {
    if (disposed || working.value || dirty.value || version.value?.id !== versionId
      || version.value.revision !== revision || version.value.status === 'locked') {
      throw new Error('当前工作版无法采用，请保存并刷新后重试')
    }
    gridAdopting.value = true
    saveError.value = ''
    try {
      const adopted = await previsRequest<AnimaticVersion>(`/animatic-versions/${versionId}/grid-candidates/${candidateId}/adopt`, 'POST', { revision })
      return acceptGridVersion(adopted) ? adopted : false
    } catch (cause: any) {
      if (!disposed && version.value?.id === versionId) {
        saveError.value = cause?.message || '采用候选失败，请刷新后重试'
        toast.error(saveError.value)
      }
      throw cause
    } finally { gridAdopting.value = false }
  }
  async function refreshVersions() {
    versions.value = await previsRequest(`/episodes/${episodeId}/animatic-versions`)
  }
  async function initialize(id: number) {
    if (gridAdopting.value) return
    episodeId = id
    await refreshVersions()
    accept(await previsRequest(`/episodes/${episodeId}/production-workspace`), true)
    await refreshVersions()
    polling = setInterval(() => { void poll() }, 2500)
  }
  async function poll() {
    if (pollingNow || working.value || dirty.value || !version.value) return
    pollingNow = true
    const id = version.value.id
    try {
      const state = await previsRequest<Partial<AnimaticVersion> & { requiresRefresh: boolean; framePlans?: FramePlanSummary }>(
        version.value.isCurrent
          ? `/episodes/${episodeId}/production-workspace-state?version_id=${id}`
          : `/animatic-versions/${id}/state`,
      )
      if (!disposed && !dirty.value && !working.value && version.value?.id === id) {
        if (state.requiresRefresh || state.revision !== version.value.revision) {
          const remote = await previsRequest<AnimaticVersion>(version.value.isCurrent
            ? `/episodes/${episodeId}/production-workspace`
            : `/animatic-versions/${id}/timeline`)
          if (!disposed && !dirty.value && !working.value && version.value?.id === id) accept(remote, true)
        }
        else {
          if (state.batches) version.value.batches = state.batches
          if (typeof state.busy === 'boolean') version.value.busy = state.busy
          if (state.outputs) version.value.outputs = state.outputs
          if (state.contactSheets) version.value.contactSheets = state.contactSheets
          if (typeof state.isCurrent === 'boolean') version.value.isCurrent = state.isCurrent
          if (state.framePlans) framePlans.value = state.framePlans
          ensureContactSheets()
        }
      }
      pollError.value = ''
    } catch { pollError.value = '进度更新中断，正在重连…' }
    finally { pollingNow = false }
  }
  async function open(id: number) {
    if (!await save()) return
    working.value = true
    try { accept(await previsRequest(`/animatic-versions/${id}/timeline`), true) }
    finally { working.value = false }
  }
  async function create(fromCurrent = false) {
    if (!await save()) return
    working.value = true
    try {
      accept(await previsRequest(`/episodes/${episodeId}/animatic-versions`, 'POST',
        fromCurrent && version.value ? { sourceId: version.value.id } : {}), true)
      await refreshVersions()
      toast.success(fromCurrent ? '已复制为新草稿' : '已从当前分镜创建草稿')
    } finally { working.value = false }
  }
  function scheduleSave() {
    clearTimeout(autosave)
    autosave = setTimeout(() => { void save() }, 1200)
  }
  function edit(action: (t: Timeline) => void) {
    if (!editable.value || !timeline.value) return
    const before = copy(timeline.value), next = copy(before)
    action(next)
    retimeBoundAudio(before, next)
    if (JSON.stringify(before) === JSON.stringify(next)) return
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    version.value!.timeline = next
    dirty.value = true; saveError.value = ''
    scheduleSave()
  }
  function history(redo = false) {
    if (!editable.value || !timeline.value) return
    const source = redo ? redoStack : undoStack, target = redo ? undoStack : redoStack
    const next = source.value.pop()
    if (!next) return
    target.value.push(copy(timeline.value))
    version.value!.timeline = next; dirty.value = true
    scheduleSave()
  }
  async function save(): Promise<boolean> {
    if (gridAdopting.value) return false
    clearTimeout(autosave)
    if (saving) return saving
    if (!dirty.value || !version.value) return true
    working.value = true
    const current = version.value
    saving = (async () => {
      try {
        accept(await previsRequest(`/animatic-versions/${current.id}/timeline`, 'PUT',
          { revision: current.revision, timeline: current.timeline }))
        return true
      } catch (e: any) {
        saveError.value = e.message
        toast.error(`保存失败：${e.message}`)
        return false
      } finally { working.value = false; saving = undefined }
    })()
    return saving
  }
  async function check(lock = false) {
    if (!await save() || !version.value) return
    working.value = true
    try {
      accept(await previsRequest(`/animatic-versions/${version.value.id}/${lock ? 'lock' : 'check'}`, 'POST',
        { revision: version.value.revision }))
      await refreshVersions()
      toast.success(lock ? '版本已锁定' : `检查完成：${version.value!.issues.length} 项待查看`)
    } finally { working.value = false }
  }
  async function generate(type: 'image' | 'video', options: {
    configId?: number; model?: string; panelIds?: number[]; frameTypes?: FrameType[]; frameIds?: string[]; force?: boolean;
    generationMode?: 'direct' | 'storyboard_frames';
    generationScope?: VideoGenerationScope;
    videoReferenceInputStrategy?: VideoReferenceInputStrategy;
    videoContinuityMode?: VideoContinuityMode;
  } = {}) {
    if (!version.value || gridAdopting.value) return
    working.value = true
    try {
      // 后台任务完成写回会推高 revision，本地旧 revision 会被 409 拒绝（表现为"点了没反应"）。
      let stale = false
      const submit = async () => {
        if (!version.value) return false
        if (dirty.value && !await save()) {
          stale ||= /版本已更新/.test(saveError.value)
          return false
        }
        if (!version.value) return false
        try {
          await previsRequest(`/animatic-versions/${version.value.id}/batch-runs`, 'POST',
            { revision: version.value.revision, type, ...options })
          return true
        } catch (error: any) {
          if (/版本已更新/.test(error?.message || '')) { stale = true; return false }
          throw error
        }
      }
      let queued = await submit()
      // 同步最新版本后用新 revision 重试一次；未保存的本地修改以服务端版本为准。
      if (!queued && stale && version.value) {
        accept(await previsRequest(`/animatic-versions/${version.value.id}/timeline`), true)
        queued = await submit()
      }
      if (queued) {
        accept(await previsRequest(`/animatic-versions/${version.value.id}/timeline`), true)
        toast.success(stale ? '已同步最新版本，任务已加入队列' : '任务已加入队列，可在任务面板查看进度')
      }
    } finally { working.value = false }
  }
  async function batchAction(id: number, action: 'retry' | 'cancel', itemIds?: number[]) {
    if (!await save()) return
    working.value = true
    try {
      await previsRequest(`/batch-runs/${id}/${action}`, 'POST', { itemIds })
      if (version.value) accept(await previsRequest(`/animatic-versions/${version.value.id}/timeline`), true)
    } finally { working.value = false }
  }
  onUnmounted(() => { disposed = true; clearInterval(polling); clearTimeout(autosave) })
  return {
    version, versions, timeline, editable, generatable, dirty, working, saveError, pollError, undoStack, redoStack,
    framePlans, initialize, open, create, edit, history, save, check, generate, batchAction, composeContactSheets, retryContactSheet, acceptGridVersion, adoptGridCandidate,
  }
}

/** Review an asynchronous split before applying it to the version that requested it. */
export function useFramePlanner(
  workspace: Pick<ReturnType<typeof usePrevis>, 'version' | 'editable' | 'save' | 'edit'>,
  modelChoice: () => { configId?: number; model?: string },
) {
  const open = ref(false), busy = ref(false), count = ref(4)
  const plans = ref<PanelFramePlan[]>([])
  let requestToken = 0, targetPanelId = 0, targetVersionId = 0
  function close() {
    requestToken++
    open.value = false; busy.value = false; plans.value = []
  }
  async function split(panelId: number, options: { force?: boolean; count?: number } = {}) {
    if (busy.value) return
    if (!workspace.editable.value || !workspace.version.value) {
      toast.error('当前工作版不可编辑，请稍后重试或复制为新草稿')
      return
    }
    targetPanelId = panelId; targetVersionId = workspace.version.value.id
    const token = ++requestToken, versionId = targetVersionId
    const active = () => token === requestToken && open.value && workspace.version.value?.id === versionId
    count.value = options.count ?? count.value
    plans.value = []; open.value = true; busy.value = true
    try {
      const saved = await workspace.save()
      if (!active()) return
      if (!saved) { close(); return }
      const { taskIds } = await submitFramePlan(versionId, {
        revision: workspace.version.value!.revision,
        panelIds: [panelId], count: count.value, force: options.force,
        ...modelChoice(),
      })
      const taskId = taskIds[0]
      if (!taskId) throw new Error('未找到拆分任务，请重试')
      while (active()) {
        const result = await fetchFramePlans(versionId)
        if (!active()) return
        const item = result.items.find(item => item.id === taskId)
        if (!item) throw new Error('未找到拆分任务，请重试')
        if (item.status === 'failed') throw new Error(item.error || '画面拆分失败，请重试')
        const plan = result.plans.find(plan => plan.taskId === taskId)
        if (item.status === 'completed' && plan) {
          plans.value = [plan]; count.value = plan.count
          return
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    } catch (cause: any) {
      if (active()) { close(); toast.error(cause.message || '画面拆分失败，请重试') }
    } finally {
      if (token === requestToken) busy.value = false
    }
  }
  async function apply(drafts: PanelFramePlan[]) {
    if (!open.value || busy.value || !workspace.editable.value || workspace.version.value?.id !== targetVersionId) return
    const plan = drafts.find(plan => plan.panelId === targetPanelId)
    const target = workspace.version.value.timeline.panels.find(panel => panel.id === targetPanelId)
    if (!plan?.frames.length || !target) return
    if (target.frames.some(frame => frame.locked)) { toast.error('存在已锁定画面，不能应用新的拆分方案'); return }
    if (plan.frames.length > FRAME_COUNT_MAX) {
      toast.error(`每个镜头最多 ${FRAME_COUNT_MAX} 张画面，请先删减拆分方案`)
      return
    }
    busy.value = true
    const token = requestToken
    try {
      workspace.edit(timeline => {
        const panel = timeline.panels.find(panel => panel.id === plan.panelId)!
        applyFramePlanToPanel(panel, plan)
      })
      if (await workspace.save() && token === requestToken) {
        close()
        toast.success(`已写入 ${plan.frames.length} 张画面，可点击「生成整组宫格」出图`)
      }
    } catch (cause: any) {
      if (token === requestToken) toast.error(cause.message || '应用拆分方案失败，请重试')
    } finally {
      if (token === requestToken) busy.value = false
    }
  }
  watch(() => workspace.version.value?.id, close)
  onUnmounted(close)
  return { open, busy, count, plans, close, split, apply, recount: (value: number) => split(targetPanelId, { force: true, count: value }) }
}
