import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame } from '../src/services/previs-domain.js'

const root = mkdtempSync(path.join(tmpdir(), 'generation-queue-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
mkdirSync(path.join(root, 'static'), { recursive: true })
const original = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer()
writeFileSync(path.join(root, 'static', 'reference.png'), original)
const { db, schema } = await import('../src/db/index.js')
const generation = await import('../src/services/generation.js')
const queue = await import('../src/services/task-queue.js')
const imageConfigId = Number(db.insert(schema.aiServiceConfigs).values({
  name: 'queue image', serviceType: 'image', provider: 'openai', baseUrl: 'http://queue.test',
  apiKey: 'private-key', model: JSON.stringify(['gpt-image-2']), isActive: true, createdAt: 'now', updatedAt: 'now',
}).run().lastInsertRowid)
const videoConfigId = Number(db.insert(schema.aiServiceConfigs).values({
  name: 'queue video', serviceType: 'video', provider: 'volcengine', baseUrl: 'http://queue.test',
  apiKey: 'private-key', model: JSON.stringify(['doubao-seedance-2-0']), isActive: true, createdAt: 'now', updatedAt: 'now',
}).run().lastInsertRowid)
const originalFetch = globalThis.fetch
let submissions = 0
globalThis.fetch = async () => { submissions++; return new Response('rejected', { status: 400 }) }
after(() => { globalThis.fetch = originalFetch })
const task = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!

test('ordinary image and video requests are durable pending tasks before a worker claims them', async () => {
  const imageId = await generation.generateImage({ prompt: 'image', configId: imageConfigId })
  const videoId = await generation.generateVideo({ prompt: 'video', configId: videoConfigId })
  assert.equal(task(imageId).status, 'pending')
  assert.equal(task(videoId).status, 'pending')
  assert.equal(submissions, 0)
})

test('default and fallback configurations persist their effective IDs and hashes without credentials', async () => {
  const id = await generation.generateImage({ prompt: 'fallback', configId: 99999 })
  const params = JSON.parse(task(id).params!)
  assert.equal(params.configId, imageConfigId)
  assert.match(params.frozenConfigHash, /^[a-f0-9]{64}$/)
  assert.ok(!task(id).params!.includes('private-key'))
})

test('ordinary image references are frozen before waiting in the queue', async () => {
  const id = await generation.generateImage({ prompt: 'reference', configId: imageConfigId, referenceImages: ['/static/reference.png'] })
  const params = JSON.parse(task(id).params!)
  assert.ok(Array.isArray(params.frozenReferences), 'queue input must contain frozen reference snapshots')
  assert.equal(params.frozenReferences.length, 1)
  assert.notEqual(params.frozenReferences[0].url, '/static/reference.png')
  writeFileSync(path.join(root, 'static', 'reference.png'), 'replaced')
  const urls = await generation.normalizeFrozenImageReferences(params.frozenReferences)
  assert.equal(urls[0], `data:image/png;base64,${original.toString('base64')}`)
})

async function until(check: () => boolean, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(check(), 'queue work did not reach expected state')
}
function cancelWaiting() {
  for (const record of db.select().from(schema.sysTask).all()) {
    const job = queue.getQueueJob('sys_task', record.id)
    if (job?.status === 'pending') queue.cancelQueueJob(job.id)
  }
}

test('previs children cannot start before their grid parent is linked', async () => {
  cancelWaiting()
  const id = await generation.generateImage({ prompt: 'grid', configId: imageConfigId, previs: { versionId: 1, itemKey: 'grid-999999' } })
  await queue.tickTaskQueue()
  assert.equal(queue.getQueueJob('sys_task', id)!.ready, false)
  await generation.startQueuedPrevisTask(id)
  assert.equal(task(id).status, 'pending')
  assert.equal(submissions, 0)
})

test('an accepted asynchronous task retains its queue slot until polling and saving finish', async () => {
  cancelWaiting()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { submissions++; return Response.json({ task_id: 'accepted-1' }) }
    await gate
    return Response.json({ status: 'failed', error: { message: 'provider rejected content' } })
  }
  const id = await generation.generateImage({ prompt: 'async', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => task(id).taskId === 'accepted-1')
  const active = queue.getQueueJob('sys_task', id)!
  assert.equal(active.status, 'processing')
  assert.equal(active.submitted, true)
  assert.equal(JSON.parse(task(id).params!).submissionStarted, true)
  release()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed', 1500)
})

test('changed queued configuration prevents submission and requires a fresh request', async () => {
  const before = submissions
  const id = await generation.generateVideo({ prompt: 'changed config', configId: videoConfigId })
  db.update(schema.aiServiceConfigs).set({ apiKey: 'changed-secret' }).where(eq(schema.aiServiceConfigs.id, videoConfigId)).run()
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  assert.equal(submissions, before)
  assert.match(task(id).errorMsg!, /配置已变化/)
})

test('lost generation response remains tracked and cannot be blindly retried or cancelled', async () => {
  const before = submissions
  globalThis.fetch = async () => { submissions++; throw new Error('response lost') }
  const id = await generation.generateImage({ prompt: 'lost response', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.phase === 'needs_confirmation')
  const job = queue.getQueueJob('sys_task', id)!
  assert.equal(task(id).status, 'processing')
  assert.equal(job.submitted, true)
  assert.equal(submissions - before, 1, 'a lost response cannot trigger automatic reposting')
  assert.throws(() => queue.retryQueueJob(job.id), /核对/)
  assert.throws(() => queue.cancelQueueJob(job.id), /提交/)
  queue.reconcileQueueJob(job.id, true)
})

test('failed local image save retries the preserved paid result without a new generation', async () => {
  let posts = 0, rejectDownload = true
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ data: [{ url: 'http://media.test/result.png' }] }) }
    return rejectDownload ? new Response('download unavailable', { status: 503 }) : new Response(original, { headers: { 'Content-Type': 'image/png' } })
  }
  const id = await generation.generateImage({ prompt: 'save failure', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  const job = queue.getQueueJob('sys_task', id)!
  assert.equal(job.upstreamDone, true)
  assert.equal(task(id).resultUrl, 'http://media.test/result.png')
  rejectDownload = false
  queue.retryQueueJob(job.id)
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'completed')
  assert.equal(posts, 1)
  assert.equal(task(id).status, 'completed')
})

