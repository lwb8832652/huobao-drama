import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame, type Panel } from '../src/services/previs-domain.js'

const root = mkdtempSync(path.join(tmpdir(), 'continuity-review-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
// 测试只能走注入的 reviewer；意外外部请求立即失败。
globalThis.fetch = async () => { throw new Error('测试禁止调用外部模型') }
const { db, schema } = await import('../src/db/index.js')
const service = await import('../src/services/continuity-review.js')
const ts = new Date().toISOString()
db.insert(schema.dramas).values({ id: 1, title: '测试', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: '测试', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.aiServiceConfigs).values({ name: '仅供 mock', serviceType: 'text', provider: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'test', model: JSON.stringify(['mock']), isActive: true, createdAt: ts, updatedAt: ts }).run()
let versionNo = 0
function version() {
  const panels: Panel[] = [1, 2, 3].map(id => ({ id, title: '', description: '', atmosphere: '', imagePrompt: '', videoPrompt: '', durationMs: 4000, sceneId: null, scene: '', shotType: '', angle: '', movement: '', characterIds: [], propIds: [], referenceImages: [], videoUrl: '', frames: [{ ...makeFrame(`${id}`), url: `/static/${id}.png` }] }))
  return Number(db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: ++versionNo, timelineJson: JSON.stringify({ schemaVersion: 2, panels, groups: panels.map(p => ({ id: `g${p.id}`, title: '', note: '', panelIds: [p.id], entry: {}, exit: {} })), transitions: [1, 2].map(id => ({ from: `g${id}`, to: `g${id + 1}`, type: 'cut', continuity: 'normal', allowedChanges: [] })), audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
}
function mutate(id: number, change: (timeline: any) => void) {
  const row = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, id)).get()!
  const timeline = JSON.parse(row.timelineJson); change(timeline)
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline), revision: row.revision + 1 }).where(eq(schema.animaticVersions.id, id)).run()
}
const result = { overallScore: 60, confidence: 'high' as const, summary: '测试评分', dimensions: Object.fromEntries(['subject', 'scene', 'action', 'camera'].map(key => [key, { score: 15, comment: '测试' }])) as any, issues: [], suggestions: [] }

test('默认关闭、持久设置、两侧有图和 hash 去重，后台并发一且不重绘', async () => {
  assert.deepEqual(service.getContinuityReviewSettings(), { enabled: false, threshold: 70 })
  const id = version()
  service.scheduleContinuityReviews(id)
  assert.equal(service.readContinuityReviewStatus(id).items[0].status, 'idle')
  service.updateContinuityReviewSettings({ enabled: true, threshold: 70 })
  assert.deepEqual(service.getContinuityReviewSettings(), { enabled: true, threshold: 70 })
  assert.throws(() => service.updateContinuityReviewSettings({ enabled: true, threshold: 101 }))
  service.scheduleContinuityReviews(id, [2]); service.scheduleContinuityReviews(id, [2])
  assert.equal(service.readContinuityReviewStatus(id).items.length, 2)
  assert.equal(db.select().from(schema.continuityReviews).all().length, 2)
  let calls = 0, running = 0, max = 0
  const mock: service.ContinuityReviewer = async () => {
    calls++; running++; max = Math.max(max, running)
    mutate(id, t => { t.audio = [] })
    await Promise.resolve(); running--; return result
  }
  await Promise.all([service.tickContinuityReviews(mock), service.tickContinuityReviews(mock)])
  assert.equal(calls, 2); assert.equal(max, 1)
  assert.ok(service.readContinuityReviewStatus(id).items.every(item => item.status === 'completed' && item.lowScore))
  service.scheduleContinuityReviews(id); await service.tickContinuityReviews(mock); assert.equal(calls, 2)
  assert.equal(db.select().from(schema.sysTask).all().length, 0)
  const missing = version(); mutate(missing, t => { t.panels[1].frames[0].url = '' })
  service.scheduleContinuityReviews(missing)
  assert.ok(service.readContinuityReviewStatus(missing).items.every(item => item.status === 'missing_images'))
})

test('两侧画面可用性独立于旧任务执行状态，缺图的完成或失败记录仍明确标记不可用', async () => {
  for (const state of ['completed', 'failed'] as const) {
    const id = version(); mutate(id, t => { t.panels[1].frames[0].url = '' })
    await service.reviewContinuity(id, { revision: 2, toGroupId: 'g2', configId: 1, model: 'mock' }, async () => result)
    if (state === 'failed') db.update(schema.continuityReviews).set({ status: 'failed', error: 'mock 失败' }).where(eq(schema.continuityReviews.versionId, id)).run()
    const item = service.readContinuityReviewStatus(id).items[0]
    assert.equal(item.status, state); assert.equal(item.hasImages, false)
  }
  const id = version()
  assert.ok(service.readContinuityReviewStatus(id).items.every(item => item.hasImages))
})

test('过期输入不调用模型，执行期间输入变动不发布，失败不自动重试', async () => {
  const id = version(); service.scheduleContinuityReviews(id, [1])
  mutate(id, t => { t.panels[0].frames[0].url = '/static/new.png' })
  let calls = 0
  await service.tickContinuityReviews(async () => { calls++; return result })
  assert.equal(calls, 0)
  service.scheduleContinuityReviews(id, [1])
  await service.tickContinuityReviews(async () => { calls++; mutate(id, t => { t.panels[0].frames[0].url = '/static/newer.png' }); return result })
  assert.equal(calls, 1)
  assert.equal(service.listContinuityReviews(id).length, 0)
  assert.equal(service.listContinuityReviewTasks(id).items[0].result?.overallScore, 60)
  assert.equal(service.listContinuityReviewTasks(id).lowScore, 0)
  const failed = version(); service.scheduleContinuityReviews(failed, [1])
  await service.tickContinuityReviews(async () => { calls++; throw new Error('mock 失败') })
  assert.equal(service.readContinuityReviewStatus(failed).items[0].status, 'failed')
  service.scheduleContinuityReviews(failed, [1]); await service.tickContinuityReviews(async () => { calls++; return result })
  assert.equal(calls, 2)
})

test('手动请求与自动任务复用在途调用，模型异常后只允许显式重试', async () => {
  const id = version(); service.scheduleContinuityReviews(id, [1])
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const mock = async () => { calls++; entered(); await gate; return result }
  const worker = service.tickContinuityReviews(mock)
  await started
  assert.equal(service.readContinuityReviewStatus(id).items[0].status, 'processing')
  const manual = service.reviewContinuity(id, { revision: 1, toGroupId: 'g2', force: true }, mock)
  release(); await Promise.all([worker, manual])
  assert.equal(calls, 1)
  const failed = version(); service.scheduleContinuityReviews(failed, [1])
  await service.tickContinuityReviews(async () => { throw new Error('mock 失败') })
  await service.reviewContinuity(failed, { revision: 1, toGroupId: 'g2' }, async () => result)
  assert.equal(service.readContinuityReviewStatus(failed).items[0].status, 'completed')
})

test('模型输出字段缺失/类型漂移时容错归一化，而不是整条评测失败', async () => {
  service.updateContinuityReviewSettings({ enabled: true, threshold: 70 })
  const id = version()
  service.scheduleContinuityReviews(id, [1])
  // 复现线上失败：qwen 偶发省略 dimension.comment、把 score 返回成字符串、漏给 summary/confidence
  const sloppy = {
    overallScore: '60', confidence: undefined,
    summary: undefined,
    dimensions: {
      subject: { score: '15', comment: '人物衔接' },
      scene: { score: 15 },               // 缺 comment
      action: { score: '15', comment: '动作连贯' },
      camera: { score: 15, comment: '机位平稳' },
    },
    issues: [null, '穿帮一处', ''],        // 混入 null 与空串
    suggestions: null,                     // 缺数组
  } as any
  await service.tickContinuityReviews(async () => sloppy)
  const item = service.listContinuityReviewTasks(id).items[0]
  assert.equal(item.status, 'completed')
  assert.equal(item.result?.overallScore, 60)          // 四项之和重算，忽略模型给的字符串 60
  assert.equal(item.result?.summary, '未提供摘要')      // 缺 summary 回退默认
  assert.equal(item.result?.confidence, 'low')          // 非法 confidence 回退 low
  assert.equal(item.result?.dimensions.scene.comment, '未说明') // 缺 comment 回退默认
  assert.equal(item.result?.dimensions.subject.score, 15)
  assert.deepEqual(item.result?.issues, ['穿帮一处'])    // 过滤 null/空串
  assert.deepEqual(item.result?.suggestions, [])         // null 回退空数组
})

test('任务历史保留过期快照，分页不影响全局计数，移除边界后告警失效', async () => {
  service.updateContinuityReviewSettings({ enabled: true, threshold: 70 })
  const id = version()
  mutate(id, t => { t.panels[0].title = '旧镜头'; t.panels[1].title = '接续镜头' })
  service.scheduleContinuityReviews(id)
  const queued = service.listContinuityReviewTasks(id, { pageSize: 1 })
  assert.equal(queued.type, 'continuity'); assert.equal(queued.total, 2)
  assert.equal(queued.activeCount, 2); assert.equal(queued.items.length, 1)
  await service.tickContinuityReviews(async () => result)
  const completed = service.listContinuityReviewTasks(id)
  assert.equal(completed.lowScore, 2); assert.equal(completed.activeCount, 0)
  assert.ok(completed.items.every(item => item.current && item.startedAt && item.finishedAt))
  mutate(id, t => { t.panels[0].frames[0].url = '/static/replaced.png'; t.panels[0].title = '新镜头' })
  service.scheduleContinuityReviews(id, [1])
  const history = service.listContinuityReviewTasks(id, { page: 2, pageSize: 1 })
  assert.equal(history.total, 3); assert.equal(history.activeCount, 1); assert.equal(history.lowScore, 1)
  const old = service.listContinuityReviewTasks(id).items.find(item => item.fromGroupId === 'g1' && !item.current)!
  assert.equal(old.fromGroupTitle, '旧镜头'); assert.equal(old.toGroupTitle, '接续镜头')
  assert.equal(old.images.from, '/static/1.png'); assert.equal(old.result?.overallScore, 60)
  mutate(id, t => { t.panels = []; t.groups = []; t.transitions = [] })
  assert.equal(service.listContinuityReviewTasks(id).lowScore, 0)
  assert.ok(service.listContinuityReviewTasks(id).items.every(item => !item.current))
  await service.tickContinuityReviews(async () => { assert.fail('过期任务不能调用模型') })
  assert.equal(service.listContinuityReviewTasks(id).activeCount, 0)
  assert.ok(service.listContinuityReviewTasks(id).items.find(item => item.status === 'failed')?.finishedAt)
  const { default: app } = await import('../src/routes/previs.js')
  const response = await app.request(`/animatic-versions/${id}/continuity-review-tasks?page=2&pageSize=1`)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json() as any).data, service.listContinuityReviewTasks(id, { page: 2, pageSize: 1 }))
  for (const query of ['page=0', 'page=NaN', 'pageSize=101', 'pageSize=1.5']) {
    assert.equal((await app.request(`/animatic-versions/${id}/continuity-review-tasks?${query}`)).status, 400)
  }
  assert.equal(service.listContinuityReviewTasks(id, { page: 100 }).items.length, 0)
})

