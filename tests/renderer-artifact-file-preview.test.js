'use strict';

// Coverage for renderer/features/renderer-artifact-file-preview.js — the
// read-only chat-rail file preview (`file_preview` rail mode). JSDOM plus a
// stubbed versioned workspaceFs bridge; no full shell harness.
//
// The bridge contract under test: workspaceFs.readText / readImage never throw
// across the seam, so every failure must land in a bounded in-panel card,
// except the two rootless codes (0001 / 0008) which resolve FALSE so the chat
// click's IDE -> default-app -> toast ladder still runs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createArtifactFilePreview } = require('../renderer/features/renderer-artifact-file-preview');
const pathOpenUtils = require('../renderer/chat/renderer-chat-path-open');

const PANEL_HTML = '<aside id="artifactReviewPanel" data-artifact-review-mode="file_preview">'
  + '<div class="artifact-review-scroll">'
  + '<div id="artifactReviewDetailEmpty"></div>'
  + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel">'
  + '<span id="artifactReviewDetailKicker">kicker</span>'
  + '<span id="artifactReviewDetailTitle"><span class="artifact-panel-title-text">Title</span></span>'
  + '<span id="artifactReviewDetailPath">old/path.js</span>'
  + '<span id="artifactReviewDetailStatus">status</span>'
  + '<div id="artifactReviewDetailMeta"><b>meta</b></div>'
  + '<div id="artifactReviewProvenanceTimeline"><i>prov</i></div>'
  + '<div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>'
  + '<div id="artifactReviewEditorShell"></div>'
  + '<span id="artifactReviewDirtyBadge"></span>'
  + '<span id="artifactReviewSaveButton"></span>'
  + '<span id="artifactReviewRevertButton"></span>'
  + '<span id="artifactReviewRevealButton"></span>'
  + '<span id="artifactReviewOpenExternalButton"></span>'
  + '<span id="artifactReviewDeleteButton"></span>'
  + '</div></div></aside>';

function textPayload(content, overrides) {
  return Object.assign({
    ok: true, content, rootId: 'root-1', generation: 3, fileVersion: 'v1', truncated: false,
  }, overrides || {});
}

function imagePayload(overrides) {
  return Object.assign({
    ok: true, mime: 'image/png', base64: 'AAECAwQ=', rootId: 'root-1', generation: 3, fileVersion: 'v1',
  }, overrides || {});
}

