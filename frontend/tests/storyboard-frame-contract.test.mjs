import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
function evaluate(source, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(source.replaceAll('import.meta.client', 'false'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(output, {
    module, exports: module.exports,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
    crypto: {}, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
  })
  return module.exports
}
const domain = evaluate(read('../../backend/src/services/previs-domain.ts'))
const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
const panel = (count = 0, beats = 1) => ({
  id: 7, title: '开门', description: Array.from({ length: beats }, (_, i) => `【镜头${i + 1}】动作${i + 1}。`).join(''),
  durationMs: 6000, frames: Array.from({ length: count }, (_, i) => ({ ...domain.makeFrame(`old-${i}`, i), url: `/static/${i}.png` })),
  atmosphere: '', referenceImages: [], imagePrompt: '',
})
const draft = count => ({
  taskId: 13, panelId: 7, panelTitle: '开门', count, source: 'ai',
  frames: Array.from({ length: count }, (_, i) => ({ title: `画面${i}`, prompt: `动作${i}`, offsetMs: i, type: 'beat' })),
})
function api(notices = [], globals = {}) {
  return evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted() {} },
    'vue-sonner': { toast: Object.fromEntries(['error', 'success', 'info'].map(kind => [kind, message => notices.push({ kind, message })])) },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, globals)
}
function editor(target) {
  const changes = [], notices = []
  const component = evaluate(compileScript(parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor, { id: 'frame-limit-editor' }).content, {
    vue, 'vue-sonner': { toast: Object.fromEntries(['error', 'success'].map(kind => [kind, message => notices.push({ kind, message })])) },
    'lucide-vue-next': {}, '~/components/AppMenu.vue': {}, '~/components/AppMenuItem.vue': {},
    './FrameSettingsDialog.vue': {}, './StoryboardContactSheet.vue': {}, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...api() },
  }).default
  const props = { panel: target, editable: true, generatable: true, tasks: [] }
  const setup = component.setup(props, { expose() {}, emit: (event, ...args) => changes.push({ event, args }) })
  return { setup, props, changes, notices }
}
function standalone(globals) {
  const ast = ts.createSourceFile('previs.vue.ts', parse(read('../app/views/drama/previs.vue')).descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && ['planAndGenerate', 'applyFramePlan'].includes(statement.name?.text))
    .map(statement => `export ${statement.getText(ast)}`).join('\n')
  return evaluate(functions, {}, { ...domain, ...api(), ...globals })
}

