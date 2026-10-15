<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  Film, History, ImagePlus, Loader2, MoreHorizontal,
  SlidersHorizontal, Sparkles, Star, Upload,
} from 'lucide-vue-next'
import AppMenu from '~/components/AppMenu.vue'
import AppMenuItem from '~/components/AppMenuItem.vue'
import FrameSettingsDialog from './FrameSettingsDialog.vue'
import StoryboardContactSheet from './StoryboardContactSheet.vue'
import { uploadAPI } from '~/composables/useApi'
import {
  FRAME_COUNT_MAX, frameCountChangeAllowed, createFrameId, frameKey, makeFrame, mediaUrl, orderedFrames, panelImageFallback, planFrames,
  type BatchItem, type ContactSheetView, type Keyframe, type Panel,
} from '~/composables/usePrevis'

const props = withDefaults(defineProps<{
  panel: Panel
  editable: boolean
  /** 版本可提交生成（未锁定即可）：与 editable 解耦，一个画面生成中不禁用其他画面的生成入口。 */
  generatable?: boolean
  tasks?: BatchItem[]
  showVideoAction?: boolean
  videoGenerationMode?: 'direct' | 'storyboard_frames'
  activeFrameId?: string
  title?: string
  contactSheet?: ContactSheetView
  videoInputReady?: boolean
  videoInputError?: string
  /** 拆分任务提交中或排队中：与资产批量生成一致，按钮转圈显示“拆分中…” */
  splitting?: boolean
  integrated?: boolean
  canRefineGrid?: boolean
  canRefineFrame?: boolean
}>(), {
  generatable: true, tasks: () => [], showVideoAction: false, videoGenerationMode: 'storyboard_frames', activeFrameId: '', title: '分镜画面', splitting: false,
})
const emit = defineEmits<{
  change: [frames: Keyframe[], coverFrameId?: string]
  generate: [frameIds: string[], force?: boolean]
  video: []
  'settings-open': []
  split: [options?: { force?: boolean }]
  'retry-sheet': []
  refine: [edit: { frameId: string; mode: 'grid_edit' | 'frame_edit'; instruction: string }]
}>()

const uploading = ref('')
const uploadTarget = ref<{ panelId: number; frameId: string }>()
const fileInput = ref<HTMLInputElement>()
const settingsTrigger = shallowRef<HTMLElement>()
const menuId = ref('')
const toolbarMenu = ref(false)
const settings = ref<{ panelId: number; frameId?: string; newFrame?: Keyframe }>()
const frames = computed(() => orderedFrames(props.panel))
const canAdd = computed(() => props.editable && frames.value.length < FRAME_COUNT_MAX)
const usesStoryboardFrames = computed(() => props.videoGenerationMode === 'storyboard_frames')
const settingsFrame = computed(() => settings.value?.newFrame
  || props.panel.frames.find(frame => frameKey(frame) === settings.value?.frameId))
const missingVideoFrames = computed(() => frames.value.filter(frame => !frame.url).length)
const videoReady = computed(() => !usesStoryboardFrames.value || (props.videoInputReady ?? (frames.value.length > 0 && frames.value.length <= FRAME_COUNT_MAX && missingVideoFrames.value === 0)))
const missingFrames = computed(() => frames.value.filter(frame => !frame.url))
const canGenerateMissing = computed(() => props.generatable && missingFrames.value.length > 0
  && missingFrames.value.every(frame => canGenerate(frame)))

