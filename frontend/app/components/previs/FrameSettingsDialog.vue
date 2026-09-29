<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, useId } from 'vue'
import { Check, ImagePlus, RotateCcw, SlidersHorizontal, Sparkles, X } from 'lucide-vue-next'
import { mediaUrl, type Keyframe, type Panel } from '~/composables/usePrevis'

const props = defineProps<{
  panel: Panel
  frame: Keyframe
  editable: boolean
  isNew?: boolean
  returnFocus?: HTMLElement
}>()
const emit = defineEmits<{
  close: []
  frame: [changes: Partial<Keyframe>, generate: boolean]
}>()
// The dialog owns a draft. Only changed fields are applied to the latest frame on save.
const initial = {
  title: props.frame.title || '',
  offsetMs: props.frame.offsetMs || 0,
  prompt: props.frame.prompt || '',
  shotType: props.frame.shotType || '',
  angle: props.frame.angle || '',
  composition: props.frame.composition || '',
  referenceImages: props.frame.referenceImages ? [...props.frame.referenceImages] : undefined,
  url: props.frame.url || '',
}
const draft = ref({ ...initial, referenceImages: initial.referenceImages ? [...initial.referenceImages] : undefined })
const seconds = ref(initial.offsetMs / 1000)
const dialog = ref<HTMLDialogElement>()
const form = ref<HTMLFormElement>()
const titleId = useId()
const descriptionId = useId()
const readOnly = computed(() => !props.editable)
const maxSeconds = computed(() => Math.max(0, (props.panel.durationMs - 1) / 1000))
const references = computed(() => draft.value.referenceImages ?? props.panel.referenceImages)
const assets = computed(() => props.panel.referenceImages.map((url, index) => ({
  url, label: props.panel.referenceLabels?.[index] || `参考素材 ${index + 1}`,
})))
const missingReferences = computed(() => references.value.some(url => !props.panel.referenceImages.includes(url)))
const canGenerate = computed(() => !readOnly.value && references.value.length > 0 && !missingReferences.value)
const historyImages = computed(() => {
  const entries = [
    ...(props.frame.url ? [{ url: props.frame.url, taskId: props.frame.taskId }] : []),
    ...[...(props.frame.history || [])].reverse(),
  ]
  return entries.filter((entry, index) => entry.url && entries.findIndex(item => item.url === entry.url) === index)
})
const heading = computed(() => props.isNew ? '添加分镜画面' : '生成设置')
const subtitle = computed(() => `${props.panel.title} · ${props.isNew ? '新画面' : props.frame.title || '分镜画面'}`)
const invalidTime = computed(() => !Number.isFinite(seconds.value) || seconds.value < 0 || seconds.value > maxSeconds.value)
const previousFocus = props.returnFocus || (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)

