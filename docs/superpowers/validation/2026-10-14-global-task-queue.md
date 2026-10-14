# 全局任务队列验证记录

日期：2026-10-14。基线：dev / 26ae26a。两套设置和保存操作独立；后台任务总上限覆盖制作与评测，按项目和类别轮转。

## 实现范围

普通图片与视频、宫格生成和微调、单格精修、批次子任务、AI 画面规划、连续性评测、宫格本地合成、FFmpeg 拼接均接入持久队列。父批次不重复占位。默认总并发 6、图片 2、视频 2、评测 1、规划 1、本地处理 1。

提交前冻结配置与参考输入，业务记录和队列关联在事务内创建；尚未关联或尚未冻结的任务等待前置准备。执行器在数据库事务外工作。已取得外部编号只恢复查询；结果已保存的本地修复不会重新提交模型。结果不确定时保持占位，人工核对后才释放。明确的 HTTP 429 最多自动重试两次，遵守 Retry-After；HTTP 408、5xx 和未知网络结果不自动重发付费请求。

制作和评测各有独立修订号；跨面板字段拒绝保存。下调上限保留当前执行任务，暂停只限制尚未领取项。关闭自动评测取消自动排队项，保留手动和执行中任务。活跃任务不能删除。

## 自动验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 后端所有 TypeScript 测试 | backend: `node_modules/.bin/tsx --test tests/*.test.ts` | 175 / 175 通过 |
| 后端类型检查 | backend: `npm run typecheck` | 通过 |
| 前端相关行为测试 | frontend: `node --test tests/task-queue-settings.test.mjs tests/continuity-review-panel.test.mjs tests/frame-planning-interactions.test.mjs tests/storyboard-grid-interactions.test.mjs` | 110 / 110 通过 |
| 前端生产构建与静态页面 | frontend: `npm run generate` | 通过，包含 index.html |
| 前端全量测试 | frontend: `node --test tests/*.test.mjs` | 176 项，151 通过，25 项既有失败 |
| 拼接结构测试 | backend: `node --test tests/merge-direct-video-structure.test.mjs` | 2 项，1 通过，1 项既有失败 |
| 补丁格式 | `git diff --check` | 通过 |

后端行为测试覆盖跨项目总并发、分类限制、配置配额共享、轮转公平性、队头阻塞、独立暂停、修订冲突、取消、已提交占位、付费结果本地修复、旧任务迁移、准备阶段崩溃恢复、已知外部编号恢复查询、启动迁移完成前禁止领取，以及真实 FFmpeg 拼接和素材变化检测。

前端 25 项失败与干净基线相同，涉及旧路径和现行界面结构：apple-light-theme、asset-library、button-system、episode-create-dialog、model-selection、official-provider-settings、professional-redesign、project-launcher、remove-audio、remove-grid、style-preset、video-direct-generation-config。拼接结构测试仍要求已移除的 `readyVideos.length !== storyboards.length` 字符串，在修改前后均失败。本次使用真实输出验证部分镜头拼接行为，不修改这些既有断言。

## 浏览器与运行时联调

Chrome / Playwright，隔离数据库；实际后端 localhost:5683，模拟图片模型 localhost:5693。图片模型请求仅发往本地模拟服务。实际执行计数验证最大同时请求数为 1。

- 两套设置分别保存，另一套字段保持原值；实际后端旧修订号返回 HTTP 409。
- 暂停制作后提交三项：均排队、模型请求为零。页面取消一项，业务与队列同步取消。
- 页面恢复制作队列后，剩余两项自动逐项执行；已取消项没有调用模型。
- 模拟明确失败后，从任务行重试同一记录并完成，名额释放。
- 刷新保留设置与任务状态。
- 手动评测 HTTP 201 返回 pending 和共享任务编号，同输入去重；暂停期间不调用模型，取消可查询。
- 重启后 pending 和暂停设置保留，恢复仅调用模拟模型一次。

独立页面 mock 验证 9 项：保存作用范围、配额组配置、两个面板的草稿与 409 冲突、三胶囊重复取消筛选、Esc/Tab/焦点、390px、浅色/深色主题、下调上限提示、查询不发起模型 POST。无页面异常。另有 4 项取消状态行为测试，保证图片、视频与拼接轮询结束并释放页面忙碌状态。

联调发现并修复按剧集聚合接口缺少队列字段的问题；新行为测试覆盖任务抽屉真正使用的图片、视频和拼接查询接口。

报告和截图：`/private/tmp/huobao-queue-validation/`；自动验证日志：`/private/tmp/huobao-queue-*complete.log`。该目录仅为本机验证资料。
