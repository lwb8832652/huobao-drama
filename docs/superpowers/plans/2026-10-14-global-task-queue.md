# Global Task Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 制作任务与评测分别配置，所有已约定后台任务受跨项目持久化总并发、分类并发和可选配额组约束。

**Architecture:** 增加 task_queue_jobs 调度表，保留各业务表；同步 SQLite 事务领取名额，业务执行器在事务外执行。设置分为任务与评测两份，前端分别保存。执行状态保留上游提交、恢复与不确定请求信息，防止重复付费。

**Tech Stack:** TypeScript、Hono、Drizzle/better-sqlite3、Vue/Nuxt、node:test、Playwright。

## 共享契约

新增 `backend/src/services/task-queue.ts` 与 `task-queue-settings.ts`。执行器依赖前者，不能反向依赖其他业务服务。

```ts
type QueueKind = 'image' | 'video' | 'evaluation' | 'planning' | 'local'
type QueueOwner = 'sys_task' | 'continuity_review' | 'frame_plan' | 'contact_sheet' | 'video_merge'
type QueueOutcome = { status: 'completed' | 'failed' | 'needs_confirmation'; error?: string }
enqueueQueueJob({ ownerType, ownerId, kind, projectId, configId, inputHash, snapshotJson, source }): number
registerQueueExecutor(ownerType, { execute: async job => outcome, recover: async job => outcome, onCancel: job => void }): void
tickTaskQueue(): Promise<void> // 领取并启动可执行项，不等待长时模型任务完成
startTaskQueueWorker(): Promise<() => void>
getQueueJob(ownerType, ownerId): QueueJob | undefined
updateQueueJob(queueJobId, { phase, submitted, externalTaskId, upstreamDone, error }): void
cancelQueueJob(queueJobId): QueueJob // 仅取消尚未提交项，回调同步写业务状态
retryQueueJob(queueJobId): QueueJob // 仅终态失败，可复用业务记录
```

制作设置 API 数据：`{ revision, total, image, video, planning, local, paused, quotaGroups, stats }`，quotaGroups 为 `{ id, name, limit, configIds }[]`。评测设置 API 数据：`{ revision, concurrency, paused, enabled, threshold, globalTotal, stats }`。PUT 使用各自可编辑字段与 revision，严格拒绝跨面板字段。stats 统一包含全局 `active, pending` 以及 `byKind[kind]: { active, pending }`；评测面板另显示自身计数，明确数据作用范围。

## Task 1：持久化调度核心和独立设置

Files: `backend/src/db/schema.ts`, `backend/src/db/sqlite-schema.ts`, 新建 `backend/src/db/task-queue-schema.ts`, `backend/src/services/task-queue.ts`, `task-queue-settings.ts`, `backend/src/routes/settings.ts`, 新建 `backend/tests/task-queue.test.ts`。

- [x] 先写真实 SQLite 行为测试：超过总量或类别上限不领取；暂停制作不阻塞评测；队头视频堵塞不阻塞图片；不同项目公平轮转；同一账号组多个配置共享限制；两个面板独立保存。
- [x] 运行 `node_modules/.bin/tsx --test tests/task-queue.test.ts`，确认断言因未实现功能失败。
- [x] 建立唯一 `(owner_type, owner_id)` 关联，写事务中查配额、领取并更新轮转游标；父记录不注册。execute Promise 完成后按 outcome 释放，needs_confirmation 保持 processing 占位；上游结束可独立释放配额。
- [x] 保存不同 app_settings 键和修订号，原连续性设置兼容同一真实存储；暂停、取消、重试、人工核对接口明确状态和作用范围。
- [x] 重启：未提交重排，已外部编号调用 recover，不确定付费请求保持占位。禁止仅因租约过期重发。
- [x] 运行核心测试与 `npm run typecheck`，提交该任务。

核心领取示例与设置测试断言：

```ts
assert.equal(readSettings().total, 6)
await tickTaskQueue()
assert.equal(activeJobs().length, 2)
assert.equal(getQueueJob('sys_task', waitingId)?.status, 'pending')
assert.equal(readEvaluationSettings().concurrency, 1)
assert.equal(readSettings().revision, productionRevision)
```

## Task 2：图片、视频、批次与宫格接入

Files: `backend/src/services/generation.ts`, `previs-batch.ts`, `previs-grid.ts`, `backend/src/routes/tasks.ts`, `backend/src/index.ts`, 新建 `backend/tests/generation-task-queue.test.ts`。

