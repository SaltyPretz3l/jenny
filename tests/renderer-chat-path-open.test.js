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

test('IDE decline ends at the IDE toast: no OS default-app fallback', async () => {
  // F2: the IDE declines binaries and >5 MB files after its own toast; the
  // chat must not hand such a file (bin/tool.exe) to shell.openPath.
  const dom = buildDom('');
  const { controller, calls } = makeHarness(dom, {
    openIdeFileAtLine(path, line, column) {
      calls.openIdeFileAtLine.push({ path, line, column });
      return Promise.resolve(false);
    },
  });
  const { claimed } = dispatchOpenEvent(dom, { path: 'bin/tool.exe', line: 3 });
  await flush();

  assert.equal(claimed, true);
  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'bin/tool.exe', line: 3, column: null }]);
  assert.deepEqual(calls.openInDefaultApp, []);
  assert.equal(calls.toasts.length, 0, 'the IDE already toasted; no second toast');
  assert.ok(calls.logs.some((entry) => entry.event === 'chat.path_open_ide_declined'));

  assert.equal(await controller.openInIdePath('scripts/x.scr', 1, null), false);
  assert.deepEqual(calls.openInDefaultApp, [], 'the direct IDE route never falls back either');
});

test('IDE failure surfaces one toast and a warn log without calling the OS opener', async () => {
  const dom = buildDom('');
  const { calls } = makeHarness(dom, {
    openIdeFileAtLine() { return Promise.reject({ message: 'nope', error_code: 'CMP-WORKSPACEFS-0004' }); },
  });

  dispatchOpenEvent(dom, { path: 'stale/path.js', line: 9 });
  await flush();

  assert.deepEqual(calls.openInDefaultApp, []);
  assert.equal(calls.toasts.length, 1);
  assert.match(calls.toasts[0].message, /file not found/);
  const warnEvents = calls.logs.filter((entry) => entry.level === 'WARN').map((entry) => entry.event);
  assert.ok(warnEvents.includes('chat.path_open_ide_failed'));
});

test('a cite link whose IDE open is declined never reaches the OS opener', async () => {
  const dom = buildDom(
    '<article class="chat-entry message-shell assistant" data-message-id="m1"'
    + ' data-message-role="assistant" data-message-status="complete">'
    + '<div class="chat-bubble chat-bubble-markdown">see dist/huge.js:1 here</div></article>'
  );
  const { calls } = makeHarness(dom, {
    openIdeFileAtLine(path, line, column) {
      calls.openIdeFileAtLine.push({ path, line, column });
      return Promise.resolve(false);
    },
  });
  const citeOpens = [];
  const cite = citeUtils.createCodebaseCiteController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getWorkspaceFs() { return { openInDefaultApp(arg) { citeOpens.push(arg); return Promise.resolve({}); } }; },
    isEnabled() { return true; },
  });
  const detach = cite.attach();
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  assert.ok(anchor, 'the citation is linkified');
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  detach();

  assert.deepEqual(calls.openIdeFileAtLine, [{ path: 'dist/huge.js', line: 1, column: null }]);
  assert.deepEqual(calls.openInDefaultApp, []);
  assert.deepEqual(citeOpens, []);
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

