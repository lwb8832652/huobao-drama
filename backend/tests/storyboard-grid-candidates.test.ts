import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame, type Timeline } from '../src/services/previs-domain.js'
const root = mkdtempSync(path.join(tmpdir(), 'grid-candidates-'))
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
  imagesSent = 0
const server = createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  calls++
  imagesSent = (body.match(/Content-Type: image\//g) || []).length
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
}).listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
after(() => server.close())
const { db, schema } = await import('../src/db/index.js')
const grid = await import('../src/services/previs-grid.js')
const { getVersion, saveTimeline } = await import('../src/services/previs.js')
const configId = Number(
  db
    .insert(schema.aiServiceConfigs)
    .values({
      name: 'test',
      serviceType: 'image',
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      apiKey: 'test',
      model: JSON.stringify(['gpt-image-2']),
      isActive: true,
      createdAt: 'now',
      updatedAt: 'now',
    })
    .run().lastInsertRowid,
)
db.insert(schema.dramas)
  .values({
    id: 1,
    title: 'test',
    aspectRatio: '16:9',
    createdAt: 'now',
    updatedAt: 'now',
  })
  .run()
db.insert(schema.episodes)
  .values({
    id: 1,
    dramaId: 1,
    episodeNumber: 1,
    title: 'test',
    createdAt: 'now',
    updatedAt: 'now',
  })
  .run()
const frames = Array.from({ length: 4 }, (_, i) => ({
  ...makeFrame(`f${i}`, i * 1000),
  prompt: `static state ${i}`,
}))
const panel = {
  id: 1,
  title: 'test',
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
  frames,
}
const timeline = {
  schemaVersion: 2,
  panels: [panel],
  groups: [{ id: 'g', title: 'test', note: '', panelIds: [1], entry: {}, exit: {} }],
  transitions: [],
  audio: [],
  strategy: defaultStrategy,
  acknowledgements: {},
} as Timeline
db.insert(schema.storyboards)
  .values({
    id: 1,
    dramaId: 1,
    episodeId: 1,
    storyboardNumber: 1,
    title: 'test',
    duration: 5,
    createdAt: 'now',
    updatedAt: 'now',
  })
  .run()
