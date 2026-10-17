import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame } from '../src/services/previs-domain.js'

const root = mkdtempSync(path.join(tmpdir(), 'grid-scheduling-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
mkdirSync(path.join(root, 'static'), { recursive: true })
const image = await sharp({
  create: { width: 640, height: 360, channels: 3, background: 'red' },
})
  .png()
  .toBuffer()
writeFileSync(path.join(root, 'static', 'asset.png'), image)
let calls = 0,
  active = 0,
  maxActive = 0
const releases: (() => void)[] = []
const server = createServer(async (req, res) => {
  for await (const _ of req) {
    /* Consume the actual multipart upload. */
  }
  calls++
  active++
  maxActive = Math.max(maxActive, active)
  await new Promise<void>((resolve) => releases.push(resolve))
  active--
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
}).listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
after(() => {
  releases.splice(0).forEach((release) => release())
  server.close()
})
const { db, schema } = await import('../src/db/index.js')
const grid = await import('../src/services/previs-grid.js')
const generation = await import('../src/services/generation.js')
const batches = await import('../src/services/previs-batch.js')
const configId = Number(
  (await db
    .insert(schema.aiServiceConfigs)
    .values({
      name: 'local scheduling test',
      serviceType: 'image',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      apiKey: 'test',
      model: JSON.stringify(['gpt-image-2']),
      isActive: true,
      createdAt: 'now',
      updatedAt: 'now',
    })
    .run()).lastInsertRowid,
)
await db.insert(schema.dramas)
  .values({
    id: 1,
    title: 'test',
    aspectRatio: '16:9',
    createdAt: 'now',
    updatedAt: 'now',
  })
  .run()
await db.insert(schema.episodes)
  .values({
    id: 1,
    dramaId: 1,
    episodeNumber: 1,
    title: 'test',
    createdAt: 'now',
    updatedAt: 'now',
  })
  .run()
const panels = [1, 2, 3].map((id) => ({
  id,
  title: `panel ${id}`,
  description: 'action',
  atmosphere: 'daylight',
  imagePrompt: '',
  videoPrompt: 'raise hand',
  durationMs: 5000,
  sceneId: null,
  scene: 'room',
  shotType: 'medium',
  angle: 'eye',
  movement: '',
  characterIds: [],
  propIds: [],
  referenceImages: ['/static/asset.png'],
  videoUrl: '',
  frames: [makeFrame(`f${id}`, 0)],
}))
const versionId = Number(
  (await db
    .insert(schema.animaticVersions)
    .values({
      episodeId: 1,
      versionNo: 1,
      timelineJson: JSON.stringify({
        schemaVersion: 2,
        panels,
        groups: [],
        transitions: [],
        audio: [],
        strategy: defaultStrategy,
        acknowledgements: {},
      }),
      createdAt: 'now',
      updatedAt: 'now',
    })
    .run()).lastInsertRowid,
)
const payload = {
  revision: 1,
  panelIds: [1, 2, 3],
  configId,
  model: 'gpt-image-2',
  mode: 'generate' as const,
  resolution: '1K' as const,
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(await check(), 'mock task did not reach expected state')
}

test('discard after claim but before upstream submission cancels all paid requests', async () => {
  const candidates = (await grid.startGridCandidates(versionId, payload)).items
  await grid.tickGridCandidates()
  assert.equal(calls, 0, 'references are still being read before the submission boundary')
  for (const candidate of candidates) await grid.discardGridCandidate(versionId, candidate.id)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(calls, 0)
  assert.ok(
    (await db
      .select()
      .from(schema.sysTask)
      .all()).every((task) => task.status === 'cancelled'),
  )
})

test('grid and legacy queued image jobs share two configuration slots, including submitted discarded jobs', async () => {
  const candidates = (await grid.startGridCandidates(versionId, payload)).items
  await grid.tickGridCandidates()
  await until(async () => calls >= 2)
  assert.equal(calls, 2)
  assert.equal(maxActive, 2)
  const legacyId = await generation.generateImage({
    previs: { versionId, itemKey: 'legacy-slot-test' },
    prompt: 'legacy frame',
    configId,
    model: 'gpt-image-2',
    size: '1920x1080',
  })
  await generation.startQueuedPrevisTask(legacyId)
  assert.equal(
    (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, legacyId)).get()!).status,
    'pending',
  )
  for (const candidate of candidates) await grid.discardGridCandidate(versionId, candidate.id)
  await generation.startQueuedPrevisTask(legacyId)
  assert.equal(calls, 2, 'submitted discarded jobs retain their slots until they finish')
  releases.splice(0).forEach((release) => release())
  await until(
    async () =>
      (await db
        .select()
        .from(schema.sysTask)
        .all()).filter((task) => task.previsItemKey?.startsWith('grid-') && task.status === 'processing').length ===
      0,
  )
  await generation.startQueuedPrevisTask(legacyId)
  await until(async () => calls === 3)
  releases.splice(0).forEach((release) => release())
  await until(
    async () =>
      (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, legacyId)).get()!).status === 'completed',
  )
  assert.equal(maxActive, 2)
})

