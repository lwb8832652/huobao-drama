# 分镜宫格与视频参考输入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户本轮只授权需求设计与文档；本计划的保存不代表授权开始业务代码实施。

**Goal:** 将单个分镜的画面范围统一为 1～9 张，增加可点击宫格概览，并支持逐张原图、宫格及自动视频参考输入。

**Architecture:** 原始画面和时间线仍是内容来源；后端生成固定画布比例的标注宫格和干净宫格，将缓存保存在独立表中。前端复用同一布局和画面映射，视频提交先确定输入策略、校验全部输入，再把不可变快照写入现有批次队列。

**Tech Stack:** Vue 3 / Nuxt 3、TypeScript、Hono、Drizzle / better-sqlite3、Sharp、Node.js test runner；复用当前视频 adapter。

---

## 已确认设计与执行范围

设计依据：`docs/superpowers/specs/2026-10-12-storyboard-contact-sheet-design.md`，提交 `07b59d4`。以下实现细节均围绕该设计，不恢复旧的 AI 宫格生成、图片切割或 `/grid` 接口。

- 第一阶段：Task 1～6，实现数量、宫格生成和展示；视频仍沿用当前逐张参考流程。
- 第二阶段：Task 7～10，接入视频输入策略和任务快照。快照、失败重试从这一阶段开始完整实现，质量评估不作为这些正确性措施的前置条件。
- 第三阶段：Task 11，用真实生成结果评估顺序遵循、细节和分屏残留，并据此调整提示词。
- 每个任务完成后提交一个可独立审阅的 commit；执行前核对工作区，不覆盖其他任务的修改。
- 不修改时间线 schemaVersion；旧版本、锁定版本和已排队任务按兼容规则读取。

## 当前代码约束

| 位置 | 当前行为 | 计划处理 |
| --- | --- | --- |
| `backend/src/services/previs-frames.ts` | AI 数量为 2～6 | 共享常量改为 1～9；默认建议仍保持 2～5 |
| `backend/src/routes/previs.ts` | 请求数量最小值写死 2 | 使用共享数量范围 |
| `backend/src/services/previs.ts` | 保存允许最多 100 张 | 保留旧数据读取范围，对新增和扩张单独限制 9 |
| `frontend/app/components/previs/FramePlanDialog.vue` | 选项为 2～6 | 使用共享的 1～9 选项 |
| `backend/workspace/prompts/frame_splitter.*.md` | 四种语言写有 2～6 | 与 agent 默认提示词同步更新 |
| `backend/src/services/previs-batch.ts` | 逐张参考 URL 去重后发送 | 新请求保留逐画面的映射与顺序，不静默丢失重复时点 |
| `backend/src/services/generation.ts` | 本地视频参考压到 768×768 | 宫格使用独立的尺寸与质量配置 |
| `backend/src/db/previs-schema.ts` | 锁定时间线不可写 | 派生宫格单独存储，不能增加时间线 revision |
| `.gitignore` | 默认忽略 Markdown 和测试文件 | 文档单文件强制加入；实现时仅放行本功能新增测试 |

图谱 MCP 在本会话未提供可调用工具，上表通过现有源文件核对。执行时若图谱工具可用，优先用图谱检查调用关系。

## 文件职责

| 新增文件 | 职责 |
| --- | --- |
| `backend/src/services/previs-frame-contract.ts` | 数量范围、历史超限校验、共享选项 |
| `backend/src/services/previs-contact-sheet-domain.ts` | 布局、画布、单格坐标、画面映射和资源状态类型；不导入 DB、Sharp 或 Node 文件 API |
| `backend/src/services/previs-contact-sheet-renderer.ts` | 用 Buffer 合成标注图、干净图和列表缩略图 |
| `backend/src/services/previs-contact-sheets.ts` | 加载图片、持久化缓存、排队、重试、状态查询和 worker |
| `backend/src/services/previs-video-reference.ts` | 纯输入策略决策、序号/时点说明、视频参考快照类型 |
| `frontend/app/composables/useContactSheets.ts` | 宫格请求、状态合并、过期判断和显式重试 |
| `frontend/app/components/previs/StoryboardContactSheet.vue` | 固定比例宫格展示、透明点击区域、缺图状态和键盘操作 |
| `frontend/app/components/previs/VideoReferenceStrategyControl.vue` | 两个页面共用的输入策略选择及实际输入摘要 |

修改现有文件只接入必要的事件和字段，避免继续把合成、缓存或策略算法堆进 `episode.vue` 和 `usePrevis.ts`。

## 统一契约

在 Task 2、7 中分别导出以下类型，后续任务使用相同名字：

