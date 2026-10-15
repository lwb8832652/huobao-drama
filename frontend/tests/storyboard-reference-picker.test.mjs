import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function evaluate(source, deps = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source.replaceAll('import.meta.client', 'false'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: name => {
    assert.ok(name in deps, `Unexpected dependency: ${name}`); return deps[name]
  }, setTimeout, clearTimeout, setInterval, clearInterval, ...globals })
  return module.exports
}
const assets = () => [
  { key: 'character-1', id: 1, kind: 'character', name: '萧炎', imageUrl: '/static/hero.png', ready: true, bound: true },
  { key: 'character-2', id: 2, kind: 'character', name: '萧薰儿', imageUrl: '', ready: false, bound: false },
  { key: 'scene-3', id: 3, kind: 'scene', name: '广场', imageUrl: '/static/old-scene.png', ready: true, bound: true },
  { key: 'scene-4', id: 4, kind: 'scene', name: '大厅 · 白天', referenceLabel: '大厅', imageUrl: '/static/new-scene.png', ready: true, bound: false },
  { key: 'prop-5', id: 5, kind: 'prop', name: '测验石', imageUrl: '/static/stone.png', ready: true, bound: true },
]
function helper() {
  const path = '../app/composables/useStoryboardReferences.ts'
  assert.ok(existsSync(new URL(path, import.meta.url)), 'Reference selection must have explicit draft and binding semantics')
  return evaluate(read(path))
}
const panel = () => ({ id: 7, title: '测验', durationMs: 6000, sceneId: 3, characterIds: [1], propIds: [5],
  referenceImages: ['static/old-scene.png', '/static/hero.png', '/static/stone.png', '/static/custom.png'],
  referenceLabels: ['广场', '萧炎', '测验石', '构图参考'],
  frames: [{ id: 'one', url: '/static/frame.png', referenceImages: ['/static/frame-custom.png'] }],
})

test('selection toggles characters and props independently but replaces a selected scene', () => {
  const { toggleReferenceSelection } = helper(), list = assets(), original = ['character-1', 'scene-3', 'prop-5']
  assert.deepEqual(plain(toggleReferenceSelection(original, list[3], list)), ['character-1', 'prop-5', 'scene-4'])
  assert.deepEqual(plain(toggleReferenceSelection(original, list[0], list)), ['scene-3', 'prop-5'])
  assert.deepEqual(original, ['character-1', 'scene-3', 'prop-5'])
})

test('binding changes remove old asset references while preserving custom references and frame data', () => {
  const { buildReferencePatch } = helper(), target = panel(), before = plain(target)
  const patch = buildReferencePatch(target, assets(), ['character-1', 'scene-4'])
  assert.equal(patch.sceneId, 4)
  assert.deepEqual(plain(patch.characterIds), [1]); assert.deepEqual(plain(patch.propIds), [])
  assert.deepEqual(plain(patch.referenceImages), ['/static/new-scene.png', '/static/hero.png', '/static/custom.png', '/static/frame-custom.png'])
  assert.deepEqual(plain(patch.referenceLabels), ['大厅', '萧炎', '构图参考', '画面 1 参考图 1'])
  assert.deepEqual(plain(target), before)
  assert.equal('frames' in patch, false)
})

test('missing asset images remain bound and do not replace shared references with empty URLs', () => {
  const patch = helper().buildReferencePatch(panel(), assets(), ['character-2'])
  assert.deepEqual(plain(patch.characterIds), [2]); assert.equal(patch.sceneId, null)
  assert.deepEqual(plain(patch.referenceImages), ['/static/custom.png', '/static/frame-custom.png'])
})

test('frame-specific references remain available after their global asset is deselected', () => {
  const target = panel()
  target.frames[0].referenceImages = ['/static/hero.png', '/static/frame-custom.png']
  const patch = helper().buildReferencePatch(target, assets(), ['scene-3'])
  assert.deepEqual(plain(patch.characterIds), [])
  assert.ok(patch.referenceImages.includes('/static/hero.png'))
  assert.ok(target.frames[0].referenceImages.every(url => patch.referenceImages.includes(url)))
  assert.equal('frames' in patch, false)
})

test('external image origins are distinct from local static references', () => {
  const target = panel()
  target.referenceImages.push('https://other.example/static/hero.png')
  target.referenceLabels.push('远程构图')
  const patch = helper().buildReferencePatch(target, assets(), ['scene-3'])
  assert.ok(patch.referenceImages.includes('https://other.example/static/hero.png'))
  assert.ok(!patch.referenceImages.includes('/static/hero.png'))
})

test('selection rejects assets that disappeared and multiple selected scenes', () => {
  const fn = helper().buildReferencePatch
  assert.throws(() => fn(panel(), assets(), ['character-99']), /素材.*变化/)
  assert.throws(() => fn(panel(), assets(), ['scene-3', 'scene-4']), /场景/)
})

function workspace(request) {
  const shotPlanning = evaluate(read('../../backend/src/services/shot-planning.ts'))
  const domain = evaluate(read('../../backend/src/services/previs-domain.ts'), { './shot-planning.js': shotPlanning })
  const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
  const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
  const disposers = [], calls = []
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted: fn => disposers.push(fn) },
    'vue-sonner': { toast: { error() {}, success() {} } },
    '~/composables/useApi': { withNetworkRetry: fn => fn() },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, { fetch: async (url, options) => {
    const body = options.body && JSON.parse(options.body)
    calls.push({ url, method: options.method, body })
    const result = await request(url, body)
    return { ok: !result.error, status: result.error ? 409 : 200, json: async () => result.error ? { message: result.error } : { data: result } }
  } })
  const state = api.usePrevis()
  state.version.value = { id: 4, revision: 2, status: 'draft', busy: false,
    timeline: { panels: [panel()], groups: [], audio: [] }, batches: [], outputs: [], contactSheets: [] }
  return { state, calls, dispose: () => disposers.forEach(fn => fn()) }
}