- [x] 先用可控本地图片/异步视频服务验证所有普通任务先 pending、不同配置也共享类别名额、POST 返回编号后视频仍占位，以及取消未提交不调用上游。
- [x] 保存有效 configId 和配置 hash；所有 generateImage/generateVideo 创建业务记录并同步注册，普通请求即时返回；预演 worker 只创建子任务，调用统一 tick，不再独立计数。
- [x] 在付费 fetch 前持久化 submitted；响应外部编号同步入业务和队列表；processTask 必须 await pollTask。失败或保存结果失败按已知状态返回 outcome，网络结果不明保守占位。
- [x] 启动时注册所有 executor，统一恢复后启动调度，删除旧普通任务统一 failed 的启动逻辑。活跃任务禁止 DELETE，取消使用显式接口。
- [x] 运行新测试和既有 grid-scheduling/video-reference/video-continuity/batch 测试；提交。

```ts
const ids = await Promise.all([generateImage(request), generateImage(request)])
assert.equal(ids.length, 2)
await tickTaskQueue()
assert.equal(upstreamCalls, 1)
assert.equal(secondTask().status, 'pending')
```

## Task 3：评测与 AI 规划接入

Files: `backend/src/services/continuity-review.ts`, `previs-frames.ts`, `backend/src/routes/previs.ts`, 相应 worker 测试与新增 `backend/tests/evaluation-task-queue.test.ts`。

- [x] 验证手动评测 HTTP 不等待模型、相同输入去重、自动/手动共同受限、自动关闭取消尚未领取项但保留手动项；规划和评测同时受总上限。
- [x] 新增 enqueueContinuityReview，冻结输入/config/model，并注册评测 executor；原评分算法保留。手动 POST 返回 queued 记录；查询详情继续走旧业务编号。
- [x] 自动任务创建时用 source automatic；设置关闭回调只取消该来源 pending。更新原评测设置入口只修改 enabled/threshold，保留并发和独立修订逻辑。
- [x] AI 规划去掉 mapLimit 固定 4 与过期自动重发；提交边界、快照 hash、过期结果保护与规则草案回退保留，执行 Promise outcome 接入统一调度。
- [x] 更新变化后的异步契约测试并运行规划/评测回归；提交。

```ts
const response = await app.request('/animatic-versions/1/continuity-reviews', submitOptions)
assert.equal(response.status, 201)
assert.equal((await response.json()).data.status, 'pending')
assert.equal(providerFinished, false)
```

## Task 4：本地合成与拼接接入

Files: `backend/src/services/previs-contact-sheets.ts`, `ffmpeg-merge.ts`, `backend/src/routes/merge.ts`, 新建 `backend/tests/local-task-queue.test.ts`。

- [x] 验证本地任务受 local 与 total 双重限制，重启后安全重跑本地处理不触发模型；父宫格不占重复名额。
- [x] 合成与拼接创建 pending 关联，注册本地 executor，去掉直接 doMerge 启动；结果写盘、业务发布与错误保持原有语义。
- [x] 运行 contact-sheet 缓存/渲染与拼接相关测试；提交。

## Task 5：两个独立设置面板和列表队列交互

Files: 新建 `frontend/app/components/TaskQueueSettings.vue`, `frontend/app/composables/useTaskQueueSettings.ts`, `frontend/app/views/drama/episode.vue`, `frontend/app/components/previs/ContinuityReviewPanel.vue`, `frontend/app/types/previs.ts`, `frontend/app/components/previs/EvaluationTaskList.vue`, `frontend/app/assets/studio.css`，必要 API 和翻译文件。

- [x] 用实际 Vue 组件测试或浏览器 mock 验证任务设置不编辑评测、评测不编辑制作；修订冲突保留草稿；保存刷新显示结果。
- [x] 两个面板各自完整表单，可复用数字输入样式，不能共用一份可编辑设置对象；评测只读总上限并保留自动开关/阈值。
- [x] 任务抽屉与预演任务入口添加相同设置图标；三个状态胶囊可筛选并重复取消。每行区分排队/执行/确认中，取消仅合法任务可操作，活动任务不显示删除。
- [x] 手动评测提交成功提示已加入队列，pending/processing 自动查询；加载不触发模型。设置焦点、Esc 与返回保留原抽屉行为。
- [x] 运行前端相关测试、`npm run build`；提交。

## Task 6：集成、浏览器验证与交付

- [x] 完整 backend TS 测试与 typecheck；前端相关测试和生产构建。已有前端结构测试及拼接结构测试失败单独记录，不混入新功能结果。
- [x] 在隔离数据和本地模拟模型中验证：任务设置、评测设置、跨项目队列限制、自动继续、暂停独立、取消、失败重试、刷新、重启、移动布局。
- [x] 对照设计逐条检查所有本次入口，进行需求与质量复查，修复发现的缺口再运行对应验证。
- [x] 记录真实通过证据到设计/验证文档。合入本地 dev，更新 localhost:5682 用于用户查看，不自动推送远程。
