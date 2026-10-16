# Production Quality Loop Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent pure domain, then the UI. Controller owns service integration; run spec and quality reviews before completion. TDD applies to behavior changes.

**Goal:** Move production quality checks into breakdown, add independent episode evaluation and reviewable AI repairs, simplify the production page.

**Architecture:** A pure quality domain validates full-episode dialogue and planning. A durable quality-task service uses the existing evaluation queue and immutable input snapshots; reviewed repair candidates reuse transactional production repair. The existing evaluation drawer lists both types.

**Tech Stack:** TypeScript, SQLite/Drizzle, Hono, Mastra, Vue/Nuxt, node:test, Playwright.

### 1. Pure episode quality domain

Files: create backend/src/services/production-quality-domain.ts and backend/tests/production-quality-domain.test.ts.

- [x] Add failing tests for episode script coverage, word/order/speaker preservation across split panels, duplicate speech, legacy input, rule failure surviving AI scores, unknown AI IDs, and safe selected-panel changes.
- [x] Implement contracts `QualityIssue { id, rule, severity, panelIds, message, suggestion, evidence? }`, `QualityInput { script, panels }`, `QualityResult { overallScore, confidence, summary, dimensions, issues }`.
- [x] Implement `evaluateProductionRules(input)`, `mergeProductionReview(input, ai)`, `validateQualityEdits(input, selectedIds, edits)`; return structured results, throw before accepting invalid AI edits. AI issues are warnings; deterministic fails stay blocking.
- [x] Run `node --import tsx --test tests/production-quality-domain.test.ts`; require 0 failures.

### 2. Durable evaluation and repair service

Files: create backend/src/services/production-quality.ts, backend/src/db/production-quality-schema.ts and backend/tests/production-quality.test.ts; modify db/schema.ts, db/sqlite-schema.ts, services/task-queue.ts, services/shot-planning-repair.ts, routes/previs.ts, index.ts.

- [x] Test rule-only check makes no model call, identical requests dedupe, AI evaluation snapshots do not mutate source, candidate generation modifies only result, stale apply fails, apply preserves media and immediately rechecks, round cap2.
- [x] Persist `production_quality_tasks` with versionId, kind(review/optimization), parentId, round, inputHash, config/model, status, input/result JSON, appliedVersionId and timestamps. Register `production_quality` queue owner; reviews use evaluation ceiling, optimization also uses the evaluation ceiling.
- [x] Provide GET quality/status and tasks, POST check/reviews, POST tasks/:id/optimize, POST tasks/:id/apply. Server computes all hashes and candidate timing; clients submit issue IDs and expected inputHash only.
- [x] Extend internal production repair with validated server-side description/atmosphere overrides; include overrides in preview hash. Existing public repair routes remain compatible.
- [x] Tool-free model call through resolveTextModel uses JSON-only schema, no writing tools. Validate current input and config before dispatch; unknown submission outcomes require queue confirmation, never automatic duplicate paid requests.
- [x] Run domain/service tests, `npm run typecheck`.

### 3. Breakdown boundary integration

Files: modify backend/src/routes/agent.ts, backend/src/agents/tools/storyboard-tools.ts, backend/src/services/video-prompts.ts, relevant prompts; add backend/tests/production-quality-breakdown.test.ts.

- [x] Test final check waits for missing prompt completion, rule failures are returned with IDs and suggestions, no-tool/no-write response is not successful breakdown, final source hash distinguishes edits.
- [x] On storyboard-breaker completion run full-episode rules and at most one bounded correction call for returned rule issues; record rule result even when manual work remains. Trigger AI review only if automatic evaluation enabled and final prompt supplementation is settled.
- [x] Keep upfront per-batch validation before destructive replacement and existing atomic bindings. Expose structured diagnostics to UI rather than success toast for partial failure.

### 4. Unified evaluation UI

Files: modify ContinuityReviewPanel.vue, ProductionPlanPanel.vue, episode.vue, useAgent.ts; create ProductionQualityDetail.vue and useProductionQuality.ts; add frontend/tests/production-quality-interactions.test.mjs.

- [x] Write failing interaction tests for mixed list keys, status/type filters, details, select issues, candidate preview/cancel/apply, stale/conflicting responses, completed-vs-quality-failed states and no silent auto generation.
- [x] Extend the current drawer to show planning and continuity tasks with distinct prefixed keys; maintain one settings button. New-review type choice defaults planning; continuity review stays available.
- [x] Compact production status opens the same drawer focused on planning. Details show rules and five dimensions, selected-problem AI optimization, progress, candidate diff and apply. Rule-only deterministic repair remains a secondary details action.
- [x] Await async onDone in useAgent, refresh final check/report in episode after breakdown or supplementation. On adopting a candidate load new version and refresh storyboard rows.
- [x] Run related frontend tests and `npm run build`.

### 5. Review, browser verification and local integration

- [x] Independent spec review then code quality review; fix actionable defects and add regressions.
- [x] Run related domain, repair, queue, continuity, prompt, frame and UI regression suites, backend typecheck and frontend build.
- [x] Browser exercise with an isolated DB: compact status, mixed tasks, free checks, rule details, paid-task-disabled errors, optimization candidate injected through test runner, cancel no writes, apply/new version/recheck, stale report and page errors.
- [x] Record evidence, commit and fast-forward local dev. Restart known local services after confirming no active work; do not push remote or run paid generation.

## Verification evidence

- Backend related regression: 244/244 passed; backend `npm run typecheck` passed.
- Frontend focused behavior: 68/68 passed; `npm run build` passed. Full frontend comparison found the same 25 pre-existing test failures, and pinned vue-tsc found the same 10 pre-existing diagnostics in useToast/previs readiness typing.
- Browser at isolated localhost:5683 + backend5695 with copied database, keys cleared and inactive model configurations: candidate dismissal does not write, explicit adoption creates one new version, old report becomes historical, free recheck succeeds, zero page errors and zero paid requests.
- Independent spec review and code quality review completed; findings fixed with regressions: crash recovery, uncertain HTTP outcomes, candidate double restoration, atomic queue admission, manual/automatic dedupe and cancellation restart, config changes, source-conflict rejection, and UI rule repair lifecycle.
- Existing queue-test fixtures used empty visual descriptions and failed 2/6 on HEAD; supplied a valid description to exercise the concurrency/recovery checks, now 6/6.
- Local dev integration only; no remote push.