test('an unclaimed chip (no IDE wiring) toasts instead of calling the OS opener', async () => {
  const dom = buildDom(CHIP_ROW_HTML);
  const { calls } = makeHarness(dom, { openIdeFileAtLine: null });

  dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();

  assert.deepEqual(calls.openInDefaultApp, []);
  assert.equal(calls.toasts.length, 1);
  assert.match(calls.toasts[0].message, /a\/b\.js/);
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

test('split view: a second pane\'s transcript and inspector chips open once through the pane host; nothing else does', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatView">'
    + '<div class="chat-pane" data-pane-id="0"><div id="chatTimeline" data-chat-node="chatTimeline"><code>src/zero.js</code></div>'
    + '<aside id="subagentInspector" data-chat-node="subagentInspector"></aside></div>'
    + '<div class="chat-pane" data-pane-id="1"><div data-chat-node="chatTimeline"><span data-chat-path-open="src/one.js">one</span><code>src/inline.js</code></div>'
    + '<aside data-chat-node="subagentInspector"><span data-chat-path-open="src/two.js">two</span><code>src/not-prose.js</code></aside>'
    + '<div class="composer"><span data-chat-path-open="src/composer.js">composer</span></div></div>'
    + '<aside class="artifact-review-panel"><span data-chat-path-open="src/panel.js">panel</span></aside>'
    + '</div></body></html>', { url: 'https://jenny.local/chat' });
  const doc = dom.window.document;
  const { calls, dispose } = makeHarness(dom, { paneHost: doc });
  const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const pane1 = doc.querySelector('.chat-pane[data-pane-id="1"]');

  click(doc.querySelector('#chatTimeline code'));
  click(pane1.querySelector('[data-chat-path-open="src/one.js"]'));
  click(pane1.querySelector('[data-chat-node="chatTimeline"] code'));
  click(pane1.querySelector('[data-chat-path-open="src/two.js"]'));
  click(pane1.querySelector('aside code'));
  click(pane1.querySelector('[data-chat-path-open="src/composer.js"]'));
  click(doc.querySelector('[data-chat-path-open="src/panel.js"]'));
  await flush();

  assert.deepEqual(calls.openIdeFileAtLine.map((call) => call.path), ['src/zero.js', 'src/one.js', 'src/inline.js', 'src/two.js'],
    'pane 0 once (its own root), pane 1\'s chips and prose code once; inspector prose, the composer and the side panel stay inert');
  dispose();
  click(pane1.querySelector('[data-chat-path-open="src/one.js"]'));
  await flush();
  assert.equal(calls.openIdeFileAtLine.length, 4, 'dispose detaches the pane host');
});

test('W7c: an open names the chat pane it came from; an event without one names none', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatView">'
    + '<div class="chat-pane" data-pane-id="0"><div id="chatTimeline" data-chat-node="chatTimeline"><code>src/zero.js</code></div>'
    + '<aside id="subagentInspector" data-chat-node="subagentInspector"></aside></div>'
    + '<div class="chat-pane" data-pane-id="1"><div data-chat-node="chatTimeline"><span data-chat-path-open="src/one.js">one</span></div></div>'
    + '</div></body></html>', { url: 'https://jenny.local/chat' });
  const doc = dom.window.document;
  const origins = [];
  const { dispose } = makeHarness(dom, {
    paneHost: doc,
    openIdeFileAtLine(path, line, column, origin) { origins.push([path, origin]); return Promise.resolve(true); },
  });
  const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  click(doc.querySelector('#chatTimeline code'));
  click(doc.querySelector('[data-chat-path-open="src/one.js"]'));
  dispatchOpenEvent(dom, { path: 'src/rail.js', line: 3, preferIde: true });
  await flush();
  assert.deepEqual(origins, [['src/zero.js', { pane: 0 }], ['src/one.js', { pane: 1 }], ['src/rail.js', undefined]]);
  dispose();
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

// ---------------------------------------------------------------------------
// Row 95 phase 3: absolute paths, out-of-root copy, folders (absolute_path_links)
// ---------------------------------------------------------------------------

const markdownInlinePaths = require('../renderer/shared/markdown-inline-paths');

function absHarness(bodyHtml, overrides) {
  const dom = buildDom(bodyHtml);
  const revealed = [];
  const copied = [];
  const harness = makeHarness(dom, Object.assign({
    state: { workspaceRoot: { path: 'G:\\workspace' }, features: { featureFlags: { absolute_path_links: true } } },
    revealInIdeTree(path) { revealed.push(path); return Promise.resolve(true); },
  }, overrides || {}));
  dom.window.jennyShell = { clipboard: { writeText(text) { copied.push(text); return Promise.resolve(); } } };
  return Object.assign(harness, { dom, revealed, copied });
}

function clickCode(dom, text) {
  const code = dom.window.document.querySelector('code');
  assert.equal(code.textContent, text);
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  code.dispatchEvent(event);
  return event;
}

function menuLabels(harness) {
  assert.equal(harness.calls.menus.length, 1, 'one menu shown');
  return harness.calls.menus[0].items.filter((item) => item.label).map((item) => item.label);
}

function openContextMenu(dom, selector) {
  const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  dom.window.document.querySelector(selector).dispatchEvent(event);
  return event;
}

const DIR_CHIP_HTML = '<div class="tool-call-row" data-chat-path="src/lib" data-chat-path-kind="dir">'
  + '<span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="src/lib" data-chat-path-kind="dir">src/lib</span></div>';

