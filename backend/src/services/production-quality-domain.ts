import { createHash } from 'node:crypto'
import { analyzePanelProduction, extractDialogue, parseShotDescription, restoreScriptDialogue, spokenChars, spokenText, type DialogueUnit, type PlanningPanel } from './shot-planning.js'

export interface QualityIssue {
  id: string
  rule: string
  severity: 'fail' | 'warning'
  panelIds: number[]
  message: string
  suggestion: string
  evidence?: string
}
export interface QualityInput {
  script: string
  visualAssets?: {
    style: string
    characters: { id: number; name: string; appearance: string; styling: string; imageUrl: string }[]
    scenes: { id: number; location: string; time: string; prompt: string; lighting: string; imageUrl: string }[]
    props: { id: number; name: string; description: string; imageUrl: string }[]
  }
  panels: (PlanningPanel & { sceneId?: number | null; scene?: string; characterIds?: number[]; propIds?: number[] })[]
}
type Dimension = 'dialogue' | 'timing' | 'coverage' | 'continuity' | 'production'
export interface QualityResult {
  overallScore: number | null
  confidence: 'high' | 'medium' | 'low'
  summary: string
  dimensions: Record<Dimension, { score: number; comment: string }>
  issues: QualityIssue[]
}
export interface QualityEdit { panelId: number; description: string; atmosphere?: string }

interface SpeechChar { char: string; speaker: string; kind: DialogueUnit['kind']; panelId?: number }
const dimensionNames: Record<Dimension, string> = { dialogue: '对白', timing: '时间', coverage: '画面覆盖', continuity: '连续性', production: '制作成本' }
const dimensions = Object.keys(dimensionNames) as Dimension[]
const speech = (text: string, panelId?: number): SpeechChar[] => extractDialogue(text).flatMap(unit => [...spokenText(unit.text)].map(char => ({ char, speaker: unit.speaker.normalize('NFKC'), kind: unit.kind, panelId })))
const episodeSpeech = (input: QualityInput) => input.panels.flatMap(panel => speech(panel.description, panel.id))
const sameSpeech = (a: SpeechChar, b: SpeechChar) => a.char === b.char && a.speaker === b.speaker && a.kind === b.kind
const exactSpeech = (a: SpeechChar[], b: SpeechChar[]) => a.length === b.length && a.every((char, i) => sameSpeech(char, b[i]))
const textOf = (chars: SpeechChar[]) => chars.map(char => char.char).join('')

function subsequence(pattern: SpeechChar[], source: SpeechChar[], equal = sameSpeech): number[] | null {
  const positions: number[] = []
  let cursor = 0
  for (let i = 0; i < source.length && cursor < pattern.length; i++) if (equal(pattern[cursor], source[i])) { positions.push(i); cursor++ }
  return cursor === pattern.length ? positions : null
}
function uniqueSubsequence(pattern: SpeechChar[], source: SpeechChar[]) {
  const first = subsequence(pattern, source)
  if (!first) return false
  let cursor = pattern.length - 1
  for (let i = source.length - 1; i >= 0 && cursor >= 0; i--) if (sameSpeech(pattern[cursor], source[i])) {
    if (first[cursor] !== i) return false
    cursor--
  }
  return true
}