function makeHarness(t, overrides) {
  const dom = new JSDOM('<!doctype html><html><body>' + PANEL_HTML + '</body></html>', {
    url: 'https://jenny.local/chat',
  });
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
  const calls = {
    readText: [], readImage: [], rail: [], renders: 0, logs: [], scrolls: [],
    mermaid: 0, mermaidHosts: [], decorate: 0, openInDefaultApp: [], ideEvents: [],
    frames: [], frameDisposes: 0,
  };
  const scrollContainer = doc.querySelector('.artifact-review-scroll');
  scrollContainer.scrollTo = (options) => { calls.scrolls.push(options); };

  const state = {
    ui: { activeView: 'chat', artifactReview: { mode: 'artifact', enabled: true, collapsed: false } },
  };
  const surface = {
    key: 'split',
    root: byId('artifactReviewPanel'),
    detailEmpty: byId('artifactReviewDetailEmpty'),
    detailPanel: byId('artifactReviewDetailPanel'),
    detailKicker: byId('artifactReviewDetailKicker'),
    detailTitle: byId('artifactReviewDetailTitle'),
    detailPath: byId('artifactReviewDetailPath'),
    detailStatus: byId('artifactReviewDetailStatus'),
    detailMeta: byId('artifactReviewDetailMeta'),
    detailNote: null,
    previewContent: byId('artifactReviewPreviewContent'),
    editorShell: byId('artifactReviewEditorShell'),
    saveButton: byId('artifactReviewSaveButton'),
    revertButton: byId('artifactReviewRevertButton'),
    revealButton: byId('artifactReviewRevealButton'),
    openExternalButton: byId('artifactReviewOpenExternalButton'),
    deleteButton: byId('artifactReviewDeleteButton'),
    provenanceTimeline: byId('artifactReviewProvenanceTimeline'),
    dirtyBadge: byId('artifactReviewDirtyBadge'),
    metaPane: null,
  };

  const workspaceFs = Object.assign({
    readText(payload) {
      calls.readText.push(payload);
      return Promise.resolve(textPayload('alpha\nbravo\ncharlie\ndelta'));
    },
    readImage(payload) {
      calls.readImage.push(payload);
      return Promise.resolve(imagePayload());
    },
    openInDefaultApp(payload) {
      calls.openInDefaultApp.push(payload);
      return Promise.resolve({ ok: true });
    },
  }, (overrides && overrides.workspaceFs) || {});

  dom.window.addEventListener('ide:open-file-at-line', (event) => {
    calls.ideEvents.push(event.detail);
  });

  const frameUtils = {
    createHtmlArtifactFrame(host, text, options) {
      const iframe = doc.createElement('iframe');
      host.appendChild(iframe);
      const call = { host, text, options, iframe };
      calls.frames.push(call);
      let frameDisposed = false;
      return {
        requestId: `frame-${calls.frames.length}`,
        dispose() {
          if (frameDisposed) return;
          frameDisposed = true;
          calls.frameDisposes += 1;
          iframe.remove();
        },
      };
    },
  };

  let controller = null;
  controller = createArtifactFilePreview(Object.assign({
    state,
    windowRef: dom.window,
    dom: { artifactReviewPanel: byId('artifactReviewPanel') },
    getWorkspaceFsApi: () => ((overrides && 'workspaceFs' in overrides && overrides.workspaceFs === null)
      ? null
      : workspaceFs),
    escapeHtml: (value) => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    markdownUtils: {
      renderMarkdown: (source) => '<div class="md">' + source + '</div>',
      renderInlineMermaidBlocks: (host) => { calls.mermaid += 1; calls.mermaidHosts.push(host); },
    },
    codeHighlight: {
      getLanguageId: (path) => (String(path).endsWith('.js') ? 'javascript' : ''),
      decorateCodeBlocks: () => { calls.decorate += 1; },
    },
    frameUtils,
    pathOpenUtils,
    openArtifactRail: (mode) => {
      calls.rail.push(mode);
      state.ui.artifactReview.mode = mode;
      state.ui.artifactReview.enabled = true;
      state.ui.artifactReview.collapsed = false;
    },
    renderArtifactReviewPanel: () => {
      calls.renders += 1;
      controller.renderRailContent(surface);
    },
    syncArtifactReviewLayout: () => {},
    appendClientLog: (level, event, payload) => { calls.logs.push({ level, event, payload }); },
  }, (overrides && overrides.deps) || {}));
  controller.bind();
  t.after(() => controller.dispose());

  return { dom, doc, state, surface, calls, controller, workspaceFs, host: surface.previewContent };
}