```ts
export type ContactSheetStatus = 'none' | 'composing' | 'ready' | 'stale' | 'failed'
export interface ContactSheetCell {
  frameId: string
  index: number
  offsetMs: number
  url: string
  left: number
  top: number
  width: number
  height: number
}
export interface ContactSheetDescriptor {
  version: 1
  panelId: number
  aspectRatio: string
  columns: number
  rows: number
  width: number
  height: number
  cells: ContactSheetCell[]
}
export interface ContactSheetView {
  panelId: number
  sourceHash: string
  artifactId: number | null
  artifactHash: string | null
  status: ContactSheetStatus
  annotatedUrl: string | null
  cleanUrl: string | null
  thumbnailUrl: string | null
  descriptor: ContactSheetDescriptor | null
  readyFrames: number
  totalFrames: number
  error: string | null
}
export type VideoReferenceInputStrategy = 'auto' | 'individual' | 'contact_sheet'
export type EffectiveVideoReferenceInput = 'individual' | 'contact_sheet'
```

约定：`ready` 表示宫格合成完成，`readyFrames / totalFrames` 表示原图就绪程度，两者不能混为一谈。缺图可以合成带占位的预览，但缺图宫格不得提交视频。画面排序改变时，下标重新生成；引用身份仍使用 frameId。

默认输出长边 3072 像素，16:9 为 3072×1728，9:16 为 1728×3072；其他合法项目比例按相同比例计算偶数边长。整图比例等于项目比例，每格使用 contain。宫格上传 JPEG 单张限制 3 MiB，优先降低编码质量，不压回 768×768；编码或模型约束无法满足时明确报错。

## Task 1：统一 1～9 范围并兼容历史数据

**Files:**
- Create: `backend/src/services/previs-frame-contract.ts`
- Modify: `backend/src/services/previs-frames.ts`、`backend/src/routes/previs.ts`、`backend/src/services/previs.ts`
- Modify: `backend/src/agents/index.ts`、`backend/workspace/prompts/frame_splitter.md`、`backend/workspace/prompts/frame_splitter.en.md`、`backend/workspace/prompts/frame_splitter.ja.md`、`backend/workspace/prompts/frame_splitter.ko.md`、`backend/workspace/skills/frame-splitter/SKILL.md`
- Modify: `frontend/app/composables/usePrevis.ts`、`frontend/app/components/previs/FramePlanDialog.vue`、`frontend/app/components/previs/StoryboardFramesEditor.vue`、`frontend/app/views/drama/previs.vue`、`.gitignore`
- Test: `backend/tests/storyboard-frame-contract.test.ts`、`frontend/tests/storyboard-contact-sheet-interactions.test.mjs`

- [ ] 编写下面的数量回归测试。测试对象通过 `makeFrame` 构造，不调用 AI。

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeFrame } from '../src/services/previs-domain.js'
import { FRAME_COUNT_OPTIONS, frameCountChangeAllowed } from '../src/services/previs-frame-contract.js'