const versionId = Number(
  db
    .insert(schema.animaticVersions)
    .values({
      episodeId: 1,
      versionNo: 1,
      timelineJson: JSON.stringify(timeline),
      createdAt: 'now',
      updatedAt: 'now',
    })
    .run().lastInsertRowid,
)
const run = async (id: number) => {
  for (let i = 0; i < 100; i++) {
    await grid.tickGridCandidates()
    const c = grid.listGridCandidates(versionId).find((x) => x.id === id)!
    if (['ready', 'failed', 'adopted'].includes(c.status)) return c
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timeout')
}
test('joint generation submits once, reads never enqueue, and adopts locally without review', async () => {
  const payload = {
    revision: 1,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'generate' as const,
    resolution: '1K' as const,
  }
  const a = await grid.startGridCandidates(versionId, payload),
    b = await grid.startGridCandidates(versionId, payload)
  assert.equal(a.items[0].id, b.items[0].id)
  const done = await run(a.items[0].id)
  // 整组生成免审核：完成后服务端直接切分写入画面
  assert.equal(done.status, 'adopted', done.error || '')
  assert.equal(calls, 1)
  assert.ok(imagesSent >= 1)
  for (let i = 0; i < 10; i++) grid.listGridCandidates(versionId)
  assert.equal(calls, 1)
  const adopted = getVersion(versionId)
  assert.equal(adopted.revision, 2)
  assert.ok(adopted.timeline.panels[0].frames.every((f) => f.url))
  assert.equal(calls, 1)
  // 宫格生成要进任务面板：sys_task 必须带上分镜与剧集归属，完成后可展示原始宫格图
  const task = db
    .select()
    .from(schema.sysTask)
    .where(eq(schema.sysTask.previsItemKey, `grid-${a.items[0].id}`))
    .get()!
  assert.equal(task.storyboardId, 1)
  assert.equal(task.dramaId, 1)
  assert.ok(task.localPath, '完成任务保留返回的原始宫格图')
})
test('grid edit targets alone get replaced; frame edit after it uses latest source; stale candidate rejected atomically', async () => {
  const first = getVersion(versionId),
    original = structuredClone(first.timeline.panels[0].frames)
  const a = await grid.startGridCandidates(versionId, {
    revision: first.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'grid_edit',
    resolution: '1K',
    targetFrameIds: ['f1', 'f3'],
    instructions: { f1: 'lift hand', f3: 'change expression' },
  })
  const duplicate = await grid.startGridCandidates(versionId, {
    revision: first.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'grid_edit',
    resolution: '1K',
    targetFrameIds: ['f3', 'f1'],
    instructions: { f1: 'lift hand', f3: 'change expression' },
  })
  assert.equal(duplicate.items[0].id, a.items[0].id)
  const ready = await run(a.items[0].id)
  assert.equal(ready.status, 'ready', ready.error || '')
  const edited = await grid.adoptGridCandidate(versionId, ready.id, first.revision)
  for (const i of [0, 2]) assert.deepEqual(edited.timeline.panels[0].frames[i], original[i])
  for (const i of [1, 3]) assert.notEqual(edited.timeline.panels[0].frames[i].url, original[i].url)
  const b = await grid.startGridCandidates(versionId, {
    revision: edited.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'frame_edit',
    resolution: '1K',
    targetFrameIds: ['f0'],
    instructions: { f0: 'smile' },
  })
  const fine = await run(b.items[0].id)
  assert.equal(fine.status, 'ready', fine.error || '')
  const changed = structuredClone(edited.timeline)
  // 候选失效只看画面规划结构（帧 id 及顺序）：重新拆分/规划会换 id；改 prompt 等内容不影响采用
  changed.panels[0].frames[2].id = 'f2-replanned'
  saveTimeline(versionId, edited.revision, changed)
  await assert.rejects(grid.adoptGridCandidate(versionId, fine.id, edited.revision + 1), /结构已变化/)
  assert.equal(getVersion(versionId).timeline.panels[0].frames[0].url, original[0].url)
  assert.equal(calls, 3)
})
test('all-panel preflight failure does not create any task, frame lock blocks adopt', async () => {
  const current = getVersion(versionId),
    before = db.select().from(schema.sysTask).all().length
  await assert.rejects(
    grid.startGridCandidates(versionId, {
      revision: current.revision,
      panelIds: [1, 999],
      configId,
      model: 'gpt-image-2',
      mode: 'generate',
      resolution: '1K',
    }),
    /分镜/,
  )
  assert.equal(db.select().from(schema.sysTask).all().length, before)
  const a = await grid.startGridCandidates(versionId, {
    revision: current.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'frame_edit',
    resolution: '1K',
    targetFrameIds: ['f0'],
    instructions: { f0: 'smile' },
  })
  const ready = await run(a.items[0].id)
  const t = structuredClone(current.timeline)
  t.panels[0].frames[0].locked = true
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(t) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  await assert.rejects(grid.adoptGridCandidate(versionId, ready.id, current.revision), /锁定|变化/)
})
test('cancelling a queued candidate prevents submission; upload replaces every tile without review', async () => {
  const current = getVersion(versionId),
    t = structuredClone(current.timeline)
  t.panels[0].frames[0].locked = false
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(t) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const before = calls
  const pending = await grid.startGridCandidates(versionId, {
    revision: current.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'generate',
    resolution: '1K',
  })
  grid.discardGridCandidate(versionId, pending.items[0].id)
  await grid.tickGridCandidates()
  assert.equal(calls, before)
  // 上传替换与生成一致：就绪即自动切分，不经过人工采用
  const upload = await grid.uploadGridCandidate(versionId, current.revision, 1, '/static/asset.png')
  assert.equal(upload.status, 'adopted', upload.error || '')
  const uploaded = getVersion(versionId)
  assert.equal(uploaded.revision, current.revision + 1)
  assert.ok(uploaded.timeline.panels[0].frames.every((f) => f.url))
  const edit = await grid.startGridCandidates(versionId, {
    revision: uploaded.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'grid_edit',
    resolution: '1K',
    targetFrameIds: ['f1'],
    instruction: 'smile',
  })
  const ready = await run(edit.items[0].id)
  assert.equal(ready.status, 'ready', ready.error || '')
  assert.equal(ready.adoptFrameIds.length, 1)
  assert.equal(calls, before + 1)
  const adopted = await grid.adoptGridCandidate(versionId, ready.id, uploaded.revision)
  assert.equal(adopted.timeline.panels[0].frames.length, 4)
  assert.equal(adopted.timeline.panels[0].frames[0].source?.mode, 'generate')
  assert.equal(adopted.timeline.panels[0].frames[0].source?.candidateId, upload.id)
  assert.equal(adopted.timeline.panels[0].frames[1].source?.mode, 'grid_edit')
  assert.ok(adopted.timeline.panels[0].frames[1].history?.some((h) => h.source?.candidateId === upload.id))
  assert.equal(calls, before + 1)
})
test('single refinement adopted before whole-grid edit remains in the next frozen canvas, and local history restore is free', async () => {
  const v = getVersion(versionId)
  const single = await grid.startGridCandidates(versionId, {
    revision: v.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'frame_edit',
    resolution: '1K',
    targetFrameIds: ['f0'],
    instruction: 'smile',
  })
  const ready = await run(single.items[0].id),
    fine = await grid.adoptGridCandidate(versionId, ready.id, v.revision)
  const fineUrl = fine.timeline.panels[0].frames[0].url
  const whole = await grid.startGridCandidates(versionId, {
    revision: fine.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'grid_edit',
    resolution: '1K',
    targetFrameIds: ['f1'],
    instruction: 'raise arm',
  })
  const record = db
    .select()
    .from(schema.gridCandidates)
    .where(eq(schema.gridCandidates.id, whole.items[0].id))
    .get()!
  assert.equal(JSON.parse(record.snapshotJson).currentSources[0].sourceUrl, fineUrl)
  const next = await grid.adoptGridCandidate(versionId, (await run(whole.items[0].id)).id, fine.revision)
  assert.equal(next.timeline.panels[0].frames[0].url, fineUrl)
  const before = calls,
    restored = structuredClone(next.timeline)
  // Metadata source synchronization is outside this fixture; restore under a historical editable version.
  db.insert(schema.animaticVersions)
    .values({
      episodeId: 1,
      versionNo: 2,
      timelineJson: JSON.stringify(next.timeline),
      createdAt: 'now',
      updatedAt: 'now',
    })
    .run()
  restored.panels[0].frames[0].url = v.timeline.panels[0].frames[0].url
  const result = saveTimeline(versionId, next.revision, restored)
  assert.equal(
    result.timeline.panels[0].frames[0].source?.candidateId,
    v.timeline.panels[0].frames[0].source?.candidateId,
  )
  assert.equal(calls, before)
})

test('strict transport retains eight references including equal bytes, refuses corruption and unreadable input', async () => {
  const { normalizeFrozenImageReferences } = await import('../src/services/generation.js')
  const { freezeReferenceMedia } = await import('../src/services/previs-reference-media.js')
  const frozen = await freezeReferenceMedia('/static/asset.png')
  const refs = await normalizeFrozenImageReferences(Array(8).fill(frozen))
  assert.equal(refs.length, 8)
  assert.equal(Buffer.from(refs[0].split(',')[1], 'base64').equals(image), true)
  await assert.rejects(normalizeFrozenImageReferences([{ ...frozen, digest: 'a'.repeat(64) }]), /变化/)
  await assert.rejects(
    normalizeFrozenImageReferences([{ url: '/static/missing.png', digest: frozen.digest }]),
    /ENOENT/,
  )
})
test('partially populated legacy panel can refine its ready frame and an unlocked-only save works', async () => {
  const current = getVersion(versionId),
    t = structuredClone(current.timeline)
  t.panels[0].frames[0].locked = true
  t.panels[0].frames[2].url = ''
  t.panels[0].frames[3].url = '/static/unreadable.png'
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(t) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const unlocking = structuredClone(t)
  unlocking.panels[0].frames[0].locked = false
  const unlocked = saveTimeline(versionId, current.revision, unlocking)
  assert.equal(unlocked.timeline.panels[0].frames[0].locked, false)
  const created = await grid.startGridCandidates(versionId, {
    revision: unlocked.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'frame_edit',
    resolution: '1K',
    targetFrameIds: ['f0'],
    instruction: 'smile',
  })
  assert.equal((await run(created.items[0].id)).status, 'ready')
})
test('invalid geometry retains the returned image and retries processing without a new paid call', async () => {
  const v = getVersion(versionId),
    created = await grid.startGridCandidates(versionId, {
      revision: v.revision,
      panelIds: [1],
      configId,
      model: 'gpt-image-2',
      mode: 'frame_edit',
      resolution: '1K',
      targetFrameIds: ['f0'],
      instruction: 'smile',
    })
  await run(created.items[0].id)
  const c = db
    .select()
    .from(schema.gridCandidates)
    .where(eq(schema.gridCandidates.id, created.items[0].id))
    .get()!
  const square = await sharp({
    create: { width: 200, height: 200, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer()
  writeFileSync(path.join(root, 'static', 'wrong.png'), square)
  db.update(schema.gridCandidates)
    .set({ status: 'processing', rawUrl: null, previewUrl: null })
    .where(eq(schema.gridCandidates.id, c.id))
    .run()
  db.update(schema.sysTask)
    .set({ localPath: '/static/wrong.png', status: 'completed' })
    .where(eq(schema.sysTask.id, c.taskId!))
    .run()
  await grid.tickGridCandidates()
  const failed = grid.listGridCandidates(versionId).find((x) => x.id === c.id)!
  assert.equal(failed.status, 'failed')
  assert.ok(failed.rawUrl)
  assert.match(failed.error || '', /比例/)
  const before = calls
  // Simulate completed provider response with failed first download; local retry uses its persisted pointer.
  db.update(schema.sysTask)
    .set({ localPath: null, resultUrl: '/static/asset.png', status: 'failed' })
    .where(eq(schema.sysTask.id, c.taskId!))
    .run()
  const repaired = await grid.retryGridProcessing(versionId, c.id)
  assert.equal(repaired.status, 'ready')
  assert.equal(calls, before)
})
test('missing mandatory identity refuses every image mode before enqueue, including a panel with other references', async () => {
  const v = getVersion(versionId),
    t = structuredClone(v.timeline)
  t.panels[0].characterIds = [999]
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(t) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const before = db.select().from(schema.gridCandidates).all().length
  for (const mode of ['generate', 'frame_edit'] as const)
    await assert.rejects(
      grid.startGridCandidates(versionId, {
        revision: v.revision,
        panelIds: [1],
        configId,
        model: 'gpt-image-2',
        mode,
        resolution: '1K',
        targetFrameIds: ['f0'],
        instruction: 'smile',
      }),
      /人物.*参考图片/,
    )
  assert.equal(db.select().from(schema.gridCandidates).all().length, before)
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(v.timeline) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
})
test('regeneration freezes existing source bytes and automatic adoption refuses in-place replacement', async () => {
  const v = getVersion(versionId),
    t = structuredClone(v.timeline)
  t.panels[0].frames.forEach((f) => {
    f.url = '/static/asset.png'
    f.locked = false
  })
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(t) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const a = await grid.startGridCandidates(versionId, {
    revision: v.revision,
    panelIds: [1],
    configId,
    model: 'gpt-image-2',
    mode: 'generate',
    resolution: '1K',
  })
  // 冻结之后替换原图字节：完成即采用必须拒绝，并保留候选供人工处理
  writeFileSync(
    path.join(root, 'static', 'asset.png'),
    await sharp({
      create: { width: 640, height: 360, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer(),
  )
  const blocked = await run(a.items[0].id)
  assert.equal(blocked.status, 'ready', blocked.error || '')
  assert.match(blocked.error || '', /文件已变化/)
  assert.equal(getVersion(versionId).revision, v.revision, '采用失败不应推进版本')
  writeFileSync(path.join(root, 'static', 'asset.png'), image)
  const adopted = await grid.adoptGridCandidate(versionId, blocked.id, getVersion(versionId).revision)
  assert.ok(adopted.timeline.panels[0].frames.every((f) => f.url && f.url !== '/static/asset.png'))
})
test('restart resumes a known synchronous result without a supplier id or a new model call', async () => {
  const { recoverPrevisTasks } = await import('../src/services/generation.js')
  const row = db
    .select()
    .from(schema.sysTask)
    .all()
    .find((t) => t.previsItemKey?.startsWith('grid-'))!
  db.update(schema.sysTask)
    .set({
      status: 'processing',
      localPath: null,
      resultUrl: `data:image/png;base64,${image.toString('base64')}`,
      taskId: null,
    })
    .where(eq(schema.sysTask.id, row.id))
    .run()
  const before = calls
  // A restart preserves both the business result and the queue reservation.
  db.$client.prepare("UPDATE task_queue_jobs SET status='processing',phase='saving',submitted=1,upstream_done=1 WHERE owner_type='sys_task' AND owner_id=?").run(row.id)
  await recoverPrevisTasks()
  const { recoverTaskQueue } = await import('../src/services/task-queue.js')
  await recoverTaskQueue()
  for (let i = 0; i < 200 && db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.id)).get()!.status !== 'completed'; i++)
    await new Promise(resolve => setTimeout(resolve, 5))
  const recovered = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.id)).get()!
  assert.equal(recovered.status, 'completed')
  assert.ok(recovered.localPath)
  assert.equal(calls, before)
})

test('legacy nullable task ids round-trip and locked frames cannot be deleted', () => {
  const v = getVersion(versionId),
    timeline: any = structuredClone(v.timeline)
  timeline.panels[0].frames[0].taskId = null
  timeline.panels[0].frames[0].history[0].taskId = null
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(timeline) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const normalized = getVersion(versionId)
  assert.equal(normalized.timeline.panels[0].frames[0].taskId, undefined)
  assert.equal(normalized.timeline.panels[0].frames[0].history![0].taskId, undefined)
  assert.doesNotThrow(() => saveTimeline(versionId, normalized.revision, normalized.timeline))
  const current = getVersion(versionId),
    locked = structuredClone(current.timeline)
  locked.panels[0].frames[0].locked = true
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(locked) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const deleted = structuredClone(locked)
  deleted.panels[0].frames.shift()
  assert.throws(() => saveTimeline(versionId, current.revision, deleted), /锁定/)
  assert.equal(getVersion(versionId).timeline.panels[0].frames.length, locked.panels[0].frames.length)
})

test('switching back to an earlier candidate stays adoptable after a later adoption rewrote frame urls', async () => {
  // 复现 2026-10-13 事故：采用候选 B 后帧 url/history 被改写，旧「整面板哈希」校验让候选 A 永久失配
  // （切换候选即 409「原图或画面规划已变化」）。新校验只比帧 id 结构，同结构候选可随时来回切换。
  const unlock = getVersion(versionId),
    unlocked = structuredClone(unlock.timeline)
  for (const f of unlocked.panels[0].frames) f.locked = false
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(unlocked) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const current = getVersion(versionId)
  const payload = { revision: current.revision, panelIds: [1], configId, model: 'gpt-image-2', mode: 'generate' as const, resolution: '1K' as const }
  const a = await grid.startGridCandidates(versionId, payload)
  assert.equal((await run(a.items[0].id)).status, 'adopted')
  const b = await grid.startGridCandidates(versionId, { ...payload, revision: getVersion(versionId).revision })
  assert.equal((await run(b.items[0].id)).status, 'adopted')
  // B 采用后 A 回退为 ready；此时画面 url 已是 B 的切格，A 的快照面板还是生成时的旧内容
  const beforeSwitch = getVersion(versionId)
  const back = await grid.adoptGridCandidate(versionId, a.items[0].id, beforeSwitch.revision)
  assert.equal(back.revision, beforeSwitch.revision + 1)
  const listed = grid.listGridCandidates(versionId)
  assert.equal(listed.find((c) => c.id === a.items[0].id)!.status, 'adopted')
  assert.equal(listed.find((c) => c.id === b.items[0].id)!.status, 'ready')
  assert.ok(back.timeline.panels[0].frames.every((f) => f.url))
})

test('candidates are grouped into batches: each generation opens a new one, refinement and upload follow their anchor', async () => {
  const current = getVersion(versionId)
  // 上一测试末尾锁定了画面，先解锁（上传/生成都要求未锁定）
  const unlocked = structuredClone(current.timeline)
  for (const f of unlocked.panels[0].frames) f.locked = false
  db.update(schema.animaticVersions)
    .set({ timelineJson: JSON.stringify(unlocked) })
    .where(eq(schema.animaticVersions.id, versionId))
    .run()
  const payload = { revision: current.revision, panelIds: [1], configId, model: 'gpt-image-2', mode: 'generate' as const, resolution: '1K' as const }
  const first = await grid.startGridCandidates(versionId, payload)
  const firstBatch = (await run(first.items[0].id)).batchNo
  assert.ok(firstBatch >= 1, `首批应有正式批次号，实际 ${firstBatch}`)
  const second = await grid.startGridCandidates(versionId, { ...payload, revision: getVersion(versionId).revision })
  const secondBatch = (await run(second.items[0].id)).batchNo
  assert.equal(secondBatch, firstBatch + 1, '再次整组生成应开新批')
  // 无基准的 frame_edit 跟随当前采用结果（第二批）
  const refine = await grid.startGridCandidates(versionId, {
    revision: getVersion(versionId).revision, panelIds: [1], configId, model: 'gpt-image-2',
    mode: 'frame_edit', resolution: '1K', targetFrameIds: ['f0'], instruction: 'smile',
  })
  assert.equal((await run(refine.items[0].id)).batchNo, secondBatch)
  // 上传替换 = 新的整组生成，开新批
  const upload = await grid.uploadGridCandidate(versionId, getVersion(versionId).revision, 1, '/static/asset.png')
  assert.equal(upload.batchNo, secondBatch + 1)
})
