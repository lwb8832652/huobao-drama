import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeFrame, type Panel } from '../src/services/previs-domain.js'
import { buildProductionPlan, renderProductionPrompt } from '../src/services/shot-planning.js'

process.env.SQLITE_PATH = ':memory:'
const { suggestedFrameCount, ruleFrames, normalizeFramePlan, planInputHash } = await import('../src/services/previs-frames.js')
function panel(): Panel {
  return { id: 1, title: '门口', description: '【镜头1】小明站在门口。\n小明：「你终于来了！真的等了很久。」\n【镜头2】小红双手扶着门框。',
    videoPrompt: '', imagePrompt: '', atmosphere: '暖光', durationMs: 12000, sceneId: null, scene: '走廊', shotType: '中景', angle: '平视', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '', frames: [] }
}
function timedPanel(): Panel {
  const p = panel(), segment = buildProductionPlan(p, { maxSeconds: 15 }).segments[0]
  return { ...p, description: segment.description, durationMs: segment.durationMs, videoPrompt: renderProductionPrompt(segment.plan), productionPlan: segment.plan }
}
test('recommended counts cover visual subshots and do not grow with duration', () => {
  assert.equal(suggestedFrameCount(panel()), 2)
  assert.equal(suggestedFrameCount({ ...panel(), durationMs: 3000 }), 2)
  assert.equal(suggestedFrameCount({ ...panel(), description: '小明站在门口。', durationMs: 30000 }), 1)
})
test('rule drafts cover every visual subshot and never sample dialogue punctuation', () => {
  const frames = ruleFrames(panel(), 2)
  assert.equal(frames.length, 2)
  assert.match(frames[0].prompt, /小明站在门口/)
  assert.match(frames[1].prompt, /小红双手扶着门框/)
  assert.doesNotMatch(frames.map(f => f.prompt).join(''), /终于来了|真的等了|[「」“”]/)
  assert.deepEqual(frames.map(f => f.shotId), ['s1', 's2'])
  assert.throws(() => ruleFrames(panel(), 1), /覆盖|子镜头/)
})
test('quote-only or punctuation-only descriptions cannot become visual frames', () => {
  for (const description of ['「你来了！」', '【镜头1】。；！？']) {
    assert.throws(() => ruleFrames({ ...panel(), description, imagePrompt: '' }, 1), /可视|画面描述/)
  }
  assert.equal(normalizeFramePlan({ ...panel(), description: '小明站在门口。' }, 1, { frames: [{ title: '对白', prompt: '「你终于来了！」' }] }), null)
})
test('valid explicit AI timing overrides previous timing while preserving frame identities', () => {
  const p = { ...panel(), description: '小明站在门口。', frames: [0, 3000, 11999].map((offset, i) => ({ ...makeFrame(`stable-${i}`, offset), url: '/static/old.png' })) }
  const result = normalizeFramePlan(p, 3, { frames: [0, 1700, 10000].map((offsetMs, i) => ({ title: `状态${i}`, prompt: '小明双手扶门框。', offsetMs })) })
  assert.deepEqual(result?.frames.map(f => f.offsetMs), [0, 1700, 10000])
  assert.deepEqual(result?.frames.map(f => f.id), ['stable-0', 'stable-1', 'stable-2'])
})
test('unified plan controls shot IDs and timing and refuses mismatched or missing coverage', () => {
  const p = timedPanel(), shots = p.productionPlan!.shots
  const frames = ruleFrames(p, 2)
  assert.deepEqual(frames.map(f => f.shotId), shots.map(s => s.id))
  assert.deepEqual(frames.map(f => f.offsetMs), shots.map(s => s.startMs))
  const input = { frames: shots.map(s => ({ title: s.id, prompt: s.visual, shotId: s.id, offsetMs: s.startMs })) }
  assert.ok(normalizeFramePlan(p, 2, input))
  assert.equal(normalizeFramePlan(p, 2, { frames: input.frames.map(f => ({ ...f, shotId: 's1', offsetMs: f.offsetMs })) }), null)
  assert.equal(normalizeFramePlan(p, 2, { frames: input.frames.map((f, i) => ({ ...f, offsetMs: i })) }), null)
  assert.notEqual(planInputHash(p), planInputHash({ ...p, productionPlan: { ...p.productionPlan!, charsPerSecond: 3.8 } }))
})

test('grid prompt carries the unified plan and frame mappings as the sole time source', async () => {
  const { promptFor } = await import('../src/services/previs-grid.js')
  const p = timedPanel()
  p.frames = ruleFrames(p, 2).map(frame => ({ ...makeFrame(frame.id!, frame.offsetMs), ...frame }))
  const prompt = promptFor(p, { columns: 2, rows: 1 } as any, 'generate', [], {}, [])
  assert.match(prompt, /统一镜头与对白时间计划（唯一时序依据）/)
  assert.match(prompt, /"shots"/)
  assert.match(prompt, /子镜头 s1/)
  assert.match(prompt, /子镜头 s2/)
  assert.doesNotMatch(prompt, /原视频动作与时间：/)
})

test('readonly AI context includes unified timing and existing frame shot mappings', async () => {
  const { db, schema } = await import('../src/db/index.js')
  const { readFramePlanningContext } = await import('../src/agents/tools/frame-splitter-tools.js')
  const { buildFramePlanningRequestContent } = await import('../src/services/previs-frames.js')
  const { defaultStrategy } = await import('../src/services/previs-domain.js')
  const ts = new Date().toISOString()
  const dramaId = Number((await db.insert(schema.dramas).values({ title: 'Unified context', createdAt: ts, updatedAt: ts }).run()).lastInsertRowid)
  const episodeId = Number((await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Unified context', createdAt: ts, updatedAt: ts }).run()).lastInsertRowid)
  const p = timedPanel()
  p.frames = ruleFrames(p, 2).map(frame => ({ ...makeFrame(frame.id!, frame.offsetMs), ...frame }))
  const versionId = Number((await db.insert(schema.animaticVersions).values({ episodeId, versionNo: 1, timelineJson: JSON.stringify({ schemaVersion: 2, panels: [p], groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run()).lastInsertRowid)
  const context = await readFramePlanningContext(versionId, [p.id], episodeId, dramaId)
  assert.ok(!('error' in context))
  const target = context.panels[0] as any
  assert.deepEqual(target.productionPlan, JSON.parse(JSON.stringify(p.productionPlan)))
  assert.deepEqual(target.existingFrames.map((frame: any) => frame.shotId), ['s1', 's2'])
  assert.equal(target.visualShots.length, 2)
  const content = buildFramePlanningRequestContent({ versionId, panelId: p.id, count: 2, context })
  assert.match(content, /唯一时序依据/)
  assert.match(content, /"productionPlan"/)
  assert.match(content, /"shotId":"s2"/)
})

test('legacy frame normalization rejects missing subshot coverage and repeated declared mappings', () => {
  const p = panel()
  const frames = [{ title: '门前', prompt: '小明站在门口。', shotId: 's1', offsetMs: 0 },
    { title: '扶门', prompt: '小红双手扶着门框。', shotId: 's2', offsetMs: 6000 }]
  assert.ok(normalizeFramePlan(p, 2, { frames }))
  assert.equal(normalizeFramePlan(p, 1, { frames: frames.slice(0, 1) }), null)
  assert.equal(normalizeFramePlan(p, 2, { frames: frames.map(f => ({ ...f, shotId: 's1' })) }), null)
  assert.equal(normalizeFramePlan(p, 2, { frames: frames.map((f, i) => ({ ...f, shotId: `s${2 - i}` })) }), null)
})
