/**
 * 部署后自愈：旧页面引用已失效 chunk 时自动重新加载最新版本。
 *
 * 背景（2026-10-13 实测）：
 *   - 前端是 SPA，路由 / 对话框 / 异步组件都靠动态 import() 按需拉取 chunk；
 *     每次 nuxt build 都会重新生成 chunk 文件名，旧文件随即从产物中消失。
 *   - 用户长时间停留在旧页面上（浏览器内存里仍是重新构建前的 bundle），此时点击
 *     任意会触发动态 import 的控件，就会去请求已经不存在的旧 chunk：
 *         GET /_nuxt/<旧哈希>.js → 404 (application/json)
 *     → 浏览器抛 `TypeError: Failed to fetch dynamically imported module`，
 *       前端 toast 原样展示成「Failed to fetch」（看起来像接口挂了，其实不是）。
 *
 * Vite 在动态 import 失败时会派发可取消的 `vite:preloadError` 事件，这里接管它做
 * 一次整页刷新，让用户无感拿到线上最新版本；用 sessionStorage 做冷却，避免新版自身
 * 有问题时陷入「刷新 → 仍然失败 → 再刷新」的死循环。
 *
 * 注意：本插件只能覆盖「新页面」；已经停留在旧 bundle 上的页面无从加载它，那类页面
 * 仍需手动硬刷新一次。
 */
const RELOAD_KEY = 'huobao:chunk-reload-at'
const RELOAD_COOLDOWN_MS = 10_000

export default defineNuxtPlugin(() => {
  if (!import.meta.client) return

  window.addEventListener('vite:preloadError', (event) => {
    // 阻止 Vite 继续抛出：否则控制台仍会留下未捕获错误，Nuxt 也可能再处理一次
    event.preventDefault()

    let last = 0
    try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0) } catch { /* 隐私模式下不可用 */ }
    if (Date.now() - last < RELOAD_COOLDOWN_MS) {
      console.warn('[chunk] 资源已失效且刚重新加载过，跳过自动重载以避免死循环')
      return
    }
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* 同上 */ }

    // 不做缓存穿透参数：HTML 无缓存头，普通 reload 即会拿到新的 chunk 清单
    console.warn('[chunk] 检测到已失效的前端资源（通常是部署后停留在旧页面），正在重新加载最新版本…')
    window.location.reload()
  })
})
