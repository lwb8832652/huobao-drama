# 分镜画面交互简化验证

本次仅调整前端交互：整组生成、整图定格微调、单格精修仍复用原有候选 API。两个工作区共用同一个分镜画面区域，当前宫格紧接工具栏，生成记录通过更多打开；画面详情中的图片微调、画面规划及历史恢复分别提交。

## 自动化验证

运行 `node --test tests/storyboard-grid-interactions.test.mjs tests/frame-planning-interactions.test.mjs tests/storyboard-frame-contract.test.mjs tests/storyboard-contact-sheet.test.mjs`，覆盖旧流程和新交互。新增测试先复现失败再实现，包括单格两种模式精确 frameId/指令/一次提交、保存规划不生图、历史恢复保留来源与原规划、锁定与缺图阻止、关闭详情保持概览、分辨率记忆及能力过滤。

规范审查发现保存等待期间可能改变锁定/图片/能力/权限，提交前缺少复核，已修复。新增回归在 `beforeAction` 等待期间修改这些状态，保证零 POST；正常保存临时占用工作区后恢复权限时，仍按冻结的目标和指令只提交一次。

最终 77/77 项相关测试通过，`npm run generate` 成功，`git diff --check` 无问题。规范复审及独立质量审查通过，未发现未解决的重要问题。

## 浏览器验证

在 Chrome 中验证视频制作页 `/drama/1/episode/1?stage=videos` 和独立预演页 `/drama/1/episode/1/previs`。使用复制的 SQLite 数据库、复制素材和本地图片模型接口，服务为 `localhost:5682`，模型为 `127.0.0.1:5684`，没有调用外部付费图片模型，也没有写入原项目数据库。

通过 10 项流程检查：统一画面区及默认收起记录、重新生成后人工采用、点击第二格直接整图微调、点击第四格单张精修、多格微调保留已有精修、仅保存规划、分辨率刷新后记忆、独立页精修、丢弃候选、请求数检查。每次完整运行 6 次显式生成对应 6 次实际图片请求；未选格的完整帧数据保持不变，保存规划、查看记录、刷新、切分、采用及丢弃不增加调用。

通过 3 项边界检查：历史恢复 URL/taskId/source 且不保存未确认规划（零调用）；采用请求延迟时关闭窗口，父工作区写锁持续到响应完成；760px 深色模式详情及 2×2 多格选择可操作（零调用）。通过长任务取消检查，工作区轮询进入 busy 后仍可取消，迟到结果不会覆盖当前图，只有初始的 1 次图片请求。

视觉检查发现独立预演窄侧栏把标题挤成竖排，已改为按组件宽度自适应。通过 3 项布局复查：主工作台工具栏与宫格一起可见、独立页标题与按钮分两行、更多弹层保持在窄面板内（零调用）。

本地模拟图用于验证输入、切分、请求数与交互，不代表真实图片模型的画质或人物一致性。真实画质需使用配置模型另行评估。

## 产物

报告与截图保存在 `/Users/liuwenbo/.codex/visualizations/2026/10/10/01a1260c-21a7-7292-901c-52c33ae85c5f/storyboard-simple-interaction/`：

- `workflow-report.json`：10 项核心流程与 6 次图片请求。
- `edges-report.json`：3 项边界检查，无模型请求。
- `cancel-report.json`：长任务取消，仅初始 1 次请求。
- `layout-report.json`：3 项布局检查，无模型请求。
- `workbench-overview.png`、`standalone-overview.png`：统一宫格区域。
- `frame-details.png`、`history-selection.png`、`generation-records.png`：详情及次级操作。
- `dark-narrow-details.png`、`dark-narrow-grid.png`、`dark-narrow-overview.png`：窄屏深色布局。