describe('openFilePreviewTarget — happy path', () => {
  test('renders a numbered read-only line list with the cited row marked and scrolled to', async (t) => {
    const h = makeHarness(t);
    const taken = await h.controller.openFilePreviewTarget({ path: 'renderer/app.js', line: 3, column: 5 });

    assert.equal(taken, true);
    assert.deepEqual(h.calls.rail, ['file_preview']);
    assert.equal(h.calls.readText.length, 1);
    assert.equal(h.calls.readText[0].intent, 'preview');
    assert.equal(h.calls.readText[0].maxBytes, 512000);

    const rows = h.host.querySelectorAll('.artifact-file-preview-row');
    assert.equal(rows.length, 4, 'one <li> per source line');
    assert.equal(h.host.querySelectorAll('ol.artifact-file-preview-code').length, 1);
    assert.deepEqual(
      Array.from(rows).map((row) => row.getAttribute('data-preview-line')),
      ['1', '2', '3', '4']
    );
    const cited = h.host.querySelectorAll('.artifact-file-preview-row.is-cited');
    assert.equal(cited.length, 1);
    assert.equal(cited[0].getAttribute('data-preview-line'), '3');
    assert.equal(cited[0].getAttribute('aria-current'), 'true');
    assert.equal(h.calls.scrolls.length, 1, 'the cited row scrolls the rail container');
    assert.equal(h.calls.decorate, 1, 'the highlighter runs once over the rendered list');
    assert.equal(h.host.querySelector('code').getAttribute('data-language-id'), 'javascript');
    assert.deepEqual(h.controller.getFilePreviewTarget(), { path: 'renderer/app.js', line: 3, column: 5 });
  });

  test('a long file renders a bounded window plus a truncation note', async (t) => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
    const h = makeHarness(t, { workspaceFs: { readText: () => Promise.resolve(textPayload(lines)) } });
    await h.controller.openFilePreviewTarget({ path: 'big/file.txt', line: 3000 });

    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 2000);
    const note = h.host.querySelector('.artifact-file-preview-note');
    assert.ok(note, 'truncation note renders');
    assert.match(note.textContent, /Showing lines 2900–4899 of 5000\./);
    assert.equal(h.host.querySelector('.artifact-file-preview-row.is-cited').getAttribute('data-preview-line'), '3000');
  });
});

describe('kind routing', () => {
  test('markdown with no cited line renders the sanitized document', async (t) => {
    const h = makeHarness(t, { workspaceFs: { readText: () => Promise.resolve(textPayload('# Title')) } });
    await h.controller.openFilePreviewTarget({ path: 'docs/readme.md' });

    assert.ok(h.host.querySelector('.artifact-file-preview-doc'), 'document view');
    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 0);
    assert.equal(h.calls.mermaid, 1, 'the shared lazy mermaid pass runs on the doc');
    assert.equal(h.calls.mermaidHosts[0], h.host.querySelector('.artifact-file-preview-doc'));
    assert.ok(h.host.querySelector('[data-file-preview-view="read"]'), 'Read/Source toggle is offered');
  });

  test('markdown WITH a cited line opens in the code view and can toggle back to Read', async (t) => {
    const h = makeHarness(t, { workspaceFs: { readText: () => Promise.resolve(textPayload('# Title\nbody\ntail')) } });
    await h.controller.openFilePreviewTarget({ path: 'docs/readme.md', line: 2 });

    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 3, 'code view for a cited line');
    assert.equal(h.host.querySelector('.artifact-file-preview-row.is-cited').getAttribute('data-preview-line'), '2');

    h.host.querySelector('[data-file-preview-view="read"]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.ok(h.host.querySelector('.artifact-file-preview-doc'), 'toggling to Read swaps in the document view');
  });

  test('images read through readImage and render a data URL, never readText', async (t) => {
    const h = makeHarness(t);
    await h.controller.openFilePreviewTarget({ path: 'assets/logo.png' });

    assert.equal(h.calls.readImage.length, 1);
    assert.deepEqual(h.calls.readImage[0], { path: 'assets/logo.png' });
    assert.equal(h.calls.readText.length, 0, 'image files never hit the text reader');
    const img = h.host.querySelector('.artifact-file-preview-image img');
    assert.ok(img);
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,AAECAwQ=');
    assert.equal(h.calls.decorate, 0, 'no code highlighting on an image');
  });
});

