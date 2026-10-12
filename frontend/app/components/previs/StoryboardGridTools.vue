<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { Check, Grid2X2, Loader2, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-vue-next'
import { uploadAPI } from '~/composables/useApi'
import { FRAME_COUNT_MAX, frameKey, mediaUrl, orderedFrames, previsRequest,
  type AnimaticVersion, type GridCandidate, type GridCapabilities, type GridMode, type Panel } from '~/composables/usePrevis'

const props = defineProps<{
  panel: Panel
  versionId: number
  revision: number
  configId?: number
  model?: string
  aspectRatio?: string
  editable: boolean
  managementEditable?: boolean
  beforeAction: () => Promise<{ versionId: number; revision: number } | false>
  commitAdoption: (versionId: number, candidateId: number, revision: number) => Promise<AnimaticVersion | false>
}>()
const emit = defineEmits<{ adopted: [version: AnimaticVersion]; busy: [value: boolean] }>()
const capabilities = ref<GridCapabilities>()
const candidates = ref<GridCandidate[]>([])
const error = ref(''), submitting = ref(false), loading = ref(false)
const resolution = ref('2K')
const modal = ref<'review' | 'edit' | ''>('')
const review = ref<GridCandidate>()
const confirmedReview = ref(false)
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
const gridSide = computed(() => frames.value.length === 1 ? 1 : frames.value.length <= 4 ? 2 : 3)
const predictedCell = computed(() => selectedSize.value && ({ width: Math.floor(selectedSize.value.width / gridSide.value), height: Math.floor(selectedSize.value.height / gridSide.value) }))
const canSubmit = computed(() => props.editable && validFrameCount.value && !!capabilities.value?.enabled && !!selectedSize.value && !paidBusy.value)
const canGenerate = computed(() => canSubmit.value && frames.value.every(frame => !frame.locked))
const canGridEdit = computed(() => canSubmit.value && !!capabilities.value?.supportsEdit && frames.value.every(frame => frame.url) && frames.value.some(frame => !frame.locked))
const canFrameEdit = computed(() => canSubmit.value && !!capabilities.value?.supportsEdit && frames.value.some(frame => frame.url && !frame.locked))
const editFrames = computed(() => baseCandidate.value
  ? [...baseCandidate.value.grid.cells].sort((a, b) => a.index - b.index)
    .map(cell => frames.value.find(frame => frameKey(frame) === cell.frameId)).filter((frame): frame is NonNullable<typeof frame> => !!frame)
  : frames.value)
const currentGridSlots = computed(() => Array.from({ length: gridSide.value ** 2 }, (_, index) => ({ index, frame: frames.value[index] })))
const currentGridStyle = computed(() => ({ gridTemplateColumns: `repeat(${gridSide.value}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${gridSide.value}, minmax(0, 1fr))`, aspectRatio: projectRatio.value.replace(':', ' / ') }))
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
const reviewCells = computed(() => !review.value ? [] : review.value.mode === 'frame_edit'
  ? review.value.grid.cells.filter(cell => review.value!.targetFrameIds.includes(cell.frameId)).map(cell => ({ ...cell, index: 0, number: cell.index + 1 }))
  : review.value.grid.cells.map(cell => ({ ...cell, number: cell.index + 1 })))
let token = 0, mounted = false, disposed = false
let polling: ReturnType<typeof setTimeout> | undefined
let previousFocus: HTMLElement | null = null
const discardedIds = new Set<number>()
let contextKey = ''
const currentContextKey = () => `${props.versionId}:${props.panel.id}:${props.configId || ''}:${props.model || ''}:${props.aspectRatio || ''}`
const path = () => `/animatic-versions/${props.versionId}/grid-candidates`
const active = (requestToken: number, versionId: number, panelId: number) => !disposed && requestToken === token && props.versionId === versionId && props.panel.id === panelId
function failure(cause: unknown, fallback: string) { error.value = cause instanceof Error ? cause.message : (cause as { message?: string })?.message || fallback }
function stopPolling() { clearTimeout(polling); polling = undefined }
function schedulePolling(requestToken: number, versionId: number, panelId: number) {
  stopPolling()
  if (!active(requestToken, versionId, panelId) || !pending.value) return
  polling = setTimeout(() => { void refreshCandidates(requestToken, versionId, panelId) }, 1200)
}
async function refreshCandidates(requestToken = token, versionId = props.versionId, panelId = props.panel.id) {
  try {
    const result = await previsRequest<{ items: GridCandidate[] }>(`/animatic-versions/${versionId}/grid-candidates?panel_id=${panelId}`)
    if (!active(requestToken, versionId, panelId)) return
    candidates.value = result.items.filter(candidate => !discardedIds.has(candidate.id))
    if (review.value) review.value = result.items.find(candidate => candidate.id === review.value!.id) || review.value
  } catch (cause) {
    if (active(requestToken, versionId, panelId)) failure(cause, '候选图进度读取失败，可点击刷新重试')
  } finally { schedulePolling(requestToken, versionId, panelId) }
}
async function loadContext() {
  const nextContextKey = currentContextKey()
  if (submitting.value && contextKey === nextContextKey) return
  contextKey = nextContextKey
  stopPolling()
  const requestToken = ++token, versionId = props.versionId, panelId = props.panel.id
  discardedIds.clear()
  candidates.value = []; capabilities.value = undefined; error.value = ''; loading.value = true
  submitting.value = false; closeModal()
  const query = new URLSearchParams()
  if (props.configId) query.set('config_id', String(props.configId))
  if (props.model) query.set('model', props.model)
  const results = await Promise.allSettled([
    previsRequest<GridCapabilities>(`/previs/grid-capabilities?${query}`),
    previsRequest<{ items: GridCandidate[] }>(`/animatic-versions/${versionId}/grid-candidates?panel_id=${panelId}`),
  ])
  if (!active(requestToken, versionId, panelId)) return
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') { failure(result.reason, '宫格能力或候选图读取失败'); continue }
    if (index === 0) {
      capabilities.value = result.value as GridCapabilities
      const supported = supportedResolutions.value
      if (!supported.includes(resolution.value)) resolution.value = supported[0] || '2K'
    } else candidates.value = (result.value as { items: GridCandidate[] }).items
  }
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
    const result = await previsRequest<{ items: GridCandidate[] }>(`/animatic-versions/${versionId}/grid-candidates`, 'POST',
      { revision: saved.revision, panelIds: [panelId], mode, ...chosenModel, ...(mode === 'generate' ? {} : edit) })
    if (!active(requestToken, versionId, panelId)) return
    for (const candidate of result.items) candidates.value = [candidate, ...candidates.value.filter(item => item.id !== candidate.id)]
    if (result.items[0]) reviewCandidate(result.items[0])
    schedulePolling(requestToken, versionId, panelId)
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '宫格任务提交失败') }
  finally { if (active(requestToken, versionId, panelId)) submitting.value = false }
}
function generateGrid() { return submitCandidate('generate') }
function submitEdit() { return submitCandidate(editMode.value) }
function openModal(kind: 'review' | 'edit') {
  if (!modal.value && typeof document !== 'undefined') previousFocus = document.activeElement as HTMLElement
  modal.value = kind
}
function reviewCandidate(candidate: GridCandidate) { confirmedReview.value = false; review.value = candidate; openModal('review') }
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
  if (!props.editable || submitting.value || !confirmedReview.value || !candidate || candidate.status !== 'ready' || !candidate.previewUrl) return
  const requestToken = token, versionId = props.versionId, panelId = props.panel.id
  submitting.value = true; error.value = ''
  try {
    const saved = await savedContext(requestToken, versionId, panelId)
    if (!saved) return
    const result = await props.commitAdoption(versionId, candidate.id, saved.revision)
    if (!active(requestToken, versionId, panelId)) return
    if (!result) { error.value = '候选已在服务端采用，请保留本地草稿并刷新工作版'; return }
    candidates.value = candidates.value.map(item => item.id === candidate.id ? { ...item, status: 'adopted' } : item)
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
    candidates.value = [result, ...candidates.value]
    reviewCandidate(result)
  } catch (cause) { if (active(requestToken, versionId, panelId)) failure(cause, '宫格上传失败') }
  finally { if (active(requestToken, versionId, panelId)) submitting.value = false }
}
watch(modal, async value => { if (value) { await nextTick(); if (modal.value && !dialog.value?.open) dialog.value?.showModal() } })
watch(paidBusy, value => emit('busy', value), { flush: 'sync' })
watch(() => [props.versionId, props.panel.id, props.configId, props.model, props.aspectRatio], () => { if (mounted) void loadContext() })
onMounted(() => { mounted = true; return loadContext() })
onBeforeUnmount(() => { disposed = true; token++; stopPolling(); closeModal(); emit('busy', false) })
</script>

