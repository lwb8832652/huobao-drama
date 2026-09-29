<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Clapperboard, Film, Images, Maximize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-vue-next'
import { posterOf } from '~/composables/useMedia'
import { durationMs, formatTime, mediaUrl, orderedFrames, timelineSegments, type Timeline } from '~/composables/usePrevis'

type PlayerView = 'storyboard' | 'video' | 'script'

const props = defineProps<{
  timeline: Timeline; currentMs: number; view: PlayerView
  videoSources: Record<number, { url: string; offsetMs: number }>
  storyboardIsVideoInput: boolean
}>()
const emit = defineEmits<{ seek: [ms: number]; playing: [value: boolean] }>()
const playing = ref(false), muted = ref(false), volume = ref(1), rate = ref(1), expanded = ref(false)
const video = ref<HTMLVideoElement>(), canvas = ref<HTMLElement>(), failedVideos = ref<string[]>([])
const segments = computed(() => timelineSegments(props.timeline)), total = computed(() => durationMs(props.timeline))
const segment = computed(() => segments.value.find(s => props.currentMs >= s.startMs && props.currentMs < s.endMs) || segments.value.at(-1))
const frame = computed(() => {
  const s = segment.value
  if (!s) return ''
  const offset = props.currentMs - s.startMs
  return orderedFrames(s.panel).filter(f => f.url && (f.offsetMs || 0) <= offset).at(-1)?.url
    || orderedFrames(s.panel).find(f => f.url)?.url || ''
})
const motionStyle = computed(() => {
  const s = segment.value
  if (!s) return {}
  const ratio = Math.max(0, Math.min(1, (props.currentMs - s.startMs) / s.panel.durationMs))
  return { transform: /摇|移|跟/.test(s.panel.movement) ? `scale(1.06) translateX(${(ratio - .5) * 4}%)`
    : /推|拉/.test(s.panel.movement) ? `scale(${1 + ratio * .055})` : 'none' }
})
const videoSource = computed(() => {
  const s = segment.value
  if (!s) return null
  if (Object.prototype.hasOwnProperty.call(props.videoSources, s.panel.id)) {
    return props.videoSources[s.panel.id]?.url ? props.videoSources[s.panel.id] : null
  }
  return s.panel.videoUrl ? { url: s.panel.videoUrl, offsetMs: 0 } : null
})
const playableVideoSource = computed(() =>
  props.view === 'video' && videoSource.value && !failedVideos.value.includes(videoSource.value.url)
    ? videoSource.value
    : null)
const videoPoster = computed(() => playableVideoSource.value
  ? posterOf(mediaUrl(playableVideoSource.value.url)) || (frame.value ? mediaUrl(frame.value) : '')
  : '')
const playableView = computed(() => props.view === 'storyboard' || props.view === 'video')
const timelineAudioEnabled = computed(() => !playableVideoSource.value)
const sourceLabel = computed(() => props.view === 'storyboard'
  ? `分镜预演 · ${props.storyboardIsVideoInput ? '视频输入' : '非视频输入'}`
  : playableVideoSource.value ? '生成视频' : '分镜回退')
const emptyTitle = computed(() => props.view === 'video' ? '视频与分镜画面均未就绪' : '分镜画面等待就绪')
const emptyHint = computed(() => props.view === 'video' ? '当前镜头生成视频缺失，且没有可回退的分镜画面' : '为当前分镜生成或上传画面，开始预演')
const activeClips = computed(() => props.timeline.audio.filter(a => props.currentMs >= a.startMs && props.currentMs < a.startMs + a.durationMs))
const caption = computed(() => activeClips.value.filter(a => a.type !== 'sound').map(a => `${a.character ? `${a.character}：` : ''}${a.text}`).join('\n'))
const audioElements = new Map<string, { url: string; el: HTMLAudioElement }>()
let animation = 0, lastTick = 0, lastAudioTick = 0
function stop() { playing.value = false }
function seek(ms: number) {
  emit('seek', Math.max(0, Math.min(total.value, ms)))
  void nextTick(syncMedia)
}
function toggle() {
  if (!total.value) return
  if (!playing.value && props.currentMs >= total.value) seek(0)
  playing.value = !playing.value
}
function skip(direction: number) {
  const index = segments.value.findIndex(s => s === segment.value)
  seek(segments.value[Math.max(0, Math.min(segments.value.length - 1, index + direction))]?.startMs || 0)
}
function toggleMute() {
  if (muted.value && volume.value === 0) volume.value = 1
  muted.value = !muted.value
}
function setVolume(event: Event) {
  volume.value = Math.max(0, Math.min(1, Number((event.target as HTMLInputElement).value) / 100))
  muted.value = volume.value === 0
}
function markVideoFailed(url: string) {
  if (url && !failedVideos.value.includes(url)) failedVideos.value.push(url)
  void nextTick(syncMedia)
}
function syncMedia() {
  const targetVideo = video.value, s = segment.value, source = playableVideoSource.value
  if (targetVideo && s && source) {
    const target = Math.max(0, (props.currentMs - s.startMs + source.offsetMs) / 1000)
    if (Number.isFinite(targetVideo.duration) && Math.abs(targetVideo.currentTime - target) > .3) {
      targetVideo.currentTime = Math.min(target, Math.max(0, targetVideo.duration - .03))
    }
    targetVideo.muted = muted.value; targetVideo.volume = volume.value; targetVideo.playbackRate = rate.value
    if (playing.value && target < (targetVideo.duration || Infinity)) void targetVideo.play().catch(() => {})
    else targetVideo.pause()
  } else targetVideo?.pause()
  const active = new Set(timelineAudioEnabled.value ? activeClips.value.map(c => c.id) : [])
  for (const [id, { el }] of audioElements) if (!active.has(id) || !playing.value) el.pause()
  if (!timelineAudioEnabled.value) return
  for (const clip of activeClips.value) {
    if (clip.url) {
      let source = audioElements.get(clip.id)
      if (!source || source.url !== clip.url) {
        source?.el.pause()
        source = { url: clip.url, el: new Audio(mediaUrl(clip.url)) }
        audioElements.set(clip.id, source)
      }
      const audio = source.el, target = (props.currentMs - clip.startMs) / 1000
      if (Math.abs(audio.currentTime - target) > .3) audio.currentTime = target
      audio.muted = muted.value; audio.volume = volume.value; audio.playbackRate = rate.value
      if (playing.value && target < (audio.duration || Infinity)) void audio.play().catch(() => {})
    }
  }
}
function tick(now: number) {
  if (!playing.value) return
  const elapsed = Math.min(now - lastTick, 250) * rate.value
  lastTick = now
  const next = Math.min(total.value, props.currentMs + elapsed)
  emit('seek', next)
  if (now - lastAudioTick > 100) { syncMedia(); lastAudioTick = now }
  if (next >= total.value) stop()
  else animation = requestAnimationFrame(tick)
}
watch(playing, value => {
  emit('playing', value); cancelAnimationFrame(animation)
  if (value) { lastTick = performance.now(); animation = requestAnimationFrame(tick) }
  syncMedia()
})
watch([muted, volume, rate], syncMedia)
watch(() => playableVideoSource.value?.url, () => {
  video.value?.pause()
  void nextTick(syncMedia)
})
watch(() => props.view, () => {
  stop()
  void nextTick(syncMedia)
})
watch(() => props.currentMs, () => { if (!playing.value) syncMedia() })
function fullscreen() {
  if (!document.fullscreenElement) void canvas.value?.requestFullscreen().catch(() => { expanded.value = !expanded.value })
  else void document.exitFullscreen()
}
onUnmounted(() => {
  cancelAnimationFrame(animation)
  for (const { el } of audioElements.values()) { el.pause(); el.src = '' }
})
defineExpose({ stop, toggle, seek })
</script>

