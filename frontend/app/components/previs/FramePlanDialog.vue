<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { Loader2, Scissors, Sparkles, Trash2, X } from 'lucide-vue-next'
import { type PanelFramePlan } from '~/composables/usePrevis'

const props = defineProps<{
  plans: PanelFramePlan[]
  count: number
  busy?: boolean
  editable?: boolean
  returnFocus?: HTMLElement
}>()
const emit = defineEmits<{
  close: []
  apply: [plans: PanelFramePlan[]]
  recount: [count: number]
}>()
const COUNT_OPTIONS = [2, 3, 4, 5, 6]
const drafts = ref<PanelFramePlan[]>(JSON.parse(JSON.stringify(props.plans)))
// 窗口先开、结果后到：结果到达时必须刷新草稿，否则一直停在"应用 0 张画面"。
watch(() => props.plans, plans => { drafts.value = JSON.parse(JSON.stringify(plans)) })
const dialog = ref<HTMLDialogElement>()
const titleId = useId()
const descriptionId = useId()
const previousFocus = props.returnFocus
  || (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
const totalFrames = computed(() => drafts.value.reduce((sum, plan) => sum + plan.frames.length, 0))
const aiCount = computed(() => drafts.value.filter(plan => plan.source === 'ai').length)
const canApply = computed(() => !!props.editable && !props.busy && drafts.value.some(plan => plan.frames.length))
const sourceLabel = (plan: PanelFramePlan) => plan.source === 'ai' ? 'AI 拆分' : '规则兜底'

function remove(panelIndex: number, frameIndex: number) {
  if (!props.editable || props.busy) return
  drafts.value[panelIndex].frames.splice(frameIndex, 1)
}
function seconds(value: number) { return (value / 1000).toFixed(1) }
function apply() {
  if (!canApply.value) return
  emit('apply', JSON.parse(JSON.stringify(drafts.value.filter(plan => plan.frames.length))))
}
function onKey(event: KeyboardEvent) {
  event.stopPropagation()
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    apply()
  }
}
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => dialog.value?.close())
onUnmounted(() => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) })
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="frame-plan-dialog"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      @cancel.prevent="emit('close')"
      @click.self="emit('close')"
      @keydown="onKey"
    >
      <header class="plan-header">
        <span class="plan-icon"><Scissors :size="20" /></span>
        <div>
          <h2 :id="titleId">分镜画面拆分方案</h2>
          <p :id="descriptionId">{{ drafts.length }} 个镜头 · {{ totalFrames }} 张画面{{ aiCount ? ` · ${aiCount} 个镜头来自 AI` : ' · 规则兜底' }}</p>
        </div>
        <button type="button" class="btn btn-icon" aria-label="关闭拆分方案" @click="emit('close')"><X :size="18" /></button>
      </header>

      <div class="plan-toolbar">
        <label>
          <span>每个镜头的画面数</span>
          <select :value="count" :disabled="busy" @change="emit('recount', Number(($event.target as HTMLSelectElement).value))">
            <option v-for="option in COUNT_OPTIONS" :key="option" :value="option">{{ option }} 张</option>
          </select>
        </label>
        <span class="plan-hint">调整后会按新数量重新拆分；确认前可自由修改标题与提示词。</span>
      </div>

      <div class="plan-body">
        <div v-if="busy && !drafts.length" class="plan-loading">
          <Loader2 :size="24" class="plan-spin" />
          <strong>正在生成拆分方案…</strong>
          <p>AI 正在按镜头描述拆分画面，通常需要十几秒。</p>
        </div>
        <p v-else-if="busy" class="plan-busy"><Loader2 :size="13" class="plan-spin" />正在按新数量重新拆分…</p>
        <section v-for="(plan, panelIndex) in drafts" :key="plan.panelId" class="plan-panel">
          <header>
            <strong :title="plan.panelTitle">{{ plan.panelTitle }}</strong>
            <span class="plan-source" :class="plan.source"><Sparkles v-if="plan.source === 'ai'" :size="11" />{{ sourceLabel(plan) }}</span>
            <span class="plan-count">{{ plan.frames.length }} 张</span>
          </header>
          <article v-for="(frame, frameIndex) in plan.frames" :key="`${plan.panelId}-${frameIndex}`" class="plan-frame">
            <div class="plan-frame-head">
              <span class="plan-index">{{ String(frameIndex + 1).padStart(2, '0') }}</span>
              <input v-model="frame.title" type="text" maxlength="60" aria-label="画面标题" :disabled="!editable || busy">
              <span class="plan-time">{{ seconds(frame.offsetMs) }}s</span>
              <button
                type="button" class="btn btn-sm plan-remove" :disabled="!editable || busy || plan.frames.length <= 1"
                :aria-label="`移除第 ${frameIndex + 1} 张画面`" :title="`移除第 ${frameIndex + 1} 张画面`"
                @click="remove(panelIndex, frameIndex)"
              ><Trash2 :size="13" /></button>
            </div>
            <textarea v-model="frame.prompt" rows="3" maxlength="4000" aria-label="画面提示词" :disabled="!editable || busy" />
          </article>
          <p v-if="!plan.frames.length" class="plan-empty">这个镜头没有可用的拆分结果，可取消后单独处理。</p>
        </section>
      </div>

      <footer class="plan-footer">
        <span class="plan-tip">应用后只写入画面（标题/提示词/时间点），不会立即生成图片。</span>
        <div class="plan-actions">
          <button type="button" class="btn" :disabled="busy" @click="emit('close')">取消</button>
          <button type="button" class="btn btn-primary" :disabled="!canApply" @click="apply">应用 {{ totalFrames }} 张画面</button>
        </div>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.frame-plan-dialog {
  width: min(760px, calc(100vw - 32px));
  max-height: min(84vh, 900px);
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-0);
  overflow: hidden;
}
.frame-plan-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.plan-header { display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 12px; border-bottom: 1px solid var(--border); }
.plan-icon { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--bg-active); color: var(--accent-text); }
.plan-header > div { flex: 1; min-width: 0; }
.plan-header h2 { margin: 0; font-size: 15px; }
.plan-header p { margin: 2px 0 0; color: var(--text-2); font-size: 11px; }
.plan-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--surface-soft); }
.plan-toolbar label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-1); }
.plan-toolbar select { min-height: 28px; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 11px; }
.plan-hint { color: var(--text-2); font-size: 11px; }
.plan-body { flex: 1; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.plan-busy { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--accent-text); font-size: 11px; }
.plan-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 46px 12px; color: var(--text-2); }
.plan-loading strong { color: var(--text-0); font-size: 13px; }
.plan-loading p { margin: 0; font-size: 11px; }
.plan-panel { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); overflow: hidden; }
.plan-panel > header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.plan-panel strong { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
.plan-source { display: flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 4px; background: var(--bg-active); color: var(--text-2); font-size: 10px; }
.plan-source.ai { color: var(--accent-text); }
.plan-count { color: var(--text-2); font: 10px var(--font-mono); }
.plan-frame { padding: 8px 10px; border-bottom: 1px solid var(--border); }
.plan-frame:last-child { border-bottom: 0; }
.plan-frame-head { display: flex; align-items: center; gap: 6px; }
.plan-index { color: var(--text-3); font: 10px var(--font-mono); }
.plan-frame-head input { flex: 1; min-width: 0; min-height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 12px; }
.plan-time { color: var(--text-2); font: 10px var(--font-mono); }
.plan-remove { width: 28px; min-height: 28px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
.plan-remove:hover:not(:disabled) { background: var(--bg-hover); color: var(--error); }
.plan-frame textarea { width: 100%; margin-top: 6px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 11px; line-height: 1.6; resize: vertical; }
.plan-empty { margin: 0; padding: 10px; color: var(--text-2); font-size: 11px; }
.plan-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--surface-soft); }
.plan-tip { color: var(--text-2); font-size: 11px; }
.plan-actions { display: flex; align-items: center; gap: 6px; }
.plan-spin { animation: plan-spin 1s linear infinite; }
@keyframes plan-spin { to { transform: rotate(360deg); } }
.frame-plan-dialog :disabled { opacity: .5; cursor: not-allowed; }
.frame-plan-dialog button:focus-visible,
.frame-plan-dialog input:focus-visible,
.frame-plan-dialog textarea:focus-visible,
.frame-plan-dialog select:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .plan-spin { animation: none; } }
</style>
