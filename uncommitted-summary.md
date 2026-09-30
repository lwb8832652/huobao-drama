# 未提交改动汇总

生成时间：2026-09-29 18:11:03

## 总览

```
 29 files changed, 5360 insertions(+), 176 deletions(-)
```

## 各文件增删

| 新增 | 删除 | 文件 |
|---:|---:|---|
| 7 | 0 | .gitignore |
| 5 | 0 | backend/src/agents/index.ts |
| 106 | 0 | backend/src/db/previs-schema.ts |
| 3 | 0 | backend/src/db/schema.ts |
| 8 | 0 | backend/src/db/sqlite-schema.ts |
| 8 | 2 | backend/src/index.ts |
| 75 | 0 | backend/src/middleware/static-range.ts |
| 69 | 0 | backend/src/routes/previs.ts |
| 30 | 6 | backend/src/routes/tasks.ts |
| 361 | 0 | backend/src/services/continuity-review.ts |
| 31 | 3 | backend/src/services/ffmpeg-merge.ts |
| 50 | 7 | backend/src/services/generation.ts |
| 424 | 0 | backend/src/services/previs-batch.ts |
| 348 | 0 | backend/src/services/previs-domain.ts |
| 516 | 0 | backend/src/services/previs.ts |
| 790 | 0 | frontend/app/assets/css/previs.css |
| 255 | 0 | frontend/app/components/previs/FrameSettingsDialog.vue |
| 187 | 0 | frontend/app/components/previs/PrevisPlayer.vue |
| 145 | 0 | frontend/app/components/previs/PrevisTimeline.vue |
| 305 | 0 | frontend/app/components/previs/StoryboardFramesEditor.vue |
| 13 | 1 | frontend/app/composables/useApi.ts |
| 195 | 0 | frontend/app/composables/usePrevis.ts |
| 6 | 0 | frontend/app/locales/en.json |
| 6 | 0 | frontend/app/locales/ja.json |
| 6 | 0 | frontend/app/locales/ko.json |
| 6 | 0 | frontend/app/locales/zh.json |
| 532 | 157 | frontend/app/views/drama/episode.vue |
| 868 | 0 | frontend/app/views/drama/previs.vue |
| 5 | 0 | frontend/nuxt.config.ts |

## 改动内容

````diff
diff --git a/.gitignore b/.gitignore
index 30c4a72..bac2f87 100644
--- a/.gitignore
+++ b/.gitignore
@@ -3,14 +3,21 @@ node_modules/
 
 # Build output
 dist/
+# Nuxt generate may create dist as a symlink rather than a directory.
+/frontend/dist
 
 # IDE
 .idea/
 .vscode/
 *.swp
 *.swo
+*.md
 *~
 
+# Tests
+*.test.ts
+*.test.mjs
+
 # Environment
 .env
 .env.local
diff --git a/backend/src/agents/index.ts b/backend/src/agents/index.ts
index d6b3aaf..f689f36 100644
--- a/backend/src/agents/index.ts
+++ b/backend/src/agents/index.ts
@@ -329,6 +329,11 @@ async function getModel(fileModel: string | undefined, modelOverride?: string, t
   return provider.chat(modelName)
 }
 
+/** Reuse the configured text-model transport for focused, tool-free AI calls. */
+export function resolveTextModel(modelOverride?: string, textConfigId?: number) {
+  return getModel(undefined, modelOverride, textConfigId)
+}
+
 const AGENT_TOOLS: Record<string, Record<string, any>> = {
   script_rewriter: scriptTools,
   extractor: extractTools,
diff --git a/backend/src/db/previs-schema.ts b/backend/src/db/previs-schema.ts
new file mode 100644
index 0000000..f25f5ba
--- /dev/null
+++ b/backend/src/db/previs-schema.ts
@@ -0,0 +1,106 @@
+import type Database from 'better-sqlite3'
+import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
+
+// Groups, panels, transitions and audio belong to a version's snapshot, never to shared mutable rows.
+export const animaticVersions = sqliteTable('animatic_versions', {
+  id: integer('id').primaryKey({ autoIncrement: true }),
+  episodeId: integer('episode_id').notNull(),
+  versionNo: integer('version_no').notNull(),
+  revision: integer('revision').notNull().default(1),
+  status: text('status').notNull().default('draft'),
+  timelineJson: text('timeline_json').notNull(),
+  contentHash: text('content_hash'),
+  lockedAt: text('locked_at'),
+  createdAt: text('created_at').notNull(),
+  updatedAt: text('updated_at').notNull(),
+})
+export const batchRuns = sqliteTable('batch_runs', {
+  id: integer('id').primaryKey({ autoIncrement: true }),
+  versionId: integer('version_id').notNull(),
+  type: text('type').notNull(),
+  status: text('status').notNull().default('pending'),
+  requestHash: text('request_hash').notNull(),
+  configId: integer('config_id').notNull(),
+  model: text('model').notNull(),
+  createdAt: text('created_at').notNull(),
+})
+export const batchRunItems = sqliteTable('batch_run_items', {
+  id: integer('id').primaryKey({ autoIncrement: true }),
+  batchId: integer('batch_id').notNull(),
+  groupId: text('group_id').notNull(),
+  panelId: integer('panel_id'),
+  frameType: text('frame_type'),
+  requestJson: text('request_json').notNull(),
+  status: text('status').notNull().default('pending'),
+  taskId: integer('task_id'),
+  attempt: integer('attempt').notNull().default(0),
+  error: text('error'),
+})
+export const continuityReviews = sqliteTable('continuity_reviews', {
+  id: integer('id').primaryKey({ autoIncrement: true }),
+  versionId: integer('version_id').notNull(),
+  fromGroupId: text('from_group_id').notNull(),
+  toGroupId: text('to_group_id').notNull(),
+  inputHash: text('input_hash').notNull(),
+  configId: integer('config_id').notNull(),
+  model: text('model').notNull(),
+  status: text('status').notNull().default('completed'),
+  resultJson: text('result_json').notNull().default(''),
+  error: text('error'),
+  createdAt: text('created_at').notNull(),
+}, table => [
+  uniqueIndex('idx_continuity_review_input').on(
+    table.versionId, table.fromGroupId, table.toGroupId, table.inputHash,
+  ),
+])
+
+export function initPrevisSchema(sqlite: Database.Database) {
+  sqlite.exec(`
+    CREATE TABLE IF NOT EXISTS animatic_versions (
+      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER NOT NULL, version_no INTEGER NOT NULL,
+      revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
+      timeline_json TEXT NOT NULL, content_hash TEXT, locked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
+      UNIQUE(episode_id, version_no)
+    );
+    CREATE TRIGGER IF NOT EXISTS animatic_locked_immutable BEFORE UPDATE ON animatic_versions
+    WHEN OLD.status = 'locked'
+    BEGIN SELECT RAISE(ABORT, 'Locked animatic versions are immutable'); END;
+    CREATE TABLE IF NOT EXISTS batch_runs (
+      id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, type TEXT NOT NULL,
+      status TEXT NOT NULL DEFAULT 'pending', request_hash TEXT NOT NULL,
+      config_id INTEGER NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
+      UNIQUE(version_id, request_hash)
+    );
+    CREATE TABLE IF NOT EXISTS batch_run_items (
+      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, group_id TEXT NOT NULL,
+      panel_id INTEGER, frame_type TEXT, request_json TEXT NOT NULL,
+      status TEXT NOT NULL DEFAULT 'pending', task_id INTEGER, attempt INTEGER NOT NULL DEFAULT 0, error TEXT
+    );
+    CREATE TABLE IF NOT EXISTS continuity_reviews (
+      id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL,
+      from_group_id TEXT NOT NULL, to_group_id TEXT NOT NULL, input_hash TEXT NOT NULL,
+      config_id INTEGER NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
+      result_json TEXT NOT NULL DEFAULT '', error TEXT, created_at TEXT NOT NULL,
+      UNIQUE(version_id, from_group_id, to_group_id, input_hash)
+    );
+    CREATE INDEX IF NOT EXISTS idx_previs_batch_version ON batch_runs(version_id);
+    CREATE INDEX IF NOT EXISTS idx_previs_batch_version_type ON batch_runs(version_id, type);
+    CREATE INDEX IF NOT EXISTS idx_previs_batch_status ON batch_runs(status);
+    CREATE INDEX IF NOT EXISTS idx_previs_items_batch ON batch_run_items(batch_id);
+    CREATE INDEX IF NOT EXISTS idx_previs_items_batch_status ON batch_run_items(batch_id, status);
+    CREATE INDEX IF NOT EXISTS idx_previs_items_status ON batch_run_items(status);
+    CREATE INDEX IF NOT EXISTS idx_continuity_review_version ON continuity_reviews(version_id);
+  `)
+  const reviewColumns = sqlite.prepare('PRAGMA table_info(continuity_reviews)').all() as { name: string }[]
+  if (!reviewColumns.some(c => c.name === 'status')) {
+    sqlite.exec("ALTER TABLE continuity_reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'")
+  }
+  if (!reviewColumns.some(c => c.name === 'error')) {
+    sqlite.exec('ALTER TABLE continuity_reviews ADD COLUMN error TEXT')
+  }
+  const columns = sqlite.prepare('PRAGMA table_info(sys_task)').all() as { name: string }[]
+  for (const [name, type] of [['animatic_version_id', 'INTEGER'], ['previs_item_key', 'TEXT']]) {
+    if (!columns.some(c => c.name === name)) sqlite.exec(`ALTER TABLE sys_task ADD COLUMN ${name} ${type}`)
+  }
+  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_previs_item_key ON sys_task(previs_item_key) WHERE previs_item_key IS NOT NULL')
+}
diff --git a/backend/src/db/schema.ts b/backend/src/db/schema.ts
index 9549ff3..e9a6075 100644
--- a/backend/src/db/schema.ts
+++ b/backend/src/db/schema.ts
@@ -4,6 +4,7 @@
  * boolean→integer boolean mode、时间戳仍为 text 存 ISO 字符串，表/列名不变。
  */
 import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
+export { animaticVersions, batchRuns, batchRunItems, continuityReviews } from './previs-schema.js'
 
 export const dramas = sqliteTable('dramas', {
   id: integer('id').primaryKey({ autoIncrement: true }),
@@ -201,6 +202,8 @@ export const stylePresets = sqliteTable('style_presets', {
 export const sysTask = sqliteTable('sys_task', {
   id: integer('id').primaryKey({ autoIncrement: true }),
   type: text('type').notNull(), // image | video
+  animaticVersionId: integer('animatic_version_id'),
+  previsItemKey: text('previs_item_key'),
   storyboardId: integer('storyboard_id'),
   dramaId: integer('drama_id'),
   sceneId: integer('scene_id'),
diff --git a/backend/src/db/sqlite-schema.ts b/backend/src/db/sqlite-schema.ts
index ac18882..34d235b 100644
--- a/backend/src/db/sqlite-schema.ts
+++ b/backend/src/db/sqlite-schema.ts
@@ -5,6 +5,7 @@
  * - 种子语句去掉 FROM DUAL（SQLite 非法），幂等语义（WHERE NOT EXISTS）保留
  */
 import type Database from 'better-sqlite3'
+import { initPrevisSchema } from './previs-schema.js'
 
 export const sqliteSchemaStatements = [
   `CREATE TABLE IF NOT EXISTS dramas (
@@ -114,6 +115,8 @@ export const sqliteSchemaStatements = [
     updated_at TEXT NOT NULL,
     deleted_at TEXT
   )`,
+  `CREATE INDEX IF NOT EXISTS idx_storyboards_episode_active_order
+    ON storyboards (episode_id, deleted_at, storyboard_number)`,
 
   `CREATE TABLE IF NOT EXISTS episode_characters (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
@@ -225,6 +228,10 @@ export const sqliteSchemaStatements = [
   `CREATE INDEX IF NOT EXISTS idx_sys_task_type ON sys_task (type)`,
   `CREATE INDEX IF NOT EXISTS idx_sys_task_drama_id ON sys_task (drama_id)`,
   `CREATE INDEX IF NOT EXISTS idx_sys_task_storyboard_id ON sys_task (storyboard_id)`,
+  `CREATE INDEX IF NOT EXISTS idx_sys_task_character_id ON sys_task (character_id)`,
+  `CREATE INDEX IF NOT EXISTS idx_sys_task_scene_id ON sys_task (scene_id)`,
+  `CREATE INDEX IF NOT EXISTS idx_sys_task_prop_id ON sys_task (prop_id)`,
+  `CREATE INDEX IF NOT EXISTS idx_sys_task_created_at ON sys_task (created_at DESC, id DESC)`,
 
   `CREATE TABLE IF NOT EXISTS video_merges (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
@@ -378,6 +385,7 @@ export function initSqliteSchema(sqlite: Database.Database) {
   for (const statement of sqliteSchemaStatements) {
     sqlite.exec(statement)
   }
+  initPrevisSchema(sqlite)
   const insertSeed = sqlite.prepare(SEED_SQL)
   const upgradeSeed = sqlite.prepare(UPGRADE_SQL)
   const removeSeed = sqlite.prepare(REMOVE_SQL)
diff --git a/backend/src/index.ts b/backend/src/index.ts
index 87ebc39..be58e6f 100644
--- a/backend/src/index.ts
+++ b/backend/src/index.ts
@@ -23,9 +23,12 @@ import props from './routes/props.js'
 import settings from './routes/settings.js'
 import storage from './routes/storage.js'
 import serverUpdate from './routes/serverUpdate.js'
+import previs from './routes/previs.js'
+import { startPrevisWorker } from './services/previs-batch.js'
 import { requestLogger, errorHandler } from './middleware/logger.js'
+import { serveStaticRanges } from './middleware/static-range.js'
 import { db, schema } from './db/index.js'
-import { eq } from 'drizzle-orm'
+import { and, eq, isNull } from 'drizzle-orm'
 import { now } from './utils/response.js'
 import { DATA_ROOT } from './utils/paths.js'
 
@@ -69,6 +72,7 @@ api.route('/props', props)
 api.route('/storage', storage)
 api.route('/settings', settings)
 api.route('/server-update', serverUpdate)
+api.route('/', previs)
 
 app.route('/api/v1', api)
 
@@ -78,6 +82,7 @@ app.use('/static/*', async (c, next) => {
   await next()
   if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
 })
+app.use('/static/*', serveStaticRanges(DATA_ROOT))
 app.use('/static/*', serveStatic({ root: DATA_ROOT }))
 
 // Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
@@ -92,7 +97,7 @@ console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)
 // 启动时统一标记为 failed,避免前端一直显示"生成中"
 db.update(schema.sysTask)
   .set({ status: 'failed', errorMsg: '服务重启，生成任务中断，请重试', updatedAt: now() })
-  .where(eq(schema.sysTask.status, 'processing'))
+  .where(and(eq(schema.sysTask.status, 'processing'), isNull(schema.sysTask.previsItemKey)))
   .then(res => {
     const affected = res?.changes ?? 0
     if (affected > 0) console.log(`🔁 已清理 ${affected} 个中断的生成任务`)
@@ -100,3 +105,4 @@ db.update(schema.sysTask)
   .catch(err => console.error('清理中断任务失败:', err?.message))
 
 serve({ fetch: app.fetch, port })
+void startPrevisWorker().catch(err => console.error('Previs worker startup failed:', err.message))
diff --git a/backend/src/middleware/static-range.ts b/backend/src/middleware/static-range.ts
new file mode 100644
index 0000000..687bd48
--- /dev/null
+++ b/backend/src/middleware/static-range.ts
@@ -0,0 +1,75 @@
+import { createReadStream } from 'node:fs'
+import { stat } from 'node:fs/promises'
+import path from 'node:path'
+import { Readable } from 'node:stream'
+import type { MiddlewareHandler } from 'hono'
+import { getMimeType } from 'hono/utils/mime'
+
+export interface ByteRange {
+  start: number
+  end: number
+}
+
+export function parseByteRange(value: string, size: number): ByteRange | null {
+  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
+  if (!match || size <= 0 || (!match[1] && !match[2])) return null
+
+  if (!match[1]) {
+    const suffixLength = Number(match[2])
+    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
+    return { start: Math.max(0, size - suffixLength), end: size - 1 }
+  }
+
+  const start = Number(match[1])
+  const requestedEnd = match[2] ? Number(match[2]) : size - 1
+  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
+    || start < 0 || start >= size || requestedEnd < start) return null
+  return { start, end: Math.min(requestedEnd, size - 1) }
+}
+
+export function serveStaticRanges(root: string): MiddlewareHandler {
+  const resolvedRoot = path.resolve(root)
+  return async (c, next) => {
+    const rangeHeader = c.req.header('range')
+    if (c.req.method !== 'GET' || !rangeHeader?.startsWith('bytes=')) return next()
+
+    let relativePath: string
+    try {
+      relativePath = decodeURIComponent(c.req.path).replace(/^\/+/, '')
+    } catch {
+      return next()
+    }
+    const filePath = path.resolve(resolvedRoot, relativePath)
+    if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) return next()
+
+    let size: number
+    let modifiedAt: Date
+    try {
+      const file = await stat(filePath)
+      if (!file.isFile()) return next()
+      size = file.size
+      modifiedAt = file.mtime
+    } catch {
+      return next()
+    }
+
+    const range = parseByteRange(rangeHeader, size)
+    if (!range) {
+      return new Response(null, {
+        status: 416,
+        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` },
+      })
+    }
+
+    const stream = Readable.toWeb(createReadStream(filePath, range)) as unknown as BodyInit
+    const headers = new Headers({
+      'Accept-Ranges': 'bytes',
+      'Content-Length': String(range.end - range.start + 1),
+      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
+      'Last-Modified': modifiedAt.toUTCString(),
+    })
+    const mimeType = getMimeType(filePath)
+    if (mimeType) headers.set('Content-Type', mimeType)
+    return new Response(stream, { status: 206, headers })
+  }
+}
diff --git a/backend/src/routes/previs.ts b/backend/src/routes/previs.ts
new file mode 100644
index 0000000..38a8db5
--- /dev/null
+++ b/backend/src/routes/previs.ts
@@ -0,0 +1,69 @@
+import { Hono } from 'hono'
+import { z } from 'zod'
+import { success, created } from '../utils/response.js'
+import {
+  createVersion, getVersion, getVersionState, getWorkspace, getWorkspaceState,
+  listVersions, saveTimeline, checkOrLock, PrevisError,
+} from '../services/previs.js'
+import { createBatch, updateBatch, videoCapabilities } from '../services/previs-batch.js'
+import { listContinuityReviews, reviewContinuity } from '../services/continuity-review.js'
+
+const app = new Hono()
+const positiveId = z.number().int().positive()
+const revision = z.number().int().positive()
+app.onError((err, c) => {
+  const status = err instanceof PrevisError ? err.status : 400
+  const message = err instanceof z.ZodError ? `请求数据无效：${err.issues[0]?.message}` : err.message
+  return c.json({ code: status, message }, status)
+})
+app.get('/previs/capabilities', c => success(c, { enabled: process.env.PREVIS_ENABLED !== 'false', video: videoCapabilities }))
+app.get('/episodes/:id/animatic-versions', c => success(c, listVersions(Number(c.req.param('id')))))
+app.get('/episodes/:id/production-workspace', c => success(c, getWorkspace(Number(c.req.param('id')))))
+app.get('/episodes/:id/production-workspace-state', c => success(c,
+  getWorkspaceState(Number(c.req.param('id')), Number(c.req.query('version_id')))))
+app.post('/episodes/:id/animatic-versions', async c => {
+  const body = z.object({ sourceId: positiveId.optional() }).parse(await c.req.json())
+  return created(c, createVersion(Number(c.req.param('id')), body.sourceId))
+})
+app.get('/animatic-versions/:id/timeline', c => success(c, getVersion(Number(c.req.param('id')))))
+app.get('/animatic-versions/:id/state', c => success(c, getVersionState(Number(c.req.param('id')))))
+app.get('/animatic-versions/:id/continuity-reviews', c =>
+  success(c, listContinuityReviews(Number(c.req.param('id')))))
+app.put('/animatic-versions/:id/timeline', async c => {
+  const body = z.object({ revision, timeline: z.unknown() }).parse(await c.req.json())
+  return success(c, saveTimeline(Number(c.req.param('id')), body.revision, body.timeline))
+})
+app.post('/animatic-versions/:id/continuity-reviews', async c => {
+  const body = z.object({
+    revision,
+    toGroupId: z.string().min(1).max(100),
+    configId: positiveId.optional(),
+    model: z.string().trim().min(1).max(200).optional(),
+    force: z.boolean().optional(),
+  }).parse(await c.req.json())
+  return created(c, await reviewContinuity(Number(c.req.param('id')), body))
+})
+for (const action of ['check', 'lock'] as const) {
+  app.post(`/animatic-versions/:id/${action}`, async c => {
+    const body = z.object({ revision }).parse(await c.req.json())
+    return success(c, checkOrLock(Number(c.req.param('id')), body.revision, action === 'lock'))
+  })
+}
+app.post('/animatic-versions/:id/batch-runs', async c => {
+  const body = z.object({
+    revision, type: z.enum(['image', 'video']), configId: positiveId.optional(), model: z.string().max(200).optional(),
+    panelIds: z.array(positiveId).max(1000).optional(),
+    frameTypes: z.array(z.enum(['start', 'middle', 'end', 'beat'])).min(1).max(4).optional(),
+    frameIds: z.array(z.string().min(1).max(100)).min(1).max(1000).optional(), force: z.boolean().optional(),
+    generationMode: z.enum(['direct', 'storyboard_frames']).optional(),
+  }).parse(await c.req.json())
+  if (process.env.PREVIS_ENABLED === 'false') throw new PrevisError('动态故事版功能已关闭')
+  return created(c, await createBatch(Number(c.req.param('id')), body))
+})
+for (const action of ['retry', 'cancel'] as const) {
+  app.post(`/batch-runs/:id/${action}`, async c => {
+    const body = z.object({ itemIds: z.array(positiveId).optional() }).parse(await c.req.json())
+    return success(c, updateBatch(Number(c.req.param('id')), action, body.itemIds))
+  })
+}
+export default app
diff --git a/backend/src/routes/tasks.ts b/backend/src/routes/tasks.ts
index 700e0a4..adaf0d6 100644
--- a/backend/src/routes/tasks.ts
+++ b/backend/src/routes/tasks.ts
@@ -1,5 +1,5 @@
 import { Hono } from 'hono'
-import { eq } from 'drizzle-orm'
+import { and, desc, eq, type SQL } from 'drizzle-orm'
 import { db, schema } from '../db/index.js'
 import { success, created, badRequest } from '../utils/response.js'
 import { generateImage, generateVideo } from '../services/generation.js'
@@ -219,13 +219,37 @@ app.get('/', async (c) => {
   const type = c.req.query('type')
   const storyboardId = c.req.query('storyboard_id')
   const dramaId = c.req.query('drama_id')
+  const characterId = c.req.query('character_id')
+  const sceneId = c.req.query('scene_id')
+  const propId = c.req.query('prop_id')
+  const requestedLimit = Number(c.req.query('limit'))
+  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
+    ? Math.min(requestedLimit, 500)
+    : 200
+  const numericFilters = [
+    ['storyboard_id', storyboardId],
+    ['drama_id', dramaId],
+    ['character_id', characterId],
+    ['scene_id', sceneId],
+    ['prop_id', propId],
+  ] as const
+  if (numericFilters.some(([, value]) =>
+    value !== undefined && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0))) {
+    return badRequest(c, '筛选 ID 必须为正整数')
+  }
 
-  let rows = await db.select().from(schema.sysTask)
-
-  if (type) rows = rows.filter(r => r.type === type)
-  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
-  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
+  const filters: SQL[] = []
+  if (type) filters.push(eq(schema.sysTask.type, type))
+  if (storyboardId) filters.push(eq(schema.sysTask.storyboardId, Number(storyboardId)))
+  if (dramaId) filters.push(eq(schema.sysTask.dramaId, Number(dramaId)))
+  if (characterId) filters.push(eq(schema.sysTask.characterId, Number(characterId)))
+  if (sceneId) filters.push(eq(schema.sysTask.sceneId, Number(sceneId)))
+  if (propId) filters.push(eq(schema.sysTask.propId, Number(propId)))
 
+  const query = db.select().from(schema.sysTask)
+  const rows = filters.length
+    ? await query.where(and(...filters)).orderBy(desc(schema.sysTask.createdAt), desc(schema.sysTask.id)).limit(limit)
+    : await query.orderBy(desc(schema.sysTask.createdAt), desc(schema.sysTask.id)).limit(limit)
   return success(c, rows)
 })
 
diff --git a/backend/src/services/continuity-review.ts b/backend/src/services/continuity-review.ts
new file mode 100644
index 0000000..0dd2929
--- /dev/null
+++ b/backend/src/services/continuity-review.ts
@@ -0,0 +1,361 @@
+import { Agent } from '@mastra/core/agent'
+import { and, desc, eq } from 'drizzle-orm'
+import { z } from 'zod'
+import { resolveTextModel } from '../agents/index.js'
+import { db, schema } from '../db/index.js'
+import { now } from '../utils/response.js'
+import { parseDataUrl, readImageAsCompressedDataUrl } from '../utils/storage.js'
+import { getActiveConfigId, getConfigById } from './ai.js'
+import {
+  groupPanels, normalizeTimeline, orderedFrames,
+  type ContinuityReview, type ContinuityReviewResult, type Panel, type Timeline,
+} from './previs-domain.js'
+import { hashContent, PrevisError, versionRow } from './previs.js'
+
+const dimensionSchema = z.object({
+  score: z.number().min(0).max(25),
+  comment: z.string().trim().min(1).max(1000),
+})
+export const continuityReviewResultSchema = z.object({
+  overallScore: z.number().min(0).max(100),
+  confidence: z.enum(['high', 'medium', 'low']),
+  summary: z.string().trim().min(1).max(2000),
+  dimensions: z.object({
+    subject: dimensionSchema,
+    scene: dimensionSchema,
+    action: dimensionSchema,
+    camera: dimensionSchema,
+  }),
+  issues: z.array(z.string().trim().min(1).max(1000)).max(8),
+  suggestions: z.array(z.string().trim().min(1).max(1000)).max(8),
+})
+
+interface ReviewPanelContext {
+  group: { id: string; title: string; note: string }
+  panel: {
+    id: number
+    title: string
+    description: string
+    atmosphere: string
+    videoPrompt: string
+    scene: string
+    shotType: string
+    angle: string
+    movement: string
+  }
+  frame: {
+    id: string
+    title: string
+    prompt: string
+    url: string
+  } | null
+  sceneAsset: Record<string, unknown> | null
+  characters: Record<string, unknown>[]
+  props: Record<string, unknown>[]
+}
+
+export interface ContinuityReviewInput {
+  transition: {
+    type: string
+    continuity: string
+    allowedChanges: string[]
+  }
+  from: ReviewPanelContext
+  to: ReviewPanelContext
+}
+
+interface ReviewOptions {
+  revision: number
+  toGroupId: string
+  configId?: number
+  model?: string
+  force?: boolean
+}
+
+interface ReviewerOptions {
+  configId: number
+  model: string
+}
+
+export type ContinuityReviewer = (
+  input: ContinuityReviewInput,
+  options: ReviewerOptions,
+) => Promise<ContinuityReviewResult>
+
+const activeReviews = new Map<number, Promise<ContinuityReview>>()
+const REVIEW_LEASE_MS = 30 * 60 * 1000
+
+function reviewClaimExpired(row: typeof schema.continuityReviews.$inferSelect) {
+  const claimedAt = Date.parse(row.createdAt)
+  return !Number.isFinite(claimedAt) || Date.now() - claimedAt >= REVIEW_LEASE_MS
+}
+
+function panelContext(
+  timeline: Timeline,
+  groupId: string,
+  panel: Panel,
+  framePosition: 'first' | 'last',
+): ReviewPanelContext {
+  const group = timeline.groups.find(item => item.id === groupId)!
+  const frames = orderedFrames(panel).filter(frame => frame.url)
+  const frame = framePosition === 'last' ? frames.at(-1) : frames[0]
+  const scene = panel.sceneId
+    ? db.select().from(schema.scenes).where(eq(schema.scenes.id, panel.sceneId)).get()
+    : null
+  const characters = panel.characterIds.map(characterId =>
+    db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get(),
+  ).filter(Boolean)
+  const props = panel.propIds.map(propId =>
+    db.select().from(schema.props).where(eq(schema.props.id, propId)).get(),
+  ).filter(Boolean)
+  return {
+    group: { id: group.id, title: group.title, note: group.note },
+    panel: {
+      id: panel.id, title: panel.title, description: panel.description,
+      atmosphere: panel.atmosphere, videoPrompt: panel.videoPrompt,
+      scene: panel.scene, shotType: panel.shotType, angle: panel.angle, movement: panel.movement,
+    },
+    frame: frame ? {
+      id: frame.id || frame.type, title: frame.title || '', prompt: frame.prompt,
+      url: frame.url,
+    } : null,
+    sceneAsset: scene ? {
+      id: scene.id, location: scene.location, time: scene.time, prompt: scene.prompt,
+      lighting: scene.lighting, finalPrompt: scene.finalPrompt,
+    } : null,
+    characters: characters.map(item => ({
+      id: item!.id, name: item!.name, appearance: item!.appearance,
+      styling: item!.styling, finalPrompt: item!.finalPrompt,
+    })),
+    props: props.map(item => ({
+      id: item!.id, name: item!.name, type: item!.type,
+      description: item!.description, finalPrompt: item!.finalPrompt,
+    })),
+  }
+}
+
+function reviewInput(timeline: Timeline, toGroupId: string): ContinuityReviewInput {
+  const transition = timeline.transitions.find(item => item.to === toGroupId)
+  if (!transition) throw new PrevisError('首个镜头没有上一镜头，无需进行相邻镜头评分')
+  const fromGroup = timeline.groups.find(item => item.id === transition.from)
+  const toGroup = timeline.groups.find(item => item.id === transition.to)
+  const fromPanel = fromGroup && groupPanels(timeline, fromGroup).at(-1)
+  const toPanel = toGroup && groupPanels(timeline, toGroup)[0]
+  if (!fromGroup || !toGroup || !fromPanel || !toPanel) throw new PrevisError('相邻镜头数据不完整，无法评分')
+  return {
+    transition: {
+      type: transition.type,
+      continuity: transition.continuity,
+      allowedChanges: transition.allowedChanges,
+    },
+    from: panelContext(timeline, fromGroup.id, fromPanel, 'last'),
+    to: panelContext(timeline, toGroup.id, toPanel, 'first'),
+  }
+}
+
+function normalizeReview(value: unknown): ContinuityReviewResult {
+  const parsed = continuityReviewResultSchema.safeParse(value)
+  if (!parsed.success) throw new PrevisError(`AI 连续性评分格式无效：${parsed.error.issues[0]?.message}`)
+  const scores = Object.values(parsed.data.dimensions).map(item => Math.round(item.score))
+  return {
+    ...parsed.data,
+    overallScore: scores.reduce((sum, score) => sum + score, 0),
+    dimensions: Object.fromEntries(Object.entries(parsed.data.dimensions).map(([key, item]) => [
+      key, { ...item, score: Math.round(item.score) },
+    ])) as ContinuityReviewResult['dimensions'],
+  }
+}
+
+function parseReview(text: string): ContinuityReviewResult {
+  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
+  const source = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
+  try {
+    return normalizeReview(JSON.parse(source))
+  } catch (error) {
+    if (error instanceof PrevisError) throw error
+    throw new PrevisError('AI 未返回可解析的连续性评分，请重试')
+  }
+}
+
+async function imagePart(url: string) {
+  if (/^https?:\/\//.test(url)) return { type: 'image' as const, image: new URL(url) }
+  const dataUrl = url.startsWith('data:')
+    ? url
+    : await readImageAsCompressedDataUrl(url.replace(/^\/+/, ''), {
+      maxWidth: 1024, maxHeight: 1024, quality: 76,
+    })
+  const parsed = parseDataUrl(dataUrl)
+  if (!parsed) throw new PrevisError('连续性评分图片格式无效')
+  return {
+    type: 'image' as const,
+    image: Buffer.from(parsed.data, 'base64'),
+    mimeType: parsed.mimeType,
+  }
+}
+
+const reviewerInstructions = `你是影视制作中的镜头连续性审核员。请比较上一镜头的结束状态与当前镜头的开始状态。
+只依据给定图片和文字资料判断，不得臆造画外信息。场景切换、建立镜头、声音桥及明确允许的变化不应被误判为穿帮。
+四项各 0-25 分：subject=人物与关键道具，scene=场景、时间与光线，action=动作、姿态、视线与方向，camera=构图、景别与机位衔接。
+overallScore 必须等于四项之和。图片缺失时仍可依据文字评分，但 confidence 必须为 low，并在 summary 中说明依据有限。
+issues 只列明确问题，没有则返回空数组；suggestions 给出可直接修改分镜或提示词的建议。
+只输出一个 JSON 对象，不要 Markdown，不要代码围栏，不要补充解释。`
+
+export const runContinuityReviewer: ContinuityReviewer = async (input, options) => {
+  const model = await resolveTextModel(options.model, options.configId)
+  const agent = new Agent({
+    id: 'continuity-reviewer',
+    name: '镜头连续性审核',
+    instructions: reviewerInstructions,
+    model,
+  })
+  const content: any[] = [{
+    type: 'text',
+    text: `请评估以下相邻镜头。结构化资料：\n${JSON.stringify(input, null, 2)}`,
+  }]
+  if (input.from.frame?.url) {
+    content.push({ type: 'text', text: '上一镜头的最后一张可用画面：' })
+    content.push(await imagePart(input.from.frame.url))
+  }
+  if (input.to.frame?.url) {
+    content.push({ type: 'text', text: '当前镜头的第一张可用画面：' })
+    content.push(await imagePart(input.to.frame.url))
+  }
+  const response = await agent.generate([{ role: 'user', content }], { maxSteps: 1 })
+  return parseReview(response.text)
+}
+
+function serializeReview(
+  row: typeof schema.continuityReviews.$inferSelect,
+  input: ContinuityReviewInput,
+  cached: boolean,
+): ContinuityReview {
+  return {
+    id: row.id,
+    versionId: row.versionId,
+    fromGroupId: row.fromGroupId,
+    toGroupId: row.toGroupId,
+    inputHash: row.inputHash,
+    configId: row.configId,
+    model: row.model,
+    result: continuityReviewResultSchema.parse(JSON.parse(row.resultJson)),
+    images: { from: !!input.from.frame?.url, to: !!input.to.frame?.url },
+    createdAt: row.createdAt,
+    cached,
+  }
+}
+
+export function listContinuityReviews(versionId: number): ContinuityReview[] {
+  const row = versionRow(versionId)
+  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
+  const rows = db.select().from(schema.continuityReviews)
+    .where(eq(schema.continuityReviews.versionId, versionId))
+    .orderBy(desc(schema.continuityReviews.id)).all()
+  const currentInputs = new Map(timeline.transitions.map(transition => {
+    const input = reviewInput(timeline, transition.to)
+    return [`${transition.from}:${transition.to}:${hashContent(input)}`, input] as const
+  }))
+  return rows.flatMap(review => {
+    if (review.status !== 'completed') return []
+    const input = currentInputs.get(`${review.fromGroupId}:${review.toGroupId}:${review.inputHash}`)
+    if (!input) return []
+    try { return [serializeReview(review, input, true)] }
+    catch { return [] }
+  })
+}
+
+export async function reviewContinuity(
+  versionId: number,
+  options: ReviewOptions,
+  reviewer: ContinuityReviewer = runContinuityReviewer,
+): Promise<ContinuityReview> {
+  const row = versionRow(versionId)
+  if (row.revision !== options.revision) throw new PrevisError('版本已更新，请刷新后重新评分', 409)
+  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
+  const input = reviewInput(timeline, options.toGroupId)
+  const inputHash = hashContent(input)
+  const identity = and(
+    eq(schema.continuityReviews.versionId, versionId),
+    eq(schema.continuityReviews.fromGroupId, input.from.group.id),
+    eq(schema.continuityReviews.toGroupId, input.to.group.id),
+    eq(schema.continuityReviews.inputHash, inputHash),
+  )
+  const prior = db.select().from(schema.continuityReviews).where(identity).get()
+  if (prior?.status === 'completed' && !options.force) return serializeReview(prior, input, true)
+  if (prior?.status === 'processing' && !reviewClaimExpired(prior)) {
+    const running = activeReviews.get(prior.id)
+    if (running) return { ...await running, cached: true }
+    throw new PrevisError('该镜头边界正在评分，请稍后刷新结果', 409)
+  }
+
+  const configId = options.configId || await getActiveConfigId('text')
+  if (!configId) throw new PrevisError('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
+  const configRow = db.select().from(schema.aiServiceConfigs)
+    .where(eq(schema.aiServiceConfigs.id, configId)).get()
+  if (!configRow?.isActive || configRow.serviceType !== 'text') throw new PrevisError('所选文本模型配置不可用')
+  const config = await getConfigById(configId)
+  if (!config) throw new PrevisError('所选文本模型配置不可用')
+  const model = options.model || config.model
+  if (!model) throw new PrevisError('所选文本模型没有可用模型')
+
+  const claim = db.transaction(tx => {
+    const current = tx.select().from(schema.continuityReviews).where(identity).get()
+    if (current?.status === 'processing' && !reviewClaimExpired(current)) {
+      return { id: current.id, owner: false, row: current }
+    }
+    if (current?.status === 'completed' && !options.force) return { id: current.id, owner: false, row: current }
+    const values = {
+      versionId,
+      fromGroupId: input.from.group.id,
+      toGroupId: input.to.group.id,
+      inputHash,
+      configId,
+      model,
+      status: 'processing',
+      error: null,
+      createdAt: now(),
+    }
+    if (current) {
+      tx.update(schema.continuityReviews).set(values)
+        .where(eq(schema.continuityReviews.id, current.id)).run()
+      return { id: current.id, owner: true, row: null }
+    }
+    const id = Number(tx.insert(schema.continuityReviews).values({ ...values, resultJson: '' }).run().lastInsertRowid)
+    return { id, owner: true, row: null }
+  })
+  if (!claim.owner) {
+    if (claim.row?.status === 'completed') return serializeReview(claim.row, input, true)
+    const running = activeReviews.get(claim.id)
+    if (running) return { ...await running, cached: true }
+    throw new PrevisError('该镜头边界正在评分，请稍后刷新结果', 409)
+  }
+
+  const execution = (async () => {
+    try {
+      const result = normalizeReview(await reviewer(input, { configId, model }))
+      if (!input.from.frame?.url || !input.to.frame?.url) {
+        result.confidence = 'low'
+        if (!/图片|画面|文字/.test(result.summary)) result.summary = `边界画面不完整；${result.summary}`
+      }
+      if (versionRow(versionId).revision !== options.revision) {
+        throw new PrevisError('评分期间版本已更新，本次结果未保存，请重新评分', 409)
+      }
+      db.update(schema.continuityReviews).set({
+        status: 'completed', resultJson: JSON.stringify(result), error: null, createdAt: now(),
+      }).where(eq(schema.continuityReviews.id, claim.id)).run()
+      const saved = db.select().from(schema.continuityReviews)
+        .where(eq(schema.continuityReviews.id, claim.id)).get()!
+      return serializeReview(saved, input, false)
+    } catch (error: any) {
+      db.update(schema.continuityReviews).set({
+        status: 'failed', error: error?.message || '连续性评分失败',
+      }).where(eq(schema.continuityReviews.id, claim.id)).run()
+      throw error
+    }
+  })()
+  activeReviews.set(claim.id, execution)
+  try {
+    return await execution
+  } finally {
+    if (activeReviews.get(claim.id) === execution) activeReviews.delete(claim.id)
+  }
+}
diff --git a/backend/src/services/ffmpeg-merge.ts b/backend/src/services/ffmpeg-merge.ts
index 1cc0241..222a290 100644
--- a/backend/src/services/ffmpeg-merge.ts
+++ b/backend/src/services/ffmpeg-merge.ts
@@ -11,6 +11,7 @@ import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger
 import { extractVideoPoster } from '../utils/video-poster.js'
 import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
 import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
+import { getVersion, listVersions } from './previs.js'
 
 function toAbsPath(relativePath: string): string {
   if (path.isAbsolute(relativePath)) return relativePath
@@ -27,6 +28,29 @@ export async function mergeEpisodeVideos(episodeId: number, dramaId: number, sto
   let storyboards = await db.select().from(schema.storyboards)
     .where(eq(schema.storyboards.episodeId, episodeId))
     .orderBy(schema.storyboards.storyboardNumber)
+  const current = listVersions(episodeId)[0]
+  if (current) {
+    const version = getVersion(current.id)
+    const selected = storyboardIds?.length ? new Set(storyboardIds.map(Number)) : null
+    const outputs = version.outputs.filter(output => !output.stale
+      && (!selected || output.panelIds.some(id => selected.has(id))))
+    const claimed = new Set(outputs.flatMap(output => output.panelIds))
+    const tracked = new Set(version.outputs.flatMap(output => output.panelIds))
+    const clips = [
+      ...outputs.map(output => ({
+        order: version.timeline.panels.findIndex(p => p.id === output.panelIds[0]),
+        label: output.panelIds.map(id => `S${version.timeline.panels.findIndex(p => p.id === id) + 1}`).join('/'),
+        url: output.url,
+      })),
+      ...version.timeline.panels.filter(panel => !claimed.has(panel.id) && !tracked.has(panel.id) && (!selected || selected.has(panel.id)))
+        .map(panel => {
+          const order = version.timeline.panels.findIndex(item => item.id === panel.id)
+          const source = storyboards.find(sb => sb.id === panel.id)
+          return { order, label: `S${order + 1}`, url: source?.videoUrl || source?.composedVideoUrl || '' }
+        }).filter(clip => clip.url),
+    ].sort((a, b) => a.order - b.order)
+    if (clips.length) return mergeClips(episodeId, dramaId, clips)
+  }
 
   if (storyboardIds?.length) {
     const allow = new Set(storyboardIds.map(Number))
@@ -35,9 +59,13 @@ export async function mergeEpisodeVideos(episodeId: number, dramaId: number, sto
 
   // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
   const clips = storyboards
-    .map(sb => ({ sb, url: sb.videoUrl || sb.composedVideoUrl }))
-    .filter(c => Boolean(c.url)) as { sb: typeof storyboards[number]; url: string }[]
+    .map(sb => ({ label: `S${sb.storyboardNumber}`, url: sb.videoUrl || sb.composedVideoUrl }))
+    .filter(c => Boolean(c.url)) as { label: string; url: string }[]
+
+  return mergeClips(episodeId, dramaId, clips)
+}
 
+async function mergeClips(episodeId: number, dramaId: number, clips: { label: string; url: string }[]) {
   if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')
 
   // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
@@ -51,7 +79,7 @@ export async function mergeEpisodeVideos(episodeId: number, dramaId: number, sto
   // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
   const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
   if (missing.length > 0) {
-    const nums = missing.map(c => `S${c.sb.storyboardNumber}`).join('、')
+    const nums = missing.map(c => c.label).join('、')
     throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
   }
 
diff --git a/backend/src/services/generation.ts b/backend/src/services/generation.ts
index dba4c31..b2aece9 100644
--- a/backend/src/services/generation.ts
+++ b/backend/src/services/generation.ts
@@ -3,7 +3,7 @@
  * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
  */
 import { db, getInsertId, schema } from '../db/index.js'
-import { eq } from 'drizzle-orm'
+import { and, eq, isNotNull } from 'drizzle-orm'
 import { getActiveConfig, getConfigById } from './ai.js'
 import { now } from '../utils/response.js'
 import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
@@ -38,6 +38,7 @@ const LONG_TASK_AGENT = new Agent({
 })
 
 interface GenerateImageParams {
+  previs?: { versionId: number; itemKey: string }
   storyboardId?: number
   dramaId?: number
   sceneId?: number
@@ -52,6 +53,7 @@ interface GenerateImageParams {
 }
 
 interface GenerateVideoParams {
+  previs?: { versionId: number; itemKey: string }
   storyboardId?: number
   dramaId?: number
   prompt: string
@@ -83,6 +85,8 @@ export async function generateImage(params: GenerateImageParams): Promise<number
   if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')
 
   const id = await createTask('image', config, {
+    animaticVersionId: params.previs?.versionId,
+    previsItemKey: params.previs?.itemKey,
     storyboardId: params.storyboardId,
     dramaId: params.dramaId,
     sceneId: params.sceneId,
@@ -91,6 +95,7 @@ export async function generateImage(params: GenerateImageParams): Promise<number
     prompt: params.prompt,
     model: params.model || config.model,
   }, {
+    configId: params.configId,
     size: params.size || '1920x1080',
     frameType: params.frameType,
     referenceImages: params.referenceImages,
@@ -105,7 +110,7 @@ export async function generateImage(params: GenerateImageParams): Promise<number
     frameType: params.frameType,
     model: params.model || config.model,
   })
-  logTaskPayload('ImageTask', 'enqueue params', {
+  if (!params.previs) logTaskPayload('ImageTask', 'enqueue params', {
     id,
     config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
     params,
@@ -121,11 +126,14 @@ export async function generateVideo(params: GenerateVideoParams): Promise<number
   if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
 
   const id = await createTask('video', config, {
+    animaticVersionId: params.previs?.versionId,
+    previsItemKey: params.previs?.itemKey,
     storyboardId: params.storyboardId,
     dramaId: params.dramaId,
     prompt: params.prompt,
     model: params.model || config.model,
   }, {
+    configId: params.configId,
     referenceMode: params.referenceMode || 'reference',
     imageUrl: params.imageUrl,
     firstFrameUrl: params.firstFrameUrl,
@@ -153,7 +161,7 @@ export async function generateVideo(params: GenerateVideoParams): Promise<number
     referenceMode: params.referenceMode || 'reference',
     duration: params.duration || 5,
   })
-  logTaskPayload('VideoTask', 'enqueue params', {
+  if (!params.previs) logTaskPayload('VideoTask', 'enqueue params', {
     id,
     config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
     params,
@@ -165,6 +173,8 @@ async function createTask(
   type: TaskType,
   config: AIConfig,
   fields: {
+    animaticVersionId?: number
+    previsItemKey?: string
     storyboardId?: number
     dramaId?: number
     sceneId?: number
@@ -181,19 +191,45 @@ async function createTask(
     ...fields,
     provider: config.provider,
     params: JSON.stringify(params),
-    status: 'processing',
+    status: fields.previsItemKey ? 'pending' : 'processing',
     createdAt: ts,
     updatedAt: ts,
   })
 
   const id = getInsertId(res)
-  processTask(id, config).catch(err => {
+  if (!fields.previsItemKey) processTask(id, config).catch(err => {
     logTaskError(taskLabel(type), 'process', { id, error: err.message })
     console.error(`${taskLabel(type)} ${id} failed:`, err)
   })
   return id
 }
 
+/** Claim before submission. A pending task is safe to resume; an unacknowledged submission is not. */
+export async function startQueuedPrevisTask(id: number) {
+  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
+  if (!record?.previsItemKey || record.status !== 'pending') return
+  const params = parseTaskParams(record.params)
+  const config = await getConfigById(params.configId)
+  if (!config) { await failTask(id, '生成配置已停用，请启用后重试'); return }
+  const claim = db.update(schema.sysTask).set({ status: 'processing', updatedAt: now() })
+    .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.status, 'pending'))).run()
+  if (claim.changes) void processTask(id, config)
+}
+
+export async function recoverPrevisTasks() {
+  const tasks = db.select().from(schema.sysTask)
+    .where(and(isNotNull(schema.sysTask.previsItemKey), eq(schema.sysTask.status, 'processing'))).all()
+  for (const task of tasks) {
+    const config = await getConfigById(parseTaskParams(task.params).configId)
+    if (task.taskId && config) {
+      // Keep the acknowledged external ID; never resubmit a paid request during recovery.
+      void pollTask(task, config, task.taskId)
+    } else {
+      await failTask(task.id, '服务重启时尚未取得外部任务编号，提交结果待确认；请核对服务商记录后手动重试，避免重复扣费')
+    }
+  }
+}
+
 function parseTaskParams(raw: string | null | undefined): Record<string, any> {
   if (!raw) return {}
   try {
@@ -237,6 +273,11 @@ async function processTask(id: number, config: AIConfig) {
       const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(params.firstFrameUrl)
       const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(params.lastFrameUrl)
       const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(params.referenceImageUrls)
+      if (record.animaticVersionId && ((params.firstFrameUrl && !resolvedFirstFrameUrl)
+        || (params.lastFrameUrl && !resolvedLastFrameUrl)
+        || resolvedReferenceImageUrls.length !== new Set(params.referenceImageUrls || []).size)) {
+        throw new Error('选用的分镜画面无法读取，请重新上传或重新选择；本次未提交视频生成')
+      }
       // 参考视频/音频文件较大，不适合 dataURL 内联，需解析为公网可访问 URL
       const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
       const resolvedReferenceAudioUrls = resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
@@ -273,7 +314,7 @@ async function processTask(id: number, config: AIConfig) {
     })
 
     const isMultipart = body instanceof FormData
-    logTaskPayload(label, 'request payload', {
+    if (!record.animaticVersionId) logTaskPayload(label, 'request payload', {
       id, method, url, headers,
       // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
       body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
@@ -496,6 +537,8 @@ async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: stri
 
 // 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
 async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
+  // Version-owned tasks bind through previs-batch, which checks latest intent before updating shared assets.
+  if (record.animaticVersionId) return
   const params = parseTaskParams(record.params)
   if (record.storyboardId) {
     const sbUpdate: Record<string, any> = { updatedAt: now() }
@@ -525,7 +568,7 @@ async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, dura
 
   logTaskSuccess('VideoTask', 'downloaded', { id: record.id, localPath, storyboardId: record.storyboardId, duration })
 
-  if (record.storyboardId) {
+  if (record.storyboardId && !record.animaticVersionId) {
     await db.update(schema.storyboards)
       .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
       .where(eq(schema.storyboards.id, record.storyboardId))
diff --git a/backend/src/services/previs-batch.ts b/backend/src/services/previs-batch.ts
new file mode 100644
index 0000000..6b2df44
--- /dev/null
+++ b/backend/src/services/previs-batch.ts
@@ -0,0 +1,424 @@
+import { and, eq, gt, inArray } from 'drizzle-orm'
+import { db, schema } from '../db/index.js'
+import { getActiveConfigId, getConfigById } from './ai.js'
+import { getImageAdapter, getVideoAdapter } from './adapters/registry.js'
+import { generateImage, generateVideo, recoverPrevisTasks, startQueuedPrevisTask } from './generation.js'
+import { now } from '../utils/response.js'
+import { getDramaStylePrompt } from './style-preset.js'
+import {
+  frameKey, normalizeTimeline, orderedFrames, groupPanels, panelImageFallback,
+  type FrameType, type Timeline, type Panel, type VideoGenerationMode,
+} from './previs-domain.js'
+import { getVersion, hashContent, frameFingerprint, videoFingerprint, isCurrentVersion,
+  PrevisError, readBatches, requireEditable, versionRow, episodeForPrevis } from './previs.js'
+
+/** Reflect the actual adapters: Seedance's current adapter supports reference images only. */
+export const videoCapabilities = {
+  aliyun: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 2, maxSeconds: 30, maxImages: 10, group: true },
+  minimax: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 4, maxSeconds: 15, maxImages: 9, group: true },
+  volcengine: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 4, maxSeconds: 15, maxImages: 9, group: true },
+  nuwax: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 1, maxSeconds: 30, maxImages: 9, group: false },
+} as const
+
+interface BatchOptions {
+  revision: number
+  type: 'image' | 'video'
+  configId?: number
+  model?: string
+  panelIds?: number[]
+  frameTypes?: FrameType[]
+  frameIds?: string[]
+  force?: boolean
+  generationMode?: VideoGenerationMode
+}
+export function videoInputs(
+  t: Timeline,
+  panels: Panel[],
+  provider: string,
+  generationMode: VideoGenerationMode = 'direct',
+) {
+  const cap = videoCapabilities[provider as keyof typeof videoCapabilities]
+  if (!cap) throw new PrevisError('当前视频服务尚未声明预演生成能力')
+  if (t.strategy.mode === 'group' && !cap.group) throw new PrevisError('当前服务不支持按组生成，请改用按分镜生成')
+  const seconds = panels.reduce((s, p) => s + p.durationMs, 0) / 1000
+  if (!Number.isInteger(seconds) || seconds < cap.minSeconds || seconds > cap.maxSeconds) {
+    throw new PrevisError(`「${panels[0].title}」时长 ${seconds} 秒；当前模型要求 ${cap.minSeconds}–${cap.maxSeconds} 的整数秒，请调整时长`)
+  }
+  const allFrames = panels.flatMap(p => orderedFrames(p))
+  if (generationMode === 'storyboard_frames' && !allFrames.length) {
+    throw new PrevisError(`「${panels[0].title}」尚无分镜画面，请先添加并生成画面`)
+  }
+  const missing = generationMode === 'storyboard_frames' ? allFrames.filter(frame => !frame.url) : []
+  if (missing.length) {
+    throw new PrevisError(`「${panels[0].title}」还有 ${missing.length} 张分镜画面未完成，请全部生成或上传后再生成视频`)
+  }
+  const availableReferences = [...new Set(generationMode === 'storyboard_frames'
+    ? allFrames.map(frame => frame.url)
+    : panels.flatMap(panel => panel.referenceImages).filter(Boolean))]
+  if (generationMode === 'storyboard_frames' && availableReferences.length > cap.maxImages) {
+    throw new PrevisError(`「${panels[0].title}」共有 ${availableReferences.length} 张分镜画面，当前模型最多接收 ${cap.maxImages} 张，请减少输入图片`)
+  }
+  // Keep the legacy direct-generation behavior: bound assets beyond the provider limit are ignored.
+  const references = availableReferences.slice(0, cap.maxImages)
+  if (generationMode === 'storyboard_frames' && !(cap.constraints as readonly string[]).includes('reference')) {
+    throw new PrevisError('当前视频模型不支持分镜画面参考模式，请更换模型')
+  }
+  return {
+    generationMode, actualStrategy: generationMode === 'direct' ? 'direct' : 'reference', duration: seconds,
+    firstFrameUrl: undefined, lastFrameUrl: undefined, referenceImageUrls: references,
+  }
+}
+export async function createBatch(versionId: number, options: BatchOptions) {
+  const row = versionRow(versionId)
+  const ep = episodeForPrevis(row.episodeId)
+  const raw = JSON.parse(row.timelineJson)
+  const t = normalizeTimeline(raw)
+  if (row.revision !== options.revision) throw new PrevisError('版本已更新，请刷新后生成', 409)
+  if (row.status === 'locked' && row.contentHash !== hashContent(raw)) throw new PrevisError('锁定版本内容校验失败', 409)
+  if (options.type === 'image') requireEditable(versionId, options.revision)
+  const configId = options.configId || (options.type === 'image' ? ep.imageConfigId : ep.videoConfigId) || await getActiveConfigId(options.type)
+  const configRow = configId ? db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).get() : null
+  if (!configRow?.isActive || configRow.serviceType !== options.type) throw new PrevisError(`请先在设置中启用${options.type === 'image' ? '图片' : '视频'}模型`)
+  const config = await getConfigById(configRow.id)
+  if (!config) throw new PrevisError('生成模型配置不可用')
+  const model = options.model || config.model
+  const generationMode = options.generationMode || 'direct'
+  const allowedModels: string[] = JSON.parse(configRow.model || '[]')
+  if (!allowedModels.includes(model)) throw new PrevisError('所选模型不属于当前服务配置')
+  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).get()
+  const style = await getDramaStylePrompt(ep.dramaId)
+  const items: { groupId: string; panelId: number | null; frameType: FrameType | null; requestJson: string }[] = []
+  if (options.panelIds?.some(id => !t.panels.some(p => p.id === id))) throw new PrevisError('选择的分镜不属于当前版本')
+  for (const group of t.groups) {
+    const allPanels = groupPanels(t, group)
+    const selected = allPanels.filter(p => !options.panelIds?.length || options.panelIds.includes(p.id))
+    // A group job always represents the complete group, including its timing and endpoints.
+    const panels = options.type === 'video' && t.strategy.mode === 'group' && selected.length ? allPanels : selected
+    if (options.type === 'image') {
+      getImageAdapter(config.provider)
+      for (const panel of panels) {
+        for (const frame of panel.frames) {
+          const type = frame.type
+          if (options.frameTypes?.length && !options.frameTypes.includes(type)) continue
+          if (options.frameIds?.length && !options.frameIds.includes(frameKey(frame))) continue
+          if (frame.url && !options.force) continue
+          const referenceImages = frame.referenceImages ?? panel.referenceImages
+          if (!referenceImages.length) {
+            throw new PrevisError(`「${panel.title} / ${frame.title || '分镜画面'}」尚未选择资产参考素材，请先绑定角色、场景或道具图片`)
+          }
+          const referenceLegend = referenceImages.map((url, index) => {
+            const panelIndex = panel.referenceImages.indexOf(url)
+            return `@图片${index + 1}：${panel.referenceLabels?.[panelIndex] || '参考素材'}`
+          })
+          const prompt = [
+            style, ...referenceLegend, frame.prompt || panelImageFallback(panel),
+            `场景：${panel.scene}。景别：${frame.shotType || panel.shotType}。机位：${frame.angle || panel.angle}。运镜：${panel.movement}。构图：${frame.composition || '遵循画面描述'}。`,
+            `画面：${frame.title || '分镜画面'}，位于本段 ${(frame.offsetMs || 0) / 1000} 秒。`,
+            '只绘制一张完整的电影分镜画面，不要拼图、文字、水印。保持参考素材的人物身份、服装、道具与场景一致。',
+          ].filter(Boolean).join('\n')
+          items.push({
+            groupId: group.id, panelId: panel.id, frameType: type,
+            requestJson: JSON.stringify({
+              storyboardId: panel.id, dramaId: ep.dramaId, prompt, model, configId,
+              frameId: frameKey(frame), inputHash: frameFingerprint(frame, panel),
+              frameType: type === 'start' ? 'first_frame' : type === 'end' ? 'last_frame' : 'middle',
+              size: drama?.aspectRatio === '9:16' ? '1080x1920' : '1920x1080',
+              referenceImages,
+            }),
+          })
+        }
+      }
+    } else {
+      for (const unit of t.strategy.mode === 'group' ? (panels.length ? [panels] : []) : panels.map(p => [p])) {
+        const inputs = videoInputs(t, unit, config.provider, generationMode)
+        const referenceLegend = generationMode === 'storyboard_frames'
+          ? unit.flatMap(p => orderedFrames(p).map((frame, i) => {
+            const index = inputs.referenceImageUrls.indexOf(frame.url)
+            return index < 0 ? '' : `@图片${index + 1}：${p.title} / ${frame.title || `画面 ${i + 1}`}`
+          })).filter(Boolean)
+          : unit.flatMap(p => p.referenceImages.map((url, i) => {
+            const index = inputs.referenceImageUrls.indexOf(url)
+            return index < 0 ? '' : `@图片${index + 1}：${p.referenceLabels?.[i] || '绑定素材'}`
+          })).filter(Boolean)
+        const prompt = [style, ...new Set(referenceLegend), ...unit.map(p => {
+          let text = (p.videoPrompt || [p.description, p.atmosphere].filter(Boolean).join('\n')).replace(/@图片(\d+)/g, (_, n) => {
+            const index = inputs.referenceImageUrls.indexOf(p.referenceImages[Number(n) - 1])
+            return index < 0 ? (p.referenceLabels?.[Number(n) - 1] || '') : `@图片${index + 1}`
+          })
+          if (generationMode === 'direct') {
+            const labels = p.referenceImages.map((url, index) => ({
+              label: p.referenceLabels?.[index] || '',
+              inputIndex: inputs.referenceImageUrls.indexOf(url),
+            })).filter(item => item.label && item.inputIndex >= 0).sort((a, b) => b.label.length - a.label.length)
+            text = text.replace(/@([^\s@]+)/g, (whole, raw) => {
+              const match = labels.find(item => raw.startsWith(item.label))
+              return match ? `@图片${match.inputIndex + 1}${raw}` : whole
+            })
+          }
+          return `[${p.durationMs / 1000}秒] ${text}`
+        })].filter(Boolean).join('\n')
+        const request = { ...inputs, storyboardId: t.strategy.mode === 'storyboard' ? unit[0].id : undefined,
+          panelIds: unit.map(p => p.id), inputHash: videoFingerprint(t, unit, generationMode),
+          dramaId: ep.dramaId, prompt, model, configId, aspectRatio: drama?.aspectRatio || '16:9', resolution: ep.resolution || '720p' }
+        // Validate the contract before persisting any jobs or making a paid call.
+        // Static images are converted to data URLs by generation.ts; use web URLs for contract validation only.
+        const validationUrl = (url?: string) => url && /^\/?static\//.test(url) ? `https://local.invalid/${url}` : url
+        getVideoAdapter(config.provider).buildGenerateRequest(config, {
+          ...request, id: 0, firstFrameUrl: validationUrl(request.firstFrameUrl), lastFrameUrl: validationUrl(request.lastFrameUrl),
+          referenceImageUrls: JSON.stringify(request.referenceImageUrls.map(validationUrl)),
+        })
+        items.push({ groupId: group.id, panelId: request.storyboardId || null, frameType: null, requestJson: JSON.stringify(request) })
+      }
+    }
+  }
+  if (!items.length) throw new PrevisError(options.type === 'video'
+    ? '没有可生成的视频镜头'
+    : '没有需要生成的画面；请先添加画面，已有图片会自动跳过')
+  const baseHash = hashContent({ type: options.type, configId, model, items })
+  const prior = db.select().from(schema.batchRuns)
+    .where(and(eq(schema.batchRuns.versionId, versionId), eq(schema.batchRuns.requestHash, baseHash))).get()
+  // Rapid duplicate clicks share an active batch. Once it finishes, the same inputs may be regenerated.
+  const requestHash = prior && !['pending', 'processing'].includes(prior.status)
+    ? hashContent({ baseHash, afterBatch: prior.id, requestedAt: now() })
+    : baseHash
+  db.transaction(tx => {
+    // Config lookup above is asynchronous; recheck revision and locks inside the write transaction.
+    if (options.type === 'image') requireEditable(versionId, options.revision)
+    else if (versionRow(versionId).revision !== options.revision) throw new PrevisError('版本已更新，请刷新后生成', 409)
+    if (tx.select().from(schema.batchRuns).where(and(eq(schema.batchRuns.versionId, versionId), eq(schema.batchRuns.requestHash, requestHash))).get()) return
+    const batchId = Number(tx.insert(schema.batchRuns).values({
+      versionId, type: options.type, requestHash, configId: configRow.id, model, createdAt: now(),
+    }).run().lastInsertRowid)
+    for (const item of items) tx.insert(schema.batchRunItems).values({ ...item, batchId }).run()
+  })
+  void tickPrevisBatches().catch(e => console.error('Previs worker:', e.message))
+  return getVersion(versionId)
+}
+
+/** Completion binding is guarded by the version and batch item, so later drafts cannot be overwritten. */
+function reconcile() {
+  const activeBatches = db.select().from(schema.batchRuns)
+    .where(inArray(schema.batchRuns.status, ['pending', 'processing'])).all()
+  const processingItems = db.select().from(schema.batchRunItems)
+    .where(eq(schema.batchRunItems.status, 'processing')).all()
+  const knownBatchIds = new Set(activeBatches.map(batch => batch.id))
+  const missingBatchIds = [...new Set(processingItems
+    .map(item => item.batchId)
+    .filter(batchId => !knownBatchIds.has(batchId)))]
+  const batches = missingBatchIds.length
+    ? [...activeBatches, ...db.select().from(schema.batchRuns).where(inArray(schema.batchRuns.id, missingBatchIds)).all()]
+    : activeBatches
+  if (!batches.length) return
+  const batchById = new Map(batches.map(batch => [batch.id, batch]))
+  const items = db.select().from(schema.batchRunItems)
+    .where(inArray(schema.batchRunItems.batchId, batches.map(batch => batch.id))).all()
+  const itemsByBatch = new Map<number, typeof items>()
+  for (const item of items) {
+    const group = itemsByBatch.get(item.batchId) || []
+    group.push(item)
+    itemsByBatch.set(item.batchId, group)
+  }
+  const taskIds = [...new Set(processingItems.flatMap(item => item.taskId ? [item.taskId] : []))]
+  const tasks = taskIds.length
+    ? db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, taskIds)).all()
+    : []
+  const taskById = new Map(tasks.map(task => [task.id, task]))
+  const completedFloor = new Map<string, number>()
+  for (const item of processingItems) {
+    const batch = batchById.get(item.batchId)
+    if (!batch || taskById.get(item.taskId || 0)?.status !== 'completed') continue
+    const key = `${batch.versionId}:${batch.type}`
+    completedFloor.set(key, Math.min(completedFloor.get(key) ?? item.id, item.id))
+  }
+  type SiblingItem = Pick<typeof schema.batchRunItems.$inferSelect, 'id' | 'panelId' | 'frameType' | 'requestJson'>
+  const siblingCache = new Map<string, SiblingItem[]>()
+  const siblingsFor = (batch: typeof schema.batchRuns.$inferSelect) => {
+    const key = `${batch.versionId}:${batch.type}`
+    const cached = siblingCache.get(key)
+    if (cached) return cached
+    const siblings = db.select({
+      id: schema.batchRunItems.id,
+      panelId: schema.batchRunItems.panelId,
+      frameType: schema.batchRunItems.frameType,
+      requestJson: schema.batchRunItems.requestJson,
+    }).from(schema.batchRunItems).innerJoin(
+      schema.batchRuns,
+      eq(schema.batchRunItems.batchId, schema.batchRuns.id),
+    ).where(and(
+      eq(schema.batchRuns.versionId, batch.versionId),
+      eq(schema.batchRuns.type, batch.type),
+      gt(schema.batchRunItems.id, completedFloor.get(key) || 0),
+    )).all()
+    siblingCache.set(key, siblings)
+    return siblings
+  }
+  for (const batch of batches) {
+    const batchItems = itemsByBatch.get(batch.id) || []
+    for (const item of batchItems.filter(i => i.status === 'processing')) {
+      const task = item.taskId ? taskById.get(item.taskId) : null
+      if (!task || !['completed', 'failed'].includes(task.status || '')) continue
+      const siblings = task.status === 'completed' ? siblingsFor(batch) : []
+      db.transaction(tx => {
+        if (task.status === 'completed') {
+          const row = tx.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, batch.versionId)).get()
+          if (row) {
+            const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
+            const request = JSON.parse(item.requestJson)
+            const panel = timeline.panels.find(p => p.id === item.panelId)
+            const url = task.localPath || task.resultUrl || ''
+            let changed = false
+            if (batch.type === 'image' && panel && row.status !== 'locked') {
+              const frame = panel.frames.find(f => request.frameId ? frameKey(f) === request.frameId : f.type === item.frameType)
+              const newer = siblings.some(i => i.id > item.id && i.panelId === item.panelId
+                && (JSON.parse(i.requestJson).frameId || i.frameType) === (request.frameId || item.frameType))
+              if (frame && url) {
+                frame.history = [
+                  ...(frame.history || []),
+                  ...(frame.url ? [{ url: frame.url, taskId: frame.taskId }] : []),
+                  { url, taskId: task.id },
+                ].filter((entry, index, all) =>
+                  entry.url && all.findIndex(candidate => candidate.url === entry.url) === index,
+                ).slice(-200)
+                if (!newer && (!request.inputHash || request.inputHash === frameFingerprint(frame, panel))) {
+                  frame.url = url; frame.taskId = task.id
+                  panel.coverFrameId ||= frameKey(frame)
+                }
+                changed = true
+              }
+            } else if (batch.type === 'video' && panel && url) {
+              const newer = siblings.some(i => {
+                const r = JSON.parse(i.requestJson)
+                return i.id > item.id && (r.panelIds || (i.panelId ? [i.panelId] : [])).includes(panel.id)
+              })
+              if (!newer && (!request.inputHash || request.inputHash === videoFingerprint(
+                timeline, [panel], request.generationMode || 'storyboard_frames',
+              ))) {
+                if (row.status !== 'locked') { panel.videoUrl = url; changed = true }
+                if (isCurrentVersion(row.id)) tx.update(schema.storyboards).set({ videoUrl: url, updatedAt: now() })
+                  .where(eq(schema.storyboards.id, panel.id)).run()
+              }
+            }
+            if (changed) {
+              tx.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline), revision: row.revision + 1, status: 'draft', contentHash: null, updatedAt: now() })
+                .where(eq(schema.animaticVersions.id, row.id)).run()
+              if (batch.type === 'image' && panel && isCurrentVersion(row.id)) {
+                const cover = panel.frames.find(f => frameKey(f) === panel.coverFrameId && f.url) || panel.frames.find(f => f.url)
+                tx.update(schema.storyboards).set({
+                  composedImage: cover?.url || null,
+                  firstFrameImage: panel.frames.find(f => f.type === 'start')?.url || null,
+                  lastFrameImage: panel.frames.find(f => f.type === 'end')?.url || null,
+                  updatedAt: now(),
+                }).where(eq(schema.storyboards.id, panel.id)).run()
+              }
+            }
+          }
+        }
+        tx.update(schema.batchRunItems).set({ status: task.status!, error: task.errorMsg }).where(eq(schema.batchRunItems.id, item.id)).run()
+      })
+      item.status = task.status!
+      item.error = task.errorMsg
+    }
+    const states = batchItems.map(item => item.status)
+    const status = batch.status === 'cancelled' ? 'cancelled'
+      : states.some(s => s === 'pending' || s === 'processing') ? 'processing'
+      : states.some(s => s === 'failed') ? 'partial_failed' : 'completed'
+    if (status !== batch.status) db.update(schema.batchRuns).set({ status }).where(eq(schema.batchRuns.id, batch.id)).run()
+  }
+}
+let ticking = false
+export async function tickPrevisBatches() {
+  if (ticking) return
+  ticking = true
+  try {
+    reconcile()
+    const batches = db.select().from(schema.batchRuns)
+      .where(inArray(schema.batchRuns.status, ['pending', 'processing'])).all()
+    const processingItems = db.select().from(schema.batchRunItems)
+      .where(eq(schema.batchRunItems.status, 'processing')).all()
+    const processingBatchIds = [...new Set(processingItems.map(item => item.batchId))]
+    const processingBatches = processingBatchIds.length
+      ? db.select().from(schema.batchRuns).where(inArray(schema.batchRuns.id, processingBatchIds)).all()
+      : []
+    const processingBatchById = new Map(processingBatches.map(batch => [batch.id, batch]))
+    const activeByConfig = new Map<number, number>()
+    // Cancelled batches may still have already-submitted work occupying a slot.
+    for (const item of processingItems) {
+      const batch = processingBatchById.get(item.batchId)
+      if (batch) activeByConfig.set(batch.configId, (activeByConfig.get(batch.configId) || 0) + 1)
+    }
+    const batchIds = batches.map(batch => batch.id)
+    const pendingItems = batchIds.length
+      ? db.select().from(schema.batchRunItems).where(and(
+        inArray(schema.batchRunItems.batchId, batchIds),
+        eq(schema.batchRunItems.status, 'pending'),
+      )).all()
+      : []
+    const pendingByBatch = new Map<number, typeof pendingItems>()
+    for (const item of pendingItems) {
+      const group = pendingByBatch.get(item.batchId) || []
+      group.push(item)
+      pendingByBatch.set(item.batchId, group)
+    }
+    const itemKeys = pendingItems.map(item => `${item.id}:${item.attempt}`)
+    const existingTasks = itemKeys.length
+      ? db.select().from(schema.sysTask).where(inArray(schema.sysTask.previsItemKey, itemKeys)).all()
+      : []
+    const existingTaskByKey = new Map(existingTasks.map(task => [task.previsItemKey, task]))
+    for (const batch of batches) {
+      for (const item of pendingByBatch.get(batch.id) || []) {
+        if ((activeByConfig.get(batch.configId) || 0) >= 2) continue
+        if (db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batch.id)).get()?.status === 'cancelled') break
+        if (db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, item.id)).get()?.status !== 'pending') continue
+        try {
+          const itemKey = `${item.id}:${item.attempt}`
+          const existing = existingTaskByKey.get(itemKey)
+          const request = { ...JSON.parse(item.requestJson), previs: { versionId: batch.versionId, itemKey } }
+          const taskId = existing?.id || await (batch.type === 'image' ? generateImage(request) : generateVideo(request))
+          const latestItem = db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, item.id)).get()
+          const latestBatch = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batch.id)).get()
+          if (latestItem?.status !== 'pending' || latestBatch?.status === 'cancelled') {
+            db.update(schema.sysTask).set({ status: 'cancelled' })
+              .where(and(eq(schema.sysTask.id, taskId), eq(schema.sysTask.status, 'pending'))).run()
+            continue
+          }
+          db.update(schema.batchRunItems).set({ taskId, status: 'processing' }).where(eq(schema.batchRunItems.id, item.id)).run()
+          activeByConfig.set(batch.configId, (activeByConfig.get(batch.configId) || 0) + 1)
+          await startQueuedPrevisTask(taskId)
+        } catch (e: any) {
+          db.update(schema.batchRunItems).set({ status: 'failed', error: e.message }).where(eq(schema.batchRunItems.id, item.id)).run()
+        }
+      }
+    }
+    reconcile()
+  } finally { ticking = false }
+}
+export function updateBatch(batchId: number, action: 'retry' | 'cancel', itemIds?: number[]) {
+  const batch = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batchId)).get()
+  if (!batch) throw new PrevisError('批次不存在', 404)
+  const row = versionRow(batch.versionId)
+  if (action === 'retry' && batch.type === 'image') requireEditable(row.id, row.revision)
+  db.transaction(tx => {
+    const items = tx.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.batchId, batchId)).all()
+    for (const item of items) {
+      if (itemIds?.length && !itemIds.includes(item.id)) continue
+      if (action === 'retry' && item.status === 'failed') tx.update(schema.batchRunItems)
+        .set({ status: 'pending', error: null, taskId: null, attempt: item.attempt + 1 }).where(eq(schema.batchRunItems.id, item.id)).run()
+      if (action === 'cancel' && item.status === 'pending') tx.update(schema.batchRunItems)
+        .set({ status: 'cancelled' }).where(eq(schema.batchRunItems.id, item.id)).run()
+    }
+    tx.update(schema.batchRuns).set({ status: action === 'cancel' ? 'cancelled' : 'pending' }).where(eq(schema.batchRuns.id, batchId)).run()
+  })
+  return readBatches(batch.versionId).find(b => b.id === batchId)
+}
+export async function startPrevisWorker() {
+  await recoverPrevisTasks()
+  // A crash can leave a linked but not yet started task. Resume these without creating a new task.
+  for (const item of db.select().from(schema.batchRunItems)
+    .where(eq(schema.batchRunItems.status, 'processing')).all().filter(item => item.taskId)) {
+    await startQueuedPrevisTask(item.taskId!)
+  }
+  await tickPrevisBatches()
+  const timer = setInterval(() => { void tickPrevisBatches().catch(e => console.error('Previs worker:', e.message)) }, 1500)
+  timer.unref()
+  return () => clearInterval(timer)
+}
diff --git a/backend/src/services/previs-domain.ts b/backend/src/services/previs-domain.ts
new file mode 100644
index 0000000..17473a7
--- /dev/null
+++ b/backend/src/services/previs-domain.ts
@@ -0,0 +1,348 @@
+/** Version-owned production data. Times are integer milliseconds throughout. */
+export type FrameType = 'start' | 'middle' | 'end' | 'beat'
+export type VideoGenerationMode = 'direct' | 'storyboard_frames'
+export type VideoConstraint = 'auto' | 'text' | 'reference' | 'first' | 'first_last'
+export interface PanelGeneration {
+  constraint: VideoConstraint
+  includeAssets: boolean
+}
+export type ContinuityState = Record<string, string>
+export interface Keyframe {
+  id?: string
+  title?: string
+  offsetMs?: number
+  useForVideo?: boolean
+  history?: { url: string; taskId?: number }[]
+  referenceImages?: string[]
+  shotType?: string
+  angle?: string
+  composition?: string
+  type: FrameType
+  url: string
+  prompt: string
+  locked: boolean
+  taskId?: number
+}
+export interface Panel {
+  id: number
+  title: string
+  description: string
+  atmosphere: string
+  imagePrompt: string
+  videoPrompt: string
+  durationMs: number
+  sceneId: number | null
+  scene: string
+  shotType: string
+  angle: string
+  movement: string
+  characterIds: number[]
+  propIds: number[]
+  referenceImages: string[]
+  referenceLabels?: string[]
+  sourceFingerprint?: string
+  generation?: PanelGeneration
+  coverFrameId?: string
+  videoUrl: string
+  frames: Keyframe[]
+}
+export interface StoryboardGroup {
+  id: string
+  title: string
+  note: string
+  panelIds: number[]
+  entry: ContinuityState
+  exit: ContinuityState
+}
+export interface Transition {
+  from: string
+  to: string
+  type: 'cut' | 'match_cut' | 'occlusion' | 'insert' | 'establishing' | 'audio_bridge'
+  continuity: 'strong' | 'normal' | 'scene_change'
+  allowedChanges: string[]
+}
+export interface AudioClip {
+  id: string
+  type: 'dialogue' | 'narration' | 'sound'
+  panelId: number | null
+  character: string
+  text: string
+  url: string
+  startMs: number
+  durationMs: number
+}
+export interface GenerationStrategy {
+  mode: 'storyboard' | 'group'
+  constraint: VideoConstraint
+  fallback: 'first' | 'reference' | 'text'
+  minDurationMs: number
+  maxDurationMs: number
+}
+export interface Timeline {
+  schemaVersion: 1 | 2
+  groups: StoryboardGroup[]
+  panels: Panel[]
+  transitions: Transition[]
+  audio: AudioClip[]
+  strategy: GenerationStrategy
+  acknowledgements: Record<string, string>
+  inheritedOutputs?: VideoOutput[]
+}
+export interface ContinuityIssue {
+  id: string
+  severity: 'fail' | 'warning'
+  rule: string
+  message: string
+  groupId: string
+  panelId?: number
+  fromGroupId?: string
+  field?: string
+  reason?: string
+}
+export type ContinuityReviewConfidence = 'high' | 'medium' | 'low'
+export interface ContinuityReviewDimension {
+  score: number
+  comment: string
+}
+export interface ContinuityReviewResult {
+  overallScore: number
+  confidence: ContinuityReviewConfidence
+  summary: string
+  dimensions: {
+    subject: ContinuityReviewDimension
+    scene: ContinuityReviewDimension
+    action: ContinuityReviewDimension
+    camera: ContinuityReviewDimension
+  }
+  issues: string[]
+  suggestions: string[]
+}
+export interface ContinuityReview {
+  id: number
+  versionId: number
+  fromGroupId: string
+  toGroupId: string
+  inputHash: string
+  configId: number
+  model: string
+  result: ContinuityReviewResult
+  images: { from: boolean; to: boolean }
+  createdAt: string
+  cached: boolean
+}
+export interface AnimaticVersion {
+  id: number
+  episodeId: number
+  versionNo: number
+  revision: number
+  status: 'draft' | 'ready' | 'locked'
+  contentHash: string | null
+  lockedAt: string | null
+  timeline: Timeline
+  issues: ContinuityIssue[]
+  busy: boolean
+  batches: BatchRun[]
+  isCurrent: boolean
+  outputs: VideoOutput[]
+}
+export interface VideoOutput {
+  key: string
+  panelIds: number[]
+  url: string
+  taskId?: number
+  generationMode?: VideoGenerationMode
+  stale: boolean
+}
+export interface BatchItem {
+  id: number
+  groupId: string
+  panelId: number | null
+  frameType: FrameType | null
+  status: string
+  taskId: number | null
+  error: string | null
+  localPath?: string | null
+  resultUrl?: string | null
+  actualStrategy?: string
+  generationMode?: VideoGenerationMode
+  frameId?: string
+  panelIds?: number[]
+  inputHash?: string
+}
+export interface BatchRun {
+  id: number
+  versionId: number
+  type: 'image' | 'video'
+  status: string
+  items: BatchItem[]
+}
+export const defaultStrategy: GenerationStrategy = {
+  mode: 'storyboard', constraint: 'auto', fallback: 'first',
+  minDurationMs: 10_000, maxDurationMs: 15_000,
+}
+export function frameKey(frame: Keyframe) { return frame.id || frame.type }
+export function orderedFrames(panel: Panel) {
+  return [...panel.frames].sort((a, b) => (a.offsetMs || 0) - (b.offsetMs || 0))
+}
+export function makeFrame(id: string, offsetMs = 0, title = '分镜画面'): Keyframe {
+  return { id, title, offsetMs, type: 'beat', url: '', prompt: '', locked: false, useForVideo: true, history: [] }
+}
+export function panelImageFallback(panel: Panel) {
+  return [panel.description, panel.atmosphere].filter(Boolean).join('\n') || panel.imagePrompt
+}
+/** Normalize in memory only; stored locked versions and their original hashes remain untouched. */
+export function normalizeTimeline(value: Timeline): Timeline {
+  const t: Timeline = JSON.parse(JSON.stringify(value))
+  const legacy = t.schemaVersion === 1
+  t.schemaVersion = 2
+  t.strategy.mode = 'storyboard'
+  t.strategy.constraint = 'auto'
+  for (const p of t.panels) {
+    p.atmosphere ||= ''
+    p.generation = { constraint: 'auto', includeAssets: false }
+    if (legacy) p.frames = p.frames.filter(f => f.url || f.prompt)
+    p.frames.forEach((f, i) => {
+      f.id ||= `${p.id}-${f.type}-${i}`
+      f.title ||= f.type === 'start' ? '开场画面' : f.type === 'end' ? '结束画面' : `画面 ${i + 1}`
+      f.offsetMs ??= f.type === 'end' ? Math.max(0, p.durationMs - 1) : f.type === 'middle' ? Math.floor(p.durationMs / 2) : 0
+      f.useForVideo = true
+      f.locked = false
+      f.history ||= f.url ? [{ url: f.url, taskId: f.taskId }] : []
+    })
+    p.coverFrameId ||= p.frames.find(f => f.url)?.id
+  }
+  if (t.groups.length !== t.panels.length || t.groups.some(group => group.panelIds.length !== 1)) {
+    const oldGroups = t.groups
+    const oldTransitions = t.transitions
+    const orderedIds = oldGroups.flatMap(group => group.panelIds)
+    for (const panel of t.panels) if (!orderedIds.includes(panel.id)) orderedIds.push(panel.id)
+    t.groups = orderedIds.map(panelId => {
+      const panel = t.panels.find(item => item.id === panelId)!
+      const source = oldGroups.find(group => group.panelIds.includes(panelId))
+      const index = source?.panelIds.indexOf(panelId) ?? 0
+      const last = index === (source?.panelIds.length || 1) - 1
+      const entry = { ...(source?.entry || {}) }
+      return {
+        id: `panel-${panelId}`, title: panel.title, note: index === 0 ? source?.note || '' : '',
+        panelIds: [panelId], entry, exit: { ...(last ? source?.exit || entry : entry) },
+      }
+    })
+    t.transitions = t.groups.slice(1).map((group, index) => {
+      const from = t.groups[index]
+      const fromSource = oldGroups.find(item => item.panelIds.includes(from.panelIds[0]))
+      const toSource = oldGroups.find(item => item.panelIds.includes(group.panelIds[0]))
+      const old = fromSource && toSource && fromSource.id !== toSource.id
+        ? oldTransitions.find(edge => edge.from === fromSource.id && edge.to === toSource.id)
+        : undefined
+      return old ? { ...old, from: from.id, to: group.id }
+        : { from: from.id, to: group.id, type: 'cut', continuity: 'normal', allowedChanges: [] }
+    })
+  }
+  for (const group of t.groups) {
+    const panel = t.panels.find(item => item.id === group.panelIds[0])
+    if (panel) group.title = panel.title
+  }
+  return t
+}
+/** Plan one image per explicitly labelled subshot; plain descriptions need only one. */
+export function planFrames(panel: Panel, prefix: string): Keyframe[] {
+  const parts = panel.description.split(/(?=【(?:镜头|子镜头)\s*[\d一二三四五六七八九十]+】)/).filter(s => s.trim())
+  const labelled = parts.filter(s => /^【(?:镜头|子镜头)/.test(s))
+  const shots = labelled.length
+    ? labelled.map(prompt => [prompt, panel.atmosphere].filter(Boolean).join('\n'))
+    : [panelImageFallback(panel)]
+  return shots.map((prompt, i) => ({
+    ...makeFrame(`${prefix}-${i}`, Math.floor(i * panel.durationMs / shots.length), `画面 ${i + 1}`),
+    prompt: prompt.trim(),
+  }))
+}
+export function groupPanels(t: Timeline, group: StoryboardGroup): Panel[] {
+  const byId = new Map(t.panels.map(p => [p.id, p]))
+  return group.panelIds.map(id => byId.get(id)).filter((p): p is Panel => !!p)
+}
+export function timelineSegments(t: Timeline) {
+  let startMs = 0
+  return t.groups.flatMap(g => groupPanels(t, g).map(panel => {
+    const segment = { groupId: g.id, panel, startMs, endMs: startMs + panel.durationMs }
+    startMs = segment.endMs
+    return segment
+  }))
+}
+export function durationMs(t: Timeline) {
+  return timelineSegments(t).at(-1)?.endMs || 0
+}
+/** Preserve a bound clip's offset inside its shot when earlier shots move or change length. */
+export function retimeBoundAudio(before: Timeline, after: Timeline) {
+  const starts = new Map(timelineSegments(before).map(s => [s.panel.id, s.startMs]))
+  const nextStarts = new Map(timelineSegments(after).map(s => [s.panel.id, s.startMs]))
+  for (const clip of after.audio) {
+    if (!clip.panelId) continue
+    const previous = starts.get(clip.panelId), next = nextStarts.get(clip.panelId)
+    if (previous !== undefined && next !== undefined) clip.startMs = Math.max(0, clip.startMs + next - previous)
+  }
+}
+export function mediaUrl(value?: string | null) {
+  if (!value) return ''
+  return /^(https?:|blob:|data:|\/)/.test(value) ? value : `/${value}`
+}
+export function formatTime(ms: number) {
+  const tenths = Math.floor(Math.max(0, ms) / 100)
+  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`
+}
+export function rebuildTransitions(t: Timeline) {
+  t.transitions = t.groups.slice(1).map((g, i) =>
+    t.transitions.find(e => e.from === t.groups[i].id && e.to === g.id) ||
+    { from: t.groups[i].id, to: g.id, type: 'cut', continuity: 'normal', allowedChanges: [] })
+}
+export function autoGroup(panels: Panel[], _strategy = defaultStrategy): StoryboardGroup[] {
+  return panels.map(panel => {
+    const state = { scene: panel.scene, characters: panel.characterIds.join(','), props: panel.propIds.join(',') }
+    return {
+      id: `panel-${panel.id}`, title: panel.title, note: '', panelIds: [panel.id],
+      entry: { ...state }, exit: { ...state },
+    }
+  })
+}
+export function checkContinuity(t: Timeline): ContinuityIssue[] {
+  const issues: ContinuityIssue[] = []
+  const add = (issue: Omit<ContinuityIssue, 'reason'>) => {
+    // Include evidence in the identity: waivers do not survive a changed condition.
+    issue.id = `${issue.id}:${encodeURIComponent(issue.message)}`
+    issues.push({ ...issue, reason: t.acknowledgements[issue.id] })
+  }
+  for (const group of t.groups) {
+    const panels = groupPanels(t, group)
+    if (!panels.length) add({ id: `empty:${group.id}`, rule: 'empty_group', severity: 'fail', groupId: group.id, message: '镜头节点没有关联分镜，请同步视频制作数据。' })
+    for (const p of panels) if (!p.frames.some(f => f.url)) add({
+      id: `frame:${p.id}`, rule: 'missing_frame', severity: 'warning', groupId: group.id, panelId: p.id,
+      message: `「${p.title}」尚无预览画面；可添加画面，也可直接使用纯文本生成视频。`,
+    })
+  }
+  for (const edge of t.transitions) {
+    const from = t.groups.find(g => g.id === edge.from)!
+    const to = t.groups.find(g => g.id === edge.to)!
+    if (!from || !to) continue
+    const a = groupPanels(t, from).at(-1), b = groupPanels(t, to)[0]
+    if (a?.scene && b?.scene && a.scene !== b.scene && !['establishing', 'audio_bridge', 'insert'].includes(edge.type)) add({
+      id: `scene:${from.id}:${to.id}`, rule: 'scene_bridge', severity: 'warning', fromGroupId: from.id, groupId: to.id,
+      message: `场景从「${a.scene}」变为「${b.scene}」，建议声明建立镜头或声音桥。`,
+    })
+    if (a && b && a.shotType && b.shotType && a.shotType !== b.shotType && a.angle !== b.angle && edge.type === 'cut') add({
+      id: `camera:${from.id}:${to.id}`, rule: 'camera_jump', severity: 'warning', fromGroupId: from.id, groupId: to.id,
+      message: `景别和机位同时变化：${a.shotType}/${a.angle} → ${b.shotType}/${b.angle}，请确认转场。`,
+    })
+  }
+  const segments = timelineSegments(t)
+  for (const clip of t.audio) {
+    const segment = segments.find(s => s.panel.id === clip.panelId)
+    const outOfBounds = clip.startMs + clip.durationMs > durationMs(t)
+      || (clip.type === 'dialogue' && segment && (clip.startMs < segment.startMs || clip.startMs + clip.durationMs > segment.endMs))
+    if (outOfBounds) add({
+      id: `audio:${clip.id}`, rule: 'audio_overflow', severity: 'fail',
+      groupId: segment?.groupId || t.groups[0]?.id || '', panelId: clip.panelId || undefined,
+      message: `「${clip.text || '音频'}」的播放区间超出${clip.type === 'dialogue' && segment ? '所属分镜' : '时间线'}。`,
+    })
+  }
+  if (!t.panels.length) add({ id: 'empty', rule: 'empty_timeline', severity: 'fail', groupId: '', message: '尚无分镜，请先在视频制作中拆分剧本。' })
+  return issues
+}
diff --git a/backend/src/services/previs.ts b/backend/src/services/previs.ts
new file mode 100644
index 0000000..b9eede2
--- /dev/null
+++ b/backend/src/services/previs.ts
@@ -0,0 +1,516 @@
+import { createHash } from 'node:crypto'
+import { z } from 'zod'
+import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
+import { db, schema } from '../db/index.js'
+import { now } from '../utils/response.js'
+import {
+  autoGroup, checkContinuity, defaultStrategy, rebuildTransitions, normalizeTimeline, frameKey, retimeBoundAudio,
+  timelineSegments, panelImageFallback, type Timeline, type Panel, type AnimaticVersion, type BatchRun,
+  type Keyframe, type VideoOutput, type VideoGenerationMode,
+} from './previs-domain.js'
+
+export class PrevisError extends Error {
+  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message) }
+}
+const text = z.string().max(30_000)
+const id = z.number().int().positive()
+const ms = z.number().int().min(0).max(86_400_000)
+const url = z.string().max(4000).refine(v => !v || /^(\/?static\/[^?#]+|https?:\/\/)/.test(v), '媒体地址必须为 static 路径或 HTTP(S) URL')
+const state = z.record(z.string().max(80), z.string().max(2000))
+const constraint = z.enum(['auto', 'first_last', 'first', 'reference', 'text'])
+export const timelineSchema = z.object({
+  schemaVersion: z.union([z.literal(1), z.literal(2)]),
+  groups: z.array(z.object({
+    id: z.string().min(1).max(100), title: text, note: text, panelIds: z.array(id).max(1000),
+    entry: state, exit: state,
+  })).max(1000),
+  panels: z.array(z.object({
+    id, title: text, description: text, atmosphere: text.optional(), imagePrompt: text, videoPrompt: text, durationMs: ms.min(100),
+    sceneId: id.nullable(), scene: text, shotType: text, angle: text, movement: text,
+    characterIds: z.array(id), propIds: z.array(id), referenceImages: z.array(url).max(30), videoUrl: url,
+    referenceLabels: z.array(text).max(30).optional(), sourceFingerprint: z.string().optional(),
+    generation: z.object({ constraint, includeAssets: z.boolean() }).optional(),
+    coverFrameId: z.string().max(100).optional(),
+    frames: z.array(z.object({
+      id: z.string().min(1).max(100).optional(), title: z.string().max(200).optional(), offsetMs: ms.optional(),
+      useForVideo: z.boolean().optional(), history: z.array(z.object({ url, taskId: id.optional() })).max(200).optional(),
+      referenceImages: z.array(url).max(30).optional(),
+      shotType: z.string().max(200).optional(), angle: z.string().max(200).optional(), composition: z.string().max(1000).optional(),
+      type: z.enum(['start', 'middle', 'end', 'beat']), url, prompt: text, locked: z.boolean(), taskId: id.optional(),
+    })).max(100),
+  })).max(1000),
+  transitions: z.array(z.object({
+    from: z.string(), to: z.string(),
+    type: z.enum(['cut', 'match_cut', 'occlusion', 'insert', 'establishing', 'audio_bridge']),
+    continuity: z.enum(['strong', 'normal', 'scene_change']), allowedChanges: z.array(z.string()).max(50),
+  })).max(1000),
+  audio: z.array(z.object({
+    id: z.string().min(1).max(100), type: z.enum(['dialogue', 'narration', 'sound']), panelId: id.nullable(),
+    character: text, text, url, startMs: ms, durationMs: ms.min(100),
+  })).max(2000),
+  strategy: z.object({
+    mode: z.enum(['storyboard', 'group']), constraint,
+    fallback: z.enum(['first', 'reference', 'text']), minDurationMs: ms.min(1000), maxDurationMs: ms.min(1000),
+  }),
+  acknowledgements: z.record(z.string().max(20_000), z.string().trim().min(1).max(2000)),
+  inheritedOutputs: z.array(z.object({
+    key: z.string(), panelIds: z.array(id), url, taskId: id.optional(),
+    generationMode: z.enum(['direct', 'storyboard_frames']).optional(), stale: z.boolean(),
+  })).optional(),
+})
+
+export function hashContent(value: unknown) {
+  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
+    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
+  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
+}
+export function validateTimeline(input: unknown, original?: Timeline): Timeline {
+  const result = timelineSchema.safeParse(input)
+  if (!result.success) throw new PrevisError(`时间线数据无效：${result.error.issues[0]?.message}`)
+  const t = normalizeTimeline(result.data as Timeline)
+  if (original) original = normalizeTimeline(original)
+  const panelIds = t.panels.map(p => p.id)
+  const grouped = t.groups.flatMap(g => g.panelIds)
+  if (new Set(panelIds).size !== panelIds.length || new Set(t.groups.map(g => g.id)).size !== t.groups.length
+    || grouped.length !== panelIds.length || new Set(grouped).size !== grouped.length
+    || grouped.some(p => !panelIds.includes(p))) throw new PrevisError('每个分镜必须且只能属于一个镜头组')
+  if (original && (panelIds.length !== original.panels.length || panelIds.some(p => !original.panels.some(o => o.id === p)))) {
+    throw new PrevisError('分镜集合已变化，请通过同步分镜创建新草稿')
+  }
+  if (t.strategy.minDurationMs > t.strategy.maxDurationMs) throw new PrevisError('最短组时长不能超过最长组时长')
+  if (new Set(t.audio.map(a => a.id)).size !== t.audio.length) throw new PrevisError('音频片段 ID 重复')
+  for (const p of t.panels) {
+    if (new Set(p.frames.map(frameKey)).size !== p.frames.length) throw new PrevisError('同一分镜的画面 ID 不能重复')
+    if (p.frames.some(f => (f.offsetMs || 0) >= p.durationMs)) throw new PrevisError('画面时间点必须在分镜时长以内')
+    if (p.frames.some(f => f.referenceImages?.some(url => !p.referenceImages.includes(url)))) {
+      throw new PrevisError('画面引用的素材已从当前分镜解绑，请重新选择参考素材')
+    }
+    if (p.coverFrameId && !p.frames.some(f => frameKey(f) === p.coverFrameId)) p.coverFrameId = p.frames[0]?.id
+  }
+  for (const clip of t.audio) if (clip.panelId && !panelIds.includes(clip.panelId)) throw new PrevisError('音频引用的分镜不属于当前版本')
+  if (t.transitions.length !== Math.max(0, t.groups.length - 1)
+    || t.transitions.some((edge, i) => edge.from !== t.groups[i].id || edge.to !== t.groups[i + 1].id)) {
+    throw new PrevisError('组间连接必须与当前组顺序一致')
+  }
+  return t as Timeline
+}
+export function frameFingerprint(frame: Keyframe, panel?: Panel) {
+  return hashContent({
+    id: frameKey(frame), prompt: frame.prompt || (panel ? panelImageFallback(panel) : ''), url: frame.url,
+    referenceImages: frame.referenceImages ?? panel?.referenceImages,
+    shotType: frame.shotType || panel?.shotType, angle: frame.angle || panel?.angle,
+    movement: panel?.movement, composition: frame.composition,
+  })
+}
+export function videoFingerprint(t: Timeline, panels: Panel[], generationMode: VideoGenerationMode = 'storyboard_frames') {
+  return hashContent({
+    mode: t.strategy.mode,
+    generationMode,
+    panels: panels.map(p => ({
+      id: p.id, description: p.description, atmosphere: p.atmosphere, prompt: p.videoPrompt, durationMs: p.durationMs,
+      references: generationMode === 'direct' ? p.referenceImages : undefined,
+      referenceLabels: generationMode === 'direct' ? p.referenceLabels : undefined,
+      frames: generationMode === 'storyboard_frames'
+        ? p.frames.map(f => ({ id: frameKey(f), url: f.url, offsetMs: f.offsetMs, type: f.type }))
+        : undefined,
+    })),
+  })
+}
+function sourceMetadata(p: Panel) {
+  return {
+    title: p.title, description: p.description, atmosphere: p.atmosphere,
+    imagePrompt: p.imagePrompt, videoPrompt: p.videoPrompt,
+    durationMs: p.durationMs, sceneId: p.sceneId, scene: p.scene, shotType: p.shotType, angle: p.angle,
+    movement: p.movement, characterIds: p.characterIds, propIds: p.propIds,
+    referenceImages: p.referenceImages, referenceLabels: p.referenceLabels,
+  }
+}
+export function isCurrentVersion(versionId: number) {
+  const row = versionRow(versionId)
+  return listVersions(row.episodeId)[0]?.id === versionId
+}
+/** Mirror the current working version for legacy consumers (agents, asset selectors and exports). */
+export function mirrorCurrent(versionId: number, timeline: Timeline) {
+  if (!isCurrentVersion(versionId)) return
+  for (const p of timeline.panels) {
+    const cover = p.frames.find(f => frameKey(f) === p.coverFrameId && f.url) || p.frames.find(f => f.url)
+    const values: Record<string, unknown> = {
+      title: p.title, description: p.description, atmosphere: p.atmosphere,
+      imagePrompt: p.imagePrompt, videoPrompt: p.videoPrompt,
+      duration: p.durationMs / 1000, sceneId: p.sceneId, shotType: p.shotType, angle: p.angle, movement: p.movement,
+      composedImage: cover?.url || null, firstFrameImage: p.frames.find(f => f.type === 'start')?.url || null,
+      lastFrameImage: p.frames.find(f => f.type === 'end')?.url || null, updatedAt: now(),
+    }
+    // A draft without a selected video must not erase the legacy/current export fallback.
+    if (p.videoUrl) values.videoUrl = p.videoUrl
+    db.update(schema.storyboards).set(values).where(eq(schema.storyboards.id, p.id)).run()
+    db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, p.id)).run()
+    for (const characterId of new Set(p.characterIds)) db.insert(schema.storyboardCharacters).values({ storyboardId: p.id, characterId }).run()
+    db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, p.id)).run()
+    for (const propId of new Set(p.propIds)) db.insert(schema.storyboardProps).values({ storyboardId: p.id, propId }).run()
+  }
+}
+
+export function episodeForPrevis(episodeId: number) {
+  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
+  if (!ep || ep.deletedAt) throw new PrevisError('剧集不存在', 404)
+  return ep
+}
+export function versionRow(versionId: number) {
+  const row = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()
+  if (!row) throw new PrevisError('故事版版本不存在', 404)
+  episodeForPrevis(row.episodeId)
+  return row
+}
+export function listVersions(episodeId: number) {
+  episodeForPrevis(episodeId)
+  return db.select({
+    id: schema.animaticVersions.id, versionNo: schema.animaticVersions.versionNo,
+    status: schema.animaticVersions.status, revision: schema.animaticVersions.revision,
+    lockedAt: schema.animaticVersions.lockedAt, updatedAt: schema.animaticVersions.updatedAt,
+  }).from(schema.animaticVersions).where(eq(schema.animaticVersions.episodeId, episodeId))
+    .orderBy(desc(schema.animaticVersions.versionNo)).all()
+}
+function initialTimeline(episodeId: number): Timeline {
+  const rows = db.select().from(schema.storyboards).where(and(
+    eq(schema.storyboards.episodeId, episodeId),
+    isNull(schema.storyboards.deletedAt),
+  )).orderBy(schema.storyboards.storyboardNumber).all()
+  const storyboardIds = rows.map(row => row.id)
+  const characterLinks = storyboardIds.length
+    ? db.select().from(schema.storyboardCharacters)
+      .where(inArray(schema.storyboardCharacters.storyboardId, storyboardIds)).all()
+    : []
+  const propLinks = storyboardIds.length
+    ? db.select().from(schema.storyboardProps)
+      .where(inArray(schema.storyboardProps.storyboardId, storyboardIds)).all()
+    : []
+  const sceneIds = [...new Set(rows.flatMap(row => row.sceneId ? [row.sceneId] : []))]
+  const characterIds = [...new Set(characterLinks.map(link => link.characterId))]
+  const propIds = [...new Set(propLinks.map(link => link.propId))]
+  const scenes = sceneIds.length
+    ? db.select().from(schema.scenes).where(and(inArray(schema.scenes.id, sceneIds), isNull(schema.scenes.deletedAt))).all()
+    : []
+  const characters = characterIds.length
+    ? db.select().from(schema.characters).where(and(inArray(schema.characters.id, characterIds), isNull(schema.characters.deletedAt))).all()
+    : []
+  const props = propIds.length
+    ? db.select().from(schema.props).where(and(inArray(schema.props.id, propIds), isNull(schema.props.deletedAt))).all()
+    : []
+  const sceneById = new Map(scenes.map(scene => [scene.id, scene]))
+  const characterById = new Map(characters.map(character => [character.id, character]))
+  const propById = new Map(props.map(prop => [prop.id, prop]))
+  const charactersByStoryboard = new Map<number, typeof characterLinks>()
+  const propsByStoryboard = new Map<number, typeof propLinks>()
+  for (const link of characterLinks) {
+    const links = charactersByStoryboard.get(link.storyboardId) || []
+    links.push(link)
+    charactersByStoryboard.set(link.storyboardId, links)
+  }
+  for (const link of propLinks) {
+    const links = propsByStoryboard.get(link.storyboardId) || []
+    links.push(link)
+    propsByStoryboard.set(link.storyboardId, links)
+  }
+  const panels: Panel[] = rows.map(s => {
+    const chars = charactersByStoryboard.get(s.id) || []
+    const panelProps = propsByStoryboard.get(s.id) || []
+    const scene = s.sceneId ? sceneById.get(s.sceneId) : null
+    const references = [
+      { url: scene?.imageUrl, label: scene?.location || '场景' },
+      ...chars.map(link => {
+        const character = characterById.get(link.characterId)
+        return { url: character?.imageUrl, label: character?.name || '角色' }
+      }),
+      ...panelProps.map(link => {
+        const prop = propById.get(link.propId)
+        return { url: prop?.imageUrl, label: prop?.name || '道具' }
+      }),
+    ].filter(r => !!r.url)
+    const panel: Panel = {
+      id: s.id, title: s.title || `镜头 ${s.storyboardNumber}`, description: s.description || '',
+      atmosphere: s.atmosphere || '', imagePrompt: s.imagePrompt || '', videoPrompt: s.videoPrompt || '',
+      durationMs: Math.max(100, Math.round((s.duration || 5) * 1000)),
+      sceneId: s.sceneId, scene: [scene?.location || s.location, scene?.time || s.time].filter(Boolean).join(' / '),
+      shotType: s.shotType || '', angle: s.angle || '', movement: s.movement || '',
+      characterIds: chars.map(c => c.characterId), propIds: panelProps.map(p => p.propId),
+      referenceImages: references.map(r => r.url!), referenceLabels: references.map(r => r.label),
+      videoUrl: s.videoUrl || '',
+      frames: [
+        { type: 'start', url: s.firstFrameImage || '', prompt: '', locked: false },
+        { type: 'middle', url: s.composedImage || '', prompt: '', locked: false },
+        { type: 'end', url: s.lastFrameImage || '', prompt: '', locked: false },
+      ],
+    }
+    panel.sourceFingerprint = hashContent(sourceMetadata(panel))
+    return panel
+  })
+  const t: Timeline = { schemaVersion: 1, groups: autoGroup(panels), panels, transitions: [], audio: [], strategy: { ...defaultStrategy }, acknowledgements: {} }
+  rebuildTransitions(t)
+  // Parse explicit script labels only; do not fabricate dialogue from a visual description.
+  for (const seg of timelineSegments(t)) {
+    const lines = seg.panel.description.split('\n')
+    lines.forEach((line, i) => {
+      const match = line.match(/(?:^|\s|【)(旁白|对白|台词|内心独白)[】\s]*[：:]\s*(.+)/)
+      if (match) t.audio.push({
+        id: `script-${seg.panel.id}-${i}`, panelId: seg.panel.id, type: match[1] === '旁白' ? 'narration' : 'dialogue',
+        character: '', text: match[2], url: '', startMs: seg.startMs,
+        durationMs: Math.max(1000, Math.ceil(match[2].length / 4) * 1000),
+      })
+    })
+  }
+  return normalizeTimeline(t)
+}
+export function createVersion(episodeId: number, sourceId?: number): AnimaticVersion {
+  episodeForPrevis(episodeId)
+  const source = sourceId ? versionRow(sourceId) : null
+  if (source && source.episodeId !== episodeId) throw new PrevisError('源版本不属于当前剧集')
+  const timeline = source ? normalizeTimeline(JSON.parse(source.timelineJson)) : initialTimeline(episodeId)
+  if (source) {
+    timeline.inheritedOutputs = resolveVideoOutputs(source.id, timeline)
+    for (const p of timeline.panels) {
+      const output = timeline.inheritedOutputs.find(o => o.panelIds.length === 1 && o.panelIds[0] === p.id && !o.stale)
+      if (output) p.videoUrl = output.url
+      p.sourceFingerprint = hashContent(sourceMetadata(p))
+    }
+  }
+  // New drafts start with fresh acknowledgements; generated media remains available.
+  timeline.acknowledgements = {}
+  const newId = db.transaction(tx => {
+    const last = tx.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.episodeId, episodeId))
+      .orderBy(desc(schema.animaticVersions.versionNo)).get()
+    const id = Number(tx.insert(schema.animaticVersions).values({
+      episodeId, versionNo: (last?.versionNo || 0) + 1, timelineJson: JSON.stringify(timeline),
+      createdAt: now(), updatedAt: now(),
+    }).run().lastInsertRowid)
+    mirrorCurrent(id, timeline)
+    return id
+  })
+  return getVersion(newId)
+}
+export function readBatches(versionId: number): BatchRun[] {
+  const batches = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.versionId, versionId))
+    .orderBy(desc(schema.batchRuns.id)).all()
+  const batchIds = batches.map(batch => batch.id)
+  const items = batchIds.length
+    ? db.select().from(schema.batchRunItems).where(inArray(schema.batchRunItems.batchId, batchIds))
+      .orderBy(schema.batchRunItems.id).all()
+    : []
+  const taskIds = [...new Set(items.flatMap(item => item.taskId ? [item.taskId] : []))]
+  const tasks = taskIds.length
+    ? db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, taskIds)).all()
+    : []
+  const taskById = new Map(tasks.map(task => [task.id, task]))
+  const itemsByBatch = new Map<number, typeof items>()
+  for (const item of items) {
+    const group = itemsByBatch.get(item.batchId) || []
+    group.push(item)
+    itemsByBatch.set(item.batchId, group)
+  }
+  return batches.map(batch => ({
+    id: batch.id, versionId: batch.versionId, type: batch.type as 'image' | 'video', status: batch.status,
+    items: (itemsByBatch.get(batch.id) || []).map(item => {
+      const task = item.taskId ? taskById.get(item.taskId) : null
+      const request = JSON.parse(item.requestJson)
+      return {
+        id: item.id, groupId: item.groupId, panelId: item.panelId, frameType: item.frameType as any,
+        status: item.status, taskId: item.taskId, error: item.error, frameId: request.frameId,
+        localPath: task?.localPath, resultUrl: task?.resultUrl,
+        actualStrategy: request.actualStrategy, generationMode: request.generationMode,
+        panelIds: request.panelIds, inputHash: request.inputHash,
+      }
+    }),
+  }))
+}
+export function isBusy(versionId: number, batches = readBatches(versionId)) {
+  return batches.some(b => b.type === 'image' && b.items.some(i => ['pending', 'processing'].includes(i.status)))
+}
+export function getVersion(versionId: number): AnimaticVersion {
+  const row = versionRow(versionId)
+  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
+  const batches = readBatches(versionId)
+  return { ...row, status: row.status as AnimaticVersion['status'], timeline, issues: checkContinuity(timeline),
+    isCurrent: isCurrentVersion(versionId), outputs: resolveVideoOutputs(versionId, timeline, batches),
+    busy: isBusy(versionId, batches), batches }
+}
+export function resolveVideoOutputs(
+  versionId: number,
+  timeline = getVersionTimeline(versionId),
+  batches = readBatches(versionId),
+): VideoOutput[] {
+  const results: VideoOutput[] = []
+  const claimed = new Set<number>()
+  const trackedUrls = new Set<string>()
+  for (const batch of batches.filter(batch => batch.type === 'video')) for (const item of batch.items) {
+    if (item.status !== 'completed' || !item.taskId) continue
+    const ids: number[] = item.panelIds || (item.panelId ? [item.panelId] : timeline.groups.find(g => g.id === item.groupId)?.panelIds || [])
+    if (!ids.length || ids.some(id => claimed.has(id) || !timeline.panels.some(p => p.id === id))) continue
+    const url = item.localPath || item.resultUrl
+    if (!url) continue
+    trackedUrls.add(url)
+    const panels = ids.map(id => timeline.panels.find(p => p.id === id)!)
+    const stale = !!item.inputHash && item.inputHash !== videoFingerprint(
+      timeline, panels, item.generationMode || 'storyboard_frames',
+    )
+    results.push({
+      key: `task-${item.taskId}`, panelIds: ids, url, taskId: item.taskId,
+      generationMode: item.generationMode, stale,
+    })
+    if (!stale) ids.forEach(id => claimed.add(id))
+  }
+  for (const output of timeline.inheritedOutputs || []) {
+    trackedUrls.add(output.url)
+    if (output.panelIds.some(id => claimed.has(id) || !timeline.panels.some(p => p.id === id))) continue
+    results.push(output)
+    if (!output.stale) output.panelIds.forEach(id => claimed.add(id))
+  }
+  for (const p of timeline.panels) if (!claimed.has(p.id) && p.videoUrl && !trackedUrls.has(p.videoUrl)) {
+    results.push({ key: `import-${p.id}`, panelIds: [p.id], url: p.videoUrl, stale: false })
+  }
+  const order = timelineSegments(timeline).map(s => s.panel.id)
+  return results.sort((a, b) => order.indexOf(a.panelIds[0]) - order.indexOf(b.panelIds[0]))
+}
+function getVersionTimeline(versionId: number) { return normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson)) }
+function sourceChanged(before: Timeline, source: Timeline) {
+  const collectionChanged = source.panels.length !== before.panels.length
+    || source.panels.some(panel => !before.panels.some(existing => existing.id === panel.id))
+  const metadataChanged = source.panels.some(panel => {
+    const existing = before.panels.find(candidate => candidate.id === panel.id)
+    return existing && hashContent(sourceMetadata(panel))
+      !== (existing.sourceFingerprint || hashContent(sourceMetadata(existing)))
+  })
+  return { collectionChanged, changed: collectionChanged || metadataChanged }
+}
+
+function versionState(
+  row: typeof schema.animaticVersions.$inferSelect,
+  timeline: Timeline,
+  isCurrent: boolean,
+) {
+  const batches = readBatches(row.id)
+  return {
+    id: row.id,
+    revision: row.revision,
+    status: row.status as AnimaticVersion['status'],
+    isCurrent,
+    busy: isBusy(row.id, batches),
+    batches,
+    outputs: resolveVideoOutputs(row.id, timeline, batches),
+  }
+}
+
+export function getVersionState(versionId: number) {
+  const row = versionRow(versionId)
+  return { ...versionState(row, normalizeTimeline(JSON.parse(row.timelineJson)), isCurrentVersion(versionId)), requiresRefresh: false }
+}
+
+export function getWorkspaceState(episodeId: number, versionId: number) {
+  const latest = listVersions(episodeId)[0]
+  if (!latest || latest.id !== versionId) {
+    return { id: latest?.id || null, revision: latest?.revision || null, requiresRefresh: true }
+  }
+  const row = versionRow(latest.id)
+  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
+  if (sourceChanged(timeline, initialTimeline(episodeId)).changed) {
+    return { id: row.id, revision: row.revision, requiresRefresh: true }
+  }
+  return { ...versionState(row, timeline, true), requiresRefresh: false }
+}
+
+/** Only the latest version follows outside edits. Viewing a historical version never activates it. */
+export function getWorkspace(episodeId: number): AnimaticVersion {
+  const latest = listVersions(episodeId)[0]
+  if (!latest) return createVersion(episodeId)
+  const row = versionRow(latest.id), before = getVersionTimeline(row.id)
+  const source = initialTimeline(episodeId)
+  const sourceState = sourceChanged(before, source)
+  if (!sourceState.changed) return getVersion(row.id)
+  const next = structuredClone(before)
+  next.panels = source.panels.map(p => {
+    const old = before.panels.find(o => o.id === p.id)
+    if (!old) return p
+    // Keep image choices, generation settings and histories while importing source edits.
+    const merged = { ...old, ...sourceMetadata(p), sourceFingerprint: p.sourceFingerprint }
+    merged.frames = merged.frames.map(f => ({
+      ...f,
+      offsetMs: Math.min(f.offsetMs || 0, merged.durationMs - 1),
+      referenceImages: f.referenceImages?.filter(url => merged.referenceImages.includes(url)),
+    }))
+    return merged
+  })
+  if (sourceState.collectionChanged) {
+    next.groups = autoGroup(next.panels, next.strategy)
+    rebuildTransitions(next)
+    next.audio = next.audio.filter(a => !a.panelId || next.panels.some(p => p.id === a.panelId))
+  }
+  retimeBoundAudio(before, next)
+  next.acknowledgements = {}
+  if (row.status === 'locked' || sourceState.collectionChanged) {
+    const id = db.transaction(tx => {
+      const id = Number(tx.insert(schema.animaticVersions).values({
+        episodeId, versionNo: row.versionNo + 1, timelineJson: JSON.stringify(next), createdAt: now(), updatedAt: now(),
+      }).run().lastInsertRowid)
+      mirrorCurrent(id, next)
+      return id
+    })
+    return getVersion(id)
+  }
+  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(next), revision: row.revision + 1,
+    status: 'draft', contentHash: null, updatedAt: now() }).where(eq(schema.animaticVersions.id, row.id)).run()
+  return getVersion(row.id)
+}
+export function requireEditable(versionId: number, revision: number) {
+  const row = versionRow(versionId)
+  if (!Number.isInteger(revision) || row.revision !== revision) throw new PrevisError('版本已更新，请先刷新；本地修改可复制后重新应用。', 409)
+  if (row.status === 'locked') throw new PrevisError('锁定版本不可修改，请复制为新草稿', 409)
+  return row
+}
+export function saveTimeline(versionId: number, revision: number, input: unknown) {
+  db.transaction(tx => {
+    const row = requireEditable(versionId, revision)
+    const original = normalizeTimeline(JSON.parse(row.timelineJson))
+    const timeline = validateTimeline(input, original)
+    timeline.inheritedOutputs = original.inheritedOutputs?.map(o => ({
+      ...o, stale: o.stale || videoFingerprint(
+        original, original.panels.filter(p => o.panelIds.includes(p.id)), o.generationMode || 'storyboard_frames',
+      ) !== videoFingerprint(
+        timeline, timeline.panels.filter(p => o.panelIds.includes(p.id)), o.generationMode || 'storyboard_frames',
+      ),
+    }))
+    // Metadata baselines are server-owned; keep optimistic concurrency across the two pages.
+    if (isCurrentVersion(versionId)) {
+      const source = initialTimeline(row.episodeId)
+      if (source.panels.length !== original.panels.length || source.panels.some(p => {
+        const old = original.panels.find(o => o.id === p.id)
+        return !old || (old.sourceFingerprint && old.sourceFingerprint !== p.sourceFingerprint)
+      })) throw new PrevisError('分镜资料已在其他页面更新，请刷新当前工作版后重试。', 409)
+    }
+    for (const p of timeline.panels) {
+      p.sourceFingerprint = hashContent(sourceMetadata(p))
+      for (const f of p.frames) {
+        const old = original.panels.find(o => o.id === p.id)?.frames.find(o => frameKey(o) === frameKey(f))
+        f.history = [...(old?.history || []), ...(old?.url ? [{ url: old.url, taskId: old.taskId }] : []), ...(f.url ? [{ url: f.url, taskId: f.taskId }] : [])]
+          .filter((h, i, all) => all.findIndex(v => v.url === h.url) === i).slice(-200)
+      }
+    }
+    tx.update(schema.animaticVersions).set({
+      timelineJson: JSON.stringify(timeline), revision: revision + 1, status: 'draft', contentHash: null, updatedAt: now(),
+    }).where(and(eq(schema.animaticVersions.id, versionId), eq(schema.animaticVersions.revision, revision))).run()
+    mirrorCurrent(versionId, timeline)
+  })
+  return getVersion(versionId)
+}
+export function checkOrLock(versionId: number, revision: number, lock: boolean) {
+  db.transaction(tx => {
+    const row = requireEditable(versionId, revision)
+    if (lock && isBusy(versionId)) throw new PrevisError('画面正在生成，请等待完成后再锁定', 409)
+    const t = validateTimeline(JSON.parse(row.timelineJson))
+    const issues = checkContinuity(t)
+    if (lock && issues.some(i => i.severity === 'fail')) throw new PrevisError('请修复时间线中的阻断问题后再锁定', 409)
+    tx.update(schema.animaticVersions).set({
+      status: lock ? 'locked' : issues.some(i => i.severity === 'fail') ? 'draft' : 'ready',
+      timelineJson: JSON.stringify(t), revision: revision + 1, contentHash: hashContent(t), lockedAt: lock ? now() : null, updatedAt: now(),
+    }).where(eq(schema.animaticVersions.id, versionId)).run()
+  })
+  return getVersion(versionId)
+}
diff --git a/frontend/app/assets/css/previs.css b/frontend/app/assets/css/previs.css
new file mode 100644
index 0000000..06ab0e4
--- /dev/null
+++ b/frontend/app/assets/css/previs.css
@@ -0,0 +1,790 @@
+/* 镜头看板沿用 studio.css 的主题、按钮与分段控件，不维护独立配色。 */
+.pv-app {
+  height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
+  padding: 8px; gap: 8px; background: var(--surface-base); color: var(--text-0);
+  font: 13px/1.6 var(--font-body);
+  --sel: var(--text-0);
+  --sel-bg: var(--bg-active);
+  --sel-text: var(--text-0);
+}
+:root[data-theme="light"] .pv-app { color-scheme: light; }
+:root[data-theme="dark"] .pv-app { color-scheme: dark; }
+:where(.pv-app) :where(button, select, input, textarea) { font: inherit; color: inherit; }
+/* 保持低特异性，避免覆盖共用 .btn、.seg-item 和 ThemeToggle。 */
+:where(.pv-app) button:where(:not(.btn):not(.seg-item):not(.theme-toggle)) {
+  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
+  min-height: var(--button-height-sm); padding: 0 12px; border: 0;
+  border-radius: var(--button-radius); background: var(--button-bg); color: var(--button-text);
+  font-size: 12px; font-weight: 600; line-height: 1.4; box-shadow: var(--button-shadow);
+  cursor: pointer; white-space: nowrap; transition: background .18s var(--ease-out), color .18s var(--ease-out);
+}
+:where(.pv-app) button:where(:not(.btn):not(.seg-item):not(.theme-toggle)):hover:not(:disabled) {
+  background: var(--button-bg-hover); color: var(--button-text-hover);
+}
+:where(.pv-app) button:disabled, .pv-upload.disabled { opacity: .45; cursor: not-allowed; }
+:where(.pv-app) :focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
+.pv-app input:not([type=checkbox]):not([type=range]):not([type=file]),
+.pv-app select, .pv-app textarea {
+  min-width: 0; max-width: 100%; border: 1px solid var(--border-strong);
+  border-radius: var(--radius); background: var(--surface-input); padding: 8px 10px;
+  color: var(--text-0); outline: none; transition: border-color .16s, box-shadow .16s;
+}
+.pv-app input:not([type=checkbox]):not([type=range]):not([type=file]):hover:not(:disabled),
+.pv-app select:hover:not(:disabled), .pv-app textarea:hover:not(:disabled) { border-color: var(--border-hover); }
+.pv-app input:focus-visible, .pv-app select:focus-visible, .pv-app textarea:focus-visible {
+  border-color: var(--border-focus); box-shadow: 0 0 0 3.5px var(--button-focus);
+}
+.pv-app input::placeholder, .pv-app textarea::placeholder { color: var(--text-3); }
+.pv-app input[type=checkbox] { accent-color: var(--accent); width: 13px; height: 13px; flex-shrink: 0; }
+.pv-app input[type=range] { accent-color: var(--accent); height: 4px; min-width: 40px; cursor: pointer; }
+.pv-app textarea { resize: vertical; line-height: 1.7; }
+.pv-app a { color: var(--accent-text); text-decoration: none; }
+.pv-app a:hover { text-decoration: underline; }
+.pv-muted { color: var(--text-2); }
+.pv-eyebrow { font-size: 11px; font-weight: 500; line-height: 1.5; color: var(--text-2); }
+
+/* 与视频制作页面一致的工作台外壳。 */
+.pv-app .studio-topbar {
+  display: flex; align-items: center; justify-content: space-between; gap: 8px;
+  flex-shrink: 0; min-height: 40px; padding: 4px 10px;
+  border-radius: var(--radius-lg); background: var(--header-bg);
+  border: 1px solid var(--border); box-shadow: var(--shadow-card);
+  backdrop-filter: blur(20px) saturate(180%);
+}
+.pv-app .studio-topbar-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
+.pv-app .back-btn {
+  display: flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0;
+  height: 26px; min-width: 72px; padding: 0 12px; border: 0;
+  border-radius: var(--radius-pill); background: var(--overlay-track); color: var(--text-1);
+  font-size: 11px; font-weight: 650; cursor: pointer; box-shadow: none;
+}
+.pv-app .back-btn:hover { background: var(--bg-active); color: var(--text-0); }
+.pv-app .studio-identity { min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
+.pv-app .studio-title {
+  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
+  font-size: 13px; line-height: 1; font-weight: 700;
+}
+.pv-app .studio-episode-chip,
+.pv-app .studio-meta-pill {
+  display: inline-flex; align-items: center; height: 18px; padding: 0 8px;
+  border-radius: var(--radius-pill); background: var(--accent-bg); color: var(--accent-text);
+  font-size: 9px; font-weight: 700; white-space: nowrap;
+}
+.pv-app .studio-meta-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
+.pv-app .studio-meta-pill { font-size: 8px; font-weight: 600; }
+.pv-app .studio-meta-pill.is-progress { background: var(--success-bg); color: var(--success); }
+.pv-app .studio-meta-inline { font-size: 9px; color: var(--text-3); font-weight: 600; white-space: nowrap; }
+.pv-app .studio-topbar-side,
+.pv-app .studio-model-picks,
+.pv-app .studio-actions { display: flex; align-items: center; gap: 6px; }
+.pv-app .studio-topbar-side { flex-shrink: 0; }
+.pv-app .studio-topbar .btn { height: 26px; padding: 0 9px; font-size: 10.5px; white-space: nowrap; }
+.pv-app .task-drawer-trigger { position: relative; }
+.pv-app .task-drawer-badge {
+  min-width: 16px; height: 16px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center;
+  border-radius: var(--radius-pill); background: var(--accent); color: var(--action-primary-text);
+  font-size: 10px; font-weight: 700; line-height: 1;
+}
+.pv-app .studio-body {
+  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px;
+  flex: 1; min-height: 0;
+}
+
+/* 主流程导航复用视频制作页的状态表达。 */
+.pv-app .sidebar {
+  width: 208px; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
+  border-radius: var(--radius); background: var(--surface-raised);
+  border: 1px solid var(--border); box-shadow: var(--shadow-card);
+  transition: width .22s var(--ease-out);
+}
+.pv-app .pipeline { flex: 1; overflow-y: auto; padding: 12px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
+.pv-app .pipe-section { display: flex; flex-direction: column; gap: 2px; }
+.pv-app .pipe-section-label {
+  display: flex; align-items: center; gap: 5px; padding: 0 7px 2px;
+  color: var(--text-3); font-size: 10.5px; font-weight: 700; text-transform: uppercase;
+}
+.pv-app .pipe-section-state {
+  width: 13px; height: 13px; border-radius: 50%; flex-shrink: 0;
+  display: inline-flex; align-items: center; justify-content: center;
+}
+.pv-app .pipe-section.is-done .pipe-section-state { background: var(--success-bg); color: var(--success); }
+.pv-app .pipe-section-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-3); opacity: .55; }
+.pv-app .pipe-section-pulse,
+.pv-app .pipe-item-pulse {
+  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
+  animation: pv-pipe-pulse 1.6s var(--ease-out) infinite;
+}
+@keyframes pv-pipe-pulse {
+  0% { box-shadow: 0 0 0 0 var(--accent-glow); }
+  70%, 100% { box-shadow: 0 0 0 5px transparent; }
+}
+.pv-app .pipe-section-tag {
+  padding: 1px 5px; border-radius: var(--radius-pill); background: var(--bg-2); color: var(--text-2);
+  font-size: 9.5px; font-weight: 600; text-transform: none;
+}
+.pv-app .pipe-item {
+  position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px;
+  width: 100%; min-height: 34px; padding: 5px 8px; border: 1px solid transparent;
+  border-radius: var(--radius); background: transparent; color: var(--text-2);
+  box-shadow: none; text-align: left; cursor: pointer;
+}
+.pv-app .pipe-item:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-0); }
+.pv-app .pipe-item.active { background: var(--sel-bg); color: var(--sel-text); }
+.pv-app .pipe-item.active::before {
+  content: ''; position: absolute; left: 0; top: 9px; bottom: 9px;
+  width: 3px; border-radius: var(--radius-pill); background: var(--accent);
+}
+.pv-app .pipe-item-sub:not(:last-child)::after {
+  content: ''; position: absolute; left: 15px; top: 23px; bottom: -6px;
+  width: 1px; background: var(--border);
+}
+.pv-app .pipe-icon {
+  position: relative; z-index: 1; width: 16px; height: 16px; flex-shrink: 0;
+  display: flex; align-items: center; justify-content: center;
+  border: 1px solid var(--border); border-radius: 50%; background: var(--bg-2); color: var(--text-3);
+}
+.pv-app .pipe-item.doing .pipe-icon { background: var(--accent-bg); border-color: var(--accent-glow); }
+.pv-app .pipe-item.active .pipe-icon,
+.pv-app .icon-active { background: var(--sel) !important; border-color: var(--sel) !important; color: var(--surface-raised) !important; }
+.pv-app .pipe-item.done .pipe-icon,
+.pv-app .icon-done { background: var(--success-bg) !important; border-color: var(--success-bg) !important; color: var(--success) !important; }
+.pv-app .pipe-copy { min-width: 0; }
+.pv-app .pipe-label { font-size: 12.5px; font-weight: 600; }
+.pv-app .sidebar-bottom {
+  padding: 9px 10px 10px; display: flex; flex-direction: column; gap: 7px; flex-shrink: 0;
+  border-top: 1px solid var(--border); background: var(--surface-soft);
+}
+.pv-app .sidebar-toggle {
+  width: 100%; min-height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; gap: 5px;
+  border: 0; border-radius: 6px; background: transparent; color: var(--text-3); box-shadow: none;
+  font-size: 11px; font-weight: 600; cursor: pointer;
+}
+.pv-app .sidebar-toggle:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-0); }
+.pv-app .sidebar-toggle-icon { transition: transform .22s var(--ease-out); }
+.pv-app .sidebar-progress { display: flex; flex-direction: column; gap: 7px; padding: 2px 2px 4px; }
+.pv-app .sidebar-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
+.pv-app .sidebar-progress-title {
+  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
+  color: var(--text-1); font-size: 12.5px; font-weight: 700;
+}
+.pv-app .sidebar-progress-count { flex-shrink: 0; color: var(--text-3); font: 11px var(--font-mono); }
+.pv-app .sidebar-progress-track,
+.pv-app .sidebar-progress-labels { display: flex; gap: 4px; }
+.pv-app .sidebar-progress-seg {
+  position: relative; flex: 1; height: 5px; min-height: 0; padding: 0;
+  border: 0; border-radius: var(--radius-pill); overflow: hidden;
+  background: var(--overlay-track); box-shadow: none; cursor: pointer;
+}
+.pv-app .sidebar-progress-seg:hover:not(:disabled) { background: var(--overlay-track); transform: scaleY(1.6); }
+.pv-app .sidebar-progress-seg.done { background: var(--success); }
+.pv-app .sidebar-progress-seg.current { background: var(--accent-bg); }
+.pv-app .sidebar-progress-seg.current .sidebar-progress-seg-fill {
+  position: absolute; inset: 0; background: var(--accent);
+  animation: pv-segment-pulse 1.5s ease-in-out infinite;
+}
+@keyframes pv-segment-pulse { 50% { opacity: .55; } }
+.pv-app .sidebar-progress-labels span {
+  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
+  color: var(--text-3); font-size: 10.5px; text-align: center;
+}
+.pv-app .sidebar-progress-labels span.done { color: var(--success); }
+.pv-app .sidebar-progress-labels span.on { color: var(--accent-text); font-weight: 700; }
+.pv-app .refresh-btn {
+  width: 100%; min-height: 28px; padding: 0 10px; display: flex; align-items: center; justify-content: center; gap: 6px;
+  border: 1px solid var(--button-border); border-radius: var(--button-radius);
+  background: var(--button-bg); color: var(--button-text); box-shadow: var(--button-shadow);
+  font-size: 12.5px; font-weight: 650; cursor: pointer;
+}
+.pv-app .sidebar.collapsed { width: 46px; }
+.pv-app .sidebar.collapsed .pipeline { padding: 12px 5px 8px; gap: 10px; }
+.pv-app .sidebar.collapsed .pipe-section-label { justify-content: center; padding: 0 0 2px; }
+.pv-app .sidebar.collapsed .pipe-section-label > span:not(.pipe-section-state),
+.pv-app .sidebar.collapsed .pipe-copy,
+.pv-app .sidebar.collapsed .sidebar-progress { display: none; }
+.pv-app .sidebar.collapsed .pipe-item { grid-template-columns: auto; justify-content: center; padding: 6px 0; min-height: 0; }
+.pv-app .sidebar.collapsed .pipe-item-sub:not(:last-child)::after { display: none; }
+.pv-app .sidebar.collapsed .pipe-icon { width: 22px; height: 22px; }
+.pv-app .sidebar.collapsed .sidebar-toggle-icon { transform: rotate(180deg); }
+.pv-app .sidebar.collapsed .sidebar-bottom { padding: 9px 6px 10px; align-items: center; }
+.pv-app .sidebar.collapsed .refresh-btn { width: 28px; min-height: 28px; padding: 0; font-size: 0; }
+.pv-app .pipe-mini-pulse {
+  position: absolute; top: -3px; right: -3px; width: 7px; height: 7px;
+  border: 1.5px solid var(--surface-raised); border-radius: 50%; background: var(--accent);
+}
+
+/* 镜头看板内容：操作栏、左侧镜头导航、预览与右侧菜单。 */
+.pv-app .main {
+  min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
+  border: 1px solid var(--border); border-radius: var(--radius);
+  background: color-mix(in srgb, var(--surface-soft) 82%, var(--surface-raised));
+  box-shadow: var(--shadow-card);
+}
+.pv-board-toolbar {
+  min-height: 52px; padding: 7px 12px; display: flex; align-items: center; gap: 12px; flex-shrink: 0;
+  border-bottom: 1px solid var(--border); background: var(--surface-raised);
+}
+.pv-board-heading { min-width: 0; display: flex; align-items: center; gap: 8px; }
+.pv-board-heading > svg {
+  width: 30px; height: 30px; padding: 6px; flex-shrink: 0;
+  border-radius: var(--radius-sm); background: var(--accent-bg); color: var(--accent-text);
+}
+.pv-board-heading h2 { font-size: 13.5px; font-weight: 700; line-height: 1.3; }
+.pv-board-heading p { margin-top: 2px; color: var(--text-3); font-size: 10px; line-height: 1.3; white-space: nowrap; }
+.pv-video-mode {
+  flex-shrink: 0; margin-left: auto; border: 1px solid var(--border);
+  border-radius: var(--radius); background: var(--overlay-track);
+}
+.pv-video-mode .seg-item {
+  min-height: 26px; padding: 4px 9px; display: inline-flex; align-items: center; gap: 5px;
+  border-radius: calc(var(--radius) - 2px); font-size: 11px; letter-spacing: 0;
+}
+.pv-header-actions {
+  display: flex; align-items: center; gap: 5px; flex-shrink: 0; margin-left: 0;
+  padding-left: 10px; border-left: 1px solid var(--border);
+}
+.pv-header-actions > button { min-height: 28px; padding: 0 9px; font-size: 11px; }
+.pv-header-actions > button[aria-label="撤销"],
+.pv-header-actions > button[aria-label="重做"] { width: 28px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
+.pv-check-button span { min-width: 16px; padding: 0 4px; border-radius: var(--radius-pill); background: var(--overlay-track); font-size: 10px; }
+.pv-banner {
+  display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin: 8px 8px 0; padding: 7px 10px;
+  border-radius: var(--radius); background: var(--info-bg); color: var(--info); font-size: 12px;
+}
+.pv-banner.is-error { background: var(--error-bg); color: var(--error); }
+.pv-banner button { min-height: 26px; padding: 0 10px; font-size: 11px; }
+.pv-group-list {
+  min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column;
+  gap: 3px; overflow-x: hidden; overflow-y: auto; padding: 7px 6px;
+}
+.pv-group-list::-webkit-scrollbar, .pv-inspector-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
+.pv-group-list::-webkit-scrollbar-track, .pv-inspector-scroll::-webkit-scrollbar-track { background: transparent; }
+.pv-group-list::-webkit-scrollbar-thumb, .pv-inspector-scroll::-webkit-scrollbar-thumb {
+  border-radius: var(--radius-pill); background: var(--border-strong);
+}
+.pv-group-card {
+  position: relative; flex: 0 0 auto; width: 100%; display: grid; grid-template-columns: 15px 50px minmax(0, 1fr); gap: 7px;
+  min-height: 60px; padding: 5px; border: 1px solid transparent; border-radius: var(--radius);
+  background: transparent; box-shadow: none; color: var(--text-1); text-align: left;
+  transition: background .14s var(--ease-out), border-color .14s var(--ease-out), box-shadow .14s var(--ease-out);
+}
+.pv-group-card:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border); }
+.pv-group-card.selected {
+  background: color-mix(in srgb, var(--accent-bg) 42%, var(--surface-raised));
+  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
+  box-shadow: 0 1px 2px color-mix(in srgb, var(--accent) 12%, transparent);
+}
+.pv-group-card.selected::before {
+  content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px;
+  border-radius: var(--radius-pill); background: var(--accent);
+}
+.pv-group-number { align-self: start; margin-top: 2px; color: var(--text-3); font: 10px var(--font-mono); }
+.pv-group-card.selected .pv-group-number { color: var(--accent-text); font-weight: 700; }
+.pv-mini-still {
+  position: relative; width: 50px; height: 50px; overflow: hidden;
+  display: flex; align-items: center; justify-content: center;
+  border: 1px solid var(--border); border-radius: var(--radius-sm);
+  background: var(--surface-muted); color: var(--text-3);
+}
+.pv-mini-still img { width: 100%; height: 100%; object-fit: cover; }
+.pv-mini-still b {
+  position: absolute; right: 3px; bottom: 3px; padding: 1px 4px;
+  border-radius: 4px; background: var(--scrim); color: var(--on-media); font-size: 9px; font-weight: 500;
+}
+.pv-group-copy { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
+.pv-group-copy strong,
+.pv-group-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
+.pv-group-copy strong { font-size: 11.5px; font-weight: 600; }
+.pv-group-copy small { color: var(--text-2); font-size: 9.5px; }
+.pv-status { display: inline-flex; align-items: center; gap: 5px; color: var(--success); font-size: 9.5px; font-weight: 500; white-space: nowrap; }
+.pv-status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
+.pv-status.fail { color: var(--error); }
+.pv-status.warning { color: var(--warning); }
+.pv-status.pass { color: var(--success); }
+.pv-workspace {
+  min-height: 0; flex: 1; display: grid; grid-template-columns: 220px minmax(400px, 1fr) minmax(320px, 360px);
+  gap: 10px; padding: 10px;
+}
+.pv-navigator, .pv-stage-column, .pv-inspector, .pv-timeline {
+  min-width: 0; overflow: hidden; border: 1px solid var(--border);
+  border-radius: var(--radius); background: var(--surface-raised);
+}
+.pv-navigator, .pv-stage-column, .pv-inspector { min-height: 0; display: flex; flex-direction: column; }
+.pv-navigator { background: color-mix(in srgb, var(--surface-soft) 72%, var(--surface-raised)); }
+.pv-stage-column { box-shadow: 0 3px 12px color-mix(in srgb, var(--text-0) 5%, transparent); }
+.pv-stage-toolbar {
+  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 12px;
+  min-height: 54px; padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--surface-raised);
+}
+.pv-stage-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
+.pv-stage-title > span {
+  display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0;
+  border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
+  border-radius: var(--radius-sm); background: var(--accent-bg); color: var(--accent-text);
+  font: 700 12px var(--font-mono);
+}
+.pv-stage-title > div { min-width: 0; }
+.pv-stage-title b { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
+.pv-tabs { min-width: 0; flex-shrink: 0; }
+.pv-tabs .seg-item { padding: 5px 11px; font-size: 12px; }
+.pv-stage-scroll {
+  flex: 1; min-height: 0; display: flex; overflow: hidden; padding: 14px 16px 10px;
+  background: color-mix(in srgb, var(--surface-soft) 68%, var(--surface-raised));
+}
+.pv-player { width: 100%; min-height: 0; flex: 1; display: flex; flex-direction: column; }
+
+/* 媒体区在浅深主题下均保留深底，与视频制作播放器一致。 */
+.pv-canvas {
+  position: relative; display: flex; align-items: center; justify-content: center;
+  width: 100%; min-height: 150px; flex: 1;
+  overflow: hidden; border: 1px solid color-mix(in srgb, var(--on-media) 12%, transparent);
+  border-radius: var(--radius); background: var(--media-surface); color: var(--on-media);
+  box-shadow: 0 12px 30px color-mix(in srgb, var(--media-surface) 28%, transparent);
+}
+.pv-canvas > img, .pv-canvas > video { width: 100%; height: 100%; object-fit: contain; display: block; }
+.pv-canvas > img { transition: transform .1s linear; }
+.pv-canvas:fullscreen, .pv-canvas.expanded { aspect-ratio: auto; max-height: none; height: 100dvh; border-radius: 0; }
+.pv-canvas.expanded { position: fixed; inset: 0; z-index: var(--z-blocking); }
+.pv-no-frame { display: flex; align-items: center; flex-direction: column; gap: 10px; padding: 24px; text-align: center; color: var(--on-media); }
+.pv-no-frame strong { font-size: 15px; font-weight: 600; }
+.pv-no-frame span { font-size: 12px; opacity: .75; }
+.pv-shot-stamp { position: absolute; left: 12px; top: 12px; display: flex; flex-direction: column; gap: 3px; padding: 4px 7px; border-radius: var(--radius-sm); background: var(--scrim); color: var(--on-media); }
+.pv-shot-stamp span { font-size: 10px; font-weight: 600; }
+.pv-shot-stamp b { font-size: 10px; font-weight: 400; }
+.pv-source-badge {
+  position: absolute; right: 12px; top: 12px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px;
+  border: 1px solid color-mix(in srgb, var(--on-media) 18%, transparent);
+  border-radius: var(--radius-sm); background: var(--scrim); color: var(--on-media);
+  font-size: 10px; font-weight: 600; line-height: 1.4; white-space: nowrap;
+}
+.pv-source-badge.is-video { background: color-mix(in srgb, var(--accent) 82%, var(--scrim)); color: var(--on-accent); }
+.pv-source-badge.is-fallback { background: color-mix(in srgb, var(--warning) 78%, var(--scrim)); }
+.pv-subtitle { position: absolute; bottom: 20px; left: 10%; right: 10%; text-align: center; font-size: 16px; font-weight: 500; color: var(--on-media); text-shadow: 0 1px 3px #000, 0 2px 14px #000; white-space: pre-line; }
+.pv-canvas-play {
+  position: absolute; left: 50%; top: 50%; z-index: 3;
+  width: 52px; height: 52px; min-height: 52px; padding: 0;
+  transform: translate(-50%, -50%); border: 1px solid color-mix(in srgb, var(--on-accent) 28%, transparent);
+  border-radius: 50%; background: var(--accent-gradient); color: var(--on-accent);
+  box-shadow: 0 8px 26px var(--scrim); transition: opacity .16s var(--ease-out), transform .16s var(--ease-out);
+}
+.pv-canvas-play:hover:not(:disabled) {
+  transform: translate(-50%, -50%) scale(1.06); background: var(--accent-gradient); color: var(--on-accent);
+}
+.pv-canvas-play.playing { opacity: 0; pointer-events: none; }
+.pv-canvas:hover .pv-canvas-play.playing,
+.pv-canvas-play.playing:focus-visible { opacity: 1; pointer-events: auto; }
+.pv-expand { position: absolute; right: 10px; bottom: 10px; width: 28px; min-height: 28px; padding: 0; background: var(--scrim); color: var(--on-media); box-shadow: none; }
+.pv-expand:hover:not(:disabled) { background: var(--media-surface); color: var(--on-media); }
+.pv-script { padding: 24px; overflow: auto; max-height: 100%; width: 100%; }
+.pv-script small { font-size: 11px; opacity: .75; }
+.pv-script h3 { margin: 12px 0; font-size: 18px; font-weight: 600; color: var(--on-media); }
+.pv-script p { white-space: pre-wrap; line-height: 1.9; font-size: 13px; margin-bottom: 12px; }
+.pv-player-controls {
+  min-height: 40px; display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 5px 8px;
+  border: 1px solid var(--border); border-radius: var(--radius);
+  background: var(--surface-raised); box-shadow: 0 1px 2px color-mix(in srgb, var(--text-0) 5%, transparent);
+}
+.pv-player-controls button { width: 28px; min-height: 28px; flex-shrink: 0; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
+.pv-player-controls button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-0); }
+.pv-player-controls .pv-progress { flex: 1; width: 0; }
+.pv-volume-control { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
+.pv-volume-control input[type=range] { width: 64px; min-width: 64px; flex: none; }
+.pv-player-controls select { height: 28px; padding: 3px 7px; border-radius: var(--radius-sm); font-size: 11px; }
+.pv-time { font: 11px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
+.pv-shots-header { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 12px 0 8px; }
+.pv-shots-header > b { font-size: 12px; font-weight: 600; }
+.pv-shots-header > b span { color: var(--text-2); margin-left: 6px; }
+.pv-shots-header > div { display: flex; gap: 4px; }
+.pv-shots-header button { min-height: 26px; padding: 0 8px; font-size: 11px; }
+.pv-shot-picker { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
+.pv-shot-picker label { display: flex; align-items: center; padding-left: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); max-width: 100%; }
+.pv-shot-picker label.active { background: var(--bg-active); border-color: var(--border-strong); }
+.pv-shot-picker button { padding: 4px 8px; background: transparent; box-shadow: none; border-radius: var(--radius-sm); max-width: 100%; font-size: 11px; font-weight: 500; white-space: normal; text-align: left; }
+.pv-shot-picker button:hover:not(:disabled) { background: var(--bg-hover); }
+.pv-shot-picker small { color: var(--text-2); white-space: nowrap; }
+.pv-keyframes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
+.pv-keyframes article { overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); }
+.pv-keyframes article.locked { border-color: var(--border-strong); }
+.pv-keyframes header { display: flex; align-items: center; gap: 5px; padding: 5px 8px; font-size: 11px; }
+.pv-keyframes header b { font-weight: 600; }
+.pv-keyframes header button { margin-left: auto; width: 24px; min-height: 24px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
+.pv-keyframes article.locked header button { color: var(--success); }
+.pv-frame-image { display: flex; width: 100%; aspect-ratio: 16 / 9; background: var(--media-surface); padding: 0; border-radius: 0; overflow: hidden; box-shadow: none; }
+.pv-frame-image:hover:not(:disabled) { background: var(--media-surface); }
+.pv-frame-image img { width: 100%; height: 100%; object-fit: contain; }
+.pv-frame-image > span { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--on-media); font-size: 11px; }
+.pv-keyframes footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 6px; gap: 4px; }
+.pv-keyframes footer button, .pv-keyframes footer .pv-upload { min-height: 26px; padding: 0 6px; font-size: 11px; gap: 4px; background: transparent; box-shadow: none; color: var(--text-2); }
+.pv-keyframes footer button:hover:not(:disabled), .pv-keyframes footer .pv-upload:hover:not(.disabled) { background: var(--bg-hover); color: var(--text-0); }
+.pv-upload { position: relative; display: inline-flex; gap: 6px; align-items: center; justify-content: center; min-height: 30px; padding: 0 12px; border-radius: var(--button-radius); background: var(--button-bg); color: var(--button-text); box-shadow: var(--button-shadow); font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
+.pv-upload:hover:not(.disabled) { background: var(--button-bg-hover); }
+.pv-upload input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: inherit; }
+.pv-upload:focus-within { box-shadow: 0 0 0 3.5px var(--button-focus); }
+.pv-frame-error { color: var(--error); font-size: 11px; padding: 6px 8px; overflow-wrap: anywhere; line-height: 1.6; max-height: 100px; overflow: auto; }
+.pv-shot-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
+.pv-shot-actions button, .pv-shot-actions select { font-size: 11px; padding: 5px 10px; }
+
+.pv-inspector { background: color-mix(in srgb, var(--surface-soft) 55%, var(--surface-raised)); }
+.pv-inspector-tabs {
+  display: flex; flex-shrink: 0; margin: 8px 8px 0; padding: 3px;
+  border: 1px solid var(--border); border-radius: var(--radius); background: var(--overlay-track);
+}
+.pv-inspector-tabs .seg-item { flex: 1; min-height: 28px; padding: 5px 8px; font-size: 11.5px; white-space: nowrap; }
+.pv-inspector-tabs span { margin-left: 4px; padding: 0 5px; border-radius: var(--radius-pill); font-size: 10px; background: var(--info-bg); color: var(--info); }
+.pv-inspector-scroll { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
+.pv-ai-review {
+  margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border);
+}
+.pv-ai-review > header {
+  display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px;
+}
+.pv-ai-review > header > div { min-width: 0; }
+.pv-ai-review > header strong {
+  display: block; max-width: 100%; overflow: hidden; margin-top: 2px;
+  color: var(--text-0); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap;
+}
+.pv-ai-review > header button { flex-shrink: 0; min-height: 28px; padding: 0 9px; font-size: 11px; }
+.pv-ai-review-images {
+  display: grid; grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr); align-items: center; gap: 6px;
+}
+.pv-ai-review-images > svg { color: var(--text-3); }
+.pv-ai-review-images figure {
+  position: relative; min-width: 0; aspect-ratio: 16 / 9; overflow: hidden;
+  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--media-surface);
+}
+.pv-ai-review-images img { width: 100%; height: 100%; display: block; object-fit: cover; }
+.pv-ai-review-images figure > span { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--on-media); opacity: .55; }
+.pv-ai-review-images figcaption {
+  position: absolute; left: 4px; bottom: 4px; padding: 1px 5px;
+  border-radius: 4px; background: var(--scrim); color: var(--on-media); font-size: 9px;
+}
+.pv-ai-review-result { margin-top: 12px; }
+.pv-ai-review-summary { display: grid; grid-template-columns: 58px minmax(0, 1fr); align-items: center; gap: 10px; }
+.pv-ai-review-score {
+  width: 58px; height: 58px; display: flex; align-items: center; justify-content: center; flex-direction: column;
+  border-radius: var(--radius); background: var(--accent-bg); color: var(--accent-text);
+}
+.pv-ai-review-score b { font: 700 21px/1 var(--font-mono); }
+.pv-ai-review-score span { margin-top: 4px; font-size: 9px; }
+.pv-confidence {
+  display: inline-flex; padding: 1px 6px; border-radius: var(--radius-pill);
+  background: var(--success-bg); color: var(--success); font-size: 9px; font-weight: 600;
+}
+.pv-confidence.medium { background: var(--warning-bg); color: var(--warning); }
+.pv-confidence.low { background: var(--error-bg); color: var(--error); }
+.pv-ai-review-summary p { margin-top: 5px; color: var(--text-2); font-size: 11px; line-height: 1.65; }
+.pv-ai-review-dimensions { display: grid; gap: 9px; margin-top: 14px; }
+.pv-ai-review-dimensions > div {
+  display: grid; grid-template-columns: 72px minmax(40px, 1fr) 20px; align-items: center; gap: 7px;
+}
+.pv-ai-review-dimensions span { color: var(--text-1); font-size: 10.5px; }
+.pv-ai-review-dimensions progress { width: 100%; height: 5px; accent-color: var(--accent); }
+.pv-ai-review-dimensions progress::-webkit-progress-bar { border-radius: var(--radius-pill); background: var(--overlay-track); }
+.pv-ai-review-dimensions progress::-webkit-progress-value { border-radius: var(--radius-pill); background: var(--accent); }
+.pv-ai-review-dimensions b { color: var(--text-1); font: 10px var(--font-mono); text-align: right; }
+.pv-ai-review-dimensions small { grid-column: 1 / -1; color: var(--text-3); font-size: 10px; line-height: 1.55; }
+.pv-ai-review-list { margin-top: 12px; padding-left: 8px; border-left: 2px solid var(--error); }
+.pv-ai-review-list.suggestions { border-left-color: var(--accent); }
+.pv-ai-review-list strong { font-size: 10.5px; font-weight: 600; }
+.pv-ai-review-list p { margin-top: 5px; color: var(--text-2); font-size: 10.5px; line-height: 1.6; }
+.pv-ai-review-list p::before { content: '·'; margin-right: 5px; color: var(--text-3); }
+.pv-ai-review-result footer {
+  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
+  margin-top: 12px; padding-top: 9px; border-top: 1px solid var(--border);
+  color: var(--text-3); font-size: 9px;
+}
+.pv-ai-review-result footer span { min-width: 0; overflow-wrap: anywhere; }
+.pv-ai-review-result footer time { flex-shrink: 0; }
+.pv-ai-review-empty {
+  min-height: 52px; display: flex; align-items: center; justify-content: center; gap: 7px;
+  color: var(--text-2); font-size: 11px;
+}
+.pv-ai-review-first { margin-bottom: 12px; border-bottom: 1px solid var(--border); }
+.pv-check-summary { display: flex; align-items: center; gap: 12px; padding-bottom: 16px; }
+.pv-score { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 3px; border-radius: var(--radius-lg); color: var(--error); width: 56px; height: 56px; flex-shrink: 0; background: var(--error-bg); }
+.pv-score.pass { color: var(--success); background: var(--success-bg); }
+.pv-score b { font-size: 11px; font-weight: 600; }
+.pv-check-summary strong { font-size: 13px; font-weight: 600; }
+.pv-check-summary p { margin-top: 5px; font-size: 11px; color: var(--text-2); }
+.pv-issue-filter { display: flex; gap: 6px; margin-bottom: 12px; }
+.pv-issue-filter button { min-height: 28px; padding: 0 10px; background: transparent; box-shadow: none; font-size: 11px; color: var(--text-2); }
+.pv-issue-filter .active { color: var(--text-0); background: var(--bg-active); }
+.pv-issue-stack { display: grid; gap: 8px; }
+.pv-issue { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; background: var(--surface-muted); }
+.pv-issue.fail { border-color: color-mix(in srgb, var(--error) 25%, var(--border)); background: var(--error-bg); }
+.pv-issue.warning { border-color: color-mix(in srgb, var(--warning) 25%, var(--border)); background: var(--warning-bg); }
+.pv-issue.acknowledged { border-color: var(--border); background: var(--surface-muted); }
+.pv-issue-heading { display: flex; width: 100%; min-height: 22px; padding: 0; background: transparent; box-shadow: none; gap: 8px; justify-content: flex-start; }
+.pv-issue-heading:hover:not(:disabled) { background: transparent; }
+.pv-issue-heading strong { font-size: 12px; font-weight: 600; }
+.pv-issue-heading > svg { margin-left: auto; color: var(--text-2); flex-shrink: 0; }
+.pv-issue > p { font-size: 12px; line-height: 1.8; margin-top: 8px; overflow-wrap: anywhere; color: var(--text-2); }
+.pv-issue.fail > p { color: var(--error); }
+.pv-issue > small { display: block; font-size: 11px; margin-top: 8px; color: var(--success); }
+.pv-issue-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
+.pv-issue-actions button { min-height: 26px; font-size: 11px; padding: 0 8px; }
+.pv-property-card { border-top: 1px solid var(--border); margin-top: 18px; padding-top: 14px; }
+.pv-property-card > p { margin-bottom: 12px; }
+.pv-property-card label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; color: var(--text-2); font-size: 12px; }
+.pv-property-card select, .pv-property-card input { width: 58%; font-size: 12px; }
+.pv-property-card > button { width: 100%; margin-top: 6px; font-size: 12px; }
+.pv-form { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
+.pv-form label { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--text-2); font-size: 12px; }
+.pv-form label input, .pv-form label textarea, .pv-form label select { width: 100%; color: var(--text-0); font-size: 13px; }
+.pv-form > .pv-eyebrow { padding-top: 14px; border-top: 1px solid var(--border); margin-top: 4px; color: var(--text-0); font-size: 12px; font-weight: 600; }
+.pv-form > .pv-eyebrow:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
+.pv-form-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
+.pv-audio-list-item { justify-content: space-between; font-size: 12px; font-weight: 500; white-space: normal; text-align: left; padding: 8px 10px; border-radius: var(--radius-sm); }
+.pv-audio-list-item small { color: var(--text-2); white-space: nowrap; }
+.pv-task-intro p:last-child { margin: 8px 0 16px; font-size: 12px; color: var(--text-2); }
+.pv-batch { background: var(--surface-muted); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin-bottom: 10px; }
+.pv-batch header { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
+.pv-batch header b { font-weight: 600; }
+.pv-batch header span { color: var(--text-2); font-size: 11px; }
+.pv-batch progress { display: block; width: 100%; height: 5px; border-radius: var(--radius-pill); overflow: hidden; margin: 10px 0 6px; accent-color: var(--accent); }
+.pv-batch progress::-webkit-progress-bar { background: var(--overlay-track); border-radius: var(--radius-pill); }
+.pv-batch progress::-webkit-progress-value { background: var(--accent); border-radius: var(--radius-pill); }
+.pv-batch > small { color: var(--text-2); font-size: 11px; }
+.pv-batch-actions { display: flex; gap: 5px; margin: 10px 0; }
+.pv-batch button { min-height: 26px; padding: 0 8px; font-size: 11px; }
+.pv-batch details { font-size: 12px; margin-top: 10px; }
+.pv-batch summary { color: var(--text-2); cursor: pointer; }
+.pv-task-item { display: flex; align-items: flex-start; flex-direction: column; gap: 7px; padding: 12px 0; border-bottom: 1px solid var(--border); }
+.pv-task-item:last-child { border-bottom: 0; padding-bottom: 0; }
+.pv-task-item b { font-weight: 600; }
+.pv-task-item span { color: var(--text-2); }
+.pv-task-item .pv-frame-error { padding: 0; }
+/* 时间轴保持固定轨道高度，窄屏可横向滚动。 */
+.pv-timeline {
+  flex-shrink: 0; height: 198px; margin: 0 10px 10px;
+  box-shadow: 0 2px 8px color-mix(in srgb, var(--text-0) 4%, transparent);
+}
+.pv-timeline-header {
+  display: flex; align-items: center; justify-content: space-between; gap: 16px;
+  padding: 0 14px; height: 40px; border-bottom: 1px solid var(--border); background: var(--surface-raised);
+}
+.pv-timeline-header > div:first-child { display: flex; align-items: center; gap: 12px; }
+.pv-timeline-header .pv-eyebrow { color: var(--text-0); font-size: 12px; font-weight: 600; }
+.pv-timeline-header b { font-size: 11px; font-weight: 500; color: var(--text-2); }
+.pv-timeline-header > small { color: var(--text-2); font-size: 11px; margin-left: auto; }
+.pv-zoom { display: flex; align-items: center; gap: 6px; }
+.pv-zoom span { color: var(--text-2); font: 11px var(--font-mono); min-width: 32px; text-align: center; }
+.pv-zoom button { width: 26px; min-height: 26px; padding: 0; background: transparent; box-shadow: none; }
+.pv-track-layout { display: flex; height: calc(100% - 40px); }
+.pv-track-labels {
+  width: 110px; flex-shrink: 0; border-right: 1px solid var(--border);
+  background: color-mix(in srgb, var(--surface-muted) 72%, var(--surface-raised)); z-index: 3;
+}
+.pv-track-labels span { display: flex; align-items: center; height: 26px; padding-left: 14px; font-size: 11px; color: var(--text-2); }
+.pv-track-labels span:nth-child(1) { height: 25px; font-size: 10px; }
+.pv-track-labels span:nth-child(2) { height: 50px; }
+.pv-track-scroll {
+  flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; padding-right: 12px;
+  background: color-mix(in srgb, var(--surface-soft) 72%, var(--surface-raised));
+}
+.pv-tracks { min-width: 100%; position: relative; height: 153px; }
+.pv-ruler { height: 25px; position: relative; cursor: crosshair; border-bottom: 1px solid var(--border); }
+.pv-ruler span { position: absolute; top: 5px; font: 10px var(--font-mono); color: var(--text-2); border-left: 1px solid var(--border); padding-left: 6px; white-space: nowrap; }
+.pv-ruler span:last-child { transform: translateX(-100%); }
+.pv-track { height: 26px; position: relative; border-bottom: 1px solid var(--border); }
+.pv-group-track { height: 34px; }
+.pv-frame-track { height: 50px; }
+.pv-group-track button { position: absolute; top: 4px; min-height: 0; height: 26px; padding: 0 7px; border-radius: 5px; overflow: hidden; justify-content: flex-start; gap: 8px; background: var(--surface-muted); border: 1px solid var(--border); border-right: 3px solid var(--surface-raised); box-shadow: none; }
+.pv-group-track button.active {
+  background: color-mix(in srgb, var(--accent-bg) 52%, var(--surface-muted));
+  border-color: color-mix(in srgb, var(--accent) 32%, var(--border));
+  border-right-color: var(--surface-raised);
+}
+.pv-group-track small { font-size: 10px; color: var(--text-2); }
+.pv-group-track b { font-weight: 600; font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
+.pv-frame-clip {
+  position: absolute; top: 3px; height: 43px; min-width: 4px;
+  overflow: hidden; border-right: 3px solid var(--surface-raised); border-radius: 5px;
+  background: var(--media-surface);
+}
+.pv-frame-strip { width: 100%; height: 100%; display: flex; overflow: hidden; border-radius: inherit; }
+.pv-video-thumb {
+  position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden;
+  padding: 0; border: 0; border-radius: inherit; background: var(--media-surface); box-shadow: none;
+}
+.pv-video-thumb video { width: 100%; height: 100%; display: block; object-fit: cover; pointer-events: none; }
+.pv-video-thumb:hover:not(:disabled) video { filter: brightness(1.08); }
+.pv-frame-thumb {
+  position: relative; min-width: 0; width: 0; height: 100%; min-height: 0; flex: 1;
+  overflow: hidden; padding: 0; border: 0; border-right: 1px solid color-mix(in srgb, var(--on-media) 18%, transparent);
+  border-radius: 0; background: var(--media-surface); box-shadow: none;
+}
+.pv-frame-thumb:last-child { border-right: 0; }
+.pv-frame-thumb img { width: 100%; height: 100%; object-fit: cover; opacity: .78; transition: opacity .14s var(--ease-out); }
+.pv-frame-thumb:hover:not(:disabled) img { opacity: 1; }
+.pv-frame-thumb.active, .pv-video-thumb.active {
+  z-index: 1; background: var(--media-surface);
+  box-shadow: inset 0 0 0 2px var(--accent);
+}
+.pv-frame-thumb.active img { opacity: 1; }
+.pv-frame-mark {
+  position: absolute; left: 3px; top: 3px; z-index: 2;
+  display: inline-flex; align-items: center; gap: 2px; max-width: calc(100% - 6px);
+  overflow: hidden; padding: 1px 3px; border-radius: 3px;
+  background: var(--scrim); color: var(--on-media);
+  font-size: 7.5px; font-weight: 650; line-height: 1.45; white-space: nowrap; pointer-events: none;
+}
+.pv-frame-mark svg { flex-shrink: 0; }
+.pv-frame-empty {
+  width: 100%; height: 100%; min-height: 0; padding: 0 6px;
+  overflow: hidden; border-radius: inherit; background: var(--surface-muted); box-shadow: none;
+  color: var(--text-2); font-size: 9px; text-overflow: ellipsis;
+}
+.pv-media-kind {
+  position: absolute; right: 4px; top: 3px; z-index: 3;
+  display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px;
+  border-radius: 3px; background: var(--scrim); color: var(--on-media);
+  font-size: 8px; font-weight: 650; line-height: 1.5; white-space: nowrap; pointer-events: none;
+}
+.pv-video-thumb .pv-media-kind { background: color-mix(in srgb, var(--accent) 82%, var(--scrim)); color: var(--on-accent); }
+.pv-media-kind.fallback { top: auto; bottom: 3px; background: color-mix(in srgb, var(--warning) 78%, var(--scrim)); }
+.pv-frame-clip.is-fallback .pv-frame-title { display: none; }
+.pv-frame-title {
+  position: absolute; left: 4px; bottom: 2px; z-index: 2; max-width: calc(100% - 12px);
+  overflow: hidden; padding: 0 3px; border-radius: 3px; background: var(--scrim); color: var(--on-media);
+  font-size: 9px; line-height: 1.6; text-overflow: ellipsis; white-space: nowrap; pointer-events: none;
+}
+.pv-trim { display: block; position: absolute; right: 0; top: 0; bottom: 0; width: 8px; cursor: ew-resize; border-right: 2px solid var(--text-3); touch-action: none; }
+.pv-trim:hover { background: var(--accent-bg); border-color: var(--accent); }
+.pv-audio-clip { position: absolute; top: 3px; height: 20px; min-width: 4px; }
+.pv-audio-clip button { width: 100%; height: 100%; min-height: 0; background: var(--warning-bg); color: var(--tag-warning-text); border-radius: 5px; padding: 1px 8px; font-size: 10px; font-weight: 500; overflow: hidden; display: block; text-overflow: ellipsis; text-align: left; cursor: grab; touch-action: none; box-shadow: none; }
+.pv-audio-track.narration button { background: var(--success-bg); color: var(--tag-success-text); }
+.pv-audio-track.sound button { background: var(--info-bg); color: var(--tag-info-text); }
+.pv-playhead { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--accent); pointer-events: none; z-index: 2; }
+.pv-playhead i { position: absolute; width: 7px; height: 9px; background: var(--accent); left: -4px; top: 0; clip-path: polygon(0 0,100% 0,100% 60%,50% 100%,0 60%); }
+
+.pv-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; padding: 40px; color: var(--text-2); text-align: center; }
+.pv-empty-icon { display: flex; align-items: center; justify-content: center; width: 88px; height: 88px; border-radius: var(--radius-xl); color: var(--accent-text); background: var(--accent-bg); margin-bottom: 8px; }
+.pv-empty h2 { font-size: 24px; font-weight: 700; color: var(--text-0); }
+.pv-empty p { font-size: 13px; }
+.pv-empty small { font-size: 12px; }
+.pv-small-empty { display: flex; align-items: center; flex-direction: column; gap: 10px; text-align: center; color: var(--text-2); padding: 24px 12px; font-size: 12px; }
+.pv-small-empty strong { font-weight: 600; color: var(--text-0); }
+.pv-small-empty > svg { color: var(--success); }
+.pv-dialog { margin: auto; padding: 0; width: min(530px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-xl); color: var(--text-0); background: var(--surface-raised); box-shadow: var(--shadow-elevated); }
+.pv-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(8px); }
+.pv-dialog > form { padding: 20px 24px; }
+.pv-dialog form > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); gap: 16px; }
+.pv-dialog h2 { font-size: 17px; font-weight: 700; }
+.pv-dialog header button { width: 30px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
+.pv-dialog .pv-form > p { line-height: 1.8; }
+.pv-dialog .pv-help { padding: 12px; background: var(--surface-muted); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; color: var(--text-2); }
+.pv-dialog-mode { width: 100%; border: 1px solid var(--border); border-radius: var(--radius); }
+.pv-dialog-mode .seg-item { flex: 1; min-height: 32px; padding: 5px 10px; letter-spacing: 0; }
+.pv-dialog footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 16px; margin-top: 4px; border-top: 1px solid var(--border); }
+.pv-dialog audio { width: 100%; height: 35px; }
+.pv-form .pv-upload { flex-direction: row; color: var(--button-text); }
+.pv-spin { animation: pv-spin 1s linear infinite; }
+@keyframes pv-spin { to { transform: rotate(360deg); } }
+
+@media (min-width: 1600px) {
+  .pv-workspace { grid-template-columns: 240px minmax(520px, 1fr) 400px; }
+  .pv-stage-scroll { padding: 16px 24px; }
+  .pv-group-card { grid-template-columns: 16px 64px minmax(0, 1fr); }
+  .pv-mini-still { width: 64px; height: 54px; }
+}
+@media (max-width: 1320px) {
+  .pv-app .studio-title { max-width: 190px; }
+  .pv-app .studio-model-picks > :first-child { display: none; }
+  .pv-workspace { grid-template-columns: 190px minmax(330px, 1fr) 320px; }
+  .pv-header-actions { gap: 4px; }
+  .pv-header-actions > button:not(.theme-toggle) { padding-left: 9px; padding-right: 9px; }
+  .pv-player-controls { gap: 5px; }
+  .pv-stage-toolbar, .pv-stage-scroll { padding-left: 10px; padding-right: 10px; }
+}
+@media (max-width: 1120px) {
+  .pv-app .studio-meta-inline { display: none; }
+  .pv-app .studio-model-picks > :nth-child(2) { display: none; }
+}
+@media (max-width: 1200px) {
+  .pv-workspace { grid-template-columns: 190px minmax(330px, 1fr); }
+  .pv-inspector { grid-column: 1 / -1; min-height: 360px; max-height: 440px; }
+}
+@media (max-width: 900px) {
+  .pv-app { overflow: auto; }
+  .pv-app .studio-topbar { flex-direction: column; align-items: stretch; }
+  .pv-app .studio-topbar-side { justify-content: space-between; }
+  .pv-app .studio-model-picks > :nth-child(2) { display: flex; }
+  .pv-app .sidebar { width: 46px; }
+  .pv-app .sidebar .pipeline { padding: 12px 5px 8px; gap: 10px; }
+  .pv-app .sidebar .pipe-section-label { justify-content: center; padding: 0 0 2px; }
+  .pv-app .sidebar .pipe-section-label > span:not(.pipe-section-state),
+  .pv-app .sidebar .pipe-copy,
+  .pv-app .sidebar .sidebar-progress { display: none; }
+  .pv-app .sidebar .pipe-item { grid-template-columns: auto; justify-content: center; padding: 6px 0; min-height: 0; }
+  .pv-app .sidebar .pipe-item-sub:not(:last-child)::after { display: none; }
+  .pv-app .sidebar .pipe-icon { width: 22px; height: 22px; }
+  .pv-app .sidebar .sidebar-bottom { padding: 9px 6px 10px; align-items: center; }
+  .pv-app .sidebar .refresh-btn { width: 28px; min-height: 28px; padding: 0; font-size: 0; }
+  .pv-board-toolbar { flex-wrap: wrap; }
+  .pv-workspace { flex: none; grid-template-columns: 1fr; }
+  .pv-navigator { min-height: 0; max-height: 82px; }
+  .pv-group-list { flex-direction: row; overflow-x: auto; overflow-y: hidden; }
+  .pv-group-card { flex: 0 0 190px; width: auto; }
+  .pv-stage-column { min-height: 440px; }
+  .pv-stage-scroll { display: block; }
+  .pv-player { height: auto; }
+  .pv-canvas { aspect-ratio: 16 / 9; max-height: 360px; flex: none; }
+  .pv-inspector { min-height: 420px; max-height: 520px; }
+  .pv-inspector-scroll { min-height: 180px; }
+  .pv-inspector-tabs { align-self: flex-start; min-width: 240px; }
+  .pv-banner { flex-wrap: wrap; }
+  .pv-timeline-header > small { display: none; }
+}
+@media (max-width: 700px) {
+  .pv-app { padding: 6px; }
+  .pv-app .studio-body { grid-template-columns: 1fr; }
+  .pv-app .sidebar { display: none; }
+  .pv-app .studio-topbar-side,
+  .pv-app .studio-actions { flex-wrap: wrap; }
+  .pv-app .studio-model-picks { width: 100%; overflow-x: auto; }
+  .pv-app .studio-model-picks > :first-child,
+  .pv-app .studio-model-picks > :nth-child(2) { display: none; }
+  .pv-header-actions { flex-basis: 100%; justify-content: flex-end; flex-wrap: wrap; }
+  .pv-board-toolbar { align-items: flex-start; }
+  .pv-board-heading { flex: 1; }
+  .pv-stage-column { min-height: 0; }
+  .pv-stage-toolbar { flex-wrap: wrap; gap: 8px; }
+  .pv-stage-title { flex: 1; }
+  .pv-tabs { width: 100%; overflow-x: auto; }
+  .pv-tabs .seg-item { flex: 1 0 auto; }
+  .pv-inspector { max-height: 450px; }
+  .pv-track-labels { width: 88px; }
+  .pv-track-labels span { padding-left: 10px; font-size: 10px; }
+  .pv-timeline-header { padding: 0 10px; gap: 8px; }
+  .pv-timeline-header > div:first-child { gap: 8px; }
+  .pv-shots-header { flex-wrap: wrap; }
+  .pv-subtitle { font-size: 13px; }
+  .pv-empty { padding: 32px 16px; }
+  .pv-empty h2 { font-size: 22px; }
+}
+@media (max-width: 420px) {
+  .pv-app .studio-title { max-width: 160px; }
+  .pv-app .studio-meta-row { flex-wrap: wrap; }
+  .pv-app .studio-model-picks { display: none; }
+  .pv-header-actions { justify-content: flex-start; }
+  .pv-header-actions > button { font-size: 0; width: 30px; padding: 0; }
+  .pv-header-actions .pv-check-button { width: auto; font-size: 10px; }
+  .pv-player-controls { gap: 2px; padding: 4px; flex-wrap: nowrap; }
+  .pv-player-controls button { width: 24px; min-height: 26px; }
+  .pv-volume-control { gap: 1px; }
+  .pv-volume-control input[type=range] { width: 36px; min-width: 36px; }
+  .pv-player-controls select { width: 45px; padding: 2px 3px; flex-shrink: 0; }
+  .pv-player-controls .pv-time { font-size: 9px; }
+  .pv-shot-stamp, .pv-source-badge { top: 8px; }
+  .pv-shot-stamp { left: 8px; }
+  .pv-source-badge { right: 8px; font-size: 9px; }
+  .pv-shots-header button { padding: 0 6px; }
+  .pv-keyframes { gap: 6px; }
+  .pv-keyframes header { padding: 4px 6px; }
+  .pv-keyframes footer { padding: 4px; }
+  .pv-dialog > form { padding: 18px; }
+  .pv-timeline-header b { font-size: 10px; }
+}
+@media (prefers-reduced-motion: reduce) {
+  .pv-app *, .pv-app *::before, .pv-app *::after { animation: none !important; transition: none !important; }
+}
diff --git a/frontend/app/components/previs/FrameSettingsDialog.vue b/frontend/app/components/previs/FrameSettingsDialog.vue
new file mode 100644
index 0000000..9bce383
--- /dev/null
+++ b/frontend/app/components/previs/FrameSettingsDialog.vue
@@ -0,0 +1,255 @@
+<script setup lang="ts">
+import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, useId } from 'vue'
+import { Check, ImagePlus, RotateCcw, SlidersHorizontal, Sparkles, X } from 'lucide-vue-next'
+import { mediaUrl, type Keyframe, type Panel } from '~/composables/usePrevis'
+
+const props = defineProps<{
+  panel: Panel
+  frame: Keyframe
+  editable: boolean
+  isNew?: boolean
+  returnFocus?: HTMLElement
+}>()
+const emit = defineEmits<{
+  close: []
+  frame: [changes: Partial<Keyframe>, generate: boolean]
+}>()
+// The dialog owns a draft. Only changed fields are applied to the latest frame on save.
+const initial = {
+  title: props.frame.title || '',
+  offsetMs: props.frame.offsetMs || 0,
+  prompt: props.frame.prompt || '',
+  shotType: props.frame.shotType || '',
+  angle: props.frame.angle || '',
+  composition: props.frame.composition || '',
+  referenceImages: props.frame.referenceImages ? [...props.frame.referenceImages] : undefined,
+  url: props.frame.url || '',
+}
+const draft = ref({ ...initial, referenceImages: initial.referenceImages ? [...initial.referenceImages] : undefined })
+const seconds = ref(initial.offsetMs / 1000)
+const dialog = ref<HTMLDialogElement>()
+const form = ref<HTMLFormElement>()
+const titleId = useId()
+const descriptionId = useId()
+const readOnly = computed(() => !props.editable)
+const maxSeconds = computed(() => Math.max(0, (props.panel.durationMs - 1) / 1000))
+const references = computed(() => draft.value.referenceImages ?? props.panel.referenceImages)
+const assets = computed(() => props.panel.referenceImages.map((url, index) => ({
+  url, label: props.panel.referenceLabels?.[index] || `参考素材 ${index + 1}`,
+})))
+const missingReferences = computed(() => references.value.some(url => !props.panel.referenceImages.includes(url)))
+const canGenerate = computed(() => !readOnly.value && references.value.length > 0 && !missingReferences.value)
+const historyImages = computed(() => {
+  const entries = [
+    ...(props.frame.url ? [{ url: props.frame.url, taskId: props.frame.taskId }] : []),
+    ...[...(props.frame.history || [])].reverse(),
+  ]
+  return entries.filter((entry, index) => entry.url && entries.findIndex(item => item.url === entry.url) === index)
+})
+const heading = computed(() => props.isNew ? '添加分镜画面' : '生成设置')
+const subtitle = computed(() => `${props.panel.title} · ${props.isNew ? '新画面' : props.frame.title || '分镜画面'}`)
+const invalidTime = computed(() => !Number.isFinite(seconds.value) || seconds.value < 0 || seconds.value > maxSeconds.value)
+const previousFocus = props.returnFocus || (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
+
+function toggleReference(url: string) {
+  if (readOnly.value) return
+  draft.value.referenceImages = references.value.includes(url)
+    ? references.value.filter(item => item !== url) : [...references.value, url]
+}
+function save(generate = false) {
+  if (readOnly.value || !form.value?.reportValidity()) return
+  if (invalidTime.value || missingReferences.value || (generate && !canGenerate.value)) return
+  const changes: Partial<Keyframe> = {}
+  for (const key of ['title', 'prompt', 'shotType', 'angle', 'composition'] as const) {
+    if (draft.value[key] !== initial[key]) changes[key] = draft.value[key]
+  }
+  const offsetMs = Math.round(seconds.value * 1000)
+  if (offsetMs !== initial.offsetMs) changes.offsetMs = offsetMs
+  if (JSON.stringify(draft.value.referenceImages) !== JSON.stringify(initial.referenceImages)) {
+    changes.referenceImages = draft.value.referenceImages ? [...draft.value.referenceImages] : undefined
+  }
+  if (draft.value.url !== initial.url) {
+    const selected = historyImages.value.find(entry => entry.url === draft.value.url)
+    if (selected) { changes.url = selected.url; changes.taskId = selected.taskId }
+  }
+  emit('frame', changes, generate)
+}
+function onKey(event: KeyboardEvent) {
+  // Keep editor shortcuts local; the workbench also listens for space/arrows/undo.
+  event.stopPropagation()
+  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
+    event.preventDefault()
+    save()
+  }
+}
+onMounted(() => {
+  dialog.value?.showModal()
+})
+onBeforeUnmount(() => dialog.value?.close())
+onUnmounted(() => {
+  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
+})
+</script>
+
+<template>
+  <Teleport to="body">
+    <dialog
+      ref="dialog"
+      class="frame-settings-dialog"
+      :aria-labelledby="titleId"
+      :aria-describedby="descriptionId"
+      @cancel.prevent="emit('close')"
+      @click.self="emit('close')"
+      @keydown="onKey"
+    >
+      <form ref="form" @submit.prevent="save()">
+        <header class="settings-header">
+          <span class="settings-icon"><SlidersHorizontal :size="20" /></span>
+          <div><h2 :id="titleId">{{ heading }}</h2><p :id="descriptionId">{{ subtitle }}</p></div>
+          <button type="button" class="btn btn-icon" aria-label="关闭生成设置" @click="emit('close')"><X :size="18" /></button>
+        </header>
+
+        <div class="settings-body with-preview">
+          <aside class="settings-preview">
+            <div class="settings-image">
+              <img v-if="draft.url || frame.url" :src="mediaUrl(draft.url || frame.url)" :alt="draft.title || '分镜画面'">
+              <span v-else><ImagePlus :size="32" />画面生成后显示在这里</span>
+            </div>
+            <div class="settings-preview-meta"><b>{{ draft.title || '未命名画面' }}</b><span>{{ seconds || 0 }} 秒 / {{ panel.durationMs / 1000 }} 秒</span></div>
+            <p class="settings-hint">参考素材仅用于生成这张画面。视频会使用镜头内的全部分镜画面。</p>
+            <div v-if="historyImages.length > 1" class="settings-history">
+              <h3>历史图片 <span>{{ historyImages.length }}</span></h3>
+              <div>
+                <button
+                  v-for="(entry, index) in historyImages" :key="entry.url" type="button"
+                  :disabled="readOnly" :class="{ selected: draft.url === entry.url, current: frame.url === entry.url }"
+                  :aria-pressed="draft.url === entry.url" :aria-label="`使用历史图片 ${index + 1}`"
+                  @click="draft.url = entry.url"
+                ><img :src="mediaUrl(entry.url)" :alt="`历史图片 ${index + 1}`"><span v-if="frame.url === entry.url">当前</span><Check v-if="draft.url === entry.url" :size="14" /></button>
+              </div>
+              <p class="settings-hint">选择历史图片后点击保存，即可切换当前使用画面。</p>
+            </div>
+          </aside>
+
+          <div class="settings-fields">
+            <p v-if="readOnly" class="settings-notice">当前版本不可编辑，可查看画面设置。</p>
+              <div class="settings-pair">
+                <label>画面名称<input v-model="draft.title" :disabled="readOnly" maxlength="200" placeholder="如：人物推门进入"></label>
+                <label>出现时间点 / 秒<input v-model.number="seconds" :disabled="readOnly" type="number" min="0" :max="maxSeconds" step="0.001" required></label>
+              </div>
+              <p v-if="invalidTime" class="settings-error" role="alert">时间点需在 0–{{ maxSeconds }} 秒之间。</p>
+              <label>画面提示词
+                <textarea v-model="draft.prompt" :disabled="readOnly" rows="5" maxlength="20000" placeholder="描述这张画面的动作、构图、光线和人物状态；留空时使用镜头描述与氛围。" />
+              </label>
+              <div class="settings-section-heading"><h3>镜头与构图</h3><span>留空时沿用镜头设置</span></div>
+              <div class="settings-pair">
+                <label>景别<input v-model="draft.shotType" :disabled="readOnly" :placeholder="panel.shotType || '如：中景'" maxlength="200"></label>
+                <label>视角<input v-model="draft.angle" :disabled="readOnly" :placeholder="panel.angle || '如：平视'" maxlength="200"></label>
+              </div>
+              <label>构图<input v-model="draft.composition" :disabled="readOnly" placeholder="如：三分法、前景遮挡、人物位于画面右侧" maxlength="1000"></label>
+
+              <div class="settings-section-heading">
+                <h3>参考素材 <span>{{ references.length }} / {{ assets.length }}</span></h3>
+                <button v-if="draft.referenceImages" type="button" class="settings-reset" :disabled="readOnly" @click="draft.referenceImages = undefined"><RotateCcw :size="12" />沿用全部</button>
+                <span v-else>沿用镜头素材</span>
+              </div>
+              <div v-if="assets.length" class="settings-assets">
+                <button
+                  v-for="asset in assets" :key="asset.url" type="button"
+                  :class="{ selected: references.includes(asset.url) }" :disabled="readOnly"
+                  :aria-pressed="references.includes(asset.url)" :title="asset.label"
+                  @click="toggleReference(asset.url)"
+                ><img :src="mediaUrl(asset.url)" :alt="asset.label"><span>{{ asset.label }}</span><i><Check v-if="references.includes(asset.url)" :size="12" /></i></button>
+              </div>
+              <p v-else class="settings-notice">还没有参考素材。请先在视频制作页绑定角色、场景或道具图片。</p>
+              <p v-if="assets.length && !references.length" class="settings-notice">请选择至少一项参考素材后生成画面；也可以先保存设置。</p>
+              <p v-if="missingReferences" class="settings-error" role="alert">部分参考素材已被解绑，请点击“沿用全部”后重新选择。</p>
+          </div>
+        </div>
+        <footer class="settings-footer">
+          <span>{{ readOnly ? '只读' : '保存后生效' }}</span>
+          <button type="button" class="btn" @click="emit('close')">{{ readOnly ? '关闭' : '取消' }}</button>
+          <button v-if="!readOnly" type="submit" class="btn" :disabled="invalidTime || missingReferences">保存设置</button>
+          <button v-if="!readOnly" type="button" class="btn btn-primary" :disabled="!canGenerate || invalidTime" @click="save(true)"><Sparkles :size="14" />保存并{{ frame.url ? '重新生成' : '生成' }}</button>
+        </footer>
+      </form>
+    </dialog>
+  </Teleport>
+</template>
+
+<style scoped>
+.frame-settings-dialog {
+  width: min(860px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 40px);
+  margin: auto; padding: 0; overflow: hidden; color: var(--text-0); background: var(--surface-raised);
+  border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-elevated);
+  font: 13px/1.6 var(--font-body);
+}
+.frame-settings-dialog::backdrop { background: var(--scrim); backdrop-filter: blur(5px); }
+.frame-settings-dialog form { display: flex; flex-direction: column; max-height: calc(100dvh - 42px); }
+.settings-header { display: flex; align-items: center; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
+.settings-icon { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--radius); background: var(--accent-bg); color: var(--accent-text); }
+.settings-header > div { min-width: 0; }
+.settings-header h2 { font-size: 17px; margin: 0; }
+.settings-header p { margin: 3px 0 0; color: var(--text-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
+.settings-header > button { margin-left: auto; flex-shrink: 0; background: transparent; box-shadow: none; }
+.settings-body { overflow: auto; min-height: 0; padding: 22px; }
+.settings-body.with-preview { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; }
+.settings-preview { min-width: 0; align-self: start; }
+.settings-image { aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center; border-radius: var(--radius); overflow: hidden; background: var(--media-surface); color: var(--on-media); }
+.settings-image img { width: 100%; height: 100%; object-fit: contain; }
+.settings-image > span { display: flex; align-items: center; flex-direction: column; gap: 12px; font-size: 11px; opacity: .7; }
+.settings-preview-meta { display: flex; flex-direction: column; gap: 2px; padding: 12px 0 8px; }
+.settings-preview-meta b { font-size: 13px; overflow-wrap: anywhere; }
+.settings-preview-meta span { font: 11px var(--font-mono); color: var(--text-2); }
+.settings-hint { color: var(--text-2); font-size: 12px; margin: 0; }
+.settings-history { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 14px; }
+.settings-history h3, .settings-section-heading h3 { font-size: 12px; margin: 0; }
+.settings-history h3 span, .settings-section-heading h3 span { color: var(--text-2); font-weight: 400; margin-left: 5px; }
+.settings-history > div { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 8px 0; }
+.settings-history button { position: relative; padding: 0; aspect-ratio: 4/3; overflow: hidden; border: 2px solid transparent; border-radius: var(--radius-sm); background: var(--media-surface); cursor: pointer; }
+.settings-history img { width: 100%; height: 100%; object-fit: contain; }
+.settings-history button.selected { border-color: var(--accent); }
+.settings-history button svg { position: absolute; bottom: 2px; right: 2px; background: var(--accent); color: var(--on-accent); border-radius: 50%; }
+.settings-history button > span { position: absolute; left: 3px; top: 3px; padding: 1px 4px; border-radius: 3px; background: var(--scrim); color: var(--on-media); font-size: 8px; line-height: 1.5; }
+.settings-fields { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
+.settings-fields label { min-width: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-1); }
+.settings-fields input, .settings-fields textarea {
+  width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--border-strong); border-radius: var(--radius);
+  color: var(--text-0); background: var(--surface-input); font: 13px/1.6 var(--font-body); outline: none;
+}
+.settings-fields textarea { resize: vertical; min-height: 120px; }
+.settings-fields input:focus-visible, .settings-fields textarea:focus-visible { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--button-focus); }
+.settings-fields input::placeholder, .settings-fields textarea::placeholder { color: var(--text-3); font-weight: 400; }
+.settings-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
+.settings-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--border); padding-top: 16px; }
+.settings-section-heading > span { color: var(--text-2); font-size: 11px; }
+.settings-reset { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--accent-text); font: 11px var(--font-body); cursor: pointer; }
+.settings-assets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
+.settings-assets button { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-soft); color: var(--text-1); text-align: left; cursor: pointer; }
+.settings-assets button.selected { border-color: var(--border-strong); background: var(--bg-active); }
+.settings-assets img { width: 40px; height: 40px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }
+.settings-assets span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--font-body); }
+.settings-assets i { display: grid; place-items: center; width: 16px; height: 16px; margin-left: auto; flex-shrink: 0; border: 1px solid var(--border-strong); border-radius: 4px; }
+.settings-assets .selected i { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
+.settings-notice { display: flex; align-items: center; gap: 6px; margin: 0; padding: 10px; background: var(--warning-bg); color: var(--tag-warning-text); font-size: 12px; border-radius: var(--radius); }
+.settings-notice svg { flex-shrink: 0; }
+.settings-error { margin: 0; font-size: 12px; color: var(--error); }
+.settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 22px; border-top: 1px solid var(--border); flex-shrink: 0; }
+.settings-footer > span { margin-right: auto; color: var(--text-3); font-size: 11px; }
+.frame-settings-dialog :disabled { opacity: .5; cursor: not-allowed; }
+.frame-settings-dialog button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
+@media (max-width: 640px) {
+  .settings-header { padding: 14px; gap: 8px; }
+  .settings-header p { max-width: 230px; }
+  .settings-body { padding: 14px; }
+  .settings-body.with-preview { grid-template-columns: 1fr; gap: 18px; }
+  .settings-image { aspect-ratio: 16/9; max-height: 180px; }
+  .settings-preview > .settings-hint { display: none; }
+  .settings-history { margin-top: 8px; }
+  .settings-footer { padding: 12px; flex-wrap: wrap; gap: 6px; }
+  .settings-footer > span { display: none; }
+  .settings-footer .btn { padding: 0 10px; font-size: 12px; }
+  .settings-pair { gap: 8px; }
+  .settings-assets { gap: 6px; }
+}
+</style>
diff --git a/frontend/app/components/previs/PrevisPlayer.vue b/frontend/app/components/previs/PrevisPlayer.vue
new file mode 100644
index 0000000..b510672
--- /dev/null
+++ b/frontend/app/components/previs/PrevisPlayer.vue
@@ -0,0 +1,187 @@
+<script setup lang="ts">
+import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
+import { Clapperboard, Film, Images, Maximize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-vue-next'
+import { posterOf } from '~/composables/useMedia'
+import { durationMs, formatTime, mediaUrl, orderedFrames, timelineSegments, type Timeline } from '~/composables/usePrevis'
+
+type PlayerView = 'storyboard' | 'video' | 'script'
+
+const props = defineProps<{
+  timeline: Timeline; currentMs: number; view: PlayerView
+  videoSources: Record<number, { url: string; offsetMs: number }>
+  storyboardIsVideoInput: boolean
+}>()
+const emit = defineEmits<{ seek: [ms: number]; playing: [value: boolean] }>()
+const playing = ref(false), muted = ref(false), volume = ref(1), rate = ref(1), expanded = ref(false)
+const video = ref<HTMLVideoElement>(), canvas = ref<HTMLElement>(), failedVideos = ref<string[]>([])
+const segments = computed(() => timelineSegments(props.timeline)), total = computed(() => durationMs(props.timeline))
+const segment = computed(() => segments.value.find(s => props.currentMs >= s.startMs && props.currentMs < s.endMs) || segments.value.at(-1))
+const frame = computed(() => {
+  const s = segment.value
+  if (!s) return ''
+  const offset = props.currentMs - s.startMs
+  return orderedFrames(s.panel).filter(f => f.url && (f.offsetMs || 0) <= offset).at(-1)?.url
+    || orderedFrames(s.panel).find(f => f.url)?.url || ''
+})
+const motionStyle = computed(() => {
+  const s = segment.value
+  if (!s) return {}
+  const ratio = Math.max(0, Math.min(1, (props.currentMs - s.startMs) / s.panel.durationMs))
+  return { transform: /摇|移|跟/.test(s.panel.movement) ? `scale(1.06) translateX(${(ratio - .5) * 4}%)`
+    : /推|拉/.test(s.panel.movement) ? `scale(${1 + ratio * .055})` : 'none' }
+})
+const videoSource = computed(() => {
+  const s = segment.value
+  if (!s) return null
+  if (Object.prototype.hasOwnProperty.call(props.videoSources, s.panel.id)) {
+    return props.videoSources[s.panel.id]?.url ? props.videoSources[s.panel.id] : null
+  }
+  return s.panel.videoUrl ? { url: s.panel.videoUrl, offsetMs: 0 } : null
+})
+const playableVideoSource = computed(() =>
+  props.view === 'video' && videoSource.value && !failedVideos.value.includes(videoSource.value.url)
+    ? videoSource.value
+    : null)
+const videoPoster = computed(() => playableVideoSource.value
+  ? posterOf(mediaUrl(playableVideoSource.value.url)) || (frame.value ? mediaUrl(frame.value) : '')
+  : '')
+const playableView = computed(() => props.view === 'storyboard' || props.view === 'video')
+const timelineAudioEnabled = computed(() => !playableVideoSource.value)
+const sourceLabel = computed(() => props.view === 'storyboard'
+  ? `分镜预演 · ${props.storyboardIsVideoInput ? '视频输入' : '非视频输入'}`
+  : playableVideoSource.value ? '生成视频' : '分镜回退')
+const emptyTitle = computed(() => props.view === 'video' ? '视频与分镜画面均未就绪' : '分镜画面等待就绪')
+const emptyHint = computed(() => props.view === 'video' ? '当前镜头生成视频缺失，且没有可回退的分镜画面' : '为当前分镜生成或上传画面，开始预演')
+const activeClips = computed(() => props.timeline.audio.filter(a => props.currentMs >= a.startMs && props.currentMs < a.startMs + a.durationMs))
+const caption = computed(() => activeClips.value.filter(a => a.type !== 'sound').map(a => `${a.character ? `${a.character}：` : ''}${a.text}`).join('\n'))
+const audioElements = new Map<string, { url: string; el: HTMLAudioElement }>()
+let animation = 0, lastTick = 0, lastAudioTick = 0
+function stop() { playing.value = false }
+function seek(ms: number) {
+  emit('seek', Math.max(0, Math.min(total.value, ms)))
+  void nextTick(syncMedia)
+}
+function toggle() {
+  if (!total.value) return
+  if (!playing.value && props.currentMs >= total.value) seek(0)
+  playing.value = !playing.value
+}
+function skip(direction: number) {
+  const index = segments.value.findIndex(s => s === segment.value)
+  seek(segments.value[Math.max(0, Math.min(segments.value.length - 1, index + direction))]?.startMs || 0)
+}
+function toggleMute() {
+  if (muted.value && volume.value === 0) volume.value = 1
+  muted.value = !muted.value
+}
+function setVolume(event: Event) {
+  volume.value = Math.max(0, Math.min(1, Number((event.target as HTMLInputElement).value) / 100))
+  muted.value = volume.value === 0
+}
+function markVideoFailed(url: string) {
+  if (url && !failedVideos.value.includes(url)) failedVideos.value.push(url)
+  void nextTick(syncMedia)
+}
+function syncMedia() {
+  const targetVideo = video.value, s = segment.value, source = playableVideoSource.value
+  if (targetVideo && s && source) {
+    const target = Math.max(0, (props.currentMs - s.startMs + source.offsetMs) / 1000)
+    if (Number.isFinite(targetVideo.duration) && Math.abs(targetVideo.currentTime - target) > .3) {
+      targetVideo.currentTime = Math.min(target, Math.max(0, targetVideo.duration - .03))
+    }
+    targetVideo.muted = muted.value; targetVideo.volume = volume.value; targetVideo.playbackRate = rate.value
+    if (playing.value && target < (targetVideo.duration || Infinity)) void targetVideo.play().catch(() => {})
+    else targetVideo.pause()
+  } else targetVideo?.pause()
+  const active = new Set(timelineAudioEnabled.value ? activeClips.value.map(c => c.id) : [])
+  for (const [id, { el }] of audioElements) if (!active.has(id) || !playing.value) el.pause()
+  if (!timelineAudioEnabled.value) return
+  for (const clip of activeClips.value) {
+    if (clip.url) {
+      let source = audioElements.get(clip.id)
+      if (!source || source.url !== clip.url) {
+        source?.el.pause()
+        source = { url: clip.url, el: new Audio(mediaUrl(clip.url)) }
+        audioElements.set(clip.id, source)
+      }
+      const audio = source.el, target = (props.currentMs - clip.startMs) / 1000
+      if (Math.abs(audio.currentTime - target) > .3) audio.currentTime = target
+      audio.muted = muted.value; audio.volume = volume.value; audio.playbackRate = rate.value
+      if (playing.value && target < (audio.duration || Infinity)) void audio.play().catch(() => {})
+    }
+  }
+}
+function tick(now: number) {
+  if (!playing.value) return
+  const elapsed = Math.min(now - lastTick, 250) * rate.value
+  lastTick = now
+  const next = Math.min(total.value, props.currentMs + elapsed)
+  emit('seek', next)
+  if (now - lastAudioTick > 100) { syncMedia(); lastAudioTick = now }
+  if (next >= total.value) stop()
+  else animation = requestAnimationFrame(tick)
+}
+watch(playing, value => {
+  emit('playing', value); cancelAnimationFrame(animation)
+  if (value) { lastTick = performance.now(); animation = requestAnimationFrame(tick) }
+  syncMedia()
+})
+watch([muted, volume, rate], syncMedia)
+watch(() => playableVideoSource.value?.url, () => {
+  video.value?.pause()
+  void nextTick(syncMedia)
+})
+watch(() => props.view, () => {
+  stop()
+  void nextTick(syncMedia)
+})
+watch(() => props.currentMs, () => { if (!playing.value) syncMedia() })
+function fullscreen() {
+  if (!document.fullscreenElement) void canvas.value?.requestFullscreen().catch(() => { expanded.value = !expanded.value })
+  else void document.exitFullscreen()
+}
+onUnmounted(() => {
+  cancelAnimationFrame(animation)
+  for (const { el } of audioElements.values()) { el.pause(); el.src = '' }
+})
+defineExpose({ stop, toggle, seek })
+</script>
+
+<template>
+  <div class="pv-player">
+    <div ref="canvas" class="pv-canvas" :class="{ expanded }">
+      <template v-if="playableView">
+        <video v-if="playableVideoSource" ref="video" :src="mediaUrl(playableVideoSource.url)" :poster="videoPoster || undefined" playsinline preload="auto" @loadedmetadata="syncMedia" @error="markVideoFailed(videoSource?.url || '')" />
+        <img v-else-if="frame" :src="mediaUrl(frame)" :alt="segment?.panel.title" :style="motionStyle">
+        <div v-else class="pv-no-frame"><Clapperboard :size="40" :stroke-width="1" /><strong>{{ emptyTitle }}</strong><span>{{ emptyHint }}</span></div>
+        <div class="pv-shot-stamp"><span>SHOT {{ String(segments.indexOf(segment!) + 1).padStart(2, '0') }}</span><b>{{ segment?.panel.shotType }} · {{ segment?.panel.movement || '静止' }}</b></div>
+        <div class="pv-source-badge" :class="{ 'is-video': !!playableVideoSource, 'is-fallback': view === 'video' && !playableVideoSource }"><Film v-if="playableVideoSource" :size="10" /><Images v-else :size="10" />{{ sourceLabel }}</div>
+        <div v-if="caption" class="pv-subtitle">{{ caption }}</div>
+      </template>
+      <div v-else class="pv-script"><small>剧本节拍 / {{ segment?.panel.title }}</small><h3>{{ caption || segment?.panel.title }}</h3><p>{{ segment?.panel.description || '当前分镜尚无画面描述' }}</p><small>{{ segment?.panel.scene }}</small></div>
+      <button
+        v-if="playableView"
+        class="pv-canvas-play"
+        :class="{ playing }"
+        :aria-label="playing ? '暂停预览' : '播放预览'"
+        :disabled="!total"
+        @click="toggle"
+      >
+        <Pause v-if="playing" :size="22" /><Play v-else :size="22" />
+      </button>
+      <button class="pv-expand" aria-label="全屏预览" @click="fullscreen"><Maximize2 :size="16" /></button>
+    </div>
+    <div class="pv-player-controls">
+      <button aria-label="上一个镜头" @click="skip(-1)"><SkipBack :size="15" /></button>
+      <button aria-label="下一个镜头" @click="skip(1)"><SkipForward :size="15" /></button>
+      <span class="pv-time">{{ formatTime(currentMs) }}</span>
+      <input class="pv-progress" type="range" aria-label="预演播放进度" min="0" :max="total" step="100" :value="currentMs" @input="seek(Number(($event.target as HTMLInputElement).value))">
+      <span class="pv-time pv-muted">{{ formatTime(total) }}</span>
+      <div class="pv-volume-control">
+        <button :aria-label="muted ? '取消静音' : '静音'" @click="toggleMute"><VolumeX v-if="muted || volume === 0" :size="16" /><Volume2 v-else :size="16" /></button>
+        <input type="range" aria-label="预演音量" min="0" max="100" step="5" :value="Math.round(volume * 100)" :title="`音量 ${Math.round(volume * 100)}%`" @input="setVolume">
+      </div>
+      <select v-model.number="rate" aria-label="播放速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="1.5">1.5×</option><option :value="2">2×</option></select>
+    </div>
+  </div>
+</template>
diff --git a/frontend/app/components/previs/PrevisTimeline.vue b/frontend/app/components/previs/PrevisTimeline.vue
new file mode 100644
index 0000000..5f9d6e6
--- /dev/null
+++ b/frontend/app/components/previs/PrevisTimeline.vue
@@ -0,0 +1,145 @@
+<script setup lang="ts">
+import { computed, onUnmounted, ref } from 'vue'
+import { Film, Images, Minus, Plus } from 'lucide-vue-next'
+import { posterOf } from '~/composables/useMedia'
+import {
+  durationMs, formatTime, frameKey, mediaUrl, orderedFrames, timelineSegments,
+  type Keyframe, type Panel, type Timeline,
+} from '~/composables/usePrevis'
+type Segment = ReturnType<typeof timelineSegments>[number]
+const props = defineProps<{
+  timeline: Timeline; currentMs: number; groupId: string; activeFrameId: string
+  videoPreview: boolean; videoSources: Record<number, { url: string; offsetMs: number }>
+  editable: boolean
+}>()
+const emit = defineEmits<{
+  seek: [ms: number]; select: [groupId: string, panelId?: number]; audio: [id: string]
+  duration: [panelId: number, ms: number]; moveAudio: [id: string, startMs: number, durationMs: number]
+}>()
+const zoom = ref(100), tracks = ref<HTMLElement>()
+const segments = computed(() => timelineSegments(props.timeline)), total = computed(() => Math.max(1000, durationMs(props.timeline)))
+const baseTrackWidth = computed(() => Math.max(720, segments.value.reduce((width, segment) =>
+  width + Math.max(140, (props.videoPreview && videoSource(segment.panel.id)
+    ? 1 : orderedFrames(segment.panel).filter(frame => frame.url).length) * 44), 0)))
+const tracksWidth = computed(() => `max(${zoom.value}%, ${Math.round(baseTrackWidth.value * zoom.value / 100)}px)`)
+const pos = (ms: number) => `${ms / total.value * 100}%`
+const ticks = computed(() => Array.from({ length: 11 }, (_, i) => total.value * i / 10))
+const availableFrames = (panel: Panel) => orderedFrames(panel).filter(frame => frame.url)
+const videoSource = (panelId: number) => props.videoSources[panelId]?.url ? props.videoSources[panelId] : null
+function videoPoster(panel: Panel, source: { url: string }) {
+  return posterOf(mediaUrl(source.url)) || (availableFrames(panel)[0]?.url ? mediaUrl(availableFrames(panel)[0].url) : '')
+}
+function frameOffset(panel: Panel, frame: Keyframe) {
+  return Math.max(0, Math.min(Math.max(0, panel.durationMs - 1), frame.offsetMs || 0))
+}
+function frameMarker(index: number) {
+  return `图 ${String(index + 1).padStart(2, '0')}`
+}
+function selectFrame(segment: Segment, frame: Keyframe) {
+  emit('select', segment.groupId, segment.panel.id)
+  emit('seek', segment.startMs + frameOffset(segment.panel, frame))
+}
+function selectPanel(segment: Segment) {
+  emit('select', segment.groupId, segment.panel.id)
+  emit('seek', segment.startMs)
+}
+const dragging = ref<{ id: string; startMs: number; durationMs: number } | null>(null)
+let cleanupDrag = () => {}
+let ignoreClickUntil = 0
+function openAudio(id: string) {
+  if (Date.now() >= ignoreClickUntil) emit('audio', id)
+}
+function drag(event: PointerEvent, kind: 'move' | 'trim' | 'panel', id: string | number) {
+  if (!props.editable || !tracks.value) return
+  event.preventDefault(); event.stopPropagation()
+  const panel = segments.value.find(s => s.panel.id === id)?.panel
+  const clip = props.timeline.audio.find(c => c.id === id)
+  const start = clip?.startMs || 0, duration = clip?.durationMs || panel?.durationMs || 1000
+  const x = event.clientX, scale = total.value / tracks.value.getBoundingClientRect().width
+  let moved = false
+  dragging.value = { id: String(id), startMs: start, durationMs: duration }
+  function move(e: PointerEvent) {
+    if (Math.abs(e.clientX - x) > 3) moved = true
+    const delta = Math.round((e.clientX - x) * scale / 100) * 100
+    dragging.value = {
+      id: String(id), startMs: kind === 'move' ? Math.max(0, Math.min(total.value - 100, start + delta)) : start,
+      durationMs: kind === 'move' ? duration : Math.max(100, duration + delta),
+    }
+  }
+  function end() {
+    const value = dragging.value
+    cleanupDrag()
+    if (!value || !moved) return
+    ignoreClickUntil = Date.now() + 300
+    if (kind === 'panel') emit('duration', Number(id), value.durationMs)
+    else emit('moveAudio', String(id), value.startMs, value.durationMs)
+  }
+  cleanupDrag = () => {
+    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end)
+    window.removeEventListener('pointercancel', cleanupDrag); dragging.value = null
+  }
+  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end)
+  window.addEventListener('pointercancel', cleanupDrag)
+}
+function clipStyle(clip: { id: string; startMs: number; durationMs: number }) {
+  const value = dragging.value?.id === clip.id ? dragging.value : clip
+  return { left: pos(value.startMs), width: pos(value.durationMs) }
+}
+function seekRuler(event: MouseEvent) {
+  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
+  emit('seek', (event.clientX - rect.left) / rect.width * total.value)
+}
+onUnmounted(() => cleanupDrag())
+</script>
+
+<template>
+  <section class="pv-timeline">
+    <header class="pv-timeline-header"><div><span class="pv-eyebrow">时间轴</span><b>{{ timeline.panels.length }} 个分镜 · {{ formatTime(total) }}</b></div><small>拖动音频调整位置，拖动片段右边缘调整时长</small><div class="pv-zoom"><button aria-label="缩小时间线" :disabled="zoom <= 100" @click="zoom -= 25"><Minus :size="14" /></button><span>{{ zoom }}%</span><button aria-label="放大时间线" :disabled="zoom >= 400" @click="zoom += 25"><Plus :size="14" /></button></div></header>
+    <div class="pv-track-layout">
+      <div class="pv-track-labels"><span>时间</span><span>镜头 / 画面</span><span>对白</span><span>旁白</span><span>声音</span></div>
+      <div class="pv-track-scroll">
+        <div ref="tracks" class="pv-tracks" :style="{ width: tracksWidth }">
+          <div class="pv-ruler" @click="seekRuler"><span v-for="tick in ticks" :key="tick" :style="{ left: pos(tick) }">{{ formatTime(tick) }}</span></div>
+          <div class="pv-track pv-frame-track"><div v-for="s in segments" :key="s.panel.id" class="pv-frame-clip" :class="{ active: groupId === s.groupId, 'is-fallback': videoPreview && !videoSource(s.panel.id) }" :style="{ left: pos(s.startMs), width: pos(dragging?.id === String(s.panel.id) ? dragging.durationMs : s.panel.durationMs) }">
+            <button
+              v-if="videoPreview && videoSource(s.panel.id)"
+              type="button"
+              class="pv-video-thumb"
+              :class="{ active: currentMs >= s.startMs && currentMs < s.endMs }"
+              :aria-label="`选择视频 ${s.panel.title}`"
+              :aria-pressed="currentMs >= s.startMs && currentMs < s.endMs"
+              :title="`${s.panel.title} · 生成视频`"
+              @click="selectPanel(s)"
+            >
+              <video :src="mediaUrl(videoSource(s.panel.id)!.url)" :poster="videoPoster(s.panel, videoSource(s.panel.id)!) || undefined" muted playsinline preload="none" tabindex="-1" aria-hidden="true" />
+              <span class="pv-media-kind"><Film :size="9" />视频</span>
+            </button>
+            <div v-else-if="availableFrames(s.panel).length" class="pv-frame-strip">
+              <button
+                v-for="(frame, index) in availableFrames(s.panel)"
+                :key="frameKey(frame)"
+                type="button"
+                class="pv-frame-thumb"
+                :class="{ active: activeFrameId === frameKey(frame) }"
+                :aria-label="`选择 ${s.panel.title} · ${frame.title || `画面 ${index + 1}`} · ${(frameOffset(s.panel, frame) / 1000).toFixed(1)} 秒`"
+                :aria-pressed="activeFrameId === frameKey(frame)"
+                :title="`${frame.title || `画面 ${index + 1}`} · ${(frameOffset(s.panel, frame) / 1000).toFixed(1)}s`"
+                @click="selectFrame(s, frame)"
+              ><img :src="mediaUrl(frame.url)" :alt="frame.title || '分镜画面'" loading="lazy"><span class="pv-frame-mark"><Images :size="8" />{{ frameMarker(index) }}</span></button>
+            </div>
+            <button v-else type="button" class="pv-frame-empty" :title="`${s.panel.title} · 暂无可用画面`" @click="selectPanel(s)">暂无画面</button>
+            <span v-if="videoPreview && !videoSource(s.panel.id)" class="pv-media-kind fallback"><Images :size="9" />分镜回退</span>
+            <span class="pv-frame-title">{{ s.panel.title }}</span>
+            <span v-if="editable" class="pv-trim" title="拖动调整分镜时长" @pointerdown="drag($event, 'panel', s.panel.id)" />
+          </div></div>
+          <div v-for="type in (['dialogue', 'narration', 'sound'] as const)" :key="type" class="pv-track pv-audio-track" :class="type">
+            <div v-for="clip in timeline.audio.filter(c => c.type === type)" :key="clip.id" class="pv-audio-clip" :style="clipStyle(clip)">
+              <button :title="clip.text || '音频片段'" @click="openAudio(clip.id)" @pointerdown="drag($event, 'move', clip.id)">{{ clip.character }} {{ clip.text || '音频片段' }}</button><span v-if="editable" class="pv-trim" title="拖动调整音频时长" @pointerdown="drag($event, 'trim', clip.id)" />
+            </div>
+          </div>
+          <div class="pv-playhead" :style="{ left: pos(currentMs) }"><i /></div>
+        </div>
+      </div>
+    </div>
+  </section>
+</template>
diff --git a/frontend/app/components/previs/StoryboardFramesEditor.vue b/frontend/app/components/previs/StoryboardFramesEditor.vue
new file mode 100644
index 0000000..a11344e
--- /dev/null
+++ b/frontend/app/components/previs/StoryboardFramesEditor.vue
@@ -0,0 +1,305 @@
+<script setup lang="ts">
+import { computed, nextTick, ref, shallowRef, watch } from 'vue'
+import { toast } from 'vue-sonner'
+import {
+  Film, History, ImagePlus, Loader2, MoreHorizontal,
+  SlidersHorizontal, Sparkles, Star, Upload,
+} from 'lucide-vue-next'
+import AppMenu from '~/components/AppMenu.vue'
+import AppMenuItem from '~/components/AppMenuItem.vue'
+import FrameSettingsDialog from './FrameSettingsDialog.vue'
+import { uploadAPI } from '~/composables/useApi'
+import {
+  frameKey, makeFrame, mediaUrl, orderedFrames, panelImageFallback, planFrames,
+  type BatchItem, type Keyframe, type Panel,
+} from '~/composables/usePrevis'
+
+const props = withDefaults(defineProps<{
+  panel: Panel
+  editable: boolean
+  tasks?: BatchItem[]
+  showVideoAction?: boolean
+  videoGenerationMode?: 'direct' | 'storyboard_frames'
+  activeFrameId?: string
+  title?: string
+}>(), {
+  tasks: () => [], showVideoAction: false, videoGenerationMode: 'direct', activeFrameId: '', title: '分镜画面',
+})
+const emit = defineEmits<{
+  change: [frames: Keyframe[], coverFrameId?: string]
+  generate: [frameIds: string[], force?: boolean]
+  video: []
+  'settings-open': []
+}>()
+
+const uploading = ref('')
+const uploadTarget = ref<{ panelId: number; frameId: string }>()
+const fileInput = ref<HTMLInputElement>()
+const settingsTrigger = shallowRef<HTMLElement>()
+const menuId = ref('')
+const toolbarMenu = ref(false)
+const settings = ref<{ panelId: number; frameId?: string; newFrame?: Keyframe }>()
+const frames = computed(() => orderedFrames(props.panel))
+const usesStoryboardFrames = computed(() => props.videoGenerationMode === 'storyboard_frames')
+const settingsFrame = computed(() => settings.value?.newFrame
+  || props.panel.frames.find(frame => frameKey(frame) === settings.value?.frameId))
+const missingVideoFrames = computed(() => frames.value.filter(frame => !frame.url).length)
+const videoReady = computed(() => !usesStoryboardFrames.value || (frames.value.length > 0 && missingVideoFrames.value === 0))
+const missingFrames = computed(() => frames.value.filter(frame => !frame.url))
+const canGenerateMissing = computed(() => props.editable && missingFrames.value.length > 0
+  && missingFrames.value.every(canGenerate))
+
+function task(frame: Keyframe) {
+  return props.tasks.find(item => item.frameId === frameKey(frame) || (!item.frameId && item.frameType === frame.type))
+}
+function inProgress(frame: Keyframe) { return ['pending', 'processing'].includes(task(frame)?.status || '') }
+function frameReferenceUrls(frame: Keyframe) { return frame.referenceImages ?? props.panel.referenceImages }
+function frameHistoryCount(frame: Keyframe) {
+  return [...(frame.history || []), ...(frame.url ? [{ url: frame.url }] : [])]
+    .filter((entry, index, all) => entry.url && all.findIndex(item => item.url === entry.url) === index).length
+}
+function canEdit(frame: Keyframe) { return props.editable && !inProgress(frame) && uploading.value !== frameKey(frame) }
+function canGenerate(frame: Keyframe) { return canEdit(frame) && frameReferenceUrls(frame).length > 0 }
+function status(frame: Keyframe) {
+  if (uploading.value === frameKey(frame)) return { label: '上传中', kind: 'busy' }
+  if (inProgress(frame)) return { label: task(frame)?.status === 'pending' ? '排队中' : '生成中', kind: 'busy' }
+  if (task(frame)?.status === 'failed') return { label: '生成失败', kind: 'error' }
+  return frame.url ? { label: '已就绪', kind: 'ready' } : { label: '待生成', kind: 'empty' }
+}
+function changed(next: Keyframe[], cover = props.panel.coverFrameId) {
+  if (!props.editable) return
+  emit('change', next, cover && next.some(frame => frameKey(frame) === cover) ? cover : next.find(frame => frame.url)?.id)
+}
+function patch(id: string, value: Partial<Keyframe>) {
+  changed(props.panel.frames.map(frame => frameKey(frame) === id ? { ...frame, ...value } : frame))
+}
+function openSettings(frame: Keyframe, event: Event) {
+  settingsTrigger.value = event.currentTarget as HTMLElement
+  settings.value = { panelId: props.panel.id, frameId: frameKey(frame) }
+  emit('settings-open')
+}
+function add(event: Event) {
+  if (!props.editable) return
+  settingsTrigger.value = event.currentTarget as HTMLElement
+  const lastOffset = frames.value.at(-1)?.offsetMs || 0
+  const offset = frames.value.length ? Math.min(props.panel.durationMs - 1, Math.round((lastOffset + props.panel.durationMs) / 2)) : 0
+  settings.value = { panelId: props.panel.id, newFrame: makeFrame(crypto.randomUUID(), offset, `画面 ${frames.value.length + 1}`) }
+  emit('settings-open')
+}
+async function saveSettings(changes: Partial<Keyframe>, generate: boolean) {
+  const context = settings.value
+  const frame = settingsFrame.value
+  if (!context || context.panelId !== props.panel.id || !frame || !canEdit(frame)) return
+  const updated = { ...frame, ...changes }
+  if (context.newFrame) changed([...props.panel.frames, updated])
+  else if (Object.keys(changes).length) patch(frameKey(frame), changes)
+  settings.value = undefined
+  // Parent change listeners update the shared timeline synchronously; generation reads it after render.
+  await nextTick()
+  const saved = props.panel.frames.find(item => frameKey(item) === frameKey(updated))
+  if (generate && context.panelId === props.panel.id && saved && canGenerate(saved)) {
+    emit('generate', [frameKey(saved)], !!saved.url)
+  }
+}
+function plan() {
+  toolbarMenu.value = false
+  if (!props.editable) return
+  const planned = planFrames(props.panel, crypto.randomUUID())
+  const existing = frames.value
+  const next = planned.map((frame, index) => {
+    const old = existing[index]
+    return old ? { ...old, title: frame.title, offsetMs: frame.offsetMs, prompt: frame.prompt } : frame
+  })
+  // Planning keeps existing extra images while updating matching planned slots.
+  changed([...next, ...existing.slice(planned.length)])
+}
+function menuAction(action: () => void) { menuId.value = ''; action() }
+function move(frame: Keyframe, direction: number) {
+  const next = frames.value.map(item => ({ ...item }))
+  const index = next.findIndex(item => frameKey(item) === frameKey(frame)), target = index + direction
+  if (!canEdit(frame) || target < 0 || target >= next.length || !canEdit(next[target])) return
+  const offset = next[index].offsetMs
+  next[index].offsetMs = next[target].offsetMs
+  next[target].offsetMs = offset
+  // Equal timestamps still need a stable ordering change.
+  const moving = next[index]
+  next[index] = next[target]
+  next[target] = moving
+  changed(next)
+}
+function remove(frame: Keyframe) {
+  if (canEdit(frame)) changed(props.panel.frames.filter(item => frameKey(item) !== frameKey(frame)))
+}
+function chooseUpload(frame: Keyframe) {
+  if (!canEdit(frame) || uploading.value) return
+  uploadTarget.value = { panelId: props.panel.id, frameId: frameKey(frame) }
+  fileInput.value?.click()
+}
+async function upload(event: Event) {
+  const input = event.target as HTMLInputElement, file = input.files?.[0], target = uploadTarget.value
+  input.value = ''
+  uploadTarget.value = undefined
+  if (!file || !target || target.panelId !== props.panel.id) return
+  const frame = props.panel.frames.find(item => frameKey(item) === target.frameId)
+  if (!frame || !canEdit(frame)) return
+  uploading.value = target.frameId
+  try {
+    const result = await uploadAPI.image(file)
+    if (target.panelId !== props.panel.id || !props.editable) return
+    const latest = props.panel.frames.find(item => frameKey(item) === target.frameId)
+    if (!latest) return
+    const url = result.path || result.url
+    const history = [...(latest.history || []), ...(latest.url ? [{ url: latest.url, taskId: latest.taskId }] : []), { url }]
+      .filter((entry, index, all) => all.findIndex(item => item.url === entry.url) === index)
+    patch(target.frameId, { url, taskId: undefined, history })
+  } catch (error: any) { toast.error(error.message || '图片上传失败，请重试') }
+  finally { uploading.value = '' }
+}
+watch(() => props.panel.id, () => {
+  settings.value = undefined
+  menuId.value = ''
+  toolbarMenu.value = false
+})
+watch(settingsFrame, frame => {
+  if (settings.value?.frameId && !frame) settings.value = undefined
+})
+</script>
+
+<template>
+  <section class="frame-editor">
+    <header class="frame-editor-head">
+      <div><strong>{{ title }}</strong><span>{{ frames.length - missingVideoFrames }} / {{ frames.length }} 张已就绪</span></div>
+      <button type="button" class="btn btn-sm" :disabled="!editable" @click="add"><ImagePlus :size="14" />添加画面</button>
+    </header>
+    <div class="frame-editor-tools">
+      <button type="button" class="btn btn-sm frame-fill" :disabled="!canGenerateMissing"
+        :title="missingFrames.some(frame => !frameReferenceUrls(frame).length) ? '请先在生成设置中选择参考素材' : '生成所有缺失画面'"
+        @click="emit('generate', missingFrames.map(frameKey))"><Sparkles :size="13" />生成缺失<span v-if="missingVideoFrames">{{ missingVideoFrames }}</span></button>
+      <AppMenu v-model:open="toolbarMenu" placement="bottom-end">
+        <template #trigger><button type="button" class="btn btn-sm frame-icon" title="更多画面操作" aria-label="更多画面操作"><MoreHorizontal :size="16" /></button></template>
+        <AppMenuItem :disabled="!editable" @click="plan">按镜头描述规划画面</AppMenuItem>
+      </AppMenu>
+    </div>
+    <input ref="fileInput" class="frame-upload-input" type="file" accept="image/*" aria-label="上传分镜画面" @change="upload">
+
+    <div v-if="frames.length" class="frame-editor-grid">
+      <article v-for="(frame, index) in frames" :key="frameKey(frame)" class="frame-card" :class="{ selected: activeFrameId === frameKey(frame) }">
+        <header class="frame-card-head">
+          <span class="frame-index">{{ String(index + 1).padStart(2, '0') }}</span>
+          <strong :title="frame.title">{{ frame.title || `画面 ${index + 1}` }}</strong>
+          <span class="frame-time">{{ ((frame.offsetMs || 0) / 1000).toFixed(1) }}s</span>
+          <AppMenu :open="menuId === frameKey(frame)" placement="bottom-end" @update:open="menuId = $event ? frameKey(frame) : ''">
+            <template #trigger><button type="button" class="btn btn-sm frame-icon" :aria-label="`画面 ${index + 1} 更多操作`"><MoreHorizontal :size="15" /></button></template>
+            <AppMenuItem :disabled="!editable || !frame.url" :selected="panel.coverFrameId === frameKey(frame)" @click="menuAction(() => changed(panel.frames, frameKey(frame)))">设为镜头封面</AppMenuItem>
+            <AppMenuItem :disabled="!canEdit(frame) || index === 0 || !canEdit(frames[index - 1])" @click="menuAction(() => move(frame, -1))">前移一张</AppMenuItem>
+            <AppMenuItem :disabled="!canEdit(frame) || index === frames.length - 1 || !canEdit(frames[index + 1])" @click="menuAction(() => move(frame, 1))">后移一张</AppMenuItem>
+            <AppMenuItem danger :disabled="!canEdit(frame)" @click="menuAction(() => remove(frame))">移除画面</AppMenuItem>
+          </AppMenu>
+        </header>
+        <div class="frame-card-content">
+          <button type="button" class="frame-thumb" :aria-label="`查看画面 ${index + 1} 与生成设置`" @click="openSettings(frame, $event)">
+            <img v-if="frame.url" :src="mediaUrl(frame.url)" :alt="frame.title || '分镜画面'" loading="lazy">
+            <ImagePlus v-else :size="24" />
+            <span v-if="panel.coverFrameId === frameKey(frame)" class="frame-cover"><Star :size="10" fill="currentColor" />封面</span>
+          </button>
+          <div class="frame-card-summary">
+            <div class="frame-state" :class="status(frame).kind"><Loader2 v-if="status(frame).kind === 'busy'" :size="11" class="frame-spin" /><i v-else />{{ status(frame).label }}</div>
+            <p :title="frame.prompt || panelImageFallback(panel)">{{ frame.prompt || panelImageFallback(panel) || '点击生成设置，描述这张画面' }}</p>
+            <small>{{ frameReferenceUrls(frame).length }} 项参考 · {{ frame.shotType || panel.shotType || '默认景别' }}</small>
+          </div>
+        </div>
+        <p v-if="task(frame)?.status === 'failed'" class="frame-error" :title="task(frame)?.error">{{ task(frame)?.error || '生成失败，请检查设置后重试' }}</p>
+        <footer class="frame-card-actions">
+          <button type="button" class="btn btn-sm" :disabled="!canGenerate(frame)" :title="!frameReferenceUrls(frame).length ? '请先在生成设置中选择参考素材' : ''"
+            @click="emit('generate', [frameKey(frame)], !!frame.url)"><Sparkles :size="12" />{{ frame.url ? '重新生成' : '生成' }}</button>
+          <button v-if="frameHistoryCount(frame) > 1" type="button" class="btn btn-sm" title="切换历史图片" @click="openSettings(frame, $event)"><History :size="12" />历史 {{ frameHistoryCount(frame) }}</button>
+          <button type="button" class="btn btn-sm" :disabled="!canEdit(frame) || !!uploading" @click="chooseUpload(frame)"><Upload :size="12" />上传</button>
+          <button type="button" class="btn btn-sm frame-settings-action" @click="openSettings(frame, $event)"><SlidersHorizontal :size="12" />生成设置</button>
+        </footer>
+      </article>
+    </div>
+    <div v-else class="frame-editor-empty">
+      <ImagePlus :size="26" />
+      <strong>还没有分镜画面</strong>
+      <p>手动添加画面，或根据镜头描述规划。</p>
+      <button type="button" class="btn btn-sm" :disabled="!editable" @click="plan"><Sparkles :size="13" />按描述规划</button>
+    </div>
+    <footer class="frame-editor-video">
+      <div><Film :size="14" /><span>{{ usesStoryboardFrames ? (videoReady ? `全部 ${frames.length} 张画面已就绪` : frames.length ? `还需完成 ${missingVideoFrames} 张画面` : '先添加分镜画面') : '当前为直接生成模式' }}<small>{{ usesStoryboardFrames ? '视频按时间顺序使用全部画面' : '这些画面仅用于预演和审核，不作为当前视频输入' }}</small></span></div>
+      <button v-if="showVideoAction" type="button" class="btn btn-primary btn-sm" :disabled="!videoReady" @click="emit('video')"><Film :size="13" />生成视频</button>
+    </footer>
+    <FrameSettingsDialog
+      v-if="settings && settingsFrame"
+      :key="`${settings.panelId}-${settings.frameId || settings.newFrame?.id}`"
+      :panel="panel"
+      :frame="settingsFrame"
+      :return-focus="settingsTrigger"
+      :is-new="!!settings.newFrame"
+      :editable="editable && (!settingsFrame || (!inProgress(settingsFrame) && uploading !== frameKey(settingsFrame)))"
+      @close="settings = undefined"
+      @frame="saveSettings"
+    />
+  </section>
+</template>
+
+<style scoped>
+.frame-editor { min-width: 0; display: flex; flex-direction: column; gap: 10px; container-type: inline-size; }
+.frame-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
+.frame-editor-head > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
+.frame-editor-head strong { color: var(--text-0); font-size: 13px; }
+.frame-editor-head span { color: var(--text-2); font-size: 11px; }
+.frame-editor .btn { font-size: 11px; padding: 0 10px; min-height: 28px; }
+.frame-editor-tools { display: flex; align-items: center; gap: 6px; }
+.frame-editor .frame-fill { flex: 1; justify-content: center; }
+.frame-fill span { min-width: 16px; border-radius: 4px; padding: 1px 4px; background: var(--bg-active); font: 10px var(--font-mono); }
+.frame-editor .frame-icon { width: 28px; min-height: 28px; padding: 0; background: transparent; box-shadow: none; color: var(--text-2); }
+.frame-editor .frame-icon:hover { background: var(--bg-hover); color: var(--text-0); }
+.frame-upload-input { display: none; }
+.frame-editor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); align-items: start; gap: 10px; }
+.frame-card { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); }
+.frame-card:hover { border-color: var(--border-strong); }
+.frame-card.selected {
+  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
+  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
+}
+.frame-card-head { display: flex; align-items: center; gap: 7px; padding: 7px 8px 0; }
+.frame-index { color: var(--text-3); font: 10px var(--font-mono); }
+.frame-card-head strong { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; font-weight: 600; }
+.frame-time { color: var(--text-2); font: 10px var(--font-mono); }
+.frame-card-content { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 7px 10px 10px; }
+.frame-editor .frame-thumb { position: relative; width: 96px; height: 76px; display: flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: var(--radius-sm); overflow: hidden; color: var(--on-media); background: var(--media-surface); box-shadow: none; cursor: pointer; }
+.frame-thumb img { width: 100%; height: 100%; object-fit: contain; }
+.frame-thumb:hover img { opacity: .88; }
+.frame-cover { position: absolute; left: 3px; bottom: 3px; display: flex; align-items: center; gap: 3px; padding: 1px 4px; border-radius: 3px; background: var(--scrim); color: var(--on-media); font-size: 9px; }
+.frame-cover svg { color: var(--warning); }
+.frame-card-summary { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 5px; }
+.frame-state { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text-2); }
+.frame-state i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
+.frame-state.ready { color: var(--success); }
+.frame-state.busy { color: var(--accent-text); }
+.frame-state.error { color: var(--error); }
+.frame-card-summary p { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 0; color: var(--text-1); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
+.frame-card-summary small { width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-2); font-size: 10px; }
+.frame-card-actions { display: flex; align-items: center; gap: 4px; padding: 6px 7px; border-top: 1px solid var(--border); background: var(--surface-soft); }
+.frame-card-actions .btn { flex: 1; padding: 0 6px; min-height: 28px; background: transparent; box-shadow: none; color: var(--text-1); font-weight: 500; }
+.frame-card-actions .btn:hover:not(:disabled) { background: var(--bg-hover); }
+.frame-card-actions .frame-settings-action { color: var(--accent-text); }
+.frame-error { margin: 0 10px 8px; color: var(--error); font-size: 11px; overflow-wrap: anywhere; max-height: 56px; overflow: auto; }
+.frame-editor-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 28px 12px; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--text-2); }
+.frame-editor-empty strong { color: var(--text-1); font-size: 13px; }
+.frame-editor-empty p { font-size: 11px; margin: 0; }
+.frame-editor-video { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0 2px; border-top: 1px solid var(--border); }
+.frame-editor-video > div { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-1); }
+.frame-editor-video small { display: block; margin-top: 2px; font-size: 10px; color: var(--text-3); }
+.frame-editor button:disabled { opacity: .45; cursor: not-allowed; }
+.frame-editor button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
+.frame-spin { animation: frame-spin 1s linear infinite; }
+@keyframes frame-spin { to { transform: rotate(360deg); } }
+@container (max-width: 280px) {
+  .frame-card-content { grid-template-columns: 76px minmax(0, 1fr); gap: 8px; padding: 7px; }
+  .frame-editor .frame-thumb { width: 76px; height: 66px; }
+  .frame-card-actions { gap: 1px; padding: 5px; }
+  .frame-card-actions .btn { font-size: 10px; padding: 0 3px; }
+}
+@media (prefers-reduced-motion: reduce) { .frame-spin { animation: none; } }
+</style>
diff --git a/frontend/app/composables/useApi.ts b/frontend/app/composables/useApi.ts
index de13851..8cbad82 100644
--- a/frontend/app/composables/useApi.ts
+++ b/frontend/app/composables/useApi.ts
@@ -94,11 +94,23 @@ export const taskAPI = {
   generate: (d: any) => api.post('/tasks', d),
   get: (id: number) => api.get(`/tasks/${id}`),
   del: (id: number) => api.del(`/tasks/${id}`),
-  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number }) => {
+  list: (params?: {
+    type?: 'image' | 'video'
+    drama_id?: number
+    storyboard_id?: number
+    character_id?: number
+    scene_id?: number
+    prop_id?: number
+    limit?: number
+  }) => {
     const query = new URLSearchParams()
     if (params?.type) query.set('type', params.type)
     if (params?.drama_id) query.set('drama_id', String(params.drama_id))
     if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
+    if (params?.character_id) query.set('character_id', String(params.character_id))
+    if (params?.scene_id) query.set('scene_id', String(params.scene_id))
+    if (params?.prop_id) query.set('prop_id', String(params.prop_id))
+    if (params?.limit) query.set('limit', String(params.limit))
     return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
   },
   // 按集聚合生成任务（sys_task + video_merges）
diff --git a/frontend/app/composables/usePrevis.ts b/frontend/app/composables/usePrevis.ts
new file mode 100644
index 0000000..9e16581
--- /dev/null
+++ b/frontend/app/composables/usePrevis.ts
@@ -0,0 +1,195 @@
+import { computed, onUnmounted, ref, watch } from 'vue'
+import { toast } from 'vue-sonner'
+import type { AnimaticVersion, Timeline, FrameType } from '../../../backend/src/services/previs-domain'
+import { retimeBoundAudio } from '../../../backend/src/services/previs-domain'
+export {
+  autoGroup, checkContinuity, durationMs, formatTime, frameKey, groupPanels, makeFrame, mediaUrl,
+  orderedFrames, panelImageFallback, planFrames, rebuildTransitions, timelineSegments,
+} from '../../../backend/src/services/previs-domain'
+export type {
+  AnimaticVersion, AudioClip, BatchItem, BatchRun, ContinuityIssue, ContinuityReview, ContinuityReviewResult,
+  FrameType, GenerationStrategy, Keyframe, Panel, PanelGeneration, StoryboardGroup, Timeline, Transition,
+  VideoConstraint, VideoGenerationMode, VideoOutput,
+} from '../../../backend/src/services/previs-domain'
+
+// Timeline prompts and provider credentials must not be logged by the client.
+export async function previsRequest<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
+  const response = await fetch(`/api/v1${path}`, {
+    method, headers: { 'Content-Type': 'application/json' },
+    body: body === undefined ? undefined : JSON.stringify(body),
+  })
+  const result = await response.json()
+  if (!response.ok) throw new Error(result.message || `请求失败 (${response.status})`)
+  return result.data ?? result
+}
+const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
+const VIDEO_GENERATION_MODE_KEY = 'huobao:video-generation-mode'
+
+export function useVideoGenerationMode() {
+  type Mode = 'direct' | 'storyboard_frames'
+  let initial: Mode = 'direct'
+  if (import.meta.client) {
+    try {
+      const stored = localStorage.getItem(VIDEO_GENERATION_MODE_KEY)
+      if (stored === 'direct' || stored === 'storyboard_frames') initial = stored
+    } catch {}
+  }
+  const mode = ref<Mode>(initial)
+  watch(mode, value => {
+    try { localStorage.setItem(VIDEO_GENERATION_MODE_KEY, value) } catch {}
+  })
+  return mode
+}
+
+export function usePrevis() {
+  const version = ref<AnimaticVersion | null>(null)
+  const versions = ref<{ id: number; versionNo: number; status: string }[]>([])
+  const working = ref(false), dirty = ref(false), saveError = ref(''), pollError = ref('')
+  const undoStack = ref<Timeline[]>([]), redoStack = ref<Timeline[]>([])
+  const editable = computed(() => !!version.value && version.value.status !== 'locked' && !version.value.busy && !working.value)
+  const timeline = computed(() => version.value?.timeline)
+  let episodeId = 0, polling: ReturnType<typeof setInterval> | undefined
+  let autosave: ReturnType<typeof setTimeout> | undefined
+  let saving: Promise<boolean> | undefined
+  let pollingNow = false, disposed = false
+
+  function accept(value: AnimaticVersion, clearHistory = false) {
+    version.value = value; dirty.value = false; saveError.value = ''
+    if (clearHistory) { undoStack.value = []; redoStack.value = [] }
+  }
+  async function refreshVersions() {
+    versions.value = await previsRequest(`/episodes/${episodeId}/animatic-versions`)
+  }
+  async function initialize(id: number) {
+    episodeId = id
+    await refreshVersions()
+    accept(await previsRequest(`/episodes/${episodeId}/production-workspace`), true)
+    await refreshVersions()
+    polling = setInterval(() => { void poll() }, 2500)
+  }
+  async function poll() {
+    if (pollingNow || working.value || dirty.value || !version.value) return
+    pollingNow = true
+    const id = version.value.id
+    try {
+      const state = await previsRequest<Partial<AnimaticVersion> & { requiresRefresh: boolean }>(
+        version.value.isCurrent
+          ? `/episodes/${episodeId}/production-workspace-state?version_id=${id}`
+          : `/animatic-versions/${id}/state`,
+      )
+      if (!disposed && !dirty.value && !working.value && version.value?.id === id) {
+        if (state.requiresRefresh || state.revision !== version.value.revision) {
+          const remote = await previsRequest<AnimaticVersion>(version.value.isCurrent
+            ? `/episodes/${episodeId}/production-workspace`
+            : `/animatic-versions/${id}/timeline`)
+          if (!disposed && !dirty.value && !working.value && version.value?.id === id) accept(remote, true)
+        }
+        else {
+          if (state.batches) version.value.batches = state.batches
+          if (typeof state.busy === 'boolean') version.value.busy = state.busy
+          if (state.outputs) version.value.outputs = state.outputs
+          if (typeof state.isCurrent === 'boolean') version.value.isCurrent = state.isCurrent
+        }
+      }
+      pollError.value = ''
+    } catch { pollError.value = '进度更新中断，正在重连…' }
+    finally { pollingNow = false }
+  }
+  async function open(id: number) {
+    if (!await save()) return
+    working.value = true
+    try { accept(await previsRequest(`/animatic-versions/${id}/timeline`), true) }
+    finally { working.value = false }
+  }
+  async function create(fromCurrent = false) {
+    if (!await save()) return
+    working.value = true
+    try {
+      accept(await previsRequest(`/episodes/${episodeId}/animatic-versions`, 'POST',
+        fromCurrent && version.value ? { sourceId: version.value.id } : {}), true)
+      await refreshVersions()
+      toast.success(fromCurrent ? '已复制为新草稿' : '已从当前分镜创建草稿')
+    } finally { working.value = false }
+  }
+  function scheduleSave() {
+    clearTimeout(autosave)
+    autosave = setTimeout(() => { void save() }, 1200)
+  }
+  function edit(action: (t: Timeline) => void) {
+    if (!editable.value || !timeline.value) return
+    const before = copy(timeline.value), next = copy(before)
+    action(next)
+    retimeBoundAudio(before, next)
+    if (JSON.stringify(before) === JSON.stringify(next)) return
+    undoStack.value.push(before)
+    if (undoStack.value.length > 60) undoStack.value.shift()
+    redoStack.value = []
+    version.value!.timeline = next
+    dirty.value = true; saveError.value = ''
+    scheduleSave()
+  }
+  function history(redo = false) {
+    if (!editable.value || !timeline.value) return
+    const source = redo ? redoStack : undoStack, target = redo ? undoStack : redoStack
+    const next = source.value.pop()
+    if (!next) return
+    target.value.push(copy(timeline.value))
+    version.value!.timeline = next; dirty.value = true
+    scheduleSave()
+  }
+  async function save(): Promise<boolean> {
+    clearTimeout(autosave)
+    if (saving) return saving
+    if (!dirty.value || !version.value) return true
+    working.value = true
+    const current = version.value
+    saving = (async () => {
+      try {
+        accept(await previsRequest(`/animatic-versions/${current.id}/timeline`, 'PUT',
+          { revision: current.revision, timeline: current.timeline }))
+        return true
+      } catch (e: any) {
+        saveError.value = e.message
+        toast.error(`保存失败：${e.message}`)
+        return false
+      } finally { working.value = false; saving = undefined }
+    })()
+    return saving
+  }
+  async function check(lock = false) {
+    if (!await save() || !version.value) return
+    working.value = true
+    try {
+      accept(await previsRequest(`/animatic-versions/${version.value.id}/${lock ? 'lock' : 'check'}`, 'POST',
+        { revision: version.value.revision }))
+      await refreshVersions()
+      toast.success(lock ? '版本已锁定' : `检查完成：${version.value!.issues.length} 项待查看`)
+    } finally { working.value = false }
+  }
+  async function generate(type: 'image' | 'video', options: {
+    configId?: number; model?: string; panelIds?: number[]; frameTypes?: FrameType[]; frameIds?: string[]; force?: boolean;
+    generationMode?: 'direct' | 'storyboard_frames';
+  } = {}) {
+    if (!await save() || !version.value) return
+    working.value = true
+    try {
+      await previsRequest(`/animatic-versions/${version.value.id}/batch-runs`, 'POST',
+        { revision: version.value.revision, type, ...options })
+      accept(await previsRequest(`/animatic-versions/${version.value.id}/timeline`), true)
+      toast.success('任务已加入队列，可在任务面板查看进度')
+    } finally { working.value = false }
+  }
+  async function batchAction(id: number, action: 'retry' | 'cancel', itemIds?: number[]) {
+    if (!await save()) return
+    working.value = true
+    try {
+      await previsRequest(`/batch-runs/${id}/${action}`, 'POST', { itemIds })
+      if (version.value) accept(await previsRequest(`/animatic-versions/${version.value.id}/timeline`), true)
+    } finally { working.value = false }
+  }
+  onUnmounted(() => { disposed = true; clearInterval(polling); clearTimeout(autosave) })
+  return {
+    version, versions, timeline, editable, dirty, working, saveError, pollError, undoStack, redoStack,
+    initialize, open, create, edit, history, save, check, generate, batchAction,
+  }
+}
diff --git a/frontend/app/locales/en.json b/frontend/app/locales/en.json
index f033b55..47b1fd1 100644
--- a/frontend/app/locales/en.json
+++ b/frontend/app/locales/en.json
@@ -560,6 +560,12 @@
       "uploadSceneImage": "Upload scene image",
       "uploadPropImage": "Upload prop image",
       "uploadImage": "Upload image",
+      "imageHistory": "Image History",
+      "currentImage": "Current",
+      "useHistoryImage": "Use this historical image",
+      "useImage": "Use",
+      "historyApplied": "Current image updated",
+      "historyApplyFailed": "Failed to switch historical image",
       "appearance": "Appearance: ",
       "styling": "Styling: ",
       "lighting": "Lighting · ",
diff --git a/frontend/app/locales/ja.json b/frontend/app/locales/ja.json
index 40a1ca2..231596f 100644
--- a/frontend/app/locales/ja.json
+++ b/frontend/app/locales/ja.json
@@ -560,6 +560,12 @@
       "uploadSceneImage": "シーン図をアップロード",
       "uploadPropImage": "小道具図をアップロード",
       "uploadImage": "画像をアップロード",
+      "imageHistory": "画像履歴",
+      "currentImage": "現在",
+      "useHistoryImage": "この履歴画像に切り替える",
+      "useImage": "使用",
+      "historyApplied": "現在の画像を切り替えました",
+      "historyApplyFailed": "履歴画像の切り替えに失敗しました",
       "appearance": "外見：",
       "styling": "スタイリング：",
       "lighting": "光照 · ",
diff --git a/frontend/app/locales/ko.json b/frontend/app/locales/ko.json
index 9d50e7a..d24be01 100644
--- a/frontend/app/locales/ko.json
+++ b/frontend/app/locales/ko.json
@@ -560,6 +560,12 @@
       "uploadSceneImage": "장면 이미지 업로드",
       "uploadPropImage": "소품 이미지 업로드",
       "uploadImage": "이미지 업로드",
+      "imageHistory": "이미지 기록",
+      "currentImage": "현재",
+      "useHistoryImage": "이 이전 이미지로 전환",
+      "useImage": "사용",
+      "historyApplied": "현재 이미지가 변경되었습니다",
+      "historyApplyFailed": "이전 이미지 전환에 실패했습니다",
       "appearance": "외모: ",
       "styling": "스타일링: ",
       "lighting": "조명 · ",
diff --git a/frontend/app/locales/zh.json b/frontend/app/locales/zh.json
index 6ccd55d..d7c5006 100644
--- a/frontend/app/locales/zh.json
+++ b/frontend/app/locales/zh.json
@@ -560,6 +560,12 @@
       "uploadSceneImage": "上传场景图",
       "uploadPropImage": "上传道具图",
       "uploadImage": "上传图片",
+      "imageHistory": "历史图片",
+      "currentImage": "当前图片",
+      "useHistoryImage": "切换为此历史图片",
+      "useImage": "使用",
+      "historyApplied": "已切换当前图片",
+      "historyApplyFailed": "切换历史图片失败",
       "appearance": "样貌：",
       "styling": "妆造：",
       "lighting": "光照 · ",
diff --git a/frontend/app/views/drama/episode.vue b/frontend/app/views/drama/episode.vue
index 5a87812..794ace8 100644
--- a/frontend/app/views/drama/episode.vue
+++ b/frontend/app/views/drama/episode.vue
@@ -487,7 +487,19 @@
               <span class="dim" style="font-size:12px">{{ t('episode.prod.videos') }}</span>
               <span class="tag mono">{{ t('episode.sb.segmentStat', { n: sbs.length, dur: totalDuration }) }}</span>
               <span class="tag mono" :title="t('episode.vid.aspectRatio')">{{ dramaAspectRatio }}</span>
+              <div class="seg video-generation-mode" aria-label="视频生成模式">
+                <button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'direct' }"
+                  :aria-pressed="videoGenerationMode === 'direct'" title="使用提示词与已绑定素材直接生成"
+                  @click="videoGenerationMode = 'direct'"><Film :size="12" />直接生成</button>
+                <button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'storyboard_frames' }"
+                  :aria-pressed="videoGenerationMode === 'storyboard_frames'" title="使用当前镜头的全部分镜画面生成"
+                  @click="videoGenerationMode = 'storyboard_frames'"><Images :size="12" />分镜画面</button>
+              </div>
               <div class="ml-auto flex gap-1">
+                <button class="btn btn-sm btn-primary" @click="navigateTo(`/drama/${dramaId}/episode/${episodeNumber}/previs`)">
+                  <Clapperboard :size="13" />
+                  镜头看板 · 关键帧预演
+                </button>
                 <button class="btn btn-sm" :disabled="rn" @click="doBreakdown">
                   <Loader2 v-if="rt === 'storyboard_breaker'" :size="11" class="animate-spin" />
                   <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
@@ -570,6 +582,12 @@
                       muted
                       tabindex="-1"
                     />
+                    <img
+                      v-else-if="productionCoverById(task.id)"
+                      :src="mediaUrl(productionCoverById(task.id))"
+                      :alt="`${task.title} 分镜画面`"
+                      loading="lazy"
+                    />
                     <div v-else class="video-task-empty">
                       <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                     </div>
@@ -598,7 +616,7 @@
                   <button
                     class="btn btn-icon btn-sm video-task-action"
                     :title="videoTaskActionLabel(task.storyboard)"
-                    :disabled="videoTaskState(task.storyboard) === 'pending'"
+                    :disabled="videoTaskState(task.storyboard) === 'pending' || !videoCanGenerate(task.id)"
                     @click.stop="genVid(task.storyboard)"
                   >
                     <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
@@ -610,6 +628,17 @@
               <div v-if="selectedSb" class="video-task-side">
               <div class="video-main-col">
               <div class="video-main-scroll">
+                <div v-if="productionVersion" class="production-work-version">
+                  <span>当前工作版 V{{ String(productionVersion.versionNo).padStart(2, '0') }}</span>
+                  <small>{{ productionVersion.status === 'locked' ? '已锁定，复制草稿后可修改画面' : (productionWorking ? '正在同步' : '与镜头看板实时共用') }}</small>
+                  <button
+                    v-if="productionVersion.status === 'locked'"
+                    type="button"
+                    class="btn btn-sm"
+                    :disabled="productionWorking"
+                    @click="createProduction(true)"
+                  >复制为新草稿</button>
+                </div>
                 <div class="video-main-grid">
                   <section class="video-inspector-section">
                     <span class="video-inspector-label">{{ t('episode.sb.descSection') }}</span>
@@ -625,7 +654,7 @@
 
                   <section class="video-inspector-section">
                     <div class="video-inspector-prompt-head">
-                      <span class="video-inspector-label">{{ t('episode.ref.title') }}</span>
+                      <span class="video-inspector-label">1 · {{ t('episode.ref.title') }}</span>
                       <span class="tag mono">{{ t('episode.ref.boundCount', { bound: refBindableAssets.filter(a => a.bound).length, total: refBindableAssets.length }) }}</span>
                     </div>
                     <div class="storyboard-ref-list is-embedded">
@@ -664,9 +693,43 @@
                   </section>
                 </div>
 
+                  <section
+                    v-if="productionPanel && (videoUsesStoryboardFrames || directFramesExpanded)"
+                    class="video-inspector-section production-frames-section"
+                  >
+                    <div v-if="!videoUsesStoryboardFrames" class="direct-frames-context">
+                      <Images :size="15" />
+                      <div><strong>可选预演画面</strong><small>直接生成不会读取这些画面</small></div>
+                      <button type="button" class="btn btn-icon btn-sm" title="收起分镜画面" aria-label="收起分镜画面"
+                        @click="directFramesExpanded = false"><ChevronUp :size="15" /></button>
+                    </div>
+                    <StoryboardFramesEditor
+                      :panel="productionPanel"
+                      :editable="productionEditable"
+                      :tasks="productionImageTasks"
+                      :video-generation-mode="videoGenerationMode"
+                      :title="videoUsesStoryboardFrames ? '2 · 分镜画面' : '分镜画面 · 仅用于预演'"
+                      @change="updateProductionFrames"
+                      @generate="generateProductionFrames"
+                    />
+                  </section>
+                  <button
+                    v-else-if="productionPanel"
+                    type="button"
+                    class="direct-frames-entry"
+                    @click="directFramesExpanded = true"
+                  >
+                    <span class="direct-frames-icon"><Images :size="16" /></span>
+                    <span class="direct-frames-copy">
+                      <strong>分镜画面（可选）</strong>
+                      <small>{{ productionPanel.frames.filter(frame => frame.url).length }} / {{ productionPanel.frames.length }} 张已就绪 · 仅用于预演和审核</small>
+                    </span>
+                    <ChevronRight :size="16" />
+                  </button>
+
                   <section class="video-inspector-section">
                     <div class="video-inspector-prompt-head">
-                      <span class="video-inspector-label video-inspector-label-hero">{{ t('episode.sb.videoPromptSection') }}</span>
+                      <span class="video-inspector-label video-inspector-label-hero">{{ videoUsesStoryboardFrames ? '3' : '2' }} · {{ t('episode.sb.videoPromptSection') }}</span>
                       <button
                         type="button"
                         class="btn btn-sm"
@@ -731,15 +794,16 @@
                 <div v-else class="video-player-empty">
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                   <div class="video-player-empty-copy">
-                    <div class="video-player-empty-title">{{ videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGenerating') : t('episode.vid.emptyNoVideo') }}</div>
-                    <div class="video-player-empty-desc">{{ videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGeneratingDesc') : t('episode.vid.emptyNoVideoDesc') }}</div>
+                    <div class="video-player-empty-title">{{ videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGenerating') : videoTaskState(selectedSb) === 'blocked' ? '分镜画面尚未全部完成' : t('episode.vid.emptyNoVideo') }}</div>
+                    <div class="video-player-empty-desc">{{ videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGeneratingDesc') : videoTaskState(selectedSb) === 'blocked' ? '分镜画面模式会按时间顺序使用当前镜头的全部画面' : videoGenerationMode === 'direct' ? '直接使用视频提示词与已绑定素材生成' : t('episode.vid.emptyNoVideoDesc') }}</div>
                   </div>
                   <button
                     v-if="videoTaskState(selectedSb) !== 'pending'"
                     class="btn btn-primary btn-sm video-player-empty-action"
+                    :disabled="videoTaskState(selectedSb) === 'blocked'"
                     @click="genVid(selectedSb)"
                   >
-                    {{ t('episode.vid.generateVideo') }}
+                    {{ videoTaskState(selectedSb) === 'blocked' ? '先完成全部分镜画面' : t('episode.vid.generateVideo') }}
                   </button>
                 </div>
               </div>
@@ -767,31 +831,6 @@
                 </div>
               </div>
             </div>
-                <div class="video-inspector-body">
-                  <section class="video-inspector-section">
-                    <div class="video-inspector-prompt-head">
-                      <span class="video-inspector-label">{{ t('episode.inspector.boundRefs') }}</span>
-                      <span class="tag mono">{{ boundRefAssets.length }}</span>
-                    </div>
-                    <div v-if="boundRefAssets.length" class="video-bound-refs">
-                      <button
-                        v-for="asset in boundRefAssets"
-                        :key="asset.key"
-                        type="button"
-                        class="video-bound-ref"
-                        :disabled="!asset.ready"
-                        :title="`${asset.name} · ${asset.typeLabel}`"
-                        @click="asset.ready && openImageViewer(assetImageSrc({ imageUrl: asset.imageUrl }), `${asset.name} ${asset.typeLabel}`)"
-                      >
-                        <img v-if="asset.ready" :src="thumbOf(assetImageSrc({ imageUrl: asset.imageUrl }))" :alt="asset.name" loading="lazy" @error="thumbFallback($event, assetImageSrc({ imageUrl: asset.imageUrl }))" />
-                        <span v-else class="video-bound-ref-empty">{{ asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar') }}</span>
-                        <small>{{ asset.name }}</small>
-                      </button>
-                    </div>
-                    <div v-else class="video-bound-refs-empty">{{ t('episode.inspector.noBoundRefs') }}</div>
-                  </section>
-                </div>
-
                 <!-- 分镜时长 + 生成操作常驻底部：不随检查器内容滚动 -->
                 <div class="video-inspector-footer">
                   <section class="video-inspector-section video-params-card">
@@ -814,9 +853,16 @@
                   <div class="video-inspector-effective">
                     {{ t('episode.inspector.effective', { model: effectiveVideoModelLabel || t('episode.vid.defaultModel'), res: episodeResolutionShort, dur: effectiveVideoDuration }) }}
                   </div>
+                  <div class="video-frame-readiness" :class="{ ready: videoCanGenerate(selectedSb?.id), direct: videoGenerationMode === 'direct' }">
+                    {{ videoGenerationMode === 'direct'
+                      ? '直接生成：使用视频提示词与已绑定素材，不依赖分镜画面'
+                      : videoFramesReady(selectedSb?.id)
+                        ? `分镜画面：全部 ${productionPanelById(selectedSb?.id)?.frames.length || 0} 张画面将作为视频输入`
+                        : `分镜画面：请先完成全部画面（缺 ${videoMissingFrameCount(selectedSb?.id)} 张）` }}
+                  </div>
                   <button
                     class="btn btn-primary video-inspector-action"
-                    :disabled="videoTaskState(selectedSb) === 'pending'"
+                    :disabled="videoTaskState(selectedSb) === 'pending' || !videoCanGenerate(selectedSb?.id)"
                     @click="genVid(selectedSb)"
                   >
                     {{ videoTaskActionLabel(selectedSb) }}
@@ -1123,6 +1169,32 @@
                   </span>
                 </button>
 
+                <section v-if="assetHistoryLoading || assetImageHistory.length > 1" class="asset-image-history">
+                  <div class="asset-detail-section-title">
+                    <span>{{ t('episode.asset.imageHistory') }}</span>
+                    <span class="asset-detail-state">{{ assetImageHistory.length }}</span>
+                  </div>
+                  <div v-if="assetHistoryLoading" class="asset-history-loading">
+                    <Loader2 :size="15" class="animate-spin" />{{ t('common.loading') }}
+                  </div>
+                  <div v-else class="asset-history-grid">
+                    <button
+                      v-for="entry in assetImageHistory"
+                      :key="entry.id"
+                      type="button"
+                      :class="{ current: sameMediaPath(entry.url, assetImageSrc(assetDetail.item)) }"
+                      :disabled="!!applyingAssetHistoryUrl"
+                      :title="sameMediaPath(entry.url, assetImageSrc(assetDetail.item)) ? t('episode.asset.currentImage') : t('episode.asset.useHistoryImage')"
+                      @click="useAssetHistory(entry)"
+                    >
+                      <img :src="thumbOf(assetImageSrc({ imageUrl: entry.url }))" :alt="t('episode.asset.imageHistory')" @error="thumbFallback($event, assetImageSrc({ imageUrl: entry.url }))">
+                      <span>{{ formatHistoryTime(entry.createdAt) || `#${entry.id}` }}</span>
+                      <i>{{ sameMediaPath(entry.url, assetImageSrc(assetDetail.item)) ? t('episode.asset.currentImage') : t('episode.asset.useImage') }}</i>
+                      <Loader2 v-if="sameMediaPath(entry.url, applyingAssetHistoryUrl)" :size="13" class="animate-spin" />
+                    </button>
+                  </div>
+                </section>
+
                 <div class="asset-detail-meta-row">
                   <div class="asset-detail-meta-item">
                     <span>{{ t('episode.asset.kindLabel') }}</span>
@@ -1405,7 +1477,10 @@
             <div class="batch-video-row"><span>{{ t('episode.vid.confirmTotal') }}</span><strong>{{ t('episode.vid.confirmApprox', { n: batchVideoTotalDuration }) }}</strong></div>
             <div class="batch-video-row"><span>{{ t('episode.vid.confirmModel') }}</span><strong>{{ effectiveVideoModelLabel || t('episode.vid.defaultModel') }}</strong></div>
             <div class="batch-video-row"><span>{{ t('episode.vid.confirmResolution') }}</span><strong>{{ episodeResolutionLabel }}</strong></div>
-            <p class="batch-video-note">{{ t('episode.vid.confirmNote') }}</p>
+            <div class="batch-video-row"><span>生成模式</span><strong>{{ videoGenerationModeLabel }}</strong></div>
+            <p class="batch-video-note">{{ videoGenerationMode === 'direct'
+              ? '每个镜头将使用视频提示词与已绑定素材直接生成，不检查分镜画面。'
+              : '每个镜头将按时间顺序使用全部分镜画面；未完成的画面会阻止提交。' }}</p>
           </div>
           <footer class="dialog-foot">
             <button class="btn" @click="batchVideoConfirm.open = false">{{ t('common.cancel') }}</button>
@@ -1432,13 +1507,15 @@ import { toast } from 'vue-sonner'
 import { useI18n } from 'vue-i18n'
 import {
   Users, FileText, FolderKanban, Clapperboard, Download, Loader2,
-  Plus, X, ListTodo, CircleHelp,
+  Plus, X, ListTodo, CircleHelp, ChevronRight, ChevronUp, Film, Images,
 } from 'lucide-vue-next'
 import { api, dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, propAPI, taskAPI, mergeAPI, aiConfigAPI, uploadAPI } from '~/composables/useApi'
 import { startTour, autoTour } from '~/composables/useTour'
 import { useAgent } from '~/composables/useAgent'
 import { toastError, mapError, MODERATION_RE } from '~/composables/useToast'
 import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
+import StoryboardFramesEditor from '~/components/previs/StoryboardFramesEditor.vue'
+import { mediaUrl, usePrevis, useVideoGenerationMode } from '~/composables/usePrevis'
 
 definePageMeta({ layout: 'studio' })
 
@@ -1449,6 +1526,19 @@ const dramaId = Number(route.params.id)
 const episodeNumber = Number(route.params.episodeNumber)
 
 const drama = ref(null), episode = ref(null), chars = ref([]), scenes = ref([]), propItems = ref([]), sbs = ref([]), mergeData = ref(null)
+const {
+  version: productionVersion, timeline: productionTimeline, editable: productionEditable,
+  working: productionWorking, initialize: initializeProduction, create: createProduction,
+  edit: editProduction, save: saveProduction, generate: generateProduction,
+} = usePrevis()
+const videoGenerationMode = useVideoGenerationMode()
+const videoUsesStoryboardFrames = computed(() => videoGenerationMode.value === 'storyboard_frames')
+const videoGenerationModeLabel = computed(() =>
+  videoUsesStoryboardFrames.value ? '依赖分镜画面' : '直接生成')
+const directFramesExpanded = ref(false)
+watch(videoGenerationMode, value => {
+  if (value === 'direct') directFramesExpanded.value = false
+})
 // 工作台面板位置记忆（按剧集隔离）：仅页面刷新(reload)时恢复到上次所在步骤；
 // 从列表/详情页点击进入时始终默认「剧本」面板
 const PANEL_STORE_KEY = `huobao:workbench:panel:${dramaId}:${episodeNumber}`
@@ -1509,6 +1599,22 @@ const scriptStep = ref(storedPanel ? (storedPanel.scriptStep === 0 ? 0 : 1) : 0)
 // 旧版本地存储的 'storyboard' 子步骤已并入 'videos'（视频制作）
 const storedProdTab = storedPanel?.prodTab === 'storyboard' ? 'videos' : storedPanel?.prodTab
 const prodTab = ref(['assets', 'videos'].includes(storedProdTab) ? storedProdTab : 'assets')
+if (route.query.stage === 'script') {
+  panel.value = 'script'
+  scriptStep.value = route.query.step === 'raw' ? 0 : 1
+  panelRestored = true
+} else if (route.query.stage === 'assets') {
+  panel.value = 'production'
+  prodTab.value = 'assets'
+  panelRestored = true
+} else if (route.query.stage === 'videos') {
+  panel.value = 'production'
+  prodTab.value = 'videos'
+  panelRestored = true
+} else if (route.query.stage === 'export') {
+  panel.value = 'export'
+  panelRestored = true
+}
 // 面板位置变化即持久化
 watch([panel, scriptStep, prodTab], ([p, s, pt]) => {
   try { localStorage.setItem(PANEL_STORE_KEY, JSON.stringify({ panel: p, scriptStep: s, prodTab: pt })) } catch { /* 静默 */ }
@@ -1634,6 +1740,10 @@ async function toggleExportDone() {
 }
 const assetDetail = ref({ open: false, type: '', item: null })
 const assetDetailDraft = ref({ appearance: '', styling: '', prompt: '', lighting: '', description: '' })
+const assetImageHistory = ref([])
+const assetHistoryLoading = ref(false)
+const applyingAssetHistoryUrl = ref('')
+let assetHistoryRequest = 0
 // 最终提示词手动编辑：dirty 时才随保存提交，避免无修改保存误清空 Agent 生成的提示词
 const assetPromptDraft = ref('')
 const assetPromptDirty = ref(false)
@@ -1664,15 +1774,96 @@ function openAssetDetail(type, item) {
   }
   assetPromptDraft.value = item.final_prompt || item.finalPrompt || ''
   assetPromptDirty.value = false
+  void loadAssetImageHistory(type, item)
 }
 
 function closeAssetDetail() {
+  assetHistoryRequest++
   assetDetail.value = { open: false, type: '', item: null }
   assetDetailDraft.value = { appearance: '', styling: '', prompt: '', lighting: '', description: '' }
+  assetImageHistory.value = []
+  assetHistoryLoading.value = false
+  applyingAssetHistoryUrl.value = ''
   assetPromptDraft.value = ''
   assetPromptDirty.value = false
 }
 
+function taskImagePath(task) {
+  return task?.local_path || task?.localPath || task?.result_url || task?.resultUrl || ''
+}
+
+function sameMediaPath(left, right) {
+  const normalize = value => String(value || '').replace(/^\/+/, '')
+  return !!normalize(left) && normalize(left) === normalize(right)
+}
+
+function assetHistoryQuery(type, id) {
+  const query = { type: 'image', limit: 100 }
+  if (type === 'character') query.character_id = id
+  else if (type === 'scene') query.scene_id = id
+  else query.prop_id = id
+  return query
+}
+
+async function loadAssetImageHistory(type = assetDetail.value.type, item = assetDetail.value.item) {
+  if (!type || !item?.id) { assetImageHistory.value = []; return }
+  const request = ++assetHistoryRequest
+  assetHistoryLoading.value = true
+  try {
+    const rows = await taskAPI.list(assetHistoryQuery(type, item.id))
+    const entries = (Array.isArray(rows) ? rows : [])
+      .filter(task => task.status === 'completed' && taskImagePath(task))
+      .map(task => ({
+        id: task.id,
+        url: taskImagePath(task),
+        localPath: task.local_path || task.localPath || '',
+        createdAt: task.created_at || task.createdAt || '',
+        model: task.model || '',
+      }))
+      .filter((entry, index, all) => all.findIndex(item => sameMediaPath(item.url, entry.url)) === index)
+    const currentUrl = item.image_url || item.imageUrl || ''
+    if (currentUrl && !entries.some(entry => sameMediaPath(entry.url, currentUrl))) {
+      entries.unshift({ id: `current-${currentUrl}`, url: currentUrl, localPath: item.local_path || item.localPath || '', createdAt: item.updated_at || item.updatedAt || '', model: '' })
+    }
+    if (request === assetHistoryRequest && assetDetail.value.open
+      && assetDetail.value.type === type && assetDetail.value.item?.id === item.id) {
+      assetImageHistory.value = entries.slice(0, 30)
+    }
+  } catch {
+    if (request === assetHistoryRequest) assetImageHistory.value = []
+  } finally {
+    if (request === assetHistoryRequest) assetHistoryLoading.value = false
+  }
+}
+
+function assetList(type) {
+  return type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
+}
+
+async function useAssetHistory(entry) {
+  const detail = assetDetail.value
+  if (!detail.open || !detail.item?.id || !entry?.url || sameMediaPath(entry.url, assetImageSrc(detail.item))) return
+  applyingAssetHistoryUrl.value = entry.url
+  try {
+    const payload = { image_url: entry.url }
+    if (entry.localPath) payload.local_path = entry.localPath
+    if (detail.type === 'character') await characterAPI.update(detail.item.id, payload)
+    else if (detail.type === 'scene') await sceneAPI.update(detail.item.id, payload)
+    else await propAPI.update(detail.item.id, payload)
+    const patch = { image_url: entry.url, imageUrl: entry.url }
+    if (entry.localPath) Object.assign(patch, { local_path: entry.localPath, localPath: entry.localPath })
+    Object.assign(detail.item, patch)
+    const target = assetList(detail.type).find(item => item.id === detail.item.id)
+    if (target) Object.assign(target, patch)
+    toast.success(t('episode.asset.historyApplied'))
+    await loadAssetImageHistory(detail.type, detail.item)
+  } catch (error) {
+    toastError(error, { fallback: 'episode.asset.historyApplyFailed' })
+  } finally {
+    applyingAssetHistoryUrl.value = ''
+  }
+}
+
 // ─── 手动新增资产 ────────────────────────────────────────────
 // 类型短显示名渲染时求值（不模块级固化），逻辑判断一律用 kind code
 const assetKindLabelMap = computed(() => ({
@@ -1938,11 +2129,11 @@ function isPendingSceneImage(id) {
 }
 
 function isPendingVideo(id) {
-  return pendingVideoIds.value.includes(id)
+  return !!productionVideoItem(id, 'pending') || !!productionVideoItem(id, 'processing') || pendingVideoIds.value.includes(id)
 }
 
 function videoFailMessage(id) {
-  return failedVideoMessages.value[id] || ''
+  return productionVideoItem(id, 'failed')?.error || failedVideoMessages.value[id] || ''
 }
 
 // 内容审核类失败（真人/敏感内容，如火山的 OutputVideoSensitiveContentDetected）：
@@ -1955,6 +2146,7 @@ function videoTaskState(sb) {
   if (hasVid(sb)) return 'done'
   if (isPendingVideo(sb?.id)) return 'pending'
   if (videoFailMessage(sb?.id)) return 'failed'
+  if (!videoCanGenerate(sb?.id)) return 'blocked'
   return 'ready'
 }
 
@@ -1963,19 +2155,21 @@ function videoTaskStatusLabel(sb) {
   if (state === 'done') return t('episode.status.done')
   if (state === 'pending') return t('episode.status.generating')
   if (state === 'failed') return t('episode.status.failed')
+  if (state === 'blocked') return '待完成分镜画面'
   return t('episode.status.todo')
 }
 
 function videoTaskActionLabel(sb) {
+  if (!videoCanGenerate(sb?.id)) return '先完成全部分镜画面'
   const state = videoTaskState(sb)
   if (state === 'done') return t('episode.asset.regen')
   if (state === 'pending') return t('episode.asset.generating')
+  if (state === 'blocked') return '先完成全部分镜画面'
   return t('episode.asset.generate')
 }
 
 const allVideoTaskRows = computed(() => sbs.value.map((sb, index) => {
   const duration = Number(sb.duration || 5)
-  const referenceCount = getShotReferenceImages(sb).length
   const sceneName = getSceneName(sb)
   return {
     id: sb.id,
@@ -1984,7 +2178,6 @@ const allVideoTaskRows = computed(() => sbs.value.map((sb, index) => {
     title: sb.description || t('episode.vid.shotN', { n: String(index + 1).padStart(2, '0') }),
     meta: sceneName,
     duration: Number.isFinite(duration) ? duration : 5,
-    referenceCount,
     state: videoTaskState(sb),
     // 只有当前处于失败状态才显示错误,避免重试成功的分镜残留历史错误信息
     error: videoTaskState(sb) === 'failed' ? videoFailMessage(sb.id) : '',
@@ -2120,9 +2313,6 @@ const selectedVideoConfig = computed(() => {
 const isWan3Video = computed(() => selectedVideoConfig.value?.provider === 'aliyun'
   || bareModelName(videoModel.value).startsWith('wan3.0-video'))
 
-// 参考图上限（Wan 3.0 官方 10 张，其他模型 9 张），绑定素材收集与 @名字 映射统一读取
-const refImageLimit = computed(() => isWan3Video.value ? 10 : 9)
-
 // 本次生成的生效配置（模型/分辨率/时长），用于右侧小结与批量确认弹窗
 const effectiveVideoModelLabel = computed(() => {
   const explicit = bareModelName(videoModel.value)
@@ -2141,6 +2331,14 @@ const batchVideoTotalDuration = computed(() =>
 function openBatchVideoConfirm(pool) {
   const targets = pool.filter(s => !isPendingVideo(s.id))
   if (!targets.length) { toast.info(t('episode.vid.noneToGenerate')); return }
+  const incomplete = videoUsesStoryboardFrames.value
+    ? targets.filter(sb => !videoFramesReady(sb.id))
+    : []
+  if (incomplete.length) {
+    selectedSb.value = incomplete[0]
+    toast.error(`有 ${incomplete.length} 个镜头的分镜画面尚未全部完成`)
+    return
+  }
   batchVideoConfirm.value = { open: true, targets }
 }
 function batchVideos() {
@@ -2154,20 +2352,21 @@ function batchVideos() {
 function retryFailedVideos() {
   openBatchVideoConfirm(sbs.value.filter(s => videoTaskState(s) === 'failed'))
 }
-function confirmBatchVideos() {
+async function confirmBatchVideos() {
   const targets = [...batchVideoConfirm.value.targets]
   batchVideoConfirm.value = { open: false, targets: [] }
   if (!targets.length) return
   const ids = targets.map(s => s.id)
-  targets.forEach(sb => genVid(sb, { silent: true }))
-  toast.success(t('episode.vid.batchStarted', { n: ids.length }))
-  watchAsyncResult(() => ids.every(id => {
-    const target = sbs.value.find(s => s.id === id)
-    const done = !!getVideoUrl(target)
-    if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== id)
-    return done
-  }), 80, 4000)
-  if (videoSelectMode.value) toggleVideoSelectMode()
+  const option = videoModelOptions.value.find(item => item.key === videoModel.value) || videoModelOptions.value[0]
+  if (!productionVersion.value || !option) { toast.error('请先启用视频模型并载入当前工作版'); return }
+  try {
+    await generateProduction('video', {
+      panelIds: ids, configId: option.configId, model: option.model,
+      generationMode: videoGenerationMode.value,
+    })
+    toast.success(t('episode.vid.batchStarted', { n: ids.length }))
+    if (videoSelectMode.value) toggleVideoSelectMode()
+  } catch (e) { toastError(e, { fallback: 'episode.vid.genFailed' }) }
 }
 
 // 配置变化后校验持久化的模型是否仍存在（配置被删/模型被移除时回退默认，避免把失效模型传给后端）
@@ -2519,6 +2718,58 @@ const currentSubStageLabel = computed(() => currentStageLabel.value)
 
 const totalDuration = computed(() => sbs.value.reduce((s, sb) => s + (sb.duration || 10), 0))
 const selectedSb = ref(null)
+const productionPanel = computed(() => productionTimeline.value?.panels.find(p => p.id === selectedSb.value?.id))
+const productionImageTasks = computed(() => productionVersion.value?.batches
+  .filter(batch => batch.type === 'image').flatMap(batch => batch.items)
+  .filter(item => item.panelId === productionPanel.value?.id) || [])
+function productionPanelById(id) {
+  return productionTimeline.value?.panels.find(panel => panel.id === id)
+}
+function productionOutputById(id) {
+  return productionVersion.value?.outputs.find(output => !output.stale && output.panelIds.includes(id))
+}
+function videoMissingFrameCount(id) {
+  const frames = productionPanelById(id)?.frames || []
+  return frames.length ? frames.filter(frame => !frame.url).length : 1
+}
+function videoFramesReady(id) {
+  const frames = productionPanelById(id)?.frames || []
+  return frames.length > 0 && frames.every(frame => !!frame.url)
+}
+function videoCanGenerate(id) {
+  return !videoUsesStoryboardFrames.value || videoFramesReady(id)
+}
+function productionCoverById(id) {
+  const panel = productionPanelById(id)
+  if (!panel) return ''
+  return panel.frames.find(frame => frame.id === panel.coverFrameId && frame.url)?.url
+    || [...panel.frames].sort((a, b) => (a.offsetMs || 0) - (b.offsetMs || 0)).find(frame => frame.url)?.url
+    || ''
+}
+function productionVideoItem(id, status) {
+  return productionVersion.value?.batches
+    .filter(batch => batch.type === 'video').flatMap(batch => batch.items)
+    .find(item => {
+      if (item.status !== status) return false
+      if (item.panelId === id) return true
+      return productionTimeline.value?.groups.find(group => group.id === item.groupId)?.panelIds.includes(id)
+    })
+}
+function updateProductionFrames(frames, coverFrameId) {
+  const id = selectedSb.value?.id
+  editProduction(timeline => {
+    const target = timeline.panels.find(panel => panel.id === id)
+    if (target) { target.frames = frames; target.coverFrameId = coverFrameId }
+  })
+}
+async function generateProductionFrames(frameIds, force = false) {
+  const target = productionPanel.value
+  const option = imageModelOptions.value.find(item => item.key === imageModel.value) || imageModelOptions.value[0]
+  if (!target || !option) { toast.error('请先启用图片模型'); return }
+  await generateProduction('image', {
+    panelIds: [target.id], frameIds, force, configId: option.configId, model: option.model,
+  })
+}
 const selectedVideoTaskNumber = computed(() => {
   const index = videoTaskRows.value.findIndex(task => String(task.id) === String(selectedSb.value?.id))
   return index >= 0 ? index + 1 : 0
@@ -2530,6 +2781,33 @@ function updateField(sb, field, value) {
   sb[field] = value
   const camelField = toCamel(field)
   if (camelField !== field) sb[camelField] = value
+  const target = productionPanelById(sb.id)
+  const fieldMap = {
+    title: 'title', description: 'description', image_prompt: 'imagePrompt', video_prompt: 'videoPrompt',
+    scene_id: 'sceneId', shot_type: 'shotType', angle: 'angle', movement: 'movement',
+    character_ids: 'characterIds', prop_ids: 'propIds',
+  }
+  if (target && (fieldMap[field] || field === 'duration')) {
+    editProduction(timeline => {
+      const panel = timeline.panels.find(item => item.id === sb.id)
+      if (!panel) return
+      if (field === 'duration') panel.durationMs = Math.max(100, Math.round(Number(value) * 1000))
+      else panel[fieldMap[field]] = value
+      if (['scene_id', 'character_ids', 'prop_ids'].includes(field)) {
+        const refs = []
+        const labels = []
+        const push = (url, label) => { if (url && !refs.includes(url)) { refs.push(url); labels.push(label) } }
+        const scene = getStoryboardScene(sb)
+        push(scene?.image_url || scene?.imageUrl, scene?.location || '场景')
+        for (const character of getStoryboardCharacters(sb)) push(character.image_url || character.imageUrl, character.name || '角色')
+        for (const prop of getStoryboardProps(sb)) push(prop.image_url || prop.imageUrl, prop.name || '道具')
+        panel.referenceImages = refs
+        panel.referenceLabels = labels
+        panel.scene = scene ? `${scene.location} / ${scene.time || ''}` : ''
+      }
+    })
+    return
+  }
   storyboardAPI.update(sb.id, { [field]: value }).catch(e => toastError(e))
 }
 
@@ -2857,6 +3135,42 @@ function watchAsyncResult(check, attempts = 24, delay = 2500) {
   })()
 }
 
+function setAssetPending(type, id, pending) {
+  const source = type === 'character' ? pendingCharImageIds : type === 'scene' ? pendingSceneImageIds : pendingPropImageIds
+  source.value = pending
+    ? [...new Set([...source.value, id])]
+    : source.value.filter(item => item !== id)
+}
+
+function syncOpenAssetDetail(type, id) {
+  if (!assetDetail.value.open || assetDetail.value.type !== type || assetDetail.value.item?.id !== id) return
+  const latest = assetList(type).find(item => item.id === id)
+  if (latest) assetDetail.value.item = latest
+  void loadAssetImageHistory(type, assetDetail.value.item)
+}
+
+function pollAssetGeneration(type, id, generationId) {
+  void (async () => {
+    if (!generationId) {
+      setAssetPending(type, id, false)
+      return
+    }
+    for (let attempt = 0; attempt < 60; attempt++) {
+      await sleep(2500)
+      try {
+        const task = await taskAPI.get(generationId)
+        if (!task || !['completed', 'failed'].includes(task.status)) continue
+        await refresh()
+        setAssetPending(type, id, false)
+        syncOpenAssetDetail(type, id)
+        if (task.status === 'failed') toast.error(mapError(task.error_msg || task.errorMsg || t('episode.status.failed')))
+        return
+      } catch {}
+    }
+    setAssetPending(type, id, false)
+  })()
+}
+
 async function genCharImg(id) {
   try {
     if (!isPendingCharImage(id)) pendingCharImageIds.value.push(id)
@@ -2867,15 +3181,10 @@ async function genCharImg(id) {
         await ensureAssetPrompt('character', id)
       } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
     }
-    await characterAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
+    const result = await characterAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
     toast.success(t('episode.image.generatingChar'))
     await refresh()
-    watchAsyncResult(() => {
-      const char = chars.value.find(c => c.id === id)
-      const done = !!(char?.image_url || char?.imageUrl)
-      if (done) pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
-      return done
-    })
+    pollAssetGeneration('character', id, result?.image_generation_id || result?.imageGenerationId)
   } catch (e) {
     pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
     toastError(e)
@@ -2909,15 +3218,10 @@ async function genSceneImg(id) {
         await ensureAssetPrompt('scene', id)
       } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
     }
-    await sceneAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
+    const result = await sceneAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
     toast.success(t('episode.image.generatingScene'))
     await refresh()
-    watchAsyncResult(() => {
-      const scene = scenes.value.find(s => s.id === id)
-      const done = !!(scene?.image_url || scene?.imageUrl)
-      if (done) pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
-      return done
-    })
+    pollAssetGeneration('scene', id, result?.image_generation_id || result?.imageGenerationId)
   } catch (e) {
     pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
     toastError(e)
@@ -2936,15 +3240,10 @@ async function genPropImg(id) {
         await ensureAssetPrompt('prop', id)
       } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
     }
-    await propAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
+    const result = await propAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId())
     toast.success(t('episode.image.generatingProp'))
     await refresh()
-    watchAsyncResult(() => {
-      const prop = propItems.value.find(p => p.id === id)
-      const done = !!(prop?.image_url || prop?.imageUrl)
-      if (done) pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
-      return done
-    })
+    pollAssetGeneration('prop', id, result?.image_generation_id || result?.imageGenerationId)
   } catch (e) {
     pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
     toastError(e)
@@ -2976,7 +3275,13 @@ function batchPropImages() {
     return done
   }), 36)
 }
-function getVideoUrl(s) { return s?.video_url || s?.videoUrl || s?.composed_video_url || s?.composedVideoUrl || null }
+function getVideoUrl(s) {
+  const output = productionOutputById(s?.id)
+  if (output) return output.url
+  if (productionVersion.value?.outputs.some(item => item.panelIds.includes(s?.id))) return null
+  return productionPanelById(s?.id)?.videoUrl
+    || s?.video_url || s?.videoUrl || s?.composed_video_url || s?.composedVideoUrl || null
+}
 function hasVid(s) { return !!getVideoUrl(s) }
 
 // ===== 分镜视频历史（一个分镜可能生成多个视频,sys_task 留存全部记录）=====
@@ -3009,7 +3314,15 @@ async function setAsMainVideo() {
   const sb = selectedSb.value
   if (!sb || !previewVideoUrl.value) return
   try {
-    await storyboardAPI.update(sb.id, { video_url: previewVideoUrl.value })
+    if (productionPanelById(sb.id) && productionEditable.value) {
+      editProduction(timeline => {
+        const panel = timeline.panels.find(item => item.id === sb.id)
+        if (panel) panel.videoUrl = previewVideoUrl.value
+      })
+      await saveProduction()
+    } else {
+      await storyboardAPI.update(sb.id, { video_url: previewVideoUrl.value })
+    }
     sb.video_url = previewVideoUrl.value
     sb.videoUrl = previewVideoUrl.value
     toast.success(t('episode.vid.setMainDone'))
@@ -3033,23 +3346,6 @@ function formatHistoryTime(iso) {
   return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
 }
 
-function getShotReferenceImages(sb) {
-  const refs = []
-  const pushRef = (value) => {
-    if (!value || refs.includes(value) || refs.length >= refImageLimit.value) return
-    refs.push(value)
-  }
-  const scene = getStoryboardScene(sb)
-  pushRef(scene?.image_url || scene?.imageUrl)
-  for (const char of getStoryboardCharacters(sb)) {
-    pushRef(char?.image_url || char?.imageUrl)
-  }
-  for (const prop of getStoryboardProps(sb)) {
-    pushRef(prop?.image_url || prop?.imageUrl)
-  }
-  return refs
-}
-
 // 右侧参考素材面板：本集全部可绑定素材（场景单选、角色/道具多选），bound 标记是否已绑定
 // kind 为英文 code（逻辑值）；typeLabel 为显示名（渲染时求值）
 function shotBindableAssets(sb) {
@@ -3106,9 +3402,6 @@ const refBindableAssets = computed(() => {
   return sb ? shotBindableAssets(sb) : []
 })
 
-// 右栏「绑定参考图」：当前分镜已绑定素材（生成时作为参考图提交），按分组顺序平铺展示
-const boundRefAssets = computed(() => refBindableAssets.value.filter(a => a.bound))
-
 // 参考面板分组顺序（kind code 驱动，label 渲染时求值）
 const REF_KINDS = computed(() => ([
   { kind: 'character', label: t('common.role') },
@@ -3161,44 +3454,6 @@ const mentionOptions = computed(() => {
   ]
 })
 
-// 按参考图顺序（场景图在前、角色图居中、道具图在后）为 @名字 建立索引映射，供视频提示词引用替换
-function getShotReferenceIndexMap(sb) {
-  const ordered = []
-  const seen = new Set()
-  const push = (name, url) => {
-    if (!url || seen.has(url) || ordered.length >= refImageLimit.value) return
-    seen.add(url)
-    ordered.push({ name, imageUrl: url })
-  }
-  const scene = getStoryboardScene(sb)
-  push(scene?.location || '', scene?.image_url || scene?.imageUrl)
-  for (const char of getStoryboardCharacters(sb)) {
-    push(char.name || '', char?.image_url || char?.imageUrl)
-  }
-  for (const prop of getStoryboardProps(sb)) {
-    push(prop.name || '', prop?.image_url || prop?.imageUrl)
-  }
-  const nameToIndex = {}
-  ordered.forEach((a, i) => { if (a.name && !(a.name in nameToIndex)) nameToIndex[a.name] = i + 1 })
-  return nameToIndex
-}
-
-// 将视频提示词里的 @名字 替换为 @图片N名字（N 为参考图序号，1 起），生成时使用
-function resolveVideoPromptRefs(sb) {
-  const prompt = sb.video_prompt || sb.videoPrompt || ''
-  const map = getShotReferenceIndexMap(sb)
-  const names = Object.keys(map).sort((a, b) => b.length - a.length)
-  if (!names.length) return prompt
-  return prompt.replace(/@([^\s@]+)/g, (m, raw) => {
-    for (const name of names) {
-      if (raw.startsWith(name)) {
-        return `@图片${map[name]}${name}${raw.slice(name.length)}`
-      }
-    }
-    return m
-  })
-}
-
 // 分镜时长（视频生成参数区直接编辑并保存到分镜）：
 // 按当前视频模型限制范围收敛后写入 storyboards.duration，列表/批量/单次生成统一读取该值
 function onVideoDurationChange(e) {
@@ -3252,32 +3507,18 @@ function uploadAssetImage(kind, id) {
 }
 
 async function genVid(sb, opts = {}) {
-  const referenceImages = getShotReferenceImages(sb)
-  // 参考素材完全来自分镜绑定的角色/场景/道具图片
-  const params = {
-    storyboard_id: sb.id,
-    drama_id: dramaId,
-    prompt: resolveVideoPromptRefs(sb),
-    duration: Number(sb.duration || 10),
-    aspect_ratio: dramaAspectRatio.value,
-    generate_audio: true,
-    model: bareModelName(videoModel.value) || undefined,
-    config_id: ownerConfigId(videoModelOptions.value, videoModel.value),
-    reference_image_urls: referenceImages,
-  }
-  if (!params.prompt && !referenceImages.length) {
-    toast.error(t('episode.vid.needRefOrPrompt'))
-    return
-  }
+  const option = videoModelOptions.value.find(item => item.key === videoModel.value) || videoModelOptions.value[0]
+  if (!productionVersion.value || !productionPanelById(sb.id)) { toast.error('当前工作版尚未就绪'); return }
+  if (!videoCanGenerate(sb.id)) { toast.error('请先完成当前镜头的全部分镜画面'); return }
+  if (!option) { toast.error('请先启用视频模型'); return }
   try {
     delete failedVideoMessages.value[sb.id]
-    if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
-    const generation = await taskAPI.generate({ type: 'video', ...params })
+    await generateProduction('video', {
+      panelIds: [sb.id], configId: option.configId, model: option.model,
+      generationMode: videoGenerationMode.value,
+    })
     if (!opts.silent) toast.success(t('episode.vid.generating'))
-    await refresh()
-    pollVideoGeneration(generation?.id, sb.id)
   } catch (e) {
-    pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
     failedVideoMessages.value = {
       ...failedVideoMessages.value,
       [sb.id]: e.message || t('episode.vid.genFailed'),
@@ -3364,7 +3605,14 @@ async function loadConfigs() {
   } catch (e) { console.error('Failed to load AI configs', e) }
 }
 
-onMounted(async () => { await refresh(); loadConfigs(); syncExtractStatus() })
+onMounted(async () => {
+  await refresh()
+  if (epId.value) {
+    try { await initializeProduction(epId.value) } catch (e) { toastError(e) }
+  }
+  loadConfigs()
+  syncExtractStatus()
+})
 
 // ===== 应用内引导（工作台）：沿左侧进度栏走 6 步流水线 =====
 const EPISODE_TOUR = [
@@ -4161,6 +4409,12 @@ onMounted(() => setTimeout(() => autoTour('episode', EPISODE_TOUR, t), 900))
 /* Production content */
 .prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
 .prod-section-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
+.prod-section-bar > .ml-auto { min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
+.video-generation-mode { flex-shrink: 0; border: 1px solid var(--border); border-radius: var(--radius); }
+.video-generation-mode .seg-item {
+  min-height: 26px; padding: 4px 9px; display: inline-flex; align-items: center; gap: 5px;
+  border-radius: calc(var(--radius) - 2px); font-size: 11px; letter-spacing: 0;
+}
 
 /* 资产栏动作：提取（虚线中性）与批量生成（强调色）视觉分组 */
 .asset-bar-actions { align-items: center; }
@@ -4641,10 +4895,54 @@ onMounted(() => setTimeout(() => autoTour('episode', EPISODE_TOUR, t), 900))
   padding: 14px 16px 16px;
   background: var(--surface-raised);
 }
+.production-work-version {
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  min-height: 34px;
+  padding: 6px 9px;
+  border: 1px solid var(--border);
+  border-radius: var(--radius);
+  background: var(--surface-muted);
+}
+.production-work-version > span { color: var(--text-0); font-size: 11px; font-weight: 700; }
+.production-work-version > small { color: var(--text-2); font-size: 10px; }
+.production-work-version > button { margin-left: auto; }
+.production-frames-section {
+  padding: 12px;
+  border: 1px solid var(--border);
+  border-radius: var(--radius);
+  background: var(--surface-muted);
+}
+.direct-frames-entry {
+  appearance: none; width: 100%; min-height: 56px; display: flex; align-items: center; gap: 10px;
+  padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--radius);
+  background: var(--surface-soft); color: var(--text-1); box-shadow: none; text-align: left;
+  cursor: pointer; letter-spacing: 0; transition: border-color .16s, background .16s;
+}
+.direct-frames-entry:hover { border-color: var(--border-strong); background: var(--bg-hover); }
+.direct-frames-entry:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--button-focus); }
+.direct-frames-entry > svg { flex-shrink: 0; color: var(--text-2); }
+.direct-frames-icon {
+  width: 32px; height: 32px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
+  border-radius: var(--radius-sm); background: var(--info-bg); color: var(--info);
+}
+.direct-frames-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
+.direct-frames-copy strong { color: var(--text-0); font-size: 12px; font-weight: 700; }
+.direct-frames-copy small { color: var(--text-2); font-size: 10px; line-height: 1.5; white-space: normal; }
+.direct-frames-context {
+  display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 8px;
+  border-radius: var(--radius-sm); background: var(--info-bg); color: var(--info);
+}
+.direct-frames-context > svg { flex-shrink: 0; }
+.direct-frames-context > div { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
+.direct-frames-context strong { font-size: 11px; }
+.direct-frames-context small { font-size: 10px; line-height: 1.4; }
+.direct-frames-context .btn { flex-shrink: 0; padding: 0; }
 /* 生成前检查动线集中一屏：上双栏（画面描述/氛围 ｜ 参考绑定），下整宽（视频提示词） */
 .video-main-grid {
   display: grid;
-  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
+  grid-template-columns: minmax(0, 1fr);
   gap: 16px;
   align-items: start;
 }
@@ -5114,6 +5412,16 @@ button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
   border-top: 1px solid var(--border);
   background: var(--surface-muted);
 }
+.video-frame-readiness {
+  padding: 6px 8px;
+  border-radius: var(--radius-sm);
+  background: var(--warning-bg);
+  color: var(--warning);
+  font-size: 10px;
+  line-height: 1.5;
+}
+.video-frame-readiness.ready { background: var(--success-bg); color: var(--success); }
+.video-frame-readiness.direct { background: var(--info-bg); color: var(--info); }
 .video-inspector-section { display: flex; flex-direction: column; gap: 7px; }
 .video-inspector-label { color: var(--text-0); font-size: 12px; font-weight: 700; }
 .video-inspector-label-hero {
@@ -5357,6 +5665,69 @@ button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
   justify-content: center;
   color: var(--text-3);
 }
+.asset-image-history {
+  display: flex;
+  flex-direction: column;
+  gap: 8px;
+  padding-top: 2px;
+}
+.asset-history-loading {
+  min-height: 54px;
+  display: flex;
+  align-items: center;
+  justify-content: center;
+  gap: 7px;
+  color: var(--text-2);
+  font-size: 11px;
+}
+.asset-history-grid {
+  display: grid;
+  grid-template-columns: repeat(3, minmax(0, 1fr));
+  gap: 7px;
+  max-height: 220px;
+  overflow: auto;
+  padding-right: 2px;
+}
+.asset-history-grid button {
+  position: relative;
+  min-width: 0;
+  aspect-ratio: 4 / 3;
+  padding: 0;
+  overflow: hidden;
+  border: 1px solid var(--surface-outline);
+  border-radius: var(--radius-sm);
+  background: var(--bg-2);
+  box-shadow: none;
+  cursor: pointer;
+}
+.asset-history-grid button:hover:not(:disabled) { border-color: var(--border-strong); }
+.asset-history-grid button.current {
+  border-color: var(--accent);
+  box-shadow: inset 0 0 0 1px var(--accent);
+}
+.asset-history-grid img { width: 100%; height: 100%; display: block; object-fit: cover; }
+.asset-history-grid span,
+.asset-history-grid i {
+  position: absolute;
+  z-index: 1;
+  padding: 1px 4px;
+  border-radius: 4px;
+  background: var(--scrim);
+  color: var(--on-media);
+  font-size: 8px;
+  font-style: normal;
+  line-height: 1.5;
+}
+.asset-history-grid span { left: 3px; bottom: 3px; max-width: calc(100% - 6px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
+.asset-history-grid i { right: 3px; top: 3px; }
+.asset-history-grid button.current i { background: var(--accent); color: var(--on-accent); }
+.asset-history-grid svg {
+  position: absolute;
+  inset: 50% auto auto 50%;
+  z-index: 2;
+  transform: translate(-50%, -50%);
+  color: var(--on-media);
+}
 .asset-detail-desc {
   margin: 0;
   color: var(--text-1);
@@ -6004,6 +6375,9 @@ button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
     flex-wrap: wrap;
   }
 
+  .video-generation-mode { order: 2; }
+  .prod-section-bar > .ml-auto { width: 100%; margin-left: 0; justify-content: flex-start; }
+
   .asset-grid,
   .character-asset-grid,
   .prod-grid {
@@ -6031,7 +6405,8 @@ button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
     flex-direction: column;
   }
 
-  .video-task-workbench {
+  .video-task-workbench,
+  .video-task-workbench.has-player {
     grid-template-columns: 1fr;
     overflow-y: auto;
   }
diff --git a/frontend/app/views/drama/previs.vue b/frontend/app/views/drama/previs.vue
new file mode 100644
index 0000000..c11712a
--- /dev/null
+++ b/frontend/app/views/drama/previs.vue
@@ -0,0 +1,868 @@
+<script setup lang="ts">
+import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
+import { onBeforeRouteLeave } from 'vue-router'
+import { toast } from 'vue-sonner'
+import { useI18n } from 'vue-i18n'
+import {
+  ArrowLeft, ArrowRight, Check, Clapperboard,
+  Download, FileText, Film, Images, Layers, ListTodo, Loader2, Lock, Plus,
+  Redo2, RefreshCw, Save, ShieldCheck, Sparkles, Undo2, Upload, Users, X,
+} from 'lucide-vue-next'
+import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
+import ThemeToggle from '~/components/ThemeToggle.vue'
+import PrevisPlayer from '~/components/previs/PrevisPlayer.vue'
+import PrevisTimeline from '~/components/previs/PrevisTimeline.vue'
+import StoryboardFramesEditor from '~/components/previs/StoryboardFramesEditor.vue'
+import { uploadAPI } from '~/composables/useApi'
+import {
+  checkContinuity, durationMs, formatTime, frameKey, groupPanels, mediaUrl, orderedFrames,
+  planFrames, previsRequest, timelineSegments, usePrevis, useVideoGenerationMode,
+  type AudioClip, type ContinuityIssue, type ContinuityReview, type FrameType, type Keyframe,
+  type Panel, type Timeline,
+} from '~/composables/usePrevis'
+import '~/assets/css/previs.css'
+
+definePageMeta({ layout: 'studio' })
+type PrevisStageView = 'storyboard' | 'video' | 'script'
+
+const { t } = useI18n()
+const route = useRoute()
+const dramaId = Number(route.params.id), episodeNumber = Number(route.params.episodeNumber)
+const episodePath = `/drama/${dramaId}/episode/${episodeNumber}`
+const {
+  version, timeline, editable, dirty, working, saveError, pollError, undoStack, redoStack,
+  initialize, open, create, edit, history, save, check, generate, batchAction,
+} = usePrevis()
+const videoGenerationMode = useVideoGenerationMode()
+const videoUsesStoryboardFrames = computed(() => videoGenerationMode.value === 'storyboard_frames')
+const drama = ref<any>(), episode = ref<any>(), error = ref(''), loading = ref(true), enabled = ref(true)
+const groupId = ref(''), panelId = ref(0), currentMs = ref(0)
+const stageView = ref<PrevisStageView>('storyboard'), inspector = ref('frames'), allIssues = ref(true)
+const previewViews: Array<{ key: PrevisStageView; label: string }> = [
+  { key: 'storyboard', label: '分镜预演' },
+  { key: 'video', label: '视频预览' },
+  { key: 'script', label: '剧本' },
+]
+const player = ref<InstanceType<typeof PrevisPlayer>>()
+const modal = ref(''), dialog = ref<HTMLDialogElement>()
+const videoPanelIds = ref<number[]>([])
+const textModel = ref(''), imageModel = ref(''), videoModel = ref('')
+const episodeResolution = ref('720p')
+const configs = ref<any[]>([]), capabilities = ref<Record<string, any>>({})
+const storyboards = ref<any[]>([])
+const SIDEBAR_COLLAPSED_KEY = 'huobao:sidebar-collapsed'
+const sidebarCollapsed = ref((() => {
+  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
+})())
+const frameNames: Record<FrameType, string> = { start: '开场画面', middle: '过程画面', end: '结束画面', beat: '分镜画面' }
+const constraintNames: Record<string, string> = {
+  auto: '全部分镜画面', direct: '直接生成', first_last: '首尾帧（历史）',
+  first: '首帧（历史）', reference: '全部分镜画面', text: '纯文本（历史）',
+}
+const statusNames: Record<string, string> = {
+  pending: '排队中', processing: '生成中', completed: '已完成', failed: '失败',
+  partial_failed: '部分失败', cancelled: '已取消', draft: '草稿', ready: '待锁定', locked: '已锁定',
+}
+const ruleNames: Record<string, string> = {
+  missing_frame: '关键帧缺失', group_duration: '组时长建议',
+  scene_bridge: '场景衔接', camera_jump: '机位跳变', audio_overflow: '音频超时',
+  empty_group: '空镜头', empty_timeline: '没有分镜',
+}
+const reviewDimensionKeys = ['subject', 'scene', 'action', 'camera'] as const
+const reviewDimensionNames = {
+  subject: '人物与道具', scene: '场景与光线', action: '动作与视线', camera: '构图与机位',
+}
+const continuityReviews = ref<ContinuityReview[]>([])
+const continuityReviewLoading = ref(false), continuityReviewError = ref('')
+let continuityReviewLoadToken = 0
+const groups = computed(() => timeline.value?.groups || [])
+const segments = computed(() => timeline.value ? timelineSegments(timeline.value) : [])
+const total = computed(() => timeline.value ? durationMs(timeline.value) : 0)
+const group = computed(() => groups.value.find(g => g.id === groupId.value) || groups.value[0])
+const panels = computed(() => timeline.value && group.value ? groupPanels(timeline.value, group.value) : [])
+const panel = computed(() => panels.value.find(p => p.id === panelId.value) || panels.value[0])
+const activeFrameId = computed(() => {
+  const current = segments.value.find(s => currentMs.value >= s.startMs && currentMs.value < s.endMs)
+    || segments.value.at(-1)
+  if (!current) return ''
+  const available = orderedFrames(current.panel).filter(item => item.url)
+  const offset = currentMs.value - current.startMs
+  const frame = available.filter(item => (item.offsetMs || 0) <= offset).at(-1) || available[0]
+  return frame ? frameKey(frame) : ''
+})
+const edge = computed(() => timeline.value?.transitions.find(e => e.to === group.value?.id))
+const currentReview = computed(() => !dirty.value
+  ? continuityReviews.value.find(item => item.toGroupId === group.value?.id)
+  : undefined)
+const boundaryImages = computed(() => {
+  if (!timeline.value || !edge.value) return { from: '', to: '' }
+  const fromGroup = timeline.value.groups.find(item => item.id === edge.value?.from)
+  const fromPanel = fromGroup ? groupPanels(timeline.value, fromGroup).at(-1) : undefined
+  const toPanel = group.value ? groupPanels(timeline.value, group.value)[0] : undefined
+  return {
+    from: fromPanel ? orderedFrames(fromPanel).filter(item => item.url).at(-1)?.url || '' : '',
+    to: toPanel ? orderedFrames(toPanel).find(item => item.url)?.url || '' : '',
+  }
+})
+const issues = computed(() => timeline.value ? checkContinuity(timeline.value) : [])
+const fails = computed(() => issues.value.filter(i => i.severity === 'fail'))
+const warnings = computed(() => issues.value.filter(i => i.severity === 'warning' && !i.reason))
+const visibleIssues = computed(() => issues.value.filter(i => allIssues.value || i.groupId === group.value?.id))
+const batches = computed(() => version.value?.batches || [])
+const activeTasks = computed(() => batches.value.flatMap(b => b.items).filter(i => ['pending', 'processing'].includes(i.status)).length)
+const frameCount = computed(() => timeline.value?.panels.reduce((n, p) => n + p.frames.filter(f => f.url).length, 0) || 0)
+const characterCount = computed(() => drama.value?.characters?.filter((item: any) => !item.deleted_at && !item.deletedAt).length || 0)
+const assets = computed(() => [
+  ...(drama.value?.characters || []),
+  ...(drama.value?.scenes || []),
+  ...(drama.value?.props || []),
+].filter((item: any) => !item.deleted_at && !item.deletedAt))
+const assetsReady = computed(() => assets.value.length > 0 && assets.value.every((item: any) => item.image_url || item.imageUrl))
+const videoSources = computed(() => {
+  const sources: Record<number, { url: string; offsetMs: number }> = {}
+  for (const output of version.value?.outputs.filter(o => !o.stale) || []) {
+    let offsetMs = 0
+    for (const id of output.panelIds) {
+      if (!sources[id]) sources[id] = { url: output.url, offsetMs }
+      offsetMs += timeline.value?.panels.find(p => p.id === id)?.durationMs || 0
+    }
+  }
+  for (const output of version.value?.outputs.filter(o => o.stale) || []) {
+    for (const id of output.panelIds) if (!sources[id]) sources[id] = { url: '', offsetMs: 0 }
+  }
+  for (const item of timeline.value?.panels || []) {
+    if (Object.prototype.hasOwnProperty.call(sources, item.id)) continue
+    const legacy = storyboards.value.find(storyboard => Number(storyboard.id) === item.id)
+    const url = item.videoUrl || legacy?.video_url || legacy?.videoUrl
+      || legacy?.composed_video_url || legacy?.composedVideoUrl
+    if (url) sources[item.id] = { url, offsetMs: 0 }
+  }
+  return sources
+})
+const hasVideoPreview = computed(() => timeline.value?.panels.some(item => {
+  if (Object.prototype.hasOwnProperty.call(videoSources.value, item.id)) return !!videoSources.value[item.id]?.url
+  return !!item.videoUrl
+}) || false)
+const completedVideos = computed(() => storyboards.value.length
+  ? storyboards.value.filter(item => item.video_url || item.videoUrl).length
+  : groups.value.filter(g => g.panelIds.every(id => !!videoSources.value[id]?.url)).length)
+function modelOptions(type: string) {
+  const seen = new Set<string>()
+  return [...configs.value]
+    .filter(c => (c.service_type || c.serviceType) === type && (c.is_active ?? c.isActive))
+    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
+    .flatMap(c => {
+      let models: string[] = []
+      try { models = Array.isArray(c.model) ? c.model : JSON.parse(c.model || '[]') } catch { models = [c.model] }
+      return models.filter(model => {
+        const key = `${c.provider}/${model}`
+        if (!model || seen.has(key)) return false
+        seen.add(key)
+        return true
+      }).map(model => ({
+        key: `${c.provider}/${model}`, label: `${c.name} · ${model}`, configId: c.id,
+        configName: c.name, model, provider: c.provider,
+      }))
+    })
+}
+function hasMultipleConfigs(type: string) {
+  return new Set(modelOptions(type).map(option => option.configId)).size > 1
+}
+function modelChoice(type: 'text' | 'image' | 'video') {
+  const selected = type === 'text' ? textModel.value : type === 'image' ? imageModel.value : videoModel.value
+  return modelOptions(type).find(o => o.key === selected) || modelOptions(type)[0]
+}
+const resolutionOptions = computed(() => {
+  const provider = modelChoice('video')?.provider
+  if (provider === 'minimax') return [
+    { key: '720p', model: '768P · 高清' },
+    { key: '1080p', model: '2K · 超清' },
+  ]
+  if (provider === 'aliyun') return [
+    { key: '480p', model: '480P · 流畅' },
+    { key: '720p', model: '720P · 高清' },
+    { key: '1080p', model: '1080P · 超清' },
+  ]
+  return [
+    { key: '480p', model: '480p · 流畅' },
+    { key: '720p', model: '720p · 高清' },
+  ]
+})
+const sidebarSections = computed(() => ([
+  {
+    id: 'script',
+    label: t('episode.stage.script'),
+    items: [
+      { key: 'script:raw', label: t('episode.script.raw'), icon: FileText },
+      { key: 'script:rewrite', label: t('episode.script.rewrite'), icon: FileText },
+    ],
+  },
+  {
+    id: 'production',
+    label: t('episode.stage.production'),
+    items: [
+      { key: 'prod:assets', label: t('episode.prod.assets'), icon: Users },
+      { key: 'prod:videos', label: t('episode.prod.videos'), icon: Clapperboard },
+    ],
+  },
+  {
+    id: 'export',
+    label: t('episode.stage.export'),
+    items: [{ key: 'export:merge', label: t('episode.stage.mergeExport'), icon: Download }],
+  },
+]))
+const mainProgressSteps = computed(() => [
+  { id: 'script', label: t('episode.stage.script') },
+  { id: 'assets', label: t('episode.prod.assets') },
+  { id: 'videos', label: t('episode.stage.videos') },
+  { id: 'export', label: t('episode.stage.export') },
+])
+const currentMainIdx = 2
+const pipelineProgress = computed(() =>
+  Number(!!(episode.value?.script_content || episode.value?.scriptContent)) + Number(mainStageDone('videos')))
+const currentStageLabel = computed(() => `${t('episode.stage.videos')} · 镜头看板`)
+function mainStageDone(stageId: string) {
+  if (stageId === 'script') return !!(episode.value?.script_content || episode.value?.scriptContent)
+  if (stageId === 'assets') return assetsReady.value
+  if (stageId === 'videos') return groups.value.length > 0 && completedVideos.value === groups.value.length
+  if (stageId === 'export') return !!(episode.value?.video_url || episode.value?.videoUrl)
+  return false
+}
+function sectionState(sectionId: string) {
+  if (sectionId === 'export') return 'none'
+  if (sectionId === 'script') return mainStageDone('script') ? 'done' : 'pending'
+  return mainStageDone('assets') && mainStageDone('videos') ? 'done' : 'active'
+}
+function toggleSidebar() {
+  sidebarCollapsed.value = !sidebarCollapsed.value
+  try {
+    sidebarCollapsed.value
+      ? localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
+      : localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
+  } catch {}
+}
+function goSubStep(key: string) {
+  const [stage, step] = key.split(':')
+  const query = stage === 'script'
+    ? { stage: 'script', step }
+    : stage === 'prod'
+      ? { stage: step }
+      : { stage: 'export' }
+  void navigateTo({ path: episodePath, query })
+}
+function goMainStage(stage: string) {
+  void navigateTo({ path: episodePath, query: { stage } })
+}
+function persistModel(value: string, key: string) {
+  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key) } catch {}
+}
+watch(textModel, value => persistModel(value, 'huobao:model:chat'))
+watch(imageModel, value => persistModel(value, 'huobao:model:image'))
+watch(videoModel, value => persistModel(value, 'huobao:model:video'))
+watch(episodeResolution, async (value, previous) => {
+  if (!episode.value?.id || value === previous || value === (episode.value.resolution || '720p')) return
+  try {
+    await previsRequest(`/episodes/${episode.value.id}`, 'PUT', { resolution: value })
+    episode.value.resolution = value
+    toast.success(`视频分辨率已切换为 ${resolutionOptions.value.find(item => item.key === value)?.model || value}`)
+  } catch (cause: any) {
+    episodeResolution.value = previous
+    toast.error(cause.message || '分辨率更新失败')
+  }
+})
+const videoCapability = computed(() => capabilities.value[modelChoice('video')?.provider || ''])
+const videoTargetPanels = computed(() => {
+  if (!timeline.value) return []
+  if (!videoPanelIds.value.length) return timeline.value.panels
+  return timeline.value.panels.filter(p => videoPanelIds.value.includes(p.id))
+})
+const incompleteVideoPanels = computed(() => videoTargetPanels.value.filter(p => !p.frames.length || p.frames.some(frame => !frame.url)))
+function groupDuration(id: string) { return segments.value.filter(s => s.groupId === id).reduce((n, s) => n + s.panel.durationMs, 0) }
+function groupThumb(id: string) {
+  return timeline.value?.panels.find(p => p.id === groups.value.find(g => g.id === id)?.panelIds[0])?.frames.find(f => f.url)?.url
+}
+function groupScene(id: string) {
+  const item = groups.value.find(group => group.id === id)
+  return timeline.value?.panels.find(panel => item?.panelIds.includes(panel.id))?.scene || '未填写场景'
+}
+function groupStatus(id: string) {
+  return issues.value.some(i => i.groupId === id && i.severity === 'fail') ? 'fail'
+    : issues.value.some(i => i.groupId === id && !i.reason) ? 'warning' : 'pass'
+}
+async function run(action: () => any) {
+  try { await action() } catch (e: any) { toast.error(e.message || '操作失败，请重试') }
+}
+function setStageView(view: PrevisStageView) {
+  if (view === stageView.value) return
+  player.value?.stop()
+  stageView.value = view
+}
+function select(id: string, shotId?: number) {
+  player.value?.stop()
+  continuityReviewError.value = ''
+  groupId.value = id
+  panelId.value = shotId || groups.value.find(g => g.id === id)?.panelIds[0] || 0
+  currentMs.value = segments.value.find(s => s.panel.id === panelId.value)?.startMs || 0
+}
+function seek(ms: number) {
+  currentMs.value = Math.max(0, Math.min(total.value, ms))
+  const s = segments.value.find(s => ms >= s.startMs && ms < s.endMs)
+  if (s) { groupId.value = s.groupId; panelId.value = s.panel.id }
+}
+watch(() => version.value?.id, () => { select(groups.value[0]?.id || ''); videoPanelIds.value = [] })
+watch(total, value => { if (currentMs.value > value) seek(value) })
+function updatePanel(key: keyof Panel, value: any) {
+  const id = panel.value?.id
+  edit(t => {
+    const target = t.panels.find(p => p.id === id)
+    if (target) Object.assign(target, { [key]: value })
+    if (key === 'title') {
+      const group = t.groups.find(group => group.panelIds[0] === id)
+      if (group) group.title = value
+    }
+  })
+}
+function updateFrames(frames: Keyframe[], coverFrameId?: string) {
+  const id = panel.value?.id
+  edit(t => {
+    const target = t.panels.find(p => p.id === id)
+    if (target) { target.frames = frames; target.coverFrameId = coverFrameId }
+  })
+}
+function setDuration(id: number, value: number) {
+  edit(t => {
+    const p = t.panels.find(p => p.id === id)
+    if (p) p.durationMs = Math.max(100, Math.round(value))
+  })
+}
+function updateEdge(key: string, value: any) {
+  const to = group.value?.id
+  edit(t => { const e = t.transitions.find(e => e.to === to); if (e) Object.assign(e, { [key]: value }) })
+}
+function locateIssue(issue: ContinuityIssue) {
+  select(issue.groupId, issue.panelId)
+  setStageView('storyboard')
+}
+const waiverIssue = ref<ContinuityIssue>(), waiverReason = ref('')
+function waive(issue: ContinuityIssue) { waiverIssue.value = issue; waiverReason.value = issue.reason || ''; modal.value = 'waiver' }
+function applyWaiver() {
+  if (!waiverReason.value.trim() || !waiverIssue.value) return
+  edit(t => { t.acknowledgements[waiverIssue.value!.id] = waiverReason.value.trim() }); modal.value = ''
+}
+function showStrategy() { modal.value = 'strategy' }
+function confidenceName(value: ContinuityReview['result']['confidence']) {
+  return { high: '高置信度', medium: '中置信度', low: '低置信度' }[value]
+}
+async function loadContinuityReviews() {
+  const target = version.value
+  if (!target) { continuityReviews.value = []; return }
+  const token = ++continuityReviewLoadToken
+  try {
+    const result = await previsRequest<ContinuityReview[]>(`/animatic-versions/${target.id}/continuity-reviews`)
+    if (token === continuityReviewLoadToken && version.value?.id === target.id) continuityReviews.value = result
+  } catch {
+    if (token === continuityReviewLoadToken) continuityReviews.value = []
+  }
+}
+async function scoreContinuity() {
+  if (!version.value || !group.value || !edge.value) return
+  const force = !!currentReview.value
+  if (!await save() || !version.value) return
+  const choice = modelChoice('text')
+  if (!choice) { toast.error('请先选择文本模型'); return }
+  continuityReviewLoading.value = true
+  continuityReviewError.value = ''
+  try {
+    const review = await previsRequest<ContinuityReview>(
+      `/animatic-versions/${version.value.id}/continuity-reviews`,
+      'POST',
+      {
+        revision: version.value.revision,
+        toGroupId: group.value.id,
+        configId: choice.configId,
+        model: choice.model,
+        force,
+      },
+    )
+    continuityReviews.value = [
+      ...continuityReviews.value.filter(item => item.toGroupId !== review.toGroupId),
+      review,
+    ]
+    toast.success(review.cached ? '已读取缓存评分' : '连续性评分已完成')
+  } catch (cause: any) {
+    continuityReviewError.value = cause.message || '连续性评分失败'
+    throw cause
+  } finally {
+    continuityReviewLoading.value = false
+  }
+}
+async function generateFrames(ids?: number[], frameIds?: string[], force = false) {
+  const model = modelChoice('image')
+  if (!model) { showStrategy(); toast.error('请选择已启用的图片模型'); return }
+  await generate('image', { configId: model.configId, model: model.model, panelIds: ids, frameIds, force })
+  inspector.value = 'tasks'
+}
+async function planAndGenerate(ids?: number[]) {
+  const selected = ids?.length ? ids : timeline.value?.panels.map(p => p.id) || []
+  edit(t => {
+    for (const p of t.panels.filter(p => selected.includes(p.id))) {
+      if (!p.frames.length) p.frames = planFrames(p, crypto.randomUUID())
+    }
+  })
+  await generateFrames(selected)
+}
+const uploading = ref(false)
+const audioDraft = ref<AudioClip>()
+function showAudio(id?: string) {
+  const clip = timeline.value?.audio.find(a => a.id === id)
+  audioDraft.value = clip ? JSON.parse(JSON.stringify(clip)) : {
+    id: crypto.randomUUID(), type: 'dialogue', panelId: panel.value?.id || null, character: '', text: '', url: '',
+    startMs: Math.round(currentMs.value / 100) * 100, durationMs: panel.value?.durationMs || 3000,
+  }
+  modal.value = 'audio'
+}
+function saveAudio(remove = false) {
+  if (!audioDraft.value) return
+  const value = { ...audioDraft.value }
+  edit(t => {
+    const index = t.audio.findIndex(a => a.id === value.id)
+    if (remove) { if (index >= 0) t.audio.splice(index, 1) }
+    else if (index >= 0) t.audio[index] = value
+    else t.audio.push(value)
+  }); modal.value = ''
+}
+async function uploadAudio(event: Event) {
+  const input = event.target as HTMLInputElement, file = input.files?.[0]
+  if (!file || !audioDraft.value) return
+  uploading.value = true
+  try {
+    const result = await uploadAPI.audio(file)
+    audioDraft.value.url = result.path || result.url
+  } finally { uploading.value = false; input.value = '' }
+}
+function moveAudio(id: string, startMs: number, duration: number) {
+  edit(t => { const a = t.audio.find(a => a.id === id); if (a) { a.startMs = startMs; a.durationMs = duration } })
+}
+async function startVideo() {
+  const choice = modelChoice('video')
+  if (!choice) { toast.error('请先选择视频模型'); return }
+  if (videoUsesStoryboardFrames.value && incompleteVideoPanels.value.length) {
+    toast.error(`请先完成 ${incompleteVideoPanels.value.length} 个镜头的全部分镜画面`)
+    return
+  }
+  await generate('video', { configId: choice.configId, model: choice.model,
+    panelIds: videoPanelIds.value.length ? videoPanelIds.value : undefined,
+    generationMode: videoGenerationMode.value })
+  modal.value = ''; inspector.value = 'tasks'
+}
+function downloadDraft() {
+  const blob = new Blob([JSON.stringify(version.value, null, 2)], { type: 'application/json' })
+  const url = URL.createObjectURL(blob), a = document.createElement('a')
+  a.href = url; a.download = `previs-ep${episodeNumber}-v${version.value?.versionNo}.json`; a.click()
+  URL.revokeObjectURL(url)
+}
+async function refreshWorkbench() {
+  await run(async () => {
+    const latestDrama = await previsRequest(`/dramas/${dramaId}`)
+    drama.value = latestDrama
+    episode.value = latestDrama.episodes?.find((item: any) =>
+      (item.episode_number || item.episodeNumber) === episodeNumber)
+    if (version.value) await open(version.value.id)
+    if (episode.value) storyboards.value = await previsRequest(`/episodes/${episode.value.id}/storyboards`)
+    configs.value = await previsRequest('/ai-configs')
+    toast.success('镜头看板已刷新')
+  })
+}
+function valueOf(event: Event) { return (event.target as HTMLInputElement).value }
+watch(modal, async value => {
+  if (value) { player.value?.stop(); await nextTick(); if (!dialog.value?.open) dialog.value?.showModal() }
+  else dialog.value?.close()
+})
+watch(() => [version.value?.id, version.value?.revision], () => { void loadContinuityReviews() })
+function onKey(event: KeyboardEvent) {
+  if (modal.value || /INPUT|TEXTAREA|SELECT|BUTTON/.test((event.target as HTMLElement).tagName)) return
+  if (event.code === 'Space') { event.preventDefault(); player.value?.toggle() }
+  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
+    event.preventDefault()
+    const index = segments.value.findIndex(s => s.panel.id === panel.value?.id)
+    const next = segments.value[index + (event.key === 'ArrowRight' ? 1 : -1)]
+    if (next) select(next.groupId, next.panel.id)
+  }
+  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey) }
+  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
+}
+function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
+onBeforeRouteLeave(async () => await save())
+onMounted(async () => {
+  window.addEventListener('keydown', onKey); window.addEventListener('beforeunload', beforeUnload)
+  try {
+    const cap = await previsRequest('/previs/capabilities')
+    enabled.value = cap.enabled; capabilities.value = cap.video
+    drama.value = await previsRequest(`/dramas/${dramaId}`)
+    episode.value = drama.value.episodes?.find((e: any) => (e.episode_number || e.episodeNumber) === episodeNumber)
+    if (!episode.value) throw new Error('未找到当前剧集')
+    await initialize(episode.value.id)
+    storyboards.value = await previsRequest(`/episodes/${episode.value.id}/storyboards`)
+    configs.value = await previsRequest('/ai-configs')
+    const storedModel = (key: string) => {
+      try { return localStorage.getItem(key) || '' } catch { return '' }
+    }
+    const chooseModel = (type: string, stored: string, configId?: number) => {
+      const options = modelOptions(type)
+      return options.find(option => option.key === stored)?.key
+        || options.find(option => option.configId === configId)?.key
+        || options[0]?.key
+        || ''
+    }
+    textModel.value = chooseModel('text', storedModel('huobao:model:chat'))
+    imageModel.value = chooseModel('image', storedModel('huobao:model:image'), episode.value.image_config_id || episode.value.imageConfigId)
+    videoModel.value = chooseModel('video', storedModel('huobao:model:video'), episode.value.video_config_id || episode.value.videoConfigId)
+    episodeResolution.value = episode.value.resolution || '720p'
+  } catch (e: any) { error.value = e.message }
+  finally { loading.value = false }
+})
+onUnmounted(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', beforeUnload) })
+</script>
+
+<template>
+  <div class="pv-app">
+    <header class="studio-topbar">
+      <div class="studio-topbar-main">
+        <button class="back-btn topbar-back" @click="navigateTo(`/drama/${dramaId}`)">
+          <ArrowLeft :size="15" />
+          {{ t('episode.topbar.back') }}
+        </button>
+        <div class="studio-identity">
+          <h1 class="studio-title">{{ drama?.title || '动态故事版' }}</h1>
+          <span class="studio-episode-chip">{{ t('episode.topbar.episodeN', { n: episodeNumber }) }}</span>
+          <div class="studio-meta-row">
+            <span class="studio-meta-pill">镜头看板 · 关键帧预演</span>
+            <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/2</span>
+            <span class="studio-meta-inline">{{ t('episode.topbar.meta', { roles: characterCount, shots: groups.length }) }}</span>
+          </div>
+        </div>
+      </div>
+
+      <div class="studio-topbar-side">
+        <div class="studio-model-picks">
+          <ModelSelect
+            v-if="modelOptions('text').length"
+            v-model="textModel"
+            :label="t('common.serviceType.text')"
+            :options="modelOptions('text')"
+            :default-label="modelOptions('text')[0]?.model"
+            :show-config="hasMultipleConfigs('text')"
+          />
+          <ModelSelect
+            v-if="modelOptions('image').length"
+            v-model="imageModel"
+            :label="t('common.serviceType.image')"
+            :options="modelOptions('image')"
+            :default-label="modelOptions('image')[0]?.model"
+            :show-config="hasMultipleConfigs('image')"
+          />
+          <ModelSelect
+            v-if="modelOptions('video').length"
+            v-model="videoModel"
+            :label="t('common.serviceType.video')"
+            :options="modelOptions('video')"
+            :default-label="modelOptions('video')[0]?.model"
+            :show-config="hasMultipleConfigs('video')"
+          />
+          <ModelSelect
+            v-model="episodeResolution"
+            :label="t('episode.topbar.resolution')"
+            :options="resolutionOptions"
+            hide-default
+          />
+        </div>
+        <div class="studio-actions">
+          <LocaleSwitcher />
+          <ThemeToggle />
+          <button class="btn" :disabled="working" @click="refreshWorkbench">
+            <RefreshCw :size="12" :class="{ 'pv-spin': working }" />
+            {{ t('common.refresh') }}
+          </button>
+          <button class="btn task-drawer-trigger" @click="inspector = 'tasks'">
+            <ListTodo :size="12" />
+            {{ t('episode.topbar.tasks') }}
+            <span v-if="activeTasks" class="task-drawer-badge">{{ activeTasks }}</span>
+          </button>
+        </div>
+      </div>
+    </header>
+
+    <div class="studio-body">
+      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
+        <nav class="pipeline">
+          <div
+            v-for="section in sidebarSections"
+            :key="section.id"
+            :class="['pipe-section', 'is-' + sectionState(section.id)]"
+          >
+            <div class="pipe-section-label">
+              <span v-if="sectionState(section.id) !== 'none'" class="pipe-section-state">
+                <Check v-if="sectionState(section.id) === 'done'" :size="10" :stroke-width="2.5" />
+                <span v-else-if="sectionState(section.id) === 'active'" class="pipe-section-pulse" />
+                <span v-else class="pipe-section-dot" />
+              </span>
+              <span>{{ section.label }}</span>
+              <span v-if="sectionState(section.id) === 'active'" class="pipe-section-tag">{{ t('episode.sidebar.inProgress') }}</span>
+            </div>
+            <button
+              v-for="item in section.items"
+              :key="item.key"
+              :class="['pipe-item pipe-item-sub', {
+                active: item.key === 'prod:videos',
+                done: sectionState(section.id) === 'done',
+                doing: sectionState(section.id) === 'active',
+              }]"
+              :title="sidebarCollapsed ? item.label : undefined"
+              @click="goSubStep(item.key)"
+            >
+              <span class="pipe-icon" :class="sectionState(section.id) === 'done' ? 'icon-done' : item.key === 'prod:videos' ? 'icon-active' : ''">
+                <template v-if="sidebarCollapsed">
+                  <component :is="item.icon" :size="12" />
+                  <span v-if="sectionState(section.id) === 'active'" class="pipe-mini-pulse" />
+                </template>
+                <Check v-else-if="sectionState(section.id) === 'done'" :size="10" :stroke-width="2.5" />
+                <span v-else-if="sectionState(section.id) === 'active'" class="pipe-item-pulse" />
+                <component :is="item.icon" v-else :size="11" />
+              </span>
+              <span class="pipe-copy"><span class="pipe-label">{{ item.label }}</span></span>
+            </button>
+          </div>
+        </nav>
+
+        <div class="sidebar-bottom">
+          <button
+            type="button"
+            class="sidebar-toggle"
+            :title="t(sidebarCollapsed ? 'episode.sidebar.expand' : 'episode.sidebar.collapse')"
+            @click="toggleSidebar"
+          >
+            <ArrowLeft class="sidebar-toggle-icon" :size="12" />
+            <span v-if="!sidebarCollapsed">{{ t('episode.sidebar.collapse') }}</span>
+          </button>
+          <div class="sidebar-progress">
+            <div class="sidebar-progress-head">
+              <span class="sidebar-progress-title">{{ currentStageLabel }}</span>
+              <span class="sidebar-progress-count">{{ currentMainIdx + 1 }}/{{ mainProgressSteps.length }}</span>
+            </div>
+            <div class="sidebar-progress-track">
+              <button
+                v-for="(step, index) in mainProgressSteps"
+                :key="step.id"
+                type="button"
+                :class="['sidebar-progress-seg', { done: index < currentMainIdx || mainStageDone(step.id), current: index === currentMainIdx }]"
+                :title="step.label"
+                @click="goMainStage(step.id)"
+              ><span class="sidebar-progress-seg-fill" /></button>
+            </div>
+            <div class="sidebar-progress-labels">
+              <span
+                v-for="(step, index) in mainProgressSteps"
+                :key="step.id"
+                :class="{ on: index === currentMainIdx, done: index < currentMainIdx || mainStageDone(step.id) }"
+              >{{ step.label }}</span>
+            </div>
+          </div>
+          <button class="refresh-btn" :disabled="working" @click="refreshWorkbench">
+            <RefreshCw :size="12" :class="{ 'pv-spin': working }" />
+            {{ t('episode.sidebar.refreshData') }}
+          </button>
+        </div>
+      </aside>
+
+      <main class="main pv-main">
+        <header class="pv-board-toolbar">
+          <div class="pv-board-heading">
+            <Clapperboard :size="17" />
+            <div>
+              <h2>镜头看板</h2>
+              <p>{{ groups.length }} 个镜头 · {{ frameCount }} 张画面 · {{ (total / 1000).toFixed(1) }} 秒</p>
+            </div>
+          </div>
+          <div class="seg pv-video-mode" aria-label="视频生成模式">
+            <button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'direct' }"
+              :aria-pressed="videoGenerationMode === 'direct'" title="使用提示词与已绑定素材直接生成"
+              @click="videoGenerationMode = 'direct'"><Film :size="12" />直接生成</button>
+            <button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'storyboard_frames' }"
+              :aria-pressed="videoGenerationMode === 'storyboard_frames'" title="使用当前镜头的全部分镜画面生成"
+              @click="videoGenerationMode = 'storyboard_frames'"><Images :size="12" />分镜画面</button>
+          </div>
+          <div class="pv-header-actions">
+            <button
+              class="btn btn-sm"
+              title="返回原始视频制作页面"
+              @click="navigateTo({ path: episodePath, query: { stage: 'videos' } })"
+            >
+              <ArrowLeft :size="14" />视频制作
+            </button>
+            <template v-if="version">
+              <button :disabled="!editable || !undoStack.length" title="撤销 ⌘Z" aria-label="撤销" @click="history()"><Undo2 :size="16" /></button>
+              <button :disabled="!editable || !redoStack.length" title="重做 ⇧⌘Z" aria-label="重做" @click="history(true)"><Redo2 :size="16" /></button>
+              <button :disabled="working || !dirty" @click="save"><Loader2 v-if="working" :size="14" class="pv-spin" /><Save v-else :size="14" />{{ dirty ? '保存' : '已保存' }}</button>
+              <button class="pv-check-button" :disabled="!editable" @click="run(() => check())"><ShieldCheck :size="15" />运行检查 <span>{{ fails.length }}</span></button>
+            </template>
+          </div>
+        </header>
+    <div v-if="loading" class="pv-empty"><Loader2 class="pv-spin" :size="30" /><h2>正在加载故事版…</h2></div>
+    <div v-else-if="error || !enabled" class="pv-empty"><Clapperboard :size="40" /><h2>{{ error || '动态故事版功能暂未启用' }}</h2><button @click="navigateTo(episodePath)">返回剧集工作台</button></div>
+    <div v-else-if="!version" class="pv-empty"><div class="pv-empty-icon"><Layers :size="42" :stroke-width="1.5" /></div><h2>先看见故事，再生成视频</h2><p>从当前分镜生成画面，检查相邻镜头衔接并播放整集预演。</p><button class="btn btn-primary" :disabled="working" @click="run(() => create())"><Plus :size="16" />从分镜创建故事版</button><small>请先在视频制作中完成分镜拆分</small></div>
+    <template v-else-if="timeline">
+      <div v-if="saveError || pollError || version.busy || version.status === 'locked'" class="pv-banner" :class="{ 'is-error': saveError }">
+        <Lock v-if="version.status === 'locked'" :size="13" /><Loader2 v-else-if="version.busy" :size="13" class="pv-spin" />
+        {{ saveError ? `尚未保存：${saveError}` : pollError || (version.busy ? '分镜画面正在生成，可继续编辑其他内容。' : `V${String(version.versionNo).padStart(2, '0')} 已锁定。`) }}
+        <button v-if="saveError" @click="downloadDraft">下载本地草稿</button><button v-if="saveError" @click="modal = 'reload'">重新载入远端版本</button>
+      </div>
+      <section class="pv-workspace">
+        <aside class="pv-navigator">
+          <div class="pv-group-list" role="tablist" aria-label="镜头列表">
+          <button
+            v-for="(item, index) in groups"
+            :key="item.id"
+            role="tab"
+            class="pv-group-card"
+            :class="{ selected: group?.id === item.id }"
+            :aria-selected="group?.id === item.id"
+            @click="select(item.id)"
+          >
+            <span class="pv-group-number">{{ String(index + 1).padStart(2, '0') }}</span>
+            <span class="pv-mini-still">
+              <img v-if="groupThumb(item.id)" :src="mediaUrl(groupThumb(item.id))" :alt="item.title" loading="lazy">
+              <Clapperboard v-else :size="20" :stroke-width="1" />
+              <b>{{ (groupDuration(item.id) / 1000).toFixed(1) }}″</b>
+            </span>
+            <span class="pv-group-copy">
+              <strong>{{ item.title || '未命名镜头' }}</strong>
+              <small>{{ groupScene(item.id) }}</small>
+              <span class="pv-status" :class="groupStatus(item.id)"><i />{{ groupStatus(item.id) === 'fail' ? '阻断' : groupStatus(item.id) === 'warning' ? '需确认' : '通过' }}</span>
+            </span>
+          </button>
+          <div v-if="!groups.length" class="pv-small-empty">尚无分镜。返回视频制作拆分剧本，再同步分镜。</div>
+          </div>
+        </aside>
+        <section class="pv-stage-column">
+          <header class="pv-stage-toolbar"><div class="pv-stage-title"><span>{{ String(groups.findIndex(g => g.id === group?.id) + 1).padStart(2, '0') }}</span><div><p class="pv-eyebrow">镜头预览</p><b>{{ panel?.title || group?.title || '镜头预览' }}</b></div></div><div class="seg pv-tabs"><button v-for="view in previewViews" :key="view.key" class="seg-item" :class="{ on: stageView === view.key }" :aria-pressed="stageView === view.key" :title="view.key === 'video' && !hasVideoPreview ? '当前工作版暂无视频，将回退分镜预演' : view.label" @click="setStageView(view.key)">{{ view.label }}</button></div></header>
+          <div class="pv-stage-scroll">
+            <PrevisPlayer ref="player" :timeline="timeline" :current-ms="currentMs" :view="stageView" :video-sources="videoSources" :storyboard-is-video-input="videoUsesStoryboardFrames" @seek="seek" />
+          </div>
+        </section>
+        <aside class="pv-inspector">
+          <div class="seg pv-inspector-tabs"><button v-for="tab in ['frames', 'issues', 'properties']" :key="tab" class="seg-item" :class="{ on: inspector === tab }" :aria-pressed="inspector === tab" @click="inspector = tab">{{ { frames: '画面', issues: '连续性', properties: '属性' }[tab] }}</button></div>
+          <div class="pv-inspector-scroll">
+            <template v-if="inspector === 'frames' && panel">
+              <StoryboardFramesEditor
+                :key="`${version.id}-${panel.id}`"
+                :panel="panel"
+                :editable="editable"
+                :tasks="batches.filter(b => b.type === 'image').flatMap(b => b.items).filter(item => item.panelId === panel!.id)"
+                :video-generation-mode="videoGenerationMode"
+                :active-frame-id="activeFrameId"
+                :title="videoUsesStoryboardFrames ? '分镜画面 · 视频输入' : '分镜画面 · 仅用于预演'"
+                show-video-action
+                @change="updateFrames"
+                @settings-open="player?.stop()"
+                @generate="(ids, force) => run(() => generateFrames([panel!.id], ids, force))"
+                @video="videoPanelIds = [panel!.id]; modal = 'video'"
+              />
+            </template>
+            <template v-else-if="inspector === 'issues'">
+              <section v-if="edge" class="pv-ai-review">
+                <header>
+                  <div><p class="pv-eyebrow">AI 相邻镜头评分</p><strong>{{ groups.find(item => item.id === edge?.from)?.title }} → {{ group?.title }}</strong></div>
+                  <button :disabled="continuityReviewLoading || working || !textModel" title="调用所选文本模型评分" @click="run(scoreContinuity)">
+                    <Loader2 v-if="continuityReviewLoading" :size="13" class="pv-spin" /><Sparkles v-else :size="13" />
+                    {{ currentReview ? '重新评分' : '开始评分' }}
+                  </button>
+                </header>
+                <div class="pv-ai-review-images">
+                  <figure><img v-if="boundaryImages.from" :src="mediaUrl(boundaryImages.from)" alt="上一镜头尾张"><span v-else><Images :size="18" /></span><figcaption>上一镜头</figcaption></figure>
+                  <ArrowRight :size="14" />
+                  <figure><img v-if="boundaryImages.to" :src="mediaUrl(boundaryImages.to)" alt="当前镜头首张"><span v-else><Images :size="18" /></span><figcaption>当前镜头</figcaption></figure>
+                </div>
+                <div v-if="currentReview" class="pv-ai-review-result">
+                  <div class="pv-ai-review-summary">
+                    <div class="pv-ai-review-score"><b>{{ currentReview.result.overallScore }}</b><span>/ 100</span></div>
+                    <div><span class="pv-confidence" :class="currentReview.result.confidence">{{ confidenceName(currentReview.result.confidence) }}</span><p>{{ currentReview.result.summary }}</p></div>
+                  </div>
+                  <div class="pv-ai-review-dimensions">
+                    <div v-for="key in reviewDimensionKeys" :key="key">
+                      <span>{{ reviewDimensionNames[key] }}</span><progress :value="currentReview.result.dimensions[key].score" max="25" /><b>{{ currentReview.result.dimensions[key].score }}</b>
+                      <small>{{ currentReview.result.dimensions[key].comment }}</small>
+                    </div>
+                  </div>
+                  <div v-if="currentReview.result.issues.length" class="pv-ai-review-list"><strong>发现的问题</strong><p v-for="item in currentReview.result.issues" :key="item">{{ item }}</p></div>
+                  <div v-if="currentReview.result.suggestions.length" class="pv-ai-review-list suggestions"><strong>修改建议</strong><p v-for="item in currentReview.result.suggestions" :key="item">{{ item }}</p></div>
+                  <footer><span>{{ currentReview.images.from && currentReview.images.to ? '双画面评分' : '文字辅助评分' }} · {{ currentReview.model }}</span><time>{{ new Date(currentReview.createdAt).toLocaleString() }}</time></footer>
+                </div>
+                <div v-else class="pv-ai-review-empty">
+                  <Loader2 v-if="continuityReviewLoading" :size="18" class="pv-spin" />
+                  <Sparkles v-else :size="18" />
+                  <span>{{ continuityReviewLoading ? '正在评分…' : continuityReviewError || (!textModel ? '请先配置文本模型' : dirty ? '镜头内容已修改，请保存后重新评分' : '尚未评分') }}</span>
+                </div>
+              </section>
+              <div v-else class="pv-ai-review-empty pv-ai-review-first"><Check :size="18" /><span>首个镜头无前序衔接</span></div>
+              <div class="pv-check-summary"><div class="pv-score" :class="{ pass: !fails.length }"><ShieldCheck :size="24" /><b>{{ fails.length ? `${fails.length} 项` : '通过' }}</b></div><div><strong>{{ fails.length ? '镜头衔接需处理' : warnings.length ? '还有提示需要确认' : '已满足锁定条件' }}</strong><p>{{ fails.length }} 项阻断 · {{ warnings.length }} 项待确认</p></div></div>
+              <div class="pv-issue-filter"><button :class="{ active: allIssues }" @click="allIssues = true">全部 {{ issues.length }}</button><button :class="{ active: !allIssues }" @click="allIssues = false">当前镜头</button></div>
+              <div class="pv-issue-stack"><article v-for="issue in visibleIssues" :key="issue.id" class="pv-issue" :class="[issue.severity, { acknowledged: issue.reason }]"><button class="pv-issue-heading" @click="locateIssue(issue)"><span class="pv-status" :class="issue.reason ? 'pass' : issue.severity"><i />{{ issue.reason ? '已确认' : issue.severity === 'fail' ? '阻断' : '提示' }}</span><strong>{{ ruleNames[issue.rule] || issue.rule }}</strong><ArrowRight :size="13" /></button><p>{{ issue.message }}</p><small v-if="issue.reason">确认原因：{{ issue.reason }}</small><div class="pv-issue-actions"><button v-if="issue.rule === 'missing_frame'" :disabled="!editable" @click="run(() => planAndGenerate([issue.panelId!]))">添加并生成画面</button><button v-if="issue.severity === 'warning' && !issue.reason" :disabled="!editable" @click="waive(issue)">确认并记录原因</button><button @click="locateIssue(issue); inspector = 'properties'">修改属性</button></div></article><div v-if="!visibleIssues.length" class="pv-small-empty"><Check :size="26" /><strong>没有待处理问题</strong><p>可以继续预览或锁定当前版本。</p></div></div>
+              <div v-if="edge" class="pv-property-card"><p class="pv-eyebrow">当前连接 · 上一镜头 → 当前镜头</p><label>转场<select :value="edge.type" :disabled="!editable" @change="updateEdge('type', valueOf($event))"><option value="cut">直接切换</option><option value="match_cut">匹配切换</option><option value="occlusion">遮挡切换</option><option value="insert">插入镜头</option><option value="establishing">建立镜头</option><option value="audio_bridge">声音桥</option></select></label><label>连续性<select :value="edge.continuity" :disabled="!editable" @change="updateEdge('continuity', valueOf($event))"><option value="strong">强继承</option><option value="normal">常规继承</option><option value="scene_change">场景变化</option></select></label><label>允许变化的字段<input :value="edge.allowedChanges.join(',')" :disabled="!editable" placeholder="如 scene,lighting" @change="updateEdge('allowedChanges', valueOf($event).split(',').map(s => s.trim()).filter(Boolean))"></label></div>
+            </template>
+            <template v-else-if="inspector === 'properties' && group">
+              <div class="pv-form">
+                <template v-if="panel">
+                  <p class="pv-eyebrow">镜头属性</p>
+                  <label>标题<input :value="panel.title" :disabled="!editable" @change="updatePanel('title', valueOf($event))"></label>
+                  <div class="pv-form-pair">
+                    <label>时长 / 秒<input type="number" min=".1" step=".1" :value="panel.durationMs / 1000" :disabled="!editable" @change="setDuration(panel.id, Number(valueOf($event)) * 1000)"></label>
+                    <label>景别<input :value="panel.shotType" :disabled="!editable" @change="updatePanel('shotType', valueOf($event))"></label>
+                  </div>
+                  <div class="pv-form-pair">
+                    <label>机位<input :value="panel.angle" :disabled="!editable" @change="updatePanel('angle', valueOf($event))"></label>
+                    <label>运镜<input :value="panel.movement" :disabled="!editable" @change="updatePanel('movement', valueOf($event))"></label>
+                  </div>
+                  <label>画面描述<textarea :value="panel.description" :disabled="!editable" rows="4" @change="updatePanel('description', valueOf($event))" /></label>
+                  <label>氛围<textarea :value="panel.atmosphere" :disabled="!editable" rows="2" @change="updatePanel('atmosphere', valueOf($event))" /></label>
+                  <label>视频提示词<textarea :value="panel.videoPrompt" :disabled="!editable" rows="3" @change="updatePanel('videoPrompt', valueOf($event))" /></label>
+                </template>
+                <p class="pv-eyebrow">音轨</p><button v-for="clip in timeline.audio.filter(c => c.panelId === panel?.id || !c.panelId)" :key="clip.id" class="pv-audio-list-item" @click="showAudio(clip.id)">{{ clip.text || '音频片段' }} <small>{{ formatTime(clip.startMs) }}</small></button><button :disabled="!editable" @click="showAudio()"><Plus :size="13" />添加对白 / 旁白 / 声音</button>
+              </div>
+            </template>
+            <template v-else-if="inspector === 'tasks'">
+              <div class="pv-task-intro"><p class="pv-eyebrow">V{{ String(version.versionNo).padStart(2, '0') }} / 生成记录</p><p>已提交任务继续执行，取消仅停止尚未开始的任务。</p></div>
+              <article v-for="batch in batches" :key="batch.id" class="pv-batch"><header><b>{{ batch.type === 'image' ? '关键帧' : '视频' }} #{{ batch.id }}</b><span>{{ statusNames[batch.status] || batch.status }}</span></header><progress :value="batch.items.filter(i => i.status === 'completed').length" :max="batch.items.length" /><small>{{ batch.items.filter(i => i.status === 'completed').length }} / {{ batch.items.length }} 已完成</small><div class="pv-batch-actions"><button v-if="batch.items.some(i => i.status === 'failed')" :disabled="working || (batch.type === 'image' && !editable)" @click="run(() => batchAction(batch.id, 'retry'))">重试失败项</button><button v-if="batch.items.some(i => i.status === 'pending')" :disabled="working" @click="run(() => batchAction(batch.id, 'cancel'))">取消排队任务</button></div><details><summary>查看 {{ batch.items.length }} 个任务</summary><div v-for="item in batch.items" :key="item.id" class="pv-task-item"><b>{{ timeline.panels.find(p => p.id === item.panelId)?.title || groups.find(g => g.id === item.groupId)?.title }} {{ item.frameType ? frameNames[item.frameType] : '' }}</b><span>{{ statusNames[item.status] || item.status }}<small v-if="item.actualStrategy"> · {{ constraintNames[item.actualStrategy] }}</small></span><p v-if="item.error" class="pv-frame-error">{{ item.error }}</p><button v-if="item.status === 'failed'" :disabled="working || (batch.type === 'image' && !editable)" @click="run(() => batchAction(batch.id, 'retry', [item.id]))">重试此项</button><a v-if="item.status === 'completed' && (item.localPath || item.resultUrl)" :href="mediaUrl(item.localPath || item.resultUrl)" target="_blank" rel="noopener">查看生成结果 ↗</a></div></details></article><div v-if="!batches.length" class="pv-small-empty"><Film :size="27" /><p>还没有生成任务</p><span>生成关键帧后，进度会显示在这里。</span></div>
+            </template>
+          </div>
+        </aside>
+      </section>
+      <PrevisTimeline :timeline="timeline" :current-ms="currentMs" :group-id="group?.id || ''" :active-frame-id="activeFrameId" :video-preview="stageView === 'video'" :video-sources="videoSources" :editable="editable" @seek="player?.seek($event)" @select="select" @audio="showAudio" @duration="setDuration" @move-audio="moveAudio" />
+    </template>
+    <dialog ref="dialog" class="pv-dialog" @close="modal = ''" @click="($event.target === dialog) && (modal = '')">
+      <form v-if="modal" @submit.prevent>
+        <header><h2>{{ ({ strategy: '模型设置', video: '生成正式视频', audio: '编辑音轨', waiver: '确认连续性提示', lock: '锁定故事版', sync: '同步最新分镜', reload: '重新载入版本' } as Record<string, string>)[modal] }}</h2><button aria-label="关闭对话框" @click="modal = ''"><X :size="18" /></button></header>
+        <div v-if="modal === 'strategy'" class="pv-form">
+          <label>图片模型<select v-model="imageModel"><option value="" disabled>选择图片模型</option><option v-for="o in modelOptions('image')" :key="o.key" :value="o.key">{{ o.label }}</option></select></label>
+          <label>视频模型<select v-model="videoModel"><option value="" disabled>选择视频模型</option><option v-for="o in modelOptions('video')" :key="o.key" :value="o.key">{{ o.label }}</option></select></label>
+          <label>视频生成模式<div class="seg pv-dialog-mode"><button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'direct' }" @click="videoGenerationMode = 'direct'">直接生成</button><button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'storyboard_frames' }" @click="videoGenerationMode = 'storyboard_frames'">依赖分镜画面</button></div></label>
+          <NuxtLink v-if="!modelOptions('image').length || !modelOptions('video').length" to="/settings">前往设置启用生成模型 →</NuxtLink>
+          <p v-if="videoCapability" class="pv-help">当前视频服务支持 {{ videoCapability.minSeconds }}–{{ videoCapability.maxSeconds }} 整数秒、每个镜头最多 {{ videoCapability.maxImages }} 张分镜画面。视频始终按单镜头生成。</p>
+          <footer><button class="btn btn-primary" @click="modal = ''">完成</button></footer>
+        </div>
+        <div v-else-if="modal === 'audio' && audioDraft" class="pv-form"><div class="pv-form-pair"><label>类型<select v-model="audioDraft.type" :disabled="!editable"><option value="dialogue">对白</option><option value="narration">旁白</option><option value="sound">环境声 / 音乐</option></select></label><label>角色<input v-model="audioDraft.character" :disabled="!editable"></label></div><label>关联分镜<select v-model="audioDraft.panelId" :disabled="!editable"><option :value="null">跨镜头音轨</option><option v-for="p in timeline?.panels" :key="p.id" :value="p.id">{{ p.title }}</option></select></label><label>文本<textarea v-model="audioDraft.text" :disabled="!editable" rows="3" /></label><div class="pv-form-pair"><label>起点 / 秒<input type="number" min="0" step=".1" :value="audioDraft.startMs / 1000" :disabled="!editable" @change="audioDraft.startMs = Math.max(0, Math.round(Number(valueOf($event)) * 1000))"></label><label>时长 / 秒<input type="number" min=".1" step=".1" :value="audioDraft.durationMs / 1000" :disabled="!editable" @change="audioDraft.durationMs = Math.max(100, Math.round(Number(valueOf($event)) * 1000))"></label></div><label>音频地址<input v-model="audioDraft.url" :disabled="!editable" placeholder="上传音频或填写 https:// 地址"></label><label class="pv-upload" :class="{ disabled: !editable || uploading }"><Upload :size="14" />{{ uploading ? '上传中…' : '上传配音 / 音效' }}<input type="file" accept="audio/*" :disabled="!editable || uploading" @change="run(() => uploadAudio($event))"></label><audio v-if="audioDraft.url" :src="mediaUrl(audioDraft.url)" controls /><p class="pv-help">未上传音频时，可在播放器开启浏览器临时配音。对白超出所属分镜会阻止锁定。</p><footer><button class="btn btn-danger" :disabled="!editable" @click="saveAudio(true)">删除片段</button><button class="btn btn-primary" :disabled="!editable || uploading" @click="saveAudio()">保存音轨</button></footer></div>
+        <div v-else-if="modal === 'waiver'" class="pv-form"><p>{{ waiverIssue?.message }}</p><label>确认原因<textarea v-model="waiverReason" rows="4" maxlength="2000" placeholder="说明这是有意的叙事变化，或已人工确认…" autofocus /></label><footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="!waiverReason.trim() || !editable" @click="applyWaiver">记录并确认</button></footer></div>
+        <div v-else-if="modal === 'video'" class="pv-form">
+          <p>将使用当前工作版 V{{ version?.versionNo }} 生成{{ videoPanelIds.length ? '当前镜头' : '全部镜头' }}。</p>
+          <label>生成模式<div class="seg pv-dialog-mode"><button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'direct' }" @click="videoGenerationMode = 'direct'">直接生成</button><button type="button" class="seg-item" :class="{ on: videoGenerationMode === 'storyboard_frames' }" @click="videoGenerationMode = 'storyboard_frames'">依赖分镜画面</button></div></label>
+          <label>视频模型<select v-model="videoModel"><option value="" disabled>选择模型</option><option v-for="o in modelOptions('video')" :key="o.key" :value="o.key">{{ o.label }}</option></select></label>
+          <p class="pv-help">{{ videoGenerationMode === 'direct' ? '使用视频提示词与已绑定素材直接生成，不依赖分镜画面。' : '全部分镜画面将按时间顺序作为视频参考。' }}</p>
+          <p v-if="videoUsesStoryboardFrames && incompleteVideoPanels.length" class="pv-frame-error">还有 {{ incompleteVideoPanels.length }} 个镜头存在未完成画面，请先生成或上传全部画面。</p>
+          <footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="working || !videoModel || (videoUsesStoryboardFrames && !!incompleteVideoPanels.length)" @click="run(startVideo)"><Film :size="14" />提交生成</button></footer>
+        </div>
+        <div v-else class="pv-form"><p>{{ ({ lock: '锁定后时间线和分镜画面不可修改；后续编辑需复制为新草稿。', sync: '读取视频制作中的最新分镜并建立新草稿，当前版本将保留。', reload: '载入远端最新版本。尚未保存的本地修改将被替换，建议先下载本地草稿。' } as Record<string, string>)[modal] }}</p><footer><button class="btn" @click="modal = ''">取消</button><button class="btn btn-primary" :disabled="working" @click="run(async () => { if (modal === 'lock') await check(true); else if (modal === 'sync') await create(); else if (modal === 'reload') { dirty = false; await open(version!.id) } modal = '' })">确认{{ modal === 'lock' ? '锁定' : modal === 'sync' ? '同步' : '' }}</button></footer></div>
+      </form>
+    </dialog>
+      </main>
+    </div>
+  </div>
+</template>
diff --git a/frontend/nuxt.config.ts b/frontend/nuxt.config.ts
index 0da53ab..ba9a369 100644
--- a/frontend/nuxt.config.ts
+++ b/frontend/nuxt.config.ts
@@ -22,6 +22,11 @@ export default defineNuxtConfig({
           path: '/drama/:id/episode/:episodeNumber',
           file: fileURLToPath(new URL('./app/views/drama/episode.vue', import.meta.url)),
         },
+        {
+          name: 'drama-previs',
+          path: '/drama/:id/episode/:episodeNumber/previs',
+          file: fileURLToPath(new URL('./app/views/drama/previs.vue', import.meta.url)),
+        },
       )
     },
   },
````
