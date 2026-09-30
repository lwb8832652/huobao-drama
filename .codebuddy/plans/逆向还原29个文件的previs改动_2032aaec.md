---
name: 逆向还原29个文件的previs改动
overview: 从 uncommitted-summary.md 提取 29 文件 diff 补丁，以反向模式（patch -R）应用，把代码恢复到改动前的基线状态：删除 14 个新增文件，回退 15 个修改文件，最终编译/标记验证并交付。
todos:
  - id: extract-revert-patch
    content: 从 uncommitted-summary.md 提取 29 文件 diff 到 /tmp/revert.patch 并核对文件数
    status: completed
  - id: dry-run-reverse
    content: 对 revert.patch 执行逆向 dry-run 验证 29 文件全部可逆
    status: completed
    dependencies:
      - extract-revert-patch
  - id: apply-reverse-patch
    content: patch -p1 -R 正式逆向应用补丁撤销全部改动
    status: completed
    dependencies:
      - dry-run-reverse
  - id: verify-reverted-state
    content: 正向 dry-run、关键标记清零、新文件删除、git status 29 项验证无遗漏
    status: completed
    dependencies:
      - apply-reverse-patch
---

## 需求说明

逆向撤销 `uncommitted-summary.md` 中记录的全部 29 个文件改动（+5360/-176），使工作区代码回到 diff 的"改动前"状态：

- **撤销 14 个新增文件**（动态故事版 previs 功能）：`backend/src/db/previs-schema.ts`、`backend/src/middleware/static-range.ts`、`backend/src/routes/previs.ts`、`backend/src/services/continuity-review.ts`、`backend/src/services/previs-batch.ts`、`backend/src/services/previs-domain.ts`、`backend/src/services/previs.ts`、`frontend/app/assets/css/previs.css`、`frontend/app/components/previs/` 下 4 个组件、`frontend/app/composables/usePrevis.ts`、`frontend/app/views/drama/previs.vue`
- **回退 15 个修改文件**：`.gitignore`、`backend/src/agents/index.ts`（移除 `resolveTextModel`）、`db/schema.ts`、`db/sqlite-schema.ts`、`index.ts`（移除 previs 路由、worker 启动、Range 中间件）、`routes/tasks.ts`、`services/ffmpeg-merge.ts`、`services/generation.ts`、`frontend/app/composables/useApi.ts`、4 个语言 `locales/*.json`、`views/drama/episode.vue`、`nuxt.config.ts`

交付状态：工作区处于"改动已撤销"的未提交状态，不替用户提交。

## 技术方案

### 方法

利用已验证可行的提取命令从 `uncommitted-summary.md` 的 ````diff` 围栏提取完整补丁，用 `patch -p1 -R` 逆向应用。前序轮次已证明该补丁对当前代码树 100% 精确匹配（正向/反向 dry-run 均 29 文件全通过、0 失败、0 偏移），且当前工作区 = HEAD = 补丁后状态，因此逆向应用可精确回到改动前，无冲突风险。

### 执行步骤

1. **提取补丁**：`awk '/^````diff$/{f=1;next} /^````[[:space:]]*$/{if(f) exit} f' uncommitted-summary.md > /tmp/revert.patch`，确认含 29 个 `diff --git` 头、6333 行。
2. **逆向 dry-run**：`patch -p1 -R --dry-run --no-backup-if-mismatch < /tmp/revert.patch`，要求 29 个文件全部 `patching`、无 FAILED/offset/fuzz。
3. **正式逆向应用**：`patch -p1 -R --no-backup-if-mismatch < /tmp/revert.patch`。
4. **验证（无遗漏判定）**：

- 对同一补丁做**正向** dry-run 应 29 文件全部 clean → 证明树已回到 diff"改动前"状态；
- 关键标记计数为 0：`resolveTextModel`(agents/index.ts)、`startPrevisWorker`/`serveStaticRanges`(index.ts)、`previs`(nuxt.config.ts)、`previs_item_key`(schema.ts)；
- 14 个新增文件已不存在（`ls` 检查）；
- `git status --short` 显示 29 个变更：14 个 `D`（已删）+ 15 个 `M`（已回退），`git log` 仍为单个 `d394323 init`（不提交）。

### 风险控制

- 全程不产生 `.orig`/`.rej` 备份垃圾（`--no-backup-if-mismatch`）；失败则终止，不改任何文件（dry-run 先行）。
- 改动前内容可从 `git show HEAD:<path>` 恢复，操作本身可逆，不触碰 `uncommitted-summary.md`、`sd.sh`、`sd.md.enc` 等非目标文件。
- 用户此前取消过 npm install，故不做编译验证；如需可另行安排。