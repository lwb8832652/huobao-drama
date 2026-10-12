<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, useId } from 'vue'
import { Check, ImagePlus, SlidersHorizontal, Sparkles, X } from 'lucide-vue-next'
import { frameKey, mediaUrl, type Keyframe, type Panel } from '~/composables/usePrevis'

const props = withDefaults(defineProps<{
  panel: Panel
  frame: Keyframe
  editable: boolean
  isNew?: boolean
  frameNumber?: number
  canRefineGrid?: boolean
  canRefineFrame?: boolean
  returnFocus?: HTMLElement
}>(), { canRefineGrid: false, canRefineFrame: false })
const emit = defineEmits<{
  close: []
  frame: [changes: Partial<Keyframe>, generate: boolean]
  refine: [edit: { frameId: string; mode: 'grid_edit' | 'frame_edit'; instruction: string }]
}>()
// Planning and image history have separate save actions; neither starts a model task.
const initial = {
  title: props.frame.title || '', offsetMs: props.frame.offsetMs || 0,
  prompt: props.frame.prompt || '', shotType: props.frame.shotType || '',
  angle: props.frame.angle || '', composition: props.frame.composition || '',
  continuity: props.frame.continuity || '', url: props.frame.url || '',
}
const draft = ref({ ...initial })
const seconds = ref(initial.offsetMs / 1000)
const refinementMode = ref<'grid_edit' | 'frame_edit'>('grid_edit')
const refinementInstruction = ref('')
const planningOpen = ref(!!props.isNew || !props.frame.url)
const dialog = ref<HTMLDialogElement>(), form = ref<HTMLFormElement>()
const titleId = useId(), descriptionId = useId()
const readOnly = computed(() => !props.editable || !!props.frame.locked)
const maxSeconds = computed(() => Math.max(0, (props.panel.durationMs - 1) / 1000))
const historyImages = computed(() => {
  const entries = [
    ...(props.frame.url ? [{ url: props.frame.url, taskId: props.frame.taskId, source: props.frame.source }] : []),
    ...[...(props.frame.history || [])].reverse(),
  ]
  return entries.filter((entry, index) => entry.url && entries.findIndex(item => item.url === entry.url) === index)
})
const heading = computed(() => props.isNew ? '添加分镜画面' : '画面详情')
const subtitle = computed(() => `${props.frameNumber ? `画面 ${props.frameNumber} · ` : ''}${props.panel.title} · ${(props.frame.offsetMs || 0) / 1000} 秒`)
const invalidTime = computed(() => !Number.isFinite(seconds.value) || seconds.value < 0 || seconds.value > maxSeconds.value)
const canRefine = computed(() => !readOnly.value && !!props.frame.url && !!refinementInstruction.value.trim()
  && (refinementMode.value === 'grid_edit' ? props.canRefineGrid : props.canRefineFrame))