function toggleReference(url: string) {
  if (readOnly.value) return
  draft.value.referenceImages = references.value.includes(url)
    ? references.value.filter(item => item !== url) : [...references.value, url]
}
function save(generate = false) {
  if (readOnly.value || !form.value?.reportValidity()) return
  if (invalidTime.value || missingReferences.value || (generate && !canGenerate.value)) return
  const changes: Partial<Keyframe> = {}
  for (const key of ['title', 'prompt', 'shotType', 'angle', 'composition'] as const) {
    if (draft.value[key] !== initial[key]) changes[key] = draft.value[key]
  }
  const offsetMs = Math.round(seconds.value * 1000)
  if (offsetMs !== initial.offsetMs) changes.offsetMs = offsetMs
  if (JSON.stringify(draft.value.referenceImages) !== JSON.stringify(initial.referenceImages)) {
    changes.referenceImages = draft.value.referenceImages ? [...draft.value.referenceImages] : undefined
  }
  if (draft.value.url !== initial.url) {
    const selected = historyImages.value.find(entry => entry.url === draft.value.url)
    if (selected) { changes.url = selected.url; changes.taskId = selected.taskId }
  }
  emit('frame', changes, generate)
}
function onKey(event: KeyboardEvent) {
  // Keep editor shortcuts local; the workbench also listens for space/arrows/undo.
  event.stopPropagation()
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    save()
  }
}
onMounted(() => {
  dialog.value?.showModal()
})
onBeforeUnmount(() => dialog.value?.close())
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="frame-settings-dialog"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      @cancel.prevent="emit('close')"
      @click.self="emit('close')"
      @keydown="onKey"
    >
      <form ref="form" @submit.prevent="save()">
        <header class="settings-header">
          <span class="settings-icon"><SlidersHorizontal :size="20" /></span>
          <div><h2 :id="titleId">{{ heading }}</h2><p :id="descriptionId">{{ subtitle }}</p></div>
          <button type="button" class="btn btn-icon" aria-label="关闭生成设置" @click="emit('close')"><X :size="18" /></button>
        </header>

        <div class="settings-body with-preview">
          <aside class="settings-preview">
            <div class="settings-image">
              <img v-if="draft.url || frame.url" :src="mediaUrl(draft.url || frame.url)" :alt="draft.title || '分镜画面'">
              <span v-else><ImagePlus :size="32" />画面生成后显示在这里</span>
            </div>
            <div class="settings-preview-meta"><b>{{ draft.title || '未命名画面' }}</b><span>{{ seconds || 0 }} 秒 / {{ panel.durationMs / 1000 }} 秒</span></div>
            <p class="settings-hint">参考素材仅用于生成这张画面。视频会使用镜头内的全部分镜画面。</p>
            <div v-if="historyImages.length > 1" class="settings-history">
              <h3>历史图片 <span>{{ historyImages.length }}</span></h3>
              <div>
                <button
                  v-for="(entry, index) in historyImages" :key="entry.url" type="button"
                  :disabled="readOnly" :class="{ selected: draft.url === entry.url, current: frame.url === entry.url }"
                  :aria-pressed="draft.url === entry.url" :aria-label="`使用历史图片 ${index + 1}`"
                  @click="draft.url = entry.url"
                ><img :src="mediaUrl(entry.url)" :alt="`历史图片 ${index + 1}`"><span v-if="frame.url === entry.url">当前</span><Check v-if="draft.url === entry.url" :size="14" /></button>
              </div>
              <p class="settings-hint">选择历史图片后点击保存，即可切换当前使用画面。</p>
            </div>
          </aside>

          <div class="settings-fields">
            <p v-if="readOnly" class="settings-notice">当前版本不可编辑，可查看画面设置。</p>
              <div class="settings-pair">
                <label>画面名称<input v-model="draft.title" :disabled="readOnly" maxlength="200" placeholder="如：人物推门进入"></label>
                <label>出现时间点 / 秒<input v-model.number="seconds" :disabled="readOnly" type="number" min="0" :max="maxSeconds" step="0.001" required></label>
              </div>
              <p v-if="invalidTime" class="settings-error" role="alert">时间点需在 0–{{ maxSeconds }} 秒之间。</p>
              <label>画面提示词
                <textarea v-model="draft.prompt" :disabled="readOnly" rows="5" maxlength="20000" placeholder="描述这张画面的动作、构图、光线和人物状态；留空时使用镜头描述与氛围。" />
              </label>
              <div class="settings-section-heading"><h3>镜头与构图</h3><span>留空时沿用镜头设置</span></div>
              <div class="settings-pair">
                <label>景别<input v-model="draft.shotType" :disabled="readOnly" :placeholder="panel.shotType || '如：中景'" maxlength="200"></label>
                <label>视角<input v-model="draft.angle" :disabled="readOnly" :placeholder="panel.angle || '如：平视'" maxlength="200"></label>
              </div>
              <label>构图<input v-model="draft.composition" :disabled="readOnly" placeholder="如：三分法、前景遮挡、人物位于画面右侧" maxlength="1000"></label>

              <div class="settings-section-heading">
                <h3>参考素材 <span>{{ references.length }} / {{ assets.length }}</span></h3>
                <button v-if="draft.referenceImages" type="button" class="settings-reset" :disabled="readOnly" @click="draft.referenceImages = undefined"><RotateCcw :size="12" />沿用全部</button>
                <span v-else>沿用镜头素材</span>
              </div>
              <div v-if="assets.length" class="settings-assets">
                <button
                  v-for="asset in assets" :key="asset.url" type="button"
                  :class="{ selected: references.includes(asset.url) }" :disabled="readOnly"
                  :aria-pressed="references.includes(asset.url)" :title="asset.label"
                  @click="toggleReference(asset.url)"
                ><img :src="mediaUrl(asset.url)" :alt="asset.label"><span>{{ asset.label }}</span><i><Check v-if="references.includes(asset.url)" :size="12" /></i></button>
              </div>
              <p v-else class="settings-notice">还没有参考素材。请先在视频制作页绑定角色、场景或道具图片。</p>
              <p v-if="assets.length && !references.length" class="settings-notice">请选择至少一项参考素材后生成画面；也可以先保存设置。</p>
              <p v-if="missingReferences" class="settings-error" role="alert">部分参考素材已被解绑，请点击“沿用全部”后重新选择。</p>
          </div>
        </div>
        <footer class="settings-footer">
          <span>{{ readOnly ? '只读' : '保存后生效' }}</span>
          <button type="button" class="btn" @click="emit('close')">{{ readOnly ? '关闭' : '取消' }}</button>
          <button v-if="!readOnly" type="submit" class="btn" :disabled="invalidTime || missingReferences">保存设置</button>
          <button v-if="!readOnly" type="button" class="btn btn-primary" :disabled="!canGenerate || invalidTime" @click="save(true)"><Sparkles :size="14" />保存并{{ frame.url ? '重新生成' : '生成' }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.frame-settings-dialog {
  width: min(860px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 40px);
  margin: auto; padding: 0; overflow: hidden; color: var(--text-0); background: var(--surface-raised);
  border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-elevated);
  font: 13px/1.6 var(--font-body);
}
.frame-settings-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(5px); }
.frame-settings-dialog form { display: flex; flex-direction: column; max-height: calc(100dvh - 42px); }
.settings-header { display: flex; align-items: center; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.settings-icon { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--radius); background: var(--accent-bg); color: var(--accent-text); }
.settings-header > div { min-width: 0; }
.settings-header h2 { font-size: 17px; margin: 0; }
.settings-header p { margin: 3px 0 0; color: var(--text-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-header > button { margin-left: auto; flex-shrink: 0; background: transparent; box-shadow: none; }
.settings-body { overflow: auto; min-height: 0; padding: 22px; }
.settings-body.with-preview { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; }
.settings-preview { min-width: 0; align-self: start; }
.settings-image { aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center; border-radius: var(--radius); overflow: hidden; background: var(--media-surface); color: var(--on-media); }
.settings-image img { width: 100%; height: 100%; object-fit: contain; }
.settings-image > span { display: flex; align-items: center; flex-direction: column; gap: 12px; font-size: 11px; opacity: .7; }
.settings-preview-meta { display: flex; flex-direction: column; gap: 2px; padding: 12px 0 8px; }
.settings-preview-meta b { font-size: 13px; overflow-wrap: anywhere; }
.settings-preview-meta span { font: 11px var(--font-mono); color: var(--text-2); }
.settings-hint { color: var(--text-2); font-size: 12px; margin: 0; }
.settings-history { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 14px; }
.settings-history h3, .settings-section-heading h3 { font-size: 12px; margin: 0; }
.settings-history h3 span, .settings-section-heading h3 span { color: var(--text-2); font-weight: 400; margin-left: 5px; }
.settings-history > div { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 8px 0; }
.settings-history button { position: relative; padding: 0; aspect-ratio: 4/3; overflow: hidden; border: 2px solid transparent; border-radius: var(--radius-sm); background: var(--media-surface); cursor: pointer; }
.settings-history img { width: 100%; height: 100%; object-fit: contain; }
.settings-history button.selected { border-color: var(--accent); }
.settings-history button svg { position: absolute; bottom: 2px; right: 2px; background: var(--accent); color: var(--on-accent); border-radius: 50%; }
.settings-history button > span { position: absolute; left: 3px; top: 3px; padding: 1px 4px; border-radius: 3px; background: var(--scrim); color: var(--on-media); font-size: 8px; line-height: 1.5; }
.settings-fields { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.settings-fields label { min-width: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-1); }
.settings-fields input, .settings-fields textarea {
  width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--border-strong); border-radius: var(--radius);
  color: var(--text-0); background: var(--surface-input); font: 13px/1.6 var(--font-body); outline: none;
}
.settings-fields textarea { resize: vertical; min-height: 120px; }
.settings-fields input:focus-visible, .settings-fields textarea:focus-visible { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--button-focus); }
.settings-fields input::placeholder, .settings-fields textarea::placeholder { color: var(--text-3); font-weight: 400; }
.settings-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.settings-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--border); padding-top: 16px; }
.settings-section-heading > span { color: var(--text-2); font-size: 11px; }
.settings-reset { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--accent-text); font: 11px var(--font-body); cursor: pointer; }
.settings-assets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.settings-assets button { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-soft); color: var(--text-1); text-align: left; cursor: pointer; }
.settings-assets button.selected { border-color: var(--border-strong); background: var(--bg-active); }
.settings-assets img { width: 40px; height: 40px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }
.settings-assets span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--font-body); }
.settings-assets i { display: grid; place-items: center; width: 16px; height: 16px; margin-left: auto; flex-shrink: 0; border: 1px solid var(--border-strong); border-radius: 4px; }
.settings-assets .selected i { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.settings-notice { display: flex; align-items: center; gap: 6px; margin: 0; padding: 10px; background: var(--warning-bg); color: var(--tag-warning-text); font-size: 12px; border-radius: var(--radius); }
.settings-notice svg { flex-shrink: 0; }
.settings-error { margin: 0; font-size: 12px; color: var(--error); }
.settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 22px; border-top: 1px solid var(--border); flex-shrink: 0; }
.settings-footer > span { margin-right: auto; color: var(--text-3); font-size: 11px; }
.frame-settings-dialog :disabled { opacity: .5; cursor: not-allowed; }
.frame-settings-dialog button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
@media (max-width: 640px) {
  .settings-header { padding: 14px; gap: 8px; }
  .settings-header p { max-width: 230px; }
  .settings-body { padding: 14px; }
  .settings-body.with-preview { grid-template-columns: 1fr; gap: 18px; }
  .settings-image { aspect-ratio: 16/9; max-height: 180px; }
  .settings-preview > .settings-hint { display: none; }
  .settings-history { margin-top: 8px; }
  .settings-footer { padding: 12px; flex-wrap: wrap; gap: 6px; }
  .settings-footer > span { display: none; }
  .settings-footer .btn { padding: 0 10px; font-size: 12px; }
  .settings-pair { gap: 8px; }
  .settings-assets { gap: 6px; }
}
</style>
