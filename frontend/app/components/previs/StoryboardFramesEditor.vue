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
import { uploadAPI } from '~/composables/useApi'
import {
  frameKey, makeFrame, mediaUrl, orderedFrames, panelImageFallback, planFrames,
  type BatchItem, type Keyframe, type Panel,
} from '~/composables/usePrevis'

const props = withDefaults(defineProps<{
  panel: Panel
  editable: boolean
  tasks?: BatchItem[]
  showVideoAction?: boolean
  videoGenerationMode?: 'direct' | 'storyboard_frames'
  activeFrameId?: string
  title?: string
}>(), {
  tasks: () => [], showVideoAction: false, videoGenerationMode: 'direct', activeFrameId: '', title: '分镜画面',
})
const emit = defineEmits<{
  change: [frames: Keyframe[], coverFrameId?: string]
  generate: [frameIds: string[], force?: boolean]
  video: []
  'settings-open': []
  split: [options?: { force?: boolean }]
}>()

const uploading = ref('')
const uploadTarget = ref<{ panelId: number; frameId: string }>()
const fileInput = ref<HTMLInputElement>()
const settingsTrigger = shallowRef<HTMLElement>()
const menuId = ref('')
const toolbarMenu = ref(false)
const settings = ref<{ panelId: number; frameId?: string; newFrame?: Keyframe }>()
const frames = computed(() => orderedFrames(props.panel))
const usesStoryboardFrames = computed(() => props.videoGenerationMode === 'storyboard_frames')
const settingsFrame = computed(() => settings.value?.newFrame
  || props.panel.frames.find(frame => frameKey(frame) === settings.value?.frameId))
const missingVideoFrames = computed(() => frames.value.filter(frame => !frame.url).length)
const videoReady = computed(() => !usesStoryboardFrames.value || (frames.value.length > 0 && missingVideoFrames.value === 0))
const missingFrames = computed(() => frames.value.filter(frame => !frame.url))
const canGenerateMissing = computed(() => props.editable && missingFrames.value.length > 0
  && missingFrames.value.every(canGenerate))

