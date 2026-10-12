import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultStrategy, makeFrame, type Panel, type Timeline } from '../src/services/previs-domain.js'

// Exercise the real validators/routes against an isolated database.
process.env.SQLITE_PATH = ':memory:'
const { validateTimeline } = await import('../src/services/previs.js')
const { FRAME_COUNT_MIN, FRAME_COUNT_MAX, clampCount, ruleFrames } = await import('../src/services/previs-frames.js')
const { createBatch } = await import('../src/services/previs-batch.js')
const { db, schema } = await import('../src/db/index.js')
const { default: routes } = await import('../src/routes/previs.js')

function panel(count = 0): Panel {
  return {
    id: 7, title: '开门', description: '走到门前。推开门。', atmosphere: '安静', imagePrompt: '', videoPrompt: '',
    durationMs: 6000, sceneId: null, scene: '', shotType: '中景', angle: '平视', movement: '',
    characterIds: [], propIds: [], referenceImages: [], videoUrl: '',
    frames: Array.from({ length: count }, (_, i) => ({ ...makeFrame(`frame-${i}`, i), url: '/static/same.png' })),
  }
}
function timeline(count = 0): Timeline {
  return {
    schemaVersion: 2, panels: [panel(count)],
    groups: [{ id: 'panel-7', title: '开门', note: '', panelIds: [7], entry: {}, exit: {} }],
    transitions: [], audio: [], strategy: { ...defaultStrategy }, acknowledgements: {},
  }
}

test('frame plans support one through nine frames and preserve endpoint timing and camera metadata', () => {
  assert.equal(FRAME_COUNT_MIN, 1)
  assert.equal(FRAME_COUNT_MAX, 9)
  assert.equal(clampCount(1, 3), 1)
  assert.equal(clampCount(9, 3), 9)
  assert.equal(clampCount(99, 3), 9)
  const single = ruleFrames(panel(), 1)
  assert.equal(single.length, 1)
  assert.equal(single[0].offsetMs, 0)
  assert.equal(single[0].type, 'beat')
  assert.equal(single[0].title, '关键画面')
  assert.match(single[0].prompt, /推开门/)
  assert.equal(single[0].shotType, '中景')
  assert.equal(single[0].angle, '平视')
  const nine = ruleFrames(panel(), 9)
  assert.equal(nine.length, 9)
  assert.equal(nine[0].offsetMs, 0)
  assert.equal(nine.at(-1)?.offsetMs, 5999)
})

test('empty, single and nine-frame timelines can be saved, while a new tenth frame is rejected', () => {
  for (const count of [0, 1, 9]) assert.equal(validateTimeline(timeline(count), timeline()).panels[0].frames.length, count)
  assert.throws(() => validateTimeline(timeline(10), timeline(9)), /9/)
})

test('legacy timelines above nine remain readable and can retain or remove existing frame IDs', () => {
  const original = timeline(12)
  assert.equal(validateTimeline(original).panels[0].frames.length, 12)
  const unchanged = structuredClone(original)
  unchanged.panels[0].frames[0].prompt = '保留旧画面并编辑描述'
  assert.equal(validateTimeline(unchanged, original).panels[0].frames.length, 12)
  const reduced = structuredClone(original)
  reduced.panels[0].frames.splice(0, 2)
  assert.equal(validateTimeline(reduced, original).panels[0].frames.length, 10)
  assert.equal(validateTimeline(timeline(9), original).panels[0].frames.length, 9)
})

test('legacy timelines above nine cannot grow or replace frames with new IDs', () => {
  const original = timeline(12)
  assert.throws(() => validateTimeline(timeline(13), original), /9/)
  const replaced = structuredClone(original)
  replaced.panels[0].frames[0].id = 'new-frame'
  assert.throws(() => validateTimeline(replaced, original), /9/)
})

test('the split endpoint accepts one and nine and rejects zero and ten before version lookup', async () => {
  for (const count of [1, 9]) {
    const response = await routes.request('/animatic-versions/9999/frames/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1, panelIds: [7], count }),
    })
    assert.equal(response.status, 404)
  }
  for (const count of [0, 10]) {
    const response = await routes.request('/animatic-versions/9999/frames/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1, panelIds: [7], count }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).message, /请求数据无效/)
  }
})

test('a new storyboard video above nine fails before creating jobs and leaves old jobs intact', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({ title: '测试剧', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '测试集', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const versionId = Number(db.insert(schema.animaticVersions).values({ episodeId, versionNo: 1, timelineJson: JSON.stringify(timeline(10)), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const batchId = Number(db.insert(schema.batchRuns).values({ versionId, type: 'video', status: 'completed', requestHash: 'old', configId: 1, model: 'old', createdAt: ts }).run().lastInsertRowid)
  db.insert(schema.batchRunItems).values({ batchId, groupId: 'panel-7', panelId: 7, requestJson: '{"legacy":true}', status: 'completed' }).run()
  const oldBatches = db.select().from(schema.batchRuns).all()
  const oldJobs = db.select().from(schema.batchRunItems).all()
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', generationMode: 'storyboard_frames' }), /9/)
  assert.deepEqual(db.select().from(schema.batchRuns).all(), oldBatches)
  assert.deepEqual(db.select().from(schema.batchRunItems).all(), oldJobs)
  // The frame limit only applies when the storyboard frames supply the video input.
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', generationMode: 'direct' }), /请先在设置中启用视频模型/)
})
