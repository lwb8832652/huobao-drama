import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateProductionRules, mergeProductionReview, validateQualityEdits, type QualityInput } from '../src/services/production-quality-domain.js'

const panel = (id: number, description: string, extra = {}) => ({ id, title: `分镜${id}`, description, videoPrompt: `0-15秒：${description}`, durationMs: 15000, ...extra })
const visual = (speech: string) => `【镜头1】甲站在门前，抬头望向来人。\n${speech}`
const source = '甲：「你终于回来了。」\n乙：「我们一起回家吧。」'
const input = (): QualityInput => ({ script: source, panels: [panel(1, visual('甲：「你终于回来了。」')), panel(2, visual('乙：「我们一起回家吧。」'))] })
const scriptIssues = (value: QualityInput) => evaluateProductionRules(value).issues.filter(issue => issue.rule.startsWith('script_dialogue_'))

test('whole episode detects dialogue from a scene that has no panel and exposes missing words', () => {
  const value = input()
  value.script += '\n场景：院子\n旁白：「雨还在下，他没有再回来。」'
  const issue = scriptIssues(value).find(issue => issue.rule === 'script_dialogue_missing')
  assert.equal(issue?.severity, 'fail')
  assert.deepEqual(issue?.panelIds, [])
  assert.match(issue?.evidence || '', /雨还在下他没有再回来/)
})

test('a same-speaker source line can split across consecutive panels without losing coverage', () => {
  const value = { script: '甲：「你终于回来了，我们一起回家吧。」', panels: [panel(1, visual('甲：「你终于回来了。」')), panel(2, visual('甲：「我们一起回家吧。」'))] }
  assert.deepEqual(scriptIssues(value), [])
  assert.equal(evaluateProductionRules(value).overallScore, 100)
})

test('normalization permits punctuation changes without changing speech', () => {
  assert.deepEqual(scriptIssues({ script: 'Alex：「ＡＢＣ，１２３！」', panels: [panel(1, visual('Alex：「ABC 123。」'))] }), [])
})

test('repeated original lines require every occurrence', () => {
  const issue = scriptIssues({ script: '甲：「回来。」\n甲：「回来。」', panels: [panel(1, visual('甲：「回来。」'))] })
  assert.ok(issue.some(issue => issue.rule === 'script_dialogue_missing'))
})

test('duplicated panel speech is newly added speech even when the words occur in the script', () => {
  const value = input()
  value.panels.push(panel(3, visual('乙：「我们一起回家吧。」')))
  const issue = scriptIssues(value).find(issue => issue.rule === 'script_dialogue_added')
  assert.equal(issue?.severity, 'fail')
  assert.deepEqual(issue?.panelIds, [3])
})

test('original words in a different episode order fail', () => {
  const value = input()
  value.panels.reverse()
  assert.ok(scriptIssues(value).some(issue => issue.rule === 'script_dialogue_order'))
})

test('speaker checks follow normalized character ranges through line merges', () => {
  const value = { script: source, panels: [panel(1, visual('甲：「你终于回来了，我们一起回家吧。」'))] }
  const issue = scriptIssues(value).find(issue => issue.rule === 'script_dialogue_speaker_mismatch')
  assert.deepEqual(issue?.panelIds, [1])
})

test('identical repeated lines cannot be reassigned to a different speaker', () => {
  const value = { script: '甲：「回来。」\n乙：「回来。」', panels: [panel(1, visual('乙：「回来。」\n甲：「回来。」'))] }
  assert.ok(scriptIssues(value).some(issue => issue.rule === 'script_dialogue_speaker_mismatch'))
})

test('narration identity and kind are preserved', () => {
  const value = { script: '旁白：「雨还在下。」', panels: [panel(1, visual('甲：「雨还在下。」'))] }
  assert.ok(scriptIssues(value).some(issue => issue.rule === 'script_dialogue_kind_mismatch'))
})

test('script omission and invented replacement speech both carry evidence', () => {
  const value = { script: '甲：「山上风很大。」', panels: [panel(1, visual('甲：「河边水很深。」'))] }
  const issues = scriptIssues(value)
  assert.ok(issues.some(issue => issue.rule === 'script_dialogue_missing' && issue.evidence?.includes('山')))
  assert.ok(issues.some(issue => issue.rule === 'script_dialogue_added' && issue.evidence?.includes('河')))
})

