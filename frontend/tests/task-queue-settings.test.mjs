import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
function evaluate(path, deps = {}) {
  if (!existsSync(new URL(path, import.meta.url))) return {}
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: name => { assert.ok(name in deps, name); return deps[name] }, setTimeout, clearTimeout, Number, Error, TypeError, URLSearchParams, performance, console: { log() {}, warn() {} } })
  return module.exports
}
const queue = evaluate('../app/composables/useTaskQueue.ts')
const stats = { active: 3, pending: 4, byKind: { image: { active: 2, pending: 3 }, video: { active: 1, pending: 1 }, evaluation: { active: 0, pending: 0 }, planning: { active: 0, pending: 0 }, local: { active: 0, pending: 0 } } }
const settings = { revision: 1, total: 6, image: 2, video: 2, planning: 1, local: 1, paused: false, quotaGroups: [{ id: 'account', name: '共享账号', limit: 2, configIds: [1, 3] }], stats }
function createStore() {
  const calls = []; let remote = structuredClone(settings), conflict = false
  const api = { get: async path => { calls.push({ path, method: 'GET' }); return structuredClone(remote) }, put: async (path, body) => { calls.push({ path, method: 'PUT', body: structuredClone(body) }); if (conflict) throw Object.assign(new Error('设置已更新'), { status: 409 }); remote = { ...body, revision: remote.revision + 1, stats }; return structuredClone(remote) } }
  const implementation = evaluate('../app/composables/useTaskQueueSettings.ts', { vue, './useApi': { api }, './useTaskQueue': queue })
  assert.equal(typeof implementation.useTaskQueueSettings, 'function', 'production settings store is implemented')
  return { store: implementation.useTaskQueueSettings(api), calls, update: value => { remote = value }, conflict: value => { conflict = value } }
}
test('production saves only its editable fields and revision without evaluation fields or statistics', async () => {
  const { store, calls } = createStore(); await store.load()
  store.draft.value.total = 4; store.draft.value.paused = true; await store.save()
  const put = calls.find(call => call.method === 'PUT')
  assert.deepEqual(Object.keys(put.body).sort(), ['image', 'local', 'paused', 'planning', 'quotaGroups', 'revision', 'total', 'video'])
  assert.equal(put.path, '/settings/task-queue'); assert.equal(put.body.total, 4); assert.equal(put.body.paused, true); assert.equal(store.dirty.value, false)
})
test('global refresh updates statistics but preserves a dirty draft and its revision', async () => {
  const { store, update } = createStore(); await store.load(); store.draft.value.video = 3
  update({ ...settings, revision: 2, image: 4, stats: { ...stats, active: 4 } }); await store.refresh()
  assert.equal(store.draft.value.video, 3); assert.equal(store.draft.value.image, 2); assert.equal(store.saved.value.revision, 1); assert.equal(store.stats.value.active, 4)
})
test('409 retains production draft and explicit reload accepts newer global settings', async () => {
  const { store, conflict, update } = createStore(); await store.load(); store.draft.value.total = 3; conflict(true); await store.save()
  assert.equal(store.conflict.value, true); assert.equal(store.draft.value.total, 3); assert.equal(store.dirty.value, true)
  update({ ...settings, revision: 2, total: 5 }); await store.load()
  assert.equal(store.draft.value.total, 5); assert.equal(store.saved.value.revision, 2); assert.equal(store.conflict.value, false)
})
test('invalid integer limits and duplicate account memberships never PUT', async () => {
  const { store, calls } = createStore(); await store.load(); store.draft.value.image = 0; await store.save()
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0); assert.match(store.error.value, /1.*32/)
  store.draft.value.image = 2; store.draft.value.quotaGroups.push({ id: 'other', name: '另一账号', limit: 2, configIds: [3] }); await store.save()
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0); assert.match(store.error.value, /重复|多个/)
})
test('queue labels, filters and deletion guard preserve pending versus processing and cancellation', () => {
  assert.equal(typeof queue.queueStatusLabel, 'function')
  assert.equal(queue.queueStatusLabel({ status: 'pending' }), '排队中')
  assert.equal(queue.queueStatusLabel({ status: 'pending', phase: 'waiting_dependency' }), '等待前置任务')
  assert.equal(queue.queueStatusLabel({ status: 'processing', phase: 'needs_confirmation' }), '需核对提交状态')
  assert.equal(queue.queueStatusLabel({ status: 'processing', phase: 'saving' }), '保存结果中')
  assert.equal(queue.queueStatusLabel({ status: 'pending', phase: 'retry_wait' }), '限流后等待重试')
  const rows = [{ status: 'pending' }, { status: 'processing' }, { status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }]
  assert.equal(queue.filterQueueRows(rows, 'active').length, 2); assert.equal(queue.filterQueueRows(rows, 'all').length, 5)
  assert.equal(queue.canDeleteQueueRecord(rows[1]), false); assert.equal(queue.canDeleteQueueRecord(rows[4]), true)
})