<template>
  <div class="pv-player">
    <div ref="canvas" class="pv-canvas" :class="{ expanded }">
      <template v-if="playableView">
        <video v-if="playableVideoSource" ref="video" :src="mediaUrl(playableVideoSource.url)" :poster="videoPoster || undefined" playsinline preload="auto" @loadedmetadata="syncMedia" @error="markVideoFailed(videoSource?.url || '')" />
        <img v-else-if="frame" :src="mediaUrl(frame)" :alt="segment?.panel.title" :style="motionStyle">
        <div v-else class="pv-no-frame"><Clapperboard :size="40" :stroke-width="1" /><strong>{{ emptyTitle }}</strong><span>{{ emptyHint }}</span></div>
        <div class="pv-shot-stamp"><span>SHOT {{ String(segments.indexOf(segment!) + 1).padStart(2, '0') }}</span><b>{{ segment?.panel.shotType }} · {{ segment?.panel.movement || '静止' }}</b></div>
        <div class="pv-source-badge" :class="{ 'is-video': !!playableVideoSource, 'is-fallback': view === 'video' && !playableVideoSource }"><Film v-if="playableVideoSource" :size="10" /><Images v-else :size="10" />{{ sourceLabel }}</div>
        <div v-if="caption" class="pv-subtitle">{{ caption }}</div>
      </template>
      <div v-else class="pv-script"><small>剧本节拍 / {{ segment?.panel.title }}</small><h3>{{ caption || segment?.panel.title }}</h3><p>{{ segment?.panel.description || '当前分镜尚无画面描述' }}</p><small>{{ segment?.panel.scene }}</small></div>
      <button
        v-if="playableView"
        class="pv-canvas-play"
        :class="{ playing }"
        :aria-label="playing ? '暂停预览' : '播放预览'"
        :disabled="!total"
        @click="toggle"
      >
        <Pause v-if="playing" :size="22" /><Play v-else :size="22" />
      </button>
      <button class="pv-expand" aria-label="全屏预览" @click="fullscreen"><Maximize2 :size="16" /></button>
    </div>
    <div class="pv-player-controls">
      <button aria-label="上一个镜头" @click="skip(-1)"><SkipBack :size="15" /></button>
      <button aria-label="下一个镜头" @click="skip(1)"><SkipForward :size="15" /></button>
      <span class="pv-time">{{ formatTime(currentMs) }}</span>
      <input class="pv-progress" type="range" aria-label="预演播放进度" min="0" :max="total" step="100" :value="currentMs" @input="seek(Number(($event.target as HTMLInputElement).value))">
      <span class="pv-time pv-muted">{{ formatTime(total) }}</span>
      <div class="pv-volume-control">
        <button :aria-label="muted ? '取消静音' : '静音'" @click="toggleMute"><VolumeX v-if="muted || volume === 0" :size="16" /><Volume2 v-else :size="16" /></button>
        <input type="range" aria-label="预演音量" min="0" max="100" step="5" :value="Math.round(volume * 100)" :title="`音量 ${Math.round(volume * 100)}%`" @input="setVolume">
      </div>
      <select v-model.number="rate" aria-label="播放速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="1.5">1.5×</option><option :value="2">2×</option></select>
    </div>
  </div>
</template>
