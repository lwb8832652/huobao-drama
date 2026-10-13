<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { Loader2, Scissors, Sparkles, Trash2, X } from 'lucide-vue-next'
import { gridLayoutsForRatio, type PanelFramePlan } from '~/composables/usePrevis'

const props = defineProps<{
  plans: PanelFramePlan[]
  count: number
  busy?: boolean
  editable?: boolean
  aspectRatio?: string
  returnFocus?: HTMLElement
}>()
const emit = defineEmits<{
  close: []
  apply: [plans: PanelFramePlan[]]
  recount: [count: number]
}>()
/** 景别/机位用固定枚举而非自由输入：生图模型对枚举外的词（如「中近景」）解析不稳定。 */
const SHOT_TYPE_OPTIONS = ['', '远景', '全景', '中景', '近景', '特写']
const ANGLE_OPTIONS = ['', '平视', '俯拍', '仰拍', '侧拍', '过肩']
const drafts = ref<PanelFramePlan[]>(JSON.parse(JSON.stringify(props.plans)))
const requestedCount = ref(props.count)
watch(() => props.count, count => { requestedCount.value = count })
// 窗口先开、结果后到：结果到达时必须刷新草稿，否则一直停在"应用 0 张画面"。
watch(() => props.plans, plans => { drafts.value = JSON.parse(JSON.stringify(plans)) })
const dialog = ref<HTMLDialogElement>()
const titleId = useId()
const descriptionId = useId()
const previousFocus = props.returnFocus
  || (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
const totalFrames = computed(() => drafts.value.reduce((sum, plan) => sum + plan.frames.length, 0))
const layoutOptions = computed(() => gridLayoutsForRatio(props.aspectRatio))
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
function replan() {
  if (props.editable && !props.busy) emit('recount', requestedCount.value)
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
          <h2 :id="titleId">宫格画面规划</h2>
          <p :id="descriptionId">{{ drafts.length }} 个镜头 · {{ totalFrames }} 张画面{{ aiCount ? ` · ${aiCount} 个镜头来自 AI` : ' · 规则兜底' }}</p>
        </div>
        <button type="button" class="btn btn-icon" aria-label="关闭拆分方案" @click="emit('close')"><X :size="18" /></button>
      </header>

      <div class="plan-toolbar">
        <label>
          <span>目标画面数</span>
          <select v-model.number="requestedCount" :disabled="busy || !editable">
            <option v-for="layout in layoutOptions" :key="layout.count" :value="layout.count">{{ layout.label }} · {{ layout.count }} 张</option>
          </select>
        </label>
        <button type="button" class="btn btn-sm" :disabled="busy || !editable" @click="replan"><Sparkles :size="12" />重新规划</button>
        <span class="plan-hint">选择数量后点击重新规划。下方按时间排列，每格描述一个静态瞬间。</span>
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
          <details class="plan-shared-details"><summary>人物、场景与整组约束</summary><label class="plan-continuity">
            <span>整组连续性约束</span>
            <textarea v-model="plan.continuityConstraints" rows="2" maxlength="4000" aria-label="整组连续性约束" placeholder="人物、服装、背景、轴线和光线等需要保持一致的条件" :disabled="!editable || busy" />
          </label></details>
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
            <details class="plan-frame-details"><summary>衔接与镜头设置</summary>
            <label class="plan-frame-continuity"><span>与前后画面的衔接</span><textarea v-model="frame.continuity" rows="2" maxlength="2000" aria-label="画面连续性要求" placeholder="例如：人物位置和视线沿用上一画面，仅抬起右手" :disabled="!editable || busy" /></label>
            <div class="plan-camera">
              <label>
                <span>景别</span>
                <select v-model="frame.shotType" aria-label="画面景别" :disabled="!editable || busy">
                  <option v-for="option in SHOT_TYPE_OPTIONS" :key="option || 'unset'" :value="option">
                    {{ option || '沿用镜头默认' }}
                  </option>
                </select>
              </label>
              <label>
                <span>机位</span>
                <select v-model="frame.angle" aria-label="画面机位" :disabled="!editable || busy">
                  <option v-for="option in ANGLE_OPTIONS" :key="option || 'unset'" :value="option">
                    {{ option || '沿用镜头默认' }}
                  </option>
                </select>
              </label>
              <label class="plan-composition">
                <span>构图</span>
                <input
                  v-model="frame.composition" type="text" maxlength="500"
                  placeholder="主体位置、前景遮挡、引导线（可留空）" aria-label="画面构图"
                  :disabled="!editable || busy"
                >
              </label>
            </div>
            </details>
          </article>
          <p v-if="!plan.frames.length" class="plan-empty">这个镜头没有可用的拆分结果，可取消后单独处理。</p>
        </section>
      </div>

      <footer class="plan-footer">
        <span class="plan-tip">应用后写入画面规划与连续性约束，保留已有图片，不会立即生成图片。</span>
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
  margin: auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text-0);
  overflow: hidden;
}
.frame-plan-dialog::backdrop { background: rgb(0 0 0 / 55%); }
.plan-header { display: flex; flex-shrink: 0; align-items: flex-start; gap: 10px; padding: 14px 14px 12px; border-bottom: 1px solid var(--border); }
.plan-icon { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--bg-active); color: var(--accent-text); }
.plan-header > div { flex: 1; min-width: 0; }
.plan-header h2 { margin: 0; font-size: 15px; }
.plan-header p { margin: 2px 0 0; color: var(--text-2); font-size: 11px; }
.plan-toolbar { display: flex; flex-shrink: 0; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--surface-soft); }
.plan-toolbar label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-1); }
.plan-toolbar select { min-height: 28px; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 11px; }
.plan-hint { color: var(--text-2); font-size: 11px; }
.plan-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
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
.plan-frame-details, .plan-shared-details { font-size: 11px; color: var(--text-2); }
.plan-frame-details summary, .plan-shared-details summary { padding: 8px 0; cursor: pointer; }
.plan-shared-details { padding: 0 10px; border-bottom: 1px solid var(--border); }
.plan-continuity { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; font-size: 11px; color: var(--text-2); background: var(--surface-soft); }
.plan-continuity textarea { padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font: inherit; line-height: 1.6; resize: vertical; }
.plan-frame-continuity { display: block; margin-top: 7px; font-size: 11px; color: var(--text-2); }
.plan-frame:last-child { border-bottom: 0; }
.plan-frame-head { display: flex; align-items: center; gap: 6px; }
.plan-index { color: var(--text-3); font: 10px var(--font-mono); }
.plan-frame-head input { flex: 1; min-width: 0; min-height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 12px; }
.plan-time { color: var(--text-2); font: 10px var(--font-mono); }
.plan-remove { width: 28px; min-height: 28px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
.plan-remove:hover:not(:disabled) { background: var(--bg-hover); color: var(--error); }
.plan-frame textarea { width: 100%; margin-top: 6px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 11px; line-height: 1.6; resize: vertical; }
.plan-camera { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; }
.plan-camera label { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 11px; color: var(--text-2); }
.plan-camera label > span { flex-shrink: 0; }
.plan-camera select { min-height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 11px; }
.plan-composition { flex: 1; min-width: 200px; }
.plan-composition input { flex: 1; min-width: 0; min-height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-0); font-size: 11px; }
.plan-composition input::placeholder { color: var(--text-3); }
.plan-empty { margin: 0; padding: 10px; color: var(--text-2); font-size: 11px; }
.plan-footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--surface-soft); }
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
