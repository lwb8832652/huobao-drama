import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

// 真实跑 useToast.ts：文案取自真实 zh.json，「陈旧 chunk 必须压过 network」的分类优先级、
// toastError 的自愈短路都是用户可见契约。useApi 同样跑真模块（自愈与冷却逻辑在里面），
// sessionStorage / window 给可断言假件。TypeError/Error 等内置必须显式注入：vm 是独立
// realm，`err instanceof TypeError` 用沙箱自己的构造器会静默失败（这个坑已踩过三次）。
const zhMessages = JSON.parse(read('../app/locales/zh.json'))
function translate(key, params) {
  const value = String(key).split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), zhMessages)
  if (typeof value !== 'string') return key
  if (!params) return value
  return value.replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`))
}
const toasts = []
const sessionStore = new Map()
const reloads = []
function evaluate(source, dependencies = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
    setTimeout, clearTimeout, TypeError, SyntaxError, Error,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    sessionStorage: {
      getItem: key => (sessionStore.has(key) ? sessionStore.get(key) : null),
      setItem: (key, value) => sessionStore.set(key, String(value)),
    },
    window: { location: { reload: () => reloads.push(1) } },
  })
  return module.exports
}
const useApi = evaluate(read('../app/composables/useApi.ts'))
const useToast = evaluate(read('../app/composables/useToast.ts'), {
  'vue-sonner': { toast: { error: message => toasts.push(message), success: () => {} } },
  '~/composables/i18n': { i18n: { global: { t: translate } } },
  '~/composables/useApi': useApi,
})
const stale = () => new TypeError('Failed to fetch dynamically imported module: https://host/_nuxt/CNNR5FoL.js')

test('mapError classifies a stale-chunk failure as its own copy, not a network outage', () => {
  const message = useToast.mapError(stale())
  assert.equal(message, translate('errors.staleChunk'))
  assert.notEqual(message, translate('errors.network'), '不能误报成「无法连接服务器，请检查网络或服务是否已启动」')
  assert.match(message, /[\u4e00-\u9fff]/, '漏译时 mapError 会原样返回 key，这里兜住')
})

test('toastError self-heals a stale bundle with one reload and stays silent', () => {
  sessionStore.clear(); toasts.length = 0; reloads.length = 0
  useToast.toastError(stale())
  assert.equal(reloads.length, 1, '触发一次整页重载，用户无感拿到新版本')
  assert.equal(toasts.length, 0, '自愈成功不弹提示')
  assert.equal(sessionStore.has('huobao:chunk-reload-at'), true, '写入冷却键，与 chunk-reload 插件共用')
})

test('toastError falls back to the stale copy when the reload cooldown is still active', () => {
  sessionStore.clear(); toasts.length = 0; reloads.length = 0
  sessionStore.set('huobao:chunk-reload-at', String(Date.now()))
  useToast.toastError(stale())
  assert.equal(reloads.length, 0, '冷却期内不重复重载，避免新版自身有问题时死循环')
  assert.deepEqual(toasts, [translate('errors.staleChunk')])
})

test('ordinary failures still toast normally and never touch the reload path', () => {
  sessionStore.clear(); toasts.length = 0; reloads.length = 0
  useToast.toastError(new TypeError('Failed to fetch'))
  assert.deepEqual(toasts, [translate('errors.network')])
  assert.equal(reloads.length, 0, '真实网络失败不触发重载（重载只会丢状态，不修网络）')
})
