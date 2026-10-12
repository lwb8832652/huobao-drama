import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { defaultStrategy, makeFrame, type Panel } from '../src/services/previs-domain.js'

process.env.SQLITE_PATH = ':memory:'
const planning = await import('../src/services/previs-frames.js')
const contextApi = await import('../src/agents/tools/frame-splitter-tools.js')
const { db, schema } = await import('../src/db/index.js')

function panel(): Panel {
  return {
    id: 7, title: '接过杯子', description: '小明向小红递出杯子。小红接住杯子。', atmosphere: '窗边暖光', imagePrompt: '',
    videoPrompt: '0-2秒小明右手递杯；2-5秒小红左手接杯；5-6秒二人放下手臂。',
    durationMs: 6000, sceneId: null, scene: '厨房', shotType: '中景', angle: '平视', movement: '固定',
    characterIds: [], propIds: [], referenceImages: [], videoUrl: '',
    frames: [0, 1200, 5700].map((offsetMs, index) => ({ ...makeFrame(`stable-${index}`, index), offsetMs, prompt: `原状态${index}` })),
  }
}

test('normalized plans retain existing frame identities and nonuniform valid timing while carrying continuity', () => {
  assert.equal(typeof planning.normalizeFramePlan, 'function', 'frame normalization API must exist')
  const result = planning.normalizeFramePlan(panel(), 3, {
    continuityConstraints: '小明在左，小红在右；白色杯子由右手交到左手；窗光来自左侧。',
    frames: [
      { title: '递出', prompt: '小明右手握住杯柄，杯子位于两人之间。', continuity: '开始：小明持杯，小红左手尚未接触。' },
      { title: '接住', prompt: '小红左手握住杯身，小明右手仍握杯柄。', continuity: '上一格小明持杯→小红左手接触杯身→双方同时持杯。' },
      { title: '收手', prompt: '小红左手单独持杯，小明右手已放到腰侧。', continuity: '上一格双方同时持杯→小明松开杯柄→小红左手单独持杯。' },
    ],
  })
  assert.ok(result)
  assert.deepEqual(result.frames.map(frame => frame.id), ['stable-0', 'stable-1', 'stable-2'])
  assert.deepEqual(result.frames.map(frame => frame.offsetMs), [0, 1200, 5700])
  assert.match(result.continuityConstraints, /白色杯子/)
  assert.match(result.frames[1].continuity || '', /上一格.*→.*→/)
})

test('draft mapping uses chronological frame identities even when the stored array is unordered', () => {
  const original = panel()
  original.frames = [original.frames[2], original.frames[0], original.frames[1]]
  const result = planning.normalizeFramePlan(original, 3, { frames: [0, 1, 2].map(index => ({ title: `状态${index}`, prompt: `静态${index}` })) })
  assert.deepEqual(result?.frames.map(frame => frame.id), ['stable-0', 'stable-1', 'stable-2'])
  assert.deepEqual(result?.frames.map(frame => frame.offsetMs), [0, 1200, 5700])
})

test('AI timing is retained when no existing plan exists, and invalid timing falls back to ordered defaults', () => {
  assert.equal(typeof planning.normalizeFramePlan, 'function')
  const input = { ...panel(), frames: [] }
  const frames = [0, 700, 5000].map((offsetMs, index) => ({ title: `画面${index}`, prompt: `静态${index}`, offsetMs }))
  const valid = planning.normalizeFramePlan(input, 3, { frames })
  assert.deepEqual(valid?.frames.map(frame => frame.offsetMs), [0, 700, 5000])
  const invalid = planning.normalizeFramePlan(input, 3, { frames: frames.map(frame => ({ ...frame, offsetMs: 7000 })) })
  assert.deepEqual(invalid?.frames.map(frame => frame.offsetMs), [0, 3000, 5999])
})

test('planning hash changes with video action, existing plan state, and referenced identity descriptions', () => {
  assert.equal(typeof planning.planInputHash, 'function')
  const original = panel()
  const context = { characters: [{ id: 1, appearance: '红色外套' }] }
  const hash = planning.planInputHash(original, context)
  assert.notEqual(planning.planInputHash({ ...original, frames: original.frames.map(frame => ({ ...frame, url: '/static/new-adopted.png' })) }, context), hash)
  assert.notEqual(planning.planInputHash({ ...original, videoPrompt: '不同动作顺序' }, context), hash)
  assert.notEqual(planning.planInputHash({ ...original, frames: original.frames.map(frame => ({ ...frame, prompt: '已编辑的状态' })) }, context), hash)
  assert.notEqual(planning.planInputHash(original, { characters: [{ id: 1, appearance: '蓝色外套' }] }), hash)
})

