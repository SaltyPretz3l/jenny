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
    state: { features: { featureFlags: {} } },
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
  // "Read-only" moved to the footer meta; the note is only cleared so a prior
  // artifact's loading/error note cannot linger.
  assert.deepEqual(notes, ['']);
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

test('V3 raw unified diff renders semantic rows with no toolbar row and no inline wrap control', () => {
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
  assert.ok(viewer);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--remove').length, 1);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--add').length, 1);
  assert.equal(surface.previewContent.querySelectorAll('.artifact-output-line--hunk').length, 1);
  assert.equal(surface.previewContent.querySelector('script'), null, 'diff text remains escaped');
  // Wrap is the header's, read from the panel class; the body carries no state.
  assert.equal(surface.previewContent.querySelector('[data-artifact-output-wrap], .artifact-output-toolbar'), null);
  assert.equal(viewer.classList.contains('is-wrapped') || viewer.classList.contains('is-nowrap'), false);
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

test('transcript-derived tool output clears the detail note instead of stating the read-only boilerplate', () => {
  const { surface } = makeDomSurface();
  const notes = [];
  renderTextArtifactKind({ surface, artifact: { outputText: 'hello world', diff: null }, deps: makeV3Deps(notes) });
  assert.deepEqual(notes, ['']);
  assert.equal(notes.some((note) => /Read-only|Transcript-derived/i.test(note)), false);
  assert.match(surface.previewContent.innerHTML, /hello world/);
});

// Area 3 body: file line numbers, key/value header lines, tokenized rows,
// pretty JSON, the 1,600-line footnote, and no rebuild on an unchanged render.
const { prettyPrintJson: projectionPrettyPrintJson } = require('../renderer/features/renderer-artifacts-projection');

function renderInto(artifact, deps = makeV3Deps([])) {
  const { dom, surface } = makeDomSurface();
  renderTextArtifactKind({ surface, artifact, deps });
  return { dom, surface, content: surface.previewContent };
}

const READ_OUTPUT = [
  'path: docs/REQUIREMENTS.md',
  'requested: offset=35, limit=3',
  'returned: lines 36-38 of 107',
  '',
  '## R5 Matching',
  'The rules run in this order.',
  '- M1 reference',
].join('\n');

test('read_file output: header lines are unnumbered key/value rows and the gutter starts at the returned line', () => {
  const { content } = renderInto({ outputText: READ_OUTPUT, diff: null, toolName: 'read_file' });
  const meta = [...content.querySelectorAll('.artifact-output-line--meta')];
  assert.equal(meta.length, 4, 'three header lines and the blank separator');
  for (const row of meta) {
    assert.equal(row.querySelector('.artifact-output-line-number').textContent, '', 'header rows are unnumbered');
    assert.equal(row.querySelector('[data-code-highlight-line]'), null, 'header rows are not code');
  }
  assert.equal(meta[0].querySelector('.artifact-output-meta-key').textContent, 'path:');
  assert.equal(meta[0].querySelector('.artifact-output-meta-value').textContent, 'docs/REQUIREMENTS.md');
  const numbers = [...content.querySelectorAll('.artifact-output-line:not(.artifact-output-line--meta) .artifact-output-line-number')].map((n) => n.textContent);
  assert.deepEqual(numbers, ['36', '37', '38']);
});

test('read_file output: content rows are tagged with the file language and decorated with token spans', () => {
  const { content } = renderInto({ outputText: READ_OUTPUT, diff: null, toolName: 'read_file' });
  const rows = [...content.querySelectorAll('.artifact-output-line-content[data-code-highlight-line]')];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.dataset.languageId === 'markdown'), 'the language comes from the path header');
  assert.ok(content.querySelector('.artifact-output-line-content .tok[class*="tok-"]'), '.tok-* spans present');
  assert.equal(rows[0].textContent, '## R5 Matching', 'decoration keeps the text');
});

