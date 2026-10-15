import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as planning from '../src/services/shot-planning.js'

const panel = (description: string, videoPrompt = '', durationMs = 15000) => ({ id: 24, title: '对白测试', description, videoPrompt, durationMs, atmosphere: '晨光' })
const longLine = '三年前四岁练气十岁九段斗之气十一岁凝聚斗之气旋家族百年最年轻的斗者那时的他多意气风发啊'

test('quoted punctuation does not split a shot into empty quotes or lose its last visual action', () => {
  const shots = planning.parseShotDescription('【镜头1】小明站在碑前。测验员：（冷漠）「三段！级别——低级！」\n【镜头2】小明收回手掌，握紧拳头。')
  assert.equal(shots.length, 2)
  assert.equal(shots[0].dialogue.length, 1)
  assert.equal(shots[0].dialogue[0].speaker, '测验员')
  assert.match(shots[1].visual, /收回手掌.*握紧拳头/)
  assert.doesNotMatch(shots.map(s => s.visual).join(''), /[「」]/)
})

test('keeps narration and unquoted screenplay lines with explicit speaker identity', () => {
  const shots = planning.parseShotDescription('【镜头1】小明走入房间。\n旁白：三年前，故事从这里开始。\n小明：（低声）我回来了。')
  assert.deepEqual(shots[0].dialogue.map(d => [d.speaker, d.kind, d.text]), [['旁白', 'narration', '三年前，故事从这里开始。'], ['小明', 'dialogue', '我回来了。']])
})

test('catches a long line in the last three seconds even when the whole panel has spare capacity', () => {
  const target = panel(`【镜头1】小明抬头。小明：（低语）「${longLine}」`, `0-12秒：小明抬头。\n12-15秒：小明说：「${longLine}」`)
  const report = planning.analyzePanelProduction(target)
  assert.ok(report.issues.some(i => i.rule === 'dialogue_window_overflow' && i.severity === 'fail'))
})

test('detects missing ending words instead of treating a shortened prompt as within budget', () => {
  const target = panel('【镜头1】小明冷笑。小明：「这种废物早被赶出家族了，哪还能在这儿白吃白喝。」', '0-15秒：小明冷笑说：「这种废物早被赶出家族了。」')
  assert.ok(planning.analyzePanelProduction(target).issues.some(i => i.rule === 'dialogue_missing'))
})

test('rejects reordered or duplicated dialogue even when all original words occur somewhere', () => {
  const target = panel('【镜头1】甲：「你好。」乙：「再见。」', '0-7秒：乙：「再见。」\n7-15秒：甲：「你好。」')
  assert.ok(planning.analyzePanelProduction(target).issues.some(i => i.rule === 'dialogue_mismatch'))
})

test('checks gaps, overlaps and uncovered end time but accepts flexible time windows', () => {
  assert.ok(planning.analyzePanelProduction(panel('【镜头1】小明走路。', '0-5秒：小明走路。\n6-12秒：小明停步。', 14000)).issues.some(i => i.rule === 'prompt_time_gap'))
  assert.ok(planning.analyzePanelProduction(panel('【镜头1】小明走路。', '0-8秒：走路。\n7-15秒：停步。')).issues.some(i => i.rule === 'prompt_time_overlap'))
  assert.equal(planning.analyzePanelProduction(panel('【镜头1】小明走路。', '0-4.5秒：走路。\n4.5-14秒：停步。', 14000)).issues.filter(i => i.severity === 'fail').length, 0)
})

test('retimes a complete line across the available panel without forcing three-second blocks', () => {
  const target = panel('【镜头1】小明抬头。小明：（低语）「这些人……都如此刻薄势利吗？三年前他们在自己面前露出的，可是最谦卑的笑容啊。」\n【镜头2】小明低头。')
  const result = planning.buildProductionPlan(target, { maxSeconds: 15 })
  assert.ok(result.segments.length >= 1)
  for (const segment of result.segments) {
    assert.ok(segment.durationMs <= 15000)
    const rendered = planning.renderProductionPrompt(segment.plan, target.atmosphere)
    const analysis = planning.analyzePanelProduction(panel(segment.description, rendered, segment.durationMs))
    assert.equal(analysis.issues.filter(i => i.severity === 'fail').length, 0, JSON.stringify(analysis.issues))
  }
})

test('splits overlong dialogue at safe sentence boundaries, preserving every word and visual shot', () => {
  const target = panel(`【镜头1】萧媚垂眸。萧媚：（轻声）「${longLine}。${longLine}。${longLine}。」\n【镜头2】萧媚抬头望向远处。`)
  const result = planning.buildProductionPlan(target, { maxSeconds: 15 })
  assert.ok(result.segments.length > 1)
  const before = planning.extractDialogue(target.description).map(d => d.text).join('')
  const after = result.segments.flatMap(s => s.plan.shots.flatMap(shot => shot.dialogue.map(d => d.text))).join('')
  assert.equal(after, before)
  assert.match(result.segments.map(s => s.description).join(''), /萧媚抬头望向远处/)
  assert.ok(result.segments.every(s => s.durationMs <= 15000))
  assert.ok(result.segments.every(s => s.plan.shots.every(shot => shot.endMs > shot.startMs)))
})

