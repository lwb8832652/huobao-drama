<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Check, Grid2X2, Loader2, RefreshCw, Scissors, Settings2, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-vue-next'
import { isStaleChunkError, reloadStaleBundle, uploadAPI } from '~/composables/useApi'
import GridReferenceAssets from './GridReferenceAssets.vue'
import { mapError } from '~/composables/useToast'
import { i18n } from '~/composables/i18n'
import { FRAME_COUNT_MAX, frameKey, gridLayoutForCount, mediaUrl, orderedFrames, previsRequest,
  type AnimaticVersion, type GridCandidate, type GridCapabilities, type GridMode, type Panel, type GridReferenceManifest } from '~/composables/usePrevis'

const props = defineProps<{
  panel: Panel
  versionId: number
  revision: number
  configId?: number
  model?: string
  aspectRatio?: string
  editable: boolean
  managementEditable?: boolean
  /** 拆分任务提交中或排队中：与「分镜画面」的其他生成入口一致，按钮转圈并禁用。 */
  splitting?: boolean
  /** 视频输入的参考策略（逐张画面 / 整组宫格），在生成设置弹窗中调整。 */
  referenceStrategy?: string
  connection?: 'normal' | 'strong' | 'scene_change'
  beforeAction: () => Promise<{ versionId: number; revision: number } | false>
  commitAdoption: (versionId: number, candidateId: number, revision: number) => Promise<AnimaticVersion | false>
}>()
const emit = defineEmits<{ adopted: [version: AnimaticVersion]; busy: [value: boolean]; split: [options?: { force?: boolean }]; 'update:referenceStrategy': [value: string]; 'update:connection': [value: 'normal' | 'strong' | 'scene_change'] }>()
const referenceManifest = ref<GridReferenceManifest>(), referenceLoading = ref(false), referenceError = ref('')
let referenceToken = 0
async function refreshReferences() {
  const current = ++referenceToken, versionId = props.versionId, panelId = props.panel.id
  referenceLoading.value = true; referenceError.value = ''
  try {
    const manifest = await previsRequest<GridReferenceManifest>(`/animatic-versions/${versionId}/grid-references?panel_id=${panelId}`)
    if (!disposed && current === referenceToken && props.versionId === versionId && props.panel.id === panelId) referenceManifest.value = manifest
    return current === referenceToken && !disposed ? manifest : undefined
  } catch (cause: any) {
    if (current === referenceToken && !disposed) { referenceManifest.value = undefined; referenceError.value = mapError(cause) }
    return undefined
  } finally { if (current === referenceToken) referenceLoading.value = false }
}
const frozenManifest = computed<GridReferenceManifest | undefined>(() => review.value?.referenceAssets ? ({
  items: review.value.referenceAssets.map(item => ({ ...item, url: item.url })), ready: true, error: '',
  continuity: review.value.continuity, continuityStale: review.value.continuityStale, continuityStaleReason: review.value.continuityStaleReason,
}) : undefined)
const capabilities = ref<GridCapabilities>()
const candidates = ref<GridCandidate[]>([])
const error = ref(''), submitting = ref(false), loading = ref(false)
/** 分辨率默认值：优先 1K；当前模型不支持时回退到其首个可用档位。 */
const DEFAULT_RESOLUTION = '1K'
/** 存储键带版本后缀：默认值调整后旧偏好一次性失效，确保新默认真正生效。 */
const RESOLUTION_STORAGE_KEY = 'previs.grid-resolution.v2'
const resolution = ref(DEFAULT_RESOLUTION)
const modal = ref<'review' | 'edit' | 'settings' | ''>('')
const settingsTab = ref<'settings' | 'history'>('settings'), historyRefreshing = ref(false)
const review = ref<GridCandidate>()
/** 分镜画面预览：当前放大查看的画面格（frameId）；undefined 时取第一格 */
const previewFrameId = ref<string>()
const editMode = ref<GridMode>('grid_edit'), baseCandidate = ref<GridCandidate>()
const selectedFrameIds = ref<string[]>([]), instruction = ref(''), instructions = ref<Record<string, string>>({})
const dialog = ref<HTMLDialogElement>(), fileInput = ref<HTMLInputElement>()
const titleId = useId()
const frames = computed(() => orderedFrames(props.panel))
const pending = computed(() => candidates.value.some(candidate => ['pending', 'processing'].includes(candidate.status)))
const paidBusy = computed(() => submitting.value || pending.value)
const canManage = computed(() => props.managementEditable ?? props.editable)
const validFrameCount = computed(() => frames.value.length > 0 && frames.value.length <= FRAME_COUNT_MAX)
const projectRatio = computed(() => props.aspectRatio || '16:9')
const supportedResolutions = computed(() => [...new Set((capabilities.value?.sizes || [])
  .filter(size => size.aspectRatio === projectRatio.value).map(size => size.resolution))])
const selectedSize = computed(() => capabilities.value?.sizes?.find(size => size.aspectRatio === projectRatio.value && size.resolution === resolution.value))
const gridLayout = computed(() => gridLayoutForCount(frames.value.length, projectRatio.value))
const predictedCell = computed(() => selectedSize.value && ({ width: Math.floor(selectedSize.value.width / gridLayout.value.columns), height: Math.floor(selectedSize.value.height / gridLayout.value.rows) }))
const canSubmit = computed(() => props.editable && validFrameCount.value && !!capabilities.value?.enabled && !!selectedSize.value && !paidBusy.value)
const canGenerate = computed(() => !!referenceManifest.value?.ready && !referenceLoading.value && canSubmit.value && frames.value.every(frame => !frame.locked))
const canGridEdit = computed(() => canSubmit.value && !!capabilities.value?.supportsEdit && frames.value.every(frame => frame.url) && frames.value.some(frame => !frame.locked))
const canFrameEdit = computed(() => canSubmit.value && !!capabilities.value?.supportsEdit && frames.value.some(frame => frame.url && !frame.locked))
/** 重新拆分分镜画面：与生成/微调解耦，只要求版本可编辑且已有画面。 */
const canResplit = computed(() => props.editable && !props.splitting && validFrameCount.value)
const editFrames = computed(() => baseCandidate.value
  ? [...baseCandidate.value.grid.cells].sort((a, b) => a.index - b.index)
    .map(cell => frames.value.find(frame => frameKey(frame) === cell.frameId)).filter((frame): frame is NonNullable<typeof frame> => !!frame)
  : frames.value)
const currentGridSlots = computed(() => Array.from({ length: gridLayout.value.columns * gridLayout.value.rows }, (_, index) => ({ index, frame: frames.value[index] })))
const currentGridStyle = computed(() => ({ gridTemplateColumns: `repeat(${gridLayout.value.columns}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${gridLayout.value.rows}, minmax(0, 1fr))`, aspectRatio: projectRatio.value.replace(':', ' / ') }))
function editFrameNumber(frame: Panel['frames'][number]) {
  return (baseCandidate.value?.grid.cells.find(cell => cell.frameId === frameKey(frame))?.index ?? frames.value.findIndex(item => frameKey(item) === frameKey(frame))) + 1
}
const selectedFrames = computed(() => editFrames.value.filter(frame => selectedFrameIds.value.includes(frameKey(frame))))
const editValid = computed(() => selectedFrameIds.value.length > 0 && selectedFrames.value.length === selectedFrameIds.value.length
  && selectedFrames.value.every(frame => !frame.locked)
  && (editMode.value !== 'grid_edit' || !!baseCandidate.value || frames.value.every(frame => frame.url))
  && (editMode.value !== 'frame_edit' || (selectedFrameIds.value.length === 1 && !!selectedFrames.value[0]?.url))
  && selectedFrameIds.value.every(id => instruction.value.trim() || instructions.value[id]?.trim()))
const visibleCandidates = computed(() => candidates.value.filter(candidate => candidate.status !== 'discarded'))
const activeCandidates = computed(() => visibleCandidates.value.filter(candidate => candidate.status !== 'adopted'
  // 整组生成完成即自动采用，ready 只是瞬时状态；仅当自动采用失败（带上错误）才需要人工介入
  && !(candidate.mode === 'generate' && candidate.status === 'ready' && !candidate.error)))
/**
 * 生成记录按「版本」分组（新版本在上）：一版 = 一次整组生成/上传替换及其后续微调，
 * 同版本内候选画面结构相同、可自由切换采用；跨版本采用也可，只要画面规划结构未变。
 */
