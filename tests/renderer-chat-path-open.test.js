'use strict';

// Coverage for renderer/chat/renderer-chat-path-open.js — the production
// ide:open-file-at-line listener, the tool-row path-chip click delegate, and
// the chat timeline's delegated path context menu. JSDOM per test, no full
// shell harness needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createChatPathOpenController,
  isOpenableRelPath,
} = require('../renderer/chat/renderer-chat-path-open');
const pathMenuFactory = require('../renderer/features/renderer-ide-path-menu');
const citeUtils = require('../renderer/chat/renderer-chat-codebase-cite-utils');

function buildDom(bodyHtml) {
  return new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="chatView"><div id="chatTimeline" role="feed">'
      + (bodyHtml || '')
      + '</div><aside id="subagentInspector"></aside></div>'
      + '</body></html>',
    { url: 'https://jenny.local/chat' }
  );
}

function makeHarness(dom, overrides) {
  const calls = {
    setActiveView: [],
    openIdeFileAtLine: [],
    openInDefaultApp: [],
    toasts: [],
    logs: [],
    menus: [],
  };
  const opts = Object.assign({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    pathRoots: [dom.window.document.getElementById('subagentInspector')],
    state: { workspaceRoot: { path: 'G:/workspace' } },
    setActiveView(view) { calls.setActiveView.push(view); },
    openIdeFileAtLine(path, line, column) {
      calls.openIdeFileAtLine.push({ path, line, column });
      return Promise.resolve(true);
    },
    getWorkspaceFs() {
      return {
        openInDefaultApp(payload) {
          calls.openInDefaultApp.push(payload);
          return Promise.resolve({ ok: true });
        },
      };
    },
    showToastMessage(message, meta) { calls.toasts.push({ message, meta }); },
    appendClientLog(level, event, payload) { calls.logs.push({ level, event, payload }); },
    contextMenu: {
      show(menuOpts) { calls.menus.push(menuOpts); },
      hide() {},
    },
    pathMenuFactory,
    citeUtils,
  }, overrides || {});
  const controller = createChatPathOpenController(opts);
  const dispose = controller.attach();
  return { controller, calls, dispose };
}

function dispatchOpenEvent(dom, detail) {
  const event = new dom.window.CustomEvent('ide:open-file-at-line', {
    detail,
    bubbles: true,
    cancelable: true,
  });
  const unclaimed = dom.window.dispatchEvent(event);
  return { event, claimed: unclaimed === false };
}

// Flush a few microtask turns so the open promise chain settles.
function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

// ---------------------------------------------------------------------------
// isOpenableRelPath — pure (parity with cite-utils isSafeRelPath)
// ---------------------------------------------------------------------------

test('isOpenableRelPath accepts contained relative paths and rejects escapes', () => {
  assert.equal(isOpenableRelPath('renderer/app.js'), true);
  assert.equal(isOpenableRelPath('a/b/c.spec.ts'), true);
  assert.equal(isOpenableRelPath('/etc/passwd'), false);
  assert.equal(isOpenableRelPath('C:/secrets.txt'), false);
  assert.equal(isOpenableRelPath('a/../../b.js'), false);
  assert.equal(isOpenableRelPath('has space.js'), false);
  assert.equal(isOpenableRelPath(''), false);
});

// ---------------------------------------------------------------------------
// ide:open-file-at-line listener
// ---------------------------------------------------------------------------

test('listener claims a safe path: preventDefault + IDE view + open-at-line', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom);

  const { claimed } = dispatchOpenEvent(dom, { path: 'services/auth/login.js', line: 42, column: 5 });
  await flush();

  assert.equal(claimed, true, 'listener must preventDefault to claim the navigation');
  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'services/auth/login.js', line: 42, column: 5 }]);
  assert.equal(calls.openInDefaultApp.length, 0);
  assert.equal(calls.toasts.length, 0);
});

test('listener normalizes backslash paths before opening', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom);

  const { claimed } = dispatchOpenEvent(dom, { path: 'renderer\\chat\\a.js', line: 7 });
  await flush();

  assert.equal(claimed, true);
  assert.equal(calls.openIdeFileAtLine[0].path, 'renderer/chat/a.js');
});