test('unavailable and metadata-only legacy scripts report uncertainty instead of invented hard failures', () => {
  for (const script of ['', '场景：院子\n人物：甲、乙\n画面：雨夜，甲抬头。']) {
    const result = evaluateProductionRules({ script, panels: [panel(1, visual('甲：「你回来了。」'))] })
    assert.equal(result.confidence, 'low')
    assert.ok(result.issues.some(issue => issue.rule.startsWith('script_') && issue.severity === 'warning'))
    assert.ok(!result.issues.some(issue => issue.rule === 'script_dialogue_added' && issue.severity === 'fail'))
  }
})

test('per-panel timing failures survive and downstream media review is only a warning', () => {
  const text = '我们应该马上一起回到那个已经离开很久的村子里去看看大家到底怎么样了。'
  const value = { script: `甲：「${text}」`, panels: [panel(1, visual(`甲：「${text}」`), { durationMs: 2000, framePlanNeedsReview: true })] }
  const issues = evaluateProductionRules(value).issues
  assert.ok(issues.some(issue => issue.rule === 'dialogue_total_overflow' && issue.severity === 'fail'))
  assert.ok(issues.some(issue => issue.rule === 'frame_plan_review' && issue.severity === 'warning'))
})

test('empty episode and speech-only shots expose planning gaps', () => {
  const empty = evaluateProductionRules({ script: source, panels: [] })
  assert.equal(empty.overallScore, null)
  assert.ok(empty.issues.some(issue => issue.rule === 'production_panels_empty'))
  assert.ok(evaluateProductionRules({ script: '甲：「你好。」', panels: [panel(1, '甲：「你好。」')] }).issues.some(issue => issue.rule === 'visual_description_missing'))
})

test('rule issue IDs are deterministic across reviews and unaffected by unrelated issues', () => {
  const value = input()
  value.script += '\n甲：「不要走。」'
  const before = evaluateProductionRules(value).issues.find(issue => issue.rule === 'script_dialogue_missing')
  value.panels[0].durationMs = 1
  const after = evaluateProductionRules(value).issues.find(issue => issue.rule === 'script_dialogue_missing')
  assert.equal(before?.id, after?.id)
  assert.ok(before?.id)
})

test('AI perfect scores cannot erase deterministic failures', () => {
  const value = input()
  value.script += '\n甲：「不要走。」'
  const result = mergeProductionReview(value, { overallScore: 100, confidence: 'high', issues: [], dimensions: { dialogue: { score: 100, comment: '没有问题' } } })
  assert.ok(result.issues.some(issue => issue.rule === 'script_dialogue_missing' && issue.severity === 'fail'))
  assert.ok(result.overallScore !== null && result.overallScore < 60)
  assert.ok(result.dimensions.dialogue.score < 100)
})

test('AI subjective issues always become warnings and IDs are server generated', () => {
  const result = mergeProductionReview(input(), { issues: [{ id: 'attacker', rule: 'rhythm', severity: 'fail', panelIds: [2], message: '接话过急', suggestion: '增加停顿', evidence: '第二段开头' }] })
  const issue = result.issues.find(issue => issue.message === '接话过急')
  assert.equal(issue?.severity, 'warning')
  assert.equal(issue?.rule, 'rhythm')
  assert.notEqual(issue?.id, 'attacker')
  assert.deepEqual(issue?.panelIds, [2])
})

test('AI issues containing unknown IDs or malformed fields are rejected', () => {
  const result = mergeProductionReview(input(), { issues: [
    { panelIds: [1, 999], message: '未知分镜', suggestion: '修复' },
    { panelIds: ['1'], message: '字符串 ID', suggestion: '修复' },
    { panelIds: [1], message: '', suggestion: '修复' },
    { panelIds: [1], message: '没有建议' },
  ] })
  assert.equal(result.issues.length, 0)
})

test('AI scores are bounded and invalid numbers fall back to deterministic values', () => {
  const result = mergeProductionReview(input(), { overallScore: -200, dimensions: { dialogue: { score: 500, comment: '完整' }, timing: { score: Number.NaN }, coverage: { score: -20, comment: '不足' } } })
  assert.equal(result.overallScore, 0)
  assert.equal(result.dimensions.dialogue.score, 100)
  assert.equal(result.dimensions.timing.score, 100)
  assert.equal(result.dimensions.coverage.score, 0)
  assert.deepEqual(mergeProductionReview(input(), null), evaluateProductionRules(input()))
})

