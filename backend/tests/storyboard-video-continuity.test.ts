import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { makeFrame, defaultStrategy, type Panel, type Timeline } from '../src/services/previs-domain.js'
const root = mkdtempSync(path.join(tmpdir(), 'video-continuity-'))
process.env.HUOBAO_DATA_DIR = root; process.env.SQLITE_PATH = path.join(root, 'db.sqlite3')
mkdirSync(path.join(root, 'static'))
const images = await Promise.all(['red', 'green', 'blue', 'yellow'].map(background => sharp({ create: { width: 320, height: 180, channels: 3, background } }).png().toBuffer()))
images.forEach((bytes, i) => writeFileSync(path.join(root, 'static', `${i}.png`), bytes))
const { db, schema } = await import('../src/db/index.js')
const { createBatch, tickPrevisBatches } = await import('../src/services/previs-batch.js')
const { getVersion, validateTimeline } = await import('../src/services/previs.js')
const endpoints = await import('../src/services/previs-video-continuity.js')
const routes = (await import('../src/routes/previs.js')).default
const ts = new Date().toISOString()
const dramaId = Number(db.insert(schema.dramas).values({ title: 'Test', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const config = (provider: string, model: string) => Number(db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider, name: 'local', baseUrl: 'https://mock.invalid', apiKey: 'test-only', model: JSON.stringify([model]), isActive: true, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const configId = config('aliyun', 'wan3.0-video'), referenceConfigId = config('volcengine', 'doubao-seedance-2-0-260128'), minimaxConfigId = config('minimax', 'MiniMax-H3')
const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Test', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
function panel(id: number, first = 0, last = 1): Panel {
  return { id, title: `Shot ${id}`, description: 'Walks ahead', atmosphere: '', imagePrompt: '', videoPrompt: `Shot ${id} raises a cup`, durationMs: 4000, sceneId: null, scene: 'Kitchen', shotType: 'medium', angle: 'eye', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '', frames: [{ ...makeFrame(`${id}-first`), url: `/static/${first}.png`, prompt: 'cup down' }, { ...makeFrame(`${id}-last`, 3999), url: `/static/${last}.png`, prompt: 'cup up' }] }
}
let versionNo = 0
function version(panels: Panel[], strong = false) {
  const timeline: Timeline = { schemaVersion: 2, panels, groups: panels.map(p => ({ id: `p-${p.id}`, title: '', note: '', panelIds: [p.id], entry: {}, exit: {} })), transitions: panels.slice(1).map((p, i) => ({ from: `p-${panels[i].id}`, to: `p-${p.id}`, type: 'cut', continuity: strong ? 'strong' : 'normal', allowedChanges: [] })), audio: [], strategy: { ...defaultStrategy }, acknowledgements: {} }
  return Number(db.insert(schema.animaticVersions).values({ episodeId, versionNo: ++versionNo, timelineJson: JSON.stringify(timeline), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
}
const submissions: any[] = []
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /^https:\/\/mock.invalid\//)
  submissions.push(JSON.parse(String(init?.body)))
  return new Response('mock provider refuses after capture', { status: 400 })
}
const opts = { revision: 1, type: 'video' as const, configId, generationMode: 'storyboard_frames' as const, videoContinuityMode: 'auto' as const }
async function finish(count: number) {
  for (let i = 0; i < 100 && submissions.length < count; i++) await new Promise(r => setTimeout(r, 20))
  assert.equal(submissions.length, count)
  await new Promise(r => setTimeout(r, 20)); await tickPrevisBatches()
}
function request(versionId: number) {
  const batch = db.select().from(schema.batchRuns).all().find(b => b.versionId === versionId)!
  return db.select().from(schema.batchRunItems).all().filter(i => i.batchId === batch.id).map(i => ({ item: i, data: JSON.parse(i.requestJson) }))
}
function wanSubmissionFor(data: any, captured: any[]) {
  const prompt = data.prompt.trim().replace(/@图片(\d+)/g, '图$1').slice(0, 20_000)
  const matches = captured.filter(body => body.input?.prompt === prompt)
  assert.equal(matches.length, 1, `unique actual provider request for panel ${data.storyboardId}`)
  return matches[0]
}
function wanFrameBytes(submission: any, role: 'first_frame' | 'last_frame') {
  const image = submission.input.media.find((item: any) => item.type === role)
  assert.ok(image, `provider payload contains ${role}`)
  return Buffer.from(image.url.split(',')[1], 'base64')
}
test('auto endpoint jobs send independent original first/last bytes, planned states and typed provenance', async () => {
  const id = version([panel(90)]), before = submissions.length
  await createBatch(id, opts); await finish(before + 1)
  const { data, item } = request(id)[0]
  assert.equal(data.actualStrategy, 'first_last'); assert.equal(data.referenceMode, 'first_last')
  assert.deepEqual(data.referenceImageUrls, []); assert.equal(data.referenceInput, undefined)
  assert.equal(data.videoContinuity.actual, 'first_last')
  assert.deepEqual(submissions.at(-1).input.media.map((m: any) => m.type), ['first_frame', 'last_frame'])
  assert.deepEqual(submissions.at(-1).input.media.map((m: any) => Buffer.from(m.url.split(',')[1], 'base64')), images.slice(0, 2))
  assert.match(data.prompt, /cup down/); assert.match(data.prompt, /cup up/)
  assert.deepEqual(JSON.parse(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.taskId!)).get()!.params!).videoContinuity, data.videoContinuity)
  const timeline = getVersion(id).timeline
  timeline.inheritedOutputs = [{ key: 'copy', panelIds: [90], url: '/static/old.mp4', stale: false, videoContinuity: data.videoContinuity }]
  assert.deepEqual(validateTimeline(timeline).inheritedOutputs?.[0].videoContinuity, data.videoContinuity)
})
test('strong same scene shares EXACT previous LAST as next FIRST and catches upstream change/reorder', async () => {
  const id = version([panel(70, 0, 1), panel(4, 2, 3)], true), before = submissions.length
  await createBatch(id, opts); await finish(before + 2)
  const [a, b] = request(id)
  assert.equal(a.data.videoContinuity.last.digest, b.data.videoContinuity.first.digest)
  assert.equal(a.data.lastFrameUrl, b.data.firstFrameUrl)
  assert.equal(b.data.videoContinuity.first.panelId, 70)
  // Provider calls run concurrently: capture order is independent of timeline order.
  const captured = submissions.slice(before)
  for (const actualOrder of [captured, [...captured].reverse()]) {
    const actualA = wanSubmissionFor(a.data, actualOrder), actualB = wanSubmissionFor(b.data, actualOrder)
    const lastBytes = wanFrameBytes(actualA, 'last_frame'), firstBytes = wanFrameBytes(actualB, 'first_frame')
    assert.deepEqual(lastBytes, firstBytes)
    assert.deepEqual(firstBytes, images[1])
    assert.equal(createHash('sha256').update(firstBytes).digest('hex'), b.data.videoContinuity.first.digest)
  }
  for (const r of [a, b]) {
    const task = db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, r.item.id)).get()!
    db.update(schema.batchRunItems).set({ status: 'completed' }).where(eq(schema.batchRunItems.id, r.item.id)).run()
    db.update(schema.sysTask).set({ status: 'completed', localPath: `/static/${r.item.id}.mp4` }).where(eq(schema.sysTask.id, task.taskId!)).run()
  }
  assert.equal(getVersion(id).outputs.find(o => o.panelIds[0] === 4)?.stale, false)
  const t = getVersion(id).timeline; t.panels[0].frames[1].prompt = 'Different ending'
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(t) }).where(eq(schema.animaticVersions.id, id)).run()
  assert.equal(getVersion(id).outputs.find(o => o.panelIds[0] === 4)?.stale, true)
  t.panels[0].frames[1].prompt = 'cup up'; t.groups.reverse()
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(t) }).where(eq(schema.animaticVersions.id, id)).run()
  assert.equal(getVersion(id).outputs.find(o => o.panelIds[0] === 4)?.stale, true)
})
test('auto unsupported/single falls back; explicit unsupported/single/group rejects atomically', async () => {
  const one = panel(8); one.frames.pop()
  const id = version([one]), before = submissions.length
  await createBatch(id, opts); await finish(before + 1)
  assert.equal(request(id)[0].data.videoContinuity.actual, 'reference')
  assert.match(request(id)[0].data.videoContinuity.fallbackReason, /至少.*2/)
  const id2 = version([panel(9)]); await createBatch(id2, { ...opts, configId: referenceConfigId }); await finish(before + 2)
  assert.match(request(id2)[0].data.videoContinuity.fallbackReason, /参考图/)
  const jobsBefore = db.select().from(schema.batchRunItems).all().length
  await assert.rejects(createBatch(version([one]), { ...opts, videoContinuityMode: 'first_last' }), /至少.*2/)
  await assert.rejects(createBatch(version([panel(10)]), { ...opts, configId: referenceConfigId, videoContinuityMode: 'first_last' }), /参考图/)
  await assert.rejects(createBatch(version([panel(11)]), { ...opts, videoContinuityMode: 'first_last', generationScope: 'group' }), /分镜/)
  assert.equal(db.select().from(schema.batchRunItems).all().length, jobsBefore)
})
test('incomplete/corrupt later unit queues no earlier endpoint job', async () => {
  const bad = panel(31); bad.frames[1].url = ''
  const jobs = db.select().from(schema.batchRunItems).all().length
  await assert.rejects(createBatch(version([panel(30), bad]), opts), /未完成/)
  writeFileSync(path.join(root, 'static', 'corrupt.png'), images[0].subarray(0, images[0].length / 2))
  bad.frames[1].url = '/static/corrupt.png'
  await assert.rejects(createBatch(version([panel(30), bad]), opts), /pngload|stream|corrupt|Warning treated as error due to failOn setting/)
  assert.equal(db.select().from(schema.batchRunItems).all().length, jobs)
})
test('dispatch rechecks frozen files; same-url source replacement marks completed output stale', async () => {
  const id = version([panel(50)]), before = submissions.length
  await createBatch(id, opts); await finish(before + 1)
  const { item, data } = request(id)[0]
  assert.equal(typeof endpoints.normalizeVideoEndpoints, 'function')
  const file = path.join(root, data.firstFrameUrl.replace(/^\/static\//, 'static/'))
  writeFileSync(file, images[3])
  await assert.rejects(endpoints.normalizeVideoEndpoints(data.videoContinuity), /变化/)
  writeFileSync(file, images[0])
  db.update(schema.batchRunItems).set({ status: 'completed' }).where(eq(schema.batchRunItems.id, item.id)).run()
  db.update(schema.sysTask).set({ status: 'completed', localPath: '/static/fake.mp4' }).where(eq(schema.sysTask.id, item.taskId!)).run()
  assert.equal(getVersion(id).outputs[0].stale, false)
  writeFileSync(path.join(root, 'static', '1.png'), images[2])
  assert.equal(getVersion(id).outputs[0].stale, true)
  writeFileSync(path.join(root, 'static', '1.png'), images[1])
  unlinkSync(path.join(root, 'static', '1.png'))
  assert.equal(getVersion(id).outputs[0].stale, true)
  writeFileSync(path.join(root, 'static', '1.png'), images[1])
})
test('MiniMax adapter sends first_frame/last_frame roles without reference_image', async () => {
  const id = version([panel(60)]), before = submissions.length
  await createBatch(id, { ...opts, configId: minimaxConfigId }); await finish(before + 1)
  assert.deepEqual(submissions.at(-1).content.filter((m: any) => m.type === 'image_url').map((m: any) => m.role), ['first_frame', 'last_frame'])
})
test('readonly capability endpoint performs no provider work', async () => {
  const before = submissions.length
  const res = await routes.request(`/previs/video-continuity-capabilities?config_id=${configId}&model=wan3.0-video`)
  assert.equal(res.status, 200); assert.equal((await res.json()).data.firstLast, true)
  assert.equal(submissions.length, before)
})
test('normal and scene-change transitions use each current own endpoints instead of sharing previous pixels', async () => {
  for (const sceneChange of [false, true]) {
    const id = version([panel(100, 0, 1), panel(101, 2, 3)]), before = submissions.length
    if (sceneChange) {
      const row = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, id)).get()!
      const t = JSON.parse(row.timelineJson); t.transitions[0].continuity = 'scene_change'
      db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(t) }).where(eq(schema.animaticVersions.id, id)).run()
    }
    await createBatch(id, opts); await finish(before + 2)
    const [a, b] = request(id)
    assert.notEqual(a.data.videoContinuity.last.digest, b.data.videoContinuity.first.digest)
    assert.equal(b.data.videoContinuity.first.panelId, 101)
    assert.equal(b.data.videoContinuity.continuity.status, sceneChange ? 'reset' : 'available')
    assert.deepEqual(wanFrameBytes(wanSubmissionFor(b.data, submissions.slice(before)), 'first_frame'), images[2])
  }
})
test('absent mode preserves legacy reference jobs and old output schema', async () => {
  const id = version([panel(110)]), before = submissions.length
  const { videoContinuityMode, ...legacy } = opts
  await createBatch(id, legacy); await finish(before + 1)
  const data = request(id)[0].data
  assert.equal(data.videoContinuity, undefined); assert.equal(data.actualStrategy, 'reference')
  assert.equal(data.referenceInput.effective, 'individual')
  const t = getVersion(id).timeline
  t.inheritedOutputs = [{ key: 'old', panelIds: [110], url: '/static/old.mp4', stale: false, referenceInput: data.referenceInput }]
  assert.deepEqual(validateTimeline(t).inheritedOutputs?.[0].referenceInput, data.referenceInput)
})
test('strong transition with frame camera reversal sends current own first bytes to the actual provider', async () => {
  const previous = panel(120, 0, 1), current = panel(121, 2, 3)
  previous.frames[1].angle = 'high'; previous.frames[1].shotType = 'close'
  current.frames[0].angle = 'reverse low'; current.frames[0].shotType = 'wide'
  const id = version([previous, current], true), before = submissions.length
  await createBatch(id, opts); await finish(before + 2)
  const [a, b] = request(id)
  assert.equal(b.data.videoContinuity.continuity.exactVideoBoundary, false)
  assert.equal(b.data.videoContinuity.first.panelId, 121)
  assert.notEqual(a.data.videoContinuity.last.digest, b.data.videoContinuity.first.digest)
  const actual = wanSubmissionFor(b.data, submissions.slice(before))
  assert.deepEqual(wanFrameBytes(actual, 'first_frame'), images[2])
  assert.match(actual.input.prompt, /reverse low/)
  assert.match(actual.input.prompt, /wide/)
})
test('strong allowed holding/custom changes use actual current first bytes; explicit time change resets', async () => {
  for (const change of ['holding', 'arbitrary_custom_change', 'timeOfDay']) {
    const id = version([panel(130, 0, 1), panel(131, 2, 3)], true), before = submissions.length
    const row = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, id)).get()!
    const t = JSON.parse(row.timelineJson); t.transitions[0].allowedChanges = [change]
    t.groups[0].exit.holding = 'cup'; t.groups[1].entry.holding = 'empty hands'
    db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(t) }).where(eq(schema.animaticVersions.id, id)).run()
    await createBatch(id, opts); await finish(before + 2)
    const [a, b] = request(id)
    assert.equal(b.data.videoContinuity.continuity.exactVideoBoundary, false, change)
    assert.equal(b.data.videoContinuity.continuity.status, change === 'timeOfDay' ? 'reset' : 'available')
    assert.equal(b.data.videoContinuity.first.panelId, 131)
    assert.notEqual(a.data.videoContinuity.last.digest, b.data.videoContinuity.first.digest)
    assert.deepEqual(wanFrameBytes(wanSubmissionFor(b.data, submissions.slice(before)), 'first_frame'), images[2])
  }
})
