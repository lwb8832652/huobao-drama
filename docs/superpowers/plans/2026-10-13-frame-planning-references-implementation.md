# Frame Planning and References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Complete spec review and then quality review after each task.

**Goal:** Keep one storyboard with multiple frames while improving action planning and making actual image references visible and reliable.

**Architecture:** A shared readonly reference resolver feeds preview, generation preflight and candidate metadata. Planning receives server-loaded complete context; existing candidate worker, adoption and video semantics remain intact. Shared Vue components provide the same simplified planning/ref preview on both pages.

**Tech Stack:** Hono, TypeScript, Drizzle/SQLite, Sharp, Mastra, Nuxt/Vue, Node test runner, Playwright.

## Task 1: Backend context, reference contract and prompts

Files: backend/src/agents/tools/frame-splitter-tools.ts; services/previs-frames.ts, new services/previs-grid-references.ts, services/previs-grid.ts; routes/previs.ts; workspace/prompts/frame_splitter{,.en,.ja,.ko}.md, workspace/skills/frame-splitter/SKILL.md, src/agents/index.ts; backend/tests/storyboard-frame-planning-continuity.test.ts and new storyboard-grid-references.test.ts.

- [ ] Write failing tests for imagePrompt and ordered existing frames in readonly planning context, direct serialized context in a generated planning request, visual asset metadata and single-static-state action anchors. Verify failures using node_modules/.bin/tsx --test.
- [ ] Implement explicit request builder with supplied readonly context. Keep existing agent/config routing, do not introduce provider-specific API options or automatic planning→image chaining. Update prompt layers to prefer supplied context, declare action-source priorities, starts/turning points/end, no unsupported changes, script-permitted location/camera transitions.
- [ ] Test planning-input change before/after model invocation and concurrent forced requests. Reuse equal active inputs, reject changed active count/model, and publish completion/failure only for the claimed processing task.
- [ ] Write failing real SQLite/static media tests for required assets, shared panel references retained when frame overrides are empty, normalized static dedup, combined labels and exact reference order, missing/foreign/deleted asset preview and rejection, reference-free generate rejection, candidate reference metadata and multipart image-byte mapping.
- [ ] Implement resolver returning typed asset items and readiness. GET grid-references validates version/panel ownership and only reads metadata. Generation uses resolver before caps and frozen media. Store referenceAssets in snapshot/view (old snapshots optional); build prompt legend from resolved exact order and include original description plus actual allowed transitions.
- [ ] Run affected frame/grid tests and backend npm run typecheck; commit backend files only. Spec review then quality review and fix findings.

## Task 2: Compact planning and shared reference preview

Files: frontend/app/components/previs/FramePlanDialog.vue; StoryboardGridTools.vue; new GridReferenceAssets.vue; frontend/app/composables/usePrevis.ts; frontend/tests/frame-planning-interactions.test.mjs, storyboard-grid-interactions.test.mjs and focused component tests.

- [ ] Write failing compiled Vue interaction tests proving count select is local, explicit recount once, actual draft count used on apply, guards and editable drafts retained; reference loading/readiness/stale context, no references generate disabled and candidate reference display.
- [ ] Implement local requestedCount and explicit replan button. Use time-ordered frame cards, editable static prompt plus collapsed continuity/camera, collapsed shared constraints summary and one-storyboard/one-grid explanation. Preserve existing event/async planner contracts and old image application semantics.
- [ ] Add grid-references types/client preview with stable cancellation tokens, status reasons and ordered image thumbnails. Re-read after beforeAction save and guard missing refs before POST; generation backend remains authoritative. Use candidate frozen referenceAssets for review, preserve existing adopted lease and refinement source controls.
- [ ] Run all frontend targeted suites and npm run generate; commit frontend files only. Spec review then quality review and fix findings.

## Task 3: Browser validation and integration

- [ ] Serve build/new backend using copied SQLite and static assets at localhost:5682 with localhost model mock. Preserve original project data and real credentials.
- [ ] Verify both page entries: one panel/multiple frames, compact planning, number change zero calls, explicit replan, apply preserves old images, exact reference thumbnails/labels, one multipart call with frozen refs, generation/adoption and both refinements, missing reference error before model call, narrow layout and console errors.
- [ ] Capture screenshots and counts; document evidence in docs/superpowers/validation/2026-10-13-frame-planning-references-validation.md. Run final fresh affected checks/review, commit docs using git add -f, merge locally to dev and restart safe runtime from main before archiving worktree. 用户已于本轮明确授权推送远程 dev；此前已完成的 4 个提交已推送至 42285d1，本轮优化验证完成后同样推送并核对远程 SHA。