test('native drawer filters toggle off without hiding cancelled rows; busy history cannot delete', () => {
  const source = read('../app/views/drama/episode.vue')
  assert.match(source, /filterQueueRows\(genTaskRows.value, genTaskFilter.value\)/)
  assert.match(source, /genTaskFilter.value = genTaskFilter.value === filter \? 'all' : filter/)
  assert.match(source, /if \(!canDeleteQueueRecord\(t\)\)/)
})

test('queue controls post the shared job identity and require explicit upstream confirmation before releasing slots', async () => {
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const path = '../app/components/QueueJobActions.vue'
  assert.ok(existsSync(new URL(path, import.meta.url)), 'queue actions component exists')
  const calls = [], unmounts = []
  const compiled = compileScript(parse(read(path)).descriptor, { id: 'actions' })
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: n => n === 'vue' ? { ...vue, onUnmounted: fn => unmounts.push(fn) } : { api: { post: async (...args) => calls.push(args) } } })
  const props = vue.reactive({ job: { queueJobId: 42, status: 'pending', canCancel: true, canRetry: false } })
  const events = [], scope = vue.effectScope()
  const s = scope.run(() => module.exports.default.setup(props, { emit: name => events.push(name), expose() {} }))
  await s.act('retry'); assert.equal(calls.length, 0)
  await s.act('cancel'); assert.equal(calls[0][0], '/task-queue/jobs/42/cancel'); assert.equal(events[0], 'changed')
  props.job = { queueJobId: 42, status: 'processing', phase: 'needs_confirmation' }
  await s.act('reconcile'); assert.equal(calls.length, 1)
  s.confirmedStopped.value = true; await s.act('reconcile')
  assert.equal(calls[1][0], '/task-queue/jobs/42/reconcile'); assert.equal(calls[1][1].confirmedStopped, true)
  unmounts.forEach(fn => fn()); scope.stop()
})

test('Escape in a native settings dialog does not close the underlying task drawer when save disables the focused button', () => {
  const source = read('../app/views/drama/episode.vue')
  const start = source.indexOf('function handleImageViewerKeydown('), end = source.indexOf('\n}',start)+2
  let closed = false
  const module = {exports:{}}
  runInNewContext(`${source.slice(start,end)}; module.exports = handleImageViewerKeydown`, {
    module, document: {querySelector:()=>({open:true})}, imageViewer:{value:{open:false}}, assetDetail:{value:{open:false}}, taskDrawer:{value:true}, closeTaskDrawer:()=>{closed=true},
  })
  module.exports({key:'Escape'}); assert.equal(closed,false)
})

