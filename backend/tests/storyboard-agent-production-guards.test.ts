import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { eq, sql } from 'drizzle-orm'

const root = mkdtempSync(path.join(tmpdir(), 'storyboard-guards-'))
process.env.SQLITE_PATH = ':memory:'
process.env.HUOBAO_DATA_DIR = root
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
globalThis.fetch = async () => { throw new Error('Tests must not call external models') }
const { db, schema } = await import('../src/db/index.js')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { mastra } = await import('../src/mastra/index.js')
const batch = await import('../src/services/video-prompts.js')
const ts = '2026-10-16T00:00:00.000Z'
let episodeNumber = 0
const line = '门外的雨停了，我们现在可以回家。'
const description = `【镜头1】小明站在门口。\n小明：「${line}」`
const prompt = `0-10秒：【镜头1】小明站在门口。\n小明：「${line}」`
const insert = (table: any, values: any) => Number(db.insert(table).values(values).run().lastInsertRowid)

function fixture() {
  const dramaId = insert(schema.dramas, { title: 'Guard test', createdAt: ts, updatedAt: ts })
  const episodeId = insert(schema.episodes, { dramaId, episodeNumber: ++episodeNumber, title: 'Guard test', scriptContent: description, createdAt: ts, updatedAt: ts })
  const storyboardId = insert(schema.storyboards, { episodeId, storyboardNumber: 1, title: '旧分镜', description, videoPrompt: prompt, duration: 10, createdAt: ts, updatedAt: ts })
  const characterId = insert(schema.characters, { dramaId, name: '小明', createdAt: ts, updatedAt: ts })
  const propId = insert(schema.props, { dramaId, name: '钥匙', createdAt: ts, updatedAt: ts })
  const sceneId = insert(schema.scenes, { dramaId, location: '门口', time: '夜', prompt: '木门与台阶', createdAt: ts, updatedAt: ts })
  db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
  db.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
  const rc = buildAgentRequestContext({ episodeId, dramaId, language: 'zh' })
  return { dramaId, episodeId, storyboardId, characterId, propId, sceneId, rc }
}
type Fixture = ReturnType<typeof fixture>
const row = (id: number) => db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
function snapshot() {
  return [schema.storyboards, schema.storyboardCharacters, schema.storyboardProps, schema.episodes, schema.episodeCharacters, schema.episodeScenes, schema.episodeProps]
    .map(table => db.select().from(table).all())
}
const execute = (tool: any, input: any, rc: any) => tool.execute(input, { requestContext: rc })
async function errorFrom(action: Promise<any>) {
  try { return String((await action)?.error || '') } catch (error: any) { return String(error.message) }
}
const save = (f: Fixture, storyboards: any[], replace_existing = true) => execute(storyboardTools.saveStoryboards, { storyboards, replace_existing }, f.rc)
const update = (f: Fixture, fields: any, rc = f.rc) => execute(storyboardTools.updateStoryboard, { storyboard_id: f.storyboardId, ...fields }, rc)

test('replacement validates every dialogue budget before changing rows or asset associations', async () => {
  const f = fixture(), before = snapshot()
  const error = await errorFrom(save(f, [
    { shot_number: 1, description, duration: 10, character_ids: [f.characterId], scene_id: f.sceneId },
    { shot_number: 2, description: `【镜头1】小明转身。\n小明：「${'我会完整说完这些话'.repeat(10)}」`, duration: 3 },
  ]))
  assert.match(error, /对白|时长|完整/)
  assert.deepEqual(snapshot(), before)
})

test('a bad binding in the last row leaves replaced storyboards and episode links intact', async () => {
  const f = fixture(), foreign = fixture(), before = snapshot()
  const error = await errorFrom(save(f, [
    { shot_number: 1, description, duration: 10, character_ids: [f.characterId], scene_id: f.sceneId },
    { shot_number: 2, description: '小明转身。', duration: 5, prop_ids: [foreign.propId] },
  ]))
  assert.match(error, /prop_id.*不属于/)
  assert.deepEqual(snapshot(), before)
})

test('database errors roll back deletion, earlier inserts and newly linked assets together', async () => {
  const f = fixture(), before = snapshot()
  db.run(sql`CREATE TEMP TRIGGER fail_guard_insert BEFORE INSERT ON storyboards
    WHEN NEW.title = 'Force failure' BEGIN SELECT RAISE(ABORT, 'forced insertion failure'); END`)
  try {
    const error = await errorFrom(save(f, [
      { shot_number: 1, description, duration: 10, scene_id: f.sceneId, character_ids: [f.characterId], prop_ids: [f.propId] },
      { shot_number: 2, title: 'Force failure', description: '小明扶着门框。', duration: 5 },
    ]))
    assert.match(error, /forced insertion failure/)
    assert.deepEqual(snapshot(), before)
  } finally { db.run(sql`DROP TRIGGER fail_guard_insert`) }
})