test('the frame count control offers every value from one through nine', () => {
  const descriptor = parse(read('../app/components/previs/FramePlanDialog.vue')).descriptor
  const script = compileScript(descriptor, { id: 'frame-count-control' })
  const component = evaluate(script.content, {
    vue: { ...vue, useId: () => 'count-test', onMounted() {}, onBeforeUnmount() {}, onUnmounted() {} },
    'lucide-vue-next': Object.fromEntries(['Loader2', 'Scissors', 'Sparkles', 'Trash2', 'X'].map(name => [name, 'svg'])), '~/composables/usePrevis': api(),
  }).default
  const props = { plans: [], count: 1, editable: true, busy: false }
  const setup = component.setup(props, { expose() {}, emit() {} })
  const template = compileTemplate({ source: descriptor.template.content, filename: 'FramePlanDialog.vue', id: 'frame-count-control', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const { render } = evaluate(template.code, { vue: { ...vue, withDirectives: vnode => vnode } })
  const values = []
  function visit(node) {
    if (node?.type === 'option') values.push(node.props.value)
    for (const child of Array.isArray(node?.children) ? node.children : []) visit(child)
  }
  visit(render({}, [], props, vue.proxyRefs(setup), {}, {}))
  assert.deepEqual(values, [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('manual add opens below nine and stays closed at or above nine', () => {
  for (const count of [0, 8, 9, 12]) {
    const h = editor(panel(count))
    h.setup.add({ currentTarget: {} })
    assert.equal(!!h.setup.settings.value, count < 9)
    assert.equal(h.changes.filter(change => change.event === 'settings-open').length, count < 9 ? 1 : 0)
  }
})

test('saving an already-open add dialog cannot create a tenth frame', async () => {
  const target = panel(8)
  const h = editor(target)
  h.setup.add({ currentTarget: {} })
  target.frames.push(domain.makeFrame('ninth'))
  await h.setup.saveSettings({ prompt: '新画面' }, false)
  assert.equal(h.changes.filter(change => change.event === 'change').length, 0)
  assert.equal(target.frames.length, 9)
  assert.equal(h.notices.at(-1)?.kind, 'error')
})

test('rule planning rejects ten final frames without truncating or losing existing images', () => {
  const target = panel(8, 10)
  const before = JSON.stringify(target.frames)
  const h = editor(target)
  h.setup.plan()
  assert.equal(h.changes.filter(change => change.event === 'change').length, 0)
  assert.equal(JSON.stringify(target.frames), before)
  assert.equal(h.notices.at(-1)?.kind, 'error')
})

test('rule planning keeps legacy extra images when it introduces no new frame IDs', () => {
  const target = panel(12, 2)
  const h = editor(target)
  h.setup.plan()
  const next = h.changes.find(change => change.event === 'change').args[0]
  assert.equal(next.length, 12)
  assert.deepEqual(Array.from(next, frame => frame.id), target.frames.map(frame => frame.id))
  assert.equal(next[11].url, '/static/11.png')
})

test('workbench AI apply rejects an oversized result before editing or saving', async () => {
  const notices = [], target = panel(12), plan = draft(10)
  let saves = 0, edits = 0
  const workspace = {
    version: vue.ref({ id: 4, revision: 1, timeline: { panels: [target] } }), editable: vue.ref(true),
    save: async () => { saves++; return true }, edit: action => { edits++; action(workspace.version.value.timeline) },
  }
  const planner = api(notices, { fetch: async (_url, options) => ({ ok: true, json: async () => ({ data: options.method === 'POST' ? { taskIds: [13] } : { items: [{ id: 13, status: 'completed' }], plans: [plan] } }) }) }).useFramePlanner(workspace, () => ({}))
  await planner.split(7, { force: true })
  const before = JSON.stringify(workspace.version.value.timeline.panels[0].frames)
  await planner.apply([plan])
  assert.equal(edits, 0)
  assert.equal(saves, 1)
  assert.equal(JSON.stringify(workspace.version.value.timeline.panels[0].frames), before)
  assert.equal(planner.open.value, true)
  assert.equal(notices.at(-1)?.kind, 'error')
})

test('standalone rule planning rejects an oversized shot before any edits or generation', async () => {
  const targets = [panel(0, 2), { ...panel(0, 10), id: 8 }]
  const notices = []
  let edits = 0, generations = 0
  const h = standalone({
    timeline: vue.ref({ panels: targets }), toast: { error: message => notices.push(message) },
    edit: action => { edits++; action({ panels: targets }) }, generateFrames: async () => { generations++ },
  })
  await h.planAndGenerate()
  assert.equal(edits, 0)
  assert.equal(generations, 0)
  assert.ok(targets.every(target => target.frames.length === 0))
  assert.match(notices[0], /9/)
})

test('standalone AI apply rejects a batch containing an oversized shot before any edits', () => {
  const target = panel(12), notices = []
  let edits = 0
  const open = vue.ref(true)
  const h = standalone({
    timeline: vue.ref({ panels: [target] }), framePlanOpen: open,
    toast: { error: message => notices.push(message), success() {} },
    edit: action => { edits++; action({ panels: [target] }) },
  })
  h.applyFramePlan([draft(10)])
  assert.equal(edits, 0)
  assert.equal(target.frames.length, 12)
  assert.equal(open.value, true)
  assert.match(notices[0], /9/)
})