test('新画面最多九张，历史超限数据可保留和减少', () => {
  const frames = (n: number) => Array.from({ length: n }, (_, i) => makeFrame(`f-${i}`))
  assert.deepEqual(FRAME_COUNT_OPTIONS, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(frameCountChangeAllowed(frames(9), []), true)
  assert.equal(frameCountChangeAllowed(frames(10), frames(9)), false)
  assert.equal(frameCountChangeAllowed(frames(12), frames(12)), true)
  assert.equal(frameCountChangeAllowed(frames(10), frames(12)), true)
  assert.equal(frameCountChangeAllowed(frames(13), frames(12)), false)
  const replaced = frames(12).map((f, i) => i === 0 ? makeFrame('new-frame') : f)
  assert.equal(frameCountChangeAllowed(replaced, frames(12)), false)
})
```

- [ ] 从 `backend` 运行 `node --import tsx --test tests/storyboard-frame-contract.test.ts`，确认首次失败指向缺少新契约。
- [ ] 用下列完整共享契约实现数量限制，再接入上述入口。

```ts
import { frameKey, type Keyframe } from './previs-domain.js'

export const FRAME_COUNT_MIN = 1
export const FRAME_COUNT_MAX = 9
export const FRAME_COUNT_OPTIONS = Array.from({ length: 9 }, (_, i) => i + 1)

export function frameCountChangeAllowed(next: Keyframe[], before: Keyframe[] = []) {
  if (next.length <= FRAME_COUNT_MAX) return true
  if (before.length <= FRAME_COUNT_MAX || next.length > before.length) return false
  const oldIds = new Set(before.map(frameKey))
  return next.every(frame => oldIds.has(frameKey(frame)))
}
```

保存仍允许 0 张空态；存储 schema 保持最多 100 张以读取旧数据。任何新视频任务涉及的分镜超过 9 张时，在创建批次前报错；旧任务按已有快照恢复。手动添加在 9 张时禁用并显示数量上限；描述规划会保留已有额外图片，因此要在应用前检查最终数量，不能自动 slice 丢图。单张 AI 拆分只代表一个关键状态，提示词不同时要求“第一张开场、最后一张结束”两个不同画面。

- [ ] 编写前端操作测试：数量选择可选 1/9；第 10 张添加无 change 事件；描述规划超限不丢失已有 URL 和历史；AI 结果越界时不给应用。给已有 `frontend/tests/frame-planning-interactions.test.mjs` 的 evaluate 依赖映射补入新增共享契约，保持其原行为断言。运行新增测试和旧交互测试，预期全通过。
- [ ] 仅给本功能测试添加 `.gitignore` 例外 `!backend/tests/storyboard-*.test.ts`、`!frontend/tests/storyboard-*.test.mjs`。提交 `feat(previs): support one to nine storyboard frames`。

## Task 2：共享布局、固定画布与点击映射

**Files:**
- Create: `backend/src/services/previs-contact-sheet-domain.ts`
- Modify: `frontend/app/composables/usePrevis.ts`，仅 re-export 纯布局和类型
- Test: `backend/tests/storyboard-contact-sheet-domain.test.ts`

- [ ] 编写全部数量和同时间点稳定排序的测试。

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contactSheetLayout, contactSheetDescriptor } from '../src/services/previs-contact-sheet-domain.js'
import { makeFrame, type Panel } from '../src/services/previs-domain.js'

test('一至九张布局与约定一致', () => {
  const expected = [[1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2], [3, 3], [3, 3], [3, 3]]
  expected.forEach(([columns, rows], i) => assert.deepEqual(contactSheetLayout(i + 1), { columns, rows }))
  assert.throws(() => contactSheetLayout(0), RangeError)
  assert.throws(() => contactSheetLayout(10), RangeError)
})

test('编号跟随时间排序且重复 URL 保持独立格子', () => {
  const panel = { id: 7, frames: [
    { ...makeFrame('b', 2000), url: '/static/same.jpg' },
    { ...makeFrame('a', 0), url: '/static/same.jpg' },
    { ...makeFrame('c', 2000), url: '' },
  ] } as Panel
  const sheet = contactSheetDescriptor(panel, '16:9')
  assert.deepEqual(sheet.cells.map(c => [c.frameId, c.index]), [['a', 1], ['b', 2], ['c', 3]])
  assert.equal(sheet.width, 3072)
  assert.equal(sheet.height, 1728)
  assert.equal(sheet.cells.length, 3)
  assert.equal(sheet.cells[2].left, 0)
  assert.equal(sheet.cells[2].top, 864)
})
```

- [ ] 运行 `node --import tsx --test tests/storyboard-contact-sheet-domain.test.ts`，首次应因模块不存在失败。
- [ ] 定义上文 ContactSheet 类型和 `contactSheetLayout`、`contactSheetDescriptor`。布局函数如下，descriptor 用 `orderedFrames(panel)` 和 `frameKey(frame)` 生成有效格子，不为剩余空格生成 cell。

```ts
export function contactSheetLayout(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('画面数必须为 1～9')
  if (count === 1) return { columns: 1, rows: 1 }
  if (count === 2) return { columns: 2, rows: 1 }
  if (count <= 4) return { columns: 2, rows: 2 }
  if (count <= 6) return { columns: 3, rows: 2 }
  return { columns: 3, rows: 3 }
}
```

格子边界由 `floor(column * width / columns)` 和下一列边界的差计算，行同理，避免除不尽产生缝隙。descriptor 固定包含渲染版本 1。输入 hash 使用 descriptor、源 URL、画面 ID、时间点、画布比例；最终合成还记录源图片 Buffer 的 SHA-256。远程同 URL 内容变化只能通过显式重新合成读取，不把 URL 字符串当成图片内容校验值。

- [ ] 增加竖屏、空 URL、非法比例和空画面的断言；0 张在调用层走空态，不调用 descriptor。测试通过后提交 `feat(previs): define contact sheet layout and frame mapping`。

## Task 3：后端确定性合成两种宫格

**Files:**
- Create: `backend/src/services/previs-contact-sheet-renderer.ts`
- Test: `backend/tests/storyboard-contact-sheet-renderer.test.ts`

- [ ] 以纯色图片编写像素测试，直接检查解码后的宫格，避免只验证函数返回地址。

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { renderContactSheet } from '../src/services/previs-contact-sheet-renderer.js'
import { contactSheetDescriptor } from '../src/services/previs-contact-sheet-domain.js'
import { makeFrame, type Panel } from '../src/services/previs-domain.js'

test('两张画面保持顺序，标注图与干净图确实不同', async () => {
  const frame = (id: string) => ({ ...makeFrame(id), url: `/static/${id}.png` })
  const panel = { id: 7, frames: [frame('red'), frame('blue')] } as Panel
  const descriptor = contactSheetDescriptor(panel, '16:9')
  const image = (background: string) => sharp({ create: { width: 320, height: 180, channels: 3, background } }).png().toBuffer()
  const result = await renderContactSheet(descriptor, [await image('#ff0000'), await image('#0000ff')])
  const { data, info } = await sharp(result.clean).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
  const left = at(768, 864), right = at(2304, 864)
  assert.ok(left[0] > 240 && left[2] < 15)
  assert.ok(right[2] > 240 && right[0] < 15)
  assert.equal(info.width, 3072)
  assert.equal(info.height, 1728)
  assert.notDeepEqual(result.annotated, result.clean)
})
```

- [ ] 运行 renderer 测试，确认红蓝空间关系断言能失败。
- [ ] 实现以下接口：`renderContactSheet(descriptor: ContactSheetDescriptor, images: (Buffer | null)[]): Promise<{ annotated: Buffer; clean: Buffer; thumbnail: Buffer; sourceDigests: (string | null)[] }>`。逐图 `rotate()` 处理 EXIF，`resize(cell.width, cell.height, { fit: 'contain', background: '#202020' })`，按 cell 坐标 composite 到画布。
- [ ] 干净图只包含原图和中性留白；标注图在有效格左上角绘制固定大小的编号角标，编号使用固定 SVG 字形，避免依赖部署环境字体，不能使用来源标题作为 SVG 文本。缺图标注图包含编号和占位提示；布局空格无编号。缩略图从标注图生成，供列表使用。两种完整图输出 JPEG，缩略图输出 WebP。
- [ ] 增加 3/5/7/8 张空格、缺图、不同原图比例、EXIF 和九宫格测试。通过像素检查确认边框和数字只存在于标注图，且 contain 没有拉伸。提交 `feat(previs): render annotated and clean contact sheets`。

## Task 4：派生缓存、worker、状态 API 与失败重试

**Files:**
- Modify: `backend/src/db/previs-schema.ts`、`backend/src/db/schema.ts`
- Create: `backend/src/services/previs-contact-sheets.ts`
- Modify: `backend/src/routes/previs.ts`、`backend/src/index.ts`
- Test: `backend/tests/storyboard-contact-sheet-cache.test.ts`

- [ ] 使用独立临时 SQLite 和临时 storage 编写缓存测试。必须覆盖重复请求复用、替图后旧结果不能覆盖新状态、锁定版本不修改 revision、服务重启后队列恢复、文件读取失败和重试。`SQLITE_PATH`、`HUOBAO_DATA_DIR`、`MYSQL_AUTO_IMPORT=false` 在动态 import 后端模块之前设置，禁止使用项目实际数据目录。
- [ ] 新增 `frame_contact_sheets`，唯一键为 `(version_id, panel_id, input_hash)`。字段包含 `id`、上述三个键、`descriptor_json`、`source_digests_json`、`render_hash`、`status`、三个输出 URL、`error`、`attempt`、`started_at`、`updated_at`、`created_at`。DB status 使用 `pending / processing / completed / failed`，API 按当前 descriptor 派生 `ContactSheetView.status`。render_hash 由 descriptor 与实际图片内容校验值计算，API 以 artifactHash 返回，不与只描述来源字段的 sourceHash 混用。
- [ ] 实现服务方法并保持同一参数契约：

```ts
// 以下导出签名由 Task 4 实现，类型使用上文统一契约。
export interface ContactSheetService {
  scheduleContactSheets(versionId: number, panelIds?: number[], force?: boolean): void
  readContactSheets(versionId: number): ContactSheetView[]
  retryContactSheet(versionId: number, revision: number, panelId: number): ContactSheetView
  tickContactSheets(): Promise<void>
  startContactSheetWorker(): Promise<() => void>
}
```

readContactSheets 只读；retryContactSheet 校验 revision，只重试当前 hash；scheduleContactSheets 默认复用已完成记录，force 用于用户主动重新合成，重新读取同 URL 图片并更新 render_hash。每次领取任务先写 processing 和 attempt。完成后条件更新必须匹配任务 id、attempt 和 processing，禁止旧 worker 完成回调改写重试任务。图片和 descriptor 使用排队快照；任务文件使用唯一名称，旧视频引用的文件保留，不原地覆盖。worker 并发为 1，轮询 1500ms 并 `unref()`。

- [ ] 读取本地图片时复用 `STORAGE_ROOT`，解析 `static/` 与 `/static/`；规范化路径后确认位于 storage 内。远程图片只接受 HTTP(S)，每张请求超时 15 秒、解码前大小不超过 20 MiB。空 URL 表示未生成，传 null 绘制占位，不算文件读取失败；非空 URL 读取失败写明对应 frameId，不跳过格子，不输出可提交的干净宫格。0 张和历史超限数据不合成，只返回状态与整理提示。
- [ ] 添加以下 API；所有 POST 在排队前校验 version、revision、panel 归属。锁定版本允许生成派生素材，禁止调用 `requireEditable()` 写时间线。

| Method | `/api/v1` 下的路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/animatic-versions/:id/contact-sheets` | 无 | `{ items: ContactSheetView[] }` |
| POST | `/animatic-versions/:id/contact-sheets` | `{ revision, panelIds?: number[], force?: boolean }` | `{ items: ContactSheetView[] }` |
| POST | `/animatic-versions/:id/contact-sheets/:panelId/retry` | `{ revision }` | 当前分镜的 ContactSheetView |

- [ ] 幂等建表两次、失败重试和锁定版本测试通过后，提交 `feat(previs): persist contact sheet cache and processing state`。

## Task 5：在保存、图片完成和前端状态中同步宫格

**Files:**
- Modify: `backend/src/services/previs.ts`、`backend/src/services/previs-batch.ts`
- Modify: `backend/src/services/previs-domain.ts`、`frontend/app/composables/usePrevis.ts`
- Create: `frontend/app/composables/useContactSheets.ts`
- Test: `backend/tests/storyboard-contact-sheet-sync.test.ts`、`frontend/tests/storyboard-contact-sheet-interactions.test.mjs`

- [ ] 测试保存后新 hash 被排队；失败的时间线保存不排队；图片 reconcile 成功后更新宫格；宫格工作不会把 `version.busy` 变成 true；相同 revision 也能轮询到宫格更新。
- [ ] 在 `saveTimeline` 事务成功后排队。图片 reconcile 中只有实际回写 frame.url 后才排队；不让合成失败回滚原始图片完成结果。服务调用采用不导入 previs.ts 的缓存边界，避免 `previs -> contact-sheets -> previs` 循环。
- [ ] 给 `AnimaticVersion` 增加可选 `contactSheets?: ContactSheetView[]`；完整 version 与 state 响应都返回缓存状态。`usePrevis.poll()` 在 revision 未变化时也合并该字段；旧后端不返回时使用空数组。
- [ ] `useContactSheets` 在版本打开后确保已有画面的缓存；项目比例变动或本地编辑时，根据 descriptor 标记为 stale，保存成功后再请求合成。前端 dirty 状态不能被缓存轮询覆盖。页面切换、旧请求返回、组件销毁都用版本 ID 与请求 token 拒绝过时响应。
- [ ] 故障测试通过后提交 `feat(previs): synchronize derived sheets without timeline revisions`。

## Task 6：可点击概览、逐张编辑与列表预览

**Files:**
- Create: `frontend/app/components/previs/StoryboardContactSheet.vue`
- Modify: `frontend/app/components/previs/StoryboardFramesEditor.vue`
- Modify: `frontend/app/views/drama/episode.vue`、`frontend/app/views/drama/previs.vue`
- Test: `frontend/tests/storyboard-contact-sheet-interactions.test.mjs`

- [ ] 复用现有 SFC 编译测试方式，渲染组件并触发按钮事件：第 3 格打开 frameId 3；缺图格同样能打开设置；布局空格没有 button；只读格可查看但不能保存或生成；切换分镜不复用上一个分镜的设置。
- [ ] `StoryboardContactSheet` 接收 `panel`、`aspectRatio`、`sheet?: ContactSheetView`，发出 `select(frameId, event)`。已合成时展示标注图；未合成时使用相同 descriptor 渲染原图与缺图占位，不能继续使用过期缩略图冒充当前图。
- [ ] 宫格容器使用固定 `aspect-ratio`。按钮范围从 cell 坐标转换成百分比，并与完整画布保持一致；不要把点击坐标绑定到 img 的原始像素。每个有效格提供 `aria-label="画面 N，时间 X 秒"`，Enter/Space 与点击一致，弹窗关闭返回原格焦点。
- [ ] `StoryboardFramesEditor` 增加概览/编辑切换，默认概览。切换记忆按 panelId 存于组件内 Map；概览保留数量、生成缺失、AI 拆分、添加、更多操作和视频入口，主体不展示逐张卡片。编辑态复用当前卡片，不复制其上传和历史逻辑。已有 openSettings 接收宫格选择的 frameId。
- [ ] 工作台列表在无可播放视频时使用宫格缩略图；有视频时保留 video 节点，poster 优先宫格、其次现有视频 poster。显示完整图，不能 `object-fit: cover` 裁切。预演播放器和时间线按时间推进的单帧预览继续使用原图，不改成静态宫格。
- [ ] 运行前端新旧交互测试和 `npm --prefix frontend run generate`。对 1、2、5、9 张横竖屏、失败、缺图、锁定、窄面板做浏览器检查。提交 `feat(previs): add contact sheet overview and list previews`。第一阶段至此可验收。

## Task 7：视频输入策略与分镜/组规则

**Files:**
- Create: `backend/src/services/previs-video-reference.ts`
- Modify: `backend/src/routes/previs.ts`、`backend/src/services/previs-batch.ts`
- Test: `backend/tests/storyboard-video-reference.test.ts`

- [ ] 编写策略真值表测试，强调“组模式 auto 始终每分镜一张宫格”，不同于总原图数量超限后才切换。

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveVideoReferenceInput } from '../src/services/previs-video-reference.js'

