import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

// useApi.ts 自身无 import，可直接在 vm 里跑真模块（需要 setTimeout 供退避用）。
// 必须把宿主的 TypeError/Error 注入沙箱：isNetworkError 用 `err instanceof TypeError` 分流，
// 而 vm 是独立 realm，两边构造器不同会让 instanceof 静默失败、重试逻辑整个失效。
// reloadStaleBundle 还要 sessionStorage / window / console：给可断言的假件，冷却行为才能测。
const sessionStore = new Map()
const reloads = []
const module = { exports: {} }
runInNewContext(ts.transpileModule(read('../app/composables/useApi.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module, exports: module.exports, setTimeout, clearTimeout, TypeError, Error,
  console: { warn: () => {}, log: () => {}, error: () => {} },
  sessionStorage: {
    getItem: key => (sessionStore.has(key) ? sessionStore.get(key) : null),
    setItem: (key, value) => sessionStore.set(key, String(value)),
  },
  window: { location: { reload: () => reloads.push(Date.now()) } },
})
const { isNetworkError, isStaleChunkError, withNetworkRetry, reloadStaleBundle } = module.exports

test('isNetworkError only accepts a TypeError whose message looks like a transport failure', () => {
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true)
  assert.equal(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.')), true)
  assert.equal(isNetworkError(new TypeError('load failed')), true)
  // 非 TypeError：服务端错误/业务错误，必须原样抛出、不重试
  assert.equal(isNetworkError(new Error('Failed to fetch')), false)
  assert.equal(isNetworkError(new Error('请求失败 (500)')), false)
  // TypeError 但与网络无关
  assert.equal(isNetworkError(new TypeError('x is not a function')), false)
})

test('a GET is retried twice so two dead sockets in a row still recover', async () => {
  let calls = 0
  const value = await withNetworkRetry(async () => {
    calls += 1
    if (calls <= 2) throw new TypeError('Failed to fetch')
    return 'ok'
  }, 'GET')
  assert.equal(value, 'ok')
  assert.equal(calls, 3, '首次 + 2 次重试')
})

test('a stale-chunk import failure is not a network error: the file is gone, retrying cannot help', () => {
  const stale = new TypeError('Failed to fetch dynamically imported module: https://host/_nuxt/CNNR5FoL.js')
  assert.equal(isStaleChunkError(stale), true)
  assert.equal(isNetworkError(stale), false, '陈旧 chunk 也是 TypeError + Failed to fetch，但必须排除出重试')
  // 反向边界：普通网络失败不能被误判成陈旧 chunk
  assert.equal(isStaleChunkError(new TypeError('Failed to fetch')), false)
  assert.equal(isStaleChunkError(new Error('dynamically imported module')), false)
  assert.equal(isStaleChunkError(null), false)
})

test('a GET still surfaces the error after the retries are exhausted', async () => {
  let calls = 0
  await assert.rejects(withNetworkRetry(async () => {
    calls += 1
    throw new TypeError('Failed to fetch')
  }, 'GET'), /Failed to fetch/)
  assert.equal(calls, 3)
})

test('a stale-chunk failure surfaces immediately with no retry at all', async () => {
  let calls = 0
  await assert.rejects(withNetworkRetry(async () => {
    calls += 1
    throw new TypeError('Failed to fetch dynamically imported module: https://host/_nuxt/old.js')
  }, 'GET'), /dynamically imported module/)
  assert.equal(calls, 1, 'chunk 已被新构建删除，重试毫无意义')
})

test('reloadStaleBundle reloads once, then cools down so a broken build cannot loop', () => {
  sessionStore.clear(); reloads.length = 0
  assert.equal(reloadStaleBundle(), true)
  assert.equal(reloads.length, 1)
  assert.equal(reloadStaleBundle(), false, '冷却期内不重复重载')
  assert.equal(reloads.length, 1)
  // 把冷却键改回 11 秒前：冷却过期后允许再次重载
  sessionStore.set('huobao:chunk-reload-at', String(Date.now() - 11_000))
  assert.equal(reloadStaleBundle(), true)
  assert.equal(reloads.length, 2)
})

test('non-GET requests are never retried, and non-network errors are never retried', async () => {
  let posts = 0
  await assert.rejects(withNetworkRetry(async () => {
    posts += 1
    throw new TypeError('Failed to fetch')
  }, 'POST'), /Failed to fetch/)
  assert.equal(posts, 1, 'POST 不重试，避免重复建任务/重复下单')

  let business = 0
  await assert.rejects(withNetworkRetry(async () => {
    business += 1
    throw new Error('请求失败 (500)')
  }, 'GET'), /请求失败 \(500\)/)
  assert.equal(business, 1, 'HTTP 状态码类错误不重试')
})
