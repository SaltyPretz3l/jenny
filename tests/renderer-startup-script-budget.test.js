/* UIUX-024: "the renderer loads 647 local scripts and 9,336,542 canonical
 * LF bytes at every startup" (measured 2026-09-04; supersedes the figures
 * at audit time). The full esbuild route-entrypoint bundling fix is an
 * explicit non-goal this pass (docs/plans/UIUX_REMEDIATION_LEDGER_2026-07-12.md
 * Non-goals). What IS in scope: a budget so the eager boot payload cannot grow
 * silently, and a signal that distinguishes "more scripts" from "more eager
 * bytes" — the second is what actually costs cold-start parse time.
 *
 * Ceilings below carry headroom above the measured baseline (captured
 * 2026-07-12, post xterm.js/addon-fit.js deferral — see
 * renderer-startup-hidden-surface-deferral.test.js) because this worktree has
 * several concurrent slices legitimately adding renderer scripts in the same
 * pass. The ceilings exist to catch a real regression class — e.g. a future
 * hidden-surface vendor runtime (a Monaco/xterm/katex-sized library) being
 * re-added as a synchronous <script> tag — not to block ordinary feature work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Measured 2026-07-12 baseline (post UIUX-024 xterm deferral): 547 local
// scripts, ~7.83 MB total, 8 eager (non-defer) / ~48.8 KB eager bytes.
// +1 on 2026-07-19: renderer-stream-tool-live-tail.js (cohesiveness QoL W2-1
// live tool-output tail, owner-approved plan).
// +1 on 2026-07-19: renderer-background-jobs.js (cohesiveness QoL W2-2
// background-job chip strip, owner-approved plan).
// +1 on 2026-07-20: markdown-inline-paths.js — at-cap sibling split of
// markdown-utils.js (GUI-pass findings remediation: inline prose path chips).
// +1 on 2026-07-22: renderer-circuit-trace-gestures.js — sibling module for the
// grid-native circuit-trace click grammar (c69e4927, which registered the script
// across the other order surfaces but left this budget un-raised).
// +2 on 2026-07-23: hardware-recommend-utils.js and renderer-snapshot-refresh.js
// — v0.9.1 Windows-setup hardening split the hardware-recommendation scene and
// the snapshot refresh into their own modules.
// +4 on 2026-07-30: image-gen Lane E (owner-approved brief,
// the archived image-generation UI brief) — the former image-specific renderer,
// renderer-image-gen-controller.js, renderer-image-gen-lightbox.js,
// renderer-image-gen-settings.js.
// +2 on 2026-07-31: image-gen hardening split the DOM half out of the two
// at-ceiling Lane E controllers — renderer-image-gen-card-dom.js and
// renderer-image-gen-settings-view.js. Pure extractions: no new eager bytes
// beyond the module wrappers, and both new files stay under 600 lines.
// +1 on 2026-08-01: renderer-image-gen-session-guards.js — the D9 navigation
// guards and their confirm plumbing, split out to restore headroom under the
// 1015-line ceiling (the controller was at 1003 of 1015).
// +1 on 2026-08-01: renderer-plugins-settings.js — the Stage 3B Plugin Manager
// Settings section (owner-approved design). It absorbs the read-only plugin
// status row that W9 folded into Developer ▸ Harness, so the renderer's plugin
// surface stays one module wide, not two.
// 590 base + 3 (image-gen hardening) + 1 (Stage 3B Plugin Manager) = 594.
// +2 on 2026-08-03: the approved data-lifecycle Settings controller and its
// pure formatting helpers; destructive removal remains in a separate window.
// +3 on 2026-08-04: Stage 4B's contribution, command, and theme runtimes are
// lazy feature modules. They are counted here even though they are absent from
// index.html, so lazy loading does not become a script-budget accounting gap.
// +4 through 2026-08-06: the Stage 4B settings-view split, Stage 5 settings,
// and the two reasoning controls. Stage 7 replaced the legacy ChatGPT setup
// script with the sandboxed plugin-view host, so that migration is net zero.
// +1 on 2026-08-07: C1's focused renderer-send-receipts.js owner keeps
// immutable send/failed-payload lifecycle logic out of the at-ceiling sender.
// +1 on 2026-08-09: R1's bounded component-preservation registry keeps live
// media/Mermaid/disclosure/focus ownership out of the structural morph owner.
// +1 on 2026-08-09: Stage 8's deferred consent-status projection keeps the
// isolated Trust Window result visible without placing privilege in renderer.
// +1 on 2026-08-10: Stage 9's deferred managed-policy settings projection keeps
// machine-policy status isolated from the at-ceiling Plugin Manager controller.
// Frozen HEAD already measured 613 scripts from integrated feature work; the
// dedicated deferred chats-panel controller adds one bounded local module.
// +1 on 2026-08-14: shared assistant-identity-form.js removes duplicated
// onboarding/Settings personality controls while keeping inventory ownership.
// 2026-08-17: Artifact Panel V3 adds four focused chrome modules plus one shared listbox primitive.
// +1 on 2026-08-21: personality system v3 retires assistant-identity-form.js and lands
// personality-form.js plus two pure siblings (renderer-personality-counters.js,
// renderer-memory-notes-utils.js) that exist to keep renderer-personality-utils.js under the
// 600-line production cap; net +1 eager module, all plain renderer scripts.
// +1 on 2026-08-22: renderer-ide-test-runner-history-strip.js (per-config run-duration strip, hang markers, trend) enters explicit production order before renderer-ide-test-runner-panel.js, which consumes it; the panel stays a render-only consumer.
// +2 on 2026-09-01 (wt/composer-vision): base commit 6988f09c already measured 637 (the
// llama-server/model-tuning series bumped the complexity ratchet but not this budget); the
// composer vision gate adds renderer-composer-vision-gate.js (637 -> 638), a pure module
// that keeps renderer-render-pipeline-chrome.js and renderer-send-utils.js under their caps.
// +2 on 2026-09-02 (merge of wt/composer-vision into main): same merge arithmetic - main
// carried the skills/plugins rework (636 -> 639 on its side), this branch added
// renderer-composer-vision-gate.js off the older base (637 -> 638). Measured 640 in the
// merged tree, not unioned.
// +2 on 2026-09-02 (plan-usage meter + model-fit programs): renderer-plan-usage-meter.js and
// model-library-fit.js, both plain renderer modules (640 -> 642).
// +1 on 2026-09-02 (GGUF folders): renderer-model-library-folders.js, the Settings Model library
// "GGUF folders" row, enters production order before its section consumer (642 -> 643).
// +1 on 2026-09-02 (merge of wt/reasoning-stream-fidelity into main): the same merge arithmetic -
// main carried the GGUF folders script (642 -> 643) while this branch added
// markdown-raw-html-policy.js off the older base. Measured 644 in the merged tree, not unioned.
// +1 on 2026-09-03 (streaming perf W3-A0): renderer-stream-text-cursor.js enters production
// order before renderer-stream-handler-tools.js and renderer-stream-handler-live-events.js,
// which both consume it; it absorbs the aggregate cursor arithmetic those files shared so the
// upcoming conditional-aggregate change has one edit site (644 -> 645).
// +2 on 2026-09-04 (verification gate W3): renderer-ide-test-runner-gate-utils.js enters
// production order between the history strip and the test-runner panel that consumes it
// (gate header copy/derivation kept out of the panel so it stays under the 600 soft
// threshold). Measured 646 -> 647; the 645 -> 646 step was already accumulated drift on
// main (the test was red before this change). Measured, not unioned.
// +1 on 2026-09-04 (python_execute + approval program follow-up): renderer/chat/tool-approval-facts.js enters production order immediately before tool-call-utils.js, which binds it (the approval-facts derivation moved out so tool-call-utils leaves the over-600 set). Measured 647 -> 648.
// +3 on 2026-09-04 (resume-turn affordance): renderer-resume-turn-affordance.js enters
// production order before renderer-turn-row-render-utils.js, which resolves it, and
// renderer-resume-turn-interaction.js before renderer-chat-shell-controller.js, which
// constructs it (+2). The third is NOT this branch's: 481f3b36 already measured 646
// against a 645 budget, so main was carrying a one-script overage before this work -
// verified by measuring the tree with only these two tags removed.
// +2 on 2026-09-05 (composer model picker): renderer-composer-model-picker-utils.js and renderer-composer-model-picker.js enter production order before renderer-app-shell-bindings.js, which mounts the picker. Measured 648 -> 650.
// +5 on 2026-09-05 (Tasks Slice 0): checkbox, task-brief, spawn-chip, and two task-rail modules enter production order. Measured 648 -> 653.
// +2 on 2026-09-07 (merge of wt/plugin-sign-pipeline / Remote Control Slice 7b): the bounded Settings controller and composer banner enter deferred production order.
// +3 on 2026-09-07 (merge of wt/i18n-safety-101): eager i18n-utils and i18n-bootstrap head scripts, and scene-acknowledgement.js in setup scene order.
// +1 on 2026-09-07 (M11): i18n-backend-strings.js translates closed backend vocabularies at renderer sinks.
// +2 on 2026-09-08: calendar chat markup and interaction owners.
// +2 on 2026-09-09: approved session-runtime settings controller and knowledge
// scope helper, both deferred. Measured 667; preserve two scripts of headroom.
// Approved session-runtime program: +2 lazy inspector owners and +1 durable Send
// owner; five of the six approved additions are now used (665 -> 670).
// +6 on 2026-09-16 (Runtime UX program, approved 2026-09-16, NEXT_STEPS.md
// "Post-runtime program plan"): pre-paid for renderer-runtime-refusals.js and
// renderer-runtime-queue-view.js (A1), renderer-turn-pause-affordance.js and
// renderer-turn-pause-interaction.js (A2), and the attention-inbox model +
// controller (A3); the away digest (A4) reuses the inbox owners. Measured 670
// at the time; A4 re-bases this to measured + 1 when the program lands.
// +2 on 2026-09-16 (Runtime UX A1-A4 landed; re-based 2026-09-16): the digest
// (JEN-059) needed two owners of its own rather than reusing the inbox's, so
// the pre-paid six became seven of eight. Measured 678 with A1-A4 in the tree;
// re-based to that + the 1 script of headroom this note planned for.
// +1 on 2026-09-16 (split view W0-1, approved 2026-09-16, NEXT_STEPS.md "Post-runtime
// program plan"): renderer-chat-pane-surface-controllers.js, the per-pane scroll
// coordinator + viewport + pin-to-top cluster lifted out of the lifecycle composition,
// which sat at the 1015-line hard cap and had to be relieved before any split-view slice
// could touch it. W0-1 spent the single script of headroom the note above left (measured
// 679, exactly at that ceiling); re-based to measured + the same 1 script of headroom.
// +2 on 2026-09-16 (split view W0-2/W0-3, approved 2026-09-16, NEXT_STEPS.md "Post-runtime
// program plan"): renderer-pane-model.js (the pane layout the boot state is seeded with,
// loaded immediately before renderer-bootstrap-utils.js) and renderer-pane-visibility-utils.js
// (the per-pane render gate, loaded between the predicate it composes and the stream handler
// that resolves it). W0-1 left one script of headroom and these need two; measured 681,
// re-based to measured + the same 1 script of headroom.
// +1 on 2026-09-16 (split view W0-6, approved 2026-09-16, NEXT_STEPS.md "Post-runtime
// program plan"): renderer-pane-runtime.js, the per-pane render-memo bag and the shared
// session-cache store, loaded immediately before renderer/app.js, which reads the global
// at factory time. W0-2/W0-3 left one script of headroom and W0-6 spends it (measured 682,
// exactly at that ceiling); re-based to measured + the same 1 script of headroom. W0-4, the
// last Wave 0 slice, adds no script.
// +2 on 2026-09-20 (Projects v2, po-review, owner-approved; NEXT_STEPS.md "Projects v2"):
// renderer/features/renderer-project-menu.js and renderer-project-switcher.js are LAZY
// (STAGE4B_LAZY_MODULES, loaded on first open by renderer-shell-ide-root-service.js through
// scriptLoaderUtils.ensureScript); they are counted here only so their bytes stay inside the
// byte ceiling, exactly like the orchestration pair. index.html gains no <script> tag: the
// eager-boot slot the split-view work left is untouched. Measured 684 (682 tags + 4 lazy);
// re-based to measured + the same 1 script of headroom.
// +1 on 2026-09-22 (PDF reading add-on for 1.2.0, po-review, owner-approved): the deferred
// renderer/shell/renderer-settings-pdf-addon.js owns Settings > Tools > PDF reading add-on; no
// vendor payload, no eager tag. Measured 685 (exactly at the ceiling); re-based to measured + 1.
// 2026-09-25 (post-1.2.0 sweep S4): pinned to the authority, the `index_html_scripts` baseline in
// scripts/checks/complexity_ratchet_baselines.json (enforced by check_complexity_ratchets.py), so
// one number moves at a time: raise that baseline first, then this pin to match. The two count
// different sets that are both 685 today: the ratchet counts every non-http <script src> tag
// (681 local + 4 node_modules/vendor), this test counts the 681 local tags + STAGE4B_LAZY_MODULES.
// 2026-09-25 (sweep S3): 685 -> 683 with the two fallback-registry tags gone; ratchet lowered first.
// 2026-09-25 Split view W1-4c (approved plan docs/plans/split-view/W1_SPEC.md): +4 deferred tags,
// renderer-pane-session-context.js, renderer-pane-layout-controller.js, renderer-chat-pane-resizer.js
// and renderer-app-pane-composition.js (the pane layout goes live); ratchet raised first. 667 -> 671.
// 2026-09-25 Split view W2-2a (brief docs/plans/split-view/B_W2_2A_BRIEF.md): +1 deferred tag,
// renderer-pane-composer-rail.js (pane 1's own model/effort/run-mode rail); ratchet raised first. 671 -> 672.
// 2026-09-26 Split view W3 foundation (spec docs/plans/split-view/W3_SPEC_2026-09-26.md): +2 deferred
// tags, renderer-side-panel-owner.js and renderer-composer-toolbar-fit.js; ratchet raised first. 672 -> 674.
// 2026-09-26 Split view gate §D follow-up: +1 deferred tag, renderer-pane-drag-controller.js (the drag-to-split
// drop target and kicker drag, moved out of the at-cap pane composition); ratchet raised first. 674 -> 675.
// 2026-09-27 Astra pane findings P1: +1 deferred tag, renderer-composer-pane-drafts.js (which session's draft each
// pane's composer holds, kept out of the composer state controller at the 600-line ratchet); ratchet raised first. 675 -> 676.
// 2026-09-27 Runs page (spec silly-sauteeing-pretzel §4 Wave R): renderer-orchestration-view.js splits into
// the LAZY renderer-runs-view.js + renderer-runtime-limits-view.js (listed in STAGE4B_LAZY_MODULES, no
// index.html tag), so this set grows by one lazy module while the index_html_scripts ratchet (tags only)
// stays at its value. 676 -> 677 (merged with the tag above).
// +2 on 2026-09-27: OS notifications (renderer-settings-notifications-section.js, renderer-desktop-notifications.js).
// +1 on 2026-09-28 HB-009 waiting send: renderer-stuck-send.js (deferred; renderer-durable-send.js sat at the 600-line ratchet).
// +1 on 2026-09-28 Subagent Monitor v2: renderer-subagent-rail.js is eager by design (the artifact bridge binds it as a factory argument and restores the persisted `subagents` rail mode at boot, like the task rail); ratchet raised first.
// +1 on 2026-09-29 Transcript views (docs/plans/TRANSCRIPT_VIEWS.md): renderer/chat/renderer-transcript-view-utils.js, the per-session answers | thinking | everything vocabulary plus the Settings field builder (renderer-settings-support.js sits one line under the 1015-line cap); ratchet raised first.
// +2 on 2026-09-29 open loops redesign (merged with transcript views): renderer-open-loop-row.js and renderer-open-loop-form.js, both deferred.
// +1 on 2026-09-29 status loader: renderer-startup-starfield.js (deferred, inside #startupOverlay) replaces the curtain's circuit-trace rAF; the lifecycle module shrank by the removed trace code.
// +1 on 2026-09-29 artifact panel review (D-12): renderer-artifact-review-rail.js (deferred), the rail state machine split out of renderer-artifacts-utils.js, which sat at 1014 of the 1015-line cap; bytes move, they do not grow.
// 2026-09-29 UI wave landing (transcript views + open loops + shell chrome): the five deferred additions above compound.
// +1 on 2026-09-29 native image generation (docs/plans/BYO_IMAGE_MODELS_SDCPP.md): renderer/shell/model-library/model-library-image-engine.js, the Model Library Image engine section (deferred, mounted only behind tools_image_generate_enabled); ratchet raised first.
// +1 on 2026-09-30 composer Chat panel: renderer/chat/renderer-composer-tools-slot.js, the tools slot split out of renderer-shell-runtime-utils.js (which drops 111 lines) to stay under the 1015-line cap.
// +1 on 2026-09-30 generated image presentation: renderer/inventory/artifact-figure.js (deferred), the inline image figure; the branch
// did not raise this budget. Measured 689 on the 2026-09-30 landing tree (with the composer Chat panel above).
// +1 on 2026-09-30 timeline-perf: renderer/chat/renderer-chat-ctrl-wheel-gate.js (the Ctrl-gated wheel zoom listener split out of renderer-chat-event-utils.js at the 1015-line cap).
// +2 on 2026-09-30 Settings cohesion S0 (docs/plans/settings-cohesion/WAVE1_SPEC.md): renderer/shell/renderer-settings-field-descriptors.js and renderer-settings-field-binding.js, both deferred; ratchet raised first.
// +1 on 2026-09-30 Circuit Trace routed board: renderer-circuit-trace-board.js (deferred), the seeded PCB generator. Merged main (timeline-perf, Settings cohesion, background effects): measured 693, + 1 script of headroom.
const MAX_TOTAL_SCRIPT_COUNT = 701; // +3 on 2026-10-04 timeline-perf: renderer-render-pipeline-article-prediction.js and renderer-render-pipeline-render-signatures.js (deferred), split out of article-markup and message-renderer at their 1015-line caps, after renderer-stream-reasoning-patch-utils.js spent the last headroom (measured 700, +1 of headroom). merged 2026-10-03 row 31 with row 32 (measured 697 local tags + lazy modules, +1 of headroom). +1 on 2026-10-03 SIM-005 ordered IDE manifest; +1 on 2026-10-03 diagnostics review remediation: renderer-diagnostics-performance-utils.js (deferred), split out of render-utils at its file cap. merged 2026-10-02 with the owner-gate fix batch (+1, measured 695). +1 on 2026-10-02 gate F20 (owner-picked option A): renderer-admission-wait-line.js (deferred), the timeline line for a send held behind another chat. merged 2026-10-02 (timeline activity dot with plugin retirement stages 2 and 4: +3 -1 +1, measured 694). +3 on 2026-10-02 timeline activity dot: renderer/chat/renderer-sprite-activity.js (the activity derivation and sprite view applier, kept out of the thinking pipeline at its 600-line ratchet), renderer/chat/renderer-sprite-morph.js (the dot morph engine) and renderer/chat/renderer-stream-activity-typed.js (the activity row typed-state accessor, kept out of the row at 600) (measured 694). +1 on 2026-10-02 plugin retirement stage 2: renderer-settings-cloud-models.js (the Settings > Models Cloud models group; measured 692). -1 on 2026-10-02 plugin retirement stage 4: renderer-plugin-catalog.js deleted (catalogs retired). -2 on 2026-10-02 Remote Control removed: renderer-remote-control-banner.js and renderer-settings-remote-section.js deleted (merged with the chat timeline follow-ups: measured 691). +2 on 2026-10-02 chat timeline review follow-ups: renderer-approval-focus-restore.js and renderer-chat-accessibility-wiring.js, split out of two files at their line caps (measured 693, the headroom is spent). -1 on 2026-10-01 tips cache removal: renderer-tips-utils.js deleted (measured 693 -> 692). -2 on 2026-10-01 inline code suggestions removed: renderer-ide-inline-suggest.js and renderer-ide-fim-picker.js deleted (measured 690, + 1 of headroom).
// +1 on 2026-09-01 (merge of wt/motion-css into main): this budget is a SECOND, independent
// ceiling from the complexity ratchets, so the same merge arithmetic applies to it - both
// parents counted their own scripts off a shared base and the file auto-merged clean. Main
// carried explorer QoL W2b's renderer-ide-tree-edit.js (633 local scripts, already red against
// the 622 this branch inherited); motion adds three (634 -> 636 merged). Measured, not unioned.
// +12 on 2026-09-01: 622 -> 632 was accumulated drift from the explorer-QoL, acceleration and
// preview programs that bumped the ratchet baselines but not this budget (the test was already
// red on main); the chat-timeline motion polish adds motion-height-utils.js and
// renderer-reasoning-autocollapse-utils.js (632 -> 634), both kept out of the 1015-capped files.
// +1_970 bytes on 2026-07-31: merging main into wt/imagegen-integration combined two
// concurrently-developed lines that were each under this ceiling alone — image-gen Lane E's
// four renderer scripts plus main's circuit-trace/string-utils/turn-event work. Neither is
// the regression class this budget guards: the vendor lazy-load assertion below still passes,
// eager scripts remain 8 of 16, and the largest local script is renderer/app.js at ~64 KB, so
// no hidden-surface vendor runtime landed as a synchronous <script>. Raised to 8_650_000 to
// restore the headroom this file's header describes for concurrent slices.
// +35_000 bytes on 2026-08-01: the same merge shape again, and for the same reason —
// image-gen hardening and the Stage 3B plugin control plane each landed under the old
// ceiling alone (+32.6 KB and +28.3 KB of local script by raw file size), and only their
// sum crosses it. Measured total after the merge is 8_665_293. Still not the regression
// class this budget guards: the vendor lazy-load assertion below passes, eager scripts
// stay well under MAX_EAGER_SCRIPT_COUNT, and every added file is a plain renderer module
// — no vendor runtime landed as a synchronous <script>. Raised to restore roughly the
// ~20 KB of headroom the previous value carried, so the tripwire stays meaningful.
// Stage 7 audit on 2026-08-07: 600 production script tags plus 3 lazy plugin
// modules total 8_784_893 bytes. The delta since the Stage 4B freeze is the
// four accounted modules above plus the sandboxed plugin-view replacement;
// eager scripts remain 8 and the vendor lazy-load assertions below still pass.
// Preserve the existing 20,000-byte headroom above the measured state.
// C1-C4 freeze on 2026-08-07: immutable receipts, attachment/outbox ownership,
// destructive-operation admission, and slash/preference settlement bring the
// measured local total to 8,845,696 bytes. No vendor or non-defer runtime was
// added; preserve the same 20,000-byte review headroom.
// R1 freeze on 2026-08-09 measures 8,885,142 bytes after the focused
// preservation module; it is deferred local code, not a vendor runtime.
// Stage 8 closeout on 2026-08-10 measures 8,907,214 bytes after the deferred
// consent-status projection; preserve the established 20,000-byte headroom.
// Chats sidebar review remediation on 2026-08-14 measures 8,932,698 bytes
// after bounded lifecycle, focus, persistence, tooltip, and overflow fixes.
// Script count, eager count, and vendor loading are unchanged; restore the
// established 20,000-byte review headroom.
// Tool hardening integration on 2026-08-15 measures 8,968,391 bytes after
// bounded lazy tool-detail state, canonical result settlement, and search
// projection fixes. No vendor or non-defer runtime was added; preserve the
// established 20,000-byte review headroom.
// Artifact-panel and Monaco remediation on 2026-08-20 measures 8,999,146
// bytes after the panel chrome / v2 render split, the Monaco editor-utils
// lifecycle fixes, the artifact bridge and review-preference work, and the
// tool-detail error-body fix. Every added byte is a deferred local renderer
// module: script count, eager count, and the vendor lazy-load assertions are
// all unchanged, so this is not the regression class this budget guards.
// Preserve the established 20,000-byte review headroom.
// RE-BASED 2026-08-20 after a tree-wide CRLF->LF normalization (1589 files). Every
// measurement above was taken with a raw statSync() against a working tree carrying
// hidden CRLF, so the recorded numbers were inflated and the "20,000-byte headroom"
// rule never actually held. Reconstructed LF-true totals from git blobs vs what the
// comments recorded: 08-10 8,718,829 vs 8,907,214 (+188,385); 08-14 8,814,733 vs
// 8,932,698 (+117,965); 08-15 8,854,382 vs 8,968,391 (+114,009); 08-20 8,925,402 vs
// 8,999,146 (+73,744). Real headroom ran 94k-208k -- 4.7x to 10.4x looser than
// documented, never tighter, so the gate never false-failed; the invariant was just
// silently unenforced. measureLocalScripts now canonicalizes CRLF, so this constant
// finally means the same number on every checkout. Basis is the committed state at
// f696b495 (8,930,738 canonical bytes, confirmed two ways: canonicalByteLength over
// the worktree with dirty scripts substituted for their HEAD blobs, and an
// independent `git ls-tree -r -l` blob sum). A concurrent session's uncommitted
// Monaco/typography work was deliberately EXCLUDED from the basis -- a ratchet
// describes committed state -- so it consumes ~6,970 of the headroom until it lands.
// +32,662 on 2026-08-20 (W10, Home ask pill mini-composer): the measured total is
// 8,963,400 canonical bytes. ~25,700 of the delta is this wave — the new deferred
// renderer/features/renderer-dashboard-ask-config.js owner (20,390 bytes: chip +
// popover, the renderer-local draft, and the launcher that threads it into
// handleCreateSession) plus the manager/daybook/widgets-core/lifecycle edits that
// wire it. The remaining ~6,970 is the same concurrent session's uncommitted
// Monaco/typography work the note above already accounts for. Script count, eager
// count, and the vendor lazy-load assertions are unchanged — no vendor runtime
// landed as a synchronous <script> — so this is not the regression class this
// budget guards. Restores the established 20,000-byte review headroom.
// +27,600 on 2026-08-21 (personality system v3): measured 8,990,839 canonical bytes.
// The delta is the Settings Personality rewrite — personality-form.js,
// renderer-personality-counters.js and renderer-memory-notes-utils.js replace
// assistant-identity-form.js and the tab/preview half of renderer-personality-utils.js.
// Script count moves by +1, eager count and the vendor lazy-load assertions are
// unchanged, and every added file is a plain renderer module — no vendor runtime
// landed as a synchronous <script>. Restores the established 20,000-byte headroom.
// +22,000 on 2026-08-21 (W13 Home ask mini-composer redesign): measured
// 9,012,611 canonical bytes. The delta is +10,566 across five renderer modules
// and NO new script: renderer-dashboard-ask-config.js (+5,867 for the F1/F2/F8/
// F11/F12 fixes and the comments recording them), renderer-dashboard-daybook.js
// (+4,122 for the in-flight latch, the autosize/filled refresh, and the send-
// click delegation), the two inventory primitives (+1,348 for the textarea
// `rows`/`spellcheck` options and the extracted option-list renderer), and
// renderer-dashboard-widgets-core.js (-771, since the ask region markup shrank).
// Script count, eager count, and the vendor lazy-load assertions are unchanged —
// no vendor runtime landed as a synchronous <script>, so this is not the
// regression class this budget guards. Restores the established 20,000-byte
// review headroom.
// +27_000 on 2026-09-01: same accumulated drift as the MAX_TOTAL_SCRIPT_COUNT note above
// (measured 9_052_886 with the test already red on main); the chat-timeline motion-polish
// modules account for ~5 KB of it. No vendor runtime landed as a synchronous <script>.
// +5_000 on 2026-09-01 (motion polish follow-ups): reasoning hand-off replay on the
// rebuild paths + collapsible reflow pin, ~1.2 KB across four existing scripts.
// +68_100 on 2026-09-01 (merge of wt/motion-css into main): main was ALREADY RED here before
// the merge - 633 scripts / 9_096_011 canonical bytes against 622 / 9_070_000, accumulated by
// programs that bumped the complexity ratchets but not this second, independent budget. The
// merge measures 9_118_100; re-based to that + the established 20_000 review headroom. No
// vendor runtime landed as a synchronous <script> - the lazy-load assertion below still passes.
// +13_900 on 2026-09-01 (wt/composer-vision): base commit 6988f09c already measured ~9_144_900
// (the llama-server/model-tuning series grew existing renderer modules without bumping this
// budget); W0 paste logging + reroute and the W1 vision gate add ~7_000 bytes across
// renderer-attachment-event-utils.js, renderer-attachment-queue-utils.js and the new
// renderer-composer-vision-gate.js (5.5 KB, plain UMD, no vendor payload). The W0c/W1
// fix-ups measured 9_152_953; raised to 9_173_000 for 20_000 bytes of review headroom.
// +32_000 on 2026-09-02 (merge of wt/composer-vision into main): main's skills/plugins rework
// grew renderer modules off the shared base (main sat at 9_138_100 on its side); the merged
// tree measures 9_184_157. Re-based to that + the established 20_000 review headroom.
// +25_000 on 2026-09-02 (plan-usage meter + model-fit programs): measured 9_209_845; re-based to
// that + the established 20_000 review headroom.
// +60_000 on 2026-09-03 (streaming perf program): +30,827 measured bytes across seven renderer
// files, dominated by markdown-stream-renderer.js at +21,276 (12,136 -> 33,412). That file grew
// the fence/table construct state machine that stops a streamed Markdown table re-parsing the
// whole accumulated body every frame -- previously an out-of-memory crash, not a slow frame.
// The rest: mailbox accounting +2,712, the new stream text cursor +2,616, byte-weighted render
// cache +1,957, reasoning merge +1,159, client metrics +965, markdown-utils +843, and
// live-events -701 as its cursor arithmetic moved out. Measured 9,257,113; the ceiling keeps
// this file's usual headroom above measured rather than sitting on it.
// +21_000 on 2026-09-04 (verification gate W3): the test-runner gate header module
// (renderer-ide-test-runner-gate-utils.js, ~10 KB), the panel's gate/attribution wiring, the
// history-strip ticks, and tool-call-utils' verify verdict line. Measured 9,290,085 in an
// isolated worktree holding only this program's files (the shared tree carried unrelated
// WIP); re-based to that + the established 20,000-byte review headroom.
// +22_000 on 2026-09-04 (python_execute reliability + approval legibility program, merged onto
// main after the verification gate): the approval card's three-button row, stated-intent
// attribution, per-tool disclosure noun, control-character stripping and facts for declared
// arguments (renderer-approval-block.js, tool-call-utils.js), plus the gap row carrying its
// tool name and full input across the reducer, stream-event translator and row projector so
// an approval that beats its tool_use event still names the tool. ~2,150 bytes over the
// previous ceiling; no vendor payload. Measured 9,313,153; re-based to that + the established
// 20,000-byte review headroom.
// +2_015 on 2026-09-04 (python_execute + approval program follow-up): the tool-approval-facts.js UMD header, factory wrapper and its binding lines in tool-call-utils.js; the moved bodies are byte-identical. Measured 9,315,015; re-based to that + the established 20,000-byte review headroom.
// +89_357 on 2026-09-04 (Astra work-order pack, 27 orders + final review fixes): session offline lockdown UI, workspace recovery panel (batch Undo/Review/conflict dialog/receipts), task-board session brief, streaming Markdown chunk lists, degraded-stream recovery, outbox stop hold, usage-meter fade, tool-row write treatment, scroll telemetry, plus the review fixes; no vendor payload, no new eager script. Measured 9,404,372; re-based to that + the established 20,000-byte review headroom.
// +23_150 on 2026-09-05 (long-thinking turn performance program): reasoning append-edit consumers (renderer-reasoning-entry-merge-utils.js, chat-message-utils.js, the per-stream merger, the turn reducer's retention coalescing), the trailing live window (reasoning-row-v2-utils.js, renderer-transcript-reasoning-v2.js), the fence-boundary stable-prefix rule and the reasoning render telemetry; no vendor payload, no new eager script. ~3,150 bytes over the previous ceiling. Measured 9,427,522; re-based to that + the established 20,000-byte review headroom.
// +38_594 bytes on 2026-09-05 (composer model picker): the two picker modules add the model catalog/popover UI without vendor payload. Measured 9,353,609; re-based to that + the established 20,000-byte review headroom.
// +14_731 on 2026-09-05 (Tasks Slice 0): five bounded plain renderer modules and their wiring measure 9,419,103 bytes; preserve the established 20,000-byte review headroom.
// +39_550 on 2026-09-05: Tasks rail controller + render module filled in (post-pack trio Slice A); measured 9,458,653.
// +31_168 on 2026-09-07 (merge of wt/plugin-sign-pipeline / Remote Control Slice 7b): two new modules and their bounded renderer wiring.
// +27_672 on 2026-09-07 (merge of wt/i18n-safety-101: i18n runtime core + one-time disclosure scene).
// +34_147 on 2026-09-07 (1.0.1 i18n migration Wave 2: jt()/jtn() wrappers and keys across Settings, the top chat modules,
// and the static index.html markers; no vendor payload). Measured 9,648,861; re-based to that + the established 20,000-byte review headroom.
// +170_182 on 2026-09-07 (1.0.1 i18n migration Waves 3-5: jt()/jtn() wrappers across shell, chat, setup scenes, IDE,
// features, shared, inventory and app modules, plus i18n-backend-strings.js; no vendor payload). Measured 9,839,043;
// re-based to that + the established 20,000-byte review headroom.
// 2026-09-08: combine hosted/chat/calendar/artifact growth with upstream translations.
// 2026-09-09 integration: sandbox settings, Remote Control setup, time formatting,
// and their translations. Independent review found no new vendor payload or eager loader.
// 2026-09-09 session-runtime M1: scoped UI controls and translated catalogs;
// measured 10,174,460 LF bytes, preserving the existing 20,000-byte headroom.
// 2026-09-10 approved runtime desktop integration: measured 10,215,713 LF bytes,
// including both lazy inspector owners; retain existing 20,000-byte headroom.
// 2026-09-15 Codex burn-day integration (wt/burn-landing merging fifteen wt/burn-* branches:
// JEN-039 copy table, JEN-008 reminder notifications, the 1.1 safety nets with the streak-cap
// Settings field, Astra review fix-ups, weight-aware virtualization, Reasoning Status V2,
// updater latch copy, Mermaid fail-closed, their translations): every branch stayed under the
// ceiling on its own; the merged tree measures 10,240,425 LF bytes (+4,712 over), with no
// vendor payload or eager loader. Re-based to that + the established 20,000-byte review headroom.
// 2026-09-16 Runtime UX program (approved 2026-09-16, NEXT_STEPS.md "Post-runtime program
// plan"): measured 10,247,073 LF bytes before Wave A1; pre-paid ~132,927 bytes for the six
// modules named at MAX_TOTAL_SCRIPT_COUNT plus their catalog growth, on top of the established
// 20,000-byte review headroom. A4 re-bases this to measured + 20,000 when the program lands.
// 2026-09-16 Runtime UX A1-A4 landed; re-based 2026-09-16: the program cost less than it
// pre-paid. The tree with A1-A4 and their 19 catalogs measures 10,376,704 LF bytes, under the
// pre-paid ceiling; re-based DOWN to that + the established 20,000-byte review headroom.
// 2026-09-16 split view W0-1/W0-2/W0-3 (approved 2026-09-16, NEXT_STEPS.md "Post-runtime
// program plan"): W0-1 (the pane surface cluster) landed inside the headroom above without
// re-basing; W0-2/W0-3 add 15,106 LF bytes (the two pane modules at 6,862 and 4,161, plus the
// retained-set policy, the boot seed and the rewired render gate in four existing files), which
// takes the measured total past it. No vendor payload and no eager loader: every byte is
// deferred renderer module source. Measured 10,409,001 LF bytes; re-based to that + the
// established 20,000-byte review headroom.
// 2026-09-18 local GGUF W4 (owner-directed, NEXT_STEPS.md "Owner-directed local GGUF models
// and per-model llama-server builds"; the plan allowed this re-base): the Model library's
// Local GGUF cards, Add GGUF model… / Remove from library, the Tune build row with its
// restart rules and the custom-build pill suffix, in ten existing modules, plus their catalog
// strings, add 62,933 LF bytes. No new script, no vendor payload, no eager loader. Measured
// 10,471,934 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-18 landing merge of main into local GGUF: main's workspace-folder project,
// global-root prompt and log path-redaction commits grew renderer and catalog source by
// 31,518 LF bytes, and the UNC path-trust fix adds its one string to every catalog; together
// they pass the W4 headroom. No new script, no vendor payload, no eager loader. Measured
// 10,492,744 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-20 Projects v2 (po-review, owner-approved; NEXT_STEPS.md "Projects v2"): the Settings ›
// Projects rewrite, the Runtime limits move, the Explorer header switcher, the welcome page rows,
// the composer project line, the Chats panel filter and their catalog strings across 19 locales
// grow existing renderer modules and catalogs by 77,044 LF bytes, of which the two lazily
// loaded modules (renderer-project-menu.js 12,717 and renderer-project-switcher.js 14,653,
// listed in STAGE4B_LAZY_MODULES below, no eager tag) are 27,370; no vendor payload.
// Measured 10,569,788 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-22 PDF reading add-on (1.2.0, po-review, owner-approved): the new deferred Settings
// module renderer-settings-pdf-addon.js (18,027) plus the tool-row link, failure summary,
// recovery action, add-on notes and CMP-TOOL-0047 string in existing modules; no vendor payload.
// Measured 10,608,728 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-23 1.2.0 gate fixes (A4 paused approval card, F5 effort, F9 reload question replay,
// DOCX section breaks, and the other landings since): growth inside existing deferred modules
// only; script count, eager count and vendor loading unchanged.
// Measured 10,634,272 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-24 1.2.0 gate fixes (F18, F25, F27, F36, F37 and their review follow-ups, the
// Markdown jsdom reuse): growth inside existing deferred modules only; script count, eager
// count and vendor loading unchanged.
// Measured 10,657,358 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-25 Split view W1-4c (approved plan docs/plans/split-view/W1_SPEC.md): the four pane tags
// named at MAX_TOTAL_SCRIPT_COUNT, the pane-routing growth in existing chat/shell modules and seven
// catalog strings across 20 locales grow the set by 74,796 LF bytes (base 32009be39 measured
// 10,518,662); no vendor payload, eager count unchanged.
// Measured 10,593,458 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-25 Split view W2-2b (brief docs/plans/split-view/B_W2_2B_BRIEF.md): per-pane attachments --
// the session-keyed queue helpers, the pane-scoped attachment bindings, the pane tray render and
// the pane composition's attach button/bindings grow existing deferred modules by 15,996 LF bytes
// (base 90c358754 measured 10,612,290 after W2-1 and W2-3); no new script, no vendor payload,
// eager count unchanged. Measured 10,628,286 LF bytes; re-based to that + the established
// 20,000-byte review headroom.
// 2026-09-25 Split view W2-2a (brief docs/plans/split-view/B_W2_2A_BRIEF.md): the one deferred
// renderer-pane-composer-rail.js tag named at MAX_TOTAL_SCRIPT_COUNT plus the pane-keyed preference
// seams in existing chat/shell modules and reasoning-effort-controls.js attachCarriers grow the set by
// 26,678 LF bytes (base 90c358754 measured 10,612,290); no vendor payload, eager count unchanged.
// Measured 10,638,968 LF bytes; re-based to that + the established 20,000-byte review headroom.
// Landed together 2026-09-25: each measurement above is against 90c358754; the merged tree is
// re-measured below: 10,655,579 LF bytes + the 20,000-byte review headroom.
// 2026-09-26 Split view W3-3 (spec docs/plans/split-view/W3_SPEC_2026-09-26.md §5): the composer
// settings fit and summary pill (renderer-pane-composer-rail.js createComposerSettingsFit), pane 0's
// mount in renderer-app-shell-bindings.js, the hidden-canvas holo gate, the run-mode chip skip, pane
// 0's rail session and nine new jt() strings grow existing deferred modules; no new script, no vendor
// payload, eager count unchanged. Measured 10,681,814 LF bytes; re-based to that + the established
// 20,000-byte review headroom.
// 2026-09-26 Split view W3-2 and W3-1 (same spec, §3 and limits a-d): the side panel owner wiring,
// the per-pane subagent monitor, per-pane selection ownership and its Shift+Click entry, per-pane
// composer notices, session-keyed preference activity and the pane-root drop highlight grow existing
// deferred modules (plus 44900f1b1's dropped-path attach); no new script, no vendor payload, eager
// count unchanged. Merged tree measured 10,722,669 LF bytes; re-based to that + the established
// 20,000-byte review headroom.
// 2026-09-26 Split view gate §D findings (side findings S1-S6, review P3s R1-R10): the context panel
// reopen button, per-pane inspector ids and path links, the model-catalog retry, per-pane slash menus,
// keyed-notice cleanup, pane-1 compaction progress and the send size guard grow existing deferred
// modules plus two catalog keys; no new script, no vendor payload, eager count unchanged. Merged tree
// measured 10,746,549 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-27 Workspace panels Phase 0 bug pass: stable inputs across re-renders (source control commit
// box, search query/replace, test-runner add form), location-aware panel routing, terminal focus /
// appearance / root-reset and resize dedupe grow existing deferred modules; no new script, no vendor
// payload, eager count unchanged. Branch tree measured 10,772,551 LF bytes; re-based to that + the
// established 20,000-byte review headroom.
// 2026-09-27 Collapsed composer settings popover (owner-approved PO review 2026-09-26, the settings
// list): whole-row clicks, row/segment keys, the pill's mode icon and caret, the sub-menu cover
// helpers and their three positioners (renderer-pane-composer-rail.js and callers, +12,393 bytes),
// plus the run-mode segments and the context/plan usage bar (+8,323 bytes) grow existing deferred
// modules; no new script, no vendor payload, eager count unchanged. Measured 10,770,593 LF bytes;
// re-based to that + the established 20,000-byte review headroom.
// 2026-09-27 merge of the branches above (workspace panels, composer popover, context rail, pane findings): re-based from the measured merged tree (10812284 LF bytes) + 20,000 headroom.
// 2026-09-27 Runs page (same spec, Wave R): the Runs view, the Runtime limits form, the one-poller
// controller (all three lazy), the runs/limits binders, the Runs registry entry and text-field's number
// type add 37,231 LF bytes net of the removed renderer-orchestration-view.js; no vendor payload, no eager
// tag. Raised by exactly that delta, so the existing review headroom is unchanged.
// 2026-09-27 Projects manager (same spec, Wave P) plus both waves' locale catalogs: the switcher's
// project cache and intents, the Settings › Projects manager, Move to project (row and bulk), the
// filter follow on New Chat, memory project labels and ~150 new jt() keys grow existing lazy modules
// and the catalogs; no new script, no vendor payload, eager count unchanged. The branch tree measured
// 10,836,234 LF bytes (the Wave R delta above was measured before the catalogs were rebuilt, so it
// had eaten the headroom); re-based to that + the established 20,000-byte review headroom.
// 2026-09-27 merge of wt/projects-runs onto the four branches above: re-based from the measured merged tree (10,900,552 LF bytes) + 20,000 headroom.
// 2026-09-27 GUI-gate fix batch (F1-F7, N1-N9 + the Astra review of those fixes): the rail/sidebar/dock
// saved-width rule and column sync, the changes-panel list queue, the pane-split pixel floor, the composer
// fit recheck, the scroll coordinator's smooth-navigation hold, dir=auto on message bodies and the Runs
// poller resume grow existing deferred modules; no new script, no vendor payload, eager count unchanged.
// Measured 10,922,728 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-27 OS notifications: two deferred modules + Settings copy-map rows. Measured 10,959,574 LF bytes;
// re-based to that + the established 20,000-byte review headroom.
// 2026-09-28 HB-009 waiting send: one deferred module (renderer-stuck-send.js) plus the strip, inbox and
// durable-send growth, on top of the B1 remediation merged since. Measured 10,990,547 LF bytes;
// re-based to that + the established 20,000-byte review headroom.
// 2026-09-28 Subagent Monitor v2 (+ its B3 merge and HB-019/HB-021 live-run fixes): one deferred module
// (renderer-subagent-rail.js) plus monitor view/model/bridge growth, +37,970 over the 11,007,836 measured
// just before it (including the rail's dropped document fallback); no vendor payload. Measured
// 11,045,806 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-29 UI wave (transcript views, open loops, shell chrome incl. tab rail / title bar / artifact panel /
// status loader / last-load memory and its review batches A-D), landed together on main 713d1086e. Per branch
// from base 9fb08d11d: transcript views +26,869 (renderer-transcript-view-utils.js deferred); open loops
// +35,674 (renderer-open-loop-row.js, renderer-open-loop-form.js deferred); shell chrome +87,805
// (renderer-startup-starfield.js and renderer-artifact-review-rail.js deferred, the rest growth in existing
// modules). No new eager script, no vendor payload. The merged tree was re-measured, never the union of the
// per-branch re-bases: 11,196,154 LF bytes; re-based to that + the established 20,000-byte review headroom.
// 2026-09-29 native image generation (wt/image-sdcpp): the deferred Model Library Image engine section
// (renderer/shell/model-library/model-library-image-engine.js) plus its mount in
// renderer-settings-model-library-section.js, the review-batch focus/cancel fixes, and 84 catalog strings
// across 20 locales; no new eager script, no vendor payload. Measured 11,220,652 LF bytes; re-based to
// that + the established 20,000-byte review headroom.
// 2026-09-30 composer Chat panel (tools slot module, family registry copy, composer.chatPanel.* catalog keys; the
// gear popover and interim tools popover deleted): measured 11,244,226 bytes; re-based to that + the 20,000-byte headroom.
// +31591 on 2026-09-30 timeline-perf: the row-list reconcile, bail-out reasons, Ctrl-gated wheel gate
// module and their comments (measured 11275817); re-based to measured + 20,000 bytes of headroom.
// Merged 2026-10-01: Answers tool runs, Settings cohesion S0/Wave 1 and the background-effects batch (Circuit Trace routed board, net of the other four effects' deletions): measured 11,397,809 bytes + 20,000 headroom.
// -6,539 on 2026-10-01 tips cache removal: renderer-tips-utils.js (2,429) plus the tips wiring in seven renderer modules (4,110), measured as that delta. Merged 2026-10-01: inline code suggestions removed, Settings Wave 2 with its review remediation (rows on one standard, the Limits page, the Tools dependent-row sync, catalog strings across 20 locales; no new eager script, no vendor payload), the tool timeline lifecycle fixes and dogfood B11: measured 11,366,200 bytes on the merged tree; re-based to that + the 20,000-byte headroom. | +34,842 on 2026-10-01 Workspace IDE review remediation (IDE-001..020): guards and their comments in 27 existing IDE modules (+19,081) and five catalog strings across 20 locales (+15,761); no new script, no vendor payload. Measured 11,390,872 bytes; re-based to that + the 20,000-byte headroom. | Merged 2026-10-01: dogfood B13 to B16, the installation lifecycle remediation and the engine lifecycle remediation (Model Library runtime actions) used all but 47 bytes of that headroom; no new eager script, no vendor payload. Measured 11,410,825 bytes on the merged tree; re-based to that + the 20,000-byte headroom.
const MAX_TOTAL_SCRIPT_BYTES = 11587534; // 2026-10-05 dogfood follow-ups: the approval receipt (HB-038 H2: shared receipt helpers, ten strings across the locale catalogs) and the deferred tail cushion module (HB-038, the blank room a shrink leaves at the end of a followed live reply); no vendor payload: measured 11,567,534 bytes + the 20,000-byte headroom. Before it: 2026-10-04 long-turn render costs, follow-up: the O(1) live-row check with its write notes, the single-walk expanded-row restore, and two deferred modules split out of article-markup and message-renderer at their caps (pure moves, no vendor payload): measured 11,539,049 bytes + the 20,000-byte headroom. Before it: 2026-10-04 long-turn render costs: the active-turn-root and full-render lanes reconcile the turn row list per row, the row-list shell parse, the per-row height-prediction text cache, and the reasoning-stack patcher split out of renderer-stream-reveal-utils.js at its cap (one deferred module, no vendor payload): measured 11,532,586 bytes + the 20,000-byte headroom. Before it: 2026-10-03 merged row 31 (diagnostics review) with row 32 (memory/resource incl. SIM-005): measured 11,503,231 bytes + the 20,000-byte headroom. Before it: 2026-10-03 memory/resource remediation (row 32): bounded renderer caches, DOCX history and media budgets, disposal fences, preview URL revocation, and the SIM-005 Workspace IDE manifest and first-use loader (the IDE group still counts here as lazy bytes); no vendor payload: measured 11,481,278 bytes + the 20,000-byte headroom. Before it: 2026-10-03 diagnostics review remediation: one deferred Diagnostics performance/budget module split out of render-utils at its cap, the remaining Diagnostics labels localized (about 110 new strings in the English and pseudo-locale catalogs), the focus helper and evidence-scope copy; no vendor payload: measured 11,482,638 bytes + the 20,000-byte headroom. Before it: 2026-10-03 neglected-areas remediation merged with the Settings live review: waves 1 to 3 add the Settings personality preview's byte-for-byte mirror of the sidecar sanitizer (ART-09), the calendar form, scratchpad and MCP fixes, and the shared frame disconnect registry, less the browser facade trims; no new script, no vendor payload: measured 11,461,107 bytes + the 20,000-byte headroom. Before it: 2026-10-03 Settings live review (rows that wrap, the revert on the title line, status truth on Models and Offline with a bounded catch-up read, Runs moved to a Diagnostics tab through a shared console seam, one empty message per list, the Ollama health fold, fourteen strings across 20 locales; no new eager script, no vendor payload): measured 11,452,576 bytes + the 20,000-byte headroom. Before it: 2026-10-02 owner-gate fix batch merged (the F20 admission-wait line module, the F27 figure caption and F8 find pill growth, eight new strings across 20 locales): measured 11,425,543 bytes + the 20,000-byte headroom. Before it: 2026-10-02 merged landing (timeline activity dot, chat width rename, plugin retirement stages 2 and 4: the cloud models settings module in, the plugin catalog module and its strings out): measured 11,410,688 bytes + the 20,000-byte headroom. Before it: 2026-10-02 timeline activity dot: three new eager modules (the sprite activity derivation and view applier, the dot morph engine, the activity row typed-state accessor) less the retired sprite holo wiring, no vendor payload: measured 11,408,553 bytes + the 20,000-byte headroom. Before it: 2026-10-02 Remote Control removed (the Settings section and composer banner modules, their wiring, 56 catalog strings across 20 locales), merged with the chat timeline review remediation and follow-ups (per-pane follow/reasoning/approval/search ownership, visible-text search, four catalog strings across 20 locales, two modules split out of capped files; no new eager script, no vendor payload): measured 11,382,845 bytes + the 20,000-byte headroom.
const MAX_EAGER_SCRIPT_COUNT = 16; // headroom above the measured 8 non-defer local scripts
const MAX_EAGER_SCRIPT_BYTES = 300_000; // repo-LOCAL eager bytes only; vendor re-adds are caught by the eagerVendorPattern assertion below, not this budget (measureLocalScripts skips node_modules/ + vendor/)
const STAGE4B_LAZY_MODULES = Object.freeze(require('../renderer/shell/renderer-ide-script-manifest').map(([src]) => src).concat([
  // Diagnostics › Runs (moved from Settings 2026-10-03) + Runtime limits: two views and one controller, loaded on first attach.
  'renderer/shell/renderer-runs-view.js',
  'renderer/shell/renderer-runtime-limits-view.js',
  'renderer/shell/renderer-orchestration-controller.js',
  // Projects v2 (2026-09-20): the shared project menu + switcher glue load on first open.
  'renderer/features/renderer-project-menu.js',
  'renderer/features/renderer-project-switcher.js',
]));

function readIndexHtml() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
}

// Measure canonical (LF) bytes, not raw on-disk bytes. These files are declared
// `text eol=lf` in .gitattributes, but a long-lived Windows checkout can still carry
// CRLF on disk while git reports the tree clean: git wrote them as CRLF before the
// attribute landed and memorized the CRLF size in the index stat cache, so the fast
// path never re-hashes and nothing ever flags the drift. A raw statSync() therefore
// made this ceiling machine-dependent, and every historical bump below was recorded
// against an inflated tree (2026-08-10 recorded 8,907,214 against an LF-true
// 8,718,829). Canonicalizing here is the same thing check_plugin_contract_freeze.py
// and the Stage 5-8 budget checks do before hashing, and it makes the constant mean
// the same number on every checkout.
function canonicalByteLength(absPath) {
  const buf = fs.readFileSync(absPath);
  let crlf = 0;
  for (let i = buf.indexOf(0x0d); i !== -1 && i < buf.length - 1; i = buf.indexOf(0x0d, i + 1)) {
    if (buf[i + 1] === 0x0a) crlf += 1;
  }
  return buf.length - crlf;
}

function measureLocalScripts(html) {
  const pattern = /<script\s+([^>]*)src="([^"]+)"([^>]*)><\/script>/gi;
  let match;
  const scripts = [];
  while ((match = pattern.exec(html)) !== null) {
    const src = match[2];
    if (src.startsWith('node_modules/') || src.startsWith('vendor/')) {
      continue; // vendor bytes are a separate, already-tracked budget (mermaid/monaco/xterm loaders)
    }
    const attrs = `${match[1]} ${match[3]}`;
    let bytes;
    try {
      bytes = canonicalByteLength(path.join(ROOT, src));
    } catch (_error) {
      bytes = 0; // a missing file is caught by renderer-shell-harness-parity.test.js, not this budget
    }
    scripts.push({ src, deferred: /\bdefer\b/.test(attrs), bytes });
  }
  return scripts;
}

test('production local renderer scripts stay within the eager-boot script/byte budget', () => {
  const indexedScripts = measureLocalScripts(readIndexHtml());
  const indexedSources = new Set(indexedScripts.map((script) => script.src));
  const lazyScripts = STAGE4B_LAZY_MODULES
    .filter((src) => !indexedSources.has(src))
    .map((src) => ({ src, deferred: true, bytes: canonicalByteLength(path.join(ROOT, src)) }));
  const scripts = [...indexedScripts, ...lazyScripts];
  const totalBytes = scripts.reduce((sum, s) => sum + s.bytes, 0);
  const eager = indexedScripts.filter((s) => !s.deferred);
  const eagerBytes = eager.reduce((sum, s) => sum + s.bytes, 0);

  assert.ok(
    scripts.length <= MAX_TOTAL_SCRIPT_COUNT,
    `index.html now loads ${scripts.length} local renderer scripts (budget: ${MAX_TOTAL_SCRIPT_COUNT}). ` +
    'If this growth is intentional, raise MAX_TOTAL_SCRIPT_COUNT in this test with a one-line note of why.'
  );
  assert.ok(
    totalBytes <= MAX_TOTAL_SCRIPT_BYTES,
    `index.html's local renderer scripts now total ${totalBytes} bytes (budget: ${MAX_TOTAL_SCRIPT_BYTES}). ` +
    'A large jump usually means a heavy dependency landed as a raw <script> instead of a lazy loader ' +
    '(see renderer-mermaid-runtime-loader.js / renderer-monaco-editor-utils.js / renderer-ide-xterm-loader.js).'
  );
  assert.ok(
    eager.length <= MAX_EAGER_SCRIPT_COUNT,
    `index.html now has ${eager.length} non-defer local scripts (budget: ${MAX_EAGER_SCRIPT_COUNT}): ` +
    `${eager.map((s) => s.src).join(', ')}`
  );
  assert.ok(
    eagerBytes <= MAX_EAGER_SCRIPT_BYTES,
    `index.html's non-defer local scripts now total ${eagerBytes} bytes (budget: ${MAX_EAGER_SCRIPT_BYTES}). ` +
    'Eager (non-defer) bytes block first paint; a hidden-until-activated surface\'s vendor runtime ' +
    'belongs behind a lazy loader (ensureScript), not a synchronous <script> tag.'
  );
});

test('xterm, KaTeX, Mermaid, and Monaco vendor runtimes are lazy-loaded, not eager <script> tags', () => {
  const html = readIndexHtml();
  const eagerVendorPattern = /<script\s+(?!.*\bdefer\b)[^>]*src="(node_modules\/(?:@xterm|katex|mermaid|monaco-editor)\/[^"]+)"[^>]*><\/script>/gi;
  const matches = [];
  let match;
  while ((match = eagerVendorPattern.exec(html)) !== null) {
    matches.push(match[1]);
  }
  assert.deepEqual(
    matches,
    [],
    `found eager <script> tags for xterm/KaTeX/Mermaid/Monaco runtimes that should be lazy-loaded: ${matches.join(', ')}`
  );
});
