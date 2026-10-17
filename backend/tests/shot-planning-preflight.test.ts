import assert from 'node:assert/strict'
import { test } from 'node:test'
process.env.SQLITE_PATH = ':memory:'
const { videoInputs } = await import('../src/services/previs-batch.js')
const domain = await import('../src/services/previs-domain.js')
const p = (description: string, videoPrompt: string) => ({ id: 1, title: '长对白', description, videoPrompt, durationMs: 15000, atmosphere: '', imagePrompt: '', sceneId: null, scene: '', shotType: '', angle: '', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '', frames: [{ ...domain.makeFrame('a'), prompt: '人物抬头', url: '/static/frame.png' }] })
const t = (panel: any) => ({ schemaVersion: 2 as const, panels: [panel], groups: [], transitions: [], audio: [], strategy: domain.defaultStrategy, acknowledgements: {} })
test('video preflight rejects complete but impossible dialogue before submission', () => {
  const text = '这段对白很长。'.repeat(14), panel = p(`【镜头1】甲：「${text}」`, `0-15秒：甲：「${text}」`)
  assert.throws(() => videoInputs(t(panel), [panel], 'nuwax'), /对白|优化|预算/)
})
test('video preflight rejects omitted words and outstanding frame review', () => {
  const panel = p('【镜头1】甲：「你好，很高兴见到你。」', '0-15秒：甲：「你好。」')
  assert.throws(() => videoInputs(t(panel), [panel], 'nuwax'), /对白|完整/)
  const reviewed = { ...panel, description: '【镜头1】甲抬头。', videoPrompt: '0-15秒：甲抬头。', framePlanNeedsReview: true }
  assert.throws(() => videoInputs(t(reviewed), [reviewed], 'nuwax'), /画面|审阅|规划/)
})
test('timeline diagnostics expose actionable production issues alongside continuity', () => {
  const panel = p('【镜头1】甲：「你好，很高兴见到你。」', '0-3秒：甲：「你好。」')
  assert.ok(domain.checkContinuity(t(panel)).some(i => i.rule === 'dialogue_missing'))
})

test('retimed frames must be reviewed before any image or grid generation is queued', async () => {
  const { db, schema } = await import('../src/db/index.js')
  const { createBatch } = await import('../src/services/previs-batch.js')
  const { startGridCandidates } = await import('../src/services/previs-grid.js')
  const stamp = new Date().toISOString()
  const dramaId = Number((await db.insert(schema.dramas).values({ title: '审阅测试', createdAt: stamp, updatedAt: stamp }).run()).lastInsertRowid)
  const episodeId = Number((await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '测试集', createdAt: stamp, updatedAt: stamp }).run()).lastInsertRowid)
  const target = { ...p('人物站定。', '0-15秒：人物站定。'), framePlanNeedsReview: true }
  const versionId = Number((await db.insert(schema.animaticVersions).values({ episodeId, versionNo: 1, timelineJson: JSON.stringify(t(target)), createdAt: stamp, updatedAt: stamp }).run()).lastInsertRowid)
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'image', panelIds: [target.id] }), /审阅|重新规划/)
  await assert.rejects(startGridCandidates(versionId, { revision: 1, panelIds: [target.id], mode: 'generate' }), /审阅|重新规划/)
  assert.equal((await db.select().from(schema.sysTask).all()).length, 0)
})
