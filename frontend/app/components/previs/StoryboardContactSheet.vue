<script setup lang="ts">
import { computed } from 'vue'
import { Image as ImageIcon, Layers, Loader2, MousePointer2 } from 'lucide-vue-next'
import { FRAME_COUNT_MAX, contactSheetForPanel, mediaUrl, type ContactSheetCell, type ContactSheetView, type Panel } from '~/composables/usePrevis'

const props = withDefaults(defineProps<{
  panel: Panel
  sheet?: ContactSheetView
  compact?: boolean
  activeFrameId?: string
}>(), { compact: false, activeFrameId: '' })
const emit = defineEmits<{ select: [frameId: string, event: Event]; retry: [] }>()
const current = computed(() => contactSheetForPanel(props.panel, props.sheet))
const status = computed(() => current.value?.status || 'none')
const readyCount = computed(() => props.panel.frames.filter(frame => frame.url).length)
const label = computed(() => status.value === 'ready'
  ? readyCount.value === props.panel.frames.length ? '全部画面已就绪' : `${props.panel.frames.length - readyCount.value} 张画面待生成`
  : ({ none: '宫格等待合成', composing: '正在更新画面预览', stale: '画面已更新，等待预览', failed: '预览合成失败' }[status.value]))
const source = computed(() => current.value?.status === 'ready'
  ? props.compact ? current.value.thumbnailUrl : current.value.cleanUrl || current.value.annotatedUrl : null)
const blankCells = computed(() => {
  const descriptor = current.value?.descriptor
  if (!descriptor) return []
  const { columns, rows, width, height, cells } = descriptor
  return Array.from({ length: columns * rows - cells.length }, (_, i) => {
    const index = cells.length + i, col = index % columns, row = Math.floor(index / columns)
    const left = Math.floor(col * width / columns), top = Math.floor(row * height / rows)
    return { left, top, width: Math.floor((col + 1) * width / columns) - left,
      height: Math.floor((row + 1) * height / rows) - top }
  })
})
function cellStyle(cell: Pick<ContactSheetCell, 'left' | 'top' | 'width' | 'height'>) {
  const descriptor = current.value?.descriptor
  if (!descriptor) return {}
  return { left: `${cell.left / descriptor.width * 100}%`, top: `${cell.top / descriptor.height * 100}%`,
    width: `${cell.width / descriptor.width * 100}%`, height: `${cell.height / descriptor.height * 100}%` }
}
function select(frameId: string, event: Event) { emit('select', frameId, event) }
</script>

<template>
  <div class="storyboard-sheet" :class="{ compact }" :data-status="status">
    <div v-if="source" class="sheet-image">
      <img :src="mediaUrl(source)" :alt="`${panel.title}的分镜宫格`" loading="lazy">
      <svg v-if="compact && current?.descriptor" class="sheet-thumbnail-placeholders"
        :viewBox="`0 0 ${current.descriptor.width} ${current.descriptor.height}`" aria-hidden="true">
        <rect v-for="cell in [...current.descriptor.cells.filter(cell => !cell.url), ...blankCells]"
          :key="`${cell.left}-${cell.top}`" :x="cell.left" :y="cell.top" :width="cell.width" :height="cell.height" vector-effect="non-scaling-stroke" />
      </svg>
      <ImageIcon v-if="compact && !readyCount" class="sheet-compact-symbol" :size="12" aria-hidden="true" />
      <template v-if="!compact">
        <span v-for="(cell, index) in blankCells" :key="`blank-${index}`" class="sheet-blank" :style="cellStyle(cell)" aria-hidden="true" />
        <button v-for="cell in current?.descriptor?.cells || []" :key="cell.frameId" type="button"
          class="sheet-cell" :class="{ active: activeFrameId === cell.frameId, 'is-empty': !cell.url }" :style="cellStyle(cell)"
          :aria-label="`编辑画面 ${cell.index}，${(cell.offsetMs / 1000).toFixed(1)} 秒`"
          @click="select(cell.frameId, $event)">
          <span class="sheet-cell-number">{{ String(cell.index).padStart(2, '0') }}</span>
          <span v-if="!cell.url" class="sheet-cell-placeholder"><span class="sheet-cell-icon"><ImageIcon :size="22" :stroke-width="1.4" /></span><strong>待生成画面</strong></span>
          <span class="sheet-cell-time">{{ (cell.offsetMs / 1000).toFixed(1) }}s</span>
          <span class="sheet-cell-edit"><MousePointer2 :size="11" />编辑画面</span>
        </button>
      </template>
    </div>
    <div v-else class="sheet-placeholder" :role="compact ? undefined : 'status'">
      <span class="sheet-placeholder-icon"><Loader2 v-if="status === 'composing'" class="sheet-spinner" :size="22" /><Layers v-else :size="22" :stroke-width="1.5" /></span>
      <strong>{{ label }}</strong>
      <small v-if="!compact">{{ panel.frames.filter(frame => frame.url).length }} / {{ panel.frames.length }} 张画面已就绪</small>
    </div>
    <div v-if="!compact" class="sheet-caption">
      <span class="sheet-caption-state" :class="{ ready: status === 'ready' && readyCount === panel.frames.length }"><i />{{ label }}</span>
      <small v-if="status === 'ready'">点击格子编辑 · 按时间排序</small>
      <button v-if="status === 'failed' || status === 'stale' || status === 'none'" type="button" class="btn btn-sm"
        :disabled="!panel.frames.length || panel.frames.length > FRAME_COUNT_MAX" @click="emit('retry')">重新合成</button>
    </div>
    <p v-if="!compact && current?.error" class="sheet-error">{{ current.error }}</p>
  </div>
</template>