test('a queued external video reference is digest checked before paid submission', async () => {
  let version = 'original-video', posts = 0
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts++; return new Response('rejected', { status: 400 }) }
    return new Response(version)
  }
  const id = await generation.generateVideo({ prompt: 'video media', configId: videoConfigId, referenceVideoUrls: ['https://media.test/source.mp4'] })
  version = 'replaced-video'
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  assert.equal(posts, 0, 'changed media must fail before a paid POST')
  assert.match(task(id).errorMsg!, /参考.*变化/)
})

test('legacy batch retry reuses a paid result when only local saving failed', async () => {
  const batches = await import('../src/services/previs-batch.js')
  db.insert(schema.dramas).values({ id: 1, title: 'queue', createdAt: 'now', updatedAt: 'now' }).run()
  db.insert(schema.episodes).values({ id: 1, dramaId: 1, title: 'queue', episodeNumber: 1, createdAt: 'now', updatedAt: 'now' }).run()
  db.insert(schema.animaticVersions).values({ id: 1, episodeId: 1, versionNo: 1,
    timelineJson: JSON.stringify({ schemaVersion: 2, panels: [], groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }),
    createdAt: 'now', updatedAt: 'now' }).run()
  const batchId = Number(db.insert(schema.batchRuns).values({ versionId: 1, type: 'image', configId: imageConfigId, model: 'gpt-image-2', requestHash: 'local-retry', createdAt: 'now' }).run().lastInsertRowid)
  const itemId = Number(db.insert(schema.batchRunItems).values({ batchId, groupId: 'queue', requestJson: '{}', attempt: 1 }).run().lastInsertRowid)
  let posts = 0
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json({ data: [{ url: 'http://media.test/batch.png' }] }) }
    return new Response('unavailable', { status: 503 })
  }
  const id = await generation.generateImage({ prompt: 'batch save', configId: imageConfigId, previs: { versionId: 1, itemKey: `${itemId}:1` } })
  db.update(schema.batchRunItems).set({ taskId: id }).where(eq(schema.batchRunItems.id, itemId)).run()
  await generation.startQueuedPrevisTask(id)
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  await batches.tickPrevisBatches()
  batches.updateBatch(batchId, 'retry')
  const item = db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, itemId)).get()!
  assert.equal(item.taskId, id, 'local save retry must retain the existing paid task')
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts++; return new Response('unexpected POST', { status: 400 }) }
    return new Response(original, { headers: { 'Content-Type': 'image/png' } })
  }
  await queue.tickTaskQueue()
  await until(() => task(id).status === 'completed')
  assert.equal(posts, 1)
})