function task(frame: Keyframe) {
  return props.tasks.find(item => item.frameId === frameKey(frame) || (!item.frameId && item.frameType === frame.type))
}
function inProgress(frame: Keyframe) { return ['pending', 'processing'].includes(task(frame)?.status || '') }
function frameReferenceUrls(frame: Keyframe) { return frame.referenceImages ?? props.panel.referenceImages }
function frameHistoryCount(frame: Keyframe) {
  return [...(frame.history || []), ...(frame.url ? [{ url: frame.url }] : [])]
    .filter((entry, index, all) => entry.url && all.findIndex(item => item.url === entry.url) === index).length
}
function canEdit(frame: Keyframe) { return props.editable && !frame.locked && !inProgress(frame) && uploading.value !== frameKey(frame) }
// 生成入口不看 editable：busy（其他画面生成中）时仍可提交本画面，仅本画面有任务在跑或上传中时禁用。
function canGenerate(frame: Keyframe) {
  return props.generatable && !frame.locked && !inProgress(frame) && uploading.value !== frameKey(frame)
    && frameReferenceUrls(frame).length > 0
}
function status(frame: Keyframe) {
  if (uploading.value === frameKey(frame)) return { label: '上传中', kind: 'busy' }
  if (inProgress(frame)) return { label: task(frame)?.status === 'pending' ? '排队中' : '生成中', kind: 'busy' }
  if (task(frame)?.status === 'failed') return { label: '生成失败', kind: 'error' }
  return frame.url ? { label: frame.source?.mode === 'grid_edit' || frame.source?.mode === 'frame_edit' ? '已微调' : '已就绪', kind: 'ready' } : { label: '待生成', kind: 'empty' }
}
function changed(next: Keyframe[], cover = props.panel.coverFrameId) {
  if (!props.editable) return false
  if (props.panel.frames.some(frame => frame.locked && JSON.stringify(frame) !== JSON.stringify(next.find(item => frameKey(item) === frameKey(frame))))) {
    toast.error('已锁定画面不可修改，请先解除锁定')
    return false
  }
  if (!frameCountChangeAllowed(next, props.panel.frames)) {
    toast.error(`每个镜头最多 ${FRAME_COUNT_MAX} 张画面；旧方案超限时只能保留或删除已有画面`)
    return false
  }
  emit('change', next, cover && next.some(frame => frameKey(frame) === cover) ? cover : next.find(frame => frame.url)?.id)
  return true
}
function patch(id: string, value: Partial<Keyframe>) {
  changed(props.panel.frames.map(frame => frameKey(frame) === id ? { ...frame, ...value } : frame))
}
function openSettings(frame: Keyframe, event: Event) {
  settingsTrigger.value = event.currentTarget as HTMLElement
  settings.value = { panelId: props.panel.id, frameId: frameKey(frame) }
  emit('settings-open')
}
function selectSheetFrame(frameId: string, event: Event) {
  const frame = props.panel.frames.find(frame => frameKey(frame) === frameId)
  if (!frame) return
  openSettings(frame, event)
}
function refineFrame(edit: { frameId: string; mode: 'grid_edit' | 'frame_edit'; instruction: string }) {
  const context = settings.value, frame = settingsFrame.value
  if (!context || context.panelId !== props.panel.id || !frame || frameKey(frame) !== edit.frameId
    || !frame.url || !canEdit(frame) || !edit.instruction.trim()
    || (edit.mode === 'grid_edit' ? !props.canRefineGrid : !props.canRefineFrame)) return
  settings.value = undefined
  emit('refine', edit)
}
function add(event: Event) {
  if (!canAdd.value) return
  settingsTrigger.value = event.currentTarget as HTMLElement
  const lastOffset = frames.value.at(-1)?.offsetMs || 0
  const offset = frames.value.length ? Math.min(props.panel.durationMs - 1, Math.round((lastOffset + props.panel.durationMs) / 2)) : 0
  settings.value = { panelId: props.panel.id, newFrame: makeFrame(createFrameId(), offset, `画面 ${frames.value.length + 1}`) }
  emit('settings-open')
}
async function saveSettings(changes: Partial<Keyframe>, generate: boolean) {
  const context = settings.value
  const frame = settingsFrame.value
  if (!context || context.panelId !== props.panel.id || !frame || !canEdit(frame)) return
  const updated = { ...frame, ...changes }
  if (context.newFrame) {
    if (!changed([...props.panel.frames, updated])) return
  }
  else if (Object.keys(changes).length) patch(frameKey(frame), changes)
  settings.value = undefined
  // Parent change listeners update the shared timeline synchronously; generation reads it after render.
  await nextTick()
  const saved = props.panel.frames.find(item => frameKey(item) === frameKey(updated))
  if (generate && context.panelId === props.panel.id && saved && canGenerate(saved)) {
    emit('generate', [frameKey(saved)], !!saved.url)
  }
}
function plan() {
  toolbarMenu.value = false
  if (!props.editable) return
  if (props.panel.frames.some(frame => frame.locked)) { toast.error('存在已锁定画面，不能重新规划'); return }
  const planned = planFrames(props.panel, createFrameId())
  const existing = frames.value
  const next = planned.map((frame, index) => {
    const old = existing[index]
    return old ? { ...old, title: frame.title, offsetMs: frame.offsetMs, shotId: frame.shotId, prompt: frame.prompt } : frame
  })
  // Planning keeps existing extra images while updating matching planned slots.
  if (changed([...next, ...existing.slice(planned.length)])) toast.success(`已按描述规划 ${planned.length} 张画面`)
}
function menuAction(action: () => void) { menuId.value = ''; action() }
function move(frame: Keyframe, direction: number) {
  const next = frames.value.map(item => ({ ...item }))
  const index = next.findIndex(item => frameKey(item) === frameKey(frame)), target = index + direction
  if (!canEdit(frame) || target < 0 || target >= next.length || !canEdit(next[target])) return
  const offset = next[index].offsetMs
  next[index].offsetMs = next[target].offsetMs
  next[target].offsetMs = offset
  // Equal timestamps still need a stable ordering change.
  const moving = next[index]
  next[index] = next[target]
  next[target] = moving
  changed(next)
}
function remove(frame: Keyframe) {
  if (canEdit(frame)) changed(props.panel.frames.filter(item => frameKey(item) !== frameKey(frame)))
}
function chooseUpload(frame: Keyframe) {
  if (!canEdit(frame) || uploading.value) return
  uploadTarget.value = { panelId: props.panel.id, frameId: frameKey(frame) }
  fileInput.value?.click()
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], target = uploadTarget.value
  input.value = ''
  uploadTarget.value = undefined
  if (!file || !target || target.panelId !== props.panel.id) return
  const frame = props.panel.frames.find(item => frameKey(item) === target.frameId)
  if (!frame || !canEdit(frame)) return
  uploading.value = target.frameId
  try {
    const result = await uploadAPI.image(file)
    if (target.panelId !== props.panel.id || !props.editable) return
    const latest = props.panel.frames.find(item => frameKey(item) === target.frameId)
    if (!latest || latest.locked || inProgress(latest)) return
    const url = result.path || result.url
    const history = [...(latest.history || []), ...(latest.url ? [{ url: latest.url, taskId: latest.taskId, source: latest.source }] : []), { url }]
      .filter((entry, index, all) => all.findIndex(item => item.url === entry.url) === index)
    patch(target.frameId, { url, taskId: undefined, source: undefined, history })
  } catch (error: any) { toast.error(error.message || '图片上传失败，请重试') }
  finally { uploading.value = '' }
}
watch(() => props.panel.id, () => {
  settings.value = undefined
  menuId.value = ''
  toolbarMenu.value = false
})
watch(settingsFrame, frame => {
  if (settings.value?.frameId && !frame) settings.value = undefined
})
</script>