const candidateBatches = computed(() => {
  const groups = new Map<number, GridCandidate[]>()
  for (const candidate of [...visibleCandidates.value].sort((a, b) => b.id - a.id))
    groups.set(candidate.batchNo, [...(groups.get(candidate.batchNo) || []), candidate])
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([batchNo, items]) => ({ batchNo, items }))
})
/** 版本号标签（batch_no 的展示）：V1/V2/… = 第几次整组生成；0 = 版本概念上线前的历史候选 */
const versionLabel = (batchNo: number) => batchNo > 0 ? `V${batchNo}` : '历史生成'
/**
 * 上游偶发忽略请求尺寸、把画布改成别的比例（实测 gpt-image-2 中转把 16:9 返成 3:2）。
 * 这种输出服务端已中心裁切适配到冻结布局的比例再切格；这里把上游原尺寸标出来便于事后核对。
 */
function cropNote(candidate: GridCandidate) {
  return candidate.sourceWidth && candidate.sourceHeight
    ? `已裁切适配（上游 ${candidate.sourceWidth}×${candidate.sourceHeight} ≠ ${projectRatio.value}）`
    : ''
}
/** 分镜画面预览的格列表：frame_edit 为单格（整图即该画面），其余按宫格 index 排序 */
const reviewThumbs = computed(() => {
  if (!review.value) return []
  if (review.value.mode === 'frame_edit') {
    const cell = review.value.grid.cells.find(cell => review.value!.targetFrameIds.includes(cell.frameId)) || review.value.grid.cells[0]
    // 单格精修保留该格在原宫格中的编号，便于对照
    return cell ? [{ frameId: cell.frameId, number: cell.index + 1 }] : []
  }
  return [...review.value.grid.cells].sort((a, b) => a.index - b.index)
    .map(cell => ({ frameId: cell.frameId, number: cell.index + 1 }))
})
/** 预览大图选中的格；未选中时回退到第一格 */
const activePreviewThumb = computed(() => reviewThumbs.value.find(thumb => thumb.frameId === previewFrameId.value) || reviewThumbs.value[0])
function previewCellStyle(candidate: GridCandidate, frameId: string) {
  if (candidate.mode === 'frame_edit') {
    return { backgroundImage: `url("${mediaUrl(candidate.previewUrl || '')}")`, backgroundSize: 'cover',
      backgroundPosition: 'center', aspectRatio: `${candidate.width || 1} / ${candidate.height || 1}` }
  }
  return candidateCropStyle(candidate, frameId)
}
/** 放大格对应的画面标题（若该格映射到当前画面） */
const activePreviewFrame = computed(() => activePreviewThumb.value && frames.value.find(frame => frameKey(frame) === activePreviewThumb.value!.frameId))
let token = 0, candidateReadEpoch = 0, mounted = false, disposed = false
let polling: ReturnType<typeof setTimeout> | undefined
let previousFocus: HTMLElement | null = null
const discardedIds = new Set<number>()
/** 候选上一次可见的状态，用于识别「整组生成 → 服务端自动采用」的完成时刻 */
const candidateStatuses = new Map<number, string>()
let contextKey = ''
const currentContextKey = () => `${props.versionId}:${props.panel.id}:${props.configId || ''}:${props.model || ''}:${props.aspectRatio || ''}`
const path = () => `/animatic-versions/${props.versionId}/grid-candidates`
const active = (requestToken: number, versionId: number, panelId: number) => !disposed && requestToken === token && props.versionId === versionId && props.panel.id === panelId
/** mapError 认不出时的兜底文案；用于区分「有分类的友好文案」与「语境化兜底」。 */
const UNKNOWN_ERROR_TEXT = i18n.global.t('errors.unknown')
/**
 * 内联错误的唯一出口：统一走 mapError，把网络层失败显示成「无法连接服务器…」这类可读文案，
 * 而不是把浏览器裸的英文 `Failed to fetch` 直接印在界面上（那是排障信息，不该给用户看）。
 * 原始错误连端点一起进 DevTools——并发打多个接口时，要能一眼看出是哪一条挂了。
 *
 * 陈旧 bundle（部署后停留在旧页面）是特例：动态 import 的 chunk 已被新构建删除，重试接口、
 * 刷新数据都没有意义，直接整页重载自愈；冷却期内仍失败才展示文案，且不拼端点——
 * 失败与具体接口无关，拼上只会把排障方向带偏。
 */
