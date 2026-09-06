'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  HTML_ARTIFACT_FRAME_FILL_CLASS,
} = require('../renderer/features/renderer-html-artifact-frame-utils');

const repoRoot = path.join(__dirname, '..');

function assertStylesheetContainsSelectors(stylesheetPath, selectors) {
  const css = fs.readFileSync(path.join(repoRoot, stylesheetPath), 'utf8');
  for (const selector of selectors) {
    assert.ok(css.includes(selector), `${stylesheetPath} should contain ${selector}`);
  }
  return css;
}

test('artifact panel CSS carries the fill-height HTML frame chain', () => {
  const fillClass = `.${HTML_ARTIFACT_FRAME_FILL_CLASS}`;
  // Every panel-chain gate must require a VISIBLE preview content: the
  // code-artifact renderer hides #artifactReviewPreviewContent without
  // clearing it, and a stale hidden fill host must never restructure the
  // panel around the editor.
  const visibleGate = `#artifactReviewPreviewContent:not(.hidden) ${fillClass}`;
  assertStylesheetContainsSelectors('styles/artifact-panel.css', [
    `#artifactReviewPanel .artifact-panel-v2-scroll:has(${visibleGate}) {`,
    `#artifactReviewPanel .artifact-review-detail-panel:has(${visibleGate}) {`,
    `#artifactReviewPanel #artifactReviewPreviewShell:has(${visibleGate}),\n`
      + `#artifactReviewPanel #artifactReviewPreviewContent:not(.hidden):has(${fillClass}) {`,
    `${fillClass} > iframe {`,
    `.artifact-file-preview-frame-host${fillClass} {`,
    `#artifactReviewPanel:not(.artifact-panel-v2) ${visibleGate} {`,
  ]);
});

test('IDE preview CSS adopts the fill-height HTML frame chain', () => {
  const fillClass = `.${HTML_ARTIFACT_FRAME_FILL_CLASS}`;
  assertStylesheetContainsSelectors('styles/ide-preview.css', [
    `.ide-preview-stage-body:has(${fillClass}) {`,
    `.ide-preview-frame-host${fillClass} {`,
  ]);
});

test('artifact HTML preview CSS keeps strip chrome fixed and failed fallback scrollable', () => {
  assertStylesheetContainsSelectors('styles/artifact-html-preview.css', [
    '.artifact-html-preview-strip {\n  flex: 0 0 auto;',
    // Doubled class so min-height:0/overflow:auto outrank the fill class's
    // later-imported 120px floor if a fill host is ever left behind.
    '.artifact-html-preview-host.artifact-html-preview-host--failed {\n  overflow: auto;\n  min-height: 0;',
  ]);
});
