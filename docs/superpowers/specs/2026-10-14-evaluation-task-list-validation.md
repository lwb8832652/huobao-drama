# 评测任务列表验证记录

日期：2026-10-14；基线：dev/ad9bb3c。

## 交付行为

评测默认打开通用任务列表，点击记录才进入连续性详情。列表支持全量搜索、状态筛选、分页与自动更新；全局状态计数独立于筛选。详情独立按任务编号读取，展示冻结画面和结果，返回时保留位置；重新评测保留原查询与选择，新建成功返回列表。

发起评测与共享设置分开，缺图、在途任务、查询失败和历史记录有明确状态。列表展示契约不依赖连续性评分结构，未来类型可以复用列表并添加专用详情。本次仅接入连续性评测。

## 自动化检查

- 前端受影响测试：`node --test tests/continuity-review-panel.test.mjs tests/storyboard-continuity-ui.test.mjs tests/storyboard-grid-interactions.test.mjs tests/frame-planning-interactions.test.mjs`，97/97 通过。
- 后端查询、详情、工作线程与旧契约测试：`node_modules/.bin/tsx --test tests/storyboard-continuity-review-worker.test.ts`，14/14 通过。
- 后端 `npm run typecheck` 通过；前端 `npm run generate` 通过；`git diff --check` 通过。
- 新增交互回归先确认失败再修复，包括新建返回列表、旧详情请求不重置新列表分页、详情重试保留页码和筛选、保存同一版本新修订后保留详情、评测完成导致筛选缩页时保留详情、缺图旧任务不能再次提交。

## 浏览器检查

Google Chrome / Playwright 验证视频制作与预演两个入口，共 16 项检查通过，无页面异常。宽屏 1507×956、手机 390×844，覆盖列表、详情、返回、跨页、状态筛选、搜索、空状态、失败、缺图、历史记录、深色主题、设置保存、单次创建、查询竞态、缺图旧完成记录、读屏任务状态、离线保留结果、Esc 与焦点循环。

浏览器加载本次构建，评测 API 使用拦截数据验证，其他项目接口只读；设置和评分请求只写入测试内存。没有调用真实付费模型，也没有修改真实项目。后端路由和查询独立由 SQLite 测试验证；浏览器结果不代表对某个真实模型的评分质量验证。

截图与浏览器报告保存在：`/Users/liuwenbo/.codex/visualizations/2026/10/10/01a1260c-21a7-7292-901c-52c33ae85c5f/evaluation-redesign/`。主要文件：`task-list.png`、`task-detail.png`、`mobile-task-list.png`、`mobile-task-detail.png`、`settings.png`、`dark-task-list.png`、`dark-task-detail.png`、`browser-report.json`。

## 已有测试限制

额外运行 `tests/video-direct-generation-config.test.mjs` 时发现已有的 Wan 3.0 快捷预设命名空间断言失败。原始 dev/ad9bb3c 上单独复现，2 项通过、1 项失败，与本次评测改动无关，未修改该预设。

历史列表沿用原查询方式，先读取记录再过滤分页。任务量很大时可另行改为 SQL 聚合和分页；本次避免改变任务执行与评分算法。

## 复核

规格复核通过。最终代码质量复核通过，三项重要问题和一项读屏名称问题均已修复并验证。