<template>
  <section class="grid-tools" data-testid="storyboard-grid-tools">
    <header><div><Grid2X2 :size="15" /><strong>整组宫格</strong><small>候选确认后再切分到画面</small></div>
      <button type="button" class="btn btn-icon btn-sm" aria-label="刷新宫格候选" :disabled="loading || submitting" @click="loadContext"><RefreshCw :size="13" /></button>
    </header>
    <div class="grid-actions">
      <button type="button" class="btn btn-primary btn-sm" data-testid="grid-generate" :disabled="!canGenerate" @click="generateGrid"><Loader2 v-if="paidBusy" :size="13" class="grid-spin" /><Sparkles v-else :size="13" />{{ frames.some(frame => frame.url) ? '重新生成整组' : '生成整组宫格' }}</button>
      <label class="grid-resolution"><span>分辨率</span><select v-model="resolution" aria-label="宫格生成分辨率" :disabled="paidBusy || !editable || !supportedResolutions.length"><option v-for="option in supportedResolutions" :key="option" :value="option">{{ option }}</option></select></label>
      <button type="button" class="btn btn-sm" data-testid="grid-edit" :disabled="!canGridEdit" @click="openEdit('grid_edit')"><SlidersHorizontal :size="12" />整图微调</button>
      <button type="button" class="btn btn-sm" data-testid="frame-edit" :disabled="!canFrameEdit" @click="openEdit('frame_edit')">单格精修</button>
      <button type="button" class="btn btn-sm" :disabled="!editable || paidBusy || !validFrameCount || frames.some(frame => frame.locked)" @click="fileInput?.click()"><Upload :size="12" />上传替换宫格</button>
      <input ref="fileInput" class="grid-file-input" type="file" accept="image/*" aria-label="上传整组宫格" @change="uploadGrid">
    </div>
    <p class="grid-hint">一次提交调用图片模型 1 次。当前画面在采用前保留。</p>
    <p v-if="validFrameCount && selectedSize && predictedCell" class="grid-hint">{{ gridSide }} × {{ gridSide }} 宫格 · {{ projectRatio }} · 预计输出 {{ selectedSize.width }} × {{ selectedSize.height }}px · 预计每格约 {{ predictedCell.width }} × {{ predictedCell.height }}px<template v-if="gridSide * gridSide > frames.length"> · {{ gridSide * gridSide - frames.length }} 个留白格</template></p>
    <p v-if="!validFrameCount" class="grid-hint">先规划 1–9 张画面，再生成整组。</p>
    <p v-else-if="capabilities && !capabilities.enabled" class="grid-hint">{{ capabilities.reason || '当前图片模型不支持整组宫格，请切换模型' }}</p>
    <p v-else-if="capabilities && !supportedResolutions.length" class="grid-hint">当前模型未提供 {{ projectRatio }} 的原生输出尺寸，请切换图片模型。</p>
    <p v-else-if="capabilities && !capabilities.supportsEdit" class="grid-hint">当前模型支持整组生成；微调需要支持图片编辑的模型。</p>
    <p v-if="frames.some(frame => frame.locked)" class="grid-hint">已有画面锁定，整组生成与上传暂停；可精修未锁定的画面。</p>
    <p v-if="error" role="alert" class="grid-error">{{ error }}</p>
    <div v-if="visibleCandidates.length" class="grid-candidates">
      <button v-for="candidate in visibleCandidates" :key="candidate.id" type="button" class="grid-candidate" :data-candidate-id="candidate.id" @click="reviewCandidate(candidate)">
        <img v-if="candidate.previewUrl && candidate.status !== 'failed'" :src="mediaUrl(candidate.previewUrl)" alt="宫格候选缩略图">
        <span v-else class="grid-candidate-placeholder"><Loader2 v-if="['pending', 'processing'].includes(candidate.status)" :size="18" class="grid-spin" /><Grid2X2 v-else :size="18" /></span>
        <span><strong>{{ modeLabel(candidate) }} · {{ statusLabel(candidate) }}</strong><small>{{ candidate.error || `${candidate.resolution || ''}${perCellPixels(candidate) ? ` · 每格 ${perCellPixels(candidate)!.width} × ${perCellPixels(candidate)!.height}px` : ''}` }}</small></span>
      </button>
    </div>
  </section>

  <Teleport to="body">
    <dialog v-if="modal" ref="dialog" class="grid-dialog" :aria-labelledby="titleId" @cancel.prevent="closeModal" @click.self="closeModal" @keydown.stop>
      <header><div><h2 :id="titleId">{{ modal === 'edit' ? (editMode === 'frame_edit' ? '单格精修' : '整图微调') : '宫格候选审核' }}</h2><p>{{ modal === 'edit' ? '选择画面并描述改动，每次提交调用图片模型 1 次' : '关闭窗口会保留候选；采用后更新对应画面' }}</p></div><button type="button" class="btn btn-icon" aria-label="关闭宫格窗口" @click="closeModal"><X :size="18" /></button></header>
      <div class="grid-dialog-body">
        <template v-if="modal === 'edit'">
          <p class="grid-hint">{{ baseCandidate ? '输入为此候选整图。仅选择的格子会在采用时更新。' : editMode === 'frame_edit' ? '输入为选中画面的当前原图。其余画面不参与本次精修。' : '输入为当前所有原图重新拼成的宫格。采用时只更新选择的画面。' }}</p>
          <div v-if="baseCandidate" class="grid-preview" :style="{ aspectRatio: `${baseCandidate.width || 1} / ${baseCandidate.height || 1}` }"><img :src="mediaUrl(baseCandidate.previewUrl || '')" alt="微调输入宫格"><button v-for="cell in baseCandidate.grid.cells" :key="cell.frameId" type="button" class="grid-cell selectable" :class="{ selected: selectedFrameIds.includes(cell.frameId) }" :disabled="!frames.some(frame => frameKey(frame) === cell.frameId && !frame.locked)" :style="cellStyle(baseCandidate, cell.index)" :aria-pressed="selectedFrameIds.includes(cell.frameId)" :aria-label="`选择宫格画面 ${cell.index + 1}`" @click="toggleFrame(cell.frameId)"><span>{{ cell.index + 1 }}</span><Check v-if="selectedFrameIds.includes(cell.frameId)" :size="18" /></button></div>
          <div v-else-if="editMode === 'grid_edit'" class="grid-current-canvas" data-testid="grid-current-canvas" :style="currentGridStyle">
            <template v-for="slot in currentGridSlots" :key="slot.index">
              <button v-if="slot.frame" type="button" class="grid-current-cell" :class="{ selected: selectedFrameIds.includes(frameKey(slot.frame)) }" :disabled="slot.frame.locked || !slot.frame.url" :aria-pressed="selectedFrameIds.includes(frameKey(slot.frame))" :aria-label="`选择画面 ${slot.index + 1}`" @click="toggleFrame(frameKey(slot.frame))">
                <img v-if="slot.frame.url" :src="mediaUrl(slot.frame.url)" :alt="`当前宫格画面 ${slot.index + 1}`"><span v-else class="grid-current-missing">暂无原图</span>
                <span class="grid-current-number">{{ slot.index + 1 }}</span><Check v-if="selectedFrameIds.includes(frameKey(slot.frame))" :size="18" />
              </button>
              <span v-else class="grid-current-blank" aria-label="留白格，不可选择" />
            </template>
          </div>
          <div v-if="baseCandidate || editMode === 'frame_edit'" class="grid-frame-choices" :class="{ single: editMode === 'frame_edit' }">
            <button v-for="frame in editFrames" :key="frameKey(frame)" type="button" class="grid-frame-choice" :class="{ selected: selectedFrameIds.includes(frameKey(frame)) }" :disabled="frame.locked || (editMode === 'frame_edit' && !frame.url)" :aria-pressed="selectedFrameIds.includes(frameKey(frame))" :aria-label="`选择画面 ${editFrameNumber(frame)}`" @click="toggleFrame(frameKey(frame))">
              <span v-if="baseCandidate" class="grid-frame-crop" :style="candidateCropStyle(baseCandidate, frameKey(frame))" />
              <img v-else-if="frame.url" :src="mediaUrl(frame.url)" :alt="`当前画面 ${editFrameNumber(frame)}`"><span v-else class="grid-candidate-placeholder">暂无原图</span>
              <strong>{{ editFrameNumber(frame) }} · {{ frame.title || '画面' }}</strong><Check v-if="selectedFrameIds.includes(frameKey(frame))" :size="14" />
            </button>
          </div>
          <figure v-if="editMode === 'frame_edit' && selectedFrames[0]?.url" class="grid-single-preview"><figcaption>当前选中的原图</figcaption><img :src="mediaUrl(selectedFrames[0].url)" alt="当前选中的精修原图"></figure>
          <label class="grid-instruction"><span>{{ editMode === 'frame_edit' ? '精修指令' : '共同微调指令' }}</span><textarea v-model="instruction" rows="3" maxlength="4000" :placeholder="editMode === 'frame_edit' ? '例如：保留构图和人物，把右手放低' : '例如：保持服装、背景和未选画面一致，调整选择的画面'" aria-label="共同微调指令" /></label>
          <label v-for="frame in editMode === 'grid_edit' ? selectedFrames : []" :key="frameKey(frame)" class="grid-instruction"><span>{{ frame.title || '画面' }} · 单独指令</span><textarea v-model="instructions[frameKey(frame)]" rows="2" maxlength="4000" :aria-label="`画面 ${frameKey(frame)} 单独指令`" placeholder="可留空，使用共同指令" /></label>
          <p class="grid-hint">已选 {{ selectedFrameIds.length }} 张画面 · {{ resolution }} / {{ projectRatio }}。{{ editMode === 'frame_edit' ? '单格精修只允许选择 1 张已有原图的画面。' : '留白格不参与选择，每张选中画面都需要共同或单独指令。' }}</p>
        </template>
        <template v-else-if="review">
          <div class="grid-review-meta"><strong>{{ modeLabel(review) }} · {{ statusLabel(review) }}</strong><span>{{ review.resolution }}<template v-if="review.width && review.height"> · {{ review.width }} × {{ review.height }}px</template></span></div>
          <p v-if="perCellPixels(review)" class="grid-hint">实际每格 {{ perCellPixels(review)!.width }} × {{ perCellPixels(review)!.height }}px · 采用会更新 {{ review.adoptFrameIds.length }} 张画面</p>
          <p v-if="review.error" role="alert" class="grid-error">{{ review.error }}</p>
          <div v-if="review.status !== 'failed' && review.previewUrl" class="grid-comparison">
            <figure v-if="review.baseUrl"><figcaption>修改前</figcaption><img :src="mediaUrl(review.baseUrl)" alt="修改前原图"></figure>
            <figure><figcaption>{{ review.mode === 'generate' ? '待采用宫格' : '修改后候选' }}</figcaption><div class="grid-preview" :style="{ aspectRatio: `${review.width || 1} / ${review.height || 1}` }"><img :src="mediaUrl(review.previewUrl)" alt="待采用宫格"><span v-for="cell in reviewCells" :key="cell.frameId" class="grid-cell" :style="cellStyle(review, cell.index)"><span>{{ cell.number }}</span></span></div></figure>
          </div>
          <div v-else-if="['pending', 'processing'].includes(review.status)" class="grid-wait"><Loader2 :size="26" class="grid-spin" /><strong>{{ statusLabel(review) }}…</strong><p>可以关闭窗口，候选进度会继续更新。</p></div>
          <div v-else-if="review.status === 'failed' && review.rawUrl" class="grid-failed-raw"><p>返回的原图未通过检查，暂时无法采用。</p><img :src="mediaUrl(review.rawUrl)" alt="未通过检查的返回原图"><button type="button" class="btn btn-sm" :disabled="!editable || submitting" @click="processCandidate(review)">重新检查并切分（本地处理）</button></div>
          <button v-if="review.status === 'ready' && review.mode !== 'frame_edit'" type="button" class="btn btn-sm" :disabled="!editable || paidBusy || !capabilities?.supportsEdit" @click="openEdit('grid_edit', review)"><SlidersHorizontal :size="13" />基于此候选继续微调</button>
          <label v-if="review.status === 'ready'" class="grid-review-confirm"><input v-model="confirmedReview" type="checkbox" aria-label="已检查画格边界和顺序">已检查画格边界、顺序和画面内容，确认采用。</label>
          <p v-if="['pending', 'processing'].includes(review.status)" class="grid-hint">取消候选后会停止等待；已提交给模型的请求可能仍产生费用。</p>
        </template>
        <p v-if="error" role="alert" class="grid-error">{{ error }}</p>
      </div>
      <footer><button v-if="modal === 'review' && review && review.status !== 'adopted'" type="button" class="btn btn-sm grid-discard" :disabled="!canManage || submitting" @click="discardCandidate(review)"><Trash2 :size="13" />{{ ['pending', 'processing'].includes(review.status) ? '取消候选' : '丢弃候选' }}</button><span class="grid-footer-spacer" /><button type="button" class="btn btn-sm" @click="closeModal">{{ modal === 'review' ? '保留并关闭' : '取消' }}</button><button v-if="modal === 'edit'" type="button" class="btn btn-primary btn-sm" data-testid="grid-submit-edit" :disabled="!canSubmit || !editValid" @click="submitEdit"><Loader2 v-if="submitting" :size="13" class="grid-spin" /><Sparkles v-else :size="13" />提交微调</button><button v-else-if="review?.status === 'ready'" type="button" class="btn btn-primary btn-sm" data-testid="grid-adopt" :disabled="!editable || submitting || !confirmedReview || !review.previewUrl" @click="adoptCandidate"><Check :size="13" />{{ review.mode === 'generate' ? '采用并切分' : '采用微调' }}</button></footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.grid-tools { padding: 10px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); }