function task(frame: Keyframe) {
  return props.tasks.find(item => item.frameId === frameKey(frame) || (!item.frameId && item.frameType === frame.type))
}
function inProgress(frame: Keyframe) { return ['pending', 'processing'].includes(task(frame)?.status || '') }
function frameReferenceUrls(frame: Keyframe) { return frame.referenceImages ?? props.panel.referenceImages }
function frameHistoryCount(frame: Keyframe) {
  return [...(frame.history || []), ...(frame.url ? [{ url: frame.url }] : [])]
    .filter((entry, index, all) => entry.url && all.findIndex(item => item.url === entry.url) === index).length
}
function canEdit(frame: Keyframe) { return props.editable && !inProgress(frame) && uploading.value !== frameKey(frame) }
function canGenerate(frame: Keyframe) { return canEdit(frame) && frameReferenceUrls(frame).length > 0 }
function status(frame: Keyframe) {
  if (uploading.value === frameKey(frame)) return { label: '上传中', kind: 'busy' }
  if (inProgress(frame)) return { label: task(frame)?.status === 'pending' ? '排队中' : '生成中', kind: 'busy' }
  if (task(frame)?.status === 'failed') return { label: '生成失败', kind: 'error' }
  return frame.url ? { label: '已就绪', kind: 'ready' } : { label: '待生成', kind: 'empty' }
}
function changed(next: Keyframe[], cover = props.panel.coverFrameId) {
  if (!props.editable) return
  emit('change', next, cover && next.some(frame => frameKey(frame) === cover) ? cover : next.find(frame => frame.url)?.id)
}
function patch(id: string, value: Partial<Keyframe>) {
  changed(props.panel.frames.map(frame => frameKey(frame) === id ? { ...frame, ...value } : frame))
}
function openSettings(frame: Keyframe, event: Event) {
  settingsTrigger.value = event.currentTarget as HTMLElement
  settings.value = { panelId: props.panel.id, frameId: frameKey(frame) }
  emit('settings-open')
}
function add(event: Event) {
  if (!props.editable) return
  settingsTrigger.value = event.currentTarget as HTMLElement
  const lastOffset = frames.value.at(-1)?.offsetMs || 0
  const offset = frames.value.length ? Math.min(props.panel.durationMs - 1, Math.round((lastOffset + props.panel.durationMs) / 2)) : 0
  settings.value = { panelId: props.panel.id, newFrame: makeFrame(crypto.randomUUID(), offset, `画面 ${frames.value.length + 1}`) }
  emit('settings-open')
}
async function saveSettings(changes: Partial<Keyframe>, generate: boolean) {
  const context = settings.value
  const frame = settingsFrame.value
  if (!context || context.panelId !== props.panel.id || !frame || !canEdit(frame)) return
  const updated = { ...frame, ...changes }
  if (context.newFrame) changed([...props.panel.frames, updated])
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
  const planned = planFrames(props.panel, crypto.randomUUID())
  const existing = frames.value
  const next = planned.map((frame, index) => {
    const old = existing[index]
    return old ? { ...old, title: frame.title, offsetMs: frame.offsetMs, prompt: frame.prompt } : frame
  })
  // Planning keeps existing extra images while updating matching planned slots.
  changed([...next, ...existing.slice(planned.length)])
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
    if (!latest) return
    const url = result.path || result.url
    const history = [...(latest.history || []), ...(latest.url ? [{ url: latest.url, taskId: latest.taskId }] : []), { url }]
      .filter((entry, index, all) => all.findIndex(item => item.url === entry.url) === index)
    patch(target.frameId, { url, taskId: undefined, history })
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
    <header class="frame-editor-head">
      <div><strong>{{ title }}</strong><span>{{ frames.length - missingVideoFrames }} / {{ frames.length }} 张已就绪</span></div>
      <button type="button" class="btn btn-sm" :disabled="!editable" @click="add"><ImagePlus :size="14" />添加画面</button>
    </header>
    <div class="frame-editor-tools">
      <button type="button" class="btn btn-sm frame-fill" :disabled="!canGenerateMissing"
        :title="missingFrames.some(frame => !frameReferenceUrls(frame).length) ? '请先在生成设置中选择参考素材' : '生成所有缺失画面'"
        @click="emit('generate', missingFrames.map(frameKey))"><Sparkles :size="13" />生成缺失<span v-if="missingVideoFrames">{{ missingVideoFrames }}</span></button>
      <AppMenu v-model:open="toolbarMenu" placement="bottom-end">
        <template #trigger><button type="button" class="btn btn-sm frame-icon" title="更多画面操作" aria-label="更多画面操作"><MoreHorizontal :size="16" /></button></template>
        <AppMenuItem :disabled="!editable" @click="menuAction(() => emit('split'))"><Sparkles :size="13" />AI 拆分画面</AppMenuItem>
        <AppMenuItem v-if="frames.length" :disabled="!editable" @click="menuAction(() => emit('split', { force: true }))">重新拆分画面（覆盖现有）</AppMenuItem>
        <AppMenuItem :disabled="!editable" @click="plan">按镜头描述规划画面</AppMenuItem>
      </AppMenu>
    </div>
    <input ref="fileInput" class="frame-upload-input" type="file" accept="image/*" aria-label="上传分镜画面" @change="upload">

    <div v-if="frames.length" class="frame-editor-grid">
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
          <button type="button" class="frame-thumb" :aria-label="`查看画面 ${index + 1} 与生成设置`" @click="openSettings(frame, $event)">
            <img v-if="frame.url" :src="mediaUrl(frame.url)" :alt="frame.title || '分镜画面'" loading="lazy">
            <ImagePlus v-else :size="24" />
            <span v-if="panel.coverFrameId === frameKey(frame)" class="frame-cover"><Star :size="10" fill="currentColor" />封面</span>
          </button>
          <div class="frame-card-summary">
            <div class="frame-state" :class="status(frame).kind"><Loader2 v-if="status(frame).kind === 'busy'" :size="11" class="frame-spin" /><i v-else />{{ status(frame).label }}</div>
            <p :title="frame.prompt || panelImageFallback(panel)">{{ frame.prompt || panelImageFallback(panel) || '点击生成设置，描述这张画面' }}</p>
            <small>{{ frameReferenceUrls(frame).length }} 项参考 · {{ frame.shotType || panel.shotType || '默认景别' }}</small>
          </div>
        </div>
        <p v-if="task(frame)?.status === 'failed'" class="frame-error" :title="task(frame)?.error || undefined">{{ task(frame)?.error || '生成失败，请检查设置后重试' }}</p>
        <footer class="frame-card-actions">
          <button type="button" class="btn btn-sm" :disabled="!canGenerate(frame)" :title="!frameReferenceUrls(frame).length ? '请先在生成设置中选择参考素材' : ''"
            @click="emit('generate', [frameKey(frame)], !!frame.url)"><Sparkles :size="12" />{{ frame.url ? '重新生成' : '生成' }}</button>
          <button v-if="frameHistoryCount(frame) > 1" type="button" class="btn btn-sm" title="切换历史图片" @click="openSettings(frame, $event)"><History :size="12" />历史 {{ frameHistoryCount(frame) }}</button>
          <button type="button" class="btn btn-sm" :disabled="!canEdit(frame) || !!uploading" @click="chooseUpload(frame)"><Upload :size="12" />上传</button>
          <button type="button" class="btn btn-sm frame-settings-action" @click="openSettings(frame, $event)"><SlidersHorizontal :size="12" />生成设置</button>
        </footer>
      </article>
    </div>
    <div v-else class="frame-editor-empty">
      <ImagePlus :size="26" />
      <strong>还没有分镜画面</strong>
      <p>用 AI 按镜头描述拆分画面，或手动添加。</p>
      <div class="frame-editor-empty-actions">
        <button
          type="button" class="btn btn-sm btn-primary" :disabled="!editable"
          :title="!editable ? '当前版本不可编辑（已锁定或任务执行中）' : '提交后台拆分任务'"
          @click="emit('split')"
        ><Sparkles :size="13" />AI 拆分画面</button>
        <button type="button" class="btn btn-sm" :disabled="!editable" @click="plan">按描述规划</button>
      </div>
    </div>
    <footer class="frame-editor-video">
      <div><Film :size="14" /><span>{{ usesStoryboardFrames ? (videoReady ? `全部 ${frames.length} 张画面已就绪` : frames.length ? `还需完成 ${missingVideoFrames} 张画面` : '先添加分镜画面') : '当前为直接生成模式' }}<small>{{ usesStoryboardFrames ? '视频按时间顺序使用全部画面' : '这些画面仅用于预演和审核，不作为当前视频输入' }}</small></span></div>
      <button v-if="showVideoAction" type="button" class="btn btn-primary btn-sm" :disabled="!videoReady" @click="emit('video')"><Film :size="13" />生成视频</button>
    </footer>
    <FrameSettingsDialog
      v-if="settings && settingsFrame"
      :key="`${settings.panelId}-${settings.frameId || settings.newFrame?.id}`"
      :panel="panel"
      :frame="settingsFrame"
      :return-focus="settingsTrigger"
      :is-new="!!settings.newFrame"
      :editable="editable && (!settingsFrame || (!inProgress(settingsFrame) && uploading !== frameKey(settingsFrame)))"
      @close="settings = undefined"
      @frame="saveSettings"
    />
  </section>
</template>

<style scoped>
.frame-editor { min-width: 0; display: flex; flex-direction: column; gap: 10px; container-type: inline-size; }
.frame-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.frame-editor-head > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.frame-editor-head strong { color: var(--text-0); font-size: 13px; }
.frame-editor-head span { color: var(--text-2); font-size: 11px; }
.frame-editor .btn { font-size: 11px; padding: 0 10px; min-height: 28px; }
.frame-editor-tools { display: flex; align-items: center; gap: 6px; }
.frame-editor .frame-fill { flex: 1; justify-content: center; }
.frame-fill span { min-width: 16px; border-radius: 4px; padding: 1px 4px; background: var(--bg-active); font: 10px var(--font-mono); }
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