test('rejects an unbreakable phrase longer than the provider capacity instead of truncating text', () => {
  assert.throws(() => planning.buildProductionPlan(panel(`【镜头1】甲：「${'很'.repeat(100)}」`), { maxSeconds: 5 }), /拆句|语义|单句/)
})

test('timed plans become stale after description, duration or rendered prompt edits', () => {
  const target = panel('【镜头1】甲站定。甲：「你好。」')
  const segment = planning.buildProductionPlan(target, { maxSeconds: 15 }).segments[0]
  const applied = { ...target, description: segment.description, durationMs: segment.durationMs, videoPrompt: planning.renderProductionPrompt(segment.plan, target.atmosphere) }
  assert.equal(planning.productionPlanMatchesPanel(segment.plan, applied), true)
  assert.equal(planning.productionPlanMatchesPanel(segment.plan, { ...applied, description: '改变剧情' }), false)
  assert.equal(planning.productionPlanMatchesPanel(segment.plan, { ...applied, durationMs: 5000 }), false)
  assert.equal(planning.productionPlanMatchesPanel(segment.plan, { ...applied, videoPrompt: '改变提示词' }), false)
})

test('long static dialogue uses one visual keyframe while multiple visual shots retain coverage', () => {
  assert.equal(planning.suggestedVisualCount(panel('【镜头1】小明坐着说话。小明：「你回来就好。」', '', 15000)), 1)
  assert.equal(planning.suggestedVisualCount(panel('【镜头1】小明走近。\n【镜头2】伸手递杯。\n【镜头3】小红接住。')), 3)
})

test('script restoration only uses an unambiguous same-speaker near-exact match', () => {
  const description = '【镜头1】萧媚低头。萧媚：（低声）「斗之气旋一夜之间化为乌有，从天才的神坛摔下来。」'
  const script = '萧媚：（低声）斗之气旋一夜之间化为乌有，斗之气越来越少，从天才的神坛摔下来。'
  const restored = planning.restoreScriptDialogue(description, script)
  assert.match(restored.description, /斗之气越来越少/)
  assert.equal(restored.restorations.length, 1)
  const ambiguous = planning.restoreScriptDialogue(description, `${script}\n${script.replace('越来越少', '逐渐消散')}`)
  assert.equal(ambiguous.restorations.length, 0)
  assert.equal(ambiguous.description, description)
})

test('quote-only frames are rejected and spoken lines retain the correct speaker', () => {
  assert.equal(planning.invalidVisualPrompt('甲：「你好，很高兴见到你。」'), true)
  assert.equal(planning.invalidVisualPrompt('甲站起，伸手递杯。'), false)
  assert.ok(planning.analyzePanelProduction(panel('甲：「你好。」', '0-15秒：乙：「你好。」')).issues.some(i => i.rule === 'dialogue_speaker_mismatch'))
})

test('small duration limits never produce a segment below the hard dialogue floor', () => {
  const result = planning.buildProductionPlan(panel('【镜头1】甲站定。甲：「一二三四五六，七八九十。」'), { maxSeconds: 4 })
  for (const segment of result.segments) {
    const report = planning.analyzePanelProduction(panel(segment.description, planning.renderProductionPrompt(segment.plan), segment.durationMs))
    assert.equal(report.issues.filter(i => i.severity === 'fail').length, 0, JSON.stringify(report.issues))
    assert.ok(segment.plan.shots.every(s => s.dialogue.every(d => d.startMs >= s.startMs && d.endMs <= s.endMs)))
  }
})

test('validates internal speech intervals even if outer prompt windows cover the panel', () => {
  const segment = planning.buildProductionPlan(panel('【镜头1】甲站定。甲：「你好。」'), { maxSeconds: 15 }).segments[0]
  segment.plan.shots[0].dialogue[0].endMs = 20000
  const applied = { ...panel(segment.description, planning.renderProductionPrompt(segment.plan), segment.durationMs), productionPlan: segment.plan }
  assert.ok(planning.analyzePanelProduction(applied).issues.some(i => i.rule === 'production_plan_invalid'))
})

test('on-screen lettering remains visual content and is not scheduled as dialogue', () => {
  const description = '【镜头1】碑上浮出五个大字——「斗之力，三段」。测验员：（冷漠）「级别低级！」'
  const shots = planning.parseShotDescription(description)
  assert.deepEqual(shots[0].dialogue.map(d => d.text), ['级别低级！'])
  assert.match(shots[0].visual, /斗之力，三段/)
  const rebuilt = planning.buildProductionPlan(panel(description), { maxSeconds: 15 }).segments[0]
  assert.match(rebuilt.description, /斗之力，三段/)
})

test('reference headers required by prompt templates are metadata, not spoken lines', () => {
  const target = panel('【镜头1】小明递杯。小明：「你好。」', '出场人物：@小明、@小红；场景：@咖啡厅。\n0-15秒：小明递杯。小明：「你好。」')
  assert.deepEqual(planning.extractDialogue(target.videoPrompt).map(d => d.text), ['你好。'])
  assert.equal(planning.productionBlockingMessage(target), '')
})