test('任务筛选参数默认兼容并校验状态和关键词长度', () => {
  assert.deepEqual(service.continuityReviewTaskPageSchema.parse({}), {
    page: 1, pageSize: 20, status: 'all', keyword: '',
  })
  assert.deepEqual(service.continuityReviewTaskPageSchema.parse({ status: 'active', keyword: '  模型  ' }), {
    page: 1, pageSize: 20, status: 'active', keyword: '模型',
  })
  assert.throws(() => service.continuityReviewTaskPageSchema.parse({ status: 'pending' }))
  assert.throws(() => service.continuityReviewTaskPageSchema.parse({ keyword: 'a'.repeat(201) }))
})

test('任务先筛选再分页，状态统计覆盖版本全部任务且保留原告警语义', t => {
  service.updateContinuityReviewSettings({ enabled: true, threshold: 70 })
  const id = version()
  t.after(() => { db.update(schema.continuityReviews).set({ status: 'failed' }).where(eq(schema.continuityReviews.versionId, id)).run() })
  service.scheduleContinuityReviews(id)
  const current = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, id)).all()
  db.update(schema.continuityReviews).set({ status: 'completed', model: 'current-model', resultJson: JSON.stringify(result) })
    .where(eq(schema.continuityReviews.id, current[0].id)).run()
  db.update(schema.continuityReviews).set({ status: 'processing', model: 'processing-model' })
    .where(eq(schema.continuityReviews.id, current[1].id)).run()
  const history = [
    { status: 'pending', fromTitle: 'Needle One', toTitle: '旧接续镜头', model: 'queue-model' },
    { status: 'completed', fromTitle: '旧镜头', toTitle: 'Needle Two', model: 'snapshot-model' },
    { status: 'failed', fromTitle: '旧镜头', toTitle: '旧接续镜头', model: 'NEEDLE-model' },
    { status: 'completed', fromTitle: 'Needle Four', toTitle: '旧接续镜头', model: 'historical-model' },
    { status: 'failed', fromTitle: '其他镜头', toTitle: '其他接续镜头', model: 'other-model' },
  ].map((record, index) => {
    const input = JSON.parse(current[0].inputJson!)
    input.from.group.title = record.fromTitle; input.to.group.title = record.toTitle
    return Number(db.insert(schema.continuityReviews).values({
      versionId: id, fromGroupId: 'g1', toGroupId: 'g2', inputHash: `history-${index}`,
      configId: 1, model: record.model, status: record.status,
      resultJson: record.status === 'completed' ? JSON.stringify(result) : '',
      inputJson: JSON.stringify(input), createdAt: ts,
    }).run().lastInsertRowid)
  })
  const otherVersion = version()
  db.insert(schema.continuityReviews).values({
    versionId: otherVersion, fromGroupId: 'g1', toGroupId: 'g2', inputHash: 'other-version',
    configId: 1, model: 'NEEDLE-model', status: 'failed', resultJson: '', createdAt: ts,
  }).run()
  const summary = { total: 7, active: 2, pending: 1, processing: 1, completed: 3, failed: 2 }
  const all = service.listContinuityReviewTasks(id)
  assert.equal(all.total, 7); assert.deepEqual(all.summary, summary)
  assert.equal(all.activeCount, 2); assert.equal(all.lowScore, 1)
  assert.ok(all.items.every(item => item.type === 'continuity'))

  const first = service.listContinuityReviewTasks(id, { keyword: '  nEeDlE  ', pageSize: 2 })
  const second = service.listContinuityReviewTasks(id, { keyword: 'needle', page: 2, pageSize: 2 })
  assert.equal(first.total, 4); assert.equal(second.total, 4)
  assert.deepEqual(first.items.map(item => item.id), [history[3], history[2]])
  assert.deepEqual(second.items.map(item => item.id), [history[1], history[0]])
  assert.deepEqual(first.summary, summary); assert.deepEqual(second.summary, summary)
  assert.equal(first.activeCount, 2); assert.equal(first.lowScore, 1)
  for (const [status, expected] of [['active', ['pending', 'processing']], ['completed', ['completed']], ['failed', ['failed']]] as const) {
    const page = service.listContinuityReviewTasks(id, { status })
    assert.equal(page.total, status === 'completed' ? 3 : 2)
    assert.ok(page.items.every(item => (expected as readonly string[]).includes(item.status)))
    assert.deepEqual(page.summary, summary)
  }
  const combined = service.listContinuityReviewTasks(id, { status: 'completed', keyword: 'needle', page: 2, pageSize: 1 })
  assert.equal(combined.total, 2); assert.deepEqual(combined.items.map(item => item.id), [history[1]])
  assert.deepEqual(combined.summary, summary)
  const empty = service.listContinuityReviewTasks(id, { keyword: 'missing', page: 100 })
  assert.equal(empty.total, 0); assert.equal(empty.items.length, 0); assert.deepEqual(empty.summary, summary)
  assert.deepEqual(service.listContinuityReviewTasks(id, { keyword: '  ' }).items, all.items)
  assert.deepEqual(service.listContinuityReviewTasks(id, { keyword: String(history[2]) }).items.map(item => item.id), [history[2]])
})