for (const [label, text, expected] of [
  ['an in-root Windows path with :line:col', 'G:\\workspace\\src\\a.js:42:7', { path: 'src/a.js', line: 42, column: 7 }],
  ['the forward-slash variant', 'G:/workspace/src/a.js:5', { path: 'src/a.js', line: 5, column: null }],
  ['a different drive-letter and segment case', 'g:\\WORKSPACE\\src\\a.js', { path: 'src/a.js', line: null, column: null }],
  ['a file:/// URL', 'file:///G:/workspace/src/a%2Eb.js:3', { path: 'src/a.b.js', line: 3, column: null }],
]) {
  test(`inline code with ${label} opens the in-root file`, async () => {
    const h = absHarness(`<p><code>${text}</code></p>`);
    const event = clickCode(h.dom, text);
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(h.calls.openIdeFileAtLine, [expected]);
    assert.deepEqual(h.calls.openInDefaultApp, []);
  });
}

test('a decorated absolute chip carries the shared chip contract and opens in root', async () => {
  const h = absHarness('<p><code>G:\\workspace\\src\\a.js:42:7</code></p>');
  markdownInlinePaths.decorateInlinePathChips(h.dom.window.document.getElementById('chatTimeline'));
  const code = h.dom.window.document.querySelector('code');
  assert.equal(code.getAttribute('data-chat-path-open'), 'G:/workspace/src/a.js');
  assert.equal(code.getAttribute('data-chat-path-line'), '42');
  code.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.calls.openIdeFileAtLine, [{ path: 'src/a.js', line: 42, column: 7 }]);
});

test('an out-of-root absolute path never opens; its menu offers Copy Path only, copying the path', async () => {
  const h = absHarness('<p><code>C:\\Users\\me\\secret.txt</code></p>');
  clickCode(h.dom, 'C:\\Users\\me\\secret.txt');
  await flush();
  assert.deepEqual(h.calls.openIdeFileAtLine, []);
  assert.deepEqual(h.calls.setActiveView, []);
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(openContextMenu(h.dom, 'code').defaultPrevented, true);
  assert.deepEqual(menuLabels(h), ['Copy Path']);
  const copy = h.calls.menus[0].items.find((item) => item.label === 'Copy Path');
  await copy.action();
  assert.deepEqual(h.copied, ['C:\\Users\\me\\secret.txt']);
  assert.equal(h.calls.logs.some((log) => JSON.stringify(log.payload || {}).includes('secret')), false, 'logs never carry the path');
});

test('with no workspace root bound an absolute path offers Copy Path only', async () => {
  const h = absHarness('<p><code>G:\\workspace\\src\\a.js</code></p>', {
    state: { workspaceRoot: { path: '' }, features: { featureFlags: { absolute_path_links: true } } },
  });
  clickCode(h.dom, 'G:\\workspace\\src\\a.js');
  await flush();
  assert.deepEqual(h.calls.openIdeFileAtLine, []);
  openContextMenu(h.dom, 'code');
  assert.deepEqual(menuLabels(h), ['Copy Path']);
});

test('a ".." escape and a UNC path stay inert: no open, no menu, native context menu kept', async () => {
  for (const text of ['G:\\workspace\\..\\..\\secret\\a.js', '\\\\srv\\share\\a.js']) {
    const h = absHarness(`<p><code>${text}</code></p>`);
    const click = clickCode(h.dom, text);
    await flush();
    assert.equal(click.defaultPrevented, false, text);
    assert.deepEqual(h.calls.openIdeFileAtLine, []);
    assert.equal(openContextMenu(h.dom, 'code').defaultPrevented, false, text);
    assert.equal(h.calls.menus.length, 0);
  }
});

test('an in-root absolute path menu matches the relative one', () => {
  const h = absHarness('<p><code>G:\\workspace\\src\\a.js</code></p>');
  openContextMenu(h.dom, 'code');
  assert.deepEqual(menuLabels(h), [
    'Open in IDE', 'Reveal in File Explorer', 'Open in Default App', 'Copy Path', 'Copy Relative Path', 'Copy Name',
  ]);
});

test('a directory chip reveals it in the IDE tree and offers Reveal in File Explorer plus Copy Path', async () => {
  const h = absHarness(DIR_CHIP_HTML);
  h.dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.revealed, ['src/lib']);
  assert.deepEqual(h.calls.openIdeFileAtLine, []);
  assert.deepEqual(h.calls.setActiveView, ['ide']);
  openContextMenu(h.dom, '.tool-path-chip');
  const labels = menuLabels(h);
  assert.ok(labels.includes('Reveal in File Explorer'));
  assert.ok(labels.includes('Copy Path'));
  assert.equal(labels.includes('Open in Default App'), false);
});

