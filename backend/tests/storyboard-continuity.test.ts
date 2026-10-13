import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultStrategy, makeFrame, type Panel, type Timeline } from '../src/services/previs-domain.js'
const continuity = await import('../src/services/previs-continuity.js').catch(() => null)
const video = await import('../src/services/previs-video-continuity.js').catch(() => null)
function panel(id: number): Panel {
  return { id, title: `Shot ${id}`, description: 'Continued action', atmosphere: '', imagePrompt: '', videoPrompt: '', durationMs: 4000, sceneId: 1, scene: 'Kitchen', shotType: 'medium', angle: 'eye', movement: '', characterIds: [1], propIds: [], referenceImages: [], videoUrl: '', frames: [{ ...makeFrame(`${id}-last`, 3999), url: `/static/${id}-last.png` }, { ...makeFrame(`${id}-first`), url: `/static/${id}-first.png` }] }
}
function timeline(): Timeline {
  return { schemaVersion: 2, panels: [panel(90), panel(3), panel(40)], groups: [90, 3, 40].map(id => ({ id: `p-${id}`, title: '', note: '', panelIds: [id], entry: { time: 'day' }, exit: { time: 'day' } })), transitions: [{ from: 'p-90', to: 'p-3', type: 'cut', continuity: 'normal', allowedChanges: ['camera'] }], strategy: defaultStrategy, acknowledgements: {}, audio: [] }
}
function resolve(t: Timeline, id: number) { assert.ok(continuity, 'readonly continuity resolver must exist'); return continuity.resolvePanelContinuity(t, id, 12) }
test('first panel resets and normal continuity follows timeline order and LAST ordered adopted frame', () => {
  const t = timeline()
  assert.equal(resolve(t, 90).status, 'reset')
  const result = resolve(t, 3)
  assert.equal(result.status, 'available')
  assert.equal(result.previous?.panelId, 90)
  assert.equal(result.previous?.frameId, '90-last')
  assert.equal(result.previous?.versionId, 12)
  assert.equal(result.exactVideoBoundary, false)
  assert.deepEqual(result.transition?.allowedChanges, ['camera'])
})
test('strong same scene permits exact boundary while normal camera change does not', () => {
  const t = timeline(); t.transitions[0].continuity = 'strong'; t.transitions[0].allowedChanges = []
  assert.equal(resolve(t, 3).exactVideoBoundary, true)
  t.transitions[0].allowedChanges = ['camera']
  assert.equal(resolve(t, 3).exactVideoBoundary, false)
})
test('scene change, establishing and explicit time gap reset boundary', () => {
  const t = timeline()
  t.transitions[0].continuity = 'scene_change'; assert.equal(resolve(t, 3).status, 'reset')
  t.transitions[0].continuity = 'strong'; t.transitions[0].type = 'establishing'; assert.equal(resolve(t, 3).status, 'reset')
  t.transitions[0].type = 'cut'; t.groups[1].entry.time = 'night'; assert.equal(resolve(t, 3).status, 'reset')
  t.groups[1].entry.time = 'day'; t.panels[1].sceneId = 2; assert.equal(resolve(t, 3).status, 'reset')
})
test('missing LAST frame is optional and never falls back to earlier available frame', () => {
  const t = timeline(); t.panels[0].frames[0].url = ''
  const result = resolve(t, 3)
  assert.equal(result.status, 'missing')
  assert.equal(result.previous?.frameId, '90-last')
  assert.equal(result.previous?.sourceUrl, '')
  assert.match(result.reason, /末.*未/)
})
test('upstream state change and reorder mark saved boundary stale', () => {
  assert.ok(continuity)
  const t = timeline(), saved = resolve(t, 3)
  assert.equal(continuity.continuityMatchesTimeline(saved, t, 3), true)
  t.panels[0].frames[0].prompt = 'Changed ending'; assert.equal(continuity.continuityMatchesTimeline(saved, t, 3), false)
  const reordered = timeline(); [reordered.groups[0], reordered.groups[2]] = [reordered.groups[2], reordered.groups[0]]
  assert.equal(continuity.continuityMatchesTimeline(saved, reordered, 3), false)
})
test('model capabilities whitelist only supported first/last adapters and models', () => {
  assert.ok(video, 'model-aware video continuity capabilities must exist')
  for (const model of ['wan3.0-video', 'wan3.0-video-prime']) assert.equal(video.modelVideoContinuityCapabilities('aliyun', model).firstLast, true)
  assert.equal(video.modelVideoContinuityCapabilities('aliyun', 'wan2.2-video').firstLast, false)
  assert.equal(video.modelVideoContinuityCapabilities('minimax', 'MiniMax-H3').firstLast, true)
  assert.equal(video.modelVideoContinuityCapabilities('minimax', 'MiniMax-H3.0-fast').firstLast, true)
  assert.equal(video.modelVideoContinuityCapabilities('minimax', 'MiniMax-Hailuo-02').firstLast, false)
  for (const provider of ['volcengine', 'nuwax']) assert.equal(video.modelVideoContinuityCapabilities(provider, 'any').firstLast, false)
})
test('mixed scene bindings and pixel-changing allowances cannot silently share exact boundary', () => {
  const t = timeline(); t.panels[1].sceneId = null; t.panels[1].scene = 'Street'
  assert.equal(resolve(t, 3).status, 'reset')
  t.panels[1].sceneId = 1; t.transitions[0].continuity = 'strong'
  for (const change of ['lighting', 'character', 'styling', 'props', 'scene']) {
    t.transitions[0].allowedChanges = [change]
    assert.equal(resolve(t, 3).exactVideoBoundary, false, change)
  }
  t.transitions[0].allowedChanges = []; t.panels[1].characterIds = [2]
  assert.equal(resolve(t, 3).exactVideoBoundary, false)
})
test('strong transition without affirmative same-scene evidence cannot share pixels', () => {
  const t = timeline(); t.transitions[0].continuity = 'strong'; t.transitions[0].allowedChanges = []
  for (const p of t.panels) { p.sceneId = null; p.scene = '' }
  assert.equal(resolve(t, 3).exactVideoBoundary, false)
})
test('known provider with an unsupported model does not claim reference capability', () => {
  assert.ok(video)
  assert.equal(video.modelVideoContinuityCapabilities('aliyun', 'wan2.2-video').reference, false)
  assert.equal(video.modelVideoContinuityCapabilities('minimax', 'MiniMax-Hailuo-02').reference, false)
  assert.equal(video.modelVideoContinuityCapabilities('volcengine', 'arbitrary').reference, false)
})
test('unknown scene resets optional reference and explicit scene time qualifiers reset even with same canonical ID', () => {
  const t = timeline(); t.panels[0].sceneId = null; t.panels[1].sceneId = null; t.panels[0].scene = ''; t.panels[1].scene = ''
  assert.equal(resolve(t, 3).status, 'reset')
  t.panels[0].sceneId = 1; t.panels[1].sceneId = 1; t.panels[0].scene = '厨房（早晨）'; t.panels[1].scene = '厨房（夜晚）'
  assert.equal(resolve(t, 3).status, 'reset')
})