test('only read_file / Read split a path header: other tools keep every line as output', () => {
  const yaml = ['path: config/app.yaml', 'name: demo', 'port: 8080'].join('\n');
  const { content } = renderInto({ outputText: yaml, diff: null, tool: { toolName: 'run_command' } });
  assert.equal(content.querySelectorAll('.artifact-output-line--meta').length, 0, 'no meta row for a command that printed YAML');
  const lines = [...content.querySelectorAll('.artifact-output-line-content')].map((node) => node.textContent);
  assert.deepEqual(lines, ['path: config/app.yaml', 'name: demo', 'port: 8080']);
  const read = renderInto({ outputText: READ_OUTPUT, diff: null, tool: { toolName: 'Read' } }).content;
  assert.equal(read.querySelectorAll('.artifact-output-line--meta').length, 4, 'the projected tool name (tool.toolName) still splits for Read');
});

test('a path from the artifact tags a body without a header', () => {
  const { content } = renderInto({ outputText: 'print(1)', diff: null, filePath: 'src/app.py' });
  assert.equal(content.querySelector('.artifact-output-line-content').dataset.languageId, 'python');
});

test('JSON output is pretty-printed and tagged json', () => {
  const deps = { ...makeV3Deps([]), prettyPrintJson: projectionPrettyPrintJson };
  const { content } = renderInto({ outputText: '{"ok":true,"items":[1,2]}', diff: null, toolName: 'run_command' }, deps);
  const rows = [...content.querySelectorAll('.artifact-output-line-content')];
  assert.ok(rows.length > 3, 'two-space pretty print spreads over rows');
  assert.equal(rows[1].textContent, '  "ok": true,');
  assert.ok(rows.every((row) => row.dataset.languageId === 'json'));
});

test('JSON output is parsed once: the pretty print reports it, no second detector re-parses', () => {
  const deps = { ...makeV3Deps([]), prettyPrintJson: projectionPrettyPrintJson };
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = function countingParse(...args) { parses += 1; return original.apply(this, args); };
  let content;
  try {
    content = renderInto({ outputText: '{"ok":true}', diff: null, toolName: 'run_command' }, deps).content;
  } finally {
    JSON.parse = original;
  }
  assert.equal(parses, 1);
  assert.equal(content.querySelector('.artifact-output-line-content').dataset.languageId, 'json');
  const scalar = renderInto({ outputText: '42', diff: null, toolName: 'run_command' }, deps).content;
  assert.equal(scalar.querySelector('[data-code-highlight-line]'), null, 'a bare scalar is not a JSON document');
});

test('plain command output stays untagged', () => {
  const { content } = renderInto({ outputText: 'collected 14 items\n1 failed, 13 passed', diff: null, toolName: 'run_command' });
  assert.equal(content.querySelector('[data-code-highlight-line]'), null);
  assert.deepEqual([...content.querySelectorAll('.artifact-output-line-number')].map((n) => n.textContent), ['1', '2']);
});

test('above 1,600 lines the gutter stays on the first 1,600 and a footnote says so', () => {
  const outputText = Array.from({ length: 1700 }, (_value, index) => `line ${index + 1}`).join('\n');
  const { content } = renderInto({ outputText, diff: null });
  assert.equal(content.querySelector('.artifact-output-pre'), null, 'no silent plain fallback');
  assert.equal(content.querySelectorAll('.artifact-output-line').length, 1600);
  const note = content.querySelector('.artifact-output-footnote');
  assert.ok(note, 'the limit is stated');
  assert.equal(note.textContent, 'Showing the first 1,600 lines · Download for the rest');
});

test('structured diffs pass the artifact path so hunks tokenize by language', () => {
  const { content } = renderInto({
    outputText: 'Wrote file',
    filePath: 'src/app.py',
    diff: { additions: 1, deletions: 0, truncated: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+print(1)'] }] },
  });
  assert.equal(content.querySelector('.diff-content[data-code-highlight-line]').dataset.languageId, 'python');
});

test('an unchanged second render keeps the body node (wrap and scroll survive)', () => {
  const { dom, surface } = makeDomSurface();
  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(surface.previewContent, 'innerHTML', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { writes += 1; descriptor.set.call(this, value); },
  });
  const artifact = { id: 'a', sessionId: 's', outputText: READ_OUTPUT, diff: null };
  renderTextArtifactKind({ surface, artifact, deps: makeV3Deps([]) });
  const node = surface.previewContent.firstElementChild;
  renderTextArtifactKind({ surface, artifact: { ...artifact }, deps: makeV3Deps([]) });
  assert.equal(writes, 1);
  assert.equal(surface.previewContent.firstElementChild, node);
});