test('listener leaves absolute and parent-escaping paths unclaimed', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom);

  assert.equal(dispatchOpenEvent(dom, { path: 'C:/x/y.js', line: 1 }).claimed, false);
  assert.equal(dispatchOpenEvent(dom, { path: '../up.js', line: 1 }).claimed, false);
  await flush();

  assert.equal(calls.openIdeFileAtLine.length, 0);
  assert.equal(calls.setActiveView.length, 0);
});

test('listener leaves the event unclaimed when the workspace root is known-empty', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom, { state: { workspaceRoot: { path: '' } } });

  const { claimed } = dispatchOpenEvent(dom, { path: 'a/b.js', line: 1 });
  await flush();

  assert.equal(claimed, false, 'rootless shells fall back to the dispatcher default-app path');
  assert.equal(calls.openIdeFileAtLine.length, 0);
});

test('IDE decline falls back to the OS default app', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom, {
    openIdeFileAtLine(path, line, column) {
      calls.openIdeFileAtLine.push({ path, line, column });
      return Promise.resolve(false);
    },
  });
  dispatchOpenEvent(dom, { path: 'gone/file.js', line: 3 });
  await flush();

  assert.deepEqual(calls.openInDefaultApp, [{ path: 'gone/file.js' }]);
  assert.equal(calls.toasts.length, 0, 'fallback succeeded — no toast');
});

test('IDE failure + fallback failure surfaces one toast and warn logs', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom, {
    openIdeFileAtLine() { return Promise.reject(new Error('ide exploded')); },
    getWorkspaceFs() {
      return {
        openInDefaultApp() {
          return Promise.reject({ message: 'nope', error_code: 'CMP-WORKSPACEFS-0004' });
        },
      };
    },
  });

  dispatchOpenEvent(dom, { path: 'stale/path.js', line: 9 });
  await flush();

  assert.equal(calls.toasts.length, 1);
  assert.match(calls.toasts[0].message, /file not found/);
  const warnEvents = calls.logs.filter((entry) => entry.level === 'WARN').map((entry) => entry.event);
  assert.ok(warnEvents.includes('chat.path_open_ide_failed'));
  assert.ok(warnEvents.includes('chat.path_open_fallback_failed'));
});

// ---------------------------------------------------------------------------
// path-chip click / keydown delegates
// ---------------------------------------------------------------------------

const CHIP_ROW_HTML = '<div class="tool-call-row tool-call-row--minimal" data-chat-path="a/b.js">'
  + '<div class="tool-call-row-toggle" role="button" tabindex="0" data-tool-row-toggle="true">'
  + '<span class="tool-call-row-summary">Read '
  + '<span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="a/b.js">a/b.js</span>'
  + '</span></div></div>';

test('chip click opens the file and never reaches the row toggle', async () => {
  const dom = buildDom(CHIP_ROW_HTML);
  const { calls } = makeHarness(dom);
  const doc = dom.window.document;
  let toggleSaw = 0;
  doc.getElementById('chatTimeline').addEventListener('click', (event) => {
    if (event.target.closest && event.target.closest('[data-tool-row-toggle]')) {
      toggleSaw += 1;
    }
  });

  const chip = doc.querySelector('.tool-path-chip');
  chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.equal(calls.openIdeFileAtLine.length, 1);
  assert.equal(calls.openIdeFileAtLine[0].path, 'a/b.js');
  assert.equal(toggleSaw, 0, 'capture-phase chip handler must stop the toggle from firing');
});

test('chip Enter keydown activates the chip', async () => {
  const dom = buildDom(CHIP_ROW_HTML);
  const { calls } = makeHarness(dom);
  const chip = dom.window.document.querySelector('.tool-path-chip');

  chip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(calls.openIdeFileAtLine.length, 1);
});

test('subagent inspector evidence chips use the same contained path navigation seam', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom);
  const inspector = dom.window.document.getElementById('subagentInspector');
  inspector.innerHTML = '<span role="link" tabindex="0" data-chat-path-open="services/backend/store.js">store.js</span>';

  inspector.firstElementChild.dispatchEvent(new dom.window.MouseEvent('click', {
    bubbles: true, cancelable: true,
  }));
  await flush();

  assert.deepEqual(calls.openIdeFileAtLine, [{
    path: 'services/backend/store.js', line: null, column: null,
  }]);
});