<style scoped>
.storyboard-sheet { min-width: 0; width: 100%; container-type: inline-size; }
.sheet-image { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-raised); }
.sheet-image img { display: block; width: 100%; height: auto; object-fit: contain; }
.sheet-cell, .sheet-blank { position: absolute; box-sizing: border-box; }
.sheet-cell {
  appearance: none; display: block; margin: 0; padding: 0; min-height: 0; border: 3px solid var(--surface-raised);
  border-radius: 0; background: transparent; color: var(--on-media); box-shadow: none; cursor: pointer;
  transition: box-shadow .16s, background .16s; letter-spacing: 0;
}
.sheet-cell > span { pointer-events: none; }
.sheet-cell.is-empty { background: var(--surface-soft); color: var(--text-2); }
.sheet-cell:hover:not(:disabled), .sheet-cell.active { background: color-mix(in srgb, var(--accent) 8%, transparent); box-shadow: inset 0 0 0 2px var(--accent); }
.sheet-cell.is-empty:hover:not(:disabled), .sheet-cell.is-empty.active { background: color-mix(in srgb, var(--accent-bg) 55%, var(--surface-soft)); }
.sheet-cell:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -4px; }
.sheet-cell-number, .sheet-cell-time { position: absolute; display: inline-flex; align-items: center; justify-content: center; line-height: 1; font-family: var(--font-mono); }
.sheet-cell-number { left: 7px; top: 7px; min-width: 25px; height: 23px; padding: 0 5px; border-radius: 6px; background: var(--scrim); color: var(--on-media); font-size: 11px; font-weight: 650; backdrop-filter: blur(6px); }
.sheet-cell-time { left: 7px; bottom: 7px; padding: 4px 5px; border-radius: 4px; background: var(--scrim); color: var(--on-media); font-size: 10px; }
.is-empty .sheet-cell-number { background: var(--surface-raised); color: var(--text-2); border: 1px solid var(--border); backdrop-filter: none; }
.is-empty .sheet-cell-time { background: transparent; color: var(--text-3); }
.sheet-cell-placeholder { position: absolute; inset: 28px 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.sheet-cell-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-raised); color: var(--text-3); }
.sheet-cell-placeholder strong { font-size: 11px; font-weight: 500; color: var(--text-3); }
.sheet-cell-edit { position: absolute; right: 7px; bottom: 7px; display: inline-flex; align-items: center; gap: 3px; padding: 4px 6px; border-radius: 4px; background: var(--accent); color: var(--on-accent); font-size: 9px; line-height: 1; opacity: 0; transition: opacity .16s; }
.sheet-cell:hover .sheet-cell-edit, .sheet-cell:focus-visible .sheet-cell-edit { opacity: 1; }
.sheet-blank { border: 3px solid var(--surface-raised); background: repeating-linear-gradient(135deg, var(--surface-soft), var(--surface-soft) 5px, var(--surface-muted) 5px, var(--surface-muted) 6px); }
.sheet-thumbnail-placeholders { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.sheet-thumbnail-placeholders rect { fill: var(--surface-soft); stroke: var(--border); stroke-width: .5; }
.sheet-compact-symbol { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: var(--text-3); pointer-events: none; }
.sheet-placeholder { min-height: 154px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 18px; border: 1px dashed var(--border-strong); border-radius: 10px; background: var(--surface-soft); color: var(--text-2); text-align: center; }
.sheet-placeholder-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-raised); color: var(--text-3); }
.sheet-placeholder strong { font-size: 12px; font-weight: 500; }
.sheet-placeholder small, .sheet-caption { font-size: 10px; }
.sheet-caption { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; margin-top: 10px; color: var(--text-2); line-height: 1.5; }
.sheet-caption-state { display: inline-flex; align-items: center; gap: 5px; }
.sheet-caption-state i { width: 5px; height: 5px; border-radius: 50%; background: var(--text-3); }
.sheet-caption-state.ready { color: var(--success); }
.sheet-caption-state.ready i { background: currentColor; }
.sheet-caption > small { font-size: 10px; color: var(--text-3); }
.sheet-error { margin: 6px 0 0; color: var(--error); font-size: 11px; overflow-wrap: anywhere; }
.compact .sheet-placeholder { min-height: 0; height: 100%; padding: 4px; gap: 2px; }
.compact .sheet-placeholder-icon { width: auto; height: auto; border: 0; background: none; }
.compact .sheet-placeholder-icon svg { width: 15px; height: 15px; }
.compact .sheet-placeholder strong { display: none; }
.compact { height: 100%; }
.compact .sheet-image { height: 100%; display: flex; align-items: center; border: 0; border-radius: inherit; }
.compact .sheet-image img { height: 100%; object-fit: contain; }
.compact .sheet-blank { border-width: 1px; }
.sheet-spinner { animation: sheet-spin 1s linear infinite; }
@keyframes sheet-spin { to { transform: rotate(360deg); } }
@container (max-width: 360px) {
  .sheet-cell-number { left: 4px; top: 4px; min-width: 20px; height: 20px; font-size: 10px; }
  .sheet-cell-time { left: 4px; bottom: 4px; font-size: 9px; }
  .sheet-cell-icon { width: 28px; height: 28px; border-radius: 8px; }
  .sheet-cell-icon svg { width: 17px; height: 17px; }
  .sheet-cell-placeholder { gap: 4px; }
  .sheet-cell-placeholder strong { font-size: 9px; }
  .sheet-cell-edit { font-size: 0; padding: 4px; right: 4px; bottom: 4px; gap: 0; }
}
@container (max-width: 280px) { .sheet-cell-placeholder strong { display: none; } }
@media (prefers-reduced-motion: reduce) { .sheet-spinner { animation: none; } .sheet-cell, .sheet-cell-edit { transition: none; } }
</style>