test('HTTP 任务筛选搜索冻结名称和模型，改名后仍可查询旧任务并拒绝非法参数', async t => {
  service.updateContinuityReviewSettings({ enabled: true, threshold: 70 })
  const id = version()
  t.after(() => { db.update(schema.continuityReviews).set({ status: 'failed' }).where(eq(schema.continuityReviews.versionId, id)).run() })
  mutate(id, t => { t.panels[0].title = 'Frozen Opening'; t.panels[1].title = 'Frozen Ending' })
  service.scheduleContinuityReviews(id, [1])
  const old = service.listContinuityReviewTasks(id).items[0]
  db.update(schema.continuityReviews).set({ status: 'completed', model: 'ArchiveModel', resultJson: JSON.stringify(result) })
    .where(eq(schema.continuityReviews.id, old.id)).run()
  mutate(id, t => { t.panels[0].title = 'Current Opening'; t.panels[1].title = 'Current Ending' })
  service.scheduleContinuityReviews(id, [1])
  const { default: app } = await import('../src/routes/previs.js')
  for (const keyword of ['  frozen opening  ', 'FROZEN ENDING', 'archivemodel', String(old.id)]) {
    const query = new URLSearchParams({ status: 'completed', keyword, pageSize: '1' })
    const response = await app.request(`/animatic-versions/${id}/continuity-review-tasks?${query}`)
    assert.equal(response.status, 200)
    const page = (await response.json() as any).data
    assert.equal(page.total, 1); assert.equal(page.items[0].id, old.id)
    assert.equal(page.items[0].current, false)
    assert.equal(page.items[0].fromGroupTitle, 'Frozen Opening')
    assert.deepEqual(page.summary, { total: 2, active: 1, pending: 1, processing: 0, completed: 1, failed: 0 })
  }
  const renamed = service.listContinuityReviewTasks(id, { keyword: 'current' })
  assert.equal(renamed.total, 1); assert.equal(renamed.items[0].status, 'pending')
  for (const query of ['status=pending', 'status=unknown', `keyword=${'a'.repeat(201)}`]) {
    const response = await app.request(`/animatic-versions/${id}/continuity-review-tasks?${query}`)
    assert.equal(response.status, 400)
  }
})