<template>
  <section class="frame-editor">
    <header v-if="!integrated" class="frame-editor-head">
      <div><strong>{{ title }}</strong><span class="frame-count" :class="{ complete: frames.length > 0 && !missingVideoFrames }"><i />{{ frames.length - missingVideoFrames }} / {{ frames.length }} 张已就绪</span></div>
      <button type="button" class="btn btn-sm frame-add" :disabled="!canAdd" :title="`每个镜头最多 ${FRAME_COUNT_MAX} 张画面`" @click="add"><ImagePlus :size="13" />添加画面</button>
    </header>
    <div v-if="!integrated" class="frame-editor-tools">
      <button v-if="integrated" type="button" class="btn btn-sm frame-add" :disabled="!canAdd" @click="add"><ImagePlus :size="13" />添加画面</button>
      <button v-if="!integrated" type="button" class="btn btn-sm frame-fill" :disabled="!canGenerateMissing"
        :title="missingFrames.some(frame => !frameReferenceUrls(frame).length) ? '请先在生成设置中选择参考素材' : '生成所有缺失画面'"
        @click="emit('generate', missingFrames.map(frameKey))"><Sparkles :size="13" />逐张生成缺失<span v-if="missingVideoFrames">{{ missingVideoFrames }}</span></button>
      <AppMenu v-model:open="toolbarMenu" placement="bottom-end">
        <template #trigger><button type="button" class="btn btn-sm frame-icon" title="更多画面操作" aria-label="更多画面操作"><MoreHorizontal :size="16" /></button></template>
        <AppMenuItem :disabled="splitting || !editable" :title="splitting ? '拆分任务进行中' : (!editable ? '当前版本不可编辑（已锁定或任务执行中）' : '')" @click="menuAction(() => emit('split'))"><Sparkles :size="13" />AI 分镜规划</AppMenuItem>
        <AppMenuItem v-if="frames.length" :disabled="splitting || !editable" :title="splitting ? '拆分任务进行中' : (!editable ? '当前版本不可编辑（已锁定或任务执行中）' : '')" @click="menuAction(() => emit('split', { force: true }))">重新规划画面（确认后应用）</AppMenuItem>
        <AppMenuItem :disabled="!editable" @click="plan">按镜头描述规划画面</AppMenuItem>
        <AppMenuItem v-if="integrated" :disabled="!canGenerateMissing" @click="menuAction(() => emit('generate', missingFrames.map(frameKey)))">兼容旧方案：逐张生成缺失</AppMenuItem>
      </AppMenu>
    </div>
    <input ref="fileInput" class="frame-upload-input" type="file" accept="image/*" aria-label="上传分镜画面" @change="upload">

    <StoryboardContactSheet v-if="frames.length && integrated" :panel="panel" :sheet="contactSheet" :active-frame-id="activeFrameId"
      @select="selectSheetFrame" @retry="emit('retry-sheet')" />
    <div v-else-if="frames.length" class="frame-editor-grid">
      <article v-for="(frame, index) in frames" :key="frameKey(frame)" class="frame-card" :class="{ selected: activeFrameId === frameKey(frame) }">
        <header class="frame-card-head">
          <span class="frame-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <strong :title="frame.title">{{ frame.title || `画面 ${index + 1}` }}</strong>
          <span class="frame-time">{{ ((frame.offsetMs || 0) / 1000).toFixed(1) }}s</span>
          <AppMenu :open="menuId === frameKey(frame)" placement="bottom-end" @update:open="menuId = $event ? frameKey(frame) : ''">
            <template #trigger><button type="button" class="btn btn-sm frame-icon" :aria-label="`画面 ${index + 1} 更多操作`"><MoreHorizontal :size="15" /></button></template>
            <AppMenuItem :disabled="!editable || !frame.url" :selected="panel.coverFrameId === frameKey(frame)" @click="menuAction(() => changed(panel.frames, frameKey(frame)))">设为镜头封面</AppMenuItem>
            <AppMenuItem :disabled="!canEdit(frame) || index === 0 || !canEdit(frames[index - 1])" @click="menuAction(() => move(frame, -1))">前移一张</AppMenuItem>
            <AppMenuItem :disabled="!canEdit(frame) || index === frames.length - 1 || !canEdit(frames[index + 1])" @click="menuAction(() => move(frame, 1))">后移一张</AppMenuItem>
            <AppMenuItem danger :disabled="!canEdit(frame)" @click="menuAction(() => remove(frame))">移除画面</AppMenuItem>
          </AppMenu>
        </header>
        <div class="frame-card-content">
          <button type="button" class="frame-thumb" :aria-label="`查看画面 ${index + 1} 详情与微调`" @click="openSettings(frame, $event)">
            <img v-if="frame.url" :src="mediaUrl(frame.url)" :alt="frame.title || '分镜画面'" loading="lazy">
            <ImagePlus v-else :size="24" />
            <span v-if="panel.coverFrameId === frameKey(frame)" class="frame-cover"><Star :size="10" fill="currentColor" />封面</span>
          </button>
          <div class="frame-card-summary">
            <div class="frame-state" :class="status(frame).kind"><Loader2 v-if="status(frame).kind === 'busy'" :size="11" class="frame-spin" /><i v-else />{{ status(frame).label }}</div>
            <p :title="frame.prompt || panelImageFallback(panel)">{{ frame.prompt || panelImageFallback(panel) || '打开画面规划，描述这张画面' }}</p>
            <small>{{ frame.shotType || panel.shotType || '默认景别' }}</small>
          </div>
        </div>
        <p v-if="task(frame)?.status === 'failed'" class="frame-error" :title="task(frame)?.error || undefined">{{ task(frame)?.error || '生成失败，请检查设置后重试' }}</p>
        <footer class="frame-card-actions">
          <button v-if="!integrated" type="button" class="btn btn-sm" :disabled="!canGenerate(frame)" :title="!frameReferenceUrls(frame).length ? '请先绑定参考素材' : ''"
            @click="emit('generate', [frameKey(frame)], !!frame.url)"><Sparkles :size="12" />{{ frame.url ? '重新生成' : '生成' }}</button>
          <button v-if="frameHistoryCount(frame) > 1" type="button" class="btn btn-sm" title="切换历史图片" @click="openSettings(frame, $event)"><History :size="12" />历史 {{ frameHistoryCount(frame) }}</button>
          <button type="button" class="btn btn-sm" :disabled="!canEdit(frame) || !!uploading" @click="chooseUpload(frame)"><Upload :size="12" />上传</button>
          <button type="button" class="btn btn-sm frame-settings-action" @click="openSettings(frame, $event)"><SlidersHorizontal :size="12" />{{ frame.url ? '画面详情' : '画面规划' }}</button>
        </footer>
      </article>
    </div>
    <div v-else class="frame-editor-empty">
      <ImagePlus :size="26" />
      <strong>还没有分镜画面</strong>
      <p>用 AI 按镜头描述规划画面，或手动添加。</p>
      <div class="frame-editor-empty-actions">
        <button
          type="button" class="btn btn-sm btn-primary" :disabled="splitting || !editable"
          :title="!editable ? '当前版本不可编辑（已锁定或任务执行中）' : '提交后台拆分任务'"
          @click="emit('split')"
        ><Loader2 v-if="splitting" :size="13" class="frame-spin" /><Sparkles v-else :size="13" />{{ splitting ? '规划中…' : 'AI 分镜规划' }}</button>
        <button type="button" class="btn btn-sm" :disabled="!editable" @click="plan">按描述规划</button>
        <button v-if="integrated" type="button" class="btn btn-sm" :disabled="!canAdd" @click="add">添加画面</button>
      </div>
    </div>
    <footer v-if="usesStoryboardFrames || showVideoAction" class="frame-editor-video">
      <div><Film :size="14" /><span>{{ videoReady ? `全部 ${frames.length} 张画面已就绪` : videoInputError || (frames.length ? `还需完成 ${missingVideoFrames} 张画面` : '先添加分镜画面') }}<small>视频按时间顺序使用全部画面</small></span></div>
      <button v-if="showVideoAction" type="button" class="btn btn-primary btn-sm" :disabled="!videoReady" @click="emit('video')"><Film :size="13" />生成视频</button>
    </footer>
    <FrameSettingsDialog
      v-if="settings && settingsFrame"
      :key="`${settings.panelId}-${settings.frameId || settings.newFrame?.id}`"
      :panel="panel"
      :frame="settingsFrame"
      :frame-number="frames.findIndex(frame => frameKey(frame) === frameKey(settingsFrame!)) + 1"
      :can-refine-grid="canRefineGrid"
      :can-refine-frame="canRefineFrame"
      :return-focus="settingsTrigger"
      :is-new="!!settings.newFrame"
      :editable="editable && (!settingsFrame || (!settingsFrame.locked && !inProgress(settingsFrame) && uploading !== frameKey(settingsFrame)))"
      @close="settings = undefined"
      @frame="saveSettings"
      @refine="refineFrame"
    />
  </section>
