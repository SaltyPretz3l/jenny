// UIUX-004 residual (Wave 2): priority-order pane collapse in the 701–1180px
// band that W0-F's 640×560 window floor made reachable.
//
// Priority 1 (context panel yields to the artifact rail) already exists:
// `.chat-view.artifact-review-mode > .chat-context-panel { display: none }`
// in context-panel.css — pinned here so it can't silently regress.
//
// Priority 2 is the gap this suite closes: the rail's inline
// `--artifact-review-width` is only recomputed when the panel opens
// (renderer-artifacts-utils.js setProperty; no resize listener), so shrinking
// the window mid-session leaves a stale up-to-560px rail crushing the
// minmax(0,1fr) thread column — ~150px thread at a 720px window. The CSS
// clamp enforces the documented 50%-of-window bound
// (renderer-artifact-review-prefs.js resolveEffectiveArtifactReviewWidth)
// continuously, for both the V2 and legacy width paths. Below 700px the
// existing fixed-overlay block owns the rail instead, so the clamp band is
// bounded on both sides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const chatMediaQueriesCss = fs.readFileSync(
  path.join(rootDir, 'styles', 'chat-media-queries.css'),
  'utf8'
);
const contextPanelCss = fs.readFileSync(
  path.join(rootDir, 'styles', 'context-panel.css'),
  'utf8'
);

test('context panel yields whenever the artifact rail is open (priority 1)', () => {
  assert.match(
    contextPanelCss,
    /\.chat-view\.artifact-review-mode > \.chat-context-panel\s*\{\s*display:\s*none;/,
    'the artifact rail and context panel must never fight for the same band'
  );
});

test('compact desktop widths hide the context rail before it crushes the thread', () => {
  assert.match(
    chatMediaQueriesCss,
    /@media \(max-width:\s*1040px\)\s*\{[\s\S]*?--context-panel-width:\s*0px;[\s\S]*?\.chat-view > \.chat-context-panel\s*\{\s*display:\s*none;/,
    'an expanded sessions panel and context rail must not reduce the chat thread to an unusable sliver'
  );
});

// The bound tracks resolveArtifactReviewMaxWidth in
// renderer-artifact-review-prefs.js — raised from 50% to 90% of the window on
// 2026-08-20 so the rail can be dragged nearly full width.
test('701–1180 band clamps the artifact rail to the 90%-of-window bound (priority 2)', () => {
  assert.match(
    chatMediaQueriesCss,
    /@media \(max-width:\s*1180px\) and \(min-width:\s*701px\)\s*\{[\s\S]*?\.chat-view > \.artifact-review-panel\s*\{[\s\S]*?width:\s*min\(var\(--artifact-review-width,\s*420px\),\s*90vw\);[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*90vw;/,
    'a stale persisted rail width must not crush the thread column after a window shrink'
  );
});

test('the clamp band stays out of the ≤700 overlay block', () => {
  const overlayBlock = chatMediaQueriesCss.match(
    /@media \(max-width:\s*700px\)\s*\{[\s\S]*?\.chat-view > \.artifact-review-panel\s*\{[\s\S]*?\}/
  );
  assert.ok(overlayBlock, 'the ≤700 fixed-overlay treatment must remain');
  assert.match(
    overlayBlock[0],
    /position:\s*fixed;/,
    'below 700px the rail stays an overlay, not a clamped grid column'
  );
});