test('preserves labelled visuals, inline narration and conservatively identifies natural dialogue', () => {
  for (const label of ['画面', '中景']) {
    const shot = planning.parseShotDescription(`【镜头1】${label}：小明站在门口。\n小明：「你终于来了。」`)[0]
    assert.match(shot.visual, /小明站在门口/)
    assert.deepEqual(shot.dialogue.map(d => d.speaker), ['小明'])
  }
  const inline = '【镜头1】小明站在门口。旁白：这是他多年以来第一次来到这个村庄，眼前的一切既熟悉又陌生。'
  assert.equal(planning.extractDialogue(inline).length, 1)
  assert.ok(planning.productionBlockingMessage(panel(inline, '0-5秒：小明站在门口。', 5000)))
  const narrated = planning.parseShotDescription('【镜头1】小明站在门口，低声说：“你终于来了。”')[0]
  assert.notEqual(narrated.dialogue[0].speaker, '低声')
  assert.match(narrated.visual, /小明站在门口/)
})

test('speaker checks follow spoken ranges across quote merges and splits and reject invented speech', () => {
  const description = '甲：「你好。」\n乙：「再见。」'
  assert.ok(planning.productionBlockingMessage(panel(description, '0-15秒：甲：「你好。再见。」')))
  assert.ok(planning.productionBlockingMessage(panel(description, '0-15秒：「你好。再见。」')))
  assert.equal(planning.productionBlockingMessage(panel('甲：「你好。再见。」', '0-7秒：甲：「你好。」\n7-15秒：甲：「再见。」')), '')
  assert.ok(planning.productionBlockingMessage(panel('小明站在门口。', '0-15秒：小明：「我要离开这里。」')))
})

test('English uses a word-based speaking budget instead of Chinese letter speed', () => {
  const text = 'I thought you would never come back, but I am glad you finally decided to return home.'
  assert.equal(planning.productionBlockingMessage(panel(`Alex：「${text}」`, `0-10秒：Alex：「${text}」`, 10000)), '')
})

test('colon inside a quoted announcement is not a second speaker and inferred mentions are not duplicated', () => {
  const description = '【镜头1】测验员扬声宣布。测验员：（发紧）「斗之气——九段！级别：高级！」'
  assert.equal(planning.extractDialogue(description).length, 1)
  const segment = planning.buildProductionPlan(panel(description), { maxSeconds: 15 }).segments[0]
  assert.equal(planning.extractDialogue(segment.description).length, 1)
  assert.equal(planning.productionBlockingMessage(panel(segment.description, planning.renderProductionPrompt(segment.plan), segment.durationMs)), '')
  const mention = planning.buildProductionPlan(panel('【镜头1】@小明 站在门口，低声说：“你终于来了。”'), { maxSeconds: 15 }).segments[0]
  assert.equal(planning.extractDialogue(mention.description).length, 1)
  assert.match(mention.description, /站在门口/)
})

test('speaking verbs are not part of actor identity and multiple mentions stay ambiguous', () => {
  for (const speaker of ['小明说', '@小明说道', '@小明问', '@小明回答']) {
    const prompt = `0-10秒：${speaker}：「你好。」`
    assert.equal(planning.extractDialogue(prompt)[0].speaker, '小明')
    assert.equal(planning.productionBlockingMessage(panel('小明：「你好。」', prompt, 10000)), '')
  }
  assert.notEqual(planning.extractDialogue('@小红看向@小明说：「你好。」')[0].speaker, '小明')
  assert.equal(planning.extractDialogue('@小明说：你好。')[0].speaker, '小明')
})

test('script restoration edits the matching actor span when two actors say the same words', () => {
  const short = '今天我们终于一起回到了这个阔别多年的故乡，也终于见到了从前熟悉的街道和家人。'
  const full = short.replace('这个', '这个美丽的')
  for (const quoted of [true, false]) {
    const wrap = (text: string) => quoted ? `「${text}」` : text
    const description = `甲：${wrap(short)}\n乙：${wrap(short)}`
    const script = `甲：${wrap(short)}\n乙：${wrap(full)}`
    const repaired = planning.restoreScriptDialogue(description, script)
    assert.deepEqual(planning.extractDialogue(repaired.description).map(d => [d.speaker, d.text]), [['甲', short], ['乙', full]])
    assert.deepEqual(repaired.restorations.map(r => r.speaker), ['乙'])
  }
})

test('a repaired segment never exceeds the nine available grid frames', () => {
  const description = Array.from({ length: 11 }, (_, i) => `【镜头${i + 1}】小明完成动作${i + 1}。`).join('\n')
  const segments = planning.buildProductionPlan(panel(description), { maxSeconds: 15 }).segments
  assert.ok(segments.length > 1)
  assert.ok(segments.every(s => s.plan.shots.length <= 9))
  assert.equal(segments.reduce((sum, s) => sum + s.plan.shots.length, 0), 11)
})