test('cancelling a legacy batch also cancels linked tasks waiting for shared grid slots', async () => {
  const before = calls,
    candidates = (await grid.startGridCandidates(versionId, payload)).items
  await grid.tickGridCandidates()
  await until(async () => calls === before + 2)
  const batchId = Number(
    (await db
      .insert(schema.batchRuns)
      .values({
        versionId,
        type: 'image',
        configId,
        model: 'gpt-image-2',
        requestHash: 'cancel-test',
        createdAt: 'now',
      })
      .run()).lastInsertRowid,
  )
  const itemId = Number(
    (await db
      .insert(schema.batchRunItems)
      .values({
        batchId,
        groupId: 'test',
        panelId: 1,
        frameType: 'start',
        requestJson: '{}',
        status: 'processing',
      })
      .run()).lastInsertRowid,
  )
  const taskId = await generation.generateImage({
    previs: { versionId, itemKey: `${itemId}:1` },
    prompt: 'legacy frame',
    configId,
    model: 'gpt-image-2',
    size: '1920x1080',
  })
  await db.update(schema.batchRunItems).set({ taskId }).where(eq(schema.batchRunItems.id, itemId)).run()
  await generation.startQueuedPrevisTask(taskId)
  assert.equal((await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()!).status, 'pending')
  await batches.updateBatch(batchId, 'cancel')
  assert.equal(
    (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()!).status,
    'cancelled',
  )
  assert.equal(
    (await db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, itemId)).get()!).status,
    'cancelled',
  )
  for (const candidate of candidates) await grid.discardGridCandidate(versionId, candidate.id)
  releases.splice(0).forEach((release) => release())
  await until(
    async () =>
      (await db
        .select()
        .from(schema.sysTask)
        .all()).filter((task) => task.status === 'processing').length === 0,
  )
  await batches.tickPrevisBatches()
  assert.equal(calls, before + 2)
})

test('legacy image preflight and late completion cannot replace a locked frame', async () => {
  const v = await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()!
  const timeline = JSON.parse(v.timelineJson)
  timeline.panels[0].frames[0] = {
    ...timeline.panels[0].frames[0],
    locked: true,
    url: '/static/asset.png',
    source: {
      candidateId: 1,
      mode: 'frame_edit',
      gridIndex: 0,
      bounds: { left: 0, top: 0, width: 640, height: 360 },
    },
  }
  await db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(timeline) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  await assert.rejects(
    batches.createBatch(versionId, {
      revision: v.revision,
      type: 'image',
      configId,
      panelIds: [1],
      force: true,
    }),
    /锁定/,
  )
  const batchId = Number(
    (await db
      .insert(schema.batchRuns)
      .values({
        versionId,
        type: 'image',
        configId,
        model: 'gpt-image-2',
        requestHash: 'late-lock-test',
        status: 'processing',
        createdAt: 'now',
      })
      .run()).lastInsertRowid,
  )
  const taskId = Number(
    (await db
      .insert(schema.sysTask)
      .values({
        type: 'image',
        status: 'completed',
        localPath: '/static/new.png',
        provider: 'openai',
        createdAt: 'now',
        updatedAt: 'now',
      })
      .run()).lastInsertRowid,
  )
  await db.insert(schema.batchRunItems)
    .values({
      batchId,
      groupId: 'test',
      panelId: 1,
      frameType: 'beat',
      taskId,
      requestJson: JSON.stringify({ frameId: 'f1' }),
      status: 'processing',
    })
    .run()
  await batches.tickPrevisBatches()
  assert.deepEqual(
    JSON.parse(
      (await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get())!
        .timelineJson,
    ).panels[0].frames[0],
    timeline.panels[0].frames[0],
  )
  const item = (await db
    .select()
    .from(schema.batchRunItems)
    .all()).find((item) => item.batchId === batchId)!
  await db.update(schema.batchRunItems).set({ status: 'failed' }).where(eq(schema.batchRunItems.id, item.id)).run()
  await assert.rejects(async () => batches.updateBatch(batchId, 'retry'), /锁定/)
})
