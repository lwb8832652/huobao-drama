# 联合宫格生图实施计划

> 执行使用 subagent-driven-development；核心行为使用 test-driven-development，完成前使用 verification-before-completion。

**Goal:** 单个分镜一次生成连贯宫格，支持整图指定格微调与切分后单格精修；候选确认后才更新目标格。

**Architecture:** 独立 paid grid candidate 记录冻结规划、输入字节、目标格和布局，复用 sys_task 提交/恢复。Sharp 本地切格与选择性合并；当前原始帧继续作为派生宫格、视频参考的真值。主工作台和预演页共享同一组件。

**Tech Stack:** TypeScript、Hono、Drizzle/SQLite、Sharp、Nuxt/Vue、node:test、Playwright。

## Task 1: 图片能力与连贯规划

- [x] 在 backend/src/services/adapters 的实际请求构造中修复火山/Gemini 丢失图片输入，并声明编辑/图片数/尺寸能力；自定义工作流只有实发参考字段才开放。
- [x] 新增 backend/src/services/previs-grid-capabilities.ts：按 provider/model/settings 预检，拒绝无图编辑和超限，选择受支持尺寸。
- [x] 更新 backend/src/services/previs-frames.ts、backend/src/agents/tools/frame-splitter-tools.ts、backend/src/agents/index.ts 与 workspace frame_splitter 提示词/技能：共同约束、静态状态、前后衔接、既有切镜；不强制改变景别。
- [x] 请求构造与规划行为测试先失败，再实现；保持旧计划兼容。

## Task 2: 宫格几何与候选领域

- [x] 新增 backend/src/services/previs-grid-domain.ts 与 previs-grid-images.ts：1/2/3 方形行列、有效 ID 映射、真实尺寸切分、比例校验、只合并选择格、最新帧重组。
- [x] 新增 tests/storyboard-grid-images.test.ts（含领域几何）；覆盖 1～9、余格、横竖比例、模型修改全部格但只保留选中格，以及不累积裁边。
- [x] 扩展 Keyframe/history 与 timelineSchema，保留规划与图片来源字段；未选择帧保持完全不变。

## Task 3: 持久任务与采用

- [x] 新增 backend/src/db/previs-grid-schema.ts 与候选服务 previs-grid.ts，接入建表/启动恢复。
- [x] POST 多分镜请求全部预检和冻结后才入队；单分镜正常任务只调用 generateImage 一次；相同在途输入复用，冲突拒绝。
- [x] GET 仅查询；显式取消、重试/重新提交、上传替换、采用。sys_task 丢失提交状态禁止自动二次付费；完成结果解码校验与本地处理可安全重试。
- [x] 三种模式 generate/grid_edit/frame_edit；整图可对未采用候选编辑，单格输入当前原图，整图输入重组最新原图。
- [x] 采用临时产物后再次校验 revision、帧内容、锁定、所有图片摘要；一个事务更新时间线/来源/候选状态，接续派生宫格合成与现有视频快照。
- [x] backend/src/routes/previs.ts 添加 /animatic-versions/:id/grid-candidates API；集成测试覆盖请求次数、重复读取、失败、取消、原图保护、锁定/版本冲突、两种微调交替与回退。

## Task 4: 共享交互与两个页面

- [x] app/composables/usePrevis.ts 加入候选类型及 API；新增 StoryboardGridTools.vue，整组生成、多格选择/各格指令、单格精修、候选对比/切分采用、上传、失败状态。
- [x] main episode.vue 与 standalone previs.vue 接入共用组件并刷新 adopted 版本；保留原编辑卡片、历史与已有视频配置。
- [x] 展示生图布局与单格实际像素，空格不能选择，关闭或放弃候选不改当前帧；支持暗色与窄屏。

## Task 5: 审查与浏览器验证

- [x] 后端 typecheck、相关回归、前端 generate；规范审查通过后代码质量审查。
- [x] 独立测试数据库与本地图片模型 mock，浏览器验证主/预演页：生成宫格、采用、多格编辑、单格编辑、交替编辑、历史回退、采用锁；版本冲突、失败与取消通过隔离后端集成测试补充验证。
- [x] 记录截图和实际 API 提交数，确认图片真的传输；不自动调用付费模型。真实视觉连续性/费用作为待真人样本验证限制报告。
- [x] 提交可审阅变更并整合回本地 dev，打开验证页面。未请求本轮远程推送。
