const BASE = '/api/v1'

/**
 * 网络层失败识别：浏览器 fetch 遇到「连接被中途重置 / 代理掐断 / 隧道抖动」时只会抛裸的
 * `TypeError: Failed to fetch`（读 body 中途断同样如此），不会给出状态码。
 * 注意必须与「服务端返回的状态码/非 JSON」区分：后者不是 TypeError，照常抛出、不重试。
 */
const NETWORK_ERROR_RE = /failed to fetch|network ?error|load failed|fetch failed|err_connection|err_network/i

/**
 * 陈旧 bundle 识别：部署后停留在旧页面的用户，动态 import 会去请求已被新构建删除的 chunk：
 *   GET /_nuxt/<旧哈希>.js → 404
 *   → TypeError: Failed to fetch dynamically imported module: https://…/_nuxt/<旧哈希>.js
 * message 里含 "Failed to fetch"，会被 NETWORK_ERROR_RE 误判成网络故障——服务端其实是好的，
 * 重试也没有意义（文件已经不存在）。单独识别、单独处理，见 isStaleChunkError。
 */
const STALE_CHUNK_RE = /dynamically imported module/i

export function isStaleChunkError(cause: unknown): boolean {
  // 与 isNetworkError 一致要求 TypeError：浏览器对动态 import 失败抛的就是 TypeError，
  // 收紧一点可避免其它碰巧带同串 message 的普通 Error 被误分类
  return cause instanceof TypeError && STALE_CHUNK_RE.test(cause.message || '')
}

export function isNetworkError(cause: unknown): boolean {
  // 陈旧 chunk 同样是 TypeError + "Failed to fetch"，但重试救不回已删除的文件，排除掉
  return cause instanceof TypeError && NETWORK_ERROR_RE.test(cause.message || '') && !isStaleChunkError(cause)
}

/**
 * 陈旧 bundle 自愈：与 plugins/chunk-reload.client.ts 共用同一把 sessionStorage 冷却锁。
 * vite:preloadError 只能覆盖 Vite 包装过的动态 import；裸 import() 失败（路由 chunk 等）
 * 会以 TypeError 的形式冒到业务 catch 里，那些路径也调本函数做同一件事。
 * 返回 false = 处于 10s 冷却期（刚重载过仍失败），调用方应展示文案而不是再刷一次，
 * 避免新版自身有问题时陷入「刷新 → 仍然失败 → 再刷新」的死循环。
 */
const CHUNK_RELOAD_KEY = 'huobao:chunk-reload-at'
const CHUNK_RELOAD_COOLDOWN_MS = 10_000

export function reloadStaleBundle(): boolean {
  let last = 0
  try { last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0) } catch { /* 隐私模式下不可用 */ }
  if (Date.now() - last < CHUNK_RELOAD_COOLDOWN_MS) {
    console.warn('[chunk] 资源已失效且刚重新加载过，跳过自动重载以避免死循环')
    return false
  }
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())) } catch { /* 同上 */ }
  // 不做缓存穿透参数：HTML 无缓存头，普通 reload 即会拿到新的 chunk 清单
  console.warn('[chunk] 检测到已失效的前端资源（通常是部署后停留在旧页面），正在重新加载最新版本…')
  if (typeof window !== 'undefined') window.location.reload()
  return true
}

/**
 * 幂等请求的网络抖动容错。
 *
 * fetch 自身不重试，一次连接抖动就会原样冒到业务层变成「Failed to fetch」——本机前面挂着
 * nitro 代理与 frp 隧道，链路比直连长，这类一次性抖动值得挡在 UI 之外。
 *
 * 重试次数取 2 而不是 1：nitro 的 node-server 用 `new HttpServer()` 不传 options，吃的是
 * Node 默认 `keepAliveTimeout = 5000`，却在响应里广告 `Keep-Alive: timeout=5`；再叠上
 * frp 隧道与外部网络的 NAT，空闲连接被对端关掉后，浏览器连接池有一定概率复用到已半死的
 * socket。一次重试仍可能撞上第二个坏 socket（实测出现过连续两次），所以要给第二次机会。
 *
 * 约束：**只重试 GET**（幂等），**非 GET 一律不重试**，否则可能重复建任务/重复下单；
 * 只重试网络层 TypeError，HTTP 状态码与业务错误不受影响。
 */
export async function withNetworkRetry<T>(run: () => Promise<T>, method = 'GET', retries = 2): Promise<T> {
  const backoff = [300, 900]
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (cause) {
      if (attempt >= retries || method.toUpperCase() !== 'GET' || !isNetworkError(cause)) throw cause
      await new Promise(resolve => setTimeout(resolve, backoff[attempt] ?? 900))
    }
  }
}

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const { resp, json } = await withNetworkRetry(async () => {
      const resp = await fetch(`${BASE}${path}`, opts)
      return { resp, json: await resp.json() }
    }, method)
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw Object.assign(new Error(json.message || `${resp.status}`), { status: resp.status })
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export const characterAPI = {
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

// 统一生成任务（图片/视频）：POST 带 type 字段，列表按 type 过滤
export const taskAPI = {
  generate: (d: any) => api.post('/tasks', d),
  get: (id: number) => api.get(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  list: (params?: {
    type?: 'image' | 'video'
    drama_id?: number
    storyboard_id?: number
    character_id?: number
    scene_id?: number
    prop_id?: number
    limit?: number
  }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    if (params?.character_id) query.set('character_id', String(params.character_id))
    if (params?.scene_id) query.set('scene_id', String(params.scene_id))
    if (params?.prop_id) query.set('prop_id', String(params.prop_id))
    if (params?.limit) query.set('limit', String(params.limit))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 按集聚合生成任务（sys_task + video_merges）
  listByEpisode: (episodeId: number) => api.get<{ tasks: any[]; merges: any[] }>(`/episodes/${episodeId}/generation-tasks`),
}

async function uploadReq<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw Object.assign(new Error(json.message || `${resp.status}`), { status: resp.status })
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[]) => api.post(`/merge/episodes/${epId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