test('自动、手选和组策略按批准规则决定', () => {
  assert.equal(resolveVideoReferenceInput('auto', 'storyboard', [9], 9), 'individual')
  assert.equal(resolveVideoReferenceInput('auto', 'storyboard', [9], 4), 'contact_sheet')
  assert.equal(resolveVideoReferenceInput('auto', 'group', [1, 1], 9), 'contact_sheet')
  assert.equal(resolveVideoReferenceInput('individual', 'group', [3, 4], 9), 'individual')
  assert.equal(resolveVideoReferenceInput('contact_sheet', 'storyboard', [1], 9), 'contact_sheet')
  assert.throws(() => resolveVideoReferenceInput('individual', 'group', [5, 5], 9), /最多接收/)
  assert.throws(() => resolveVideoReferenceInput('auto', 'group', Array(10).fill(1), 9), /按分镜生成/)
  assert.throws(() => resolveVideoReferenceInput('auto', 'storyboard', [10], 9), /最多 9/)
})
```

- [ ] 实现完整决策函数，并导出前述策略类型。

```ts
export type VideoReferenceInputStrategy = 'auto' | 'individual' | 'contact_sheet'
export type EffectiveVideoReferenceInput = 'individual' | 'contact_sheet'

export function resolveVideoReferenceInput(
  requested: VideoReferenceInputStrategy,
  mode: 'storyboard' | 'group',
  frameCounts: number[],
  maxImages: number,
): EffectiveVideoReferenceInput {
  if (!frameCounts.length || frameCounts.some(n => n < 1)) throw new Error('请先添加分镜画面')
  if (frameCounts.some(n => n > 9)) throw new Error('单个分镜最多 9 张，请先整理历史画面')
  const count = frameCounts.reduce((sum, n) => sum + n, 0)
  const effective = requested === 'auto'
    ? (mode === 'group' || count > maxImages ? 'contact_sheet' : 'individual')
    : requested
  const images = effective === 'individual' ? count : frameCounts.length
  if (images > maxImages) throw new Error(`当前模型最多接收 ${maxImages} 张参考图，请改为按分镜生成或减少输入范围`)
  return effective
}
```

- [ ] batch API 新增 `referenceInputStrategy?: VideoReferenceInputStrategy`，缺省 auto；direct 模式不使用这个选项。沿用模型时长、group 支持和 reference 能力校验。手选 individual 不能自动切换；手选 contact_sheet 即使只有一张也使用宫格。
- [ ] 宫格策略只使用当前 hash、completed、全部原图可读的 cleanUrl；未生成/过期/失败返回明确错误及“先合成/重试宫格”操作。缺图时任何 storyboard_frames 策略都不允许提交。
- [ ] 真值表与全部缺图断言通过后，提交 `feat(previs): resolve video reference input strategies`。

## Task 8：提示词映射、任务快照和原子提交

**Files:**
- Modify: `backend/src/services/previs-video-reference.ts`、`backend/src/services/previs-batch.ts`
- Modify: `backend/src/services/previs.ts`、`backend/src/services/previs-domain.ts`
- Test: `backend/tests/storyboard-video-snapshot.test.ts`

- [ ] 验证两个分镜都使用“第 1 格”时，会分别映射到 `@图片1` 与 `@图片2`；同 URL 两个画面保留两个时间点；原图策略不写宫格说明；无效图片或单个单元失败时，批次和 item 都没有部分写入。
- [ ] 新请求固定以下快照，写在 `batch_run_items.request_json.referenceInput`，不写入锁定 timeline：

```ts
export interface VideoReferenceSnapshot {
  version: 1
  requested: VideoReferenceInputStrategy
  effective: EffectiveVideoReferenceInput
  imageUrls: string[]
  imageDigests: string[]
  panels: {
    panelId: number
    durationMs: number
    sheetId: number | null
    sheetHash: string | null
    frames: { frameId: string; imageIndex: number; gridIndex: number | null; offsetMs: number; sourceUrl: string }[]
  }[]
}
```

`imageIndex` 从 1 开始，对应 adapter 的图片顺序；individual 时 gridIndex 为 null，contact_sheet 时它是 1～9。格子描述采用 frame.title 和 frame.prompt，时点来自 frame.offsetMs，并附分镜时长和组内顺序；不能重新平均分配时间。

- [ ] `createBatch` 先完成所有单元的输入准备、图片可读性、宫格状态、提示词长度及 adapter 契约校验，再统一写入批次事务。逐张原图先读取并冻结为 `static/previs-inputs/<内容校验值>.<图片后缀>`，快照 imageUrls 指向不可变文件，frames.sourceUrl 保留用户选择的来源 URL；同一图片多个时点可复用同一冻结文件，但 imageUrls 保留每个位置。宫格使用独立不可变输出文件，sheetHash 保存 artifactHash。imageDigests 与 imageUrls 等长，记录实际文件内容校验值。异步读取后在事务内重新校验 revision 与来源 hash，变化则返回 409；不能发出任何付费调用。重试沿用原 request_json，不重新读取当前画面。
- [ ] 新快照任务的指纹覆盖排序、URL、时间点、输入策略、实际宫格 hash 和快照版本。旧 request_json 无 referenceInput 时仍使用当前旧指纹算法。输出过期判断读取每个任务自己的快照上下文；不能通过把默认参数改成 auto 使已有视频全部过期。
- [ ] `readBatches` 只返回策略、实际参考数量、宫格版本和画面映射摘要，不能返回模型密钥或图片 Base64。扩展 BatchItem 字段 `referenceInputStrategy`、`effectiveReferenceInput`、`referenceImageCount`，可选字段兼容旧任务。
- [ ] 增加排队后编辑、切换历史、服务恢复、重试、旧视频指纹、提示词超长测试。提交 `feat(previs): freeze video reference snapshots before batch submission`。

## Task 9：宫格上传质量与重复参考顺序

**Files:**
- Modify: `backend/src/services/generation.ts`
- Modify: `backend/src/utils/storage.ts`，复用现有压缩方法，不改所有图片的默认值
- Test: `backend/tests/storyboard-video-upload.test.ts`

- [ ] 用九色九宫格生成 3072×1728 文件，通过现有队列执行入口捕获 mock adapter 收到的真实转换数据，再解码检查尺寸和九格颜色；不为测试导出私有转换函数，也不能只断言 resize 参数。同 URL 两帧在新 storyboard 快照请求中保留顺序，读取失败不得少传一张后继续提交。
- [ ] 给 GenerateVideoParams 增加 `referenceInput?: VideoReferenceSnapshot`，并在 generateVideo 调用 createTask 的参数对象中保存 `referenceInput: params.referenceInput`。后台启动与恢复时从 task params 读取此字段，不向厂商额外发送内部快照。有 `referenceInput.version === 1` 时按快照 effective 策略转换。宫格本地图片采用长边 3072、JPEG 质量初值 88、单图上限 3 MiB；质量依次降到 80、72，仍超限则报错。不能统一压回 768。individual 保留原图压缩策略，但保留每个输入位置；同 URL 的读取可以共享 Buffer，最终数组不能去重。
- [ ] 单个新参考的载入失败使整任务失败。generation.ts 的“读取后数量”检查按快照 imageUrls.length 比较，不再按 new Set 数量比较。旧任务没有快照仍按旧逻辑处理，避免已排队任务行为变化。
- [ ] 新快照请求的内部 JSON 预检预算为 48 MiB；adapter 有更小限制时使用更小值。实际 Base64 payload 总量在请求构造后再次检查，超出预算则在网络 POST 前失败并提示减少输入范围；日志只写字节数，不输出图片 Base64。所有模型持续使用 `reference_image`，不能把宫格填进 firstFrameUrl。
- [ ] 像素、重复 URL、失败阻止 HTTP POST、旧 adapter 请求回归通过后，提交 `fix(previs): retain contact sheet detail and reference ordering`。

## Task 10：共用策略选择与真实就绪条件

**Files:**
- Create: `frontend/app/components/previs/VideoReferenceStrategyControl.vue`
- Modify: `frontend/app/composables/usePrevis.ts`
- Modify: `frontend/app/views/drama/episode.vue`、`frontend/app/views/drama/previs.vue`、`frontend/app/components/previs/StoryboardFramesEditor.vue`
- Test: `frontend/tests/storyboard-video-reference-interactions.test.mjs`

- [ ] 测试切换策略后单个、批量和预演页面提交同一 referenceInputStrategy；auto 在组模式显示“宫格”；宫格失败时 individual 可以提交，contact_sheet 禁用并解释原因；策略变更不能造成时间线 dirty。
- [ ] 增加 `useVideoReferenceInputStrategy()`，本地键为 `huobao:video-reference-input-strategy`，默认 auto，持久化异常静默降级。控件文案使用“自动”“逐张画面”“宫格参考”，不显示类型常量；显示实际将提交的图片数量。
- [ ] 在 `usePrevis.generate` 类型、工作台 `confirmBatchVideos`、`genVideo`、预演页面 `startVideo` 中传递策略。所有视频就绪判断共用原图齐备与有效策略条件；不能只改右侧按钮而遗漏左侧批量生成。
- [ ] 自动或手选宫格未就绪时提供“合成宫格”或“重试宫格”，合成完成后再允许生成视频；不在点击生成时静默改成另一策略。任务详情显示 requested/effective 策略和图片数，旧任务显示原来的生成模式即可。
- [ ] 两个页面测试、前端 generate 和后端 typecheck 通过后，提交 `feat(previs): expose reference strategy and readiness across video actions`。第二阶段至此可验收。

## Task 11：回归、浏览器与视频效果验证

**Files:**
- Test: 前述新增 `backend/tests/storyboard-*.test.ts`、`frontend/tests/storyboard-*.test.mjs`
- Retain: `frontend/tests/frame-planning-interactions.test.mjs`
- Document: `docs/superpowers/specs/2026-10-12-storyboard-contact-sheet-validation.md`

- [ ] 完整运行下面的定向检查，保存退出码和结果。只有新增修改引入的失败才调整业务代码；现存结构测试的旧路径问题单独记录，不能删除旧测试来制造全绿。

```bash
cd backend
node --import tsx --test tests/storyboard-*.test.ts
npm run typecheck
cd ../frontend
node --test tests/storyboard-*.test.mjs tests/frame-planning-interactions.test.mjs
npm run generate
```

- [ ] 用独立 SQLite 副本和独立数据目录启动服务。验证数据用纯色图、真实尺寸图片和缺图占位，不覆盖用户当前剧集。浏览器选择普通 HTTP 地址，验证 crypto.randomUUID 缺失时仍可规划和添加。
- [ ] 浏览器覆盖 1～9 所有数量、横竖屏、3/5/7/8 空格、失败重试、历史恢复、相同时点移动、列表视频优先、只读和窄面板。检查实际网络请求：individual 发送 N 张、contact_sheet 单分镜发送 1 张、auto 组内发送每分镜 1 张；检查最终 adapter 请求里的图片尺寸和顺序。
- [ ] 服务重启后确认宫格 processing 不会永久停住；锁定版本 timelineJson、contentHash、revision 均未变化；旧视频任务可以按原快照恢复；提交中 revision 冲突返回 409 且无部分批次。
- [ ] 视频效果评估是单独的真实模型实验，不属于确定性测试。对相同 1/5/9 张内容，分别测试 individual 与干净宫格，记录时序遵循、身份一致、细节、分屏/文字残留。每组至少 3 个结果，保留模型名、参数、提示词和输入快照。真实模型调用在执行阶段核对用户授权与可用额度。
- [ ] 发现任何宫格、角标或分屏残留，则记录失败样本并修正提示词或选择模型；不通过“加了禁止角标一句话”宣称效果达标。Task 1～10 的正确性可验收，真实质量实验完成前不得宣称所有模型的宫格输入效果已验证。
- [ ] 文档记录通过项目、失败项与实际支持的模型；用 `git diff --check` 验证最终变更，再按会话授权交付。推送、发布和部署不包含在本计划的文档审批中。

## 需求覆盖与自检

| 需求/风险 | 对应任务 |
| --- | --- |
| F1 数量、AI/规则/手动、历史超限 | Task 1 |
| F2 固定画布、自适应布局、稳定排序 | Task 2、3 |
| F3 角标、干净图、时点映射与成片检查 | Task 3、8、11 |
| F4 自动/手动策略、单分镜与组上限 | Task 7～10 |
| F5 宫格缩略图、视频预览优先 | Task 6 |
| F6 双态、格子点击、历史和只读 | Task 6 |
| 自动失效、重试、乱序完成与重启 | Task 4、5 |
| 锁定版本、旧视频/旧任务兼容 | Task 4、8、9、11 |
| 宫格细节被 768 压缩损坏 | Task 9 |
| 快照、无部分批次和提交前校验 | Task 8、11 |

- [ ] 执行者在每个阶段核对类型、路由和字段名称与本计划一致。
- [ ] 初始 `generationMode` 仍为 direct / storyboard_frames；不要把 referenceInputStrategy 当成第三种 generationMode。
- [ ] 明确 auto 组模式和显式 individual 组模式的区别，不混用较早讨论的“总数超限才切换”口径。
- [ ] 合成状态、原图就绪数量和视频可提交状态分开显示，缺图预览不能变成可提交素材。
- [ ] 执行前确认设计阶段“不改代码”的约束已由用户明确解除；仅确认本计划不启动业务代码修改。