function sourceLabel(source?: Keyframe['source']) {
  return source?.mode === 'generate' ? '原始切分' : source?.mode === 'grid_edit' ? '整图微调' : source?.mode === 'frame_edit' ? '单格精修' : '图片'
}
const previousFocus = props.returnFocus || (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
function savePlanning() {
  if (readOnly.value || !form.value?.reportValidity() || invalidTime.value) return
  const changes: Partial<Keyframe> = {}
  for (const key of ['title', 'prompt', 'shotType', 'angle', 'composition', 'continuity'] as const) {
    if (draft.value[key] !== initial[key]) changes[key] = draft.value[key]
  }
  const offsetMs = Math.round(seconds.value * 1000)
  if (offsetMs !== initial.offsetMs) changes.offsetMs = offsetMs
  emit('frame', changes, false)
}
function saveHistory() {
  if (readOnly.value || draft.value.url === props.frame.url) return
  const selected = historyImages.value.find(entry => entry.url === draft.value.url)
  if (selected) emit('frame', { url: selected.url, taskId: selected.taskId, source: selected.source }, false)
}
// Keep the existing save contract for callers; generation is now owned by the grid workflow.
function save(_generate = false) {
  if (draft.value.url !== initial.url) saveHistory()
  else savePlanning()
}
function refine() {
  if (!canRefine.value) return
  emit('refine', { frameId: frameKey(props.frame), mode: refinementMode.value, instruction: refinementInstruction.value.trim() })
}
function onKey(event: KeyboardEvent) {
  event.stopPropagation()
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); savePlanning()
  }
}
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
onUnmounted(() => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) })
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="frame-settings-dialog" data-testid="frame-details" :aria-labelledby="titleId" :aria-describedby="descriptionId"
      @cancel.prevent="emit('close')" @click.self="emit('close')" @keydown="onKey">
      <form ref="form" @submit.prevent="frame.url ? refine() : savePlanning()">
        <header class="settings-header">
          <span class="settings-icon"><SlidersHorizontal :size="20" /></span>
          <div><h2 :id="titleId">{{ heading }}</h2><p :id="descriptionId">{{ subtitle }}</p></div>
          <button type="button" class="btn btn-icon" aria-label="关闭画面详情" @click="emit('close')"><X :size="18" /></button>
        </header>
        <div class="settings-body with-preview">
          <aside class="settings-preview">
            <div class="settings-image">
              <img v-if="frame.url" :src="mediaUrl(frame.url)" :alt="`画面 ${frameNumber || ''} 当前原图`">
              <span v-else><ImagePlus :size="32" />保存规划后，生成宫格更新画面</span>
            </div>
            <div class="settings-preview-meta"><b>{{ frame.title || '未命名画面' }}</b><span>{{ (frame.offsetMs || 0) / 1000 }} 秒 / {{ panel.durationMs / 1000 }} 秒</span></div>
            <details v-if="historyImages.length > 1 || (!frame.url && historyImages.length)" class="settings-history">
              <summary>历史版本 · {{ historyImages.length }}</summary>
              <div>
                <button v-for="(entry, index) in historyImages" :key="entry.url" type="button"
                  :disabled="readOnly" :class="{ selected: draft.url === entry.url, current: frame.url === entry.url }"
                  :aria-pressed="draft.url === entry.url" :aria-label="`使用历史图片 ${index + 1}`" @click="draft.url = entry.url">
                  <img :src="mediaUrl(entry.url)" :alt="`历史图片 ${index + 1}`"><span>{{ frame.url === entry.url ? '当前 · ' : '' }}{{ sourceLabel(entry.source) }}</span><Check v-if="draft.url === entry.url" :size="14" />
                </button>
              </div>
              <img v-if="draft.url && draft.url !== frame.url" class="settings-history-preview" :src="mediaUrl(draft.url)" alt="选中的历史版本">
              <button type="button" class="btn btn-sm" data-testid="frame-use-history" :disabled="readOnly || draft.url === frame.url || !draft.url" @click="saveHistory">使用此版本</button>
              <p class="settings-hint">确认后切换当前图片，保留画面规划。</p>
            </details>
          </aside>
          <div class="settings-fields">
            <p v-if="readOnly" class="settings-notice">当前画面不可编辑，可以查看详情。</p>
            <template v-if="frame.url">
              <label>修改要求<textarea v-model="refinementInstruction" :disabled="readOnly" rows="4" maxlength="4000" aria-label="修改要求" placeholder="例如：保持人物服装和构图，把右手放低。" /></label>
              <fieldset class="settings-methods" :disabled="readOnly">
                <legend>修改方式</legend>
                <label><input v-model="refinementMode" type="radio" value="grid_edit" :disabled="!canRefineGrid" aria-label="保持整组衔接">保持整组衔接<small>参考当前整组宫格，只更新这张画面。</small></label>
                <label><input v-model="refinementMode" type="radio" value="frame_edit" :disabled="!canRefineFrame" aria-label="精修单张细节">精修单张细节<small>使用这张原图，适合调整表情、手部等细节。</small></label>
              </fieldset>
              <p v-if="!canRefineGrid && canRefineFrame" class="settings-hint">整组衔接需要所有画面已有图片；可选择精修单张细节。</p>
              <p v-else-if="!canRefineGrid && !canRefineFrame && !readOnly" class="settings-hint">当前模型或任务状态暂不支持微调。</p>
              <p class="settings-hint">提交后先审核候选，确认采用才会更新图片。</p>
            </template>
            <details class="settings-planning" :open="planningOpen" @toggle="planningOpen = ($event.target as HTMLDetailsElement).open">
              <summary>画面规划</summary>
              <div class="settings-planning-fields">
                <div class="settings-pair">
                  <label>画面名称<input v-model="draft.title" :disabled="readOnly" maxlength="200" placeholder="如：人物推门进入"></label>
                  <label>出现时间点 / 秒<input v-model.number="seconds" :disabled="readOnly" type="number" min="0" :max="maxSeconds" step="0.001" required></label>
                </div>
                <p v-if="invalidTime" class="settings-error" role="alert">时间点需在 0–{{ maxSeconds }} 秒之间。</p>
                <label>静态画面提示词<textarea v-model="draft.prompt" :disabled="readOnly" rows="4" maxlength="20000" placeholder="描述画面中的人物状态、动作、光线与场景。" /></label>
                <label>衔接要求<input v-model="draft.continuity" :disabled="readOnly" maxlength="2000" placeholder="如：服装、人物位置沿用上一格"></label>
                <details class="settings-camera"><summary>景别、视角与构图（可选）</summary><div class="settings-planning-fields">
                  <div class="settings-pair"><label>景别<input v-model="draft.shotType" :disabled="readOnly" :placeholder="panel.shotType || '如：中景'" maxlength="200"></label><label>视角<input v-model="draft.angle" :disabled="readOnly" :placeholder="panel.angle || '如：平视'" maxlength="200"></label></div>
                  <label>构图<input v-model="draft.composition" :disabled="readOnly" maxlength="1000" placeholder="如：人物位于画面右侧"></label>
                </div></details>
                <p class="settings-hint">仅保存规划不会修改图片。重新生成宫格或微调后才更新图片；共享参考素材在镜头绑定区管理。</p>
                <button v-if="frame.url && !readOnly" type="button" class="btn btn-sm" data-testid="frame-save-planning" :disabled="invalidTime" @click="savePlanning">仅保存规划</button>
              </div>
            </details>
          </div>
        </div>
        <footer class="settings-footer">
          <button type="button" class="btn" @click="emit('close')">关闭</button>
          <button v-if="!readOnly && !frame.url" type="button" class="btn btn-primary" data-testid="frame-save-planning" :disabled="invalidTime" @click="savePlanning">仅保存规划</button>
          <button v-if="!readOnly && frame.url" type="button" class="btn btn-primary" data-testid="frame-submit-refine" :disabled="!canRefine" @click="refine"><Sparkles :size="14" />提交微调</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.frame-settings-dialog {
  width: min(1080px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 40px);
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
.settings-body.with-preview { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 24px; }
.settings-preview { min-width: 0; align-self: start; }
.settings-image { aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center; border-radius: var(--radius); overflow: hidden; background: var(--media-surface); color: var(--on-media); }
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
.settings-history > div img { width: 100%; height: 100%; object-fit: contain; }
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
  .settings-image { aspect-ratio: 16/9; }
  .settings-preview > .settings-hint { display: none; }
  .settings-history { margin-top: 8px; }
  .settings-footer { padding: 12px; flex-wrap: wrap; gap: 6px; }
  .settings-footer > span { display: none; }
  .settings-footer .btn { padding: 0 10px; font-size: 12px; }
  .settings-pair { gap: 8px; }
}
.settings-history summary, .settings-planning > summary, .settings-camera > summary { cursor: pointer; color: var(--text-1); font-weight: 600; font-size: 12px; }
.settings-planning { border-top: 1px solid var(--border); padding-top: 14px; }
.settings-planning-fields { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }
.settings-planning-fields > button { align-self: flex-start; }
.settings-methods { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 8px; }
.settings-methods legend { margin-bottom: 8px; font-size: 12px; font-weight: 600; }
.settings-methods > label { position: relative; display: grid; grid-template-columns: 18px 1fr; gap: 2px 7px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.settings-methods input { width: 15px; height: 15px; padding: 0; margin: 2px 0; accent-color: var(--accent); }
.settings-methods small { grid-column: 2; font-weight: 400; color: var(--text-2); font-size: 11px; }
.settings-history-preview { display: block; width: 100%; max-height: 240px; object-fit: contain; background: var(--media-surface); margin: 8px 0; }
.settings-history > p { margin-top: 8px; }
</style>
