# 分镜画面交互简化实施计划

> 使用 subagent-driven-development 分派前端实现，先规范审查再质量审查；测试遵循 test-driven-development，完成使用 verification-before-completion。

**Goal:** 合并整组生成和画面面板，点格直接微调；规划、生成参数、历史逐级展开。

**Architecture:** 两页保留 StoryboardGridTools 与 StoryboardFramesEditor 的业务边界，通过共享模式、插槽/紧凑工具栏以及受控 frameId 方法组合为单一区域；FrameSettingsDialog 在 grid workflow 中承担画面详情与规划，复用后端候选与 usePrevis 采用 lease。

**Tech Stack:** Vue/Nuxt、TypeScript、node:test/Vue compiler harness、Playwright。

## Task 1: 前端交互整体实现

Files: frontend/app/components/previs/StoryboardGridTools.vue、StoryboardFramesEditor.vue、FrameSettingsDialog.vue、StoryboardContactSheet.vue（若点格标签需要调整）、frontend/app/views/drama/episode.vue、previs.vue；新增组件限清晰单一职责。相关 tests/storyboard-grid-interactions.test.mjs、frame-planning-interactions.test.mjs、storyboard-contact-sheet.test.mjs。

- [ ] 用 Vue harness 写失败行为测试：按 frameId 两种微调一次请求；规划保存不生成；无图/锁定 guard；候选历史默认收起、工作区采用和长任务取消继续有效。
- [ ] 单个工具栏整合当前宫格，隐藏重复旧逐张按钮和副标题；生成参数与采用历史移入更多/记录。主按钮按帧数量和就绪状态变化。
- [ ] 点格画面详情：原图与修改要求，两种模式，提交直接调用候选API；历史收起可免费恢复；规划次级表单与保存后的图片过期提示；参考资产统一在分镜层。
- [ ] 两页统一 wiring，保留父 adopted lease、id/context/stale/lock guards；添加帧从规划态进入；普通网格模式不会使用旧逐张 generate event。
- [ ] 运行 node --test tests/storyboard-grid-interactions.test.mjs tests/frame-planning-interactions.test.mjs tests/storyboard-frame-contract.test.mjs tests/storyboard-contact-sheet.test.mjs，运行 npm run generate，git diff --check。

## Task 2: 审查与交互验证

- [ ] 规范审查并修复，再独立质量审查；不在共享 node_modules 运行 pnpm/npx/install。
- [ ] root 用独立SQLite与本地图片mock跑两页浏览器，检查当前图可见、两种微调/多格/候选/历史/规划/状态、窄屏深色；检查POST次数与未选择原图保护。
- [ ] 记录报告与截图，提交前端变更，快进到本地dev，服务从主目录运行，归档隔离工作区。不要推送远程。
