import { computed, onUnmounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { AnimaticVersion, Timeline, FrameType } from '../../../backend/src/services/previs-domain'
import { retimeBoundAudio } from '../../../backend/src/services/previs-domain'
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
  const response = await fetch(`/api/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message || `请求失败 (${response.status})`)
  return result.data ?? result
}
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
  items: { id: number; panelId: number; status: 'pending' | 'processing' | 'completed' | 'failed'; count: number; error: string | null; createdAt: string }[]
  plans: PanelFramePlan[]
  summary: FramePlanSummary
}
/** 提交拆分任务：立即返回，进度经轮询 state.framePlans 获取。 */
export async function submitFramePlan(versionId: number, payload: FramePlanPayload) {
  return previsRequest<{ queued: number }>(`/animatic-versions/${versionId}/frames/plan`, 'POST', payload)
}
/** 查询拆分任务状态与已完成方案。 */
export async function fetchFramePlans(versionId: number) {
  return previsRequest<FramePlansResult>(`/animatic-versions/${versionId}/frames/plan`)
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const VIDEO_GENERATION_MODE_KEY = 'huobao:video-generation-mode'

export function useVideoGenerationMode() {
  type Mode = 'direct' | 'storyboard_frames'
  let initial: Mode = 'direct'
  if (import.meta.client) {
    try {
      const stored = localStorage.getItem(VIDEO_GENERATION_MODE_KEY)
      if (stored === 'direct' || stored === 'storyboard_frames') initial = stored
    } catch {}
  }
  const mode = ref<Mode>(initial)
  watch(mode, value => {
    try { localStorage.setItem(VIDEO_GENERATION_MODE_KEY, value) } catch {}
  })
  return mode
}

export function usePrevis() {
  const version = ref<AnimaticVersion | null>(null)
  const versions = ref<{ id: number; versionNo: number; status: string }[]>([])
  const framePlans = ref<FramePlanSummary>({ pending: 0, processing: 0, completed: 0, failed: 0 })
  const working = ref(false), dirty = ref(false), saveError = ref(''), pollError = ref('')
  const undoStack = ref<Timeline[]>([]), redoStack = ref<Timeline[]>([])
  const editable = computed(() => !!version.value && version.value.status !== 'locked' && !version.value.busy && !working.value)
  const timeline = computed(() => version.value?.timeline)
  let episodeId = 0, polling: ReturnType<typeof setInterval> | undefined
  let autosave: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<boolean> | undefined
  let pollingNow = false, disposed = false

  function accept(value: AnimaticVersion, clearHistory = false) {
    version.value = value; dirty.value = false; saveError.value = ''
    if (clearHistory) { undoStack.value = []; redoStack.value = [] }
  }
  async function refreshVersions() {
    versions.value = await previsRequest(`/episodes/${episodeId}/animatic-versions`)
  }
  async function initialize(id: number) {
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
      const state = await previsRequest<Partial<AnimaticVersion> & { requiresRefresh: boolean }>(
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
          if (typeof state.isCurrent === 'boolean') version.value.isCurrent = state.isCurrent
          if (state.framePlans) framePlans.value = state.framePlans
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
  } = {}) {
    if (!await save() || !version.value) return
    working.value = true
    try {
      await previsRequest(`/animatic-versions/${version.value.id}/batch-runs`, 'POST',
        { revision: version.value.revision, type, ...options })
      accept(await previsRequest(`/animatic-versions/${version.value.id}/timeline`), true)
      toast.success('任务已加入队列，可在任务面板查看进度')
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
    version, versions, timeline, editable, dirty, working, saveError, pollError, undoStack, redoStack,
    framePlans, initialize, open, create, edit, history, save, check, generate, batchAction,
  }
}
