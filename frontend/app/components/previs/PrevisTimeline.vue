<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { Film, Images, Minus, Plus } from 'lucide-vue-next'
import { posterOf } from '~/composables/useMedia'
import {
  durationMs, formatTime, frameKey, mediaUrl, orderedFrames, timelineSegments,
  type Keyframe, type Panel, type Timeline,
} from '~/composables/usePrevis'
type Segment = ReturnType<typeof timelineSegments>[number]
const props = defineProps<{
  timeline: Timeline; currentMs: number; groupId: string; activeFrameId: string
  videoPreview: boolean; videoSources: Record<number, { url: string; offsetMs: number }>
  editable: boolean
}>()
const emit = defineEmits<{
  seek: [ms: number]; select: [groupId: string, panelId?: number]; audio: [id: string]
  duration: [panelId: number, ms: number]; moveAudio: [id: string, startMs: number, durationMs: number]
}>()
const zoom = ref(100), tracks = ref<HTMLElement>()
const segments = computed(() => timelineSegments(props.timeline)), total = computed(() => Math.max(1000, durationMs(props.timeline)))
const baseTrackWidth = computed(() => Math.max(720, segments.value.reduce((width, segment) =>
  width + Math.max(140, (props.videoPreview && videoSource(segment.panel.id)
    ? 1 : orderedFrames(segment.panel).filter(frame => frame.url).length) * 44), 0)))
const tracksWidth = computed(() => `max(${zoom.value}%, ${Math.round(baseTrackWidth.value * zoom.value / 100)}px)`)
const pos = (ms: number) => `${ms / total.value * 100}%`
const ticks = computed(() => Array.from({ length: 11 }, (_, i) => total.value * i / 10))
const availableFrames = (panel: Panel) => orderedFrames(panel).filter(frame => frame.url)
const videoSource = (panelId: number) => props.videoSources[panelId]?.url ? props.videoSources[panelId] : null
function videoPoster(panel: Panel, source: { url: string }) {
  return posterOf(mediaUrl(source.url)) || (availableFrames(panel)[0]?.url ? mediaUrl(availableFrames(panel)[0].url) : '')
}
function frameOffset(panel: Panel, frame: Keyframe) {
  return Math.max(0, Math.min(Math.max(0, panel.durationMs - 1), frame.offsetMs || 0))
}
function frameMarker(index: number) {
  return `图 ${String(index + 1).padStart(2, '0')}`
}
function selectFrame(segment: Segment, frame: Keyframe) {
  emit('select', segment.groupId, segment.panel.id)
  emit('seek', segment.startMs + frameOffset(segment.panel, frame))
}
function selectPanel(segment: Segment) {
  emit('select', segment.groupId, segment.panel.id)
  emit('seek', segment.startMs)
}
const dragging = ref<{ id: string; startMs: number; durationMs: number } | null>(null)
let cleanupDrag = () => {}
let ignoreClickUntil = 0
function openAudio(id: string) {
  if (Date.now() >= ignoreClickUntil) emit('audio', id)
}
function drag(event: PointerEvent, kind: 'move' | 'trim' | 'panel', id: string | number) {
  if (!props.editable || !tracks.value) return
  event.preventDefault(); event.stopPropagation()
  const panel = segments.value.find(s => s.panel.id === id)?.panel
  const clip = props.timeline.audio.find(c => c.id === id)
  const start = clip?.startMs || 0, duration = clip?.durationMs || panel?.durationMs || 1000
  const x = event.clientX, scale = total.value / tracks.value.getBoundingClientRect().width
  let moved = false
  dragging.value = { id: String(id), startMs: start, durationMs: duration }
  function move(e: PointerEvent) {
    if (Math.abs(e.clientX - x) > 3) moved = true
    const delta = Math.round((e.clientX - x) * scale / 100) * 100
    dragging.value = {
      id: String(id), startMs: kind === 'move' ? Math.max(0, Math.min(total.value - 100, start + delta)) : start,
      durationMs: kind === 'move' ? duration : Math.max(100, duration + delta),
    }
  }
  function end() {
    const value = dragging.value
    cleanupDrag()
    if (!value || !moved) return
    ignoreClickUntil = Date.now() + 300
    if (kind === 'panel') emit('duration', Number(id), value.durationMs)
    else emit('moveAudio', String(id), value.startMs, value.durationMs)
  }
  cleanupDrag = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', cleanupDrag); dragging.value = null
  }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', cleanupDrag)
}
function clipStyle(clip: { id: string; startMs: number; durationMs: number }) {
  const value = dragging.value?.id === clip.id ? dragging.value : clip
  return { left: pos(value.startMs), width: pos(value.durationMs) }
}
function seekRuler(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit('seek', (event.clientX - rect.left) / rect.width * total.value)
}
onUnmounted(() => cleanupDrag())
</script>

