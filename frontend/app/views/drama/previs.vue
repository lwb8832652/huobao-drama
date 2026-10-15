<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft, ArrowRight, Check, Clapperboard,
  Download, FileText, Film, Images, Layers, ListTodo, Loader2, Lock, Plus,
  Redo2, RefreshCw, Save, Scissors, ShieldCheck, Sparkles, Undo2, Upload, Users, X,
} from 'lucide-vue-next'
import TaskQueueSettings from '~/components/TaskQueueSettings.vue'
import QueueSettingsButton from '~/components/QueueSettingsButton.vue'
import QueueJobActions from '~/components/QueueJobActions.vue'
import { queueStatusLabel, filterQueueRows, type QueueFilter } from '~/composables/useTaskQueue'
import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
import ThemeToggle from '~/components/ThemeToggle.vue'
import ContinuityReviewPanel from '~/components/previs/ContinuityReviewPanel.vue'
import PrevisPlayer from '~/components/previs/PrevisPlayer.vue'
import PrevisTimeline from '~/components/previs/PrevisTimeline.vue'
import StoryboardFramesEditor from '~/components/previs/StoryboardFramesEditor.vue'
import VideoContinuityControl from '~/components/previs/VideoContinuityControl.vue'
import StoryboardGridTools from '~/components/previs/StoryboardGridTools.vue'
import FramePlanDialog from '~/components/previs/FramePlanDialog.vue'
import StoryboardContactSheet from '~/components/previs/StoryboardContactSheet.vue'
import { uploadAPI } from '~/composables/useApi'
import {
  FRAME_COUNT_MAX, frameCountChangeAllowed, checkContinuity, createFrameId, durationMs, formatTime, frameKey, groupPanels, makeFrame, mediaUrl, orderedFrames,
  applyFramePlanToPanel, contactSheetForPanel, videoContinuityReadiness, panelIncomingTransition, useVideoContinuityMode, useVideoContinuityCapabilities, videoGenerationScopeError, planFrames, previsRequest, submitFramePlan, fetchFramePlans, timelineSegments, usePrevis, useVideoGenerationMode, useVideoReferenceInputStrategy,
  type AudioClip, type ContinuityIssue, type FrameType, type Keyframe,
  type Panel, type PanelFramePlan, type FramePlansResult, type Timeline, type VideoGenerationScope,
} from '~/composables/usePrevis'
import '~/assets/css/previs.css'

definePageMeta({ layout: 'studio' })
type PrevisStageView = 'storyboard' | 'video' | 'script'

const { t } = useI18n()
const route = useRoute()
const dramaId = Number(route.params.id), episodeNumber = Number(route.params.episodeNumber)
const episodePath = `/drama/${dramaId}/episode/${episodeNumber}`
const {
  version, timeline, editable, generatable, dirty, working, saveError, pollError, undoStack, redoStack,
  framePlans: framePlansSummary,
  initialize, open, create, edit, history, save, check, generate, batchAction, retryContactSheet, adoptGridCandidate,
} = usePrevis()
const videoGenerationMode = useVideoGenerationMode()
const videoReferenceInputStrategy = useVideoReferenceInputStrategy()
const videoContinuityMode = useVideoContinuityMode()
const videoGenerationScope = ref<VideoGenerationScope>('storyboard')
const drama = ref<any>(), episode = ref<any>(), error = ref(''), loading = ref(true), enabled = ref(true)
const groupId = ref(''), panelId = ref(0), currentMs = ref(0)
const stageView = ref<PrevisStageView>('storyboard'), inspector = ref('frames'), allIssues = ref(true)
const previewViews: Array<{ key: PrevisStageView; label: string }> = [
  { key: 'storyboard', label: '分镜预演' },
  { key: 'video', label: '视频预览' },
  { key: 'script', label: '剧本' },
]
const player = ref<InstanceType<typeof PrevisPlayer>>()
const modal = ref(''), dialog = ref<HTMLDialogElement>()
const framePlanOpen = ref(false), framePlanCount = ref(4)
const gridBusy = ref(false)
const framePlans = ref<PanelFramePlan[]>([])
const framePlanTaskRows = ref<FramePlansResult['items']>([]), framePlanTaskError = ref('')
let framePlanTaskToken = 0, framePlanTaskTimer: ReturnType<typeof setInterval> | undefined
async function loadFramePlanTasks() {
  const id = version.value?.id, token = ++framePlanTaskToken
  if (!id) return
  try { const result = await fetchFramePlans(id); if (token === framePlanTaskToken && version.value?.id === id) { framePlanTaskRows.value = result.items; framePlanTaskError.value = '' } }
  catch (cause: any) { if (token === framePlanTaskToken) framePlanTaskError.value = cause.message || '读取画面规划任务失败' }
}
watch(() => `${inspector.value}:${version.value?.id || ''}`, () => {
  ++framePlanTaskToken; clearInterval(framePlanTaskTimer)
  if (inspector.value === 'tasks') { void loadFramePlanTasks(); framePlanTaskTimer = setInterval(loadFramePlanTasks, 4000) }
})
const framePlanActive = computed(() => framePlansSummary.value.pending + framePlansSummary.value.processing)
const videoPanelIds = ref<number[]>([])
const textModel = ref(''), imageModel = ref(''), videoModel = ref('')
const episodeResolution = ref('480p')
const configs = ref<any[]>([]), capabilities = ref<Record<string, any>>({})
const storyboards = ref<any[]>([])
const SIDEBAR_COLLAPSED_KEY = 'huobao:sidebar-collapsed'
const sidebarCollapsed = ref((() => {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
})())
const frameNames: Record<FrameType, string> = { start: '开场画面', middle: '过程画面', end: '结束画面', beat: '分镜画面' }
const constraintNames: Record<string, string> = {
  auto: '全部分镜画面', direct: '直传素材（历史）', first_last: '首尾帧',
  first: '首帧（历史）', reference: '全部分镜画面', text: '纯文本（历史）',
}
const statusNames: Record<string, string> = {
  pending: '排队中', processing: '生成中', completed: '已完成', failed: '失败',
  partial_failed: '部分失败', cancelled: '已取消', draft: '草稿', ready: '待锁定', locked: '已锁定',
}
const ruleNames: Record<string, string> = {
  missing_frame: '关键帧缺失', group_duration: '组时长建议',
  scene_bridge: '场景衔接', camera_jump: '机位跳变', audio_overflow: '音频超时',
  empty_group: '空镜头', empty_timeline: '没有分镜',
}
const continuityPanel = ref<InstanceType<typeof ContinuityReviewPanel>>()
const groups = computed(() => timeline.value?.groups || [])
const segments = computed(() => timeline.value ? timelineSegments(timeline.value) : [])
const total = computed(() => timeline.value ? durationMs(timeline.value) : 0)
const group = computed(() => groups.value.find(g => g.id === groupId.value) || groups.value[0])
const panels = computed(() => timeline.value && group.value ? groupPanels(timeline.value, group.value) : [])
const panel = computed(() => panels.value.find(p => p.id === panelId.value) || panels.value[0])
const currentPanelVideo = computed(() => version.value?.outputs.find(o => o.panelIds.includes(panel.value?.id || 0)))
const activeFrameId = computed(() => {
  const current = segments.value.find(s => currentMs.value >= s.startMs && currentMs.value < s.endMs)
    || segments.value.at(-1)
  if (!current) return ''
  const available = orderedFrames(current.panel).filter(item => item.url)
  const offset = currentMs.value - current.startMs
  const frame = available.filter(item => (item.offsetMs || 0) <= offset).at(-1) || available[0]
  return frame ? frameKey(frame) : ''
})
const edge = computed(() => timeline.value?.transitions.find(e => e.to === group.value?.id))
const issues = computed(() => timeline.value ? checkContinuity(timeline.value) : [])
const fails = computed(() => issues.value.filter(i => i.severity === 'fail'))
const warnings = computed(() => issues.value.filter(i => i.severity === 'warning' && !i.reason))
const visibleIssues = computed(() => issues.value.filter(i => allIssues.value || i.groupId === group.value?.id))
const batches = computed(() => version.value?.batches || [])
const taskQueueSettingsOpen = ref(false), taskFilter = ref<QueueFilter>('all')
const taskItems = computed(() => batches.value.flatMap(batch => batch.items))
const activeTasks = computed(() => taskItems.value.filter(item => ['pending', 'processing'].includes(item.status)).length + framePlanActive.value)
const taskFilters = computed(() => [
  { key: 'active' as const, label: '进行中', count: activeTasks.value },
  { key: 'completed' as const, label: '完成', count: taskItems.value.filter(item => item.status === 'completed').length + framePlansSummary.value.completed },
  { key: 'failed' as const, label: '失败', count: taskItems.value.filter(item => item.status === 'failed').length + framePlansSummary.value.failed },
])
const taskExecuting = computed(() => taskItems.value.filter(item => item.status === 'processing').length + framePlansSummary.value.processing)
const taskQueued = computed(() => taskItems.value.filter(item => item.status === 'pending').length + framePlansSummary.value.pending)
const filteredBatches = computed(() => batches.value.map(batch => ({ ...batch, items: filterQueueRows(batch.items, taskFilter.value) })).filter(batch => batch.items.length))
const filteredFramePlanTasks = computed(() => filterQueueRows(framePlanTaskRows.value, taskFilter.value))
/** 行内状态胶囊的 class 映射，与 episode.vue 的 genTaskStateClass 同规则（cancelled 无配色，保持灰底）。 */
function pvTaskStateClass(status: string) {
  if (status === 'cancelled') return 'cancelled'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  return 'pending'
}
const showPlanningTasks = computed(() => taskFilter.value === 'all' ? framePlanTaskRows.value.length > 0 || framePlanActive.value + framePlansSummary.value.completed + framePlansSummary.value.failed > 0 : taskFilter.value === 'active' ? framePlanActive.value > 0 : taskFilter.value === 'failed' ? framePlansSummary.value.failed > 0 : framePlansSummary.value.completed > 0)
async function refreshQueueTasks() {
  if (!version.value) return
  const latest = await previsRequest<Partial<typeof version.value>>(`/animatic-versions/${version.value.id}/state`)
  if (latest.batches) version.value.batches = latest.batches
  await loadFramePlanTasks()
}
const frameCount = computed(() => timeline.value?.panels.reduce((n, p) => n + p.frames.filter(f => f.url).length, 0) || 0)
const characterCount = computed(() => drama.value?.characters?.filter((item: any) => !item.deleted_at && !item.deletedAt).length || 0)
const assets = computed(() => [
  ...(drama.value?.characters || []),
  ...(drama.value?.scenes || []),
  ...(drama.value?.props || []),
].filter((item: any) => !item.deleted_at && !item.deletedAt))
const assetsReady = computed(() => assets.value.length > 0 && assets.value.every((item: any) => item.image_url || item.imageUrl))
const videoSources = computed(() => {
  const sources: Record<number, { url: string; offsetMs: number }> = {}
  for (const output of version.value?.outputs.filter(o => !o.stale) || []) {
    let offsetMs = 0
    for (const id of output.panelIds) {
      if (!sources[id]) sources[id] = { url: output.url, offsetMs }
      offsetMs += timeline.value?.panels.find(p => p.id === id)?.durationMs || 0
    }
  }
  for (const output of version.value?.outputs.filter(o => o.stale) || []) {
    for (const id of output.panelIds) if (!sources[id]) sources[id] = { url: '', offsetMs: 0 }
  }
  for (const item of timeline.value?.panels || []) {
    if (Object.prototype.hasOwnProperty.call(sources, item.id)) continue
    const legacy = storyboards.value.find(storyboard => Number(storyboard.id) === item.id)
    const url = item.videoUrl || legacy?.video_url || legacy?.videoUrl
      || legacy?.composed_video_url || legacy?.composedVideoUrl
    if (url) sources[item.id] = { url, offsetMs: 0 }
  }
  return sources
})
const hasVideoPreview = computed(() => timeline.value?.panels.some(item => {
  if (Object.prototype.hasOwnProperty.call(videoSources.value, item.id)) return !!videoSources.value[item.id]?.url
  return !!item.videoUrl
}) || false)
const completedVideos = computed(() => storyboards.value.length
  ? storyboards.value.filter(item => item.video_url || item.videoUrl).length
  : groups.value.filter(g => g.panelIds.every(id => !!videoSources.value[id]?.url)).length)
