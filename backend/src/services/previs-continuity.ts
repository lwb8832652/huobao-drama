/** Readonly continuity evidence. Timeline order, never numeric panel IDs, defines adjacency. */
import { localReferenceDigest } from './previs-reference-media.js'
import { createHash } from 'node:crypto'
import { frameKey, normalizeTimeline, orderedFrames, timelineSegments, type FrameSource, type Timeline, type Transition } from './previs-domain.js'
export interface ContinuityFrameSource {
  versionId: number
  panelId: number
  panelTitle: string
  frameId: string
  sourceUrl: string
  offsetMs: number
  source?: FrameSource
  sourceSignature: string
  frozenUrl?: string
  digest?: string
}
export interface PanelContinuity {
  version: 1
  panelId: number
  status: 'reset' | 'missing' | 'available'
  reason: string
  exactVideoBoundary: boolean
  transition?: Transition
  previous?: ContinuityFrameSource
  signature: string
}
function signature(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export function resolvePanelContinuity(input: Timeline, panelId: number, versionId = 0): PanelContinuity {
  const timeline = normalizeTimeline(input), segments = timelineSegments(timeline)
  const index = segments.findIndex(s => s.panel.id === panelId), current = segments[index], prior = segments[index - 1]
  const transition = prior && current ? timeline.transitions.find(edge => edge.from === prior.groupId && edge.to === current.groupId) : undefined
  const previousGroup = timeline.groups.find(g => g.id === prior?.groupId), currentGroup = timeline.groups.find(g => g.id === current?.groupId)
  const currentFirst = current && orderedFrames(current.panel)[0]
  const eligibility = { firstCamera: currentFirst && { angle: currentFirst.angle, shotType: currentFirst.shotType, composition: currentFirst.composition }, sceneId: current?.panel.sceneId, scene: current?.panel.scene, angle: current?.panel.angle, shotType: current?.panel.shotType, characterIds: current?.panel.characterIds, propIds: current?.panel.propIds }
  const base = { version: 1 as const, panelId, exactVideoBoundary: false, ...(transition ? { transition } : {}) }
  const finish = (state: Omit<PanelContinuity, 'signature'>): PanelContinuity => ({ ...state,
    signature: signature({ ...state, eligibility, previous: state.previous && { ...state.previous, versionId: undefined } }) })
  const reset = (reason: string) => finish({ ...base, status: 'reset', reason })
  if (!current || !prior) return reset('首个分镜没有前序边界，建立当前开场状态。')
  if (transition?.continuity === 'scene_change' || transition?.type === 'establishing') return reset('场景切换或建立镜头，重新建立空间与开场状态。')
  const a = prior.panel, b = current.panel
  if ((a.sceneId && b.sceneId && a.sceneId !== b.sceneId) || (!(a.sceneId && b.sceneId) && a.scene && b.scene && a.scene !== b.scene)) return reset('场景不同，重新建立开场状态。')
  const sameScene = Boolean((a.sceneId && b.sceneId && a.sceneId === b.sceneId) || (a.scene && b.scene && a.scene === b.scene))
  if (!sameScene) return reset('缺少相同场景证据，先按当前分镜建立开场状态。')
  const timeQualifier = (scene: string) => scene.match(/凌晨|早晨|清晨|上午|中午|下午|傍晚|黄昏|夜晚|深夜|白天|夜间|\b(?:morning|afternoon|evening|night|day)\b/i)?.[0].toLowerCase()
    || scene.match(/(?:^|[\s·/|,，:：()（）-])([日夜])(?=$|[\s·/|,，:：()（）-])/u)?.[1]
  const aTime = timeQualifier(a.scene), bTime = timeQualifier(b.scene)
  if (aTime && bTime && aTime !== bTime) return reset('场景时间标记不同，重新建立开场状态。')
  const changes = transition?.allowedChanges || []
  if (changes.some(change => /^(time|time_gap|time_jump|timeOfDay|time_of_day|时间|时间跳跃)$/i.test(change))) return reset('转场允许时间跳跃，前序画面不能约束当前开场。')
  for (const key of ['time', 'timeOfDay', 'time_of_day', '时间']) {
    const exit = previousGroup?.exit[key], entry = currentGroup?.entry[key]
    if (exit && entry && exit !== entry) return reset('相邻分镜的时间状态不同，重新建立开场状态。')
  }
  const last = orderedFrames(a).at(-1)
  const previous: ContinuityFrameSource | undefined = last && { versionId, panelId: a.id, panelTitle: a.title,
    frameId: frameKey(last), sourceUrl: last.url, offsetMs: last.offsetMs || 0, source: last.source,
    sourceSignature: signature({ panel: { id: a.id, description: a.description, videoPrompt: a.videoPrompt,
      imagePrompt: a.imagePrompt, atmosphere: a.atmosphere, sceneId: a.sceneId, scene: a.scene,
      characterIds: a.characterIds, propIds: a.propIds, durationMs: a.durationMs, continuityConstraints: a.continuityConstraints },
      frame: { ...last, history: undefined, locked: undefined }, exit: previousGroup?.exit, entry: currentGroup?.entry }) }
  if (!last?.url) return finish({ ...base, status: 'missing', previous, reason: '前序分镜末画面尚未采用或缺失；可先生成当前分镜，暂不使用前序图片。' })
  const previousAngle = last.angle || a.angle, currentAngle = currentFirst?.angle || b.angle
  const previousShot = last.shotType || a.shotType, currentShot = currentFirst?.shotType || b.shotType
  const sameComposition = !last.composition || !currentFirst?.composition || last.composition === currentFirst.composition
  // Free-form allowedChanges cannot be exhaustively classified. Any deliberate
  // change keeps the current first image; explicitly contradictory states do too.
  const compatibleStates = Object.entries(previousGroup?.exit || {}).every(([key, value]) => {
    const entry = currentGroup?.entry[key]
    return !value || !entry || value === entry
  })
  const exactVideoBoundary = sameScene && transition?.continuity === 'strong'
    && changes.length === 0 && compatibleStates
    && signature([...a.characterIds].sort()) === signature([...b.characterIds].sort())
    && signature([...a.propIds].sort()) === signature([...b.propIds].sort())
    && Boolean(previousAngle && currentAngle && previousAngle === currentAngle)
    && Boolean(previousShot && currentShot && previousShot === currentShot) && sameComposition
  return finish({ ...base, status: 'available', previous, exactVideoBoundary,
    reason: exactVideoBoundary ? '同场景强连续：动作与空间延续，可共用前序末帧作为视频首帧。'
      : '同场景连续：沿用动作阶段、人物位置、视线与持物；当前机位和构图按本分镜规划。' })
}
export function continuityMatchesTimeline(saved: PanelContinuity, timeline: Timeline, panelId = saved.panelId) {
  if (saved.signature !== resolvePanelContinuity(timeline, panelId, saved.previous?.versionId).signature) return false
  if (saved.previous?.digest) {
    const digest = localReferenceDigest(saved.previous.sourceUrl)
    if (digest !== null && digest !== saved.previous.digest) return false
  }
  return true
}