test('a trailing-slash absolute inline path reveals the folder in the tree', async () => {
  const h = absHarness('<p><code>G:\\workspace\\src\\</code></p>');
  clickCode(h.dom, 'G:\\workspace\\src\\');
  await flush();
  assert.deepEqual(h.revealed, ['src']);
  assert.deepEqual(h.calls.openIdeFileAtLine, []);
});

test('a file open refused as "not a file" falls back to the tree reveal instead of a toast', async () => {
  const h = absHarness(CHIP_ROW_HTML, {
    openIdeFileAtLine() {
      const error = new Error('Path is not a regular file.');
      error.error_code = 'CMP-WORKSPACEFS-0005';
      return Promise.reject(error);
    },
  });
  h.dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.revealed, ['a/b.js']);
  assert.deepEqual(h.calls.toasts, []);
});

test('a directory chip with no tree-reveal wiring toasts instead of opening a file or the OS', async () => {
  const h = absHarness(DIR_CHIP_HTML, { revealInIdeTree: null });
  h.dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.calls.openIdeFileAtLine, []);
  assert.deepEqual(h.calls.openInDefaultApp, []);
  assert.equal(h.calls.toasts.length, 1);
});

test('absolute_path_links off restores the old behavior: absolute inert, dir hint ignored', async () => {
  const off = { workspaceRoot: { path: 'G:\\workspace' }, features: { featureFlags: { absolute_path_links: false } } };
  const abs = absHarness('<p><code>G:\\workspace\\src\\a.js</code></p>', { state: off });
  const click = clickCode(abs.dom, 'G:\\workspace\\src\\a.js');
  await flush();
  assert.equal(click.defaultPrevented, false);
  assert.deepEqual(abs.calls.openIdeFileAtLine, []);
  assert.equal(openContextMenu(abs.dom, 'code').defaultPrevented, false);

  const dir = absHarness(DIR_CHIP_HTML, { state: off });
  dir.dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new dir.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(dir.revealed, []);
  assert.deepEqual(dir.calls.openIdeFileAtLine, [{ path: 'src/lib', line: null, column: null }]);
});

// ---------------------------------------------------------------------------
// Row 95 P1: the hover "more" button after a path chip opens the chip's own menu
// ---------------------------------------------------------------------------

const MORE = '.chat-path-more';

function hoverChip(dom, selector) {
  dom.window.document.querySelector(selector)
    .dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true }));
}

function clickMore(dom, selector) {
  const button = dom.window.document.querySelector(selector || MORE);
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return button;
}

const OUTSIDE_CHIP_HTML = '<p><code class="chat-inline-path" role="link" tabindex="0" data-chat-path-open="C:/Users/me/logs" data-chat-path="C:/Users/me/logs">C:\\Users\\me\\logs</code></p>';

test('the more button is inserted lazily on hover or focus, once, with menu semantics', () => {
  const h = absHarness(CHIP_ROW_HTML);
  const doc = h.dom.window.document;
  assert.equal(doc.querySelector(MORE), null, 'the render path carries no button');
  hoverChip(h.dom, '.tool-path-chip');
  hoverChip(h.dom, '.tool-path-chip');
  const buttons = doc.querySelectorAll(MORE);
  assert.equal(buttons.length, 1);
  const button = buttons[0];
  assert.equal(button.previousElementSibling, doc.querySelector('.tool-path-chip'));
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.getAttribute('aria-label'), 'More for this path');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  const keyboard = absHarness(CHIP_ROW_HTML);
  keyboard.dom.window.document.querySelector('.tool-path-chip')
    .dispatchEvent(new keyboard.dom.window.FocusEvent('focusin', { bubbles: true }));
  assert.equal(keyboard.dom.window.document.querySelectorAll(MORE).length, 1);
});

test('no more button for non-path targets, fenced code or an unclassifiable chip', () => {
  const h = absHarness('<p><code>state.ui.value</code></p><pre><code>src/a.js</code></pre>'
    + '<span class="tool-path-chip" data-chat-path-open="../escape.js">x</span>');
  for (const selector of ['p code', 'pre code', '.tool-path-chip']) hoverChip(h.dom, selector);
  assert.equal(h.dom.window.document.querySelector(MORE), null);
});

