'use strict';

// renderer/chat/renderer-chat-path-open.js, project links: a file inside a registered project that
// is not the current Workspace (the primary chat talks about every project) opens as a read-only
// preview, with Open in IDE (switches the Workspace) and Copy Path on its menu.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatPathOpenController } = require('../renderer/chat/renderer-chat-path-open');
const pathResolve = require('../renderer/shared/workspace-path-resolve');
const pathMenuFactory = require('../renderer/features/renderer-ide-path-menu');
const citeUtils = require('../renderer/chat/renderer-chat-codebase-cite-utils');
const markdownInlinePaths = require('../renderer/shared/markdown-inline-paths');

const ROOTS = [{ id: 'p-notes', rootPath: 'D:\\notes' }, { id: 'p-site', rootPath: '/home/dev/site' }];
const ON = { workspaceRoot: { path: 'G:\\workspace' }, features: { featureFlags: { absolute_path_links: true } }, ui: { activeView: 'chat' } };

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(bodyHtml, overrides) {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatTimeline">' + (bodyHtml || '') + '</div></body></html>', { url: 'https://jenny.local/chat' });
  const calls = { preview: [], projectIde: [], ide: [], menus: [], toasts: [], logs: [], copied: [], defaultApp: [] };
  dom.window.jennyShell = { clipboard: { writeText(text) { calls.copied.push(text); return Promise.resolve(); } } };
  const controller = createChatPathOpenController(Object.assign({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    state: JSON.parse(JSON.stringify(ON)),
    setActiveView() {},
    openIdeFileAtLine(path, line, column) { calls.ide.push({ path, line, column }); return Promise.resolve(true); },
    openFilePreviewTarget(target) { calls.preview.push(target); return Promise.resolve(true); },
    openProjectFileInIde(target) { calls.projectIde.push(target); return Promise.resolve(true); },
    getProjectRoots: () => ROOTS,
    getWorkspaceFs: () => ({ openInDefaultApp(payload) { calls.defaultApp.push(payload); return Promise.resolve({ ok: true }); } }),
    showToastMessage(message, meta) { calls.toasts.push({ message, meta }); },
    appendClientLog(level, event, payload) { calls.logs.push({ level, event, payload }); },
    contextMenu: { show(menuOpts) { calls.menus.push(menuOpts); }, hide() {} },
    pathMenuFactory,
    citeUtils,
  }, overrides || {}));
  const dispose = controller.attach();
  return { dom, calls, controller, dispose };
}

function click(dom, selector) {
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  dom.window.document.querySelector(selector).dispatchEvent(event);
  return event;
}

function contextMenu(dom, selector) {
  const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  dom.window.document.querySelector(selector).dispatchEvent(event);
  return event;
}

const labels = (h) => h.calls.menus[0].items.filter((item) => item.label).map((item) => item.label);
const NOTES_CODE = '<p><code>D:\\notes\\2026\\plan.md:12:3</code></p>';

test('clicking inline code for a project file opens the read-only preview with its project id', async (t) => {
  const h = harness(NOTES_CODE);
  t.after(h.dispose);
  const event = click(h.dom, 'code');
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.calls.preview, [{ projectId: 'p-notes', path: '2026/plan.md', line: 12, column: 3, display: 'D:\\notes\\2026\\plan.md' }]);
  assert.deepEqual(h.calls.ide, []);
  assert.deepEqual(h.calls.projectIde, []);
  assert.deepEqual(h.calls.defaultApp, []);
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(JSON.stringify(h.calls.logs).includes('plan.md'), false, 'logs never carry the path');
});

test('a prose chip carrying the absolute text opens the same preview', async (t) => {
  const h = harness('<p><span class="chat-inline-path" role="link" tabindex="0" data-chat-path-open="/home/dev/site/src/a.js" data-chat-path="/home/dev/site/src/a.js" data-chat-path-line="9">/home/dev/site/src/a.js:9</span></p>');
  t.after(h.dispose);
  click(h.dom, '.chat-inline-path');
  await flush();
  assert.deepEqual(h.calls.preview, [{ projectId: 'p-site', path: 'src/a.js', line: 9, column: null, display: '/home/dev/site/src/a.js' }]);
});

test('a decorated inline-code chip re-classifies from its attributes and opens the preview', async (t) => {
  const h = harness(NOTES_CODE);
  t.after(h.dispose);
  markdownInlinePaths.decorateInlinePathChips(h.dom.window.document.getElementById('chatTimeline'));
  h.dom.window.document.querySelector('code').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.equal(h.calls.preview.length, 1);
  assert.equal(h.calls.preview[0].projectId, 'p-notes');
});