test('readonly planning context includes actual visual identities, scene, props, action prompt, and existing frames', async () => {
  assert.equal(typeof contextApi.readFramePlanningContext, 'function')
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({ title: '测试剧', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '测试集', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const characterId = Number(db.insert(schema.characters).values({ dramaId, name: '小明', description: '青年', appearance: '黑色短发', styling: '红色外套', finalPrompt: '固定身份', imageUrl: '/static/character.png', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const propId = Number(db.insert(schema.props).values({ dramaId, name: '杯子', description: '白色陶瓷杯', prompt: '右侧杯柄', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const sceneId = Number(db.insert(schema.scenes).values({ dramaId, location: '厨房', time: '早晨', prompt: '窗户在左侧，桌子在中央', lighting: '左侧暖光', imageUrl: '/static/scene.png', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const target = { ...panel(), imagePrompt: '小明红外套，右手持白杯，桌在中央', referenceImages: ['/static/common.png'], referenceLabels: ['空间布局'], characterIds: [characterId], propIds: [propId], sceneId }
  target.frames = [target.frames[2], target.frames[0], target.frames[1]]
  target.frames[0].referenceImages = []
  const versionId = Number(db.insert(schema.animaticVersions).values({ episodeId, versionNo: 1, timelineJson: JSON.stringify({ schemaVersion: 2, panels: [target], groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const context = await contextApi.readFramePlanningContext(versionId, [7], episodeId, dramaId)
  assert.ok(!('error' in context))
  const shot = context.panels[0] as any
  assert.equal(shot.videoPrompt, target.videoPrompt)
  assert.equal(shot.imagePrompt, target.imagePrompt)
  assert.equal(shot.characters[0].appearance, '黑色短发')
  assert.equal(shot.characters[0].styling, '红色外套')
  assert.equal(shot.props[0].description, '白色陶瓷杯')
  assert.equal(shot.scene.prompt, '窗户在左侧，桌子在中央')
  assert.equal(shot.scene.imageUrl, '/static/scene.png')
  assert.equal(shot.scene.ready, true)
  assert.equal(shot.characters[0].imageUrl, '/static/character.png')
  assert.equal(shot.characters[0].ready, true)
  assert.equal(shot.props[0].imageUrl, null)
  assert.equal(shot.props[0].ready, false)
  assert.deepEqual(shot.referenceManifest.items.map((item: any) => item.url), ['/static/scene.png', '/static/character.png', null, '/static/common.png'])
  assert.equal(shot.referenceManifest.ready, false)
  assert.deepEqual(shot.orderedFrames, shot.existingFrames)
  assert.deepEqual(shot.existingFrames.map((frame: any) => frame.id), ['stable-0', 'stable-1', 'stable-2'])
  assert.deepEqual(shot.existingFrames.map((frame: any) => frame.offsetMs), [0, 1200, 5700])
  assert.equal(typeof planning.buildFramePlanningRequestContent, 'function')
  const content = planning.buildFramePlanningRequestContent({ versionId, panelId: 7, count: 3, context })
  assert.match(content, /panelId=7/)
  assert.match(content, /3/)
  assert.match(content, /6000/)
  assert.match(content, /小明红外套/)
  assert.match(content, /空间布局/)
  assert.match(content, /character.png/)
  assert.match(content, /stable-2/)
  assert.match(content, /imagePrompt/)
  assert.match(content, /description/)
  assert.doesNotMatch(content, /先调用 read_previs_context/)
  const unavailable = { ...target, sceneId: 99999, characterIds: [99999], propIds: [99999] }
  const missingVersion = Number(db.insert(schema.animaticVersions).values({ episodeId, versionNo: 2, timelineJson: JSON.stringify({ schemaVersion: 2, panels: [unavailable], groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const missing = await contextApi.readFramePlanningContext(missingVersion, [7], episodeId, dramaId)
  assert.ok(!('error' in missing))
  const missingShot = missing.panels[0] as any
  assert.deepEqual(missingShot.characters.map((asset: any) => ({ id: asset.id, imageUrl: asset.imageUrl, ready: asset.ready })), [{ id: 99999, imageUrl: null, ready: false }])
  assert.deepEqual(missingShot.props.map((asset: any) => ({ id: asset.id, imageUrl: asset.imageUrl, ready: asset.ready })), [{ id: 99999, imageUrl: null, ready: false }])
  assert.equal(missingShot.scene.id, 99999)
  assert.equal(missingShot.scene.imageUrl, null)
  assert.equal(missingShot.scene.ready, false)
})

test('every frame splitter prompt layer declares the same static-state and continuity contract', async () => {
  for (const name of ['frame_splitter.md', 'frame_splitter.en.md', 'frame_splitter.ja.md', 'frame_splitter.ko.md']) {
    const text = await readFile(new URL(`../workspace/prompts/${name}`, import.meta.url), 'utf8')
    assert.match(text, /continuityConstraints/)
    assert.match(text, /offsetMs/)
    assert.match(text, /continuity/)
    assert.match(text, /imagePrompt/)
    assert.match(text, /referenceManifest/)
    assert.match(text, /description/)
    assert.doesNotMatch(text, /不要全部填同一个值|instead of repeating|同じ値を繰り返さない|같은 값을 반복하지 않는다/)
  }
  const skill = await readFile(new URL('../workspace/skills/frame-splitter/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /continuityConstraints/)
  assert.doesNotMatch(skill, /动作\/状态 \+ 景别/)
  const inline = await readFile(new URL('../src/agents/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(inline, /不要全部填同一个值/)
})