function modelOptions(type: string) {
  const seen = new Set<string>()
  return [...configs.value]
    .filter(c => (c.service_type || c.serviceType) === type && (c.is_active ?? c.isActive))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .flatMap(c => {
      let models: string[] = []
      try { models = Array.isArray(c.model) ? c.model : JSON.parse(c.model || '[]') } catch { models = [c.model] }
      return models.filter(model => {
        const key = `${c.provider}/${model}`
        if (!model || seen.has(key)) return false
        seen.add(key)
        return true
      }).map(model => ({
        key: `${c.provider}/${model}`, label: `${c.name} · ${model}`, configId: c.id,
        configName: c.name, model, provider: c.provider,
      }))
    })
}
function hasMultipleConfigs(type: string) {
  return new Set(modelOptions(type).map(option => option.configId)).size > 1
}
function modelChoice(type: 'text' | 'image' | 'video') {
  const selected = type === 'text' ? textModel.value : type === 'image' ? imageModel.value : videoModel.value
  return modelOptions(type).find(o => o.key === selected) || modelOptions(type)[0]
}
const { capability: videoContinuityCapability, error: videoContinuityError } = useVideoContinuityCapabilities(() => modelChoice('video'))
const resolutionOptions = computed(() => {
  const provider = modelChoice('video')?.provider
  if (provider === 'minimax') return [
    { key: '720p', model: '768P · 高清' },
    { key: '1080p', model: '2K · 超清' },
  ]
  if (provider === 'aliyun') return [
    { key: '480p', model: '480P · 流畅' },
    { key: '720p', model: '720P · 高清' },
    { key: '1080p', model: '1080P · 超清' },
  ]
  return [
    { key: '480p', model: '480p · 流畅' },
    { key: '720p', model: '720p · 高清' },
  ]
})
const sidebarSections = computed(() => ([
  {
    id: 'script',
    label: t('episode.stage.script'),
    items: [
      { key: 'script:raw', label: t('episode.script.raw'), icon: FileText },
      { key: 'script:rewrite', label: t('episode.script.rewrite'), icon: FileText },
    ],
  },
  {
    id: 'production',
    label: t('episode.stage.production'),
    items: [
      { key: 'prod:assets', label: t('episode.prod.assets'), icon: Users },
      { key: 'prod:videos', label: t('episode.prod.videos'), icon: Clapperboard },
    ],
  },
  {
    id: 'export',
    label: t('episode.stage.export'),
    items: [{ key: 'export:merge', label: t('episode.stage.mergeExport'), icon: Download }],
  },
]))
const mainProgressSteps = computed(() => [
  { id: 'script', label: t('episode.stage.script') },
  { id: 'assets', label: t('episode.prod.assets') },
  { id: 'videos', label: t('episode.stage.videos') },
  { id: 'export', label: t('episode.stage.export') },
])
const currentMainIdx = 2
const pipelineProgress = computed(() =>
  Number(!!(episode.value?.script_content || episode.value?.scriptContent)) + Number(mainStageDone('videos')))