test('a gateway timeout after POST is ambiguous even when an HTTP response arrives', async () => {
  let posts = 0
  globalThis.fetch = async () => { posts++; return new Response('gateway timed out while upstream worked', { status: 504 }) }
  const id = await generation.generateImage({ prompt: 'gateway timeout', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => ['failed', 'needs_confirmation'].includes(queue.getQueueJob('sys_task', id)!.phase))
  const job = queue.getQueueJob('sys_task', id)!
  assert.equal(job.phase, 'needs_confirmation')
  assert.equal(job.submitted, true)
  assert.equal(task(id).status, 'processing')
  assert.equal(posts, 1, 'an ambiguous gateway failure cannot trigger automatic reposting')
  queue.reconcileQueueJob(job.id, true)
})

test('an HTTP 408 after POST remains uncertain and cannot be automatically retried', async () => {
  let posts = 0
  globalThis.fetch = async () => { posts++; return new Response('upstream request timed out', { status: 408 }) }
  const id = await generation.generateImage({ prompt: 'request timeout', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.phase === 'needs_confirmation')
  const job = queue.getQueueJob('sys_task', id)!
  assert.equal(job.submitted, true)
  assert.equal(task(id).status, 'processing')
  assert.equal(posts, 1, 'an HTTP timeout provides no reliable proof that generation was rejected')
  assert.throws(() => queue.retryQueueJob(job.id), /核对/)
  queue.reconcileQueueJob(job.id, true)
})

test('task-center retry and cancel keep the linked previs batch item in sync', async () => {
  globalThis.fetch = async () => new Response('invalid request', { status: 400 })
  const batchId = Number(db.insert(schema.batchRuns).values({ versionId: 1, type: 'image', configId: imageConfigId, model: 'gpt-image-2', requestHash: 'task-center', createdAt: 'now' }).run().lastInsertRowid)
  const itemId = Number(db.insert(schema.batchRunItems).values({ batchId, groupId: 'queue', requestJson: '{}', attempt: 1 }).run().lastInsertRowid)
  const id = await generation.generateImage({ prompt: 'task-center', configId: imageConfigId, previs: { versionId: 1, itemKey: `${itemId}:1` } })
  db.update(schema.batchRunItems).set({ taskId: id }).where(eq(schema.batchRunItems.id, itemId)).run()
  await generation.startQueuedPrevisTask(id)
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  const batches = await import('../src/services/previs-batch.js')
  await batches.tickPrevisBatches()
  const job = queue.getQueueJob('sys_task', id)!
  queue.retryQueueJob(job.id)
  assert.equal(db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, itemId)).get()!.status, 'pending')
  queue.cancelQueueJob(job.id)
  assert.equal(db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, itemId)).get()!.status, 'cancelled')
})

test('restart migration restores saved image asset binding without submitting to a provider', async () => {
  writeFileSync(path.join(root, 'static', 'saved.png'), original)
  db.insert(schema.characters).values({ id: 1, dramaId: 1, name: 'saved character', createdAt: 'now', updatedAt: 'now' }).run()
  const id = Number(db.insert(schema.sysTask).values({ type: 'image', characterId: 1, provider: 'openai', prompt: 'saved',
    params: JSON.stringify({ configId: imageConfigId }), localPath: 'static/saved.png', status: 'processing', createdAt: 'now', updatedAt: 'now' }).run().lastInsertRowid)
  globalThis.fetch = async () => { throw new Error('saved recovery must not contact a provider') }
  await generation.recoverPrevisTasks()
  await queue.recoverTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'completed')
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, 1)).get()!.imageUrl, 'static/saved.png')
})

test('legacy ordinary processing without a submission marker is never automatically submitted again', async () => {
  const id = Number(db.insert(schema.sysTask).values({ type: 'image', provider: 'openai', prompt: 'legacy uncertain',
    params: JSON.stringify({ configId: imageConfigId }), status: 'processing', createdAt: 'now', updatedAt: 'now' }).run().lastInsertRowid)
  let posts = 0
  globalThis.fetch = async () => { posts++; return new Response('unexpected', { status: 400 }) }
  await generation.recoverPrevisTasks()
  assert.equal(queue.getQueueJob('sys_task', id)!.submitted, true, 'legacy processing has no reliable proof of non-submission')
  await queue.recoverTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.phase === 'needs_confirmation')
  assert.equal(posts, 0)
  queue.reconcileQueueJob(queue.getQueueJob('sys_task', id)!.id, true)
})

