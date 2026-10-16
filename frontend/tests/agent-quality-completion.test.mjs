import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { parse } from '@vue/compiler-sfc'
const file = new URL('../app/composables/useAgent.ts', import.meta.url)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function mount(data) {
  const module = { exports: {} }, events = []
  const deps = {
    'vue-sonner': { toast: Object.fromEntries(['success', 'warning', 'error'].map(name => [name, value => events.push({ name, value })])) },
    './useApi': { api: { post: async () => data } }, './useToast': { toastError: error => events.push({ name: 'error', value: error.message }) },
    './i18n': { i18n: { global: { t: key => key } } },
  }
  runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, ref: vue.ref, require: name => deps[name] })
  return { s: module.exports.useAgent(), events }
}
test('agent completion awaits refresh before notification and preserves returned quality data', async () => {
  const gate = deferred(), data = { quality: { status: 'passed' } }, h = mount(data)
  let callbackData
  const pending = h.s.run('storyboard', 'msg', 1, 2, async value => { callbackData = value; await gate.promise })
  await vue.nextTick(); assert.equal(h.s.running.value, true); assert.equal(h.events.length, 0)
  gate.resolve(); await pending
  assert.deepEqual(callbackData, data); assert.equal(h.events[0].name, 'success'); assert.equal(h.s.running.value, false)
})
test('breakdown with remaining quality issues warns instead of reporting unconditional success', async () => {
  const h = mount({ quality: { status: 'needs_attention', issueCount: 3 } })
  await h.s.run('storyboard', 'msg', 1, 2)
  assert.equal(h.events.length, 1); assert.equal(h.events[0].name, 'warning'); assert.match(h.events[0].value, /3.*查看评测/)
})
test('refresh failure is reported before any success notification', async () => {
  const h = mount({})
  await h.s.run('storyboard', 'msg', 1, 2, async () => { throw new Error('刷新失败') })
  assert.deepEqual(h.events, [{ name: 'error', value: '刷新失败' }])
})

test('breakdown completion waits for missing prompt batch final quality before refreshing evaluation', async () => {
  const source = parse(readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
  const ast = ts.createSourceFile('episode.ts', source, ts.ScriptTarget.Latest, true)
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['onBreakdownDone', 'batchVideoPrompts', 'pollVideoPromptBatch'].includes(node.name?.text)).map(node => `export ${node.getText(ast)}`).join('\n')
  const gate = deferred(), calls = [], module = { exports: {} }, data = { quality: { status: 'awaiting_prompts' } }
  let targetIds
  runInNewContext(ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Promise, setTimeout: fn => { queueMicrotask(fn); return 1 },
    videoPromptBatch: vue.ref({ running: false }), videoPromptBatchPolling: undefined,
    epId: vue.ref(2), sbs: vue.ref([{ id: 7, video_prompt: '' }]), videoSelectMode: vue.ref(true), selectedVideoSbIds: vue.ref([8]),
    chatModelOverride: () => 'mock', chatConfigId: () => 1, t: key => key,
    episodeAPI: { generateVideoPrompts: async (...args) => { targetIds = args[3]; return { total: 1 } }, videoPromptsStatus: async () => { await gate.promise; return { status: 'done', quality: { status: 'needs_attention', issueCount: 2 } } } },
    toast: { info() {}, success() {} }, toastError: error => assert.fail(error), refresh: async () => calls.push('refresh'),
    continuityPanel: vue.ref({ refresh: async () => calls.push('evaluation') }),
  })
  const pending = module.exports.onBreakdownDone(data)
  await vue.nextTick(); assert.deepEqual(calls, ['refresh'])
  gate.resolve(); await pending
  assert.deepEqual(calls, ['refresh', 'refresh', 'evaluation']); assert.equal(data.quality.status, 'needs_attention')
  assert.equal(targetIds, undefined, 'Automatic supplementation covers all missing prompts even if a manual selection is active')
})
