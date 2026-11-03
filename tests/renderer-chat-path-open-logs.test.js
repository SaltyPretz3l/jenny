'use strict';

// Client logs from the chat path controller carry a code or error name, never a raw main-process
// error message: it can hold an absolute path (row 95).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatPathOpenController } = require('../renderer/chat/renderer-chat-path-open');
const pathMenuFactory = require('../renderer/features/renderer-ide-path-menu');
const citeUtils = require('../renderer/chat/renderer-chat-codebase-cite-utils');

const LEAKY = 'ENOENT: no such file C:\\Users\\me\\secret\\a.js';
const ROW_HTML = '<div class="tool-call-row" data-chat-path="a/b.js"><span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="a/b.js">a/b.js</span></div>';
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function harness(t, overrides) {
  const dom = new JSDOM('<!doctype html><body><div id="chatView"><div id="chatTimeline">' + ROW_HTML + '</div><aside id="subagentInspector"></aside></div></body>', { url: 'https://jenny.local/chat' });
  const calls = { logs: [], menus: [] };
  const controller = createChatPathOpenController(Object.assign({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    pathRoots: [dom.window.document.getElementById('subagentInspector')],
    state: { workspaceRoot: { path: 'G:/workspace' }, ui: { activeView: 'chat' } },
    setActiveView() {},
    openIdeFileAtLine: () => Promise.resolve(true),
    getWorkspaceFs: () => ({ openInDefaultApp: () => Promise.resolve({ ok: true }) }),
    showToastMessage() {},
    appendClientLog(level, event, payload) { calls.logs.push({ level, event, payload }); },
    contextMenu: { show(options) { calls.menus.push(options); }, hide() {} },
    pathMenuFactory,
    citeUtils,
  }, overrides || {}));
  const dispose = controller.attach();
  t.after(() => { dispose(); dom.window.close(); });
  const open = (detail) => dom.window.dispatchEvent(new dom.window.CustomEvent('ide:open-file-at-line', { detail, bubbles: true, cancelable: true }));
  return { dom, calls, open, logged: () => JSON.stringify(calls.logs.map((entry) => entry.payload)) };
}

test('an IDE open failure logs a bounded reason, not the raw error message', async (t) => {
  const h = harness(t, { openIdeFileAtLine: () => Promise.reject({ message: LEAKY, error_code: 'CMP-WORKSPACEFS-0004' }) });
  h.open({ path: 'stale/path.js', line: 9 });
  await settle();
  const entry = h.calls.logs.find((log) => log.event === 'chat.path_open_ide_failed');
  assert.equal(entry.payload.reason, 'CMP-WORKSPACEFS-0004');
  assert.equal('message' in entry.payload, false);
  assert.ok(!h.logged().includes('secret'));
});

test('a panel failure logs the error name, not its message', async (t) => {
  const h = harness(t, { openFilePreviewTarget: () => Promise.reject(new TypeError(LEAKY)) });
  h.open({ path: 'a/b.js', line: 3 });
  await settle();
  const entry = h.calls.logs.find((log) => log.event === 'chat.path_open_panel_failed');
  assert.equal(entry.payload.reason, 'TypeError');
  assert.ok(!h.logged().includes('secret'));
});

test('a failed path-menu action logs a bounded reason, not the raw error message', (t) => {
  const h = harness(t);
  h.dom.window.document.querySelector('.tool-call-row').dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  h.calls.menus[0].onActionError(Object.assign(new Error(LEAKY), { code: 'EACCES' }));
  const entry = h.calls.logs.find((log) => log.event === 'chat.path_menu_action_failed');
  assert.equal(entry.payload.reason, 'EACCES');
  assert.ok(!h.logged().includes('secret'));
});