test('the more button opens the file menu: same items as right-click, anchored on the button', async () => {
  const h = absHarness(CHIP_ROW_HTML);
  let toggleSaw = 0;
  h.dom.window.document.getElementById('chatTimeline').addEventListener('click', (event) => {
    if (event.target.closest('[data-tool-row-toggle]')) toggleSaw += 1;
  });
  hoverChip(h.dom, '.tool-path-chip');
  const button = clickMore(h.dom);
  await flush();
  assert.equal(h.calls.menus.length, 1);
  assert.equal(h.calls.menus[0].anchorEl, button);
  assert.equal(h.calls.menus[0].restoreFocusTo, button);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(toggleSaw, 0, 'the button never toggles its row');
  assert.deepEqual(h.calls.openIdeFileAtLine, [], 'opening the menu opens nothing');
  const moreLabels = menuLabels(h);
  const right = absHarness(CHIP_ROW_HTML);
  openContextMenu(right.dom, '.tool-path-chip');
  assert.deepEqual(moreLabels, menuLabels(right));
  assert.deepEqual(moreLabels, ['Open in IDE', 'Reveal in File Explorer', 'Open in Default App', 'Copy Path', 'Copy Relative Path', 'Copy Name']);
  h.calls.menus[0].onHide();
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('the more button on a folder chip offers the tree reveal and no file-only items', async () => {
  const h = absHarness(DIR_CHIP_HTML);
  hoverChip(h.dom, '.tool-path-chip');
  clickMore(h.dom);
  const labels = menuLabels(h);
  assert.deepEqual(labels, ['Reveal in Explorer View', 'Reveal in File Explorer', 'Copy Path', 'Copy Relative Path', 'Copy Name']);
  await h.calls.menus[0].items.find((item) => item.label === 'Reveal in Explorer View').action();
  assert.deepEqual(h.revealed, ['src/lib']);
});

test('the more button on an outside-root absolute path offers Copy Path only', async () => {
  const h = absHarness(OUTSIDE_CHIP_HTML);
  hoverChip(h.dom, 'code');
  clickMore(h.dom);
  assert.deepEqual(menuLabels(h), ['Copy Path']);
  await h.calls.menus[0].items[0].action();
  assert.deepEqual(h.copied, ['C:\\Users\\me\\logs']);
});

test('a decorated inline-code chip in prose gets the button too', () => {
  const h = absHarness('<p>See <code>src/a.js:3</code> now</p>');
  markdownInlinePaths.decorateInlinePathChips(h.dom.window.document.getElementById('chatTimeline'));
  hoverChip(h.dom, 'code');
  clickMore(h.dom);
  assert.equal(h.calls.menus.length, 1);
  assert.ok(menuLabels(h).includes('Open in IDE'));
});

test('clicking the open button again closes the menu; Enter and Space on it never reach the row toggle', () => {
  let hidden = 0;
  const h = absHarness(CHIP_ROW_HTML, { contextMenu: { show(menuOpts) { h.calls.menus.push(menuOpts); }, hide() { hidden += 1; } } });
  hoverChip(h.dom, '.tool-path-chip');
  const button = clickMore(h.dom);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  clickMore(h.dom);
  assert.equal(hidden, 1);
  assert.equal(h.calls.menus.length, 1, 'the second click closes instead of reopening');
  let toggleSaw = 0;
  h.dom.window.document.getElementById('chatTimeline').addEventListener('keydown', () => { toggleSaw += 1; });
  for (const key of ['Enter', ' ']) {
    button.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  assert.equal(toggleSaw, 0);
});

test('right-click on a chip keeps working beside the button', () => {
  const h = absHarness(CHIP_ROW_HTML);
  hoverChip(h.dom, '.tool-path-chip');
  assert.equal(openContextMenu(h.dom, '.tool-path-chip').defaultPrevented, true);
  assert.equal(h.calls.menus.length, 1);
});

test('absolute_path_links off: a chip that is only classifiable absolutely gets no button', () => {
  const off = { workspaceRoot: { path: 'G:\\workspace' }, features: { featureFlags: { absolute_path_links: false } } };
  const h = absHarness(OUTSIDE_CHIP_HTML, { state: off });
  hoverChip(h.dom, 'code');
  assert.equal(h.dom.window.document.querySelector(MORE), null);
});