test('all bindings commit with one timeline write and remain unchanged until success', async () => {
  let finish
  const h = workspace((url, body) => new Promise(resolve => { finish = () => resolve({ ...plain(h.state.version.value), revision: 3, timeline: body.timeline }) }))
  assert.equal(typeof h.state.savePanelReferences, 'function')
  const changes = { sceneId: 4, characterIds: [2], propIds: [], referenceImages: ['/static/new-scene.png'], referenceLabels: ['大厅'], scene: '大厅' }
  const saving = h.state.savePanelReferences(7, changes)
  await vue.nextTick()
  assert.equal(h.state.version.value.timeline.panels[0].sceneId, 3)
  assert.equal(h.state.working.value, true)
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].body.timeline.panels[0].characterIds, [2])
  finish(); assert.equal(await saving, true)
  assert.equal(h.state.version.value.timeline.panels[0].sceneId, 4)
  assert.equal(h.state.undoStack.value.length, 1)
  assert.equal(h.state.working.value, false); h.dispose()
})

test('failed reference save leaves bindings, frame images and undo history intact', async () => {
  const h = workspace(async () => ({ error: '工作版已更新，请刷新重试' }))
  assert.equal(typeof h.state.savePanelReferences, 'function')
  const before = plain(h.state.version.value)
  assert.equal(await h.state.savePanelReferences(7, { sceneId: 4 }), false)
  assert.deepEqual(plain(h.state.version.value), before)
  assert.equal(h.state.undoStack.value.length, 0)
  assert.equal(h.state.working.value, false)
  assert.match(h.state.saveError.value, /工作版已更新/); h.dispose()
})

test('locked, busy and missing panels cannot commit references', async () => {
  for (const condition of ['locked', 'busy', 'missing']) {
    const h = workspace(async () => { throw new Error('No request expected') })
    assert.equal(typeof h.state.savePanelReferences, 'function')
    if (condition === 'locked') h.state.version.value.status = 'locked'
    if (condition === 'busy') h.state.version.value.busy = true
    assert.equal(await h.state.savePanelReferences(condition === 'missing' ? 99 : 7, { sceneId: 4 }), false)
    assert.equal(h.calls.length, 0); h.dispose()
  }
})

function picker(save = async () => true) {
  const path = '../app/components/previs/StoryboardReferencePicker.vue'
  assert.ok(existsSync(new URL(path, import.meta.url)), 'The picker must keep choices local until Save')
  const descriptor = parse(read(path)).descriptor, script = compileScript(descriptor, { id: 'reference-picker' })
  const props = vue.reactive({ assets: assets(), editable: true, title: '分镜 01', save })
  const component = evaluate(script.content, {
    vue: { ...vue, onBeforeUnmount() {}, useId: () => 'reference-picker' },
    'lucide-vue-next': {},
    '~/composables/useStoryboardReferences': helper(),
    '~/composables/usePrevis': { mediaUrl: url => url },
  })
  return { props, state: component.default.setup(props, { expose() {}, emit() {} }) }
}

test('cancel discards local changes without saving and reopening restores current bindings', () => {
  let saves = 0
  const h = picker(async () => { saves++; return true })
  h.state.openPicker(); h.state.toggleAsset(h.props.assets[3])
  assert.ok(h.state.selectedKeys.value.includes('scene-4'))
  assert.equal(h.props.assets[3].bound, false)
  h.state.closePicker(); assert.equal(saves, 0)
  h.state.openPicker(); assert.deepEqual(plain(h.state.selectedKeys.value), ['character-1', 'scene-3', 'prop-5'])
})

test('picker keeps draft open after save failure and prevents a duplicate submission', async () => {
  let finish, saves = 0
  const h = picker(() => { saves++; return new Promise(resolve => { finish = resolve }) })
  h.state.openPicker(); h.state.toggleAsset(h.props.assets[3])
  const saving = h.state.saveSelection(); await h.state.saveSelection()
  h.state.closePicker(); assert.equal(h.state.open.value, true)
  assert.equal(saves, 1)
  finish(false); await saving
  assert.equal(h.state.open.value, true)
  assert.ok(h.state.selectedKeys.value.includes('scene-4'))
  assert.match(h.state.error.value, /保存失败/)
})

test('search, kind and selected-only filters combine without changing selection', () => {
  const h = picker(); h.state.openPicker()
  h.state.query.value = '萧'; h.state.kind.value = 'character'
  assert.equal(h.state.filteredAssets.value.length, 2)
  h.state.onlySelected.value = true
  assert.equal(h.state.filteredAssets.value.length, 1)
  assert.equal(h.state.filteredAssets.value[0].name, '萧炎')
  assert.equal(h.state.selectedKeys.value.length, 3)
})

test('an outside binding change during editing cannot be overwritten by the stale picker draft', async () => {
  let saves = 0
  const h = picker(async () => { saves++; return true })
  h.state.openPicker(); h.state.toggleAsset(h.props.assets[1])
  h.props.assets[0].bound = false
  await h.state.saveSelection()
  assert.equal(saves, 0)
  assert.equal(h.state.open.value, true)
  assert.match(h.state.error.value, /绑定已.*变更/)
})
