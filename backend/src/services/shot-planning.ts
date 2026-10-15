/** Shared, deterministic production planning. No model calls, persistence or media mutation. */
export interface DialogueUnit {
  id: string
  speaker: string
  text: string
  kind: 'dialogue' | 'narration' | 'inner'
  emotion?: string
}
export interface VisualShot {
  id: string
  visual: string
  dialogue: DialogueUnit[]
}
export interface TimedShot extends VisualShot {
  startMs: number
  endMs: number
  dialogue: (DialogueUnit & { startMs: number; endMs: number })[]
}
export interface ProductionPlan {
  version: 1
  description: string
  durationMs: number
  atmosphere: string
  charsPerSecond: number
  shots: TimedShot[]
}
export interface PlanningPanel {
  id: number
  title: string
  description: string
  videoPrompt: string
  durationMs: number
  atmosphere?: string
  productionPlan?: ProductionPlan
  framePlanNeedsReview?: boolean
  frames?: { id?: string; prompt: string; offsetMs?: number; shotId?: string }[]
}
export interface ProductionIssue {
  rule: string
  severity: 'fail' | 'warning'
  message: string
  panelId: number
}
export interface ProductionSegment {
  description: string
  durationMs: number
  plan: ProductionPlan
}
export const spokenText = (text: string) => (text.normalize('NFKC').match(/[\p{L}\p{N}]/gu) || []).join('')
export const spokenChars = (text: string) => [...spokenText(text)].length
/** Chinese syllables and Latin words use their own natural speaking rates. */
function speechUnits(text: string) {
  let words = 0
  const other = text.replace(/[A-Za-z\u00c0-\u024f]+(?:['’][A-Za-z\u00c0-\u024f]+)*/g, () => { words++; return '' })
  return spokenChars(other) + words * 1.6 // 4 Chinese syllables/s or 2.5 Latin words/s.
}
const quotes = /「([^」]*)」|“([^”]*)”/g
const timeHeader = /(?:^|\n)\s*(?:\[\d+(?:\.\d+)?秒\]\s*)?(\d+(?:\.\d+)?)\s*[-—~～至]\s*(\d+(?:\.\d+)?)\s*秒\s*[:：]?/g
const metadataLabel = /^(?:\d|整体|氛围|要求|参考|镜头|风格|时长|画面|构图|光线|注意|景别|机位|出场人物|人物|角色|场景|道具|背景音乐|音效|中景$|近景$|远景$|全景$|特写$|动作$|运镜$|cast$|scene$|props$|references?$|camera$|bgm$|sfx$)/i

function speakerName(label: string) {
  const name = label.replace(/^@/, '').replace(/(?:低声道|说道|回答|说|问)$/, '')
  return name.includes('@') || metadataLabel.test(name) ? '' : name
}
function speakerBefore(prefix: string) {
  prefix = prefix.replace(timeHeader, '\n')
  const match = prefix.match(/(?:^|[。！？\n」】])\s*([@\p{L}\p{N}_-]{1,24})\s*(?:[（(]([^）)]*)[）)])\s*[：:]\s*$/u)
    || prefix.match(/(?:^|[。！？\n」】])\s*([@\p{L}\p{N}_-]{1,24})\s*[：:]\s*(?:[（(]([^）)]*)[）)])?\s*$/u)
    || prefix.match(/([@\p{L}\p{N}_-]{1,20})\s*(?:说|说道|低声道|问|回答|旁白)\s*[：:]\s*$/u)
  let speaker = speakerName(match?.[1] || '')
  if (/^(?:低声|高声|大声|轻声|喃喃|低声自语|冷冷|缓缓|轻轻)$/.test(speaker) || metadataLabel.test(speaker)) speaker = ''
  if (!speaker) {
    const context = prefix.split(/\n|[。！？」]/).at(-1) || ''
    const mentions = [...context.matchAll(/@([\p{L}\p{N}_-]{1,24})(?=\s|[，,：:]|$)/gu)]
    if (mentions.length === 1 && (context.match(/@/g) || []).length === 1) speaker = speakerName(mentions[0][1])
  }
  return { speaker, emotion: match?.[2] }
}
function kindFor(speaker: string): DialogueUnit['kind'] {
  return /旁白|画外音|narrat|voice.?over/i.test(speaker) ? 'narration' : /内心|心声|独白|inner/i.test(speaker) ? 'inner' : 'dialogue'
}
function displayedText(prefix: string) {
  return /(?:屏幕|碑文|碑面|碑上|招牌|标牌|字幕|字样|大字|文字|标语|标题|写着|写有|刻着|刻有|显示|浮出|标注为)[^。！？「」“”\n]{0,20}\s*$/.test(prefix)
}
function dialogueSpans(text: string) {
  const found: (DialogueUnit & { index: number; textStart: number; textEnd: number })[] = []
  const quoted = [...text.matchAll(quotes)]
  for (const match of quoted) {
    if (displayedText(text.slice(0, match.index))) continue
    const identity = speakerBefore(text.slice(0, match.index))
    const value = match[1] ?? match[2]
    found.push({ id: '', index: match.index, textStart: match.index + 1, textEnd: match.index + 1 + value.length,
      ...identity, text: value, kind: kindFor(identity.speaker) })
  }
  const labels = [...text.matchAll(/(?:^|[。！？\n」])\s*([@\p{L}\p{N}_-]{1,20})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(?:[（(]([^）)]*)[）)])?\s*/gu)]
  for (const [i, match] of labels.entries()) {
    if (metadataLabel.test(match[1])) continue
    const nameStart = match.index + match[0].indexOf(match[1])
    if (quoted.some(q => nameStart > q.index && nameStart < q.index + q[0].length)) continue
    const start = match.index + match[0].length
    const end = Math.min(text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start), labels[i + 1] ? labels[i + 1].index + (/^[。！？]/.test(labels[i + 1][0]) ? 1 : 0) : text.length)
    const value = text.slice(start, end).trim()
    if (!value || /^[「“]/.test(value)) continue
    const textStart = start + text.slice(start, end).indexOf(value)
    const speaker = speakerName(match[1])
    found.push({ id: '', index: start, textStart, textEnd: textStart + value.length, speaker, emotion: match[2] || match[3], text: value, kind: kindFor(speaker) })
  }
  return found.sort((a, b) => a.index - b.index).map((unit, i) => ({ ...unit, id: `d${i + 1}` }))
}
export function extractDialogue(text: string): DialogueUnit[] {
  return dialogueSpans(text).map(({ index: _, textStart: _start, textEnd: _end, ...unit }) => unit)
}
function visualOnly(text: string) {
  const spoken = extractDialogue(text)
  let visual = text
  for (const unit of spoken) {
    const identity = unit.speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escaped = unit.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (identity) visual = visual.replace(new RegExp(`@?${identity}\\s*(?:低声道|说道|回答|说|问)?\\s*(?:[（(][^）)]*[）)])?\\s*[：:]\\s*(?:[（(][^）)]*[）)])?\\s*(?:「${escaped}」|“${escaped}”|${escaped})`, 'u'), '')
    visual = visual.replace(`「${unit.text}」`, '').replace(`“${unit.text}”`, '')
  }
  return visual
    .replace(/[「」“”]/g, '').replace(/^[\s；;。]+|[\s；;]+$/g, '').trim()
}
export function parseShotDescription(description: string): VisualShot[] {
  const headers = [...description.matchAll(/【(?:镜头|子镜头|shot)\s*([^】]+)】/gi)]
  const chunks = headers.length ? headers.map((m, i) => description.slice(m.index + m[0].length, headers[i + 1]?.index ?? description.length)) : [description]
  // Unlabelled introductory text is still part of the first shot.
  if (headers[0]?.index) chunks[0] = description.slice(0, headers[0].index) + chunks[0]
  return chunks.map((text, i) => ({ id: `s${i + 1}`, visual: visualOnly(text), dialogue: extractDialogue(text).map((d, n) => ({ ...d, id: `s${i + 1}-d${n + 1}` })) }))
    .filter(s => s.visual || s.dialogue.length)
}
export function estimatedSpeechMs(unit: Pick<DialogueUnit, 'text' | 'emotion'>, charsPerSecond = 4) {
  const punctuation = (unit.text.match(/[，,、：:；;]/g) || []).length * 120
    + (unit.text.match(/[。！？!?]/g) || []).length * 220
    + (unit.text.match(/……|\.\.\.|——/g) || []).length * 350
  return Math.ceil(speechUnits(unit.text) / charsPerSecond * 1000 + punctuation + (/低|喃|羞|哽|犹豫/.test(unit.emotion || '') ? 250 : 0))
}
export function promptTimeWindows(prompt: string) {
  const headers = [...prompt.matchAll(timeHeader)]
  return headers.map((m, i) => ({ startMs: Number(m[1]) * 1000, endMs: Number(m[2]) * 1000,
    text: prompt.slice(m.index + m[0].length, headers[i + 1]?.index ?? prompt.length).trim() }))
}
export function invalidVisualPrompt(prompt: string) {
  const action = visualOnly((prompt || '').split('；')[0].replace(/^(?:开场|结束|关键状态|第\s*\d+\s*个瞬间)[：:]\s*/, '').replace(/【[^】]*】/g, ''))
  return spokenChars(action) < 2
}
export function analyzePanelProduction(panel: PlanningPanel) {
  const prompt = panel.videoPrompt || ''
  const source = extractDialogue(panel.description || ''), windows = promptTimeWindows(prompt)
  const issues: ProductionIssue[] = []
  const add = (rule: string, severity: ProductionIssue['severity'], message: string) => issues.push({ rule, severity, message, panelId: panel.id })
  const chars = source.reduce((sum, d) => sum + spokenChars(d.text), 0)
  const minimumMs = chars ? Math.ceil(source.reduce((sum, d) => sum + speechUnits(d.text), 0) / 4.5 * 1000 + 2000) : 0
  const recommendedMs = source.reduce((sum, d, i) => sum + estimatedSpeechMs(d) + (i && d.speaker !== source[i - 1].speaker ? 350 : 0), 0) + (source.length ? 1300 : 0)
  if (minimumMs > panel.durationMs) add('dialogue_total_overflow', 'fail', `完整对白 ${chars} 字，当前 ${panel.durationMs / 1000}s，最低估计 ${(minimumMs / 1000).toFixed(1)}s；建议延长或按语义拆段。`)
  else if (recommendedMs > panel.durationMs) add('dialogue_pacing_tight', 'warning', `对白与停顿预计 ${(recommendedMs / 1000).toFixed(1)}s，当前节奏偏紧。`)
  const original = source.map(d => spokenText(d.text)).join('')
  const promptDialogue = extractDialogue(prompt)
  const actual = promptDialogue.map(d => spokenText(d.text)).join('')
  if (original !== actual) {
    const missing = source.filter(d => !actual.includes(spokenText(d.text)))
    add(!original ? 'dialogue_added' : missing.length ? 'dialogue_missing' : 'dialogue_mismatch', 'fail', !original ? '视频提示词新增了原描述没有的对白，请核对后生成。' : missing.length ? `视频提示词未完整保留 ${missing.length} 条对白，请按原文恢复后生成。` : '视频提示词的对白顺序或重复次数与分镜描述不一致。')
  }
  if (original === actual) {
    let sourceCursor = 0, promptCursor = 0
    const ranges = source.map(d => { const start = sourceCursor; sourceCursor += spokenText(d.text).length; return { start, end: sourceCursor, speaker: d.speaker } })
    if (promptDialogue.some(d => {
      const start = promptCursor; promptCursor += spokenText(d.text).length
      return ranges.some(range => range.start < promptCursor && range.end > start && range.speaker && range.speaker !== d.speaker)
    })) add('dialogue_speaker_mismatch', 'fail', '视频提示词中的说话人缺失或与原描述不一致，请核对对白归属。')
  }
  if (source.some(d => !d.speaker)) add('dialogue_speaker_unknown', 'warning', '存在未明确说话人的对白，请核对归属。')
  if (prompt.trim() && !windows.length) add('prompt_time_unstructured', 'warning', '提示词没有可核对的起止时间，建议采用统一镜头计划。')
  let cursor = 0
  for (const window of windows) {
    if (window.startMs > cursor + 1) add('prompt_time_gap', 'fail', `${cursor / 1000}–${window.startMs / 1000}s 未规划。`)
    if (window.startMs < cursor - 1 || window.endMs <= window.startMs) add('prompt_time_overlap', 'fail', `${window.startMs / 1000}–${window.endMs / 1000}s 时间重叠或无效。`)
    const dialogue = extractDialogue(window.text), n = dialogue.reduce((sum, d) => sum + spokenChars(d.text), 0), units = dialogue.reduce((sum, d) => sum + speechUnits(d.text), 0)
    if (units / 4.5 * 1000 > window.endMs - window.startMs) add('dialogue_window_overflow', 'fail', `${window.startMs / 1000}–${window.endMs / 1000}s 安排 ${n} 字，纯发声至少 ${(units / 4.5).toFixed(1)}s。`)
    else if (dialogue.reduce((sum, d) => sum + estimatedSpeechMs(d), 0) > window.endMs - window.startMs) add('dialogue_window_tight', 'warning', `${window.startMs / 1000}–${window.endMs / 1000}s 对白缺少停顿与表演余量。`)
    cursor = window.endMs
  }
  if (windows.length && cursor < panel.durationMs - 1) add('prompt_time_gap', 'fail', `提示词仅覆盖到 ${cursor / 1000}s，剩余 ${(panel.durationMs - cursor) / 1000}s 未规划。`)
  if (cursor > panel.durationMs + 1) add('prompt_time_overflow', 'fail', '提示词时间超出分镜总时长。')
  for (const frame of panel.frames || []) if (frame.prompt.trim() && invalidVisualPrompt(frame.prompt)) add('invalid_frame_prompt', 'fail', '存在只有标点或缺少可视内容的画面规划，请重新规划该画面。')
  if (panel.productionPlan && !productionPlanMatchesPanel(panel.productionPlan, panel)) add('production_plan_stale', 'fail', '描述、时长或提示词已改变，统一镜头计划需要更新。')
  if (panel.productionPlan && !validProductionIntervals(panel.productionPlan)) add('production_plan_invalid', 'fail', '统一镜头计划的对白或镜头时间越界，请重新规划。')
  if (panel.framePlanNeedsReview) add('frame_plan_review', 'fail', '对白时间已调整，请重新规划并审阅画面与镜头的对应关系。')
  if (!panel.framePlanNeedsReview && panel.frames?.length) {
    const shots = panel.productionPlan?.shots || parseShotDescription(panel.description)
    const hasMapping = !!panel.productionPlan || panel.frames.some(f => !!f.shotId)
    if (panel.frames.length < shots.length) add('frame_shot_coverage', 'fail', `当前 ${panel.frames.length} 张画面不足以覆盖 ${shots.length} 个子镜头，请重新规划画面。`)
    for (const shot of shots) if (hasMapping && !panel.frames.some(f => f.shotId === shot.id && (!('startMs' in shot && 'endMs' in shot) || ((f.offsetMs || 0) >= Number(shot.startMs) && (f.offsetMs || 0) < Number(shot.endMs))))) {
      add('frame_shot_coverage', 'fail', `镜头 ${shot.id} 缺少对应时段内的参考画面，请重新规划画面。`)
    }
    if (hasMapping && panel.frames.some((f, i, all) => !shots.some(s => s.id === f.shotId)
      || (i > 0 && shots.findIndex(s => s.id === f.shotId) < shots.findIndex(s => s.id === all[i - 1].shotId)))) add('frame_shot_mapping', 'fail', '存在未关联当前镜头计划或顺序错误的画面。')
  }
  return { panelId: panel.id, title: panel.title, dialogueChars: chars, minimumMs, recommendedMs, shotCount: parseShotDescription(panel.description).length, issues }
}
export function productionBlockingMessage(panel: PlanningPanel) {
  const issues = analyzePanelProduction(panel).issues.filter(i => i.severity === 'fail')
  return issues.length ? `「${panel.title}」${issues[0].message} 请先检查与优化制作计划。` : ''
}