// ---------------------------------------------------------------------------
// delegated context menu
// ---------------------------------------------------------------------------

test('contextmenu on a path row shows Open in IDE plus the OS/path items', () => {
  const dom = buildDom(CHIP_ROW_HTML);
  const { calls } = makeHarness(dom);
  const row = dom.window.document.querySelector('.tool-call-row');

  const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  row.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true, 'claimed path rows suppress the native menu');
  assert.equal(calls.menus.length, 1);
  const labels = calls.menus[0].items.filter((item) => item.label).map((item) => item.label);
  assert.deepEqual(labels, [
    'Open in IDE',
    'Reveal in File Explorer',
    'Open in Default App',
    'Copy Path',
    'Copy Relative Path',
    'Copy Name',
  ]);
});

test('contextmenu on a settled cite link resolves the citation path', () => {
  const dom = buildDom(
    '<article class="chat-entry"><div class="chat-bubble chat-bubble-markdown">'
    + '<a class="codebase-cite-link" href="#codebase:services/auth/login.js:42">services/auth/login.js:42</a>'
    + '</div></article>'
  );
  const { calls } = makeHarness(dom);
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');

  const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.menus.length, 1);
  assert.equal(calls.menus[0].items[0].label, 'Open in IDE');
});

test('contextmenu keeps the native menu on non-path targets and editable fields', () => {
  const dom = buildDom('<p class="plain">hello</p><textarea id="ta"></textarea>'
    + '<div data-chat-path="a/b.js"><textarea id="nested"></textarea></div>');
  const { calls } = makeHarness(dom);
  const doc = dom.window.document;

  const plainEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  doc.querySelector('.plain').dispatchEvent(plainEvent);
  assert.equal(plainEvent.defaultPrevented, false);

  const editableEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  doc.getElementById('nested').dispatchEvent(editableEvent);
  assert.equal(editableEvent.defaultPrevented, false, 'editable targets keep the native menu even inside a path row');

  assert.equal(calls.menus.length, 0);
});