function failure(cause: unknown, fallback: string, endpoint = '') {
  if (isStaleChunkError(cause)) {
    console.error(`[grid] 检测到已失效的前端资源${endpoint ? `（操作 ${endpoint.split('?')[0]}）` : ''}`, cause)
    if (reloadStaleBundle()) return
    error.value = mapError(cause)
    return
  }
  const friendly = mapError(cause)
  // 端点拼进可见文案（去掉 query 只留路径）。网络层失败本身不带任何定位信息，排障时
  // 最要紧的是知道「哪一条接口挂了」——此前只能开 DevTools 看 console，门槛太高。
  // 其余对 error.value 的赋值都是整串替换，因此不会残留上一个端点的后缀。
  const where = endpoint ? `（${endpoint.split('?')[0]}）` : ''
  error.value = (friendly === UNKNOWN_ERROR_TEXT ? fallback : friendly) + where
  console.error(`[grid] ${fallback}${endpoint ? ` ← ${endpoint}` : ''}`, cause)
}
function stopPolling() { clearTimeout(polling); polling = undefined }
function schedulePolling(requestToken: number, versionId: number, panelId: number) {
  if (!active(requestToken, versionId, panelId)) return
  stopPolling()
  if (!pending.value) return
  polling = setTimeout(() => { void refreshCandidates(requestToken, versionId, panelId) }, 1200)
}
async function refreshCandidates(requestToken = token, versionId = props.versionId, panelId = props.panel.id) {
  const readEpoch = candidateReadEpoch
  try {
    const result = await previsRequest<{ items: GridCandidate[] }>(`/animatic-versions/${versionId}/grid-candidates?panel_id=${panelId}`)
    if (!active(requestToken, versionId, panelId) || readEpoch !== candidateReadEpoch) return
    candidates.value = result.items.filter(candidate => !discardedIds.has(candidate.id))
    for (const candidate of candidates.value) {
      const previous = candidateStatuses.get(candidate.id)
      candidateStatuses.set(candidate.id, candidate.status)
      // 整组生成无需审核：服务端完成后自动切分写入画面，这里只提示结果
      if (candidate.mode === 'generate' && previous && ['pending', 'processing'].includes(previous)
        && candidate.status === 'adopted') toast.success('宫格已生成，画面已自动拆分')
    }
    if (review.value) review.value = result.items.find(candidate => candidate.id === review.value!.id) || review.value
  } catch (cause) {
    if (active(requestToken, versionId, panelId) && readEpoch === candidateReadEpoch) failure(cause, '候选图进度读取失败，可点击刷新重试')
  } finally { schedulePolling(requestToken, versionId, panelId) }
}
async function refreshSettingsHistory() {
  if (historyRefreshing.value || loading.value || submitting.value) return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  historyRefreshing.value = true; error.value = ''
  try { await refreshCandidates(requestToken, versionId, panelId) }
  finally { if (active(requestToken, versionId, panelId)) historyRefreshing.value = false }
}
async function loadContext() {
  const nextContextKey = currentContextKey()
  if (submitting.value && contextKey === nextContextKey) return
  contextKey = nextContextKey
  stopPolling()
  const requestToken = ++token, versionId = props.versionId, panelId = props.panel.id
  referenceManifest.value = undefined
  const referenceRequest = refreshReferences()
  discardedIds.clear()
  candidates.value = []; capabilities.value = undefined; error.value = ''; loading.value = true
  submitting.value = false; historyRefreshing.value = false; closeModal()
  const query = new URLSearchParams()
  if (props.configId) query.set('config_id', String(props.configId))
  if (props.model) query.set('model', props.model)
  // 两条请求各自带上「人话 + 端点」：并发发出去，报错时要能指认是哪一条挂的
  const requests = [
    { path: `/previs/grid-capabilities?${query}`, fallback: '宫格能力读取失败' },
    { path: `/animatic-versions/${versionId}/grid-candidates?panel_id=${panelId}`, fallback: '候选图读取失败' },
  ]
  const results = await Promise.allSettled([
    previsRequest<GridCapabilities>(requests[0].path),
    previsRequest<{ items: GridCandidate[] }>(requests[1].path),
  ])
  if (!active(requestToken, versionId, panelId)) return
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') { failure(result.reason, requests[index].fallback, requests[index].path); continue }
    if (index === 0) {
      capabilities.value = result.value as GridCapabilities
      const supported = supportedResolutions.value
      if (!supported.includes(resolution.value)) resolution.value = supported.includes(DEFAULT_RESOLUTION) ? DEFAULT_RESOLUTION : (supported[0] || DEFAULT_RESOLUTION)
    } else candidates.value = (result.value as { items: GridCandidate[] }).items
  }
  // 初次载入的状态是基线，不触发完成提示
  for (const candidate of candidates.value) candidateStatuses.set(candidate.id, candidate.status)
  await referenceRequest
  if (!active(requestToken, versionId, panelId)) return
  loading.value = false
  schedulePolling(requestToken, versionId, panelId)
}
async function savedContext(requestToken: number, versionId: number, panelId: number) {
  const saved = await props.beforeAction()
  if (!active(requestToken, versionId, panelId)) return false
  if (!saved) { error.value = '未能保存当前修改，请保存成功后重试'; return false }
  if (saved.versionId !== versionId) { error.value = '工作版已切换，请在当前工作版重试'; return false }
  return saved
}
function submissionAllowed(mode: GridMode, targetFrameIds: string[], chosenResolution: string, candidateBaseId?: number) {
  // The save may change workspace locks or model capabilities. Ignore only this submission's own busy flag.
  if (!props.editable || pending.value || !validFrameCount.value || !capabilities.value?.enabled
    || !capabilities.value.sizes.some(size => size.aspectRatio === projectRatio.value && size.resolution === chosenResolution)) return false
  if (mode === 'generate') return frames.value.every(frame => !frame.locked)
  const targets = targetFrameIds.map(id => frames.value.find(frame => frameKey(frame) === id))
  return !!capabilities.value.supportsEdit && targets.length > 0 && targets.every(frame => frame && !frame.locked)
    && (mode === 'grid_edit' ? !!candidateBaseId || frames.value.every(frame => frame.url)
      : targets.length === 1 && !!targets[0]?.url)
}
async function submitCandidate(mode: GridMode) {
  if (!(mode === 'generate' ? canGenerate.value : canSubmit.value) || (mode !== 'generate' && (!capabilities.value?.supportsEdit || !editValid.value))) return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  const chosenModel = { configId: props.configId, model: props.model, resolution: resolution.value }
  const targetFrameIds = [...selectedFrameIds.value]
  const edits = Object.fromEntries(targetFrameIds.map(id => [id, instructions.value[id] || '']))
  const edit = { targetFrameIds, instruction: instruction.value, instructions: edits,
    ...(baseCandidate.value && mode === 'grid_edit' ? { baseCandidateId: baseCandidate.value.id } : {}) }
  submitting.value = true; error.value = ''
  try {
    const saved = await savedContext(requestToken, versionId, panelId)
    if (!saved) return
    const manifest = await refreshReferences()
    if (!active(requestToken, versionId, panelId)) return
    if (!manifest || !manifest.ready && (mode === 'generate' || manifest.items.length > 0)) { error.value = manifest?.error || referenceError.value || '参考素材读取失败，请重试'; return }
    if (!submissionAllowed(mode, targetFrameIds, chosenModel.resolution, edit.baseCandidateId)) {
      error.value = '画面或模型状态已变化，未提交；请检查原图、锁定和生成设置后重试'
      return
    }
    const result = await previsRequest<{ items: GridCandidate[] }>(`/animatic-versions/${versionId}/grid-candidates`, 'POST',
      { revision: saved.revision, panelIds: [panelId], mode, ...chosenModel, ...(mode === 'generate' ? {} : edit) })
    if (!active(requestToken, versionId, panelId)) return
    for (const candidate of result.items) {
      candidates.value = [candidate, ...candidates.value.filter(item => item.id !== candidate.id)]
      candidateStatuses.set(candidate.id, candidate.status)
    }
    // 整组生成免审核：完成后服务端直接切分写入画面，不再弹审核窗口；微调仍需人工确认
    if (result.items[0] && mode !== 'generate') reviewCandidate(result.items[0])
    schedulePolling(requestToken, versionId, panelId)
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '宫格任务提交失败') }
  finally { if (active(requestToken, versionId, panelId)) submitting.value = false }
}
function generateGrid() { return submitCandidate('generate') }
function resplit() { if (canResplit.value) emit('split', { force: true }) }
function submitEdit() { return submitCandidate(editMode.value) }
function refineFrame(edit: { frameId: string; mode: 'grid_edit' | 'frame_edit'; instruction: string }) {
  const frame = frames.value.find(frame => frameKey(frame) === edit.frameId)
  if (!frame?.url || frame.locked || !edit.instruction.trim()
    || (edit.mode === 'grid_edit' ? !canGridEdit.value : edit.mode === 'frame_edit' ? !canFrameEdit.value : true)) return
  editMode.value = edit.mode; baseCandidate.value = undefined
  selectedFrameIds.value = [edit.frameId]; instruction.value = edit.instruction.trim(); instructions.value = {}
  return submitCandidate(edit.mode)
}
function openModal(kind: 'review' | 'edit' | 'settings') {
  if (!modal.value && typeof document !== 'undefined') previousFocus = document.activeElement as HTMLElement
  if (kind === 'settings') settingsTab.value = 'settings'
  modal.value = kind
}
function navigateSettingsTabs(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  settingsTab.value = event.key === 'Home' ? 'settings' : event.key === 'End' ? 'history' : settingsTab.value === 'settings' ? 'history' : 'settings'
  nextTick(() => dialog.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus())
}
function reviewCandidate(candidate: GridCandidate) { previewFrameId.value = undefined; review.value = candidate; openModal('review') }
function closeModal() {
  modal.value = ''; review.value = undefined; baseCandidate.value = undefined
  dialog.value?.close()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
function openEdit(mode: 'grid_edit' | 'frame_edit', base?: GridCandidate) {
  if (!props.editable || paidBusy.value || !capabilities.value?.supportsEdit) return
  if (base && (base.status !== 'ready' || base.mode === 'frame_edit')) return
  editMode.value = mode; baseCandidate.value = mode === 'grid_edit' ? base : undefined
  selectedFrameIds.value = mode === 'frame_edit' ? frames.value.filter(frame => frame.url && !frame.locked).slice(0, 1).map(frameKey) : []
  instruction.value = ''; instructions.value = {}; error.value = ''; openModal('edit')
}
function toggleFrame(id: string) {
  if (submitting.value || !props.editable) return
  const frame = frames.value.find(frame => frameKey(frame) === id)
  if (!frame || frame.locked || (!baseCandidate.value && !frame.url)) return
  if (editMode.value === 'frame_edit') selectedFrameIds.value = [id]
  else selectedFrameIds.value = selectedFrameIds.value.includes(id) ? selectedFrameIds.value.filter(item => item !== id) : [...selectedFrameIds.value, id]
}
function cellStyle(candidate: GridCandidate, index: number) {
  const columns = candidate.mode === 'frame_edit' ? 1 : candidate.grid.columns
  const rows = candidate.mode === 'frame_edit' ? 1 : candidate.grid.rows
  return { left: `${index % columns * 100 / columns}%`, top: `${Math.floor(index / columns) * 100 / rows}%`,
    width: `${100 / columns}%`, height: `${100 / rows}%` }
}
function perCellPixels(candidate: GridCandidate) {
  if (!candidate.width || !candidate.height || !['ready', 'adopted'].includes(candidate.status)) return undefined
  return { width: Math.floor(candidate.width / (candidate.mode === 'frame_edit' ? 1 : candidate.grid.columns)),
    height: Math.floor(candidate.height / (candidate.mode === 'frame_edit' ? 1 : candidate.grid.rows)) }
}
function candidateCropStyle(candidate: GridCandidate, id: string) {
  const cell = candidate.grid.cells.find(cell => cell.frameId === id)
  return { backgroundImage: `url("${mediaUrl(candidate.previewUrl || '')}")`, backgroundSize: `${candidate.grid.columns * 100}% ${candidate.grid.rows * 100}%`,
    backgroundPosition: `${candidate.grid.columns > 1 ? (cell!.index % candidate.grid.columns) * 100 / (candidate.grid.columns - 1) : 0}% ${candidate.grid.rows > 1 ? Math.floor(cell!.index / candidate.grid.columns) * 100 / (candidate.grid.rows - 1) : 0}%`,
    aspectRatio: `${(candidate.width || 1) / candidate.grid.columns} / ${(candidate.height || 1) / candidate.grid.rows}` }
}
function modeLabel(candidate: GridCandidate) { return candidate.mode === 'generate' ? '整组生成' : candidate.mode === 'frame_edit' ? '单格精修' : '整图微调' }
function statusLabel(candidate: GridCandidate) { return ({ pending: '排队中', processing: '生成中', ready: '待采用', failed: '失败', adopted: '已采用', discarded: '已丢弃' })[candidate.status] }
async function adoptCandidate() {
  const candidate = review.value
  if (!props.editable || submitting.value || !candidate || candidate.status !== 'ready' || !candidate.previewUrl) return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  submitting.value = true; error.value = ''
  try {
    const saved = await savedContext(requestToken, versionId, panelId)
    if (!saved) return
    const result = await props.commitAdoption(versionId, candidate.id, saved.revision)
    if (!active(requestToken, versionId, panelId)) return
    if (!result) { error.value = '候选已在服务端采用，请保留本地草稿并刷新工作版'; return }
    // 与服务端一致：同一分镜只保留一个采用结果，旧采用记录回退为待采用
    candidates.value = candidates.value.map(item => item.id === candidate.id ? { ...item, status: 'adopted' } : item.status === 'adopted' ? { ...item, status: 'ready' } : item)
    emit('adopted', result); closeModal()
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '采用失败，请刷新候选图后重试') }
  finally {
    if (active(requestToken, versionId, panelId)) submitting.value = false
  }
}
async function discardCandidate(candidate: GridCandidate) {
  if (!canManage.value || submitting.value || candidate.status === 'adopted') return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  submitting.value = true; error.value = ''
  try {
    await previsRequest(`/animatic-versions/${versionId}/grid-candidates/${candidate.id}/discard`, 'POST')
    if (!active(requestToken, versionId, panelId)) return
    discardedIds.add(candidate.id)
    candidates.value = candidates.value.filter(item => item.id !== candidate.id)
    schedulePolling(requestToken, versionId, panelId)
    if (review.value?.id === candidate.id) closeModal()
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '丢弃失败，请重试') }
  finally { if (active(requestToken, versionId, panelId)) submitting.value = false }
}
async function processCandidate(candidate: GridCandidate) {
  if (!props.editable || submitting.value || !candidate.rawUrl || candidate.status !== 'failed') return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  submitting.value = true; error.value = ''
  try {
    await previsRequest(`/animatic-versions/${versionId}/grid-candidates/${candidate.id}/process`, 'POST')
    if (active(requestToken, versionId, panelId)) await refreshCandidates(requestToken, versionId, panelId)
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '本地切分处理失败') }
  finally { if (active(requestToken, versionId, panelId)) submitting.value = false }
}
async function uploadGrid(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file || !props.editable || paidBusy.value || !validFrameCount.value || frames.value.some(frame => frame.locked)) return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  submitting.value = true; error.value = ''
  try {
    const saved = await savedContext(requestToken, versionId, panelId)
    if (!saved) return
    const uploaded = await uploadAPI.image(file)
    if (!active(requestToken, versionId, panelId)) return
    const result = await previsRequest<GridCandidate>(`/animatic-versions/${versionId}/grid-candidates/upload`, 'POST',
      { revision: saved.revision, panelId, url: uploaded.path || uploaded.url })
    if (!active(requestToken, versionId, panelId)) return
    candidates.value = [result, ...candidates.value.filter(item => item.id !== result.id)]
    candidateStatuses.set(result.id, result.status)
    // 上传替换同样免审核：服务端已自动切分；未自动采用时回退到人工确认
    if (result.status === 'adopted') toast.success('宫格已上传，画面已自动拆分')
    else reviewCandidate(result)
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '宫格上传失败') }
  finally { if (active(requestToken, versionId, panelId)) submitting.value = false }
}
watch(modal, async value => { if (value) { await nextTick(); if (modal.value && !dialog.value?.open) dialog.value?.showModal() } })
// A read started before or during a mutation must never replace its newer result.
watch(submitting, () => { candidateReadEpoch++ }, { flush: 'sync' })
watch(paidBusy, value => emit('busy', value), { flush: 'sync' })
watch(resolution, value => { try { localStorage.setItem(RESOLUTION_STORAGE_KEY, value) } catch {} })
watch(() => props.revision, () => { if (mounted) void refreshReferences() })
// Saving replaces panel objects. Compare the logical context, not a fresh array,
// so our own save/poll cannot close settings or invalidate a paid submission.
watch(currentContextKey, () => { if (mounted) void loadContext() })
onMounted(() => {
  mounted = true
  try { resolution.value = localStorage.getItem(RESOLUTION_STORAGE_KEY) || DEFAULT_RESOLUTION } catch {}
  return loadContext()
})
onBeforeUnmount(() => { disposed = true; token++; referenceToken++; stopPolling(); closeModal(); emit('busy', false) })
</script>

