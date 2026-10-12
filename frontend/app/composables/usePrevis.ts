import { computed, onUnmounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import type { AnimaticVersion, Timeline, FrameType } from '../../../backend/src/services/previs-domain'
import { makeFrame, orderedFrames, retimeBoundAudio } from '../../../backend/src/services/previs-domain'
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
  taskId: number
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
  return previsRequest<{ queued: number; taskIds: number[] }>(`/animatic-versions/${versionId}/frames/plan`, 'POST', payload)
}
/** 查询拆分任务状态与已完成方案。 */
export async function fetchFramePlans(versionId: number) {
  return previsRequest<FramePlansResult>(`/animatic-versions/${versionId}/frames/plan`)
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const VIDEO_GENERATION_MODE_KEY = 'huobao:video-generation-mode'
let frameIdSequence = 0

/** Frame IDs only need uniqueness; randomUUID is unavailable on ordinary HTTP origins. */
export function createFrameId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `frame-${Date.now().toString(36)}-${(++frameIdSequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

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

/** Review an asynchronous split before applying it to the version that requested it. */
export function useFramePlanner(
  workspace: Pick<ReturnType<typeof usePrevis>, 'version' | 'editable' | 'save' | 'edit'>,
  modelChoice: () => { configId?: number; model?: string },
) {
  const open = ref(false), busy = ref(false), count = ref(3)
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
    busy.value = true
    const token = requestToken
    try {
      workspace.edit(timeline => {
        const panel = timeline.panels.find(panel => panel.id === plan.panelId)!
        const previous = orderedFrames(panel)
        panel.frames = plan.frames.map((frame, index) => {
          const old = previous[index]
          const history = [...(old?.history || []), ...(old?.url ? [{ url: old.url, taskId: old.taskId }] : [])]
            .filter((entry, index, all) => all.findIndex(item => item.url === entry.url) === index)
          return {
            ...makeFrame(createFrameId(), Math.max(0, Math.min(frame.offsetMs, panel.durationMs - 1)), frame.title),
            type: frame.type, prompt: frame.prompt, history,
          }
        })
        panel.coverFrameId = panel.frames[0]?.id
      })
      if (await workspace.save() && token === requestToken) {
        close()
        toast.success(`已写入 ${plan.frames.length} 张画面，可点击「生成缺失」出图`)
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