test('contextmenu skips Open in IDE when the workspace root is known-empty', () => {
  const dom = buildDom(CHIP_ROW_HTML);
  const { calls } = makeHarness(dom, { state: { workspaceRoot: { path: '' } } });
  const row = dom.window.document.querySelector('.tool-call-row');

  row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  assert.equal(calls.menus.length, 1);
  const labels = calls.menus[0].items.filter((item) => item.label).map((item) => item.label);
  assert.equal(labels.includes('Open in IDE'), false);
  assert.ok(labels.includes('Reveal in File Explorer'));
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('dispose detaches the window listener', async () => {
  const dom = buildDom('');
  const { calls, dispose } = makeHarness(dom);
  dispose();

  const { claimed } = dispatchOpenEvent(dom, { path: 'a/b.js', line: 1 });
  await flush();

  assert.equal(claimed, false);
  assert.equal(calls.openIdeFileAtLine.length, 0);
});

// ---------------------------------------------------------------------------
// Inline-code prose paths (GUI finding 2026-07-20): models reference written
// files as `workspace/hellodemo.md` in prose, and inline code reads as
// clickable — it must navigate like a chip.
// ---------------------------------------------------------------------------

test('clicking a path-shaped inline code span in prose opens the file in the IDE', async () => {
  const dom = buildDom(
    '<article class="chat-entry"><p>Done! Created <code>workspace/hellodemo.md</code> for you.</p></article>'
  );
  const { calls } = makeHarness(dom);

  dom.window.document.querySelector('code')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.equal(calls.openIdeFileAtLine.length, 1);
  assert.equal(calls.openIdeFileAtLine[0].path, 'workspace/hellodemo.md');
});

test('an inline code path with a :line suffix opens at that line', async () => {
  const dom = buildDom('<p>See <code>src/app.js:42</code> for the fix.</p>');
  const { calls } = makeHarness(dom);

  dom.window.document.querySelector('code')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.equal(calls.openIdeFileAtLine[0].path, 'src/app.js');
  assert.equal(calls.openIdeFileAtLine[0].line, 42);
});

test('non-path inline code and fenced code blocks stay inert', async () => {
  const dom = buildDom(
    '<p>Read <code>state.ui.followLatest</code> and</p>'
      + '<pre><code>workspace/in-a-block.md</code></pre>'
  );
  const { calls } = makeHarness(dom);

  for (const code of dom.window.document.querySelectorAll('code')) {
    code.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  await flush();

  assert.equal(calls.openIdeFileAtLine.length, 0);
  assert.equal(calls.setActiveView.length, 0);
});

test('contextmenu on a path-shaped inline code span shows the path menu', async () => {
  const dom = buildDom('<p>Created <code>workspace/hellodemo.md</code>.</p>');
  const { calls } = makeHarness(dom);

  dom.window.document.querySelector('code')
    .dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  assert.equal(calls.menus.length, 1);
  assert.equal(calls.menus[0].items[0].label, 'Open in IDE');
});

test('an inline code path with :line:column opens at that line and column', async () => {
  const dom = buildDom('<p>See <code>src/app.js:42:7</code>.</p>');
  const { calls } = makeHarness(dom);

  dom.window.document.querySelector('code')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.equal(calls.openIdeFileAtLine[0].path, 'src/app.js');
  assert.equal(calls.openIdeFileAtLine[0].line, 42);
  assert.equal(calls.openIdeFileAtLine[0].column, 7);
});

// ---------------------------------------------------------------------------
// Panel-first navigation: a claimed path opens in the chat page's read-only
// artifact-review file preview instead of yanking the user into the IDE. The
// IDE remains the fallback (and the explicit "Open in IDE" menu route).
// ---------------------------------------------------------------------------

function makePanelHarness(dom, overrides) {
  const panelCalls = [];
  const opts = Object.assign({
    state: { workspaceRoot: { path: 'G:/workspace' }, ui: { activeView: 'chat' } },
    openFilePreviewTarget(target) {
      panelCalls.push(target);
      return Promise.resolve(true);
    },
  }, overrides || {});
  const harness = makeHarness(dom, opts);
  harness.panelCalls = panelCalls;
  return harness;
}

test('a claimed path opens in the chat preview panel and never switches to the IDE', async () => {
  const dom = buildDom('');
  const { calls, panelCalls } = makePanelHarness(dom);

  const { claimed } = dispatchOpenEvent(dom, { path: 'services/auth/login.js', line: 42, column: 5 });
  await flush();

  assert.equal(claimed, true);
  assert.deepEqual(panelCalls, [{ path: 'services/auth/login.js', line: 42, column: 5 }]);
  assert.deepEqual(calls.setActiveView, [], 'the user stays on the chat page');
  assert.equal(calls.openIdeFileAtLine.length, 0);
  const infoEvents = calls.logs.filter((entry) => entry.level === 'INFO').map((entry) => entry.event);
  assert.ok(infoEvents.includes('chat.path_open_panel'));
});

test('a panel that declines the target falls through to the IDE route', async () => {
  const dom = buildDom('');
  const { calls, panelCalls } = makePanelHarness(dom, {
    openFilePreviewTarget(target) {
      panelCalls.push(target);
      return Promise.resolve(false);
    },
  });
  // The closure above captures the outer array before makeHarness runs, so
  // assert through the returned calls instead.
  dispatchOpenEvent(dom, { path: 'a/b.js', line: 3 });
  await flush();

  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'a/b.js', line: 3, column: null }]);
});

test('a rejecting panel warns once and still opens the file in the IDE', async () => {
  const dom = buildDom('');
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const { calls } = makePanelHarness(dom, {
    openFilePreviewTarget() { return Promise.reject(new Error('panel exploded')); },
  });

  dispatchOpenEvent(dom, { path: 'a/b.js', line: 3 });
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.removeListener('unhandledRejection', onRejection);

  assert.deepEqual(rejections, [], 'the panel rejection is handled, not leaked');
  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'a/b.js', line: 3, column: null }]);
  const warnEvents = calls.logs.filter((entry) => entry.level === 'WARN').map((entry) => entry.event);
  assert.ok(warnEvents.includes('chat.path_open_panel_failed'));
});

test('the panel is skipped when chat is not the active view', async () => {
  const dom = buildDom('');
  const { calls, panelCalls } = makePanelHarness(dom, {
    state: { workspaceRoot: { path: 'G:/workspace' }, ui: { activeView: 'ide' } },
  });

  dispatchOpenEvent(dom, { path: 'a/b.js', line: 3 });
  await flush();

  assert.deepEqual(panelCalls, [], 'the rail only owns clicks made from the chat page');
  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.equal(calls.openIdeFileAtLine.length, 1);
});