describe('sandboxed HTML routing', () => {
  test('html with no cited line renders the sandboxed frame in Read view by default', async (t) => {
    const source = '<!doctype html><h1>Preview</h1><script>window.ready = true</script>';
    const h = makeHarness(t, { workspaceFs: { readText: () => Promise.resolve(textPayload(source)) } });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    assert.ok(h.host.querySelector('[data-file-preview-frame-host]'));
    assert.equal(h.calls.frames.length, 1);
    assert.equal(h.calls.frames[0].text, source, 'the full source is handed to the frame factory');
    assert.equal(h.calls.frames[0].options.requestKey, 'site/page.html');
    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 0);
    assert.equal(h.calls.decorate, 0, 'the code highlighter never runs over a frame host');
    const read = h.host.querySelector('[data-file-preview-view="read"]');
    assert.ok(read, 'Read/Source toggle is offered');
    assert.equal(read.getAttribute('aria-pressed'), 'true');
  });

  test('html file previews mount the frame in fill sizing', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    assert.equal(h.calls.frames[0].options.sizing, 'fill');
  });

  test('html WITH a cited line opens in Source and can toggle to Read', async (t) => {
    const source = '<main>one</main>\n<p>two</p>\n<footer>three</footer>';
    const h = makeHarness(t, { workspaceFs: { readText: () => Promise.resolve(textPayload(source)) } });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html', line: 2 });

    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 3);
    assert.equal(h.host.querySelector('.artifact-file-preview-row.is-cited').getAttribute('data-preview-line'), '2');
    assert.equal(h.calls.frames.length, 0);

    h.host.querySelector('[data-file-preview-view="read"]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(h.calls.frames.length, 1);
    assert.ok(h.host.querySelector('[data-file-preview-frame-host]'));
  });

  test('the self-contained note is visible only in the html Read view', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    const note = h.host.querySelector('[data-file-preview-note]');
    assert.ok(note);
    assert.match(note.textContent, /Self-contained preview/);

    h.host.querySelector('[data-file-preview-view="code"]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(h.host.querySelector('[data-file-preview-note]'), null);
  });

  test('frame failure falls back to Source and logs a redacted WARN', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    h.calls.frames[0].options.onFailure({ ok: false, error: 'boom' });

    assert.ok(h.host.querySelector('.artifact-file-preview-row'), 'source listing replaces the failed frame');
    assert.equal(h.host.querySelector('[data-file-preview-view="read"]'), null, 'the toggle is disabled after failure');
    const warn = h.calls.logs.find((entry) => entry.event === 'artifact_file_preview.frame_failed');
    assert.ok(warn);
    assert.equal(warn.level, 'WARN');
    assert.equal(warn.payload.kind, 'html');
    assert.equal(warn.payload.message, 'boom');
    assert.equal('path' in warn.payload, false, 'frame failure logs never carry paths');
  });

  test('repeated rail renders hold the live frame instead of rebuilding it', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    h.controller.renderRailContent(h.surface);
    h.controller.renderRailContent(h.surface);
    h.controller.renderRailContent(h.surface);

    assert.equal(h.calls.frames.length, 1, 'streaming repaint churn must not recreate the frame');
    assert.equal(h.calls.frameDisposes, 0, 'the live frame remains mounted');
  });

  test('holding the live frame across repaints preserves the fill options', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    h.controller.renderRailContent(h.surface);
    h.controller.renderRailContent(h.surface);

    assert.equal(h.calls.frames.length, 1);
    assert.equal(h.calls.frames[0].options.sizing, 'fill');
  });

  test('opening a non-html target disposes the previous frame', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: {
        readText: ({ path }) => Promise.resolve(textPayload(path.endsWith('.html') ? '<h1>Preview</h1>' : 'const next = true;')),
      },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });
    await h.controller.openFilePreviewTarget({ path: 'renderer/next.js' });

    assert.equal(h.calls.frameDisposes, 1);
    assert.equal(h.host.querySelector('[data-file-preview-frame-host]'), null);
    assert.ok(h.host.querySelector('.artifact-file-preview-row'));
  });

  test('toggling an html preview to Source disposes the frame', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    h.host.querySelector('[data-file-preview-view="code"]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(h.calls.frameDisposes, 1);
    assert.ok(h.host.querySelector('.artifact-file-preview-row'));
  });

  test('truncated html is forced to Source with the truncation note and no toggle', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<main>open\ncontent', { truncated: true })) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    assert.equal(h.calls.frames.length, 0);
    assert.ok(h.host.querySelector('.artifact-file-preview-row'));
    assert.ok(h.host.querySelector('.artifact-file-preview-note'), 'existing truncation handling remains visible');
    assert.equal(h.host.querySelector('[data-file-preview-view="read"]'), null);
  });

  test('the html render kill switch restores the legacy code-only view', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    h.state.features = { featureFlags: { file_preview_html_render: false } };
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });

    assert.ok(h.host.querySelector('.artifact-file-preview-row'));
    assert.equal(h.host.querySelector('[data-file-preview-view]'), null);
    assert.equal(h.calls.frames.length, 0);
  });

  test('an absent html flag key keeps the default-on render path enabled', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    h.state.features = { featureFlags: {} };
    await h.controller.openFilePreviewTarget({ path: 'site/page.htm' });

    assert.equal(h.calls.frames.length, 1);
    assert.ok(h.host.querySelector('[data-file-preview-frame-host]'));
  });
});