test('a preview that declines toasts the existing open failure and nothing else opens', async (t) => {
  const h = harness(NOTES_CODE, { openFilePreviewTarget(target) { h.calls.preview.push(target); return Promise.resolve(false); } });
  t.after(h.dispose);
  click(h.dom, 'code');
  await flush();
  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.calls.toasts[0].message, /open/i);
  assert.deepEqual(h.calls.projectIde, []);
  assert.deepEqual(h.calls.defaultApp, []);
});

test('a throwing preview toasts too', async (t) => {
  const h = harness(NOTES_CODE, { openFilePreviewTarget() { throw new Error('boom'); } });
  t.after(h.dispose);
  click(h.dom, 'code');
  await flush();
  assert.equal(h.calls.toasts.length, 1);
});

test('the menu offers Open Preview, Open in IDE and Copy Path, each doing its own job', async (t) => {
  const h = harness(NOTES_CODE);
  t.after(h.dispose);
  assert.equal(contextMenu(h.dom, 'code').defaultPrevented, true);
  assert.deepEqual(labels(h), ['Open Preview', 'Open in IDE', 'Copy Path']);
  const [preview, ide, copy] = h.calls.menus[0].items;
  await preview.action();
  assert.equal(h.calls.preview.length, 1);
  await ide.action();
  assert.deepEqual(h.calls.projectIde, [{ projectId: 'p-notes', path: '2026/plan.md', line: 12, column: 3 }]);
  assert.deepEqual(h.calls.ide, [], 'the IDE route goes through the project switch, never straight to the workspace');
  await copy.action();
  assert.deepEqual(h.calls.copied, ['D:\\notes\\2026\\plan.md']);
});

test('the hover more button works for a project path and opens the same menu', (t) => {
  const h = harness(NOTES_CODE);
  t.after(h.dispose);
  markdownInlinePaths.decorateInlinePathChips(h.dom.window.document.getElementById('chatTimeline'));
  h.dom.window.document.querySelector('code').dispatchEvent(new h.dom.window.MouseEvent('pointerover', { bubbles: true }));
  const more = h.dom.window.document.querySelector('.chat-path-more');
  assert.ok(more, 'a project chip gets the more button');
  more.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(labels(h), ['Open Preview', 'Open in IDE', 'Copy Path']);
  assert.equal(h.calls.menus[0].anchorEl, more);
  assert.deepEqual(h.calls.preview, [], 'opening the menu opens nothing');
});

test('off the chat page the click never switches the Workspace and the menu drops Open Preview', async (t) => {
  const state = JSON.parse(JSON.stringify(ON));
  state.ui.activeView = 'ide';
  const h = harness(NOTES_CODE, { state });
  t.after(h.dispose);
  click(h.dom, 'code');
  await flush();
  assert.deepEqual(h.calls.preview, []);
  assert.equal(h.calls.projectIde.length, 0);
  contextMenu(h.dom, 'code');
  assert.deepEqual(labels(h), ['Open in IDE', 'Copy Path']);
});

test('without the IDE hook the menu is Open Preview and Copy Path', (t) => {
  const h = harness(NOTES_CODE, { openProjectFileInIde: null });
  t.after(h.dispose);
  contextMenu(h.dom, 'code');
  assert.deepEqual(labels(h), ['Open Preview', 'Copy Path']);
});

test('the workspace root wins: a path in the workspace opens as before, even if a project has that root', async (t) => {
  const h = harness('<p><code>G:\\workspace\\src\\a.js:4</code></p>', { getProjectRoots: () => ROOTS.concat([{ id: 'p-ws', rootPath: 'G:\\workspace' }]) });
  t.after(h.dispose);
  click(h.dom, 'code');
  await flush();
  assert.deepEqual(h.calls.preview, [{ path: 'src/a.js', line: 4, column: null }], 'the workspace preview, no project id');
  assert.deepEqual(h.calls.projectIde, []);
});

test('a path outside every root, a folder and a missing roots hook stay copy-only', async (t) => {
  for (const [text, overrides] of [
    ['C:\\Users\\me\\x.txt', {}],
    ['D:\\notes\\2026\\', {}],
    ['D:\\notes\\a.md', { getProjectRoots: undefined }],
  ]) {
    const h = harness('<p><code>' + text + '</code></p>', overrides);
    t.after(h.dispose);
    click(h.dom, 'code');
    await flush();
    assert.deepEqual(h.calls.preview, [], text);
    assert.deepEqual(h.calls.projectIde, [], text);
    contextMenu(h.dom, 'code');
    assert.deepEqual(labels(h), ['Copy Path'], text);
  }
});