<template>
  <section class="grid-tools" data-testid="storyboard-grid-tools">
    <header class="grid-toolbar">
      <div class="grid-heading"><Grid2X2 :size="15" /><strong>分镜画面</strong><small>{{ frames.filter(frame => frame.url).length }} / {{ frames.length }} 张已就绪</small></div>
      <div class="grid-actions">
        <button type="button" class="btn btn-primary btn-sm" data-testid="grid-generate" :disabled="!canGenerate" @click="generateGrid"><Loader2 v-if="paidBusy" :size="13" class="grid-spin" /><Sparkles v-else :size="13" />{{ frames.some(frame => frame.url) ? '重新生成' : '生成宫格' }}</button>
        <button type="button" class="btn btn-sm" data-testid="grid-edit" :disabled="!canGridEdit" @click="openEdit('grid_edit')"><SlidersHorizontal :size="12" />微调画面</button>
        <button type="button" class="btn btn-sm" data-testid="grid-resplit" :disabled="!canResplit"
          :title="splitting ? '拆分任务进行中' : (!editable ? '当前版本不可编辑（已锁定或任务执行中）' : '按新方案重新拆分本镜头的分镜画面，已生成的图片保留在画面历史中')"
          @click="resplit"><Loader2 v-if="splitting" :size="12" class="grid-spin" /><Scissors v-else :size="12" />{{ splitting ? '拆分中' : '重新拆分画面' }}</button>
        <button type="button" class="btn btn-sm" data-testid="grid-settings" :disabled="loading && !capabilities" @click="openModal('settings')"><Settings2 :size="12" />生成设置</button>
      </div>
    </header>
    <GridReferenceAssets :manifest="referenceManifest" :loading="referenceLoading" :error="referenceError">
      <template #actions><slot name="reference-actions" /></template>
    </GridReferenceAssets>
    <slot :refine-frame="refineFrame" :can-refine-grid="canGridEdit" :can-refine-frame="canFrameEdit" />
    <input ref="fileInput" class="grid-file-input" type="file" accept="image/*" aria-label="上传整组宫格" @change="uploadGrid">
    <p v-if="!validFrameCount" class="grid-hint">先规划 1–9 张画面，再生成宫格。</p>
    <p v-else-if="capabilities && !capabilities.enabled" class="grid-hint">{{ capabilities.reason || '当前图片模型不支持整组宫格，请切换模型' }}</p>
    <p v-else-if="capabilities && !supportedResolutions.length" class="grid-hint">当前模型未提供 {{ projectRatio }} 的原生输出尺寸，请切换图片模型。</p>
    <p v-else-if="capabilities && !capabilities.supportsEdit" class="grid-hint">微调需要支持图片编辑的模型。</p>
    <p v-if="frames.some(frame => frame.locked)" class="grid-hint">已有画面锁定，可微调未锁定的画面。</p>
    <p v-if="error" role="alert" class="grid-error">{{ error }}</p>
    <div v-if="activeCandidates.length" class="grid-candidate-notices" data-testid="grid-candidate-notices">
      <div v-for="candidate in activeCandidates" :key="candidate.id" class="grid-candidate-notice" :data-candidate-id="candidate.id">
        <Loader2 v-if="['pending', 'processing'].includes(candidate.status)" :size="13" class="grid-spin" />
        <span><strong>{{ modeLabel(candidate) }} · {{ statusLabel(candidate) }}</strong><small v-if="candidate.error">{{ candidate.error }}</small></span>
        <button type="button" class="btn btn-sm" @click="reviewCandidate(candidate)">{{ candidate.status === 'ready' ? '审核候选' : '查看' }}</button>
        <button type="button" class="btn btn-sm" :disabled="!canManage || submitting" @click="discardCandidate(candidate)">{{ ['pending', 'processing'].includes(candidate.status) ? '取消' : '丢弃' }}</button>
      </div>
    </div>
  </section>

  <Teleport to="body">
    <dialog v-if="modal" ref="dialog" class="grid-dialog" :class="{ 'grid-dialog-settings': modal === 'settings', 'grid-dialog-review': modal === 'review' }" :aria-labelledby="titleId" @cancel.prevent="closeModal" @click.self="closeModal" @keydown.stop>
      <header><div><h2 :id="titleId">{{ modal === 'settings' ? '生成设置' : modal === 'edit' ? '微调画面' : '分镜画面预览' }}</h2><p v-if="modal !== 'settings'">{{ modal === 'edit' ? '选择要修改的画面，每次提交生成一个候选' : '逐格预览候选画面；采用后更新对应分镜画面' }}</p></div><button type="button" class="btn btn-icon" aria-label="关闭宫格窗口" @click="closeModal"><X :size="18" /></button></header>
      <div class="grid-dialog-body">
        <template v-if="modal === 'settings'">
          <div class="grid-settings-summary">
            <div class="grid-settings-preview" :style="currentGridStyle" data-testid="grid-settings-preview" aria-label="当前分镜画面缩略图">
              <div v-for="slot in currentGridSlots" :key="slot.index" class="grid-settings-preview-cell">
                <img v-if="slot.frame?.url" :src="mediaUrl(slot.frame.url)" :alt="`画面 ${slot.index + 1}`">
                <span v-else class="grid-settings-preview-empty">{{ slot.index + 1 }}</span>
              </div>
            </div>
            <div class="grid-settings-summary-text">
              <strong>{{ panel.title || '当前分镜' }}</strong>
              <span>{{ gridLayout.label }} 宫格 · {{ projectRatio }}<template v-if="gridLayout.count > frames.length"> · {{ gridLayout.count - frames.length }} 个留白格</template></span>
              <small :class="{ ready: validFrameCount && frames.every(frame => frame.url) }"><Check v-if="validFrameCount && frames.every(frame => frame.url)" :size="12" />{{ frames.filter(frame => frame.url).length }} / {{ frames.length }} 张画面已就绪</small>
            </div>
          </div>
          <div class="grid-settings-tabs" role="tablist" aria-label="生成设置与记录" @keydown="navigateSettingsTabs">
            <button :id="`${titleId}-settings-tab`" type="button" role="tab" :aria-selected="settingsTab === 'settings'" :aria-controls="`${titleId}-settings-panel`" :tabindex="settingsTab === 'settings' ? 0 : -1" @click="settingsTab = 'settings'">生成设置</button>
            <button :id="`${titleId}-history-tab`" type="button" role="tab" :aria-selected="settingsTab === 'history'" :aria-controls="`${titleId}-history-panel`" :tabindex="settingsTab === 'history' ? 0 : -1" @click="settingsTab = 'history'">生成记录<span>{{ visibleCandidates.length }}</span></button>
          </div>
          <div v-if="settingsTab === 'settings'" :id="`${titleId}-settings-panel`" class="grid-settings-fields" role="tabpanel" :aria-labelledby="`${titleId}-settings-tab`">
            <section class="grid-setting-field">
              <h3>宫格分辨率</h3>
              <div class="grid-setting-options" role="group" aria-label="宫格生成分辨率">
                <button v-for="option in supportedResolutions" :key="option" type="button" :aria-pressed="resolution === option" :disabled="paidBusy || !editable" @click="resolution = option">{{ option }}<Check v-if="resolution === option" :size="12" /></button>
              </div>
              <p v-if="validFrameCount && selectedSize && predictedCell" class="grid-hint">整图 {{ selectedSize.width }} × {{ selectedSize.height }}px · 每格约 {{ predictedCell.width }} × {{ predictedCell.height }}px</p>
              <p v-else-if="capabilities && !supportedResolutions.length" class="grid-hint">当前模型不支持 {{ projectRatio }} 宫格，请切换图片模型。</p>
              <p v-else class="grid-hint">先规划 1–9 张画面，再生成宫格。</p>
            </section>
            <section v-if="referenceStrategy !== undefined" class="grid-setting-field">
              <h3>视频参考方式</h3>
              <div class="grid-setting-options" role="group" aria-label="画面参考方式">
                <button v-for="option in [{ value: 'auto', label: '自动选择' }, { value: 'individual', label: '逐张画面' }, { value: 'contact_sheet', label: '宫格画面' }]" :key="option.value" type="button" :aria-pressed="(referenceStrategy || 'auto') === option.value" :disabled="!editable" @click="emit('update:referenceStrategy', option.value)">{{ option.label }}<Check v-if="(referenceStrategy || 'auto') === option.value" :size="12" /></button>
              </div>
              <p class="grid-hint">{{ referenceStrategy === 'individual' ? '将各张画面分别提供给视频模型。' : referenceStrategy === 'contact_sheet' ? '将整张宫格图提供给视频模型。' : '根据视频模型能力，自动选择合适的画面参考。' }}</p>
            </section>
            <section v-if="connection !== undefined" class="grid-setting-field">
              <h3>与上镜衔接</h3>
              <div class="grid-setting-options" role="group" aria-label="分镜衔接方式">
                <button v-for="option in [{ value: 'normal', label: '自动衔接' }, { value: 'strong', label: '连续动作' }, { value: 'scene_change', label: '场景切换' }] as const" :key="option.value" type="button" :aria-pressed="connection === option.value" :disabled="!editable || paidBusy" @click="emit('update:connection', option.value)">{{ option.label }}<Check v-if="connection === option.value" :size="12" /></button>
              </div>
              <p class="grid-hint">{{ connection === 'strong' ? '同场景且画面兼容时，复用上一镜头的结束画面。' : connection === 'scene_change' ? '切换到新场景，使用当前分镜的构图。' : '沿用前镜的视觉风格，保留当前分镜构图。' }}</p>
            </section>
          </div>
          <section v-else :id="`${titleId}-history-panel`" class="grid-settings-history" role="tabpanel" :aria-labelledby="`${titleId}-history-tab`">
            <div class="grid-settings-history-toolbar">
              <span>点击记录查看画面</span>
              <div class="grid-settings-actions">
                <button type="button" class="btn btn-sm" :disabled="!editable || paidBusy || !validFrameCount || frames.some(frame => frame.locked)" @click="fileInput?.click()"><Upload :size="12" />上传宫格</button>
                <button type="button" class="btn btn-icon btn-sm" aria-label="刷新宫格候选" :disabled="loading || submitting || historyRefreshing" @click="refreshSettingsHistory"><RefreshCw :size="13" :class="{ 'grid-spin': historyRefreshing }" /></button>
              </div>
            </div>
            <div class="grid-candidates" data-testid="grid-candidate-records">
              <div v-if="!visibleCandidates.length" class="grid-settings-empty"><Grid2X2 :size="26" /><strong>还没有生成记录</strong><span>生成或上传宫格后，可在这里查看。</span></div>
              <template v-for="batch in candidateBatches" :key="batch.batchNo">
                <p class="grid-batch-head">{{ versionLabel(batch.batchNo) }} · {{ batch.items.length }} 个候选<em v-if="batch.items.some(c => c.status === 'adopted')" class="grid-batch-current">当前采用中</em></p>
                <button v-for="candidate in batch.items" :key="candidate.id" type="button" class="grid-candidate" :class="{ current: candidate.status === 'adopted' }" :data-candidate-id="candidate.id" @click="reviewCandidate(candidate)">
                  <img v-if="candidate.previewUrl && candidate.status !== 'failed'" :src="mediaUrl(candidate.previewUrl)" alt="宫格候选缩略图">
                  <span v-else class="grid-candidate-placeholder"><Grid2X2 :size="18" /></span>
                  <span><strong>{{ modeLabel(candidate) }} · {{ statusLabel(candidate) }}</strong><small>{{ cropNote(candidate) ? `${cropNote(candidate)} · ` : '' }}{{ candidate.error || `${candidate.resolution || ''}${perCellPixels(candidate) ? ` · 每格 ${perCellPixels(candidate)!.width} × ${perCellPixels(candidate)!.height}px` : ''}` }}</small></span>
                  <em v-if="candidate.status === 'adopted'" class="grid-candidate-current">当前</em>
                </button>
              </template>
            </div>
          </section>
        </template>
        <template v-else-if="modal === 'edit'">
          <p class="grid-hint">{{ baseCandidate ? '输入为此候选整图。仅选择的格子会在采用时更新。' : editMode === 'frame_edit' ? '输入为选中画面的当前原图。其余画面不参与本次精修。' : '输入为当前所有原图重新拼成的宫格。采用时只更新选择的画面。' }}</p>
          <div v-if="baseCandidate" class="grid-preview" :style="{ aspectRatio: `${baseCandidate.width || 1} / ${baseCandidate.height || 1}` }"><img :src="mediaUrl(baseCandidate.previewUrl || '')" alt="微调输入宫格"><button v-for="cell in baseCandidate.grid.cells" :key="cell.frameId" type="button" class="grid-cell selectable" :class="{ selected: selectedFrameIds.includes(cell.frameId) }" :disabled="submitting || !editable || !frames.some(frame => frameKey(frame) === cell.frameId && !frame.locked)" :style="cellStyle(baseCandidate, cell.index)" :aria-pressed="selectedFrameIds.includes(cell.frameId)" :aria-label="`选择宫格画面 ${cell.index + 1}`" @click="toggleFrame(cell.frameId)"><span>{{ cell.index + 1 }}</span><Check v-if="selectedFrameIds.includes(cell.frameId)" :size="18" /></button></div>
          <div v-else-if="editMode === 'grid_edit'" class="grid-current-canvas" data-testid="grid-current-canvas" :style="currentGridStyle">
            <template v-for="slot in currentGridSlots" :key="slot.index">
              <button v-if="slot.frame" type="button" class="grid-current-cell" :class="{ selected: selectedFrameIds.includes(frameKey(slot.frame)) }" :disabled="submitting || !editable || slot.frame.locked || !slot.frame.url" :aria-pressed="selectedFrameIds.includes(frameKey(slot.frame))" :aria-label="`选择画面 ${slot.index + 1}`" @click="toggleFrame(frameKey(slot.frame))">
                <img v-if="slot.frame.url" :src="mediaUrl(slot.frame.url)" :alt="`当前宫格画面 ${slot.index + 1}`"><span v-else class="grid-current-missing">暂无原图</span>
                <span class="grid-current-number">{{ slot.index + 1 }}</span><Check v-if="selectedFrameIds.includes(frameKey(slot.frame))" :size="18" />
              </button>
              <span v-else class="grid-current-blank" aria-label="留白格，不可选择" />
            </template>
          </div>
          <div v-if="baseCandidate || editMode === 'frame_edit'" class="grid-frame-choices" :class="{ single: editMode === 'frame_edit' }">
            <button v-for="frame in editFrames" :key="frameKey(frame)" type="button" class="grid-frame-choice" :class="{ selected: selectedFrameIds.includes(frameKey(frame)) }" :disabled="submitting || !editable || frame.locked || (editMode === 'frame_edit' && !frame.url)" :aria-pressed="selectedFrameIds.includes(frameKey(frame))" :aria-label="`选择画面 ${editFrameNumber(frame)}`" @click="toggleFrame(frameKey(frame))">
              <span v-if="baseCandidate" class="grid-frame-crop" :style="candidateCropStyle(baseCandidate, frameKey(frame))" />
              <img v-else-if="frame.url" :src="mediaUrl(frame.url)" :alt="`当前画面 ${editFrameNumber(frame)}`"><span v-else class="grid-candidate-placeholder">暂无原图</span>
              <strong>{{ editFrameNumber(frame) }} · {{ frame.title || '画面' }}</strong><Check v-if="selectedFrameIds.includes(frameKey(frame))" :size="14" />
            </button>
          </div>
          <figure v-if="editMode === 'frame_edit' && selectedFrames[0]?.url" class="grid-single-preview"><figcaption>当前选中的原图</figcaption><img :src="mediaUrl(selectedFrames[0].url)" alt="当前选中的精修原图"></figure>
          <label class="grid-instruction"><span>{{ editMode === 'frame_edit' ? '精修指令' : '共同微调指令' }}</span><textarea v-model="instruction" :disabled="submitting || !editable" rows="3" maxlength="4000" :placeholder="editMode === 'frame_edit' ? '例如：保留构图和人物，把右手放低' : '例如：保持服装、背景和未选画面一致，调整选择的画面'" aria-label="共同微调指令" /></label>
          <label v-for="frame in editMode === 'grid_edit' ? selectedFrames : []" :key="frameKey(frame)" class="grid-instruction"><span>{{ frame.title || '画面' }} · 单独指令</span><textarea v-model="instructions[frameKey(frame)]" :disabled="submitting || !editable" rows="2" maxlength="4000" :aria-label="`画面 ${frameKey(frame)} 单独指令`" placeholder="可留空，使用共同指令" /></label>
          <p class="grid-hint">已选 {{ selectedFrameIds.length }} 张画面 · {{ resolution }} / {{ projectRatio }}。{{ editMode === 'frame_edit' ? '单格精修只允许选择 1 张已有原图的画面。' : '留白格不参与选择，每张选中画面都需要共同或单独指令。' }}</p>
        </template>
        <template v-else-if="review">
          <div class="grid-preview-shell">
            <aside class="grid-preview-panel">
              <div class="grid-preview-section-title"><span>分镜画面预览</span><span class="grid-preview-state" :class="{ 'is-ready': review.status === 'adopted', 'is-failed': review.status === 'failed' }">{{ review.status === 'adopted' ? '当前采用中' : statusLabel(review) }}</span></div>
              <div v-if="review.status !== 'failed' && review.previewUrl && activePreviewThumb" class="grid-preview-main" :style="previewCellStyle(review, activePreviewThumb.frameId)" :data-preview-frame="activePreviewThumb.frameId">
                <span class="grid-preview-main-badge">画面 {{ activePreviewThumb.number }}<template v-if="activePreviewFrame?.title"> · {{ activePreviewFrame.title }}</template></span>
              </div>
              <div v-else-if="['pending', 'processing'].includes(review.status)" class="grid-preview-main grid-preview-main-wait"><Loader2 :size="26" class="grid-spin" /><strong>{{ statusLabel(review) }}…</strong></div>
              <div v-else class="grid-preview-main grid-preview-main-empty">生成失败，暂无画面</div>
              <div v-if="reviewThumbs.length > 1" class="grid-preview-thumbs" data-testid="grid-preview-thumbs">
                <button v-for="thumb in reviewThumbs" :key="thumb.frameId" type="button" class="grid-preview-thumb" :class="{ current: thumb.frameId === activePreviewThumb?.frameId }" :aria-pressed="thumb.frameId === activePreviewThumb?.frameId" @click="previewFrameId = thumb.frameId">
                  <span class="grid-preview-thumb-media" :style="previewCellStyle(review, thumb.frameId)" />
                  <span class="grid-preview-thumb-number">{{ thumb.number }}</span>
                </button>
              </div>
              <div class="grid-preview-meta-row">
                <div class="grid-preview-meta-item"><span>生成模式</span><strong>{{ modeLabel(review) }}</strong></div>
                <div class="grid-preview-meta-item"><span>分辨率</span><strong>{{ review.resolution || '—' }}<template v-if="perCellPixels(review)"> · 每格 {{ perCellPixels(review)!.width }} × {{ perCellPixels(review)!.height }}px</template></strong></div>
              </div>
            </aside>
            <section class="grid-preview-side">
              <div class="grid-preview-section-title"><span>候选信息</span><span v-if="review.width && review.height" class="dim">{{ review.width }} × {{ review.height }}px · {{ review.adoptFrameIds.length }} 张画面 · {{ versionLabel(review.batchNo) }}</span></div>
              <p v-if="cropNote(review)" class="grid-hint grid-crop-note">{{ cropNote(review) }}</p>
              <GridReferenceAssets v-if="frozenManifest" :manifest="frozenManifest" frozen />
              <p v-if="review.error" role="alert" class="grid-error">{{ review.error }}</p>
              <p v-if="review.status === 'ready'" class="grid-hint">采用后该候选会切分并更新对应画面，原画面保留在画面历史中。</p>
              <p v-else-if="review.status === 'adopted'" class="grid-hint">该候选正在使用中，即为当前分镜画面。</p>
              <p v-else-if="['pending', 'processing'].includes(review.status)" class="grid-hint">候选生成中，可以关闭窗口，进度会继续更新；取消后已提交给模型的请求可能仍产生费用。</p>
              <template v-if="review.status === 'failed'">
                <p class="grid-hint">返回的原图未通过检查，暂时无法采用。</p>
                <img v-if="review.rawUrl" class="grid-preview-raw" :src="mediaUrl(review.rawUrl)" alt="未通过检查的返回原图">
              </template>
              <div class="grid-preview-actions">
                <button v-if="review.status === 'ready'" type="button" class="btn btn-primary btn-sm" data-testid="grid-adopt" :disabled="!editable || submitting || !review.previewUrl" @click="adoptCandidate"><Loader2 v-if="submitting" :size="13" class="grid-spin" /><Check v-else :size="13" />{{ review.mode === 'generate' ? '采用并切分为当前画面' : '采用为当前画面' }}</button>
                <button v-if="review.status === 'ready' && review.mode !== 'frame_edit'" type="button" class="btn btn-sm" :disabled="!editable || paidBusy || !capabilities?.supportsEdit" @click="openEdit('grid_edit', review)"><SlidersHorizontal :size="13" />基于此候选继续微调</button>
                <button v-if="review.status === 'failed' && review.rawUrl" type="button" class="btn btn-sm" :disabled="!editable || submitting" @click="processCandidate(review)">重新检查并切分（本地处理）</button>
                <button v-if="review.status !== 'adopted'" type="button" class="btn btn-sm grid-discard" :disabled="!canManage || submitting" @click="discardCandidate(review)"><Trash2 :size="13" />{{ ['pending', 'processing'].includes(review.status) ? '取消候选' : '丢弃候选' }}</button>
              </div>
            </section>
          </div>
        </template>
        <p v-if="error" role="alert" class="grid-error">{{ error }}</p>
      </div>
      <footer><span v-if="modal === 'settings'" class="grid-settings-footnote">修改后用于下次生成</span><span class="grid-footer-spacer" /><button type="button" class="btn btn-sm" :class="{ 'btn-primary': modal === 'settings' }" @click="closeModal">{{ modal === 'settings' ? '完成' : '关闭' }}</button><button v-if="modal === 'edit'" type="button" class="btn btn-primary btn-sm" data-testid="grid-submit-edit" :disabled="!canSubmit || !editValid" @click="submitEdit"><Loader2 v-if="submitting" :size="13" class="grid-spin" /><Sparkles v-else :size="13" />提交微调</button></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
