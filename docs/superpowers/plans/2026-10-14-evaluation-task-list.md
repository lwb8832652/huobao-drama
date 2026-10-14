# 评测任务列表 Implementation Plan

> **For agentic workers:** 执行本次会话的任务并分别验证；后端筛选可独立委派，最终进行规格和质量复核。

**Goal:** 评测默认呈现通用任务列表，点击任务查看类型专用详情，保留安全的评分和生成前确认流程。

**Architecture:** EvaluationTaskList.vue 是通用列表；ContinuityReviewDetail.vue 为连续性详情；ContinuityReviewPanel.vue 编排请求、列表/详情/新建/设置视图及原生成确认。现有服务添加服务端筛选与全局计数。

**Tech Stack:** Vue 3 / Nuxt 3 / TypeScript / Hono / SQLite / node:test / Playwright。

## Task 1：历史任务查询

- [ ] 在 backend/tests/storyboard-continuity-review-worker.test.ts 添加 RED：status=active/completed/failed 与 keyword 全量筛选先于分页，summary 全局计数不会被当前过滤改变，未知参数值返回 400。
- [ ] 在 backend/src/services/continuity-review.ts 扩展 schema：`status: z.enum(['all', 'active', 'completed', 'failed']).default('all')`、`keyword: z.string().trim().max(200).default('')`。冻结输入标题、model、id 组成 searchable 字符串；过滤后计算 total、分页。新增 summary `{ total, active, completed, failed }`，保留 activeCount/lowScore 旧语义。
- [ ] 在 backend/src/routes/previs.ts 传入这两个可选参数。
- [ ] 运行 `node_modules/.bin/tsx --test tests/storyboard-continuity-review-worker.test.ts`、`npm run typecheck`，确认 GREEN。

## Task 2：通用行列表和连续性详情

- [ ] 前端类型添加 `EvaluationListItem`（key/typeLabel/title/status/summary/meta/preview/score/current/attention）和可选 summary。
- [ ] 前端测试增加点击前无详情、选择记录不折叠详情、返回保留页码、搜索/筛选回到第一页、过期记录不触发重试，运行查看 RED。
- [ ] 创建 frontend/app/components/previs/EvaluationTaskList.vue：标准任务行、状态标签、全局指标、服务器筛选、搜索、分页、加载/空/错误反馈，发出 select/filter/search/page/refresh/create 事件。
- [ ] 创建 frontend/app/components/previs/ContinuityReviewDetail.vue：记录被冻结的 images、评分、维度、问题/建议、无结果/失败/过期状态；专用 emit retry。
- [ ] 原编排组件维持 props 和 expose API，数据转换为 `EvaluationListItem[]`；新增 view=`tasks|detail|create|settings`。仅 selectTask 才切 detail；back 恢复列表，不自动选中。查询 token 排除旧请求，不因为刷新丢失同一 id 详情。
- [ ] 运行 `node --test tests/continuity-review-panel.test.mjs`，确认旧确认测试与新交互测试通过。

## Task 3：发起评测和设置

- [ ] 在 create 视图列出当前边界，模型/缺图/执行中/查询异常禁用，显式操作先 save 再 POST，busy 防重入、版本上下文不混用。
- [ ] settings 视图有开关与阈值表单，PUT 保存反馈；刷新 GET 不覆盖尚未保存的设置草稿。
- [ ] loading/错误与状态准确；focus trap 查找可见焦点节点、详情进入与返回焦点、背景滚动锁、Esc 与 native confirmation dialog 不冲突；卸载恢复。
- [ ] 运行前端测试、服务端受影响测试、`npm run generate`；现有大页面保持共用入口。

## Task 4：页面验证与交付

- [ ] Playwright 浏览器使用本地构建与拦截评测 API：验证两页入口、列表/详情/返回、图片四维评分、搜索/筛选/分页、刷新竞态、创建显式 POST 防重入、阈值/开关 PUT、当前/过期/缺图/失败、Esc/focus、宽窄屏和主题；GET 浏览不会产生 POST。
- [ ] 保存截图与验证报告，检查 `git diff --check`，请求最终规格和质量复核并修复问题。
- [ ] 验证通过后提交改动、快进整合到本地 dev，刷新当前 5682 测试运行时并验证最新代码。此次不自动推送远程。