function episodeFunctions(names, globals) {
  const source = read('../app/views/drama/episode.vue').match(/<script setup>([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile('episode.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text))
  assert.equal(functions.length, names.length)
  const module = { exports: {} }
  runInNewContext(`${functions.map(statement => statement.getText(ast)).join('\n')}\nmodule.exports = { ${names.join(',')} }`, { module, ...globals })
  return module.exports
}

test('episode refresh restores queued videos and clears cancelled latest video and asset busy states', async () => {
  const state = {
    epId: { value: 1 }, genTasks: { value: [] }, genMerges: { value: [] }, sbs: { value: [] },
    pendingVideoIds: { value: [1, 9] }, failedVideoMessages: { value: { 1: 'old failure', 9: 'local failure' } },
    pendingCharImageIds: { value: [10, 13] }, pendingSceneImageIds: { value: [11] }, pendingPropImageIds: { value: [12] },
    assetSubmittingKeys: { value: ['character:13'] }, hasVid: () => false, t: key => key,
  }
  const tasks = [
    { id: 1, type: 'video', storyboard_id: 1, status: 'processing' },
    { id: 2, type: 'video', storyboard_id: 1, status: 'cancelled' },
    { id: 3, type: 'video', storyboard_id: 2, status: 'pending' },
    { id: 4, type: 'video', storyboard_id: 3, status: 'processing' },
    { id: 5, type: 'video', storyboard_id: 4, status: 'failed', error_msg: 'provider failed' },
    { id: 6, type: 'image', character_id: 10, status: 'pending' },
    { id: 7, type: 'image', character_id: 10, status: 'cancelled' },
    { id: 8, type: 'image', scene_id: 11, status: 'failed' },
    { id: 9, type: 'image', prop_id: 12, status: 'processing' },
    { id: 10, type: 'image', character_id: 13, status: 'cancelled' },
  ]
  const handlers = episodeFunctions(['loadGenTasks'], { ...state, taskAPI: { listByEpisode: async () => ({ tasks, merges: [] }) } })
  await handlers.loadGenTasks()
  assert.deepEqual(Array.from(state.pendingVideoIds.value).sort(), [2, 3, 9])
  assert.equal(state.failedVideoMessages.value[1], undefined); assert.equal(state.failedVideoMessages.value[4], 'provider failed')
  assert.equal(state.failedVideoMessages.value[9], 'local failure')
  assert.deepEqual(Array.from(state.pendingCharImageIds.value), [13]); assert.deepEqual(Array.from(state.pendingSceneImageIds.value), [])
  assert.deepEqual(Array.from(state.pendingPropImageIds.value), [12])
})

test('cancelled asset polling stops after one task lookup and releases its busy state without success or failure', async () => {
  const pendingCharImageIds = { value: [10] }, notices = []; let lookups = 0, refreshes = 0, syncs = 0
  const handlers = episodeFunctions(['pollAssetGeneration', 'setAssetPending'], {
    pendingCharImageIds, pendingPropImageIds: { value: [] }, pendingSceneImageIds: { value: [] },
    sleep: async () => {}, taskAPI: { get: async id => { assert.equal(id, 42); lookups++; return { status: 'cancelled' } } },
    refresh: async () => { refreshes++ }, syncOpenAssetDetail: () => { syncs++ },
    toast: { success: value => notices.push(value), error: value => notices.push(value) }, mapError: value => value, t: key => key,
  })
  handlers.pollAssetGeneration('character', 10, 42)
  await new Promise(setImmediate)
  assert.equal(lookups, 1); assert.equal(refreshes, 1); assert.equal(syncs, 1)
  assert.deepEqual(Array.from(pendingCharImageIds.value), []); assert.deepEqual(notices, [])
})

test('cancelled video polling stops immediately and clears busy and old failure state without a completion toast', async () => {
  const pendingVideoIds = { value: [7, 8] }, failedVideoMessages = { value: { 7: 'old failure', 8: 'another failure' } }, notices = []
  let lookups = 0
  const handlers = episodeFunctions(['pollVideoGeneration'], {
    pendingVideoIds, failedVideoMessages, sleep: async () => {}, refresh: async () => {},
    taskAPI: { get: async id => { assert.equal(id, 42); lookups++; return { status: 'cancelled' } } },
    toast: { success: value => notices.push(value), error: value => notices.push(value) }, toastError: value => notices.push(value), t: key => key,
  })
  await handlers.pollVideoGeneration(42, 7)
  assert.equal(lookups, 1); assert.deepEqual(Array.from(pendingVideoIds.value), [8])
  assert.equal(failedVideoMessages.value[7], undefined); assert.equal(failedVideoMessages.value[8], 'another failure')
  assert.deepEqual(notices, [])
})

test('cancelled merge polling releases the interval and retains only the original queued submission notice', async () => {
  const mergeData = { value: null }, notices = []; let callback, cleared = 0
  const handlers = episodeFunctions(['doMerge'], {
    epId: { value: 1 }, mergeData,
    mergeAPI: { merge: async () => {}, status: async () => ({ status: 'cancelled' }) },
    setInterval: fn => { callback = fn; return 31 }, clearInterval: id => { assert.equal(id, 31); cleared++ },
    toast: { success: value => notices.push(value), error: value => notices.push(value) }, toastError: value => notices.push(value), t: key => key,
    loadExportMerges: () => { throw new Error('Cancelled merge cannot publish completed output') },
  })
  await handlers.doMerge([7]); await callback()
  assert.equal(cleared, 1); assert.equal(mergeData.value.status, 'cancelled')
  assert.deepEqual(notices, ['拼接任务已加入队列'])
})