/* 平铺在 .pv-inspector 内：不画外框（避免卡中卡），不另加内边距——面板 scroll 已有 12px 内容边距，与其他页签一致 */
.grid-tools { border-radius: var(--radius); background: var(--surface-raised); container: storyboard-grid / inline-size; }
.grid-tools > header, .grid-tools > header > div, .grid-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.grid-tools > header { justify-content: space-between; margin-bottom: 8px; }
.grid-tools strong { font-size: 12px; }
.grid-tools small, .grid-hint { color: var(--text-2); font-size: 11px; }
.grid-hint { margin: 7px 0 0; line-height: 1.6; }
/* 上游画布比例不符、已中心裁切适配：用告警色提示，与普通说明区分 */
.grid-crop-note { color: var(--warning, #ad7839); }
.grid-settings-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.grid-settings-preview { display: grid; flex-shrink: 0; width: 112px; gap: 2px; padding: 2px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.grid-settings-preview-cell { position: relative; min-width: 0; min-height: 0; overflow: hidden; border-radius: 2px; background: var(--surface-soft); }
.grid-settings-preview-cell img { display: block; width: 100%; height: 100%; object-fit: cover; }
.grid-settings-preview-empty { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--text-3); font: 11px var(--font-mono); }
.grid-file-input { display: none; }
.grid-error { padding: 8px; margin: 8px 0 0; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--error) 9%, transparent); color: var(--error); font-size: 12px; line-height: 1.6; }
.grid-candidates { display: flex; flex-direction: column; gap: 6px; overflow: auto; margin-top: 2px; }
.grid-candidate { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 9px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); color: var(--text-0); transition: border-color .12s ease, box-shadow .12s ease; }
.grid-candidate:hover { background: var(--bg-hover); }
.grid-candidate > img, .grid-candidate > .grid-candidate-placeholder { width: 76px; height: 48px; object-fit: cover; flex-shrink: 0; border-radius: var(--radius-sm); overflow: hidden; }
.grid-candidate > span:last-child { min-width: 0; display: flex; justify-content: center; flex-direction: column; gap: 3px; }
.grid-candidate small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid-candidate-placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-3); background: var(--surface-soft); }
.grid-candidate.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.grid-candidate-current { flex-shrink: 0; padding: 2px 7px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-text); font-size: 10px; font-style: normal; }
.grid-batch-head { display: flex; align-items: center; gap: 6px; margin: 10px 0 2px; color: var(--text-2); font-size: 11px; font-weight: 600; }
.grid-batch-head:first-child { margin-top: 0; }
.grid-batch-current { margin-left: auto; padding: 1px 7px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-text); font-size: 10px; font-style: normal; font-weight: 500; }
.grid-dialog { width: min(1050px, calc(100vw - 32px)); max-height: 90vh; margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); color: var(--text-0); }
.grid-dialog[open] { display: flex; flex-direction: column; }
.grid-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.grid-dialog > header, .grid-dialog > footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; flex-shrink: 0; }
.grid-dialog > header { border-bottom: 1px solid var(--border); }
.grid-dialog > header > div { flex: 1; }
.grid-dialog h2 { margin: 0; font-size: 16px; }
.grid-dialog header p { margin: 4px 0 0; font-size: 12px; color: var(--text-2); }
.grid-dialog-body { min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.grid-dialog > footer { border-top: 1px solid var(--border); flex-wrap: wrap; }
.grid-footer-spacer { flex: 1; }
/* 常用设置保持一屏可见，生成记录按需查看。 */
.grid-dialog.grid-dialog-settings { width: min(560px, calc(100vw - 32px)); max-height: min(760px, 90dvh); border-radius: 18px; box-shadow: 0 24px 80px rgb(15 23 42 / 20%); }
.grid-dialog-settings::backdrop { background: rgb(15 23 42 / 38%); backdrop-filter: blur(3px); }
.grid-dialog-settings > header { padding: 17px 22px 12px; border: 0; }
.grid-dialog-settings > header .btn-icon { width: 30px; height: 30px; background: transparent; color: var(--text-2); }
.grid-dialog-settings > header .btn-icon:hover { background: var(--bg-hover); }
.grid-dialog-settings > .grid-dialog-body { gap: 0; padding: 0 22px 20px; }
.grid-dialog-settings > footer { padding: 13px 22px; background: var(--surface-muted); }
.grid-dialog-settings > footer .btn { min-width: 70px; }
.grid-settings-summary { display: flex; align-items: center; gap: 16px; padding: 4px 0 20px; }
.grid-settings-summary-text { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.grid-settings-summary-text > strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 1.5; font-weight: 600; }
.grid-settings-summary-text > span { font-size: 11px; color: var(--text-2); }
.grid-settings-summary-text > small { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); font-size: 11px; }
.grid-settings-summary-text > small.ready { color: var(--success); }
.grid-settings-tabs { display: flex; gap: 24px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.grid-settings-tabs > button { position: relative; display: inline-flex; align-items: center; gap: 6px; min-height: 39px; padding: 0 0 11px; border: 0; background: transparent; color: var(--text-2); font: 500 12px var(--font-body); cursor: pointer; }
.grid-settings-tabs > button[aria-selected="true"] { color: var(--accent-text); font-weight: 600; }
.grid-settings-tabs > button[aria-selected="true"]::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; border-radius: 2px; background: var(--accent); }
.grid-settings-tabs > button > span { padding: 1px 6px; border-radius: 5px; background: var(--surface-muted); color: var(--text-2); font-size: 10px; font-weight: 500; }
.grid-settings-fields { display: flex; flex-direction: column; gap: 22px; padding-top: 22px; }
.grid-setting-field { display: flex; flex-direction: column; gap: 9px; }
.grid-setting-field h3 { margin: 0; color: var(--text-1); font-size: 12px; font-weight: 600; }
.grid-setting-options { display: flex; gap: 7px; }
.grid-setting-options > button { min-width: 0; flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 36px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-raised); color: var(--text-1); font: 500 12px var(--font-body); line-height: 1.4; cursor: pointer; transition: border-color .15s, background .15s; }
.grid-setting-options > button:hover:not(:disabled) { border-color: var(--accent); }
.grid-setting-options > button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
.grid-setting-options > button svg { flex-shrink: 0; }
.grid-setting-field .grid-hint { margin: 0; font-size: 11px; line-height: 1.65; }
.grid-settings-history { min-height: 245px; padding-top: 16px; }
.grid-settings-history-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 12px; }
.grid-settings-history-toolbar > span { color: var(--text-2); font-size: 11px; }
.grid-settings-history .grid-candidates { overflow: visible; }
.grid-settings-history .grid-candidate > span:not(.grid-candidate-placeholder) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.grid-settings-history .grid-candidate strong { font-size: 12px; }
.grid-settings-history .grid-candidate small { font-size: 10px; color: var(--text-2); }
.grid-settings-empty { display: flex; flex-direction: column; align-items: center; gap: 9px; padding: 40px 12px; text-align: center; color: var(--text-3); }
.grid-settings-empty strong { margin-top: 3px; font-size: 12px; font-weight: 500; color: var(--text-2); }
.grid-settings-empty span, .grid-settings-footnote { font-size: 11px; color: var(--text-2); }
/* ===== 分镜画面预览（与资产卡片详情同款布局） ===== */
.grid-dialog-review { width: min(960px, calc(100vw - 32px)); }
.grid-preview-shell { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(240px, 300px); gap: 14px; align-items: start; }
.grid-preview-panel, .grid-preview-side { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.grid-preview-section-title { min-height: 24px; display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-1); font-size: 12px; font-weight: 820; letter-spacing: 0.02em; }
.grid-preview-section-title .dim { color: var(--text-3); font-size: 11px; font-weight: 560; letter-spacing: 0; text-align: right; }
.grid-preview-state { min-height: 20px; display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; background: var(--overlay-track); color: var(--text-3); font-size: 10px; font-weight: 760; white-space: nowrap; }
.grid-preview-state.is-ready { color: var(--success); background: var(--success-bg); }
.grid-preview-state.is-failed { color: var(--error); background: color-mix(in srgb, var(--error) 12%, transparent); }
.grid-preview-main { position: relative; width: 100%; border: 1px solid var(--surface-outline); border-radius: var(--radius); background-color: var(--bg-2); background-repeat: no-repeat; overflow: hidden; }
.grid-preview-main-badge { position: absolute; left: 8px; top: 8px; padding: 3px 8px; border-radius: 999px; background: rgb(0 0 0 / 62%); color: #fff; font-size: 11px; line-height: 1.4; }
.grid-preview-main-wait, .grid-preview-main-empty { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-2); }
.grid-preview-main-empty { font-size: 12px; }
.grid-preview-thumbs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
.grid-preview-thumb { position: relative; flex: 0 0 auto; width: 96px; padding: 0; border: 2px solid transparent; border-radius: var(--radius-sm); background: none; cursor: pointer; }
.grid-preview-thumb.current { border-color: var(--accent); }
.grid-preview-thumb-media { display: block; width: 100%; border-radius: calc(var(--radius-sm) - 2px); background-color: var(--bg-2); background-repeat: no-repeat; }
.grid-preview-thumb-number { position: absolute; left: 4px; top: 4px; min-width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; padding: 0 4px; border-radius: 5px; background: rgb(0 0 0 / 65%); color: #fff; font: 11px var(--font-mono); }
.grid-preview-meta-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.grid-preview-meta-item { min-width: 0; padding: 9px 10px; border: 1px solid var(--surface-outline); border-radius: var(--radius); background: var(--surface-muted); }
.grid-preview-meta-item span { display: block; color: var(--text-3); font-size: 10px; font-weight: 780; letter-spacing: 0.04em; }
.grid-preview-meta-item strong { display: block; margin-top: 4px; min-width: 0; color: var(--text-0); font-size: 12px; line-height: 1.35; }
.grid-preview-side .grid-hint { margin: 0; }
.grid-preview-actions { display: flex; flex-direction: column; align-items: stretch; gap: 7px; margin-top: 2px; }
.grid-preview-raw { display: block; max-width: 100%; max-height: 220px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
@media (max-width: 720px) { .grid-preview-shell { grid-template-columns: 1fr; } }
.grid-preview { position: relative; width: 100%; overflow: hidden; border: 1px solid var(--border); background: var(--surface-soft); }
.grid-preview > img { display: block; width: 100%; height: 100%; object-fit: contain; }
.grid-cell { position: absolute; display: flex; align-items: flex-start; justify-content: space-between; padding: 6px; border: 1px solid rgb(255 255 255 / 40%); background: transparent; }
.grid-cell > span { display: flex; width: 23px; height: 23px; align-items: center; justify-content: center; background: rgb(0 0 0 / 65%); color: white; border-radius: 5px; font: 12px var(--font-mono); }
.grid-cell.selectable { cursor: pointer; color: var(--accent-text); }
.grid-cell.selected { border: 3px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.grid-frame-choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(135px, 1fr)); gap: 8px; }
.grid-current-canvas { display: grid; width: 100%; gap: 0; overflow: hidden; background: #808080; border: 1px solid var(--border); }
.grid-current-cell { position: relative; min-height: 0; min-width: 0; padding: 0; overflow: hidden; border: 0; outline: 1px solid rgb(255 255 255 / 40%); outline-offset: -1px; color: white; background: var(--surface-soft); }
.grid-current-cell img { display: block; width: 100%; height: 100%; object-fit: contain; background: #24272e; }
.grid-current-cell.selected { box-shadow: inset 0 0 0 3px var(--accent); }
.grid-current-cell.selected::after { content: ''; position: absolute; inset: 0; pointer-events: none; border: 3px solid var(--accent); }
.grid-current-number { position: absolute; top: 6px; left: 6px; display: flex; width: 23px; height: 23px; align-items: center; justify-content: center; border-radius: 5px; background: rgb(0 0 0 / 65%); font: 12px var(--font-mono); }
.grid-current-cell > svg { position: absolute; right: 8px; top: 8px; color: var(--accent); }
.grid-current-missing { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; color: var(--text-3); font-size: 12px; }
.grid-current-blank { display: block; background: #24272e; }
.grid-frame-choice { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-0); background: var(--surface); text-align: left; overflow: hidden; }
.grid-frame-choice.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.grid-frame-choice img, .grid-frame-choice .grid-candidate-placeholder { width: 100%; height: 95px; object-fit: contain; }
.grid-frame-crop { width: 100%; display: block; background-repeat: no-repeat; }
.grid-frame-choice strong { padding: 2px; font-size: 11px; }
.grid-frame-choice > svg { position: absolute; top: 9px; right: 9px; padding: 2px; box-sizing: content-box; border-radius: 50%; background: var(--accent); color: white; }
.grid-single-preview { margin: 0; }
.grid-single-preview figcaption { margin-bottom: 5px; font-size: 12px; color: var(--text-2); }
.grid-single-preview img { display: block; max-width: 100%; max-height: 380px; margin: auto; }
.grid-instruction { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.grid-instruction textarea { width: 100%; box-sizing: border-box; padding: 8px; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font: inherit; line-height: 1.6; }
.grid-discard { color: var(--error); }
.grid-tools :disabled, .grid-dialog :disabled { opacity: .5; cursor: not-allowed; }
.grid-tools button:focus-visible, .grid-dialog button:focus-visible, .grid-dialog textarea:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.grid-spin { animation: grid-spin 1s linear infinite; }
@keyframes grid-spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) { .grid-dialog { width: calc(100vw - 16px); max-height: 94vh; } .grid-dialog-body { padding: 12px; } .grid-frame-choices { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 420px) {
  .grid-dialog.grid-dialog-settings { width: calc(100vw - 24px); max-height: 92dvh; border-radius: 14px; }
  .grid-dialog-settings > header { padding: 15px 16px 10px; }
  .grid-dialog-settings > .grid-dialog-body { padding: 0 16px 18px; }
  .grid-dialog-settings > footer { padding: 12px 16px; }
  .grid-settings-summary { gap: 12px; }
  .grid-settings-preview { width: 88px; }
  .grid-setting-options { gap: 6px; }
  .grid-setting-options > button { padding: 7px 5px; font-size: 11px; }
}
@media (prefers-reduced-motion: reduce) { .grid-spin { animation: none; } }
.grid-tools > header > .grid-heading { flex: 1; flex-wrap: nowrap; white-space: nowrap; }
.grid-heading > svg { flex-shrink: 0; }
.grid-toolbar { margin-bottom: 12px !important; }
.grid-heading small { margin-left: auto; }
.grid-candidate-notices { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.grid-candidate-notice { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
.grid-candidate-notice > span { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.grid-candidate-notice small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@container storyboard-grid (max-width: 520px) {
  .grid-toolbar { flex-direction: column; align-items: stretch; }
  .grid-tools > header > .grid-heading { flex: none; width: 100%; }
  .grid-actions { width: 100%; gap: 6px; }
  .grid-actions > button { white-space: nowrap; }
}
</style>