test('breakdown saves may omit video_prompt while complete dialogue still gets a duration check', async () => {
  const f = fixture()
  const result = await save(f, [{ shot_number: 1, title: '新分镜', description, duration: 10, scene_id: f.sceneId, character_ids: [f.characterId], prop_ids: [f.propId] }])
  assert.equal(result.error, undefined)
  const rows = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, f.episodeId)).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].description, description)
  assert.equal(rows[0].title, '新分镜')
  assert.equal(db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, f.episodeId)).all().length, 1)
})

test('append retries preserve storyboard IDs and compute duration from the whole live episode', async () => {
  const f = fixture()
  const rows = [
    { shot_number: 1, title: '重试已有分镜', description, duration: 10 },
    { shot_number: 2, title: '新分镜', description: '小明扶住木门。', duration: 6 },
  ]
  await save(f, rows, false)
  const first = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, f.episodeId)).all()
  const second = await save(f, rows, false)
  assert.deepEqual(db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, f.episodeId)).all().map(row => row.id), first.map(row => row.id))
  assert.equal(first[0].id, f.storyboardId)
  assert.equal(second.total_duration, 16)
  assert.equal(first.length, 2)
})

test('duplicate shot numbers are validated against earlier rows in the same batch', async () => {
  const f = fixture(), before = snapshot()
  const error = await errorFrom(save(f, [
    { shot_number: 2, description, duration: 10, video_prompt: prompt },
    { shot_number: 2, title: '同批重号的部分更新', duration: 1 },
  ]))
  assert.match(error, /对白|时长|时间/)
  assert.deepEqual(snapshot(), before)
})

test('provided video prompts must retain all dialogue and cover the duration before replacement', async () => {
  for (const video_prompt of ['0-10秒：小明站在门口。', `0-2秒：小明：「${line}」`, `2-10秒：小明：「${line}」`]) {
    const f = fixture(), before = snapshot()
    assert.match(await errorFrom(save(f, [{ shot_number: 1, description, duration: 10, video_prompt }])), /对白|时间|规划|发声/)
    assert.deepEqual(snapshot(), before)
  }
})

test('updates validate merged source, prompt and duration without changing any field on failure', async () => {
  for (const fields of [
    { video_prompt: '0-10秒：小明站在门口。' },
    { duration: 1 },
    { description: `${description}\n小明：「${'我会完整说完这些话'.repeat(10)}」` },
  ]) {
    const f = fixture(), before = snapshot()
    assert.match(await errorFrom(update(f, fields)), /对白|时间|时长|发声/)
    assert.deepEqual(snapshot(), before)
  }
  const f = fixture()
  assert.equal((await update(f, { video_prompt: prompt.replace('站在门口', '双手扶着门框') })).error, undefined)
  assert.match(row(f.storyboardId)?.videoPrompt || '', /双手扶着门框/)
})

test('unrelated metadata edits do not force legacy storyboards to generate a missing prompt', async () => {
  const f = fixture()
  db.update(schema.storyboards).set({ videoPrompt: '' }).where(eq(schema.storyboards.id, f.storyboardId)).run()
  assert.equal((await update(f, { title: '修正标题' })).error, undefined)
  assert.equal(row(f.storyboardId)?.title, '修正标题')
})

test('a missing stored duration cannot be treated as an invented default during a prompt update', async () => {
  const f = fixture()
  db.update(schema.storyboards).set({ duration: null }).where(eq(schema.storyboards.id, f.storyboardId)).run()
  const before = snapshot()
  assert.match(await errorFrom(update(f, { video_prompt: prompt })), /时长/)
  assert.deepEqual(snapshot(), before)
})

test('read, save and update reject an episode belonging to a different drama', async () => {
  const f = fixture(), foreign = fixture(), before = snapshot()
  const rc = buildAgentRequestContext({ episodeId: f.episodeId, dramaId: foreign.dramaId, language: 'zh' })
  for (const action of [
    () => execute(storyboardTools.readStoryboardContext, {}, rc),
    () => execute(storyboardTools.saveStoryboards, { replace_existing: true, storyboards: [] }, rc),
    () => update(f, { title: '错误项目' }, rc),
  ]) assert.match(await errorFrom(action()), /Episode|episode|当前项目|所属/)
  assert.deepEqual(snapshot(), before)
})

