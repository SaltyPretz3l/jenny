'use strict';

// Pure coverage for renderer/features/renderer-artifact-file-preview-render.js:
// extension -> kind routing, the bounded line window (including the
// cited-line re-centring), the CMP-WORKSPACEFS failure map, and HTML escaping
// of attacker-influenced path/content text. No DOM, no IPC.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const render = require('../renderer/features/renderer-artifact-file-preview-render');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const OPTIONS = { escapeHtml };

describe('resolveFilePreviewKind', () => {
  test('routes markdown-family extensions to the markdown renderer', () => {
    for (const path of ['docs/a.md', 'docs/a.markdown', 'd/a.mmd', 'd/a.mermaid', 'D/A.MD']) {
      assert.equal(render.resolveFilePreviewKind(path), 'markdown', path);
    }
  });

  test('routes the mirrored image extension list to the image renderer', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']) {
      assert.equal(render.resolveFilePreviewKind(`assets/pic.${ext}`), 'image', ext);
    }
  });

  test('html/htm route to the sandboxed html kind', () => {
    for (const path of ['a/index.html', 'a/index.htm', 'A/INDEX.HTML']) {
      assert.equal(render.resolveFilePreviewKind(path), 'html', path);
    }
  });

  test('everything else falls through to the code view', () => {
    for (const path of ['a/app.js', 'a/main.py', 'a/Makefile', 'a/.gitignore', '']) {
      assert.equal(render.resolveFilePreviewKind(path), 'code', path);
    }
  });

  test('exports the exact mirrored html extension set', () => {
    // Mirrors renderer-ide-preview-stage.js and workspace-present-tool.js.
    assert.deepEqual(Array.from(render.HTML_EXTENSIONS), ['html', 'htm']);
  });
});

describe('sliceCodeWindow', () => {
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);

  test('short files render whole and are not truncated', () => {
    const result = render.sliceCodeWindow(['a', 'b', 'c'], null, 2000);
    assert.deepEqual(result.lines, ['a', 'b', 'c']);
    assert.equal(result.startLine, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.totalLines, 3);
  });

  test('long files render the head window when nothing is cited', () => {
    const result = render.sliceCodeWindow(long, null, 2000);
    assert.equal(result.lines.length, 2000);
    assert.equal(result.startLine, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.totalLines, 5000);
    assert.equal(result.lines[0], 'line 1');
  });

  test('a cited line inside the head window keeps the head window', () => {
    const result = render.sliceCodeWindow(long, 1999, 2000);
    assert.equal(result.startLine, 1);
    assert.equal(result.truncated, true);
  });

  test('a cited line beyond the cap slides the window so it sits ~100 lines down', () => {
    const result = render.sliceCodeWindow(long, 3000, 2000);
    assert.equal(result.startLine, 2900);
    assert.equal(result.lines[0], 'line 2900');
    assert.equal(result.lines[100], 'line 3000');
    assert.equal(result.lines.length, 2000);
    assert.equal(result.truncated, true);
  });

  test('a cited line near EOF clamps the window to the last full page', () => {
    const result = render.sliceCodeWindow(long, 4990, 2000);
    assert.equal(result.startLine, 3001, 'never scrolls past the final window');
    assert.equal(result.lines[result.lines.length - 1], 'line 5000');
  });

  test('line 1 and malformed cited lines behave like no citation', () => {
    for (const cited of [1, 0, -4, null, undefined, 'nope', NaN]) {
      assert.equal(render.sliceCodeWindow(long, cited, 2000).startLine, 1, String(cited));
    }
  });

  test('malformed inputs degrade to an empty, non-truncated window', () => {
    const result = render.sliceCodeWindow(null, 5, null);
    assert.deepEqual(result.lines, []);
    assert.equal(result.totalLines, 0);
    assert.equal(result.truncated, false);
  });
});

describe('describeFilePreviewFailure', () => {
  const cases = [
    ['CMP-WORKSPACEFS-0001', 'root-missing', false],
    ['CMP-WORKSPACEFS-0003', 'outside-root', false],
    ['CMP-WORKSPACEFS-0004', 'not-found', false],
    ['CMP-WORKSPACEFS-0008', 'root-transitioning', false],
    ['CMP-WORKSPACEFS-0011', 'too-large', true],
    ['CMP-WORKSPACEFS-0012', 'image-too-large', true],
    ['CMP-WORKSPACEFS-0013', 'binary', true],
    ['CMP-WORKSPACEFS-0014', 'image-unsupported', true],
  ];

  for (const [code, stateKind, retryInIde] of cases) {
    test(`${code} maps to ${stateKind}`, () => {
      const viaErrorCode = render.describeFilePreviewFailure({ ok: false, error_code: code });
      assert.equal(viaErrorCode.stateKind, stateKind);
      assert.equal(viaErrorCode.retryInIde, retryInIde);
      assert.ok(viaErrorCode.message.length > 0);
      // `code` is the legacy alias on the same seam result.
      assert.equal(render.describeFilePreviewFailure({ ok: false, code }).stateKind, stateKind);
    });
  }

  test('malformed, unknown, and absent results fall through to the generic failure', () => {
    for (const input of [undefined, null, {}, { ok: false }, { ok: false, code: 'nope' }, 42, 'CMP-WORKSPACEFS-0004']) {
      const described = render.describeFilePreviewFailure(input);
      assert.equal(described.stateKind, 'failed', JSON.stringify(input));
      assert.equal(described.retryInIde, true);
    }
  });
});

