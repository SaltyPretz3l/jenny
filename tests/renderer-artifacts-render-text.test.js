'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderTextArtifactKind } = require('../renderer/features/renderer-artifacts-render-text');
const { escapeHtml } = require('../renderer/shared/string-utils');

function makeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
}

function makeSurface() {
  return {
    editorShell: { classList: makeClassList() },
    previewContent: { classList: makeClassList(), innerHTML: '' },
  };
}

function makeDeps(notes) {
  return {
    escapeHtml,
    setDetailNote: (_surface, note) => notes.push(note),
    prettyPrintJson: (text) => String(text),
  };
}

function makeV3Deps(notes) {
  return {
    ...makeDeps(notes),
    state: { features: { featureFlags: { artifact_panel_v3: true } } },
  };
}

function makeDomSurface() {
  const dom = new JSDOM('<!doctype html><body><div id="editor"></div><div id="preview"></div></body>');
  return {
    dom,
    surface: {
      editorShell: dom.window.document.getElementById('editor'),
      previewContent: dom.window.document.getElementById('preview'),
    },
  };
}

test('diff-backed tool artifact renders the structured diff, not just the receipt', () => {
  const surface = makeSurface();
  const notes = [];
  renderTextArtifactKind({
    surface,
    artifact: {
      outputText: 'Wrote 275 bytes to workspace/hellodemo.md',
      diff: {
        additions: 9,
        deletions: 0,
        truncated: false,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+# Hello Demo!', '+Welcome to the demo'] }],
      },
    },
    deps: makeDeps(notes),
  });

  const html = surface.previewContent.innerHTML;
  assert.match(html, /diff-summary-add">\+9</);
  assert.match(html, /diff-line-add/);
  assert.match(html, /# Hello Demo!/);
  assert.match(html, /class="diff-status">Wrote 275 bytes to workspace\/hellodemo\.md</);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /artifact panel/);
});

test('truncated diff shows the too-large note without hunks', () => {
  const surface = makeSurface();
  const notes = [];
  renderTextArtifactKind({
    surface,
    artifact: {
      outputText: 'Wrote 999999 bytes to big.bin',
      diff: { additions: 5000, deletions: 4000, truncated: true, hunks: [] },
    },
    deps: makeDeps(notes),
  });

  const html = surface.previewContent.innerHTML;
  assert.match(html, /Diff too large to display/);
  assert.doesNotMatch(html, /diff-hunk/);
  assert.match(html, /diff-status/);
});

test('tool artifact without a diff falls back to the receipt pre block', () => {
  const surface = makeSurface();
  const notes = [];
  renderTextArtifactKind({
    surface,
    artifact: { outputText: 'listing complete', diff: null },
    deps: makeDeps(notes),
  });

  const html = surface.previewContent.innerHTML;
  assert.match(html, /artifact-preview-pre/);
  assert.match(html, /listing complete/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Transcript-derived tool output\. Read-only in the artifact panel\./);
});

test('non-size truncation reasons read as unavailable, not too-large', () => {
  const surface = makeSurface();
  const notes = [];
  renderTextArtifactKind({
    surface,
    artifact: {
      outputText: 'Wrote 10 bytes to x.bin',
      diff: { additions: 0, deletions: 0, truncated: true, truncation_reason: 'diff_generation_failed', hunks: [] },
    },
    deps: makeDeps(notes),
  });

  assert.match(surface.previewContent.innerHTML, /Diff unavailable/);
  assert.doesNotMatch(surface.previewContent.innerHTML, /too large/);
});

test('V3 raw unified diff renders an editor well with semantic rows and working wrap control', () => {
  const { surface } = makeDomSurface();
  const notes = [];
  const outputText = [
    'diff --git a/example.txt b/example.txt',
    'index 123..456 100644',
    '--- a/example.txt',
    '+++ b/example.txt',
    '@@ -1,2 +1,2 @@',
    '--- removed heading <script>',
    '+++ added heading & value',
    ' unchanged',
  ].join('\n');
  renderTextArtifactKind({ surface, artifact: { outputText, diff: null }, deps: makeV3Deps(notes) });

  const viewer = surface.previewContent.querySelector('.artifact-output-viewer');
  const wrap = surface.previewContent.querySelector('[data-artifact-output-wrap]');
  assert.ok(viewer);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--remove').length, 1);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--add').length, 1);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--hunk').length, 1);
  assert.equal(surface.previewContent.querySelector('script'), null, 'diff text remains escaped');
  assert.equal(wrap.getAttribute('aria-pressed'), 'true');
  assert.equal(wrap.getAttribute('title'), 'Wrap long lines');
  wrap.click();
  assert.equal(wrap.getAttribute('aria-pressed'), 'false');
  assert.equal(viewer.classList.contains('is-nowrap'), true);
});

test('V3 does not infer diff highlighting from arbitrary plus and minus lines', () => {
  const { surface } = makeDomSurface();
  renderTextArtifactKind({
    surface,
    artifact: { outputText: 'ordinary output\n+not an addition\n-not a deletion', diff: null },
    deps: makeV3Deps([]),
  });
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--neutral').length, 3);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--add, .artifact-output-line--remove').length, 0);
});

test('V3 bounds per-line DOM expansion for very large output', () => {
  const { surface } = makeDomSurface();
  const outputText = Array.from({ length: 1601 }, (_value, index) => `line ${index + 1}`).join('\n');
  renderTextArtifactKind({ surface, artifact: { outputText, diff: null }, deps: makeV3Deps([]) });
  assert.ok(surface.previewContent.querySelector('.artifact-output-pre'));
  assert.equal(surface.previewContent.querySelector('.artifact-output-line'), null);
  assert.match(surface.previewContent.textContent, /line 1601/);
});

test('V3 structured diffs use the same integrated output viewer', () => {
  const surface = makeSurface();
  renderTextArtifactKind({
    surface,
    artifact: {
      outputText: 'Wrote file',
      diff: { additions: 1, deletions: 1, truncated: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] },
    },
    deps: makeV3Deps([]),
  });
  assert.match(surface.previewContent.innerHTML, /artifact-output-viewer/);
  assert.match(surface.previewContent.innerHTML, /artifact-output-body--structured/);
  assert.match(surface.previewContent.innerHTML, /diff-line-remove/);
  assert.match(surface.previewContent.innerHTML, /diff-line-add/);
});
