'use strict';

/* Preview stage controls: Reload (bar + card actions), the Live cue, the
 * transient link-blocked note and the navigated-away auto-return. The frame
 * factory is faked through the global (resolveModule checks globals first). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ideState = require('../renderer/features/renderer-ide-state');
const { createIdePreviewStage } = require('../renderer/features/renderer-ide-preview-stage');

const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

// Manual timers so the 700 ms / 4 s holds are asserted without sleeping.
function makeTimers(domWindow) {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    windowRef: {
      DOMParser: domWindow.DOMParser,
      setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; },
      clearTimeout: (id) => { pending.delete(id); },
    },
    fireAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
}

function makeStage(t, { files = {}, buffers = {}, watchActive = false, fileOperations = null } = {}) {
  const dom = new JSDOM('<div id="idePreviewHost" class="hidden"></div>');
  const hostEl = dom.window.document.getElementById('idePreviewHost');
  const ide = ideState.createIdeUiState();
  const timers = makeTimers(dom.window);
  const state = { watchActive, frames: [], frameDisposals: 0, markdownRenders: 0 };
  globalThis.markdownUtils = {
    renderMarkdown: (source) => { state.markdownRenders += 1; return `<p>${escapeHtml(source)}</p>`; },
    renderInlineMermaidBlocks: () => {},
  };
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source, options) => {
      state.frames.push({ host, source, options });
      return { dispose: () => { state.frameDisposals += 1; } };
    },
  };
  t.after(() => {
    delete globalThis.markdownUtils;
    delete globalThis.rendererHtmlArtifactFrameUtils;
  });
  const stage = createIdePreviewStage({
    getDom: () => ({ idePreviewHost: hostEl }),
    getIde: () => ide,
    ideStateUtils: ideState,
    escapeHtml,
    editorHost: {
      hasDocument: (path) => path in buffers,
      getValue: (path) => buffers[path] || '',
      getAltVersionId: () => 1,
    },
    getWorkspaceFsApi: () => ({
      readText: async (payload) => (payload.path in files
        ? {
          ok: true, path: payload.path, pathKey: payload.path, content: files[payload.path],
          rootId: 'root-a', generation: 1, fileVersion: 'vf2_x', editable: true,
        }
        : { ok: false, code: 'CMP-WORKSPACEFS-0004' }),
    }),
    getFileOperations: () => fileOperations,
    isWatchActive: () => state.watchActive,
    windowRef: timers.windowRef,
  });
  t.after(() => stage.dispose());
  return { stage, ide, hostEl, timers, state, window: dom.window };
}

async function show(h, path) {
  ideState.setPreviewPath(h.ide, path);
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
}

const lastFrame = (h) => h.state.frames[h.state.frames.length - 1];
const bar = (h) => h.hostEl.querySelector('.ide-preview-stage-bar');

test('Reload re-renders an unchanged markdown file and an unchanged HTML file', async (t) => {
  const md = makeStage(t, { files: { 'a.md': 'ONE' } });
  await show(md, 'a.md');
  assert.equal(md.state.markdownRenders, 1);
  md.stage.sync(true);
  await settle();
  assert.equal(md.state.markdownRenders, 1, 'sync alone skips an unchanged file');
  md.hostEl.querySelector('[data-preview-reload]').click();
  await settle();
  assert.equal(md.state.markdownRenders, 2, 'Reload bypasses the unchanged skip');

  const html = makeStage(t, { files: { 'a.html': '<p>x</p>' } });
  await show(html, 'a.html');
  assert.equal(html.state.frames.length, 1);
  lastFrame(html).options.onSuccess();
  html.stage.reload();
  await settle();
  assert.equal(html.state.frames.length, 2, 'a fresh frame is staged for the same file');
  assert.equal(html.state.frameDisposals, 0, 'the previous page stays up until the new one is ready');
  lastFrame(html).options.onSuccess();
  assert.equal(html.state.frameDisposals >= 1, true, 'the previous frame is disposed once the new one succeeds');
});

test('Reload after a frame failure produces a fresh frame, from the card action', async (t) => {
  const h = makeStage(t, { files: { 'a.html': '<p>x</p>' } });
  await show(h, 'a.html');
  lastFrame(h).options.onFailure({ error: 'boom' });
  const card = h.hostEl.querySelector('[data-preview-state="frame-failed"]');
  assert.ok(card);
  const action = card.querySelector('[data-preview-reload]');
  assert.ok(action, 'the failure card carries an action');
  assert.equal(action.textContent.trim(), 'Try again');

  action.click();
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.equal(h.hostEl.querySelector('[data-preview-state]'), null, 'the card is replaced by the new frame');
});

test('card actions: missing -> Try again, navigated-away -> Reload preview, others none', async (t) => {
  const h = makeStage(t, { files: { 'a.html': '<p>x</p>', 'big.md': 'x' } });
  await show(h, 'gone.md');
  const missing = h.hostEl.querySelector('[data-preview-state="missing"] [data-preview-reload]');
  assert.equal(missing.textContent.trim(), 'Try again');

  ideState.setPreviewPath(h.ide, 'x.html');
  ideState.setPreviewPath(h.ide, 'a.html');
  h.stage.sync(true);
  await settle();
  const frame = lastFrame(h);
  frame.options.onNavigatedAway();
  await settle();
  const second = lastFrame(h);
  second.options.onNavigatedAway();
  const nav = h.hostEl.querySelector('[data-preview-state="navigated-away"]');
  assert.equal(nav.querySelector('[data-preview-reload]').textContent.trim(), 'Reload preview');

  ideState.setPreviewPath(h.ide, '');
  h.stage.sync(true);
  await settle();
  assert.equal(h.hostEl.querySelector('[data-preview-state="empty"] [data-preview-reload]'), null);
});

test('the bar carries Reload for a path and none for the empty state', async (t) => {
  const h = makeStage(t, { files: { 'a.md': 'ONE' } });
  h.stage.sync(true);
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.equal(bar(h).querySelector('[data-preview-reload]'), null, 'no path, no Reload');
  await show(h, 'a.md');
  const button = bar(h).querySelector('[data-preview-reload]');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('aria-label'), 'Reload preview');
  assert.ok(bar(h).querySelector('.ide-preview-stage-tools.ide-editor-actions'));
});

test('Live is hidden without a watcher, shown with one, and absent on failure cards', async (t) => {
  const off = makeStage(t, { files: { 'a.md': 'ONE' } });
  await show(off, 'a.md');
  assert.equal(bar(off).querySelector('[data-preview-live]'), null);

  const h = makeStage(t, { files: { 'a.md': 'ONE', 'b.html': '<p>x</p>' }, watchActive: true });
  await show(h, 'a.md');
  const live = bar(h).querySelector('[data-preview-live]');
  assert.ok(live);
  assert.match(live.textContent, /Live/);
  assert.ok(live.querySelector('.status-dot--muted'));

  ideState.setPreviewPath(h.ide, 'gone.md');
  h.stage.sync(true);
  await settle();
  assert.equal(bar(h).querySelector('[data-preview-live]'), null, 'missing card has no cue');

  // HTML only counts as live once the frame reports success.
  ideState.setPreviewPath(h.ide, 'b.html');
  h.stage.sync(true);
  await settle();
  assert.equal(bar(h).querySelector('[data-preview-live]'), null, 'not before the frame succeeds');
  lastFrame(h).options.onSuccess();
  assert.ok(bar(h).querySelector('[data-preview-live]'));
  h.stage.reload();
  await settle();
  lastFrame(h).options.onFailure({ error: 'x' });
  assert.equal(bar(h).querySelector('[data-preview-live]'), null, 'failure card has no cue');
});

test('refreshLiveCue follows the watcher state', async (t) => {
  const h = makeStage(t, { files: { 'a.md': 'ONE' } });
  await show(h, 'a.md');
  assert.equal(bar(h).querySelector('[data-preview-live]'), null);
  h.state.watchActive = true;
  h.stage.refreshLiveCue();
  assert.ok(bar(h).querySelector('[data-preview-live]'));
  h.state.watchActive = false;
  h.stage.refreshLiveCue();
  assert.equal(bar(h).querySelector('[data-preview-live]'), null);
});

test('an external update shows Updating for at least 700 ms and keeps the Reload node', async (t) => {
  const h = makeStage(t, { files: { 'a.md': 'ONE' }, watchActive: true });
  await show(h, 'a.md');
  const reloadNode = bar(h).querySelector('[data-preview-reload]');

  h.stage.handleExternalChange({ relPath: 'a.md', kind: 'changed' });
  await settle();
  const live = bar(h).querySelector('[data-preview-live]');
  assert.match(live.textContent, /Updating/);
  assert.ok(live.querySelector('.status-dot--active'));
  const settleTimers = [...h.timers.pending.values()].filter((timer) => timer.ms > 600 && timer.ms <= 700);
  assert.equal(settleTimers.length, 1, 'settling is held for the remainder of 700 ms');

  h.timers.fireAll();
  assert.match(bar(h).querySelector('[data-preview-live]').textContent, /Live/);
  assert.equal(bar(h).querySelector('[data-preview-reload]'), reloadNode, 'the Reload button node survives the cue change');
});

test('a newer update restarts the hold; dispose clears pending timers', async (t) => {
  const h = makeStage(t, { files: {}, buffers: { 'a.md': 'ONE' }, watchActive: true });
  ideState.openTab(h.ide, 'a.md');
  await show(h, 'a.md');
  h.stage.handleModelChange('a.md');
  assert.ok(h.timers.pending.size >= 1, 'debounce timer pending');
  h.stage.dispose();
  assert.equal(h.timers.pending.size, 0, 'dispose clears every timer');
});

test('the link-blocked note shows for 4 s then restores the previous note', async (t) => {
  const h = makeStage(t, { files: { 'a.html': LINKED, 's.css': 'p{}' } });
  await show(h, 'a.html');
  const frame = lastFrame(h);
  frame.options.onSuccess();
  const original = bar(h).querySelector('[data-preview-note]').textContent;
  frame.options.onLinkBlocked();
  assert.match(bar(h).querySelector('[data-preview-note]').textContent, /Links don’t open in the preview/);
  const noteTimer = [...h.timers.pending.values()].find((timer) => timer.ms === 4000);
  assert.ok(noteTimer, 'a 4000 ms timer restores the note');
  frame.options.onSuccess();
  assert.match(bar(h).querySelector('[data-preview-note]').textContent, /Links don’t open/, 'survives a bar re-render');
  h.timers.fireAll();
  assert.equal(bar(h).querySelector('[data-preview-note]').textContent, original);
});

test('the transient note is dropped when the path changes', async (t) => {
  const h = makeStage(t, { files: { 'a.html': '<p>x</p>', 'b.md': 'B' } });
  await show(h, 'a.html');
  lastFrame(h).options.onLinkBlocked();
  ideState.setPreviewPath(h.ide, 'b.md');
  h.stage.sync(true);
  await settle();
  assert.equal(bar(h).querySelector('[data-preview-note]'), null);
  assert.equal([...h.timers.pending.values()].some((timer) => timer.ms === 4000), false);
});

test('a first navigation auto-returns and re-stages; a second within 5 s shows the card', async (t) => {
  const h = makeStage(t, { files: { 'a.html': '<p>x</p>' } });
  await show(h, 'a.html');
  const first = lastFrame(h);
  first.options.onNavigatedAway();
  await settle();
  assert.equal(h.state.frames.length, 2, 'the document is staged again');
  assert.match(bar(h).querySelector('[data-preview-note]').textContent, /The page tried to leave, so the preview went back/);

  const second = lastFrame(h);
  second.options.onNavigatedAway();
  await settle();
  assert.equal(h.state.frames.length, 2, 'no further re-stage');
  const card = h.hostEl.querySelector('[data-preview-state="navigated-away"]');
  assert.ok(card);
  assert.match(card.textContent, /“a\.html” tried to open another page, and the preview can only show this file\./);
});

test('stale frame callbacks are ignored', async (t) => {
  const h = makeStage(t, { files: { 'a.html': '<p>x</p>' } });
  await show(h, 'a.html');
  const stale = lastFrame(h);
  h.stage.reload();
  await settle();
  assert.equal(h.state.frames.length, 2);
  stale.options.onNavigatedAway();
  await settle();
  assert.equal(h.state.frames.length, 2, 'a stale navigation does not re-stage');
  assert.equal(h.hostEl.querySelector('[data-preview-state]'), null);
});

test('dispose removes the delegated click handlers and ignores reload', async (t) => {
  const h = makeStage(t, { files: { 'a.md': 'ONE' } });
  await show(h, 'a.md');
  const button = bar(h).querySelector('[data-preview-reload]');
  const renders = h.state.markdownRenders;
  h.stage.dispose();
  button.click();
  h.stage.reload();
  await settle();
  assert.equal(h.state.markdownRenders, renders);
});

// ---- linked files, swap and cue ----

const LINKED = '<link rel="stylesheet" href="s.css"><p>x</p>';
const cue = (h) => bar(h).querySelector('[data-preview-live]');
const noteText = (h) => bar(h).querySelector('[data-preview-note]')?.textContent ?? null;

async function showLinked(t, extra = {}) {
  const h = makeStage(t, { files: { 'a.html': LINKED, 's.css': 'p{color:red}' }, watchActive: true, ...extra });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  return h;
}

test('a linked stylesheet is built into the staged page and named in the note', async (t) => {
  const h = await showLinked(t);
  assert.match(lastFrame(h).source, /p\{color:red\}/);
  assert.equal(noteText(h), '1 linked file loaded');
  assert.equal(bar(h).querySelector('[data-preview-note]').getAttribute('title'), 'Loaded: s.css');
});

test('scripts build in too; a missing file and web links are named by reason in the title', async (t) => {
  const html = '<script src="app.js"></script><script src="missing.js"></script><script src="https://x.test/a.js"></script>';
  const h = makeStage(t, { files: { 'site/index.html': html, 'site/app.js': 'window.__linked = 1;' } });
  await show(h, 'site/index.html');
  assert.match(lastFrame(h).source, /window\.__linked = 1;/);
  assert.equal(noteText(h), '1 loaded, 2 not loaded');
  const title = bar(h).querySelector('[data-preview-note]').getAttribute('title');
  assert.match(title, /Loaded: site\/app\.js/);
  assert.match(title, /Not loaded: missing\.js \(file not found\)/);
  assert.match(title, /1 web address not loaded/);
});

test('a page with no linked files shows no note', async (t) => {
  const h = makeStage(t, { files: { 'a.html': '<p>x</p>' } });
  await show(h, 'a.html');
  assert.equal(noteText(h), null);
});

test('a linked file change is debounced and shows Updating before it re-stages', async (t) => {
  const h = await showLinked(t);
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  assert.equal(h.state.frames.length, 1, 'nothing renders before the debounce');
  assert.ok([...h.timers.pending.values()].some((timer) => timer.ms === 600), 'a 600 ms debounce is pending');
  assert.match(cue(h).textContent, /Updating/);
});

test('a changed linked file re-stages with the new content; an unchanged build does not', async (t) => {
  const files = { 'a.html': LINKED, 's.css': 'p{color:red}' };
  const h = makeStage(t, { files, watchActive: true });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  h.timers.fireAll();

  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.frames.length, 1, 'same css text builds the same page: nothing re-staged');

  files['s.css'] = 'p{color:blue}';
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.match(lastFrame(h).source, /color:blue/);
  assert.equal(h.state.frameDisposals, 0, 'the old page stays until the new one succeeds');
  lastFrame(h).options.onSuccess();
  assert.equal(h.state.frameDisposals, 1);
});

test('a linked file buffer edit re-stages through the model-change path', async (t) => {
  const buffers = { 's.css': 'p{color:red}' };
  const h = makeStage(t, { files: { 'a.html': LINKED }, buffers });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  buffers['s.css'] = 'p{color:green}';
  h.stage.handleModelChange('s.css');
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.match(lastFrame(h).source, /color:green/);
});

test('a linked file change while Preview is hidden re-renders on the next sync', async (t) => {
  const files = { 'a.html': LINKED, 's.css': 'p{color:red}' };
  const h = makeStage(t, { files });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  ideState.setStageSurface(h.ide, 'editor');
  files['s.css'] = 'p{color:blue}';
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  await settle();
  assert.equal([...h.timers.pending.values()].some((timer) => timer.ms === 600), false, 'no render is scheduled while hidden');
  assert.equal(h.state.frames.length, 1);
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.match(lastFrame(h).source, /color:blue/);
});

test('an unrelated file change is ignored', async (t) => {
  const h = await showLinked(t);
  h.stage.handleExternalChange({ relPath: 'other.css', kind: 'changed' });
  h.stage.handleModelChange('other.css');
  assert.equal([...h.timers.pending.values()].some((timer) => timer.ms === 600), false);
});

test('the cue stays through an HTML rebuild and shows Updating until the new page is ready', async (t) => {
  const files = { 'a.html': LINKED, 's.css': 'p{color:red}' };
  const h = makeStage(t, { files, watchActive: true });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  assert.match(cue(h).textContent, /Live/);

  files['s.css'] = 'p{color:blue}';
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  assert.match(cue(h).textContent, /Updating/);
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.ok(cue(h), 'the cue does not vanish on rebuild');
  assert.match(cue(h).textContent, /Updating/);
  lastFrame(h).options.onSuccess();
  h.timers.fireAll();
  assert.match(cue(h).textContent, /Live/);
});

test('the Reload button node survives a rebuild with an unchanged note', async (t) => {
  const files = { 'a.html': LINKED, 's.css': 'p{color:red}' };
  const h = makeStage(t, { files, watchActive: true });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  const button = bar(h).querySelector('[data-preview-reload]');
  files['s.css'] = 'p{color:blue}';
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.equal(bar(h).querySelector('[data-preview-reload]'), button, 'the bar is not redrawn');
});

test('a transient note carries no title', async (t) => {
  const h = await showLinked(t);
  lastFrame(h).options.onLinkBlocked();
  const note = bar(h).querySelector('[data-preview-note]');
  assert.match(note.textContent, /Links don’t open/);
  assert.equal(note.hasAttribute('title'), false);
});

test('a stale read settles the Updating cue', async (t) => {
  const state = { stale: false };
  const payload = {
    content: 'ONE', editable: true, rootId: 'r', generation: 1, pathKey: 'a.md', fileVersion: 'v1',
  };
  const fileOperations = {
    beginPreview: (path) => path,
    readForPreview: async () => (state.stale ? { stale: true } : { payload }),
    cancelPreviewIntents: () => {},
  };
  const h = makeStage(t, { files: {}, watchActive: true, fileOperations });
  await show(h, 'a.md');
  state.stale = true;
  h.stage.handleExternalChange({ relPath: 'a.md', kind: 'changed' });
  assert.match(cue(h).textContent, /Updating/);
  await settle();
  h.timers.fireAll();
  assert.match(cue(h).textContent, /Live/);
});

test('a sync during the linked-file debounce does not render twice', async (t) => {
  const files = { 'a.html': LINKED, 's.css': 'p{color:red}' };
  const h = makeStage(t, { files, watchActive: true });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  files['s.css'] = 'p{color:blue}';
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  h.stage.sync(true);
  await settle();
  assert.equal(h.state.frames.length, 1, 'sync waits for the debounce');
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.match(lastFrame(h).source, /color:blue/);
});

test('a linked file edited while Preview is hidden shows on the next sync', async (t) => {
  const files = { 'a.html': LINKED, 's.css': 'p{color:red}' };
  const h = makeStage(t, { files, watchActive: true });
  await show(h, 'a.html');
  lastFrame(h).options.onSuccess();
  ideState.setStageSurface(h.ide, 'editor');
  files['s.css'] = 'p{color:blue}';
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.equal(h.state.frames.length, 2);
  assert.match(lastFrame(h).source, /color:blue/);
});

test('files linked from the previous page do not re-render a Markdown target', async (t) => {
  const h = await showLinked(t, { files: { 'a.html': LINKED, 's.css': 'p{color:red}', 'b.md': '# hi' } });
  await show(h, 'b.md');
  const before = h.state.markdownRenders;
  h.stage.handleExternalChange({ relPath: 's.css', kind: 'changed' });
  h.timers.fireAll();
  await settle();
  assert.equal(h.state.markdownRenders, before);
});

test('a new workspace root does not inherit the old scroll position', async (t) => {
  const h = await showLinked(t);
  lastFrame(h).options.onScroll(300);
  h.stage.handleWorkspaceRootCommitted();
  await show(h, 'a.html');
  assert.equal(lastFrame(h).options.restoreScrollY, undefined);
});