describe('markup escaping and shape', () => {
  test('the bar labels html as Sandboxed HTML', () => {
    const html = render.buildFilePreviewBarHtml({ kind: 'html', path: 'a/x.html' }, OPTIONS);
    assert.ok(html.includes('Sandboxed HTML'));
  });

  test('the bar renders an escaped note only when one is present', () => {
    const withNote = render.buildFilePreviewBarHtml({
      kind: 'html', path: 'a/x.html', note: '<b>x</b>',
    }, OPTIONS);
    assert.ok(withNote.includes('<span class="artifact-file-preview-bar-note" data-file-preview-note>&lt;b&gt;x&lt;/b&gt;</span>'));
    const withoutNote = render.buildFilePreviewBarHtml({ kind: 'html', path: 'a/x.html' }, OPTIONS);
    assert.equal(withoutNote.includes('artifact-file-preview-bar-note'), false);
  });

  test('the frame host is a single empty host and never creates an iframe', () => {
    const html = render.buildFilePreviewFrameHostHtml();
    assert.equal((html.match(/data-file-preview-frame-host/g) || []).length, 1);
    assert.equal(html.includes('<iframe'), false);
  });

  test('exports the IDE stage self-contained preview note', () => {
    assert.equal(typeof render.SELF_CONTAINED_NOTE, 'string');
    assert.ok(render.SELF_CONTAINED_NOTE.length > 0);
    assert.match(render.SELF_CONTAINED_NOTE, /external .* are not loaded\./);
  });

  test('a script-shaped path is escaped in the bar (name, dir, and title)', () => {
    const html = render.buildFilePreviewBarHtml({
      path: 'a<script>alert(1)</script>/b<img>.js', line: 7, kind: 'code',
    }, OPTIONS);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('<img>'), false);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Line 7'));
    assert.ok(html.includes('data-file-preview-open-ide'));
  });

  test('a </code> payload inside file content cannot break out of its row', () => {
    const html = render.buildCodeListHtml({
      lines: ['ok', '</code><script>alert(1)</script>', 'tail'],
      startLine: 10,
      languageId: 'javascript',
      citedLine: 11,
    }, OPTIONS);
    assert.equal(html.includes('</code><script>'), false);
    assert.ok(html.includes('&lt;/code&gt;&lt;script&gt;'));
    assert.equal((html.match(/<li /g) || []).length, 3);
    assert.ok(html.includes('data-preview-line="10"'));
    assert.ok(html.includes('data-preview-line="11" aria-current="true"'));
    assert.ok(html.includes('class="artifact-file-preview-row is-cited"'));
    assert.ok(html.includes('data-code-highlight-line data-language-id="javascript"'));
    assert.ok(html.includes('start="10"'));
  });

  test('the view toggle only renders when the caller allows it', () => {
    const withToggle = render.buildFilePreviewBarHtml({ path: 'a/b.md', kind: 'markdown', view: 'code', canToggleView: true }, OPTIONS);
    assert.ok(withToggle.includes('data-file-preview-view="read"'));
    assert.ok(withToggle.includes('data-file-preview-view="code"'));
    assert.ok(withToggle.includes('title="View rendered"'));
    assert.ok(withToggle.includes('title="View raw source"'));
    assert.ok(/aria-pressed="true"[^>]*data-file-preview-view="code"/.test(withToggle));
    const without = render.buildFilePreviewBarHtml({ path: 'a/b.md', kind: 'markdown' }, OPTIONS);
    assert.equal(without.includes('data-file-preview-view'), false);
  });

  test('state cards escape their message and carry the requested affordances', () => {
    const card = render.buildFilePreviewStateHtml('binary', 'Nope <b>x</b>', { escapeHtml, retry: true });
    assert.ok(card.includes('data-file-preview-state="binary"'));
    assert.ok(card.includes('Nope &lt;b&gt;x&lt;/b&gt;'));
    assert.ok(card.includes('data-file-preview-open-ide'));
    assert.ok(card.includes('data-file-preview-retry'));
    const bare = render.buildFilePreviewStateHtml('loading', 'Loading…', { escapeHtml, openInIde: false });
    assert.equal(bare.includes('data-file-preview-open-ide'), false);
    assert.equal(bare.includes('data-file-preview-retry'), false);
  });
});
