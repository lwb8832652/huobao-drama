/** Version-owned production data. Times are integer milliseconds throughout. */
export type FrameType = 'start' | 'middle' | 'end' | 'beat'
export type VideoGenerationMode = 'direct' | 'storyboard_frames'
export type VideoConstraint = 'auto' | 'text' | 'reference' | 'first' | 'first_last'
export interface PanelGeneration {
  constraint: VideoConstraint
  includeAssets: boolean
}
export type ContinuityState = Record<string, string>
export interface Keyframe {
  id?: string
  title?: string
  offsetMs?: number
  useForVideo?: boolean
  history?: { url: string; taskId?: number }[]
  referenceImages?: string[]
  shotType?: string
  angle?: string
  composition?: string
  type: FrameType
  url: string
  prompt: string
  locked: boolean
  taskId?: number
}
export interface Panel {
  id: number
  title: string
  description: string
  atmosphere: string
  imagePrompt: string
  videoPrompt: string
  durationMs: number
  sceneId: number | null
  scene: string
  shotType: string
  angle: string
  movement: string
  characterIds: number[]
  propIds: number[]
  referenceImages: string[]
  referenceLabels?: string[]
  sourceFingerprint?: string
  generation?: PanelGeneration
  coverFrameId?: string
  videoUrl: string
  frames: Keyframe[]
}
export interface StoryboardGroup {
  id: string
  title: string
  note: string
  panelIds: number[]
  entry: ContinuityState
  exit: ContinuityState
}
export interface Transition {
  from: string
  to: string
  type: 'cut' | 'match_cut' | 'occlusion' | 'insert' | 'establishing' | 'audio_bridge'
  continuity: 'strong' | 'normal' | 'scene_change'
  allowedChanges: string[]
}
export interface AudioClip {
  id: string
  type: 'dialogue' | 'narration' | 'sound'
  panelId: number | null
  character: string
  text: string
  url: string
  startMs: number
  durationMs: number
}
export interface GenerationStrategy {
  mode: 'storyboard' | 'group'
  constraint: VideoConstraint
  fallback: 'first' | 'reference' | 'text'
  minDurationMs: number
  maxDurationMs: number
}
export interface Timeline {
  schemaVersion: 1 | 2
  groups: StoryboardGroup[]
  panels: Panel[]
  transitions: Transition[]
  audio: AudioClip[]
  strategy: GenerationStrategy
  acknowledgements: Record<string, string>
  inheritedOutputs?: VideoOutput[]
}
export interface ContinuityIssue {
  id: string
  severity: 'fail' | 'warning'
  rule: string
  message: string
  groupId: string
  panelId?: number
  fromGroupId?: string
  field?: string
  reason?: string
}
export type ContinuityReviewConfidence = 'high' | 'medium' | 'low'
export interface ContinuityReviewDimension {
  score: number
  comment: string
}
export interface ContinuityReviewResult {
  overallScore: number
  confidence: ContinuityReviewConfidence
  summary: string
  dimensions: {
    subject: ContinuityReviewDimension
    scene: ContinuityReviewDimension
    action: ContinuityReviewDimension
    camera: ContinuityReviewDimension
  }
  issues: string[]
  suggestions: string[]
}
export interface ContinuityReview {
  id: number
  versionId: number
  fromGroupId: string
  toGroupId: string
  inputHash: string
  configId: number
  model: string
  result: ContinuityReviewResult
  images: { from: boolean; to: boolean }
  createdAt: string
  cached: boolean
}
export interface AnimaticVersion {
  id: number
  episodeId: number
  versionNo: number
  revision: number
  status: 'draft' | 'ready' | 'locked'
  contentHash: string | null
  lockedAt: string | null
  timeline: Timeline
  issues: ContinuityIssue[]
  busy: boolean
  batches: BatchRun[]
  isCurrent: boolean
  outputs: VideoOutput[]
}
export interface VideoOutput {
  key: string
  panelIds: number[]
  url: string
  taskId?: number
  generationMode?: VideoGenerationMode
  stale: boolean
}
export interface BatchItem {
  id: number
  groupId: string
  panelId: number | null
  frameType: FrameType | null
  status: string
  taskId: number | null
  error: string | null
  localPath?: string | null
  resultUrl?: string | null
  actualStrategy?: string
  generationMode?: VideoGenerationMode
  frameId?: string
  panelIds?: number[]
  inputHash?: string
}
export interface BatchRun {
  id: number
  versionId: number
  type: 'image' | 'video'
  status: string
  items: BatchItem[]
}
export const defaultStrategy: GenerationStrategy = {
  mode: 'storyboard', constraint: 'auto', fallback: 'first',
  minDurationMs: 10_000, maxDurationMs: 15_000,
}
export function frameKey(frame: Keyframe) { return frame.id || frame.type }
export function orderedFrames(panel: Panel) {
  return [...panel.frames].sort((a, b) => (a.offsetMs || 0) - (b.offsetMs || 0))
}
export function makeFrame(id: string, offsetMs = 0, title = '分镜画面'): Keyframe {
  return { id, title, offsetMs, type: 'beat', url: '', prompt: '', locked: false, useForVideo: true, history: [] }
}
export function panelImageFallback(panel: Panel) {
  return [panel.description, panel.atmosphere].filter(Boolean).join('\n') || panel.imagePrompt
}
/** Normalize in memory only; stored locked versions and their original hashes remain untouched. */
export function normalizeTimeline(value: Timeline): Timeline {
  const t: Timeline = JSON.parse(JSON.stringify(value))
  const legacy = t.schemaVersion === 1
  t.schemaVersion = 2
  t.strategy.mode = 'storyboard'
  t.strategy.constraint = 'auto'
  for (const p of t.panels) {
    p.atmosphere ||= ''
    p.generation = { constraint: 'auto', includeAssets: false }
    if (legacy) p.frames = p.frames.filter(f => f.url || f.prompt)
    p.frames.forEach((f, i) => {
      f.id ||= `${p.id}-${f.type}-${i}`
      f.title ||= f.type === 'start' ? '开场画面' : f.type === 'end' ? '结束画面' : `画面 ${i + 1}`
      f.offsetMs ??= f.type === 'end' ? Math.max(0, p.durationMs - 1) : f.type === 'middle' ? Math.floor(p.durationMs / 2) : 0
      f.useForVideo = true
      f.locked = false
      f.history ||= f.url ? [{ url: f.url, taskId: f.taskId }] : []
    })
    p.coverFrameId ||= p.frames.find(f => f.url)?.id
  }
  if (t.groups.length !== t.panels.length || t.groups.some(group => group.panelIds.length !== 1)) {
    const oldGroups = t.groups
    const oldTransitions = t.transitions
    const orderedIds = oldGroups.flatMap(group => group.panelIds)
    for (const panel of t.panels) if (!orderedIds.includes(panel.id)) orderedIds.push(panel.id)
    t.groups = orderedIds.map(panelId => {
      const panel = t.panels.find(item => item.id === panelId)!
      const source = oldGroups.find(group => group.panelIds.includes(panelId))
      const index = source?.panelIds.indexOf(panelId) ?? 0
      const last = index === (source?.panelIds.length || 1) - 1
      const entry = { ...(source?.entry || {}) }
      return {
        id: `panel-${panelId}`, title: panel.title, note: index === 0 ? source?.note || '' : '',
        panelIds: [panelId], entry, exit: { ...(last ? source?.exit || entry : entry) },
      }
    })
    t.transitions = t.groups.slice(1).map((group, index) => {
      const from = t.groups[index]
      const fromSource = oldGroups.find(item => item.panelIds.includes(from.panelIds[0]))
      const toSource = oldGroups.find(item => item.panelIds.includes(group.panelIds[0]))
      const old = fromSource && toSource && fromSource.id !== toSource.id
        ? oldTransitions.find(edge => edge.from === fromSource.id && edge.to === toSource.id)
        : undefined
      return old ? { ...old, from: from.id, to: group.id }
        : { from: from.id, to: group.id, type: 'cut', continuity: 'normal', allowedChanges: [] }
    })
  }
  for (const group of t.groups) {
    const panel = t.panels.find(item => item.id === group.panelIds[0])
    if (panel) group.title = panel.title
  }
  return t
}
/** Plan one image per explicitly labelled subshot; plain descriptions need only one. */
export function planFrames(panel: Panel, prefix: string): Keyframe[] {
  const parts = panel.description.split(/(?=【(?:镜头|子镜头)\s*[\d一二三四五六七八九十]+】)/).filter(s => s.trim())
  const labelled = parts.filter(s => /^【(?:镜头|子镜头)/.test(s))
  const shots = labelled.length
    ? labelled.map(prompt => [prompt, panel.atmosphere].filter(Boolean).join('\n'))
    : [panelImageFallback(panel)]
  return shots.map((prompt, i) => ({
    ...makeFrame(`${prefix}-${i}`, Math.floor(i * panel.durationMs / shots.length), `画面 ${i + 1}`),
    prompt: prompt.trim(),
  }))
}
export function groupPanels(t: Timeline, group: StoryboardGroup): Panel[] {
  const byId = new Map(t.panels.map(p => [p.id, p]))
  return group.panelIds.map(id => byId.get(id)).filter((p): p is Panel => !!p)
}
export function timelineSegments(t: Timeline) {
  let startMs = 0
  return t.groups.flatMap(g => groupPanels(t, g).map(panel => {
    const segment = { groupId: g.id, panel, startMs, endMs: startMs + panel.durationMs }
    startMs = segment.endMs
    return segment
  }))
}
export function durationMs(t: Timeline) {
  return timelineSegments(t).at(-1)?.endMs || 0
}
/** Preserve a bound clip's offset inside its shot when earlier shots move or change length. */
export function retimeBoundAudio(before: Timeline, after: Timeline) {
  const starts = new Map(timelineSegments(before).map(s => [s.panel.id, s.startMs]))
  const nextStarts = new Map(timelineSegments(after).map(s => [s.panel.id, s.startMs]))
  for (const clip of after.audio) {
    if (!clip.panelId) continue
    const previous = starts.get(clip.panelId), next = nextStarts.get(clip.panelId)
    if (previous !== undefined && next !== undefined) clip.startMs = Math.max(0, clip.startMs + next - previous)
  }
}
export function mediaUrl(value?: string | null) {
  if (!value) return ''
  return /^(https?:|blob:|data:|\/)/.test(value) ? value : `/${value}`
}
export function formatTime(ms: number) {
  const tenths = Math.floor(Math.max(0, ms) / 100)
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`
}
export function rebuildTransitions(t: Timeline) {
  t.transitions = t.groups.slice(1).map((g, i) =>
    t.transitions.find(e => e.from === t.groups[i].id && e.to === g.id) ||
    { from: t.groups[i].id, to: g.id, type: 'cut', continuity: 'normal', allowedChanges: [] })
}
export function autoGroup(panels: Panel[], _strategy = defaultStrategy): StoryboardGroup[] {
  return panels.map(panel => {
    const state = { scene: panel.scene, characters: panel.characterIds.join(','), props: panel.propIds.join(',') }
    return {
      id: `panel-${panel.id}`, title: panel.title, note: '', panelIds: [panel.id],
      entry: { ...state }, exit: { ...state },
    }
  })
}
export function checkContinuity(t: Timeline): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []
  const add = (issue: Omit<ContinuityIssue, 'reason'>) => {
    // Include evidence in the identity: waivers do not survive a changed condition.
    issue.id = `${issue.id}:${encodeURIComponent(issue.message)}`
    issues.push({ ...issue, reason: t.acknowledgements[issue.id] })
  }
  for (const group of t.groups) {
    const panels = groupPanels(t, group)
    if (!panels.length) add({ id: `empty:${group.id}`, rule: 'empty_group', severity: 'fail', groupId: group.id, message: '镜头节点没有关联分镜，请同步视频制作数据。' })
    for (const p of panels) if (!p.frames.some(f => f.url)) add({
      id: `frame:${p.id}`, rule: 'missing_frame', severity: 'warning', groupId: group.id, panelId: p.id,
      message: `「${p.title}」尚无预览画面；可添加画面，也可直接使用纯文本生成视频。`,
    })
  }
  for (const edge of t.transitions) {
    const from = t.groups.find(g => g.id === edge.from)!
    const to = t.groups.find(g => g.id === edge.to)!
    if (!from || !to) continue
    const a = groupPanels(t, from).at(-1), b = groupPanels(t, to)[0]
    if (a?.scene && b?.scene && a.scene !== b.scene && !['establishing', 'audio_bridge', 'insert'].includes(edge.type)) add({
      id: `scene:${from.id}:${to.id}`, rule: 'scene_bridge', severity: 'warning', fromGroupId: from.id, groupId: to.id,
      message: `场景从「${a.scene}」变为「${b.scene}」，建议声明建立镜头或声音桥。`,
    })
    if (a && b && a.shotType && b.shotType && a.shotType !== b.shotType && a.angle !== b.angle && edge.type === 'cut') add({
      id: `camera:${from.id}:${to.id}`, rule: 'camera_jump', severity: 'warning', fromGroupId: from.id, groupId: to.id,
      message: `景别和机位同时变化：${a.shotType}/${a.angle} → ${b.shotType}/${b.angle}，请确认转场。`,
    })
  }
  const segments = timelineSegments(t)
  for (const clip of t.audio) {
    const segment = segments.find(s => s.panel.id === clip.panelId)
    const outOfBounds = clip.startMs + clip.durationMs > durationMs(t)
      || (clip.type === 'dialogue' && segment && (clip.startMs < segment.startMs || clip.startMs + clip.durationMs > segment.endMs))
    if (outOfBounds) add({
      id: `audio:${clip.id}`, rule: 'audio_overflow', severity: 'fail',
      groupId: segment?.groupId || t.groups[0]?.id || '', panelId: clip.panelId || undefined,
      message: `「${clip.text || '音频'}」的播放区间超出${clip.type === 'dialogue' && segment ? '所属分镜' : '时间线'}。`,
    })
  }
  if (!t.panels.length) add({ id: 'empty', rule: 'empty_timeline', severity: 'fail', groupId: '', message: '尚无分镜，请先在视频制作中拆分剧本。' })
  return issues
}