<template>
  <section class="pv-timeline">
    <header class="pv-timeline-header"><div><span class="pv-eyebrow">时间轴</span><b>{{ timeline.panels.length }} 个分镜 · {{ formatTime(total) }}</b></div><small>拖动音频调整位置，拖动片段右边缘调整时长</small><div class="pv-zoom"><button aria-label="缩小时间线" :disabled="zoom <= 100" @click="zoom -= 25"><Minus :size="14" /></button><span>{{ zoom }}%</span><button aria-label="放大时间线" :disabled="zoom >= 400" @click="zoom += 25"><Plus :size="14" /></button></div></header>
    <div class="pv-track-layout">
      <div class="pv-track-labels"><span>时间</span><span>镜头 / 画面</span><span>对白</span><span>旁白</span><span>声音</span></div>
      <div class="pv-track-scroll">
        <div ref="tracks" class="pv-tracks" :style="{ width: tracksWidth }">
          <div class="pv-ruler" @click="seekRuler"><span v-for="tick in ticks" :key="tick" :style="{ left: pos(tick) }">{{ formatTime(tick) }}</span></div>
          <div class="pv-track pv-frame-track"><div v-for="s in segments" :key="s.panel.id" class="pv-frame-clip" :class="{ active: groupId === s.groupId, 'is-fallback': videoPreview && !videoSource(s.panel.id) }" :style="{ left: pos(s.startMs), width: pos(dragging?.id === String(s.panel.id) ? dragging.durationMs : s.panel.durationMs) }">
            <button
              v-if="videoPreview && videoSource(s.panel.id)"
              type="button"
              class="pv-video-thumb"
              :class="{ active: currentMs >= s.startMs && currentMs < s.endMs }"
              :aria-label="`选择视频 ${s.panel.title}`"
              :aria-pressed="currentMs >= s.startMs && currentMs < s.endMs"
              :title="`${s.panel.title} · 生成视频`"
              @click="selectPanel(s)"
            >
              <video :src="mediaUrl(videoSource(s.panel.id)!.url)" :poster="videoPoster(s.panel, videoSource(s.panel.id)!) || undefined" muted playsinline preload="none" tabindex="-1" aria-hidden="true" />
              <span class="pv-media-kind"><Film :size="9" />视频</span>
            </button>
            <div v-else-if="availableFrames(s.panel).length" class="pv-frame-strip">
              <button
                v-for="(frame, index) in availableFrames(s.panel)"
                :key="frameKey(frame)"
                type="button"
                class="pv-frame-thumb"
                :class="{ active: activeFrameId === frameKey(frame) }"
                :aria-label="`选择 ${s.panel.title} · ${frame.title || `画面 ${index + 1}`} · ${(frameOffset(s.panel, frame) / 1000).toFixed(1)} 秒`"
                :aria-pressed="activeFrameId === frameKey(frame)"
                :title="`${frame.title || `画面 ${index + 1}`} · ${(frameOffset(s.panel, frame) / 1000).toFixed(1)}s`"
                @click="selectFrame(s, frame)"
              ><img :src="mediaUrl(frame.url)" :alt="frame.title || '分镜画面'" loading="lazy"><span class="pv-frame-mark"><Images :size="8" />{{ frameMarker(index) }}</span></button>
            </div>
            <button v-else type="button" class="pv-frame-empty" :title="`${s.panel.title} · 暂无可用画面`" @click="selectPanel(s)">暂无画面</button>
            <span v-if="videoPreview && !videoSource(s.panel.id)" class="pv-media-kind fallback"><Images :size="9" />分镜回退</span>
            <span class="pv-frame-title">{{ s.panel.title }}</span>
            <span v-if="editable" class="pv-trim" title="拖动调整分镜时长" @pointerdown="drag($event, 'panel', s.panel.id)" />
          </div></div>
          <div v-for="type in (['dialogue', 'narration', 'sound'] as const)" :key="type" class="pv-track pv-audio-track" :class="type">
            <div v-for="clip in timeline.audio.filter(c => c.type === type)" :key="clip.id" class="pv-audio-clip" :style="clipStyle(clip)">
              <button :title="clip.text || '音频片段'" @click="openAudio(clip.id)" @pointerdown="drag($event, 'move', clip.id)">{{ clip.character }} {{ clip.text || '音频片段' }}</button><span v-if="editable" class="pv-trim" title="拖动调整音频时长" @pointerdown="drag($event, 'trim', clip.id)" />
            </div>
          </div>
          <div class="pv-playhead" :style="{ left: pos(currentMs) }"><i /></div>
        </div>
      </div>
    </div>
  </section>
</template>