/** Compare the whole stream, including repetitions. Line boundaries may change. */
function alignWords(expected: SpeechChar[], actual: SpeechChar[]) {
  const equal = (a: SpeechChar, b: SpeechChar) => a.char === b.char
  const pairs: [number, number][] = []
  let prefix = 0
  while (prefix < expected.length && prefix < actual.length && equal(expected[prefix], actual[prefix])) { pairs.push([prefix, prefix]); prefix++ }
  let endExpected = expected.length, endActual = actual.length
  while (endExpected > prefix && endActual > prefix && equal(expected[endExpected - 1], actual[endActual - 1])) { endExpected--; endActual-- }
  const left = expected.slice(prefix, endExpected), right = actual.slice(prefix, endActual)
  const leftInRight = subsequence(left, right, equal), rightInLeft = subsequence(right, left, equal)
  if (leftInRight) leftInRight.forEach((at, i) => pairs.push([prefix + i, prefix + at]))
  else if (rightInLeft) rightInLeft.forEach((at, i) => pairs.push([prefix + at, prefix + i]))
  else if (left.length * right.length <= 1_000_000) {
    // Bound work for unrelated/legacy scripts. A large unmatched middle is still
    // an exact coverage failure, but its evidence is deliberately less specific.
    const width = right.length + 1, table = new Uint32Array((left.length + 1) * width)
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = equal(left[i], right[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
    let i = 0, j = 0
    while (i < left.length && j < right.length) {
      if (equal(left[i], right[j])) { pairs.push([prefix + i++, prefix + j++]); continue }
      if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++
      else j++
    }
  }
  while (endExpected < expected.length) pairs.push([endExpected++, endActual++])
  const matchedExpected = new Set(pairs.map(pair => pair[0])), matchedActual = new Set(pairs.map(pair => pair[1]))
  return { pairs, missing: expected.flatMap((_, i) => matchedExpected.has(i) ? [] : [i]), added: actual.flatMap((_, i) => matchedActual.has(i) ? [] : [i]) }
}
function evidence(chars: SpeechChar[], indices: number[]) {
  let previous = -2
  return indices.map(i => { const gap = previous + 1 < i && previous >= 0 ? ' … ' : ''; previous = i; return gap + chars[i].char }).join('').slice(0, 1200)
}
const uniqueIds = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b)
function issue(value: Omit<QualityIssue, 'id'>): QualityIssue {
  const canonical = { ...value, panelIds: uniqueIds(value.panelIds) }
  const id = `quality_${createHash('sha256').update(JSON.stringify([canonical.rule, canonical.severity, canonical.panelIds, canonical.message, canonical.evidence || ''])).digest('hex').slice(0, 20)}`
  return { id, ...canonical }
}
function dimensionFor(rule: string): Dimension {
  if (/time|duration|pacing|overflow|tight/.test(rule)) return 'timing'
  if (/dialogue|speaker/.test(rule)) return 'dialogue'
  if (/scene|binding|continuity/.test(rule)) return 'continuity'
  if (/visual|frame|shot/.test(rule)) return 'coverage'
  return 'production'
}
function suggestionFor(rule: string) {
  if (/dialogue.*(?:overflow|tight)|pacing/.test(rule)) return '完整保留对白，延长时长或在语义边界拆段，为停顿与表演留出余量。'
  if (/dialogue|speaker/.test(rule)) return '对照原剧本恢复完整对白、重复次数、说话人和原始顺序。'
  if (/frame/.test(rule)) return '完成分镜规划后，重新规划并审阅每个镜头对应的参考画面。'
  if (/time|duration/.test(rule)) return '使用统一镜头计划重新派生时间与提示词，连续覆盖分镜总时长。'
  return '核对描述、时长和镜头计划后重新规划，保留完整剧情。'
}

export function evaluateProductionRules(input: QualityInput): QualityResult {
  const issues: QualityIssue[] = []
  const add = (rule: string, severity: QualityIssue['severity'], panelIds: number[], message: string, suggestion: string, evidence?: string) => issues.push(issue({ rule, severity, panelIds, message, suggestion, ...(evidence ? { evidence } : {}) }))
  if (!input.panels.length) add('production_panels_empty', 'fail', [], '本集还没有可评测的分镜。', '先完成整集分镜拆分，再运行规划质量评测。')
  const expected = speech(input.script || ''), actual = episodeSpeech(input)
  if (!expected.length) {
    add(input.script?.trim() ? 'script_dialogue_unavailable' : 'script_unavailable', 'warning', [], input.script?.trim() ? '原剧本没有可可靠识别的对白，无法确认整集对白覆盖。' : '缺少原剧本，无法确认整集对白覆盖。', '补全原剧本并明确标注说话人后重新评测；当前分镜对白仅作逐条核对。')
  } else {
    const { pairs, missing, added } = alignWords(expected, actual)
    const expectedText = textOf(expected), actualText = textOf(actual)
    const reordered = expectedText !== actualText && [...expectedText].sort().join('') === [...actualText].sort().join('')
    if (reordered) add('script_dialogue_order', 'fail', uniqueIds(input.panels.filter(panel => speech(panel.description).length).map(panel => panel.id)), '整集对白的原始顺序发生变化。', '按照原剧本顺序恢复对白，不能用挪动台词掩盖覆盖问题。', `${expectedText.slice(0, 500)} → ${actualText.slice(0, 500)}`)
    else {
      if (missing.length) add('script_dialogue_missing', 'fail', [], `整集分镜未完整保留原剧本的 ${missing.length} 个对白字词。`, '逐句对照原剧本恢复缺失对白；缺少整场戏时补充分镜，不得跳过。', evidence(expected, missing))
      if (added.length) add('script_dialogue_added', 'fail', uniqueIds(added.flatMap(i => actual[i].panelId === undefined ? [] : [actual[i].panelId!])), '整集分镜出现原剧本没有的对白或多余重复。', '删除新增或多余重复的台词，保留原剧本中的每一次原始发言。', evidence(actual, added))
    }
    const wrongSpeakers = pairs.filter(([a, b]) => expected[a].speaker && expected[a].speaker !== actual[b].speaker)
    const wrongKinds = pairs.filter(([a, b]) => expected[a].kind !== actual[b].kind)
    for (const [rule, wrong, message] of [
      ['script_dialogue_speaker_mismatch', wrongSpeakers, '整集分镜的对白归属与原剧本不一致。'],
      ['script_dialogue_kind_mismatch', wrongKinds, '整集分镜将对白、旁白或内心独白的类型改变。'],
    ] as const) if (wrong.length) add(rule, 'fail', uniqueIds(wrong.flatMap(([, b]) => actual[b].panelId === undefined ? [] : [actual[b].panelId!])), message, '按原剧本恢复说话人和发言类型，允许同一发言跨分镜连续拆句。', evidence(actual, wrong.map(([, b]) => b)))
  }
  for (const panel of input.panels) {
    for (const found of analyzePanelProduction(panel).issues) {
      // Image mapping is downstream of the breakdown and may legitimately await
      // adoption/replanning. Keep it visible without blocking planning quality.
      const severity = /^(?:frame_|invalid_frame_)/.test(found.rule) ? 'warning' : found.severity
      add(found.rule, severity, [panel.id], found.message, suggestionFor(found.rule))
    }
    const shots = parseShotDescription(panel.description || '')
    if (!shots.length || shots.some(shot => spokenChars(shot.visual) < 2)) add('visual_description_missing', 'fail', [panel.id], '分镜包含缺少可视画面描述的镜头。', '为每个子镜头补充可拍摄的人物动作、构图或场景状态，同时保留完整对白。')
    if (!Number.isFinite(panel.durationMs) || panel.durationMs <= 0) add('duration_invalid', 'fail', [panel.id], '分镜时长无效。', '用统一镜头计划计算正数时长，并保留完整发声与表演时间。')
    if (panel.scene && panel.sceneId === null) add('scene_binding_missing', 'warning', [panel.id], '分镜已描述场景，但尚未绑定场景素材。', '核对场景并绑定已有素材，避免后续画面生成时场景漂移。')
    if (shots.length > 9) add('production_shot_count', 'warning', [panel.id], `当前分镜含 ${shots.length} 个子镜头，超出单次九格画面规划范围。`, '按语义和制作时长分段，核对新增视频生成数量。')
  }
  const deduplicated = [...new Map(issues.map(value => [value.id, value])).values()]
  const dimensionResult = Object.fromEntries(dimensions.map(key => {
    const related = deduplicated.filter(value => dimensionFor(value.rule) === key)
    return [key, { score: Math.max(0, 100 - related.reduce((total, value) => total + (value.severity === 'fail' ? 30 : 8), 0)), comment: related.length ? `${dimensionNames[key]}有 ${related.length} 项需核对。` : `${dimensionNames[key]}规则检查通过。` }]
  })) as QualityResult['dimensions']
  const failCount = deduplicated.filter(value => value.severity === 'fail').length
  const warningCount = deduplicated.length - failCount
  const score = Math.round(dimensions.reduce((total, key) => total + dimensionResult[key].score, 0) / dimensions.length)
  return {
    overallScore: input.panels.length ? Math.min(score, failCount ? 59 : 100) : null,
    confidence: expected.length ? (extractDialogue(input.script).some(unit => !unit.speaker) ? 'medium' : 'high') : 'low',
    summary: failCount ? `规则检查发现 ${failCount} 项未通过、${warningCount} 项待核对。` : warningCount ? `规则检查没有阻断问题，${warningCount} 项需核对。` : '整集对白覆盖及分镜规划规则检查通过。',
    dimensions: dimensionResult,
    issues: deduplicated,
  }
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const boundedScore = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback
const cleanText = (value: unknown, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : ''

export function mergeProductionReview(input: QualityInput, ai: unknown): QualityResult {
  const base = evaluateProductionRules(input), review = record(ai)
  if (!review) return base
  const known = new Set(input.panels.map(panel => panel.id))
  for (const raw of Array.isArray(review.issues) ? review.issues : []) {
    const value = record(raw)
    if (!value || !Array.isArray(value.panelIds) || value.panelIds.some(id => typeof id !== 'number' || !known.has(id))) continue
    const message = cleanText(value.message), suggestion = cleanText(value.suggestion)
    if (!message || !suggestion) continue
    base.issues.push(issue({ rule: cleanText(value.rule, 100) || 'ai_review', severity: 'warning', panelIds: uniqueIds(value.panelIds as number[]), message, suggestion, ...(cleanText(value.evidence) ? { evidence: cleanText(value.evidence) } : {}) }))
  }
  base.issues = [...new Map(base.issues.map(value => [value.id, value])).values()]
  const reviewedDimensions = record(review.dimensions)
  for (const key of dimensions) {
    const dimension = record(reviewedDimensions?.[key])
    if (!dimension) continue
    base.dimensions[key] = { score: Math.min(base.dimensions[key].score, boundedScore(dimension.score, base.dimensions[key].score)), comment: cleanText(dimension.comment) || base.dimensions[key].comment }
  }
  if (base.overallScore !== null) {
    const dimensionScore = Math.round(dimensions.reduce((total, key) => total + base.dimensions[key].score, 0) / dimensions.length)
    base.overallScore = Math.min(base.overallScore, dimensionScore, boundedScore(review.overallScore, base.overallScore))
  }
  const summary = cleanText(review.summary)
  if (summary) base.summary += ` AI 评测：${summary}`
  if (base.confidence === 'high' && (review.confidence === 'low' || review.confidence === 'medium')) base.confidence = review.confidence
  else if (base.confidence === 'medium' && review.confidence === 'low') base.confidence = 'low'
  return base
}

export function validateQualityEdits(input: QualityInput, selectedIds: number[], edits: QualityEdit[]): void {
  const panels = new Map(input.panels.map(panel => [panel.id, panel]))
  const selected = new Set(selectedIds)
  if (selected.size !== selectedIds.length) throw new Error('选择的分镜 ID 重复。')
  if (selectedIds.some(id => !panels.has(id))) throw new Error('选择了未知分镜。')
  if (!Array.isArray(edits) || !edits.length) throw new Error('没有可采用的分镜优化候选。')
  const editMap = new Map<number, QualityEdit>()
  for (const edit of edits) {
    if (!edit || !panels.has(edit.panelId)) throw new Error('优化候选包含未知分镜。')
    if (editMap.has(edit.panelId)) throw new Error('优化候选包含重复分镜。')
    if (!selected.has(edit.panelId)) throw new Error('优化候选修改了未选择的分镜。')
    const shots = typeof edit.description === 'string' ? parseShotDescription(edit.description) : []
    if (!shots.length || shots.some(shot => spokenChars(shot.visual) < 2)) throw new Error('优化候选必须为每个镜头提供非空的可视画面描述。')
    if (edit.atmosphere !== undefined && typeof edit.atmosphere !== 'string') throw new Error('优化候选的氛围描述无效。')
    editMap.set(edit.panelId, edit)
  }
  const before = episodeSpeech(input)
  const after = episodeSpeech({ ...input, panels: input.panels.map(panel => editMap.has(panel.id) ? { ...panel, description: editMap.get(panel.id)!.description } : panel) })
  const source = speech(input.script || '')
  const candidateFitsSource = subsequence(after, source) !== null
  // This permits restoring an entirely missing line, but only when all existing
  // words stay in their panels and the complete candidate has one source placement.
  const globalImprovement = after.length > before.length && uniqueSubsequence(after, source)
    && input.panels.every(panel => !editMap.has(panel.id) || subsequence(speech(panel.description), speech(editMap.get(panel.id)!.description)) !== null)
  for (const edit of edits) {
    const original = panels.get(edit.panelId)!, oldSpeech = speech(original.description), newSpeech = speech(edit.description)
    if (exactSpeech(oldSpeech, newSpeech)) continue
    const restored = restoreScriptDialogue(original.description, input.script || '')
    if (candidateFitsSource && restored.restorations.length && exactSpeech(speech(restored.description), newSpeech)) continue
    if (globalImprovement) continue
    throw new Error(`分镜 ${edit.panelId} 的优化候选删除、新增、重排或重新分配了对白；仅允许可唯一核对的原剧本漏词恢复。`)
  }
}