</template>

<style scoped>
.frame-editor { min-width: 0; display: flex; flex-direction: column; gap: 12px; container-type: inline-size; }
.frame-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.frame-editor-head > div { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; min-width: 0; }
.frame-editor-head strong { color: var(--text-0); font-size: 13px; }
.frame-editor-head span { color: var(--text-2); font-size: 11px; }
.frame-editor-head .frame-count { display: inline-flex; align-items: center; gap: 5px; padding: 3px 6px; border-radius: 5px; background: var(--surface-muted); font-size: 10px; line-height: 1.2; }
.frame-count i { width: 5px; height: 5px; border-radius: 50%; background: var(--text-3); }
.frame-editor-head .frame-count.complete { color: var(--success); background: var(--success-bg); }
.frame-count.complete i { background: currentColor; }
.frame-editor .btn { font-size: 11px; padding: 0 10px; min-height: 30px; border-radius: 7px; }
.frame-editor .frame-add { flex-shrink: 0; background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-2); box-shadow: none; }
.frame-editor .frame-add:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-0); }
.frame-editor-tools { display: flex; align-items: center; gap: 6px; }
.frame-editor .frame-fill { margin-left: auto; flex: 0 1 auto; justify-content: center; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border)); background: var(--accent-bg); color: var(--accent-text); box-shadow: none; }
.frame-editor .frame-fill:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 18%, var(--surface-raised)); border-color: var(--accent); }
.frame-fill span { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; border-radius: 4px; padding: 0 4px; background: color-mix(in srgb, var(--accent) 13%, transparent); font: 10px var(--font-mono); }
.frame-editor .frame-icon { width: 28px; min-height: 28px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
.frame-editor .frame-icon:hover { background: var(--bg-hover); color: var(--text-0); }
.frame-upload-input { display: none; }
.frame-editor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); align-items: start; gap: 10px; }
.frame-card { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); }
.frame-card:hover { border-color: var(--border-strong); }
.frame-card.selected {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
}
.frame-card-head { display: flex; align-items: center; gap: 7px; padding: 7px 8px 0; }
.frame-index { color: var(--text-3); font: 10px var(--font-mono); }
.frame-card-head strong { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; font-weight: 600; }
.frame-time { color: var(--text-2); font: 10px var(--font-mono); }
.frame-card-content { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 7px 10px 10px; }
.frame-editor .frame-thumb { position: relative; width: 96px; height: 76px; display: flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: var(--radius-sm); overflow: hidden; color: var(--on-media); background: var(--media-surface); box-shadow: none; cursor: pointer; }
.frame-thumb img { width: 100%; height: 100%; object-fit: contain; }
.frame-thumb:hover img { opacity: .88; }
.frame-cover { position: absolute; left: 3px; bottom: 3px; display: flex; align-items: center; gap: 3px; padding: 1px 4px; border-radius: 3px; background: var(--scrim); color: var(--on-media); font-size: 9px; }
.frame-cover svg { color: var(--warning); }
.frame-card-summary { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 5px; }
.frame-state { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text-2); }
.frame-state i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.frame-state.ready { color: var(--success); }
.frame-state.busy { color: var(--accent-text); }
.frame-state.error { color: var(--error); }
.frame-card-summary p { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 0; color: var(--text-1); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.frame-card-summary small { width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-2); font-size: 10px; }
.frame-card-actions { display: flex; align-items: center; gap: 4px; padding: 6px 7px; border-top: 1px solid var(--border); background: var(--surface-soft); }
.frame-card-actions .btn { flex: 1; padding: 0 6px; min-height: 28px; background: transparent; box-shadow: none; color: var(--text-1); font-weight: 500; }
.frame-card-actions .btn:hover:not(:disabled) { background: var(--bg-hover); }
.frame-card-actions .frame-settings-action { color: var(--accent-text); }
.frame-error { margin: 0 10px 8px; color: var(--error); font-size: 11px; overflow-wrap: anywhere; max-height: 56px; overflow: auto; }
.frame-editor-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 28px 12px; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-2); }
.frame-editor-empty strong { color: var(--text-1); font-size: 13px; }
.frame-editor-empty p { font-size: 11px; margin: 0; }
.frame-editor-empty-actions { display: flex; align-items: center; justify-content: center; gap: 6px; }
.frame-editor-progress { display: flex; align-items: center; gap: 10px; padding: 16px 12px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border)); border-radius: var(--radius); background: var(--surface-raised); color: var(--accent-text); }
.frame-editor-progress > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.frame-editor-progress strong { color: var(--text-0); font-size: 13px; }
.frame-editor-progress span { color: var(--text-2); font-size: 11px; }
.frame-editor-video { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0 2px; border-top: 1px solid var(--border); }
.frame-editor-video > div { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-1); }
.frame-editor-video small { display: block; margin-top: 2px; font-size: 10px; color: var(--text-3); }
.frame-editor button:disabled { opacity: .45; cursor: not-allowed; }
.frame-editor button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.frame-spin { animation: frame-spin 1s linear infinite; }
@keyframes frame-spin { to { transform: rotate(360deg); } }
@container (max-width: 280px) {
  .frame-card-content { grid-template-columns: 76px minmax(0, 1fr); gap: 8px; padding: 7px; }
  .frame-editor .frame-thumb { width: 76px; height: 66px; }
  .frame-card-actions { gap: 1px; padding: 5px; }
  .frame-card-actions .btn { font-size: 10px; padding: 0 3px; }
}
@media (prefers-reduced-motion: reduce) { .frame-spin { animation: none; } }
</style>
