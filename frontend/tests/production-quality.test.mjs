import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

const file = new URL('../app/composables/useProductionQuality.ts', import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const report = () => ({ overallScore: null, confidence: 'high', summary: '需检查对白', dimensions: {}, issues: [{ id: 'dialogue:7', panelIds: [7], severity: 'fail', message: '对白不足', suggestion: '保留原文' }] })
const task = (patch = {}) => ({ id: 3, type: 'planning', versionId: 4, kind: 'rules', round: 0, status: 'completed', current: true, inputHash: 'hash-2', result: report(), ...patch })
function mount(options = {}) {
  assert.ok(existsSync(file), 'A browser-safe planning quality controller is required')
  const calls = [], unmounts = [], events = []
  const version = vue.ref({ id: 4, revision: 2, status: 'draft', isCurrent: true, timeline: { panels: [{ id: 7, description: '原描述' }] } })
  const dirty = vue.ref(false), locked = vue.ref(false), module = { exports: {} }
  const status = () => ({ inputHash: 'hash-2', rules: report(), task: task(), latest: task() })
  const request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body: body && plain(body) })
    return options.request ? options.request(path, method, body) : method === 'GET' ? status() : path.endsWith('/check') ? { task: task() } : task({ id: 5, kind: 'optimization' })
  }
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Error, JSON, Set,
    require: name => name === 'vue' ? { ...vue, onUnmounted: fn => unmounts.push(fn) } : name === './usePrevis' ? { previsRequest: request } : assert.fail(`Unexpected runtime dependency: ${name}`),
  })
  const scope = vue.effectScope()
  const s = scope.run(() => module.exports.useProductionQuality({
    version: () => version.value, dirty: () => dirty.value, busy: () => locked.value,
    save: options.save || (async () => true), model: () => ({ configId: 2, model: 'mock' }),
    applied: options.applied || (async value => { events.push(value) }),
  }))
  return { s, calls, version, dirty, locked, events, unmount() { unmounts.forEach(fn => fn()); scope.stop() } }
}
const flush = async () => { for (let i = 0; i < 8; i++) await vue.nextTick() }

test('opening and refreshing quality only reads free status; check uses the saved revision and ai:false', async () => {
  let h
  h = mount({ save: async () => { h.version.value.revision = 3; return true } }); await flush()
  assert.ok(h.calls.length > 0); assert.ok(h.calls.every(call => call.method === 'GET'))
  await h.s.check()
  const post = h.calls.find(call => call.method === 'POST')
  assert.equal(post.path, '/animatic-versions/4/production-quality/check')
  assert.deepEqual(post.body, { revision: 3, ai: false }); h.unmount()
})

test('manual review waits for save and blocks duplicate submission', async () => {
  const gate = deferred(), h = mount({ save: () => gate.promise }); await flush()
  const first = h.s.review(); const second = h.s.review()
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0)
  gate.resolve(true); await Promise.all([first, second])
  assert.deepEqual(h.calls.filter(call => call.method === 'POST').map(call => call.body), [{ revision: 2, configId: 2, model: 'mock' }]); h.unmount()
})

test('targeted optimization validates current report, selected issue IDs and round limit', async () => {
  const h = mount(); await flush()
  for (const item of [task({ current: false }), task({ round: 2 }), task({ id: 99 }), task({ status: 'processing' })]) {
    await h.s.optimize(item, ['dialogue:7'])
  }
  await h.s.optimize(task(), ['missing']); await h.s.optimize(task(), [])
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0)
  const candidate = await h.s.optimize(task(), ['dialogue:7'])
  assert.equal(candidate.kind, 'optimization')
  assert.deepEqual(h.calls.find(call => call.method === 'POST').body, { inputHash: 'hash-2', issueIds: ['dialogue:7'], configId: 2, model: 'mock' }); h.unmount()
})

test('apply requires explicit confirmation and rejects stale hash, dirty edits, lock and repeated apply', async () => {
  const candidate = task({ id: 8, kind: 'optimization', result: { summary: '候选', edits: [], preview: { proposals: [{ segments: [{}], error: null }] } } })
  const h = mount(); await flush()
  await h.s.apply(candidate)
  await h.s.apply({ ...candidate, inputHash: 'old' }, true)
  h.dirty.value = true; await h.s.apply(candidate, true); h.dirty.value = false
  h.locked.value = true; await h.s.apply(candidate, true); h.locked.value = false
  await h.s.apply({ ...candidate, appliedVersionId: 6 }, true)
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0); h.unmount()
})

test('apply awaits workspace adoption and sends only the reviewed input hash', async () => {
  const adopted = { id: 6, revision: 1, timeline: { panels: [] } }
  const h = mount({ request: (path, method) => path.endsWith('/apply') ? adopted : { inputHash: 'hash-2', rules: report(), task: task(), latest: task() } }); await flush()
  const candidate = task({ id: 8, kind: 'optimization', result: { summary: '候选', edits: [], preview: { proposals: [{ segments: [{}], error: null }] } } })
  await h.s.apply(candidate, true)
  assert.deepEqual(h.calls.find(call => call.method === 'POST'), { path: '/animatic-versions/4/production-quality/tasks/8/apply', method: 'POST', body: { inputHash: 'hash-2' } })
  assert.deepEqual(h.events, [adopted]); h.unmount()
})

test('version switches and local timeline edits ignore late read and write responses', async () => {
  const gate = deferred(), h = mount({ request: path => path.includes('/4/') ? gate.promise : { inputHash: 'new', rules: report(), task: task({ versionId: 9 }), latest: null } })
  h.version.value = { ...h.version.value, id: 9 }; await flush()
  gate.resolve({ inputHash: 'old', rules: report(), task: task(), latest: task() }); await flush()
  assert.equal(h.s.state.value?.inputHash, 'new')
  h.unmount()
  const applyGate = deferred()
  const q = mount({ request: path => path.endsWith('/apply') ? applyGate.promise : { inputHash: 'hash-2', rules: report(), task: task(), latest: task() } }); await flush()
  const candidate = task({ id: 8, kind: 'optimization', result: { preview: { proposals: [{ segments: [{}] }] } } })
  const pending = q.s.apply(candidate, true)
  q.version.value.timeline.panels[0].description = '新修改'
  applyGate.resolve({ id: 6, revision: 1, timeline: { panels: [] } }); await pending
  assert.equal(q.events.length, 0); assert.equal(q.s.busy.value, false); q.unmount()
})
test('failed workspace adoption does not report a candidate as applied', async () => {
  const h = mount({ request: path => path.endsWith('/apply') ? { id: 6, revision: 1, timeline: { panels: [] } } : { inputHash: 'hash-2', rules: report(), task: task(), latest: task() }, applied: async () => false }); await flush()
  const candidate = task({ id: 8, kind: 'optimization', result: { preview: { proposals: [{ segments: [{}] }] } } })
  assert.equal(await h.s.apply(candidate, true), false)
  assert.match(h.s.error.value, /加载.*新工作版/); h.unmount()
})
