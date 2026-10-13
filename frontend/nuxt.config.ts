import { fileURLToPath } from 'node:url'

// 构建目录按命令分流：dev 与 build/generate 共用 .nuxt 时会互相污染——build 会把
// dev 的 /@vite/client 引用混进产物（2026-10-09 实证），表现为线上页面加载 dev 模块。
// 分流后两者可同时运行，不再需要「停 dev → 移走 .nuxt → 再 build」。
// prepare（postinstall）仍写 .nuxt，供 tsconfig.json 的 extends 取类型。
const command = process.argv[2] || ''
const buildDir = process.env.NUXT_BUILD_DIR
  || (command === 'dev' ? '.nuxt-dev' : command === 'build' || command === 'generate' ? '.nuxt-build' : '.nuxt')

export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  buildDir,
  devtools: { enabled: false },
  experimental: {
    appManifest: false,
  },
  hooks: {
    // 动态路由页面统一放在 app/views/ 手动注册，避免文件路径中出现 [id] 方括号
    // （方括号路径在 git/shell 中需转义，且部分部署环境不兼容）。URL 保持不变。
    'pages:extend'(pages) {
      pages.push(
        {
          name: 'drama-detail',
          path: '/drama/:id',
          file: fileURLToPath(new URL('./app/views/drama/detail.vue', import.meta.url)),
        },
        {
          name: 'drama-episode',
          path: '/drama/:id/episode/:episodeNumber',
          file: fileURLToPath(new URL('./app/views/drama/episode.vue', import.meta.url)),
        },
        {
          name: 'drama-previs',
          path: '/drama/:id/episode/:episodeNumber/previs',
          file: fileURLToPath(new URL('./app/views/drama/previs.vue', import.meta.url)),
        },
      )
    },
  },
  app: {
    head: {
      title: '火宝短剧',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        // v 参数用于 favicon 缓存穿透（浏览器对 favicon 缓存独立于 HTTP 缓存，换图必须 bump）
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon.png?v=4' },
        { rel: 'shortcut icon', type: 'image/png', href: '/favicon.png?v=4' },
      ],
    },
  },
  vite: {
    server: {
      proxy: {
        '/api': { target: 'http://localhost:5679', changeOrigin: true },
        '/static': { target: 'http://localhost:5679', changeOrigin: true },
      },
    },
  },
  // 生产构建（nuxt build）的 /api 转发：dev 用上面的 vite proxy，生产用 Nitro routeRules。
  // 注意 nitro proxy 的 ** 只替换通配部分（不含前缀），需保留 /api、/static 前缀
  nitro: {
    routeRules: {
      '/api/**': { proxy: 'http://localhost:5679/api/**' },
      '/static/**': { proxy: 'http://localhost:5679/static/**' },
    },
  },
  compatibilityDate: '2025-05-15',
})