test('任务详情独立读取超过百条历史外的冻结任务，跨版本隔离且查询不执行评测', async t => {
  service.updateContinuityReviewSettings({ enabled: true, threshold: 70 })
  const id = version()
  t.after(() => { db.update(schema.continuityReviews).set({ status: 'failed' }).where(eq(schema.continuityReviews.versionId, id)).run() })
  mutate(id, timeline => { timeline.panels[0].title = '冻结起始镜头'; timeline.panels[1].title = '冻结接续镜头' })
  service.scheduleContinuityReviews(id, [1])
  const oldRow = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, id)).get()!
  db.update(schema.continuityReviews).set({
    status: 'completed', model: 'frozen-model', configId: 1, resultJson: JSON.stringify(result),
    startedAt: ts, finishedAt: ts,
  }).where(eq(schema.continuityReviews.id, oldRow.id)).run()
  const frozen = service.listContinuityReviewTasks(id).items[0]
  mutate(id, timeline => { timeline.panels[0].title = '最新镜头'; timeline.panels[0].frames[0].url = '/static/latest.png' })
  db.insert(schema.continuityReviews).values(Array.from({ length: 101 }, (_, index) => ({
    versionId: id, fromGroupId: 'g1', toGroupId: 'g2', inputHash: `detail-history-${index}`,
    configId: 1, model: 'later-model', status: 'failed', resultJson: '', inputJson: oldRow.inputJson,
    error: '后续评测失败', createdAt: ts,
  }))).run()
  const page = service.listContinuityReviewTasks(id, { pageSize: 100 })
  assert.equal(page.total, 102)
  assert.ok(page.items.every(item => item.id !== frozen.id))
  const expected = { ...frozen, current: false }
  const before = db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, id)).all()
  const { default: app } = await import('../src/routes/previs.js')
  const response = await app.request(`/animatic-versions/${id}/continuity-review-tasks/${frozen.id}`)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json() as any).data, expected)
  assert.deepEqual(service.getContinuityReviewTask(id, frozen.id), expected)
  assert.deepEqual(db.select().from(schema.continuityReviews).where(eq(schema.continuityReviews.versionId, id)).all(), before)

  const otherVersion = version()
  for (const [versionId, taskId] of [[otherVersion, frozen.id], [id, 999_999]]) {
    const missing = await app.request(`/animatic-versions/${versionId}/continuity-review-tasks/${taskId}`)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json() as any).code, 404)
  }
  for (const taskId of ['0', '-1', 'NaN', '1.5']) {
    assert.equal((await app.request(`/animatic-versions/${id}/continuity-review-tasks/${taskId}`)).status, 400)
  }
  assert.equal((await app.request(`/animatic-versions/0/continuity-review-tasks/${frozen.id}`)).status, 400)
  mutate(id, timeline => { timeline.panels = []; timeline.groups = []; timeline.transitions = [] })
  const deletedEdge = await app.request(`/animatic-versions/${id}/continuity-review-tasks/${frozen.id}`)
  assert.equal(deletedEdge.status, 200)
  assert.deepEqual((await deletedEdge.json() as any).data, expected)
})

