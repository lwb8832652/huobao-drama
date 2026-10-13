import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { makeFrame, defaultStrategy, type Panel, type Timeline } from '../src/services/previs-domain.js'
const root = mkdtempSync(path.join(tmpdir(), 'sheet-batch-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
const { db, schema } = await import('../src/db/index.js')
const { createBatch, tickPrevisBatches, updateBatch } = await import('../src/services/previs-batch.js')
const { scheduleContactSheets, tickContactSheets } = await import('../src/services/previs-contact-sheets.js')
const { videoFingerprint, validateTimeline, getVersion } = await import('../src/services/previs.js')
const ts = new Date().toISOString()
const dramaId = Number(db.insert(schema.dramas).values({ title: '测试剧', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const configId = Number(db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'aliyun', name: 'test', baseUrl: 'https://mock.invalid', apiKey: 'test-only', model: '["wan3.0-video"]', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({ dramaId, videoConfigId: configId, episodeNumber: 1, title: '测试集', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
mkdirSync(path.join(root, 'static'))
const source = await sharp({ create: { width: 300, height: 170, channels: 3, background: 'red' } }).png().toBuffer()
writeFileSync(path.join(root, 'static', 'source.png'), source)
const panel = (id: number, count = 3) => ({ id, title: `分镜 ${id}`, durationMs: 4000, description: '走进房间', atmosphere: '', imagePrompt: '', videoPrompt: '', sceneId: null, scene: '', shotType: '', angle: '', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '', frames: Array.from({ length: count }, (_, i) => ({ ...makeFrame(`${id}-${i}`, i * 1000), url: '/static/source.png' })) }) as Panel
function insert(panels: Panel[]) {
  const timeline: Timeline = { schemaVersion: 2, panels, groups: panels.map(p => ({ id: `panel-${p.id}`, title: p.title, note: '', panelIds: [p.id], entry: {}, exit: {} })), transitions: [], audio: [], strategy: { ...defaultStrategy }, acknowledgements: {} }
  const versionId = Number(db.insert(schema.animaticVersions).values({ episodeId, versionNo: db.select().from(schema.animaticVersions).all().length + 1, timelineJson: JSON.stringify(timeline), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  return { versionId, timeline }
}
const requests: any[] = []
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith('https://mock.invalid/'), 'Tests must never call a paid provider')
  requests.push(JSON.parse(String(options?.body)))
  return new Response('test provider stopped after capturing input', { status: 400 })
}
async function submitted(count: number) {
  for (let i = 0; i < 100 && requests.length < count; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, count)
  await new Promise(resolve => setTimeout(resolve, 20))
  await tickPrevisBatches()
}
test('real queued generation sends N original images or one full-size clean sheet with persisted snapshots', async () => {
  const { versionId, timeline } = insert([panel(1)])
  await createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'individual' })
  await submitted(1)
  assert.equal(requests[0].input.media.length, 3)
  assert.match(requests[0].input.prompt, /对应 2.0 秒/)
  const item = db.select().from(schema.batchRunItems).all()[0], request = JSON.parse(item.requestJson)
  const task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.taskId!)).get()!
  assert.deepEqual(JSON.parse(task.params!).referenceInput, request.referenceInput)
  assert.equal(request.referenceInput.imageUrls.length, 3)
  const oldHash = videoFingerprint(timeline, timeline.panels)
  assert.notEqual(oldHash, request.inputHash)
  assert.equal(videoFingerprint(timeline, timeline.panels, 'storyboard_frames', request.referenceInput), request.inputHash)
  scheduleContactSheets(versionId); await tickContactSheets()
  await createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'contact_sheet' })
  await submitted(2)
  assert.equal(requests[1].input.media.length, 1)
  assert.match(requests[1].input.prompt, /第 3 格对应 2 秒/)
  const metadata = await sharp(Buffer.from(requests[1].input.media[0].url.split(',')[1], 'base64')).metadata()
  assert.equal(metadata.width, 3072)
  assert.equal(metadata.height, 1728)
})
test('invalid later panel creates no partial jobs or provider requests', async () => {
  const missing = panel(3); missing.frames[0].url = ''
  const { versionId } = insert([panel(2), missing])
  const beforeJobs = db.select().from(schema.batchRunItems).all().length
  const beforeBatches = db.select().from(schema.batchRuns).all().length
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'individual' }), /未完成/)
  assert.equal(db.select().from(schema.batchRunItems).all().length, beforeJobs)
  assert.equal(db.select().from(schema.batchRuns).all().length, beforeBatches)
  assert.equal(requests.length, 2)
})
test('stale or failed sheet prevents submission but individual input stays usable', async () => {
  const { versionId } = insert([panel(4)])
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'contact_sheet' }), /宫格/)
  assert.equal(requests.length, 2)
  await createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'individual' })
  await submitted(3)
  assert.equal(requests[2].input.media.length, 3)
})
test('a corrupt later source cannot submit an earlier paid unit', async () => {
  writeFileSync(path.join(root, 'static', 'corrupt.png'), source.subarray(0, Math.floor(source.length / 2)))
  // PNG dimensions can still be read even though the pixels are incomplete.
  assert.equal((await sharp(path.join(root, 'static', 'corrupt.png')).metadata()).width, 300)
  const bad = panel(6); bad.frames[0].url = '/static/corrupt.png'
  const { versionId } = insert([panel(5), bad])
  const before = db.select().from(schema.batchRunItems).all().length
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'individual' }), /stream|pngload|corrupt|Warning treated as error due to failOn setting/)
  assert.equal(db.select().from(schema.batchRunItems).all().length, before)
  assert.equal(requests.length, 3)
})
test('contact-sheet input rechecks source bytes and missing originals instead of reusing old cache', async () => {
  const { versionId } = insert([panel(7)])
  scheduleContactSheets(versionId); await tickContactSheets()
  unlinkSync(path.join(root, 'static', 'source.png'))
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'contact_sheet' }), /7-0.*读取失败/)
  writeFileSync(path.join(root, 'static', 'source.png'), await sharp(source).negate().png().toBuffer())
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'contact_sheet' }), /已过期/)
  assert.equal(requests.length, 3)
})
test('new snapshot jobs reject overlong prompts without truncating or creating tasks', async () => {
  const long = panel(8); long.videoPrompt = '长'.repeat(20_000)
  const { versionId } = insert([long])
  const count = db.select().from(schema.batchRunItems).all().length
  await assert.rejects(createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'individual' }), /提示词超过/)
  assert.equal(db.select().from(schema.batchRunItems).all().length, count)
  assert.equal(requests.length, 3)
})
test('retry preserves the original strategy, frozen bytes and prompt after a source replacement', async () => {
  const first = db.select().from(schema.batchRunItems).all()[0]
  const saved = first.requestJson
  updateBatch(first.batchId, 'retry', [first.id])
  await tickPrevisBatches()
  await submitted(4)
  assert.equal(db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, first.id)).get()?.requestJson, saved)
  assert.deepEqual(requests[3], requests[0])
})
test('validation and locking schema keep inherited video provenance', () => {
  const timeline = insert([panel(9)]).timeline
  const input = JSON.parse(db.select().from(schema.batchRunItems).all()[0].requestJson).referenceInput
  timeline.inheritedOutputs = [{ key: 'copy', panelIds: [9], url: '/static/old.mp4', stale: false, generationMode: 'storyboard_frames', referenceInput: input }]
  assert.deepEqual(validateTimeline(timeline).inheritedOutputs?.[0].referenceInput, input)
})
test('explicit group scope is reachable, submits one task and one clean sheet per panel in timeline order', async () => {
  const { versionId } = insert([panel(10), panel(11)])
  scheduleContactSheets(versionId); await tickContactSheets()
  const before = db.select().from(schema.batchRunItems).all().length
  await createBatch(versionId, { revision: 1, type: 'video', configId, panelIds: [11, 10], generationMode: 'storyboard_frames', videoReferenceInputStrategy: 'auto', generationScope: 'group' })
  await submitted(5)
  assert.equal(db.select().from(schema.batchRunItems).all().length, before + 1)
  const request = JSON.parse(db.select().from(schema.batchRunItems).all().at(-1)!.requestJson)
  assert.deepEqual(request.panelIds, [10, 11])
  assert.equal(request.referenceInput.generationScope, 'group')
  assert.equal(request.referenceInput.effective, 'contact_sheet')
  assert.equal(requests[4].input.media.length, 2)
  assert.equal(requests[4].parameters.duration, 8)
})
test('a single selected panel in group scope still uses a sheet', async () => {
  const { versionId } = insert([panel(12)])
  scheduleContactSheets(versionId); await tickContactSheets()
  await createBatch(versionId, { revision: 1, type: 'video', configId, generationMode: 'storyboard_frames', generationScope: 'group' })
  await submitted(6)
  const request = JSON.parse(db.select().from(schema.batchRunItems).all().at(-1)!.requestJson)
  assert.equal(request.referenceInput.effective, 'contact_sheet')
  assert.equal(requests[5].input.media.length, 1)
})
test('reordering grouped panels marks a completed group video stale', () => {
  const item = db.select().from(schema.batchRunItems).all().find(item => JSON.parse(item.requestJson).panelIds?.join(',') === '10,11')!
  const batch = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, item.batchId)).get()!
  db.update(schema.batchRunItems).set({ status: 'completed' }).where(eq(schema.batchRunItems.id, item.id)).run()
  db.update(schema.sysTask).set({ status: 'completed', localPath: '/static/fake.mp4' }).where(eq(schema.sysTask.id, item.taskId!)).run()
  assert.equal(getVersion(batch.versionId).outputs[0].stale, false)
  const timeline = getVersion(batch.versionId).timeline
  timeline.groups.reverse()
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline), revision: 2 }).where(eq(schema.animaticVersions.id, batch.versionId)).run()
  assert.equal(getVersion(batch.versionId).outputs[0].stale, true)
})