test('preferIde events (the panel’s own escape hatch) bypass the panel entirely', async () => {
  const dom = buildDom('');
  const { calls, panelCalls } = makePanelHarness(dom);

  dispatchOpenEvent(dom, { path: 'a/b.js', line: 3, preferIde: true });
  await flush();

  assert.deepEqual(panelCalls, [], 'no bounce back into the panel that asked for the IDE');
  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.equal(calls.openIdeFileAtLine.length, 1);
});

test('chips and inline prose paths route through the same panel preference', async () => {
  const dom = buildDom(CHIP_ROW_HTML + '<p>See <code>src/app.js:9</code>.</p>');
  const { calls, panelCalls } = makePanelHarness(dom);
  const doc = dom.window.document;

  doc.querySelector('.tool-path-chip')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  doc.querySelector('p code')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.deepEqual(panelCalls, [
    { path: 'a/b.js', line: null, column: null },
    { path: 'src/app.js', line: 9, column: null },
  ]);
  assert.equal(calls.openIdeFileAtLine.length, 0);
  assert.deepEqual(calls.setActiveView, []);
});

test('the context menu leads with Open Preview and keeps Open in IDE on the direct route', async () => {
  const dom = buildDom(CHIP_ROW_HTML);
  const { calls, panelCalls } = makePanelHarness(dom);
  const row = dom.window.document.querySelector('.tool-call-row');

  row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(calls.menus.length, 1);
  const items = calls.menus[0].items.filter((item) => item.label);
  assert.deepEqual(items.map((item) => item.label), [
    'Open Preview',
    'Open in IDE',
    'Reveal in File Explorer',
    'Open in Default App',
    'Copy Path',
    'Copy Relative Path',
    'Copy Name',
  ]);

  await items[1].action();
  assert.deepEqual(panelCalls, [], 'Open in IDE never routes through the panel');
  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.equal(calls.openIdeFileAtLine.length, 1);

  await items[0].action();
  await flush();
  assert.deepEqual(panelCalls, [{ path: 'a/b.js', line: null, column: null }]);
});

test('without the panel dep every entry point keeps the legacy IDE-first behavior', async () => {
  const dom = buildDom(CHIP_ROW_HTML);
  // No openFilePreviewTarget, and an explicit chat activeView: the preference
  // must still refuse (the dep, not the view, is the gate).
  const { calls } = makeHarness(dom, {
    state: { workspaceRoot: { path: 'G:/workspace' }, ui: { activeView: 'chat' } },
  });

  dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'a/b.js', line: null, column: null }]);

  const row = dom.window.document.querySelector('.tool-call-row');
  row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const labels = calls.menus[0].items.filter((item) => item.label).map((item) => item.label);
  assert.equal(labels.includes('Open Preview'), false);
  assert.equal(labels[0], 'Open in IDE');
});

test('openInIdePath is exposed for the direct route', async () => {
  const dom = buildDom('');
  const { controller, calls, panelCalls } = makePanelHarness(dom);

  await controller.openInIdePath('a/b.js', 2, 3);

  assert.deepEqual(panelCalls, []);
  assert.deepEqual(calls.setActiveView, ['ide']);
  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'a/b.js', line: 2, column: 3 }]);
});

test('a markdown-decorated inline path chip is keyboard-activatable and carries its column', async () => {
  // decorateCodeBlocks stamps the full chip contract onto prose paths; the
  // existing capture-phase keydown delegate must drive them: keyboard
  // parity for inline paths.
  const dom = buildDom(
    '<p><code class="chat-inline-path" role="link" tabindex="0"'
      + ' data-chat-path-open="src/app.js" data-chat-path="src/app.js"'
      + ' data-chat-path-line="42" data-chat-path-column="7">src/app.js:42:7</code></p>'
  );
  const { calls } = makeHarness(dom);

  dom.window.document.querySelector('code')
    .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(calls.openIdeFileAtLine.length, 1);
  assert.deepEqual(calls.openIdeFileAtLine[0], { path: 'src/app.js', line: 42, column: 7 });
});
