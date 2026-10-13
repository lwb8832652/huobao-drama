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
 * 一次整页刷新，让用户无感拿到线上最新版本。
 *
 * 冷却锁与自愈逻辑本身在 composables/useApi.ts 的 reloadStaleBundle()：
 * vite:preloadError 覆盖不到「裸 import() 失败」（路由 chunk 等），那类错误会以
 * TypeError 形式冒到业务 catch（useToast.mapError / StoryboardGridTools.failure），
 * 两条路径必须共用同一把 sessionStorage 锁，否则可能叠加重载或绕过冷却。
 *
 * 注意：本插件只能覆盖「新页面」；已经停留在旧 bundle 上的页面无从加载它，那类页面
 * 仍需手动硬刷新一次。
 */
import { reloadStaleBundle } from '~/composables/useApi'

export default defineNuxtPlugin(() => {
  if (!import.meta.client) return

  window.addEventListener('vite:preloadError', (event) => {
    // 阻止 Vite 继续抛出：否则控制台仍会留下未捕获错误，Nuxt 也可能再处理一次
    event.preventDefault()
    reloadStaleBundle()
  })
})