describe('bounded failure cards', () => {
  test('a binary file (0013) lands in a card with a WARN log and an Open-in-IDE affordance', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: {
        readText: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0013', message: 'binary' }),
      },
    });
    const taken = await h.controller.openFilePreviewTarget({ path: 'bin/blob.dat' });

    assert.equal(taken, true, 'the rail still owns the target — it shows the reason in-panel');
    const card = h.host.querySelector('[data-file-preview-state="binary"]');
    assert.ok(card);
    assert.ok(card.querySelector('[data-file-preview-open-ide]'), 'Open in IDE is offered');
    assert.ok(card.querySelector('[data-file-preview-retry]'), 'Try again is offered');
    const warn = h.calls.logs.find((entry) => entry.event === 'artifact_file_preview.read_failed');
    assert.ok(warn);
    assert.equal(warn.level, 'WARN');
    assert.equal(warn.payload.code, 'CMP-WORKSPACEFS-0013');
    assert.equal('path' in warn.payload, false, 'log payloads carry codes, never paths');
  });

  test('an ok:true hex-preview read (editable:false) lands in the binary card, not a hex dump', async (t) => {
    // intent:'preview' decodes non-UTF-8 bytes as a hex sample with
    // editable:false instead of failing (versioned-workspace-file-encoding).
    const h = makeHarness(t, {
      workspaceFs: {
        readText: () => Promise.resolve(textPayload('00000000  4d 5a 90 00  |MZ..|', { editable: false })),
      },
    });
    const taken = await h.controller.openFilePreviewTarget({ path: 'bin/tool.exe' });

    assert.equal(taken, true, 'the rail still owns the target');
    assert.ok(h.host.querySelector('[data-file-preview-state="binary"]'), 'binary card shown');
    assert.equal(h.host.querySelector('.artifact-file-preview-code'), null, 'no hex dump rendered as code');
    const warn = h.calls.logs.find((entry) => entry.event === 'artifact_file_preview.read_failed');
    assert.ok(warn);
    assert.equal(warn.payload.code, 'binary_preview');
  });

  test('the true BINARY error code (0010) maps to the binary card too', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0010' }) },
    });
    await h.controller.openFilePreviewTarget({ path: 'bin/blob.dat' });
    assert.ok(h.host.querySelector('[data-file-preview-state="binary"]'));
  });

  test('a too-large file (0011) lands in its own card', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve({ ok: false, code: 'CMP-WORKSPACEFS-0011' }) },
    });
    await h.controller.openFilePreviewTarget({ path: 'big/huge.log' });
    assert.ok(h.host.querySelector('[data-file-preview-state="too-large"]'));
  });

  test('an image failure (0014) lands in a card rather than a broken <img>', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readImage: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0014' }) },
    });
    await h.controller.openFilePreviewTarget({ path: 'assets/weird.bmp' });
    assert.ok(h.host.querySelector('[data-file-preview-state="image-unsupported"]'));
    assert.equal(h.host.querySelectorAll('img').length, 0);
  });

  test('a structurally invalid payload is refused instead of rendered', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve({ ok: true, content: 'x' }) },
    });
    await h.controller.openFilePreviewTarget({ path: 'a/b.js' });
    assert.ok(h.host.querySelector('[data-file-preview-state="failed"]'));
    const warn = h.calls.logs.find((entry) => entry.payload?.code === 'invalid_payload');
    assert.ok(warn);
  });

  test('a thrown bridge call degrades to the generic card without escaping', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.reject(new Error('preload torn down')) },
    });
    const taken = await h.controller.openFilePreviewTarget({ path: 'a/b.js' });
    assert.equal(taken, true);
    assert.ok(h.host.querySelector('[data-file-preview-state="failed"]'));
  });
});