test('评测 Agent 出现在配置列表并复用 prompt、skill、语言和模型覆盖链', async () => {
  const { agentRegistry, validAgentTypes, DEFAULT_PROMPTS } = await import('../src/agents/index.js')
  const { skillsManagerWorkspace } = await import('../src/agents/skills.js')
  const { buildAgentRequestContext } = await import('../src/agents/context.js')
  const { default: prompts } = await import('../src/routes/prompts.js')
  assert.ok(validAgentTypes.includes('continuity-reviewer'))
  const list = (await (await prompts.request('/')).json() as any).data
  assert.ok(list.some((item: any) => item.agent_type === 'continuity-reviewer'))
  const defaults = (await (await prompts.request('/continuity-reviewer')).json() as any).data
  assert.equal(defaults.system_prompt, DEFAULT_PROMPTS['continuity-reviewer'].instructions)
  const saved = await prompts.request('/continuity-reviewer', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_prompt: '测试基础提示词', model: 'prompt-model' }) })
  assert.equal(saved.status, 200)
  await skillsManagerWorkspace.filesystem!.writeFile('skills/continuity-reviewer/SKILL.md', '---\nname: continuity-reviewer\ndescription: 测试技能\n---\n\n测试审核技能', { recursive: true })
  const rc = buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: 1, language: 'zh' })
  const agent = agentRegistry['continuity-reviewer']
  const instructions = String(await agent.getInstructions({ requestContext: rc }))
  assert.ok(instructions.includes('测试基础提示词')); assert.ok(instructions.includes('测试审核技能'))
  assert.equal((await agent.getModel({ requestContext: rc }) as any).modelId, 'prompt-model')
  rc.set('modelOverride', 'request-model')
  assert.equal((await agent.getModel({ requestContext: rc }) as any).modelId, 'request-model')
  const id = version()
  await service.reviewContinuity(id, { revision: 1, toGroupId: 'g2' }, async (_input, options) => {
    assert.equal(options.model, 'prompt-model'); return result
  })
  assert.equal(service.listContinuityReviewTasks(id).items[0].model, 'prompt-model')
  const reset = await prompts.request('/continuity-reviewer/reset', { method: 'POST' })
  assert.equal(reset.status, 200)
  await skillsManagerWorkspace.filesystem!.deleteFile('skills/continuity-reviewer/SKILL.md')
  assert.equal((await agent.getModel({ requestContext: buildAgentRequestContext({ episodeId: 1, dramaId: 1, textConfigId: 1 }) }) as any).modelId, 'mock')
})