function splitUnit(unit: DialogueUnit, capacityMs: number, charsPerSecond: number): DialogueUnit[] {
  if (estimatedSpeechMs(unit, charsPerSecond) <= capacityMs) return [unit]
  const clauses = unit.text.match(/[^。！？!?，,；;]+[。！？!?，,；;]*|[。！？!?，,；;]+/g) || [unit.text]
  const parts: string[] = []
  let text = ''
  for (const clause of clauses) {
    if (estimatedSpeechMs({ ...unit, text: clause }, charsPerSecond) > capacityMs) throw new Error('单句对白超出生成时长，请先在语义边界拆句，不能截断或删词。')
    if (text && estimatedSpeechMs({ ...unit, text: text + clause }, charsPerSecond) > capacityMs) { parts.push(text); text = '' }
    text += clause
  }
  if (text) parts.push(text)
  return parts.map((text, i) => ({ ...unit, id: `${unit.id}-${i + 1}`, text }))
}
// Silent reaction inserts can share the surrounding performance; they do not each
// require a new multi-second block. Remaining time is distributed across shots.
const shotCost = (shot: VisualShot, cps: number) => Math.max(650, shot.dialogue.reduce((sum, d, i) => sum + estimatedSpeechMs(d, cps) + (i ? 350 : 0), 0) + (shot.dialogue.length ? 700 : 0))
const requiredDuration = (shots: VisualShot[], cps: number) => {
  const chars = shots.flatMap(s => s.dialogue).reduce((sum, d) => sum + speechUnits(d.text), 0)
  return Math.max(shots.reduce((sum, shot) => sum + shotCost(shot, cps), 0), chars ? chars / 4.5 * 1000 + 2000 : 0)
}
const formatSeconds = (ms: number) => String(Math.round(ms / 100) / 10)
const speakerLabel = (d: DialogueUnit) => `${d.speaker ? `@${d.speaker}` : '人物'}${d.kind === 'narration' && !/旁白|画外音/.test(d.speaker) ? '旁白' : d.kind === 'inner' && !/内心|心声|独白/.test(d.speaker) ? '内心独白' : ''}`
export function renderProductionDescription(shots: VisualShot[]) {
  return shots.map((shot, i) => `【镜头${i + 1}】${shot.visual}\n${shot.dialogue.map(d => `${d.speaker || '人物'}：${d.emotion ? `（${d.emotion}）` : ''}「${d.text}」`).join('\n')}`.trim()).join('\n')
}
export function renderProductionPrompt(plan: ProductionPlan, atmosphere = plan.atmosphere) {
  return plan.shots.map((shot, i) => `${formatSeconds(shot.startMs)}-${formatSeconds(shot.endMs)}秒：【镜头${i + 1}】${shot.visual || '保持当前人物与场景，以自然表情承接对白。'}${shot.dialogue.length ? '\n' + shot.dialogue.map(d => `${speakerLabel(d)}${d.emotion ? `（${d.emotion}）` : ''}： 「${d.text}」（${formatSeconds(d.startMs)}–${formatSeconds(d.endMs)}秒，完整连续说完）`).join('\n') : ''}`).join('\n')
    + (atmosphere ? `\n整体氛围：${atmosphere}` : '')
    + '\n按以上实际时间推进，切镜时对白可连续；保留接话、换气和尾句收声，不赶词、不截断；人物、服装、场景和道具沿用参考素材。'
}
export function productionPlanMatchesPanel(plan: ProductionPlan, panel: PlanningPanel) {
  return plan.version === 1 && plan.description === panel.description && plan.durationMs === panel.durationMs
    && (plan.atmosphere || '') === (panel.atmosphere || '') && renderProductionPrompt(plan, panel.atmosphere || '') === panel.videoPrompt
}
function validProductionIntervals(plan: ProductionPlan) {
  let cursor = 0
  const ids = new Set<string>()
  for (const shot of plan.shots) {
    if (ids.has(shot.id) || shot.startMs !== cursor || shot.endMs <= shot.startMs || shot.endMs > plan.durationMs) return false
    ids.add(shot.id)
    let speechCursor = shot.startMs
    for (const d of shot.dialogue) {
      if (d.startMs < speechCursor || d.endMs <= d.startMs || d.endMs > shot.endMs || d.endMs - d.startMs < speechUnits(d.text) / 4.5 * 1000) return false
      speechCursor = d.endMs
    }
    cursor = shot.endMs
  }
  return plan.shots.length > 0 && cursor === plan.durationMs
}
export function buildProductionPlan(panel: PlanningPanel, options: { maxSeconds: number; minSeconds?: number; charsPerSecond?: number }) {
  const cps = options.charsPerSecond ?? 4, maxMs = Math.floor(options.maxSeconds) * 1000, minMs = Math.ceil(options.minSeconds ?? 2) * 1000
  if (!Number.isFinite(maxMs) || maxMs < minMs || maxMs > 30000 || cps < 2 || cps > 6) throw new Error('生成时长或语速设置无效')
  const source = parseShotDescription(panel.description)
  if (!source.length) throw new Error('请先填写可视画面描述')
  const expanded: VisualShot[] = []
  for (const shot of source) {
    if (requiredDuration([shot], cps) <= maxMs) { expanded.push(shot); continue }
    let group: DialogueUnit[] = []
    for (const unit of shot.dialogue.flatMap(d => splitUnit(d, Math.min(maxMs - 700, (maxMs - 2000) * 4.5 / cps), cps))) {
      if (group.length && requiredDuration([{ ...shot, dialogue: [...group, unit] }], cps) > maxMs) { expanded.push({ ...shot, id: `${shot.id}-${expanded.length}`, dialogue: group }); group = [] }
      group.push(unit)
    }
    if (group.length) expanded.push({ ...shot, id: `${shot.id}-${expanded.length}`, dialogue: group })
  }
  const groups: VisualShot[][] = []
  let current: VisualShot[] = []
  for (const shot of expanded) {
    // Each visual shot needs a frame; the grid supports at most nine per segment.
    if (current.length && (current.length >= 9 || requiredDuration([...current, shot], cps) > maxMs)) { groups.push(current); current = [] }
    current.push(shot)
  }
  if (current.length) groups.push(current)
  const segments: ProductionSegment[] = groups.map(shots => {
    const minimum = requiredDuration(shots, cps)
    const desired = groups.length === 1 ? panel.durationMs : minimum
    const durationMs = Math.min(maxMs, Math.max(minMs, Math.ceil(Math.max(minimum, desired) / 1000) * 1000))
    const slack = durationMs - shots.reduce((sum, s) => sum + shotCost(s, cps), 0)
    let cursor = 0
    const timed = shots.map((shot, i): TimedShot => {
      const startMs = cursor
      cursor = i === shots.length - 1 ? durationMs : cursor + shotCost(shot, cps) + Math.floor(slack / shots.length)
      let speechCursor = startMs + 250
      return { ...shot, id: `s${i + 1}`, startMs, endMs: cursor, dialogue: shot.dialogue.map((d, n) => {
        if (n) speechCursor += 350
        const startMs = speechCursor; speechCursor += estimatedSpeechMs(d, cps)
        return { ...d, id: `s${i + 1}-d${n + 1}`, startMs, endMs: speechCursor }
      }) }
    })
    const description = renderProductionDescription(timed)
    return { description, durationMs, plan: { version: 1, description, durationMs, atmosphere: panel.atmosphere || '', charsPerSecond: cps, shots: timed } }
  })
  return { segments }
}
export function suggestedVisualCount(panel: PlanningPanel) {
  return Math.max(1, Math.min(9, parseShotDescription(panel.description).length))
}
export function restoreScriptDialogue(description: string, script: string) {
  const originals = extractDialogue(script), restorations: { before: string; after: string; speaker: string }[] = []
  const edits: { start: number; end: number; value: string }[] = []
  let next = description
  for (const unit of dialogueSpans(description)) {
    const text = spokenText(unit.text)
    if (text.length < 12 || !unit.speaker) continue
    if (originals.some(d => d.speaker === unit.speaker && spokenText(d.text) === text)) continue
    const candidates = originals.filter(d => {
      const full = spokenText(d.text)
      if (d.speaker !== unit.speaker || full.length <= text.length || text.length / full.length < 0.7) return false
      let cursor = 0
      for (const char of full) if (char === text[cursor]) cursor++
      return cursor === text.length && full.startsWith(text.slice(0, 8)) && full.endsWith(text.slice(-8))
    })
    if (candidates.length === 1) {
      edits.push({ start: unit.textStart, end: unit.textEnd, value: candidates[0].text })
      restorations.push({ before: unit.text, after: candidates[0].text, speaker: unit.speaker })
    }
  }
  for (const edit of edits.reverse()) next = next.slice(0, edit.start) + edit.value + next.slice(edit.end)
  return { description: next, restorations }
}