describe('declining ownership (the caller falls back to the IDE ladder)', () => {
  test('ROOT_MISSING (0001) resolves false and hands the rail back to artifact mode', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0001' }) },
    });
    const taken = await h.controller.openFilePreviewTarget({ path: 'a/b.js' });

    assert.equal(taken, false);
    assert.equal(h.state.ui.artifactReview.mode, 'artifact', 'no dead preview is left on the rail');
    assert.equal(h.controller.getFilePreviewTarget(), null);
  });

  test('ROOT_TRANSITIONING (0008) resolves false too', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0008' }) },
    });
    assert.equal(await h.controller.openFilePreviewTarget({ path: 'a/b.js' }), false);
  });

  test('a missing workspaceFs bridge resolves false without throwing or opening the rail', async (t) => {
    const h = makeHarness(t, { workspaceFs: null });
    const taken = await h.controller.openFilePreviewTarget({ path: 'a/b.js', line: 2 });
    assert.equal(taken, false);
    assert.deepEqual(h.calls.rail, [], 'the rail is never flipped when the read can never happen');
  });

  test('unsafe paths are refused before any bridge call', async (t) => {
    const h = makeHarness(t);
    for (const path of ['/etc/passwd', 'C:/secrets.txt', 'a/../../b.js', '', null]) {
      assert.equal(await h.controller.openFilePreviewTarget({ path }), false, String(path));
    }
    assert.equal(h.calls.readText.length, 0);
    assert.deepEqual(h.calls.rail, []);
  });
});