test('selected visual and atmosphere edits preserve split/merged same-speaker speech', () => {
  const value = { script: '甲：「你终于回来了，我们一起回家吧。」', panels: [panel(1, visual('甲：「你终于回来了，我们一起回家吧。」'))] }
  assert.doesNotThrow(() => validateQualityEdits(value, [1], [{ panelId: 1, description: '【镜头1】甲走近门口。\n甲：「你终于回来了。」\n【镜头2】甲伸出右手。\n甲：「我们一起回家吧。」', atmosphere: '暮色' }]))
})

test('quality edits reject unknown, duplicate and unselected panel IDs', () => {
  const value = input()
  const edit = { panelId: 1, description: value.panels[0].description }
  assert.throws(() => validateQualityEdits(value, [1], [{ ...edit, panelId: 999 }]), /分镜|panel/i)
  assert.throws(() => validateQualityEdits(value, [1], [edit, edit]), /重复|duplicate/i)
  assert.throws(() => validateQualityEdits(value, [2], [edit]), /选择|selected/i)
  assert.throws(() => validateQualityEdits(value, [999], [edit]), /分镜|panel/i)
})

test('quality edits reject empty descriptions and speech-only shots', () => {
  for (const description of ['', '   ', '甲：「你终于回来了。」']) {
    assert.throws(() => validateQualityEdits(input(), [1], [{ panelId: 1, description }]), /画面|visual|描述/i)
  }
})

test('quality edits reject deleting, inventing, reordering and reassigning existing words', () => {
  const value = { script: source, panels: [panel(1, visual(source))] }
  for (const speech of ['甲：「你终于回来。」\n乙：「我们一起回家吧。」', `${source}\n甲：「不要走。」`, '乙：「我们一起回家吧。」\n甲：「你终于回来了。」', '乙：「你终于回来了。」\n甲：「我们一起回家吧。」']) {
    assert.throws(() => validateQualityEdits(value, [1], [{ panelId: 1, description: visual(speech) }]), /对白|speech|说话/i)
  }
})

test('unique near-exact same-speaker restoration can recover dropped script words', () => {
  const short = '斗之气旋一夜之间化为乌有，从天才的神坛摔下来。'
  const full = '斗之气旋一夜之间化为乌有，斗之气越来越少，从天才的神坛摔下来。'
  const value = { script: `甲：「${full}」`, panels: [panel(1, visual(`甲：「${short}」`))] }
  assert.doesNotThrow(() => validateQualityEdits(value, [1], [{ panelId: 1, description: visual(`甲：「${full}」`) }]))
})

test('whole episode sequence improvement can restore a complete missing line without losing existing speech', () => {
  const value = input()
  value.script = '甲：「你终于回来了。」\n甲：「快进屋坐下。」\n乙：「我们一起回家吧。」'
  assert.doesNotThrow(() => validateQualityEdits(value, [1], [{ panelId: 1, description: visual('甲：「你终于回来了。」\n甲：「快进屋坐下。」') }]))
})

test('restoration cannot move words from an unselected neighboring panel', () => {
  const value = input()
  assert.throws(() => validateQualityEdits(value, [1], [{ panelId: 1, description: visual(source) }]), /对白|speech|说话/i)
})

test('ambiguous partial restoration is rejected even if one occurrence could fit', () => {
  const value = { script: '甲：「回来。」\n甲：「站住。」\n甲：「回来。」\n甲：「站住。」', panels: [panel(1, visual('甲：「回来。」'))] }
  assert.throws(() => validateQualityEdits(value, [1], [{ panelId: 1, description: visual('甲：「回来。」\n甲：「站住。」') }]), /对白|speech|说话/i)
})

test('a local near-match restoration cannot duplicate script words already spoken in a neighbor', () => {
  const short = '斗之气旋一夜之间化为乌有，从天才的神坛摔下来。'
  const full = '斗之气旋一夜之间化为乌有，斗之气越来越少，从天才的神坛摔下来。'
  const value = { script: `甲：「${full}」`, panels: [panel(1, visual(`甲：「${short}」`)), panel(2, visual('甲：「斗之气越来越少。」'))] }
  assert.throws(() => validateQualityEdits(value, [1], [{ panelId: 1, description: visual(`甲：「${full}」`) }]), /对白|speech|说话/i)
})

test('speaking-budget failures lower timing while correctly preserved dialogue stays intact', () => {
  const script = `甲：「${'我们应该马上回到村子里去看看大家。'.repeat(6)}」`
  const result = evaluateProductionRules({ script, panels: [panel(1, visual(script))] })
  assert.ok(result.dimensions.timing.score < 100)
  assert.equal(result.dimensions.dialogue.score, 100)
})