test('旧任务表幂等迁移增加快照和时间，保留原有记录', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { initPrevisSchema } = await import('../src/db/previs-schema.js')
  const legacy = new Database(':memory:')
  legacy.exec(`CREATE TABLE sys_task (id INTEGER PRIMARY KEY);
    CREATE TABLE continuity_reviews (id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL,
      from_group_id TEXT NOT NULL, to_group_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      config_id INTEGER NOT NULL, model TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO continuity_reviews VALUES (1, 1, 'a', 'b', 'old', 1, 'mock', '{}', 'old-time');`)
  initPrevisSchema(legacy); initPrevisSchema(legacy)
  const row = legacy.prepare('SELECT * FROM continuity_reviews').get() as any
  assert.equal(row.input_hash, 'old'); assert.equal(row.status, 'completed')
  assert.equal(row.input_json, null); assert.equal(row.started_at, null); assert.equal(row.finished_at, null)
  legacy.close()
})

test('旧记录缺少快照仍可读取，不将当前镜头冒充历史图片', () => {
  const id = version()
  db.insert(schema.continuityReviews).values({ versionId: id, fromGroupId: 'deleted', toGroupId: 'g2', inputHash: 'legacy', configId: 0, model: '', status: 'failed', resultJson: 'invalid', error: '旧错误', createdAt: ts }).run()
  const item = service.listContinuityReviewTasks(id).items[0]
  assert.equal(item.current, false); assert.equal(item.result, null)
  assert.equal(item.error, '旧错误'); assert.equal(item.fromGroupTitle, null)
  assert.deepEqual(item.images, { from: null, to: null })
})

test('关闭开关取消排队任务，重新启用后可重新安排，HTTP 设置和状态契约可读写', async () => {
  const id = version(); service.scheduleContinuityReviews(id, [1])
  service.updateContinuityReviewSettings({ enabled: false, threshold: 50 })
  let calls = 0
  await service.tickContinuityReviews(async () => { calls++; return result }); assert.equal(calls, 0)
  const { default: app } = await import('../src/routes/previs.js')
  const updated = await app.request('/previs/continuity-review-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, threshold: 50 }) })
  assert.equal(updated.status, 200)
  service.scheduleContinuityReviews(id, [1])
  await service.tickContinuityReviews(async () => { calls++; return result }); assert.equal(calls, 1)
  const response = await app.request(`/animatic-versions/${id}/continuity-review-status`)
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.data.items[0].status, 'completed'); assert.equal(body.data.items[0].lowScore, false)
})
