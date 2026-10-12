<script setup lang="ts">
import { computed } from 'vue'
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
const label = computed(() => ({ none: '宫格等待合成', composing: '正在合成宫格…', ready: '宫格已就绪', stale: '画面已更新，宫格待合成', failed: '宫格合成失败' }[status.value]))
const source = computed(() => current.value?.status === 'ready'
  ? props.compact ? current.value.thumbnailUrl : current.value.annotatedUrl : null)
function cellStyle(cell: ContactSheetCell) {
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
      <template v-if="!compact">
        <button v-for="cell in current?.descriptor?.cells || []" :key="cell.frameId" type="button"
          class="sheet-cell" :class="{ active: activeFrameId === cell.frameId }" :style="cellStyle(cell)"
          :aria-label="`编辑画面 ${cell.index}，${(cell.offsetMs / 1000).toFixed(1)} 秒`"
          @click="select(cell.frameId, $event)" />
      </template>
    </div>
    <div v-else class="sheet-placeholder" :role="compact ? undefined : 'status'">
      <span :class="{ 'sheet-spinner': status === 'composing' }">▦</span>
      <strong>{{ label }}</strong>
      <small v-if="!compact">{{ panel.frames.filter(frame => frame.url).length }} / {{ panel.frames.length }} 张画面已就绪</small>
    </div>
    <div v-if="!compact" class="sheet-caption">
      <span>{{ label }}<small v-if="status === 'ready'"> · 点击画面编辑</small></span>
      <button v-if="status === 'failed' || status === 'stale' || status === 'none'" type="button" class="btn btn-sm"
        :disabled="!panel.frames.length || panel.frames.length > FRAME_COUNT_MAX" @click="emit('retry')">重新合成</button>
    </div>
    <p v-if="!compact && current?.error" class="sheet-error">{{ current.error }}</p>
  </div>
</template>

<style scoped>
.storyboard-sheet { min-width: 0; width: 100%; }
.sheet-image { position: relative; overflow: hidden; border-radius: var(--radius-sm); background: var(--surface-soft); }
.sheet-image img { display: block; width: 100%; height: auto; object-fit: contain; }
.sheet-cell { position: absolute; appearance: none; border: 1px solid transparent; border-radius: 0; background: transparent; cursor: pointer; }
.sheet-cell:hover, .sheet-cell.active { border: 2px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.sheet-cell:focus-visible { outline: 3px solid var(--border-focus); outline-offset: -4px; }
.sheet-placeholder { min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 14px; border: 1px dashed var(--border); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--text-2); text-align: center; }
.sheet-placeholder > span { font-size: 28px; }
.sheet-placeholder strong { font-size: 12px; font-weight: 500; }
.sheet-placeholder small, .sheet-caption { font-size: 10px; }
.sheet-caption { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 8px; color: var(--text-2); }
.sheet-error { margin: 6px 0 0; color: var(--error); font-size: 11px; overflow-wrap: anywhere; }
.compact .sheet-placeholder { min-height: 0; height: 100%; padding: 4px; gap: 2px; }
.compact .sheet-placeholder > span { font-size: 20px; }
.compact .sheet-placeholder strong { font-size: 9px; }
.compact { height: 100%; }
.compact .sheet-image { height: 100%; display: flex; align-items: center; }
.compact .sheet-image img { height: 100%; object-fit: contain; }
.sheet-spinner { animation: sheet-pulse 1s ease-in-out infinite alternate; }
@keyframes sheet-pulse { to { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .sheet-spinner { animation: none; } }
</style>
