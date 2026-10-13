# Storyboard and Video Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task; backend then frontend, with spec review followed by quality review. The user authorized implementation of the proposed best approach and remote dev push.

**Goal:** Preserve one-storyboard joint grids while grounding static keyframes, adjacent-shot boundaries and supported video endpoints in actual frozen inputs.

**Architecture:** A shared read-only continuity resolver uses timeline order and existing transition rules. Grid/planning inputs consume it; generated candidates retain source provenance and report drift without automatic paid cascade. Video endpoint snapshots are separate from existing reference snapshots, avoiding illegal mixed provider inputs. Shared UI shows actual assets/boundaries and model-specific choices.

**Tech Stack:** TypeScript/Hono/Drizzle SQLite, Sharp, Mastra, Nuxt/Vue, Node tests and Playwright.

## Task 1 — Backend production continuity

Files: services/previs-grid-references.ts, previs-grid.ts, previs-frames.ts, agents/tools/frame-splitter-tools.ts; new previs-continuity.ts and previs-video-continuity.ts; services/previs-batch.ts, previs.ts, previs-domain.ts; routes/previs.ts; related backend tests. Prompt layers only when required by the new context.

- [ ] Run merged baseline. Latest dev automatically adopts new ready grid candidates: integration tests must observe the actual terminal adopted state and assert preserved history, not time out waiting for ready. Preserve latest candidate structure-based validity and version switching.
- [ ] Add failing tests for timeline-order previous panel, same-scene continuous boundary, strong/normal/scene-change transitions, first shot, missing last frame (no earlier-frame substitution), asset authority, and ordered context. Implement readonly resolver using existing transitions and allowedChanges.
- [ ] Supply planning context directly; include previous/next descriptions, precise ending/beginning states and allowed changes. Preserve inputHash claim guards and existing frame IDs/timing.
- [ ] Grid generate appends a frozen previous adopted last-frame reference only when applicable. Keep bound assets first and authoritative; caps preflight counts all references, aliases deduplicate deterministically, generate/edit prompts address exact actual order. Use resolved project style prompt. Candidate views expose optional frozen continuity source and current/stale status; missing optional predecessor remains explicit and does not invent a bridge image.
- [ ] Test old snapshots, newly auto-adopted candidates, version rollback and upstream edits/reordering. Upstream edits report stale boundary; no silent overwrite, automatic regeneration or blanket invalidation of history. Updates to unsupported references fail before paid work.
- [ ] Add model-aware video capability resolution for implemented Wan 3.0 and MiniMax-H3 adapters; Seedance and Nuwax remain reference-only. Add optional videoContinuityMode = auto/reference/first_last to batch API. Omitted field preserves legacy reference behavior; frontend sends auto by default. Explicit unsupported first_last rejects before any tasks; auto returns actual mode and fallback reason.
- [ ] For endpoint mode, freeze current first and last ordered frame. For explicit strong, same-scene continuous boundaries, use the exact same upstream adopted last-frame bytes for downstream first-frame input. Preserve middle planned states in video prompt, do not transmit a clean grid as an endpoint image. Require at least two frames for explicit endpoints. Endpoint requests have empty referenceImageUrls; never mix illegal Wan media types.
- [ ] Persist typed endpoint source/digest snapshot and actual strategy. Extend inherited-output schema, polling and staleness checks additively; upstream boundary changes and local frame changes mark affected video stale. Validate/decode all frozen media and every unit's adapter request before queueing any job.
- [ ] Test real adapter payload endpoint roles/digests, supported and unsupported auto fallback, strong shared boundary, scene change, missing endpoints, group mode, stale upstream and old snapshot compatibility. Run affected suites and backend npm run typecheck, commit backend only.

## Task 2 — Shared planning/reference/video interaction

Files: FramePlanDialog.vue, StoryboardGridTools.vue, new GridReferenceAssets.vue and VideoContinuityControl.vue; usePrevis.ts; episode.vue, previs.vue and focused compiled Vue tests.

- [ ] Fail tests for local count choice and explicit recount, actual displayed-count apply, readonly/busy guards, async drafts, reference missing/loading, stale context and candidate frozen refs. Implement time-ordered cards, static prompts first, collapsed continuity/camera details.
- [ ] Share compact actual asset/boundary thumbnails across pages and candidate review/history. GET reference manifest refreshes after beforeAction save; use independent reference tokens, never reset paid/adoption context on own revision changes. Preserve latest resplit slot/events, auto-adoption defaults and candidate version UI.
- [ ] In shared grid settings expose current connection normal/strong/scene_change as 自动衔接/连续动作/场景切换; parent edits the existing timeline transition through workspace.edit, not a new competing flag. First shot has no predecessor selector. Explain exact shared video boundary only applies to supported same-scene continuous motion, not ordinary reverse shots.
- [ ] Share persisted videoContinuityMode control: auto default, reference option and first_last enabled only for the configured model. Both single and batch submissions include mode, use capabilities/readiness to explain first/last inputs and supported fallback. Keep current reference strategy control, do not show it as applying in endpoint mode.
- [ ] Expose upstream reference-change hint and actual generated video strategy. Preserve pending locks and all image/video history. Run focused frontend suites and npm run generate, commit frontend only.

## Task 3 — Integration, browser and delivery

- [ ] Use copied SQLite/static data and local provider mocks, never original project DB or real API credentials. Build latest UI; run actual backend on localhost:5682 for both page entries.
- [ ] In browser validate planning select zero model calls, explicit replan once, planning apply image/history preservation; image refs plus predecessor bytes/order; generate and both refinement flows; candidate version/history compatibility; missing assets and stale input; narrow layout and no page errors.
- [ ] Capture supported video request with actual first/last roles and shared boundary digests, empty references; unsupported auto fallback and explicit rejection; verify frozen snapshot persistence and upstream stale output. Mock output validates plumbing, not real visual quality.
- [ ] Record screenshots and validation results in docs/superpowers/validation/2026-10-13-storyboard-continuity-validation.md. Final fresh affected suites/typecheck/build and integration review.
- [ ] Commit docs, integrate into current clean dev after fetch, preserve concurrent remote changes, push origin dev and verify remote SHA. Restart safe runtime from main checkout before archiving managed worktree.