test('a storyboard cannot be updated from another episode or after soft deletion', async () => {
  const f = fixture(), other = fixture(), before = snapshot()
  assert.match(await errorFrom(update(f, { title: '跨集写入' }, other.rc)), /Storyboard|storyboard|当前集|所属/)
  assert.deepEqual(snapshot(), before)
  db.update(schema.storyboards).set({ deletedAt: ts }).where(eq(schema.storyboards.id, f.storyboardId)).run()
  assert.match(await errorFrom(update(f, { title: '已删除' })), /not found|不存在|已删除/)
  assert.equal(row(f.storyboardId)?.title, '旧分镜')
})

test('existing episode links cannot bypass asset project ownership and deletion checks', async () => {
  const f = fixture(), foreign = fixture()
  db.insert(schema.episodeProps).values({ episodeId: f.episodeId, propId: foreign.propId, createdAt: ts }).run()
  db.insert(schema.episodeCharacters).values({ episodeId: f.episodeId, characterId: f.characterId, createdAt: ts }).run()
  db.update(schema.characters).set({ deletedAt: ts }).where(eq(schema.characters.id, f.characterId)).run()
  for (const fields of [{ prop_ids: [foreign.propId] }, { character_ids: [f.characterId] }]) {
    const before = snapshot()
    assert.match(await errorFrom(update(f, fields)), /不属于当前项目/)
    assert.deepEqual(snapshot(), before)
  }
})

async function finished(episodeId: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = batch.getVideoPromptBatchStatus(episodeId)
    if (status && status.status !== 'running') return status
    await setImmediate()
  }
  throw new Error('Batch did not settle')
}

test('batch does not count an old prompt when the agent performs no save', async t => {
  const f = fixture()
  t.mock.method(mastra, 'getAgent', () => ({ generate: async () => ({ text: '时长不足，未保存。' }) }) as any)
  await batch.startVideoPromptBatch(f.episodeId, f.dramaId, {}, [f.storyboardId])
  const status = await finished(f.episodeId)
  assert.equal(status.completed, 0)
  assert.equal(status.failed, 1)
  assert.equal(row(f.storyboardId)?.videoPrompt, prompt)
})

test('batch rejects metadata-only writes and invalid prompts despite changed timestamps', async t => {
  for (const mode of ['title', 'invalid']) {
    const f = fixture()
    const mock = t.mock.method(mastra, 'getAgent', () => ({ generate: async (_messages: any, options: any) => {
      if (mode === 'title') return update(f, { title: '改标题' }, options.requestContext)
      db.update(schema.storyboards).set({ videoPrompt: '0-10秒：小明站在门口。', updatedAt: new Date().toISOString() }).where(eq(schema.storyboards.id, f.storyboardId)).run()
      return {}
    } }) as any)
    await batch.startVideoPromptBatch(f.episodeId, f.dramaId, {}, [f.storyboardId])
    const status = await finished(f.episodeId)
    assert.equal(status.completed, 0)
    assert.equal(status.failed, 1)
    mock.mock.restore()
  }
})

test('batch counts a valid prompt actually saved by the current agent request, including an identical regeneration', async t => {
  const f = fixture()
  t.mock.method(mastra, 'getAgent', () => ({ generate: async (_messages: any, options: any) => update(f, { video_prompt: prompt }, options.requestContext) }) as any)
  await batch.startVideoPromptBatch(f.episodeId, f.dramaId, {}, [f.storyboardId])
  const status = await finished(f.episodeId)
  assert.equal(status.completed, 1)
  assert.equal(status.failed, 0)
})

test('batch rejects mismatched episode ownership before obtaining an agent', async t => {
  const f = fixture(), foreign = fixture()
  let calls = 0
  t.mock.method(mastra, 'getAgent', () => { calls++; throw new Error('Must not request an agent') })
  await assert.rejects(batch.startVideoPromptBatch(f.episodeId, foreign.dramaId, {}, [f.storyboardId]), /Episode|episode|当前项目|所属/)
  assert.equal(calls, 0)
})

test('simultaneous batch starts for one episode only run one agent attempt', async t => {
  const f = fixture()
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(mastra, 'getAgent', () => ({ generate: async (_messages: any, options: any) => {
    calls++
    await gate
    return update(f, { video_prompt: prompt }, options.requestContext)
  } }) as any)
  const results = await Promise.all([
    batch.startVideoPromptBatch(f.episodeId, f.dramaId, {}, [f.storyboardId]),
    batch.startVideoPromptBatch(f.episodeId, f.dramaId, {}, [f.storyboardId]),
  ])
  release()
  await finished(f.episodeId)
  assert.equal(calls, 1)
  assert.equal(results.filter(result => result.started).length, 1)
  assert.equal(results.filter(result => result.total === -1).length, 1)
})