.grid-tools > header, .grid-tools > header > div, .grid-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.grid-tools > header { justify-content: space-between; margin-bottom: 8px; }
.grid-tools strong { font-size: 12px; }
.grid-tools small, .grid-hint { color: var(--text-2); font-size: 11px; }
.grid-hint { margin: 7px 0 0; line-height: 1.6; }
.grid-resolution { display: flex; align-items: center; gap: 5px; color: var(--text-2); font-size: 11px; }
.grid-resolution select { min-height: 28px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 5px; background: var(--surface); color: var(--text-0); }
.grid-file-input { display: none; }
.grid-error { padding: 8px; margin: 8px 0 0; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--error) 9%, transparent); color: var(--error); font-size: 12px; line-height: 1.6; }
.grid-candidates { display: flex; flex-direction: column; gap: 5px; max-height: 240px; overflow: auto; margin-top: 9px; }
.grid-candidate { display: flex; gap: 8px; width: 100%; padding: 5px; text-align: left; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); }
.grid-candidate:hover { background: var(--bg-hover); }
.grid-candidate > img, .grid-candidate > .grid-candidate-placeholder { width: 56px; height: 40px; object-fit: contain; flex-shrink: 0; }
.grid-candidate > span:last-child { min-width: 0; display: flex; justify-content: center; flex-direction: column; gap: 3px; }
.grid-candidate small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid-candidate-placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-3); background: var(--surface-soft); }
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
.grid-review-meta { display: flex; gap: 10px; justify-content: space-between; font-size: 12px; }
.grid-review-meta span { color: var(--text-2); }
.grid-review-confirm { display: flex; align-items: center; gap: 7px; font-size: 12px; line-height: 1.6; }
.grid-review-confirm input { accent-color: var(--accent); }
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
.grid-comparison { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.grid-comparison figure { margin: 0; min-width: 0; }
.grid-comparison figcaption { margin-bottom: 5px; color: var(--text-2); font-size: 12px; }
.grid-comparison figure > img { width: 100%; display: block; }
.grid-wait { display: flex; align-items: center; flex-direction: column; gap: 12px; padding: 40px 12px; color: var(--text-2); }
.grid-wait p { font-size: 12px; }
.grid-failed-raw img { display: block; max-width: 100%; max-height: 400px; margin-bottom: 10px; }
.grid-failed-raw p { color: var(--text-2); font-size: 12px; }
.grid-discard { color: var(--error); }
.grid-tools :disabled, .grid-dialog :disabled { opacity: .5; cursor: not-allowed; }
.grid-tools button:focus-visible, .grid-dialog button:focus-visible, .grid-dialog textarea:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.grid-spin { animation: grid-spin 1s linear infinite; }
@keyframes grid-spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) { .grid-dialog { width: calc(100vw - 16px); max-height: 94vh; } .grid-dialog-body { padding: 12px; } .grid-comparison { grid-template-columns: 1fr; } .grid-frame-choices { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .grid-spin { animation: none; } }
</style>