test('with absolute_path_links off a project path is inert', async (t) => {
  const state = JSON.parse(JSON.stringify(ON));
  state.features.featureFlags.absolute_path_links = false;
  const h = harness(NOTES_CODE, { state });
  t.after(h.dispose);
  const event = click(h.dom, 'code');
  await flush();
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(h.calls.preview, []);
  assert.equal(contextMenu(h.dom, 'code').defaultPrevented, false);
});

test('attach publishes the project roots to the shared context while links are on', (t) => {
  const h = harness('');
  t.after(h.dispose);
  assert.deepEqual(pathResolve.getContext().projectRoots, ROOTS);
  assert.equal(pathResolve.getContext().workspaceRoot, 'G:\\workspace');
});

test('the preview panel Open in IDE seam: a project open event is claimed and switches through the project hook', async (t) => {
  const h = harness('');
  t.after(h.dispose);
  const event = new h.dom.window.CustomEvent('ide:open-file-at-line', { detail: { projectId: 'p-notes', path: 'a.md', line: 3, preferIde: true }, bubbles: true, cancelable: true });
  assert.equal(h.dom.window.dispatchEvent(event), false, 'claimed');
  await flush();
  assert.deepEqual(h.calls.projectIde, [{ projectId: 'p-notes', path: 'a.md', line: 3, column: null }]);
  assert.deepEqual(h.calls.ide, []);
  assert.deepEqual(h.calls.defaultApp, []);
});

test('a project open event with no IDE hook or a bad path stays unclaimed (never the OS default app)', async (t) => {
  const none = harness('', { openProjectFileInIde: null });
  t.after(none.dispose);
  assert.equal(none.dom.window.dispatchEvent(new none.dom.window.CustomEvent('ide:open-file-at-line', { detail: { projectId: 'p-notes', path: 'a.md' }, cancelable: true })), true);
  const bad = harness('');
  t.after(bad.dispose);
  for (const detail of [{ projectId: 'p-notes', path: '../x.js' }, { projectId: 'p-notes', path: 'C:/x.js' }, { projectId: 7, path: 'a.md' }, { projectId: '', path: 'a.md' }]) {
    assert.equal(bad.dom.window.dispatchEvent(new bad.dom.window.CustomEvent('ide:open-file-at-line', { detail, cancelable: true })), true, JSON.stringify(detail));
  }
  await flush();
  assert.deepEqual(bad.calls.projectIde, []);
  assert.deepEqual(bad.calls.preview, []);
  assert.deepEqual(bad.calls.ide, [], 'a malformed project event never opens in the current workspace');
  assert.deepEqual(bad.calls.defaultApp, []);
});

test('a failing IDE hook toasts', async (t) => {
  const h = harness('', { openProjectFileInIde() { return Promise.resolve(false); } });
  t.after(h.dispose);
  h.dom.window.dispatchEvent(new h.dom.window.CustomEvent('ide:open-file-at-line', { detail: { projectId: 'p-notes', path: 'a.md' }, cancelable: true }));
  await flush();
  assert.equal(h.calls.toasts.length, 1);
});

test('prose paths in a project become chips with no workspace root, and a click on one opens the preview', async (t) => {
  const state = JSON.parse(JSON.stringify(ON));
  state.workspaceRoot = { path: '' };
  const h = harness('<article class="chat-entry message-shell assistant" data-message-id="m1" data-message-role="assistant" data-message-status="complete">'
    + '<div class="chat-bubble chat-bubble-markdown"><p>See D:\\notes\\a.md:5 now, not C:\\Users\\me\\x.txt.</p></div></article>', { state });
  t.after(h.dispose);
  const cite = citeUtils.createCodebaseCiteController({
    document: h.dom.window.document,
    window: h.dom.window,
    chatTimeline: h.dom.window.document.getElementById('chatTimeline'),
    getWorkspaceFs() { return null; },
    isEnabled() { return true; },
    appendClientLog() {},
  });
  const detach = cite.attach();
  t.after(detach);
  const chips = Array.from(h.dom.window.document.querySelectorAll('[data-chat-path-open]'));
  assert.deepEqual(chips.map((el) => el.getAttribute('data-chat-path-open')), ['D:\\notes\\a.md']);
  assert.equal(chips[0].getAttribute('data-chat-path-line'), '5');
  click(h.dom, '[data-chat-path-open]');
  await flush();
  assert.deepEqual(h.calls.preview, [{ projectId: 'p-notes', path: 'a.md', line: 5, column: null, display: 'D:\\notes\\a.md' }]);
});
