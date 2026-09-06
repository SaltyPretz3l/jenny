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
const MAX_TOTAL_SCRIPT_COUNT = 657; // measured 657 on 2026-09-05 (cherry-pick of wt/post-pack-trio Tasks Slice 0)
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
const MAX_TOTAL_SCRIPT_BYTES = 9_550_658; // measured 9,530,658 on 2026-09-05 (cherry-pick of wt/post-pack-trio Tasks rail), +20k headroom
const MAX_EAGER_SCRIPT_COUNT = 16; // headroom above the measured 8 non-defer local scripts
const MAX_EAGER_SCRIPT_BYTES = 300_000; // repo-LOCAL eager bytes only; vendor re-adds are caught by the eagerVendorPattern assertion below, not this budget (measureLocalScripts skips node_modules/ + vendor/)
const STAGE4B_LAZY_MODULES = Object.freeze([
]);

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
