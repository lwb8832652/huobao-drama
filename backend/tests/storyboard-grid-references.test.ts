import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame, type Panel } from '../src/services/previs-domain.js'

const root = mkdtempSync(path.join(tmpdir(), 'grid-references-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
mkdirSync(path.join(root, 'static'))
const bytes = await Promise.all(['red', 'green', 'blue', 'yellow', 'purple', 'orange'].map(background => sharp({ create: { width: 640, height: 360, channels: 3, background } }).png().toBuffer()))
const urls = bytes.map((buffer, index) => {
  writeFileSync(path.join(root, 'static', `${index}.png`), buffer)
  return `/static/${index}.png`
})
const submissions: { images: Buffer[]; prompt: string }[] = []
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(req.headers['content-type']) } }).formData()
  const images = await Promise.all((body.getAll('image[]') as File[]).map(async file => Buffer.from(await file.arrayBuffer())))
  submissions.push({ images, prompt: String(body.get('prompt')) })
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ b64_json: bytes[0].toString('base64') }] }))
}).listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
after(() => server.close())
const { db, schema } = await import('../src/db/index.js')
const grid = await import('../src/services/previs-grid.js')
const referenceApi = await import('../src/services/previs-grid-references.js').catch(() => null)
const routes = (await import('../src/routes/previs.js')).default
const ts = new Date().toISOString()
for (const id of [1, 2]) db.insert(schema.dramas).values({ id, title: `Drama ${id}`, createdAt: ts, updatedAt: ts }).run()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'Episode', createdAt: ts, updatedAt: ts }).run()
const sceneId = Number(db.insert(schema.scenes).values({ dramaId: 1, location: 'Kitchen', time: 'Day', prompt: 'Window at left', imageUrl: urls[0], createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const characterId = Number(db.insert(schema.characters).values({ dramaId: 1, name: 'Ming', styling: 'Red coat', imageUrl: urls[1], createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const propId = Number(db.insert(schema.props).values({ dramaId: 1, name: 'Cup', imageUrl: urls[2], createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const foreignId = Number(db.insert(schema.characters).values({ dramaId: 2, name: 'Foreign secret', imageUrl: urls[5], createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const deletedId = Number(db.insert(schema.characters).values({ dramaId: 1, name: 'Deleted', imageUrl: urls[5], deletedAt: ts, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const noImageId = Number(db.insert(schema.characters).values({ dramaId: 1, name: 'Unready', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const configId = Number(db.insert(schema.aiServiceConfigs).values({ name: 'Local test', serviceType: 'image', provider: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, apiKey: 'test', model: JSON.stringify(['gpt-image-2']), isActive: true, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
function panel(): Panel {
  return { id: 1, title: 'Passing cup', description: 'Ming gives the cup to Hong; the camera cuts to Hong holding it.', atmosphere: 'Daylight', imagePrompt: 'Red coat, white cup', videoPrompt: 'Ming reaches, Hong accepts', durationMs: 6000, sceneId, scene: 'Kitchen', shotType: 'medium', angle: 'eye', movement: 'fixed', characterIds: [characterId], propIds: [propId], referenceImages: [urls[3]], referenceLabels: ['Common layout'], videoUrl: '', frames: [{ ...makeFrame('end', 5999), prompt: 'Hong holds the cup', referenceImages: [urls[4]] }, { ...makeFrame('start', 0), prompt: 'Ming holds the cup', referenceImages: [] }] }
}
let versionNo = 0
function version(panels: Panel[]) {
  return Number(db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: ++versionNo, timelineJson: JSON.stringify({ schemaVersion: 2, panels, groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
}
function read(id: number, panelId = 1) {
  assert.equal(typeof referenceApi?.readGridReferences, 'function', 'shared readonly reference resolver must exist')
  return referenceApi!.readGridReferences(id, panelId)
}
const request = { revision: 1, panelIds: [1], mode: 'generate' as const, configId, model: 'gpt-image-2', resolution: '1K' as const }
async function run(id: number, candidateId: number) {
  for (let index = 0; index < 100; index++) {
    await grid.tickGridCandidates()
    const candidate = grid.listGridCandidates(id).find(item => item.id === candidateId)!
    if (['ready', 'adopted', 'failed'].includes(candidate.status)) return candidate
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Mock generation timeout')
}

test('readonly resolver orders bound assets, shared panel refs and all frame extras despite empty overrides', () => {
  const result = read(version([panel()]))
  assert.deepEqual(result.items.map(item => item.url), urls.slice(0, 5))
  assert.deepEqual(result.items.map(item => item.kind), ['scene', 'character', 'prop', 'custom', 'custom'])
  assert.deepEqual(result.items.map(item => item.required), [true, true, true, false, false])
  assert.equal(result.ready, true)
  assert.equal(result.error, '')
  assert.match(result.items[0].label, /Kitchen/)
  assert.equal(result.items[3].label, 'Common layout')
  assert.equal(submissions.length, 0)
  assert.equal(existsSync(path.join(root, 'static', 'previs-inputs')), false)
  assert.equal(db.select().from(schema.gridCandidates).all().length, 0)
})

test('only local static aliases deduplicate and duplicate labels merge without damaging remote/data URLs', () => {
  const p = panel()
  p.referenceImages = ['static/0.png', urls[3], 'https://assets.example/a//b.png?x=1', 'data:image/png;base64,YQ==']
  p.referenceLabels = ['Uploaded kitchen', 'Layout', 'Remote', 'Data']
  p.frames[0].referenceImages = [urls[0], 'https://assets.example/a/b.png?x=1', 'data:image/png;base64,Yg==']
  const result = read(version([p]))
  assert.deepEqual(result.items.map(item => item.url), [urls[0], urls[1], urls[2], urls[3], 'https://assets.example/a//b.png?x=1', 'data:image/png;base64,YQ==', 'https://assets.example/a/b.png?x=1', 'data:image/png;base64,Yg=='])
  assert.match(result.items[0].label, /Kitchen.*Uploaded kitchen/)
  assert.equal(result.items[0].required, true)
})

for (const [name, id, reason] of [['missing', 99999, /不存在/], ['foreign', foreignId, /当前作品/], ['deleted', deletedId, /删除/], ['unready', noImageId, /参考图片/]] as const) {
  test(`${name} mandatory binding remains visible with a null URL and blocks every paid mode`, async () => {
    const p = panel()
    p.characterIds = [id]
    p.frames.forEach(frame => { frame.url = urls[0] })
    const versionId = version([p])
    const result = read(versionId)
    assert.equal(result.items[1].url, null)
    assert.equal(result.items[1].required, true)
    assert.equal(result.ready, false)
    assert.match(result.error, reason)
    assert.doesNotMatch(result.error, /Foreign secret/)
    const before = db.select().from(schema.gridCandidates).all().length
    for (const mode of ['generate', 'grid_edit', 'frame_edit'] as const) await assert.rejects(grid.startGridCandidates(versionId, { ...request, mode, targetFrameIds: ['start'], instruction: 'Smile' }), /人物.*参考图片/)
    assert.equal(db.select().from(schema.gridCandidates).all().length, before)
    assert.equal(submissions.length, 0)
  })
}

test('API reads validate version and panel membership and return the same manifest without work', async () => {
  const id = version([panel()])
  const response = await routes.request(`/animatic-versions/${id}/grid-references?panel_id=1`)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json() as any).data, read(id))
  assert.equal((await routes.request(`/animatic-versions/${id}/grid-references?panel_id=999`)).status, 404)
  assert.equal((await routes.request('/animatic-versions/999999/grid-references?panel_id=1')).status, 404)
  assert.equal((await routes.request(`/animatic-versions/${id}/grid-references`)).status, 400)
  assert.equal(submissions.length, 0)
})

test('reference-free generate rejects before any partial candidate while legacy edit can use its original', async () => {
  const p = panel()
  p.sceneId = null; p.characterIds = []; p.propIds = []; p.referenceImages = []
  p.frames.forEach(frame => { frame.referenceImages = []; frame.url = urls[0] })
  const noRefs = version([p])
  const result = read(noRefs)
  assert.equal(result.ready, false)
  assert.match(result.error, /绑定.*上传.*参考/)
  const both = version([panel(), { ...p, id: 2 }])
  const before = db.select().from(schema.gridCandidates).all().length
  await assert.rejects(grid.startGridCandidates(both, { ...request, panelIds: [1, 2] }), /参考/)
  assert.equal(db.select().from(schema.gridCandidates).all().length, before)
  assert.equal(submissions.length, 0)
  const edit = await grid.startGridCandidates(noRefs, { ...request, mode: 'frame_edit', targetFrameIds: ['start'], instruction: 'Smile' })
  assert.ok(['ready', 'adopted'].includes((await run(noRefs, edit.items[0].id)).status))
})

test('cap preflight runs before freezing any reference and before creating candidates or paid tasks', async () => {
  const p = panel()
  p.referenceImages = Array.from({ length: 17 }, (_, index) => `/static/missing-${index}.png`)
  const before = db.select().from(schema.gridCandidates).all().length
  const tasksBefore = db.select().from(schema.sysTask).all().length
  await assert.rejects(grid.startGridCandidates(version([p]), request), /上限/)
  assert.equal(db.select().from(schema.gridCandidates).all().length, before)
  assert.equal(db.select().from(schema.sysTask).all().length, tasksBefore)
})

test('every panel binding is checked before freezing an earlier panel source', async () => {
  const first = panel(), second = { ...panel(), id: 2, characterIds: [99999] }
  first.referenceImages = ['/static/would-fail-during-freeze.png']
  const before = db.select().from(schema.gridCandidates).all().length
  await assert.rejects(grid.startGridCandidates(version([first, second]), { ...request, panelIds: [1, 2] }), /绑定资产不存在/)
  assert.equal(db.select().from(schema.gridCandidates).all().length, before)
})

test('actual multipart bytes match the deterministic reference legend and frozen candidate metadata', async () => {
  const id = version([panel()])
  const manifest = read(id)
  const created = await grid.startGridCandidates(id, request)
  const row = db.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, created.items[0].id)).get()!
  const s = JSON.parse(row.snapshotJson)
  assert.deepEqual(s.referenceAssets.map((item: any) => ({ url: item.sourceUrl, label: item.label, kind: item.kind, required: item.required })), manifest.items)
  assert.deepEqual(created.items[0].referenceAssets, s.referenceAssets)
  assert.equal(created.items[0].referenceAssets.length, 5)
  for (let index = 0; index < 5; index++) assert.ok(s.prompt.includes(`参考图片${index + 1}：${manifest.items[index].label}`))
  assert.match(s.prompt, /Ming gives the cup to Hong/)
  assert.match(s.prompt, /Hong holds the cup/)
  assert.match(s.prompt, /Ming holds the cup/)
  assert.doesNotMatch(JSON.stringify(created.items[0]), /apiKey|prompt|test-key/)
  // Replacing a source after submission cannot alter the candidate's actual reference preview or upload.
  writeFileSync(path.join(root, 'static', '0.png'), bytes[5])
  const before = submissions.length
  assert.equal((await run(id, created.items[0].id)).status, 'adopted')
  assert.equal(submissions.length, before + 1)
  assert.deepEqual(submissions.at(-1)!.images, bytes.slice(0, 5))
  assert.equal(submissions.at(-1)!.prompt.replace(/\r\n/g, '\n'), s.prompt)
  writeFileSync(path.join(root, 'static', '0.png'), bytes[0])
  const editPanel = panel()
  editPanel.frames[0].url = urls[5]
  editPanel.frames[1].url = urls[0]
  const editId = version([editPanel])
  const edit = await grid.startGridCandidates(editId, { ...request, mode: 'frame_edit', targetFrameIds: ['start'], instruction: 'Smile' })
  const editRow = db.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, edit.items[0].id)).get()!
  const editSnapshot = JSON.parse(editRow.snapshotJson)
  assert.equal(editSnapshot.referenceAssets.length, 5)
  assert.match(editSnapshot.prompt, /参考图片1是当前需要精修的唯一原图/)
  assert.match(editSnapshot.prompt, /参考图片2：场景/)
  assert.match(editSnapshot.prompt, /参考图片7为相邻画面/)
  assert.doesNotMatch(editSnapshot.prompt, /画格2（第1行/)
  assert.ok(['ready', 'adopted'].includes((await run(editId, edit.items[0].id)).status))
  assert.deepEqual(submissions.at(-1)!.images, [bytes[0], ...bytes.slice(0, 5), bytes[5]])
})

test('same scene appends LAST previous boundary after identity assets and freezes exact multipart order', async () => {
  const previous = { ...panel(), id: 90 }
  previous.frames[0].url = urls[5]; previous.frames[1].url = urls[0]
  const current = { ...panel(), id: 3 }
  const id = version([previous, current]), manifest = read(id, 3)
  assert.equal(manifest.continuity?.previous?.panelId, 90)
  assert.equal(manifest.continuity?.previous?.frameId, 'end')
  assert.equal(manifest.items.at(-1)?.kind, 'continuity')
  const result = await grid.startGridCandidates(id, { ...request, panelIds: [3] })
  const row = db.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, result.items[0].id)).get()!
  const saved = JSON.parse(row.snapshotJson)
  assert.equal(saved.continuity.previous.digest, saved.referenceAssets.at(-1).digest)
  assert.match(saved.prompt, /首.*静态状态/)
  assert.match(saved.prompt, /身份.*优先/)
  await run(id, result.items[0].id)
  assert.deepEqual(submissions.at(-1)!.images, [...bytes.slice(0, 5), bytes[5]])
  const timeline = JSON.parse(db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, id)).get()!.timelineJson)
  timeline.panels[0].frames[0].prompt = 'Changed ending'
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline) }).where(eq(schema.animaticVersions.id, id)).run()
  assert.equal(grid.listGridCandidates(id, 3)[0].continuityStale, true)
  assert.equal(read(id, 3).continuityStale, true)
})
test('last missing/reset never appends previous earlier available frame; editing later frames needs no cross-panel image', async () => {
  const previous = { ...panel(), id: 90 }; previous.frames[1].url = urls[5]
  const current = { ...panel(), id: 3 }; current.frames.forEach(f => { f.url = urls[0] })
  const id = version([previous, current])
  assert.equal(read(id, 3).continuity?.status, 'missing')
  assert.equal(read(id, 3).items.some(i => i.kind === 'continuity'), false)
  previous.frames[0].url = urls[5]
  const id2 = version([previous, current])
  const created = await grid.startGridCandidates(id2, { ...request, panelIds: [3], mode: 'frame_edit', targetFrameIds: ['end'], instruction: 'Smile' })
  const s = JSON.parse(db.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, created.items[0].id)).get()!.snapshotJson)
  assert.equal(s.referenceAssets.some((i: any) => i.kind === 'continuity'), false)
  await run(id2, created.items[0].id)
})