describe('lifecycle', () => {
  test('a stale slower read never repaints over the newer target', async (t) => {
    let releaseFirst = null;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    let call = 0;
    const h = makeHarness(t, {
      workspaceFs: {
        readText() {
          call += 1;
          return call === 1 ? first : Promise.resolve(textPayload('second-one\nsecond-two'));
        },
      },
    });

    const stale = h.controller.openFilePreviewTarget({ path: 'old/first.js', line: 1 });
    const fresh = h.controller.openFilePreviewTarget({ path: 'new/second.js', line: 2 });
    assert.equal(await fresh, true);
    releaseFirst(textPayload('first-one\nfirst-two\nfirst-three'));
    await stale;

    assert.equal(h.controller.getFilePreviewTarget().path, 'new/second.js');
    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 2, 'the newer 2-line file wins');
    assert.match(h.host.textContent, /second-one/);
    assert.equal(/first-one/.test(h.host.textContent), false);
  });

  test('renderRailContent hides every artifact-mode affordance and clears the shared header', async (t) => {
    const h = makeHarness(t);
    await h.controller.openFilePreviewTarget({ path: 'a/b.js', line: 1 });

    assert.equal(h.surface.editorShell.classList.contains('hidden'), true);
    assert.equal(h.surface.saveButton.classList.contains('hidden'), true);
    assert.equal(h.surface.revertButton.classList.contains('hidden'), true);
    assert.equal(h.surface.revealButton.classList.contains('hidden'), true);
    assert.equal(h.surface.openExternalButton.classList.contains('hidden'), true);
    assert.equal(h.surface.deleteButton.classList.contains('hidden'), true);
    assert.equal(h.surface.dirtyBadge.classList.contains('hidden'), true);
    assert.equal(h.surface.detailPanel.classList.contains('hidden'), false);
    assert.equal(h.surface.detailEmpty.classList.contains('hidden'), true);
    assert.equal(h.surface.previewContent.classList.contains('hidden'), false);
    assert.equal(h.surface.detailKicker.textContent, '');
    assert.equal(h.surface.detailTitle.querySelector('.artifact-panel-title-text').textContent, '');
    assert.equal(h.surface.detailPath.textContent, '');
    assert.equal(h.surface.detailStatus.textContent, '');
    assert.equal(h.surface.detailMeta.innerHTML, '');
    assert.equal(h.surface.provenanceTimeline.innerHTML, '', 'stale provenance never bleeds into the preview');
  });

  test('the retry affordance re-reads the same target', async (t) => {
    let attempt = 0;
    const h = makeHarness(t, {
      workspaceFs: {
        readText() {
          attempt += 1;
          return attempt === 1
            ? Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0011' })
            : Promise.resolve(textPayload('recovered'));
        },
      },
    });
    await h.controller.openFilePreviewTarget({ path: 'a/b.js' });
    h.host.querySelector('[data-file-preview-retry]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(attempt, 2);
    assert.match(h.host.textContent, /recovered/);
  });

  test('the Open-in-IDE affordance re-enters the shared event marked preferIde', async (t) => {
    const h = makeHarness(t);
    await h.controller.openFilePreviewTarget({ path: 'a/b.js', line: 4 });
    h.host.querySelector('[data-file-preview-open-ide]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.equal(h.calls.ideEvents.length, 1);
    assert.deepEqual(h.calls.ideEvents[0], { path: 'a/b.js', line: 4, column: null, preferIde: true });
  });

  // The V3 panel HEADER's Open-in-IDE button (added 2026-08-20) reuses this
  // same panel-level delegation instead of adding a second handler: it is
  // rendered with data-file-preview-open-ide, outside the preview body.
  test('the panel-header Open-in-IDE button routes through the same rail delegation', async (t) => {
    const h = makeHarness(t);
    await h.controller.openFilePreviewTarget({ path: 'a/b.js', line: 4 });
    const before = h.calls.ideEvents.length;

    const header = h.doc.createElement('div');
    header.innerHTML = require('../renderer/features/renderer-artifact-panel-chrome-render')
      .buildOpenIdeButtonHtml();
    h.doc.getElementById('artifactReviewPanel').appendChild(header);
    header.querySelector('.artifact-panel-open-ide')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.equal(h.calls.ideEvents.length, before + 1);
    assert.deepEqual(h.calls.ideEvents[before], { path: 'a/b.js', line: 4, column: null, preferIde: true });
  });

  test('handleWorkspaceRootCommitted drops the target and leaves artifact mode', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });
    h.controller.handleWorkspaceRootCommitted();
    assert.equal(h.controller.getFilePreviewTarget(), null);
    assert.equal(h.state.ui.artifactReview.mode, 'artifact');
    assert.equal(h.calls.frameDisposes, 1, 'the root switch disposes the old-root frame');
  });

  test('dispose is idempotent and detaches the rail delegates', async (t) => {
    const h = makeHarness(t, {
      workspaceFs: { readText: () => Promise.resolve(textPayload('<h1>Preview</h1>')) },
    });
    await h.controller.openFilePreviewTarget({ path: 'site/page.html' });
    const before = h.calls.ideEvents.length;

    h.controller.dispose();
    h.controller.dispose();

    assert.equal(h.calls.frameDisposes, 1, 'dispose tears down the frame exactly once');
    h.host.querySelector('[data-file-preview-open-ide]')
      .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(h.calls.ideEvents.length, before, 'the delegate no longer fires after dispose');
    assert.equal(await h.controller.openFilePreviewTarget({ path: 'a/b.js' }), false, 'disposed controllers decline');
  });
});