test('a previs video retry cannot silently use changed configuration credentials', async () => {
  const { getConfigById } = await import('../src/services/ai.js')
  const { hashContent } = await import('../src/services/previs.js')
  const configHash = hashContent(await getConfigById(videoConfigId))
  db.update(schema.aiServiceConfigs).set({ apiKey: 'another-new-key' }).where(eq(schema.aiServiceConfigs.id, videoConfigId)).run()
  await assert.rejects(generation.generateVideo({ prompt: 'frozen video', configId: videoConfigId, frozenConfigHash: configHash }), /配置已变化/)
})

test('discarding an already rejected previs task leaves its terminal tracking intact', async () => {
  globalThis.fetch = async () => new Response('rejected', { status: 400 })
  const id = await generation.generateImage({ prompt: 'ended', configId: imageConfigId, previs: { versionId: 1, itemKey: 'ended-reject' } })
  await generation.startQueuedPrevisTask(id)
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  assert.doesNotThrow(() => generation.cancelUnsubmittedPrevisTask(id))
  assert.equal(task(id).status, 'failed')
})

test('an explicitly rejected 429 is automatically retried within the existing task', async () => {
  let posts = 0
  globalThis.fetch = async () => ++posts === 1
    ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
    : Response.json({ data: [{ b64_json: original.toString('base64') }] })
  const id = await generation.generateImage({ prompt: 'safe rate limit retry', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => ['failed', 'completed'].includes(queue.getQueueJob('sys_task', id)!.status))
  assert.equal(task(id).status, 'completed')
  assert.equal(posts, 2)
})

test('automatic rate-limit retries stop after two retries and preserve a safely failed task', async () => {
  let posts = 0
  globalThis.fetch = async () => { posts++; return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }) }
  const id = await generation.generateImage({ prompt: 'exhausted rate limit', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => queue.getQueueJob('sys_task', id)!.status === 'failed')
  assert.equal(posts, 3)
  assert.equal(queue.getQueueJob('sys_task', id)!.submitted, false)
  assert.equal(JSON.parse(task(id).params!).submissionStarted, false)
})

test('cancelling during a known rate-limit wait prevents the next paid request', async () => {
  let posts = 0
  globalThis.fetch = async () => { posts++; return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.1' } }) }
  const id = await generation.generateImage({ prompt: 'cancel rate limit wait', configId: imageConfigId })
  await queue.tickTaskQueue()
  await until(() => ['failed', 'retry_wait'].includes(queue.getQueueJob('sys_task', id)!.phase))
  assert.equal(queue.getQueueJob('sys_task', id)!.phase, 'retry_wait')
  queue.cancelQueueJob(queue.getQueueJob('sys_task', id)!.id)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(posts, 1)
  assert.equal(task(id).status, 'cancelled')
})

test('queued local contact sheets freeze source bytes before a paused task is released', async () => {
  const sheets = await import('../src/services/previs-contact-sheets.js')
  const settings = await import('../src/services/task-queue-settings.js')
  const { mediaDigest } = await import('../src/services/previs-reference-media.js')
  writeFileSync(path.join(root, 'static', 'sheet-input.png'), original)
  const timeline = { schemaVersion: 2, panels: [{ id: 80, title: 'sheet', frames: [{ ...makeFrame('sheet-frame'), url: '/static/sheet-input.png' }] }],
    groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline) }).where(eq(schema.animaticVersions.id, 1)).run()
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: true })
  sheets.scheduleContactSheets(1)
  await sheets.tickContactSheets()
  const row = db.select().from(schema.frameContactSheets).all().find(row => row.panelId === 80)!
  const snapshot = JSON.parse(queue.getQueueJob('contact_sheet', row.id)!.snapshotJson)
  assert.equal(snapshot.references?.[0]?.digest, mediaDigest(original), 'queued local inputs need a frozen digest')
  writeFileSync(path.join(root, 'static', 'sheet-input.png'), await sharp(original).negate().png().toBuffer())
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: false })
  await sheets.tickContactSheets()
  assert.equal(db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, row.id)).get()!.status, 'completed')
  assert.equal(JSON.parse(db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, row.id)).get()!.sourceDigestsJson!)[0], mediaDigest(original))
})
