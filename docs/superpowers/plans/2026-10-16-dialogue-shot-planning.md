# Dialogue and Shot Planning Implementation Plan

> Execute in the current session using executing-plans; independent prompt maintenance may be delegated using subagent-driven-development.

**Goal:** Preserve dialogue and align its timing, storyboard frames and video production, with reviewable repairs.

**Architecture:** Pure shared planning domain plus optimistic transactional repair service; compatible optional Panel.productionPlan. Derive prompts and frame context from one timed plan. UI uses preview/apply without submitting generation.

**Tech Stack:** TypeScript, node:test, SQLite/Drizzle, Hono, Vue/Nuxt, Playwright.

### 1. Domain and regressions
- [x] Add backend/tests/shot-planning.test.ts with real dialogue overflow, missing lines, flexible timing, quoted punctuation, split conservation, narration and unquoted input regressions; run `node --import tsx --test tests/shot-planning.test.ts` and observe failures.
- [x] Implement backend/src/services/shot-planning.ts. Export parseShotDescription, extractDialogue, analyzePanelProduction, buildProductionPlan, renderProductionPrompt, productionPlanMatchesPanel. Budget based on speech, punctuation and handoff; cap segments; never omit/reorder dialogue.
- [x] Add optional typed productionPlan to Panel and timelineSchema; validate timing and source signature on use; include in fingerprint as appropriate.

### 2. Repair workflow
- [x] Add backend/src/services/shot-planning-repair.ts and routes: POST /animatic-versions/:id/production-plan/preview, POST /animatic-versions/:id/production-plan/apply. Check revision, source digest, selected IDs, work-in-progress, locked/current version and source drift.
- [x] Add database tests for rollback, preview not writing, apply creating fresh draft, split ordering/bindings, preserved old outputs, unchanged media and no sys_task generation.
- [x] Restore only uniquely matched original script lines using speaker and surrounding content; expose restoration in preview. Preserve original wording and don't silently change voice type.

### 3. Frame integration
- [x] Regress punctuation-only frames and changed AI timings; use structured shots for fallback, suggested count and shot/time mapping. Expose rule draft review in FramePlanDialog, allow count auto. Feed productionPlan to frame planning and grid generation.
- [x] Update frame schemas/composable mapping to preserve shotId where present. Existing valid timing is retained only when no new explicit plan is provided.

### 4. Prompt and save boundaries
- [x] Update default agents, all storyboard/prompt generator templates, bulk service and frontend regeneration entry: speech-first timing, model capability, complete dialogue, flexible shots, no fixed3s.
- [x] Validate newly saved AI storyboards/prompt edits before mutation; return useful timing/content errors. Add shared generation preflight to video batch with no paid requests on failure.

### 5. UI and verification
- [x] Build ProductionPlanPanel.vue with whole-episode issues, selected-shot detail and repair preview modal; show changed durations, split counts, restored dialogue and frame review. Apply only after explicit click, refresh workspace and storyboard list, handle optimistic conflicts and errors.
- [x] Run targeted and existing related backend tests, frontend tests, backend typecheck and frontend build.
- [x] Browser-check actual audit fixture in isolated DB/runtime: diagnostics, preview, selection, cancel without writes, apply, split timestamps, blocked generation and retained old media. Review diff for spec then code quality; record verification and integrate into local dev without remote push.
