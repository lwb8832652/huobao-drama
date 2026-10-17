import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame, normalizeTimeline, type Panel } from '../src/services/previs-domain.js'

const root = mkdtempSync(path.join(tmpdir(), 'frame-planning-worker-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
const requests: any[] = []
const releases: (() => void)[] = []
const server = createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  requests.push(body)
  await new Promise<void>(resolve => releases.push(resolve))
  const content = JSON.stringify({ continuityConstraints: '红色外套、白杯、左窗光；按描述切镜', frames: [
    { title: '持杯', prompt: '小明右手握白杯，位于桌左，视线朝右', offsetMs: 0, continuity: '起始：小明右手持杯' },
    { title: '接杯', prompt: '小红左手握杯身，小明右手仍握杯柄', offsetMs: 1200, continuity: '小明持杯→小红伸左手→两人同时持杯' },
    { title: '收手', prompt: '小红左手独自持杯，小明右手垂在腰侧', offsetMs: 5999, continuity: '同时持杯→小明松手→小红独自持杯' },
  ] })
  const payload = { id: 'mock-response', object: 'chat.completion', created: 1, model: 'test-planner', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.end(`data: ${JSON.stringify({ ...payload, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...payload, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  } else {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(payload))
  }
}).listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
after(() => { releases.splice(0).forEach(release => release()); server.close() })
const { db, schema } = await import('../src/db/index.js')
const planning = await import('../src/services/previs-frames.js')
const { readFramePlanningContext } = await import('../src/agents/tools/frame-splitter-tools.js')
const ts = new Date().toISOString()
await db.insert(schema.dramas).values({ id: 1, title: 'Test', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'Test', createdAt: ts, updatedAt: ts }).run()
const characterId = Number((await db.insert(schema.characters).values({ dramaId: 1, name: '小明', styling: '红色外套', appearance: '黑色短发', imageUrl: '/static/ming.png', createdAt: ts, updatedAt: ts }).run()).lastInsertRowid)
const configId = Number((await db.insert(schema.aiServiceConfigs).values({ name: 'Local planner', serviceType: 'text', provider: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, apiKey: 'test', model: JSON.stringify(['test-planner']), isActive: true, createdAt: ts, updatedAt: ts }).run()).lastInsertRowid)
let versionNo = 0
function panel(): Panel { return { id: 1, title: '接杯', description: '小明递杯，小红接杯，切到小红', imagePrompt: '右手白杯', videoPrompt: '0-2s递杯；2-5s接杯；5-6s松手', atmosphere: '左窗暖光', durationMs: 6000, sceneId: null, scene: 'Kitchen', shotType: 'medium', angle: 'eye', movement: 'fixed', characterIds: [characterId], propIds: [], referenceImages: ['/static/common.png'], referenceLabels: ['布局'], videoUrl: '', frames: [makeFrame('end', 5999), makeFrame('start', 0), makeFrame('middle', 1200)] } }
async function version() { return Number((await db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: ++versionNo, timelineJson: JSON.stringify({ schemaVersion: 2, panels: [panel()], groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run()).lastInsertRowid) }
async function row(id: number) { return await db.select().from(schema.framePlans).where(eq(schema.framePlans.id, id)).get()! }
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.ok(await predicate(), 'worker/mock did not reach expected state')
}
const options = { revision: 1, panelIds: [1], count: 3, configId, model: 'test-planner', force: true }
async function seedPending(id: number) {
  const r = await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, id)).get()!
  const p = normalizeTimeline(JSON.parse(r.timelineJson)).panels[0]
  const context = await readFramePlanningContext(id, [1], 1, 1)
  return Number((await db.insert(schema.framePlans).values({ versionId: id, panelId: 1, inputHash: planning.planInputHash(p, context), count: 3, configId, model: 'test-planner', status: 'pending', resultJson: '', createdAt: ts }).run()).lastInsertRowid)
}

test('queued plan rejects changed server context before any provider call', async () => {
  const id = (await version()), taskId = await seedPending(id), before = requests.length
  await db.update(schema.characters).set({ styling: '蓝色外套' }).where(eq(schema.characters.id, characterId)).run()
  const worker = planning.tickFramePlans()
  // Existing implementation starts a stale call: release it to let the assertion report the failure.
  await until(async () => requests.length > before || (await row(taskId)).status === 'failed')
  releases.splice(0).forEach(release => release())
  await worker
  assert.equal((await row(taskId)).status, 'failed')
  assert.match((await row(taskId)).error || '', /资料.*变化/)
  assert.equal(requests.length, before)
})

test('force reuses a processing plan and rejects changed options without resetting the claimed task', async () => {
  const id = (await version()), before = requests.length
  const first = await planning.startFramePlan(id, options)
  await until(async () => requests.length > before)
  try {
    const claimedAt = (await row(first.taskIds[0])).createdAt
    const duplicate = await planning.startFramePlan(id, options)
    assert.deepEqual(duplicate.taskIds, first.taskIds)
    assert.equal(duplicate.queued, 0)
    assert.equal((await row(first.taskIds[0])).status, 'processing')
    assert.equal((await row(first.taskIds[0])).createdAt, claimedAt)
    await assert.rejects(planning.startFramePlan(id, { ...options, count: 4 }), /等待.*规划/)
  } finally { releases.splice(0).forEach(release => release()) }
  await until(async () => !['pending', 'processing'].includes((await row(first.taskIds[0])).status))
  assert.equal(requests.length, before + 1)
})

test('a real tool-free response receives complete context and preserves ordered draft identities', async () => {
  const id = (await version()), before = requests.length
  const started = await planning.startFramePlan(id, options)
  await until(async () => requests.length > before)
  const message = JSON.stringify(requests.at(-1).messages.filter((message: any) => message.role === 'user'))
  assert.match(message, /目标画面数：3/)
  assert.match(message, /imagePrompt/)
  assert.match(message, /右手白杯/)
  assert.match(message, /referenceManifest/)
  assert.match(message, /ming.png/)
  assert.match(message, /orderedFrames/)
  releases.splice(0).forEach(release => release())
  await until(async () => (await row(started.taskIds[0])).status !== 'processing')
  assert.equal((await row(started.taskIds[0])).status, 'completed', (await row(started.taskIds[0])).error || '')
  const result = JSON.parse((await row(started.taskIds[0])).resultJson)
  assert.equal(result.source, 'ai')
  assert.deepEqual(result.frames.map((frame: any) => frame.id), ['start', 'middle', 'end'])
  assert.deepEqual(result.frames.map((frame: any) => frame.offsetMs), [0, 1200, 5999])
  assert.equal(requests.length, before + 1)
  assert.equal((await db.select().from(schema.sysTask).all()).length, 0, 'planning must not chain image generation')
})

test('context changed during a paid planning request fails without publishing an applicable result', async () => {
  const id = (await version()), before = requests.length
  const started = await planning.startFramePlan(id, options)
  await until(async () => requests.length > before)
  await db.update(schema.characters).set({ appearance: '长发' }).where(eq(schema.characters.id, characterId)).run()
  releases.splice(0).forEach(release => release())
  await until(async () => (await row(started.taskIds[0])).status !== 'processing')
  assert.equal((await row(started.taskIds[0])).status, 'failed')
  assert.match((await row(started.taskIds[0])).error || '', /资料.*变化/)
  assert.equal((await planning.listFramePlans(id)).plans.length, 0)
})

test('a replaced processing claim cannot be completed or failed by the original worker', async () => {
  const id = (await version()), taskId = await seedPending(id), before = requests.length
  const worker = planning.tickFramePlans()
  await until(async () => requests.length > before)
  const replacement = { status: 'processing', createdAt: 'replacement-claim', resultJson: '{"marker":"new owner"}', error: 'new owner marker' }
  await db.update(schema.framePlans).set(replacement).where(eq(schema.framePlans.id, taskId)).run()
  releases.splice(0).forEach(release => release())
  await worker
  assert.equal((await row(taskId)).status, replacement.status)
  assert.equal((await row(taskId)).createdAt, replacement.createdAt)
  assert.equal((await row(taskId)).resultJson, replacement.resultJson)
  assert.equal((await row(taskId)).error, replacement.error)
})