const currentStageLabel = computed(() => `${t('episode.stage.videos')} · 镜头看板`)
function mainStageDone(stageId: string) {
  if (stageId === 'script') return !!(episode.value?.script_content || episode.value?.scriptContent)
  if (stageId === 'assets') return assetsReady.value
  if (stageId === 'videos') return groups.value.length > 0 && completedVideos.value === groups.value.length
  if (stageId === 'export') return !!(episode.value?.video_url || episode.value?.videoUrl)
  return false
}
function sectionState(sectionId: string) {
  if (sectionId === 'export') return 'none'
  if (sectionId === 'script') return mainStageDone('script') ? 'done' : 'pending'
  return mainStageDone('assets') && mainStageDone('videos') ? 'done' : 'active'
}
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    sidebarCollapsed.value
      ? localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
      : localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
  } catch {}
}
function goSubStep(key: string) {
  const [stage, step] = key.split(':')
  const query = stage === 'script'
    ? { stage: 'script', step }
    : stage === 'prod'
      ? { stage: step }
      : { stage: 'export' }
  void navigateTo({ path: episodePath, query })
}
function goMainStage(stage: string) {
  void navigateTo({ path: episodePath, query: { stage } })
}
function persistModel(value: string, key: string) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key) } catch {}
}
watch(textModel, value => persistModel(value, 'huobao:model:chat'))
watch(imageModel, value => persistModel(value, 'huobao:model:image'))
watch(videoModel, value => persistModel(value, 'huobao:model:video'))
watch(episodeResolution, async (value, previous) => {
  if (!episode.value?.id || value === previous || value === (episode.value.resolution || '480p')) return
  try {
    await previsRequest(`/episodes/${episode.value.id}`, 'PUT', { resolution: value })
    episode.value.resolution = value
    toast.success(`视频分辨率已切换为 ${resolutionOptions.value.find(item => item.key === value)?.model || value}`)
  } catch (cause: any) {
    episodeResolution.value = previous
    toast.error(cause.message || '分辨率更新失败')
  }
})
const videoCapability = computed(() => capabilities.value[modelChoice('video')?.provider || ''])
const videoTargetPanels = computed(() => {
  if (!timeline.value) return []
  if (!videoPanelIds.value.length) return timeline.value.panels
  return timeline.value.panels.filter(p => videoPanelIds.value.includes(p.id))
})
const videoTargetDuration = computed(() => videoTargetPanels.value.reduce((sum, panel) => sum + panel.durationMs, 0) / 1000)
const incompleteVideoPanels = computed(() => videoTargetPanels.value.filter(p => !p.frames.length || p.frames.some(frame => !frame.url)))
const emptyFramePanels = computed(() => timeline.value?.panels.filter(p => !p.frames.length) || [])
function groupDuration(id: string) { return segments.value.filter(s => s.groupId === id).reduce((n, s) => n + s.panel.durationMs, 0) }
function groupPanel(id: string) {
  return timeline.value?.panels.find(p => p.id === groups.value.find(g => g.id === id)?.panelIds[0])
}
function sheetForPanel(target: Panel) {
  return contactSheetForPanel(target, version.value?.contactSheets?.find(sheet => sheet.panelId === target.id))
}
const videoReferenceState = computed(() => {
  const error = videoGenerationScopeError(videoTargetPanels.value, videoGenerationScope.value, videoCapability.value)
  if (error) return { ready: false, error, effective: undefined }
  const units = videoGenerationScope.value === 'group' ? [videoTargetPanels.value] : videoTargetPanels.value.map(panel => [panel])
  const states = units.map(panels => videoContinuityReadiness(panels, videoContinuityMode.value, videoContinuityCapability.value, videoReferenceInputStrategy.value, videoCapability.value?.maxImages || 9, version.value?.contactSheets || [], videoGenerationScope.value))
  return states.find(state => !state.ready) || { ...states[0], ready: true, error: '', effective: states[0]?.effective }
})
function groupScene(id: string) {
  const item = groups.value.find(group => group.id === id)
  return timeline.value?.panels.find(panel => item?.panelIds.includes(panel.id))?.scene || '未填写场景'
}
function groupStatus(id: string) {
  return issues.value.some(i => i.groupId === id && i.severity === 'fail') ? 'fail'
    : issues.value.some(i => i.groupId === id && !i.reason) ? 'warning' : 'pass'
}
async function run(action: () => any) {
  try { await action() } catch (e: any) { toast.error(e.message || '操作失败，请重试') }
}
function setStageView(view: PrevisStageView) {
  if (view === stageView.value) return
  player.value?.stop()
  stageView.value = view
}
function select(id: string, shotId?: number) {
  player.value?.stop()
  groupId.value = id
  panelId.value = shotId || groups.value.find(g => g.id === id)?.panelIds[0] || 0
  currentMs.value = segments.value.find(s => s.panel.id === panelId.value)?.startMs || 0
}
function seek(ms: number) {
  currentMs.value = Math.max(0, Math.min(total.value, ms))
  const s = segments.value.find(s => ms >= s.startMs && ms < s.endMs)
  if (s) { groupId.value = s.groupId; panelId.value = s.panel.id }
}
watch(() => version.value?.id, () => { select(groups.value[0]?.id || ''); videoPanelIds.value = [] })
watch(total, value => { if (currentMs.value > value) seek(value) })
function updatePanel(key: keyof Panel, value: any) {
  const id = panel.value?.id
  edit(t => {
    const target = t.panels.find(p => p.id === id)
    if (target) Object.assign(target, { [key]: value })
    if (key === 'title') {
      const group = t.groups.find(group => group.panelIds[0] === id)
      if (group) group.title = value
    }
  })
}
function updateFrames(frames: Keyframe[], coverFrameId?: string) {
  const id = panel.value?.id
  edit(t => {
    const target = t.panels.find(p => p.id === id)
    if (target) { target.frames = frames; target.coverFrameId = coverFrameId }
  })
}
function setDuration(id: number, value: number) {
  edit(t => {
    const p = t.panels.find(p => p.id === id)
    if (p) p.durationMs = Math.max(100, Math.round(value))
  })
}
function updateEdge(key: string, value: any) {
  const to = group.value?.id
  edit(t => { const e = t.transitions.find(e => e.to === to); if (e) Object.assign(e, { [key]: value }) })
}
function locateIssue(issue: ContinuityIssue) {
  select(issue.groupId, issue.panelId)
  setStageView('storyboard')
}
const waiverIssue = ref<ContinuityIssue>(), waiverReason = ref('')
function waive(issue: ContinuityIssue) { waiverIssue.value = issue; waiverReason.value = issue.reason || ''; modal.value = 'waiver' }
function applyWaiver() {
  if (!waiverReason.value.trim() || !waiverIssue.value) return
  edit(t => { t.acknowledgements[waiverIssue.value!.id] = waiverReason.value.trim() }); modal.value = ''
}
function showStrategy() { modal.value = 'strategy' }
async function generateFrames(ids?: number[], frameIds?: string[], force = false) {
  const model = modelChoice('image')
  if (!model) { showStrategy(); toast.error('请选择已启用的图片模型'); return }
  await generate('image', { configId: model.configId, model: model.model, panelIds: ids, frameIds, force })
  inspector.value = 'tasks'
}
async function beforeGridAction() {
  if (!await save() || !version.value) return false
  return { versionId: version.value.id, revision: version.value.revision }
}
async function planAndGenerate(ids?: number[]) {
  const selected = ids?.length ? ids : timeline.value?.panels.map(p => p.id) || []
  const planned = new Map<number, Keyframe[]>()
  for (const p of timeline.value?.panels.filter(p => selected.includes(p.id) && !p.frames.length) || []) {
    const next = planFrames(p, createFrameId())
    if (!frameCountChangeAllowed(next, p.frames)) {
      toast.error(`「${p.title}」规划结果超过 ${FRAME_COUNT_MAX} 张画面，请先调整镜头描述`)
      return
    }
    planned.set(p.id, next)
  }
  edit(t => {
    for (const p of t.panels) {
      const frames = planned.get(p.id)
      if (!p.frames.length && frames) p.frames = frames
    }
  })
  await generateFrames(selected)
}
const framePlanSubmitting = ref(false)
/** 提交拆分任务：立即返回，进度经轮询的 framePlansSummary 展示，完成后在任务面板查看方案。 */
async function submitFrameSplit(panelIds: number[], force = false, count?: number) {
  if (!version.value || !panelIds.length) { toast.error('没有可拆分的镜头，请先选中一个镜头'); return }
  if (version.value.status === 'locked') { toast.error('当前版本已锁定，请复制为新草稿后再拆分画面'); return }
  if (!editable.value) {
    toast.error(working.value
      ? '正在处理其他操作，请稍后再拆分'
      : '关键帧生成任务进行中，请稍后再拆分')
    return
  }
  if (!await save() || !version.value) return
  const choice = modelChoice('text')
  framePlanSubmitting.value = true
  try {
    const { queued } = await submitFramePlan(version.value.id, {
      revision: version.value.revision,
      panelIds,
      count,
      configId: choice?.configId,
      model: choice?.model,
      force,
    })
    if (!queued) { toast.info('所选镜头已生成过方案，未重复提交'); return }
    toast.success(`已提交 ${queued} 个镜头的拆分任务，正在后台拆分`)
    inspector.value = 'tasks'
  } finally { framePlanSubmitting.value = false }
}
async function splitPanel(force = false) {
  await submitFrameSplit(panel.value ? [panel.value.id] : [], force)
}
async function splitEmptyPanels() {
  const ids = emptyFramePanels.value.map(p => p.id)
  if (!ids.length) { toast.info('所有镜头都已有分镜画面'); return }
  await submitFrameSplit(ids)
}
async function openFramePlans() {
  if (!version.value) return
  try {
    const result = await fetchFramePlans(version.value.id)
    if (!result.plans.length) { toast.info('还没有完成的拆分方案'); return }
    framePlans.value = result.plans
    framePlanCount.value = result.plans[0]?.count || framePlanCount.value
    framePlanOpen.value = true
  } catch (cause: any) { toast.error(cause.message || '读取拆分方案失败') }
}
async function retryFailedFramePlans() {
  if (!version.value) return
  try {
    const { queued } = await previsRequest(`/animatic-versions/${version.value.id}/frames/plan/retry`, 'POST', {})
    toast.success(queued ? `已重新排队 ${queued} 个失败镜头` : '没有可重试的失败项')
  } catch (cause: any) { toast.error(cause.message || '重试失败') }
}
async function recountFramePlan(count: number) {
  // 调整数量 = 重新提交拆分任务，完成后再次打开方案。
  framePlanCount.value = count
  const panelIds = framePlans.value.map(plan => plan.panelId)
  framePlanOpen.value = false
  if (panelIds.length) await submitFrameSplit(panelIds, true, count)
}
function applyFramePlan(plans: PanelFramePlan[]) {
  if (!editable.value) return
  if (timeline.value?.panels.some(panel => plans.some(plan => plan.panelId === panel.id) && panel.frames.some(frame => frame.locked))) {
    toast.error('存在已锁定画面，不能应用新的拆分方案')
    return
  }
  const total = plans.reduce((sum, plan) => sum + plan.frames.length, 0)
  if (!total) return
  if (plans.some(plan => plan.frames.length > FRAME_COUNT_MAX)) {
    toast.error(`每个镜头最多 ${FRAME_COUNT_MAX} 张画面，请先删减拆分方案`)
    return
  }
  edit(t => {
    for (const plan of plans) {
      const target = t.panels.find(p => p.id === plan.panelId)
      if (!target) continue
      applyFramePlanToPanel(target, plan)
    }
  })
  framePlanOpen.value = false
  toast.success(`已写入 ${total} 张画面，可点击「生成整组宫格」出图`)
}
const uploading = ref(false)
const audioDraft = ref<AudioClip>()
function showAudio(id?: string) {
  const clip = timeline.value?.audio.find(a => a.id === id)
  audioDraft.value = clip ? JSON.parse(JSON.stringify(clip)) : {
    id: createFrameId(), type: 'dialogue', panelId: panel.value?.id || null, character: '', text: '', url: '',
    startMs: Math.round(currentMs.value / 100) * 100, durationMs: panel.value?.durationMs || 3000,
  }
  modal.value = 'audio'
}
function saveAudio(remove = false) {
  if (!audioDraft.value) return
  const value = { ...audioDraft.value }
  edit(t => {
    const index = t.audio.findIndex(a => a.id === value.id)
    if (remove) { if (index >= 0) t.audio.splice(index, 1) }
    else if (index >= 0) t.audio[index] = value
    else t.audio.push(value)
  }); modal.value = ''
}
async function uploadAudio(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file || !audioDraft.value) return
  uploading.value = true
  try {
    const result = await uploadAPI.audio(file)
    audioDraft.value.url = result.path || result.url
  } finally { uploading.value = false; input.value = '' }
}
function moveAudio(id: string, startMs: number, duration: number) {
  edit(t => { const a = t.audio.find(a => a.id === id); if (a) { a.startMs = startMs; a.durationMs = duration } })
}
async function startVideo() {
  const choice = modelChoice('video')
  if (!choice) { toast.error('请先选择视频模型'); return }
  if (incompleteVideoPanels.value.length) {
    toast.error(`请先完成 ${incompleteVideoPanels.value.length} 个镜头的全部分镜画面`)
    return
  }
  if (!videoReferenceState.value.ready) { toast.error(videoReferenceState.value.error); return }
  if (!await continuityPanel.value?.confirmGeneration(videoPanelIds.value)) return
  await generate('video', { configId: choice.configId, model: choice.model,
    panelIds: videoPanelIds.value.length ? videoPanelIds.value : undefined,
    generationMode: videoGenerationMode.value,
    generationScope: videoGenerationScope.value,
    videoReferenceInputStrategy: videoReferenceInputStrategy.value, videoContinuityMode: videoContinuityMode.value })
  modal.value = ''; inspector.value = 'tasks'
}
function downloadDraft() {
  const blob = new Blob([JSON.stringify(version.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = url; a.download = `previs-ep${episodeNumber}-v${version.value?.versionNo}.json`; a.click()
  URL.revokeObjectURL(url)
}
async function refreshWorkbench() {
  await run(async () => {
    const latestDrama = await previsRequest(`/dramas/${dramaId}`)
    drama.value = latestDrama
    episode.value = latestDrama.episodes?.find((item: any) =>
      (item.episode_number || item.episodeNumber) === episodeNumber)
    if (version.value) await open(version.value.id)
    if (episode.value) storyboards.value = await previsRequest(`/episodes/${episode.value.id}/storyboards`)
    configs.value = await previsRequest('/ai-configs')
    toast.success('镜头看板已刷新')
  })
}
function valueOf(event: Event) { return (event.target as HTMLInputElement).value }
watch(modal, async value => {
  if (value) { player.value?.stop(); await nextTick(); if (!dialog.value?.open) dialog.value?.showModal() }
  else dialog.value?.close()
})
function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || document.querySelector('dialog[open]') || modal.value || /INPUT|TEXTAREA|SELECT|BUTTON/.test((event.target as HTMLElement).tagName)) return
  if (event.code === 'Space') { event.preventDefault(); player.value?.toggle() }
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const index = segments.value.findIndex(s => s.panel.id === panel.value?.id)
    const next = segments.value[index + (event.key === 'ArrowRight' ? 1 : -1)]
    if (next) select(next.groupId, next.panel.id)
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey) }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(async () => await save())
onMounted(async () => {
  window.addEventListener('keydown', onKey); window.addEventListener('beforeunload', beforeUnload)
  try {
    const cap = await previsRequest('/previs/capabilities')
    enabled.value = cap.enabled; capabilities.value = cap.video
    drama.value = await previsRequest(`/dramas/${dramaId}`)
    episode.value = drama.value.episodes?.find((e: any) => (e.episode_number || e.episodeNumber) === episodeNumber)
    if (!episode.value) throw new Error('未找到当前剧集')
    await initialize(episode.value.id)
    storyboards.value = await previsRequest(`/episodes/${episode.value.id}/storyboards`)
    configs.value = await previsRequest('/ai-configs')
    const storedModel = (key: string) => {
      try { return localStorage.getItem(key) || '' } catch { return '' }
    }
    const chooseModel = (type: string, stored: string, configId?: number) => {
      const options = modelOptions(type)
      return options.find(option => option.key === stored)?.key
        || options.find(option => option.configId === configId)?.key
        || options[0]?.key
        || ''
    }
    textModel.value = chooseModel('text', storedModel('huobao:model:chat'))
    imageModel.value = chooseModel('image', storedModel('huobao:model:image'), episode.value.image_config_id || episode.value.imageConfigId)
    videoModel.value = chooseModel('video', storedModel('huobao:model:video'), episode.value.video_config_id || episode.value.videoConfigId)
    episodeResolution.value = episode.value.resolution || '480p'
  } catch (e: any) { error.value = e.message }
  finally { loading.value = false }
})
onUnmounted(() => { ++framePlanTaskToken; clearInterval(framePlanTaskTimer); window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <div class="pv-app">
    <header class="studio-topbar">
      <div class="studio-topbar-main">
        <button class="back-btn topbar-back" @click="navigateTo(`/drama/${dramaId}`)">
          <ArrowLeft :size="15" />
          {{ t('episode.topbar.back') }}
        </button>
        <div class="studio-identity">
          <h1 class="studio-title">{{ drama?.title || '动态故事版' }}</h1>
          <span class="studio-episode-chip">{{ t('episode.topbar.episodeN', { n: episodeNumber }) }}</span>
          <div class="studio-meta-row">
            <span class="studio-meta-pill">镜头看板 · 关键帧预演</span>
            <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/2</span>
            <span class="studio-meta-inline">{{ t('episode.topbar.meta', { roles: characterCount, shots: groups.length }) }}</span>
          </div>
        </div>
      </div>

      <div class="studio-topbar-side">
        <div class="studio-model-picks">
          <ModelSelect
            v-if="modelOptions('text').length"
            v-model="textModel"
            :label="t('common.serviceType.text')"
            :options="modelOptions('text')"
            :default-label="modelOptions('text')[0]?.model"
            :show-config="hasMultipleConfigs('text')"
          />
          <ModelSelect
            v-if="modelOptions('image').length"
            v-model="imageModel"
            :label="t('common.serviceType.image')"
            :options="modelOptions('image')"
            :default-label="modelOptions('image')[0]?.model"
            :show-config="hasMultipleConfigs('image')"
          />
          <ModelSelect
            v-if="modelOptions('video').length"
            v-model="videoModel"
            :label="t('common.serviceType.video')"
            :options="modelOptions('video')"
            :default-label="modelOptions('video')[0]?.model"
            :show-config="hasMultipleConfigs('video')"
          />
          <ModelSelect
            v-model="episodeResolution"
            :label="t('episode.topbar.resolution')"
            :options="resolutionOptions"
            hide-default
          />
        </div>
        <div class="studio-actions">
          <LocaleSwitcher />
          <ThemeToggle />
          <button class="btn" :disabled="working" @click="refreshWorkbench">
            <RefreshCw :size="12" :class="{ 'pv-spin': working }" />
            {{ t('common.refresh') }}
          </button>
          <button class="btn task-drawer-trigger" @click="inspector = 'tasks'">
            <ListTodo :size="12" />
            {{ t('episode.topbar.tasks') }}
            <span v-if="activeTasks" class="task-drawer-badge">{{ activeTasks }}</span>
          </button>
          <ContinuityReviewPanel ref="continuityPanel" :version="version" :timeline="timeline" :panel-ids="allIssues ? undefined : panels.map(p => p.id)" :text-model="modelChoice('text')" :save="save" :dirty="dirty" />
        </div>
      </div>
    </header>

    <div class="studio-body">
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <nav class="pipeline">
          <div
            v-for="section in sidebarSections"
            :key="section.id"
            :class="['pipe-section', 'is-' + sectionState(section.id)]"
          >
            <div class="pipe-section-label">
              <span v-if="sectionState(section.id) !== 'none'" class="pipe-section-state">
                <Check v-if="sectionState(section.id) === 'done'" :size="10" :stroke-width="2.5" />
                <span v-else-if="sectionState(section.id) === 'active'" class="pipe-section-pulse" />
                <span v-else class="pipe-section-dot" />
              </span>
              <span>{{ section.label }}</span>
              <span v-if="sectionState(section.id) === 'active'" class="pipe-section-tag">{{ t('episode.sidebar.inProgress') }}</span>
            </div>
            <button
              v-for="item in section.items"
              :key="item.key"
              :class="['pipe-item pipe-item-sub', {
                active: item.key === 'prod:videos',
                done: sectionState(section.id) === 'done',
                doing: sectionState(section.id) === 'active',
              }]"
              :title="sidebarCollapsed ? item.label : undefined"
              @click="goSubStep(item.key)"
            >
              <span class="pipe-icon" :class="sectionState(section.id) === 'done' ? 'icon-done' : item.key === 'prod:videos' ? 'icon-active' : ''">
                <template v-if="sidebarCollapsed">
                  <component :is="item.icon" :size="12" />
                  <span v-if="sectionState(section.id) === 'active'" class="pipe-mini-pulse" />
                </template>
                <Check v-else-if="sectionState(section.id) === 'done'" :size="10" :stroke-width="2.5" />
                <span v-else-if="sectionState(section.id) === 'active'" class="pipe-item-pulse" />
                <component :is="item.icon" v-else :size="11" />
              </span>
              <span class="pipe-copy"><span class="pipe-label">{{ item.label }}</span></span>
            </button>
          </div>
        </nav>

        <div class="sidebar-bottom">
          <button
            type="button"
            class="sidebar-toggle"
            :title="t(sidebarCollapsed ? 'episode.sidebar.expand' : 'episode.sidebar.collapse')"
            @click="toggleSidebar"
          >
            <ArrowLeft class="sidebar-toggle-icon" :size="12" />
            <span v-if="!sidebarCollapsed">{{ t('episode.sidebar.collapse') }}</span>
          </button>
          <div class="sidebar-progress">
            <div class="sidebar-progress-head">
              <span class="sidebar-progress-title">{{ currentStageLabel }}</span>
              <span class="sidebar-progress-count">{{ currentMainIdx + 1 }}/{{ mainProgressSteps.length }}</span>
            </div>
            <div class="sidebar-progress-track">
              <button
                v-for="(step, index) in mainProgressSteps"
                :key="step.id"
                type="button"
                :class="['sidebar-progress-seg', { done: index < currentMainIdx || mainStageDone(step.id), current: index === currentMainIdx }]"
                :title="step.label"
                @click="goMainStage(step.id)"
              ><span class="sidebar-progress-seg-fill" /></button>
            </div>
            <div class="sidebar-progress-labels">
              <span
                v-for="(step, index) in mainProgressSteps"
                :key="step.id"
                :class="{ on: index === currentMainIdx, done: index < currentMainIdx || mainStageDone(step.id) }"
              >{{ step.label }}</span>
            </div>
          </div>
          <button class="refresh-btn" :disabled="working" @click="refreshWorkbench">
            <RefreshCw :size="12" :class="{ 'pv-spin': working }" />
            {{ t('episode.sidebar.refreshData') }}
          </button>
        </div>
      </aside>

      <main class="main pv-main">
        <header class="pv-board-toolbar">
          <div class="pv-board-heading">
            <Clapperboard :size="17" />
            <div>
              <h2>镜头看板</h2>
              <p>{{ groups.length }} 个镜头 · {{ frameCount }} 张画面 · {{ (total / 1000).toFixed(1) }} 秒</p>
            </div>
          </div>
          <div class="pv-header-actions">
            <button
              class="btn btn-sm"
              title="返回原始视频制作页面"
              @click="navigateTo({ path: episodePath, query: { stage: 'videos' } })"
            >
              <ArrowLeft :size="14" />视频制作
            </button>
            <template v-if="version">
              <button :disabled="!editable || !undoStack.length" title="撤销 ⌘Z" aria-label="撤销" @click="history()"><Undo2 :size="16" /></button>
              <button :disabled="!editable || !redoStack.length" title="重做 ⇧⌘Z" aria-label="重做" @click="history(true)"><Redo2 :size="16" /></button>
              <button :disabled="working || !dirty" @click="save"><Loader2 v-if="working" :size="14" class="pv-spin" /><Save v-else :size="14" />{{ dirty ? '保存' : '已保存' }}</button>
              <button class="pv-check-button" :disabled="!editable" @click="run(() => check())"><ShieldCheck :size="15" />运行检查 <span>{{ fails.length }}</span></button>
              <button
                class="pv-split-button"
                :disabled="!editable || framePlanSubmitting || !emptyFramePanels.length"
                :title="emptyFramePanels.length ? `为 ${emptyFramePanels.length} 个还没有画面的镜头拆分分镜画面` : '所有镜头都已有分镜画面'"
                @click="run(splitEmptyPanels)"
              >
                <Loader2 v-if="framePlanSubmitting" :size="15" class="pv-spin" /><Scissors v-else :size="15" />
                <template v-if="framePlanActive">拆分中 {{ framePlanActive }}</template>
                <template v-else>拆分空镜头画面 <span v-if="emptyFramePanels.length">{{ emptyFramePanels.length }}</span></template>
              </button>
            </template>
          </div>
        </header>
    <div v-if="loading" class="pv-empty"><Loader2 class="pv-spin" :size="30" /><h2>正在加载故事版…</h2></div>
    <div v-else-if="error || !enabled" class="pv-empty"><Clapperboard :size="40" /><h2>{{ error || '动态故事版功能暂未启用' }}</h2><button @click="navigateTo(episodePath)">返回剧集工作台</button></div>
    <div v-else-if="!version" class="pv-empty"><div class="pv-empty-icon"><Layers :size="42" :stroke-width="1.5" /></div><h2>先看见故事，再生成视频</h2><p>从当前分镜生成画面，检查相邻镜头衔接并播放整集预演。</p><button class="btn btn-primary" :disabled="working" @click="run(() => create())"><Plus :size="16" />从分镜创建故事版</button><small>请先在视频制作中完成分镜拆分</small></div>
    <template v-else-if="timeline">
      <div v-if="saveError || pollError || version.busy || version.status === 'locked'" class="pv-banner" :class="{ 'is-error': saveError }">
        <Lock v-if="version.status === 'locked'" :size="13" /><Loader2 v-else-if="version.busy" :size="13" class="pv-spin" />
        {{ saveError ? `尚未保存：${saveError}` : pollError || (version.busy ? '分镜画面正在生成，可继续编辑其他内容。' : `V${String(version.versionNo).padStart(2, '0')} 已锁定。`) }}
        <button v-if="saveError" @click="downloadDraft">下载本地草稿</button><button v-if="saveError" @click="modal = 'reload'">重新载入远端版本</button>
      </div>
      <section class="pv-workspace">
        <aside class="pv-navigator">
          <div class="pv-group-list" role="tablist" aria-label="镜头列表">
          <button
            v-for="(item, index) in groups"
            :key="item.id"
            role="tab"
            class="pv-group-card"
            :class="{ selected: group?.id === item.id }"
            :aria-selected="group?.id === item.id"
            @click="select(item.id)"
          >
            <span class="pv-group-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="pv-mini-still">
              <StoryboardContactSheet v-if="groupPanel(item.id)" :panel="groupPanel(item.id)!" :sheet="sheetForPanel(groupPanel(item.id)!)" compact />
              <Clapperboard v-else :size="20" :stroke-width="1" />
              <b>{{ (groupDuration(item.id) / 1000).toFixed(1) }}″</b>
            </span>
            <span class="pv-group-copy">
              <strong>{{ item.title || '未命名镜头' }}</strong>
              <small>{{ groupScene(item.id) }}</small>
              <span class="pv-status" :class="groupStatus(item.id)"><i />{{ groupStatus(item.id) === 'fail' ? '阻断' : groupStatus(item.id) === 'warning' ? '需确认' : '通过' }}</span>
            </span>
          </button>
          <div v-if="!groups.length" class="pv-small-empty">尚无分镜。返回视频制作拆分剧本，再同步分镜。</div>
          </div>
        </aside>
        <section class="pv-stage-column">
          <header class="pv-stage-toolbar"><div class="pv-stage-title"><span>{{ String(groups.findIndex(g => g.id === group?.id) + 1).padStart(2, '0') }}</span><div><p class="pv-eyebrow">镜头预览</p><b>{{ panel?.title || group?.title || '镜头预览' }}</b></div></div><div class="seg pv-tabs"><button v-for="view in previewViews" :key="view.key" class="seg-item" :class="{ on: stageView === view.key }" :aria-pressed="stageView === view.key" :title="view.key === 'video' && !hasVideoPreview ? '当前工作版暂无视频，将回退分镜预演' : view.label" @click="setStageView(view.key)">{{ view.label }}</button></div></header>
          <div class="pv-stage-scroll">
            <PrevisPlayer ref="player" :timeline="timeline" :current-ms="currentMs" :view="stageView" :video-sources="videoSources" :storyboard-is-video-input="true" @seek="seek" />
          </div>
        </section>
        <aside class="pv-inspector">
          <div class="seg pv-inspector-tabs"><button v-for="tab in ['frames', 'issues', 'properties']" :key="tab" class="seg-item" :class="{ on: inspector === tab }" :aria-pressed="inspector === tab" @click="inspector = tab">{{ { frames: '画面', issues: '连续性评测', properties: '属性' }[tab] }}</button></div>
          <div class="pv-inspector-scroll">
            <template v-if="inspector === 'frames' && panel">
              <StoryboardGridTools
                :key="`grid-${version.id}-${panel.id}`"
                :panel="panel" :version-id="version.id" :revision="version.revision"
                :config-id="modelChoice('image')?.configId" :model="modelChoice('image')?.model"
                :aspect-ratio="drama?.aspect_ratio || drama?.aspectRatio || '16:9'"
                :editable="editable && !framePlanSubmitting && !framePlanActive"
                :management-editable="generatable && !working"
                :splitting="framePlanSubmitting || framePlanActive > 0"
                :before-action="beforeGridAction" :commit-adoption="adoptGridCandidate" @busy="gridBusy = $event"
                @split="options => options?.force ? (modal = 'split') : run(splitPanel)"
                :connection="panelIncomingTransition(timeline, panel.id)?.continuity"
                @update:connection="value => edit(t => { const e = panelIncomingTransition(t, panel.id); if (e) e.continuity = value })"
                :reference-strategy="videoContinuityReadiness([panel], videoContinuityMode, videoContinuityCapability, videoReferenceInputStrategy, videoCapability?.maxImages || 9, version.contactSheets || []).actual === 'reference' ? videoReferenceInputStrategy : undefined"
                @update:reference-strategy="videoReferenceInputStrategy = $event"
              >
                <template #default="{ refineFrame, canRefineGrid, canRefineFrame }">
                  <StoryboardFramesEditor
                    integrated :can-refine-grid="canRefineGrid" :can-refine-frame="canRefineFrame"
                    @refine="refineFrame"
                    :key="`${version.id}-${panel.id}`"
                    :panel="panel"
                    :contact-sheet="sheetForPanel(panel)"
                    :video-input-ready="videoContinuityReadiness([panel], videoContinuityMode, videoContinuityCapability, videoReferenceInputStrategy, videoCapability?.maxImages || 9, version.contactSheets || []).ready"
                    :video-input-error="videoContinuityReadiness([panel], videoContinuityMode, videoContinuityCapability, videoReferenceInputStrategy, videoCapability?.maxImages || 9, version.contactSheets || []).error"
                    @retry-sheet="retryContactSheet(panel.id)"
                    :editable="editable && !gridBusy"
                    :generatable="generatable && !gridBusy"
                    :splitting="framePlanSubmitting || framePlanActive > 0"
                    :tasks="batches.filter(b => b.type === 'image').flatMap(b => b.items).filter(item => item.panelId === panel!.id)"
                    :video-generation-mode="videoGenerationMode"
                    :active-frame-id="activeFrameId"
                    title="分镜画面 · 视频输入"
                    show-video-action
                    @change="updateFrames"
                    @split="options => options?.force ? (modal = 'split') : run(splitPanel)"
                    @settings-open="player?.stop()"
                    @generate="(ids, force) => run(() => generateFrames([panel!.id], ids, force))"
                    @video="videoPanelIds = [panel!.id]; modal = 'video'"
                  />
                </template>
              </StoryboardGridTools>
              <p v-if="currentPanelVideo?.videoContinuity" class="pv-frame-note">当前视频：{{ currentPanelVideo.videoContinuity.actual === 'first_last' ? '首尾帧' : '画面参考' }}<template v-if="currentPanelVideo.stale"> · 输入已变化，请检查后重新生成</template><br v-if="currentPanelVideo.videoContinuity.fallbackReason">{{ currentPanelVideo.videoContinuity.fallbackReason }}</p>
            </template>
            <template v-else-if="inspector === 'issues'">
              <div class="pv-check-summary"><div class="pv-score" :class="{ pass: !fails.length }"><ShieldCheck :size="24" /><b>{{ fails.length ? `${fails.length} 项` : '通过' }}</b></div><div><strong>{{ fails.length ? '镜头衔接需处理' : warnings.length ? '还有提示需要确认' : '已满足锁定条件' }}</strong><p>{{ fails.length }} 项阻断 · {{ warnings.length }} 项待确认</p></div></div>
              <div class="pv-issue-filter"><button :class="{ active: allIssues }" @click="allIssues = true">全部 {{ issues.length }}</button><button :class="{ active: !allIssues }" @click="allIssues = false">当前镜头</button></div>
              <div class="pv-issue-stack"><article v-for="issue in visibleIssues" :key="issue.id" class="pv-issue" :class="[issue.severity, { acknowledged: issue.reason }]"><button class="pv-issue-heading" @click="locateIssue(issue)"><span class="pv-status" :class="issue.reason ? 'pass' : issue.severity"><i />{{ issue.reason ? '已确认' : issue.severity === 'fail' ? '阻断' : '提示' }}</span><strong>{{ ruleNames[issue.rule] || issue.rule }}</strong><ArrowRight :size="13" /></button><p>{{ issue.message }}</p><small v-if="issue.reason">确认原因：{{ issue.reason }}</small><div class="pv-issue-actions"><button v-if="issue.rule === 'missing_frame'" :disabled="!editable" @click="run(() => planAndGenerate([issue.panelId!]))">添加并生成画面</button><button v-if="issue.severity === 'warning' && !issue.reason" :disabled="!editable" @click="waive(issue)">确认并记录原因</button><button @click="locateIssue(issue); inspector = 'properties'">修改属性</button></div></article><div v-if="!visibleIssues.length" class="pv-small-empty"><Check :size="26" /><strong>没有待处理问题</strong><p>可以继续预览或锁定当前版本。</p></div></div>
              <div v-if="edge" class="pv-property-card"><p class="pv-eyebrow">当前连接 · 上一镜头 → 当前镜头</p><label>转场<select :value="edge.type" :disabled="!editable" @change="updateEdge('type', valueOf($event))"><option value="cut">直接切换</option><option value="match_cut">匹配切换</option><option value="occlusion">遮挡切换</option><option value="insert">插入镜头</option><option value="establishing">建立镜头</option><option value="audio_bridge">声音桥</option></select></label><label>连续性<select :value="edge.continuity" :disabled="!editable" @change="updateEdge('continuity', valueOf($event))"><option value="strong">强继承</option><option value="normal">常规继承</option><option value="scene_change">场景变化</option></select></label><label>允许变化的字段<input :value="edge.allowedChanges.join(',')" :disabled="!editable" placeholder="如 scene,lighting" @change="updateEdge('allowedChanges', valueOf($event).split(',').map(s => s.trim()).filter(Boolean))"></label></div>
            </template>
            <template v-else-if="inspector === 'properties' && group">
              <div class="pv-form">
                <template v-if="panel">
                  <p class="pv-eyebrow">镜头属性</p>
                  <label>标题<input :value="panel.title" :disabled="!editable" @change="updatePanel('title', valueOf($event))"></label>
                  <div class="pv-form-pair">
                    <label>时长 / 秒<input type="number" min=".1" step=".1" :value="panel.durationMs / 1000" :disabled="!editable" @change="setDuration(panel.id, Number(valueOf($event)) * 1000)"></label>
                    <label>景别<input :value="panel.shotType" :disabled="!editable" @change="updatePanel('shotType', valueOf($event))"></label>
                  </div>
                  <div class="pv-form-pair">
                    <label>机位<input :value="panel.angle" :disabled="!editable" @change="updatePanel('angle', valueOf($event))"></label>
                    <label>运镜<input :value="panel.movement" :disabled="!editable" @change="updatePanel('movement', valueOf($event))"></label>
                  </div>
                  <label>画面描述<textarea :value="panel.description" :disabled="!editable" rows="4" @change="updatePanel('description', valueOf($event))" /></label>
                  <label>氛围<textarea :value="panel.atmosphere" :disabled="!editable" rows="2" @change="updatePanel('atmosphere', valueOf($event))" /></label>
                  <label>视频提示词<textarea :value="panel.videoPrompt" :disabled="!editable" rows="3" @change="updatePanel('videoPrompt', valueOf($event))" /></label>
                </template>
                <p class="pv-eyebrow">音轨</p><button v-for="clip in timeline.audio.filter(c => c.panelId === panel?.id || !c.panelId)" :key="clip.id" class="pv-audio-list-item" @click="showAudio(clip.id)">{{ clip.text || '音频片段' }} <small>{{ formatTime(clip.startMs) }}</small></button><button :disabled="!editable" @click="showAudio()"><Plus :size="13" />添加对白 / 旁白 / 声音</button>
              </div>
            </template>
            <template v-else-if="inspector === 'tasks'">
              <div class="pv-task-intro"><div class="pv-task-heading"><p class="pv-eyebrow">V{{ String(version.versionNo).padStart(2, '0') }} / 生成记录</p><QueueSettingsButton label="任务设置" @click="taskQueueSettingsOpen = true" /></div><p>本版本执行 {{ taskExecuting }} · 排队 {{ taskQueued }}</p></div>
              <div class="pv-task-filters" role="group" aria-label="筛选制作任务状态"><button v-for="option in taskFilters" :key="option.key" type="button" :class="['is-' + option.key, { on: taskFilter === option.key }]" :aria-pressed="taskFilter === option.key" title="再次点击取消筛选" @click="taskFilter = taskFilter === option.key ? 'all' : option.key"><b>{{ option.count }}</b>{{ option.label }}</button></div>
              <p v-if="framePlanTaskError" class="pv-frame-error" role="alert">{{ framePlanTaskError }}<button type="button" @click="loadFramePlanTasks">重新加载</button></p>
              <article v-if="showPlanningTasks" class="pv-batch">
                <header><b>分镜画面拆分</b><span>执行 {{ framePlansSummary.processing }} · 排队 {{ framePlansSummary.pending }}</span></header>
                <div class="pv-batch-actions"><button v-if="framePlansSummary.completed" :disabled="working" @click="run(openFramePlans)">查看拆分方案</button><button v-if="framePlansSummary.failed" :disabled="working" @click="run(retryFailedFramePlans)">重试失败项</button></div>
                <details v-if="filteredFramePlanTasks.length"><summary>查看 {{ filteredFramePlanTasks.length }} 个任务</summary><div v-for="item in filteredFramePlanTasks" :key="item.id" class="pv-task-item"><b>{{ timeline.panels.find(panel => panel.id === item.panelId)?.title || `镜头 #${item.panelId}` }}</b><span class="pv-task-status" :class="'is-' + pvTaskStateClass(item.status)"><i :class="pvTaskStateClass(item.status) === 'done' ? 'ok' : pvTaskStateClass(item.status) === 'pending' ? 'pending' : ''" />{{ queueStatusLabel(item) }}</span><p v-if="item.queueReason" class="pv-frame-note">{{ item.queueReason }}</p><p v-if="item.error" class="pv-frame-error">{{ item.error }}</p><QueueJobActions :job="item" @changed="loadFramePlanTasks" /></div></details>
              </article>
              <article v-for="batch in filteredBatches" :key="batch.id" class="pv-batch">
                <header><b>{{ batch.type === 'image' ? '关键帧' : '视频' }} #{{ batch.id }}</b><span>{{ statusNames[batch.status] || batch.status }}</span></header>
                <progress :value="batch.items.filter(i => i.status === 'completed').length" :max="batch.items.length" /><small>{{ batch.items.filter(i => i.status === 'completed').length }} / {{ batch.items.length }} 已完成</small>
                <div class="pv-batch-actions"><button v-if="batch.items.some(i => i.status === 'failed' && !i.queueJobId)" :disabled="working || (batch.type === 'image' && !editable)" @click="run(() => batchAction(batch.id, 'retry'))">重试失败项</button><button v-if="batch.items.some(i => i.status === 'pending' && !i.queueJobId)" :disabled="working" @click="run(() => batchAction(batch.id, 'cancel'))">取消排队任务</button></div>
                <details><summary>查看 {{ batch.items.length }} 个任务</summary><div v-for="item in batch.items" :key="item.id" class="pv-task-item"><b>{{ timeline.panels.find(p => p.id === item.panelId)?.title || groups.find(g => g.id === item.groupId)?.title }} {{ item.frameType ? frameNames[item.frameType] : '' }}</b><span><span class="pv-task-status" :class="'is-' + pvTaskStateClass(item.status)"><i :class="pvTaskStateClass(item.status) === 'done' ? 'ok' : pvTaskStateClass(item.status) === 'pending' ? 'pending' : ''" />{{ queueStatusLabel(item) }}</span><small v-if="item.referenceInput"> · {{ item.referenceInput.effective === 'contact_sheet' ? '宫格参考' : '逐张参考' }}</small><small v-if="item.videoContinuity?.fallbackReason"> · {{ item.videoContinuity.fallbackReason }}</small><small v-if="item.actualStrategy"> · {{ constraintNames[item.actualStrategy] }}</small></span><p v-if="item.queueReason" class="pv-frame-note">{{ item.queueReason }}</p><p v-if="item.error" class="pv-frame-error">{{ item.error }}</p><QueueJobActions v-if="item.queueJobId" :job="item" @changed="run(refreshQueueTasks)" /><button v-else-if="item.status === 'failed'" :disabled="working || (batch.type === 'image' && !editable)" @click="run(() => batchAction(batch.id, 'retry', [item.id]))">重试此项</button><a v-if="item.status === 'completed' && (item.localPath || item.resultUrl)" :href="mediaUrl(item.localPath || item.resultUrl)" target="_blank" rel="noopener">查看生成结果 ↗</a></div></details>
              </article>
              <div v-if="!filteredBatches.length && !showPlanningTasks" class="pv-small-empty"><Film :size="27" /><p>{{ taskFilter === 'all' ? '还没有生成任务' : '没有符合条件的任务' }}</p><span>生成任务后，进度会显示在这里。</span></div>
            </template>
          </div>
        </aside>
      </section>
      <PrevisTimeline :timeline="timeline" :current-ms="currentMs" :group-id="group?.id || ''" :active-frame-id="activeFrameId" :video-preview="stageView === 'video'" :video-sources="videoSources" :editable="editable" @seek="player?.seek($event)" @select="select" @audio="showAudio" @duration="setDuration" @move-audio="moveAudio" />
    </template>
    <TaskQueueSettings :open="taskQueueSettingsOpen" @close="taskQueueSettingsOpen = false" />
    <dialog ref="dialog" class="pv-dialog" @close="modal = ''" @click="($event.target === dialog) && (modal = '')">
      <form v-if="modal" @submit.prevent>
        <header><h2>{{ ({ strategy: '模型设置', video: '生成正式视频', audio: '编辑音轨', waiver: '确认连续性提示', lock: '锁定故事版', sync: '同步最新分镜', reload: '重新载入版本', split: '重新拆分分镜画面' } as Record<string, string>)[modal] }}</h2><button aria-label="关闭对话框" @click="modal = ''"><X :size="18" /></button></header>
        <div v-if="modal === 'strategy'" class="pv-form">
          <label>图片模型<select v-model="imageModel"><option value="" disabled>选择图片模型</option><option v-for="o in modelOptions('image')" :key="o.key" :value="o.key">{{ o.label }}</option></select></label>
          <VideoContinuityControl v-model="videoContinuityMode" :capability="videoContinuityCapability" :actual="videoReferenceState.actual" :fallback-reason="videoReferenceState.fallbackReason" :error="videoContinuityError" :disabled="working" />
          <label v-if="videoReferenceState.actual !== 'first_last'">画面参考<select v-model="videoReferenceInputStrategy"><option value="auto">自动选择</option><option value="individual">逐张画面</option><option value="contact_sheet">宫格画面</option></select></label>
          <label>视频模型<select v-model="videoModel"><option value="" disabled>选择视频模型</option><option v-for="o in modelOptions('video')" :key="o.key" :value="o.key">{{ o.label }}</option></select></label>
          <NuxtLink v-if="!modelOptions('image').length || !modelOptions('video').length" to="/settings">前往设置启用生成模型 →</NuxtLink>
          <p v-if="videoCapability" class="pv-help">当前视频服务支持 {{ videoCapability.minSeconds }}–{{ videoCapability.maxSeconds }} 整数秒、每次生成最多 {{ videoCapability.maxImages }} 张参考图。{{ videoCapability.group ? '支持将所选分镜合为一组生成。' : '支持按分镜生成。' }}</p>
          <footer><button class="btn btn-primary" @click="modal = ''">完成</button></footer>
        </div>
        <div v-else-if="modal === 'audio' && audioDraft" class="pv-form"><div class="pv-form-pair"><label>类型<select v-model="audioDraft.type" :disabled="!editable"><option value="dialogue">对白</option><option value="narration">旁白</option><option value="sound">环境声 / 音乐</option></select></label><label>角色<input v-model="audioDraft.character" :disabled="!editable"></label></div><label>关联分镜<select v-model="audioDraft.panelId" :disabled="!editable"><option :value="null">跨镜头音轨</option><option v-for="p in timeline?.panels" :key="p.id" :value="p.id">{{ p.title }}</option></select></label><label>文本<textarea v-model="audioDraft.text" :disabled="!editable" rows="3" /></label><div class="pv-form-pair"><label>起点 / 秒<input type="number" min="0" step=".1" :value="audioDraft.startMs / 1000" :disabled="!editable" @change="audioDraft.startMs = Math.max(0, Math.round(Number(valueOf($event)) * 1000))"></label><label>时长 / 秒<input type="number" min=".1" step=".1" :value="audioDraft.durationMs / 1000" :disabled="!editable" @change="audioDraft.durationMs = Math.max(100, Math.round(Number(valueOf($event)) * 1000))"></label></div><label>音频地址<input v-model="audioDraft.url" :disabled="!editable" placeholder="上传音频或填写 https:// 地址"></label><label class="pv-upload" :class="{ disabled: !editable || uploading }"><Upload :size="14" />{{ uploading ? '上传中…' : '上传配音 / 音效' }}<input type="file" accept="audio/*" :disabled="!editable || uploading" @change="run(() => uploadAudio($event))"></label><audio v-if="audioDraft.url" :src="mediaUrl(audioDraft.url)" controls /><p class="pv-help">未上传音频时，可在播放器开启浏览器临时配音。对白超出所属分镜会阻止锁定。</p><footer><button class="btn btn-danger" :disabled="!editable" @click="saveAudio(true)">删除片段</button><button class="btn btn-primary" :disabled="!editable || uploading" @click="saveAudio()">保存音轨</button></footer></div>
        <div v-else-if="modal === 'waiver'" class="pv-form"><p>{{ waiverIssue?.message }}</p><label>确认原因<textarea v-model="waiverReason" rows="4" maxlength="2000" placeholder="说明这是有意的叙事变化，或已人工确认…" autofocus /></label><footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="!waiverReason.trim() || !editable" @click="applyWaiver">记录并确认</button></footer></div>
        <div v-else-if="modal === 'video'" class="pv-form">
          <p>将使用当前工作版 V{{ version?.versionNo }} 生成{{ videoPanelIds.length ? '当前镜头' : '全部镜头' }}。</p>
          <label>生成范围<select v-model="videoGenerationScope"><option value="storyboard">按分镜</option><option value="group">所选分镜合为一组</option></select></label>
          <p class="pv-help">{{ videoGenerationScope === 'group' ? `所选 ${videoTargetPanels.length} 个分镜按时间线顺序合为一个视频，整组 ${videoTargetDuration} 秒，计为一次生成任务。` : `${videoTargetPanels.length} 个分镜各生成一个视频，共 ${videoTargetPanels.length} 次生成任务；总时长 ${videoTargetDuration} 秒。` }}</p>
          <VideoContinuityControl v-model="videoContinuityMode" :capability="videoContinuityCapability" :actual="videoReferenceState.actual" :fallback-reason="videoReferenceState.fallbackReason" :error="videoContinuityError" :disabled="working" />
          <label v-if="videoReferenceState.actual !== 'first_last'">画面参考<select v-model="videoReferenceInputStrategy"><option value="auto">自动选择</option><option value="individual">逐张画面</option><option value="contact_sheet">宫格画面</option></select></label>
          <label>视频模型<select v-model="videoModel"><option value="" disabled>选择模型</option><option v-for="o in modelOptions('video')" :key="o.key" :value="o.key">{{ o.label }}</option></select></label>
          <p class="pv-help">{{ videoReferenceState.actual === 'first_last' ? '首尾画面固定边界，中间关键状态按规划提示推进。' : '全部分镜画面将按时间顺序作为视频参考。' }}</p>
          <p v-if="!videoReferenceState.ready" class="pv-frame-error">{{ videoReferenceState.error }}</p>
          <p v-if="incompleteVideoPanels.length" class="pv-frame-error">还有 {{ incompleteVideoPanels.length }} 个镜头存在未完成画面，请先生成或上传全部画面。</p>
          <footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="working || !videoModel || !videoReferenceState.ready" @click="run(startVideo)"><Film :size="14" />提交生成</button></footer>
        </div>
        <div v-else-if="modal === 'split'" class="pv-form"><p>重新拆分会按新方案重写「{{ panel?.title }}」的全部分镜画面，已生成的图片会保留在画面历史中。</p><footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="framePlanSubmitting || !editable" @click="run(async () => { modal = ''; await splitPanel(true) })">重新拆分</button></footer></div>
        <div v-else class="pv-form"><p>{{ ({ lock: '锁定后时间线和分镜画面不可修改；后续编辑需复制为新草稿。', sync: '读取视频制作中的最新分镜并建立新草稿，当前版本将保留。', reload: '载入远端最新版本。尚未保存的本地修改将被替换，建议先下载本地草稿。' } as Record<string, string>)[modal] }}</p><footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="working" @click="run(async () => { if (modal === 'lock') await check(true); else if (modal === 'sync') await create(); else if (modal === 'reload') { dirty = false; await open(version!.id) } modal = '' })">确认{{ modal === 'lock' ? '锁定' : modal === 'sync' ? '同步' : '' }}</button></footer></div>
      </form>
    </dialog>
      <FramePlanDialog
        v-if="framePlanOpen"
        :plans="framePlans"
        :count="framePlanCount"
        :editable="editable"
        :aspect-ratio="drama?.aspect_ratio || drama?.aspectRatio || '16:9'"
        @close="framePlanOpen = false"
        @apply="applyFramePlan"
        @recount="run(recountFramePlan)"
      />
      </main>
    </div>
  </div>
</template>
