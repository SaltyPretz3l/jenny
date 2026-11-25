'use strict';

/* Row 190: the Chat room on the workbench. The binding (renderer-chat-workbench.js) in JSDOM with the real
 * model, ops and workbench; its layout store (renderer-chat-layout-store.js) and the one right stack
 * (renderer-chat-right-stack.js) against a fake side-panel state machine. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const workbenchUtils = require('../renderer/features/renderer-ide-workbench');
const { createChatWorkbench } = require('../renderer/chat/renderer-chat-workbench');
const { createChatLayoutStore, LAYOUT_KEY } = require('../renderer/chat/renderer-chat-layout-store');
const rightStackUtils = require('../renderer/chat/renderer-chat-right-stack');

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

const SHELL = '<!doctype html><html data-active-view="chat"><body>'
  + '<div id="workspace"><aside id="viewPanel"><div id="sidebarHistorySection"><h2 class="sidebar-title">Chats</h2>'
  + '<button id="newChatButton" class="new-chat-button">New chat</button></div></aside>'
  + '<main class="main-stage"><div class="main-stage-glow"></div><div id="workspaceRailShell"></div>'
  + '<section id="homeView"></section>'
  + '<section id="chatView" class="chat-view" data-pane-count="1"><div class="chat-pane" id="chatPane0" data-pane-id="0" data-pane-focused="true">'
  + '<textarea data-chat-node="chatInput"></textarea></div>'
  + '<aside id="artifactReviewPanel" class="artifact-review-panel hidden"></aside>'
  + '<aside id="chatContextPanel"></aside></section>'
  + '<section id="ideView"></section></main></div></body></html>';

// A side-panel state machine stand-in: open/close by mode, and present() through the right stack, as the rail does.
function fakeRail(getStack) {
  const rail = { visible: false, mode: 'artifact', opened: [], resumed: [], collapses: 0 };
  rail.sync = () => getStack()?.present({ visible: rail.visible, mode: rail.mode });
  rail.open = (mode) => { rail.opened.push(mode); rail.visible = true; rail.mode = mode; rail.sync(); return true; };
  rail.resume = (mode) => { rail.resumed.push(mode); rail.visible = true; rail.mode = mode; rail.sync(); return true; };
  rail.close = () => { rail.visible = false; rail.sync(); };
  rail.state = () => ({ visible: rail.visible, mode: rail.mode, collapse: () => { rail.collapses += 1; rail.close(); } });
  return rail;
}

function setup(opts = {}) {
  const dom = new JSDOM(SHELL, { pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  const storage = memoryStorage(opts.storage);
  let width = opts.width || 0;
  win.HTMLElement.prototype.getBoundingClientRect = function rect() {
    const w = this.id === 'chatWorkbench' ? width : 0;
    return { width: w, height: w ? 800 : 0, top: 0, left: 0, right: w, bottom: w ? 800 : 0, x: 0, y: 0 };
  };
  const calls = { newChat: 0, closeActivity: 0 };
  let bench = null;
  const rail = fakeRail(() => bench && bench.getRightStack());
  bench = createChatWorkbench({
    doc,
    win,
    workbenchUtils,
    layoutModel: model,
    layoutOps: ops,
    store: createChatLayoutStore({ storage, model }),
    rightStackUtils,
    jt: (k, d, p) => String(d).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? p[n] : m)),
    newChat: () => { calls.newChat += 1; },
    focusComposer: () => true,
    getFontScale: () => 1,
    openMode: (mode) => rail.open(mode),
    resumeMode: (mode) => rail.resume(mode),
    rail: () => rail.state(),
    isActivityAvailable: () => true,
    closeActivity: () => { calls.closeActivity += 1; doc.getElementById('chatContextPanel').classList.remove('activity-mode'); },
  });
  return { dom, win, doc, storage, bench, rail, calls, setWidth: (w) => { width = w; }, q: (s) => doc.querySelector(s) };
}

test('mount adopts the tab row and #chatView as the centre and the Chats content as the left stack; unmount puts all back', () => {
  const rig = setup();
  assert.equal(rig.bench.mount(), true);
  const root = rig.q('#chatWorkbench');
  assert.ok(root && root.classList.contains('ide-workbench'));
  assert.equal(root.parentNode, rig.q('.main-stage'), 'the room sits in the main stage');
  const centre = rig.q('.chat-workbench-centre');
  assert.deepEqual(Array.from(centre.children).map((c) => c.id), ['workspaceRailShell', 'chatView']);
  assert.equal(rig.q('#sidebarHistorySection').parentNode, rig.bench.hostFor('chats'));
  assert.equal(rig.doc.documentElement.dataset.chatWorkbench, 'on');
  const tabs = Array.from(rig.doc.querySelectorAll('[data-wb-tab]')).map((t) => t.getAttribute('data-wb-tab'));
  assert.deepEqual(tabs, ['chats', 'session', 'artifacts', 'changes', 'project']);
  assert.ok(rig.q('#chat-wbView-session'), 'element ids carry the chat- prefix beside the Workspace and the Board');

  rig.bench.unmount();
  assert.equal(rig.q('#chatWorkbench'), null);
  assert.equal(rig.q('#sidebarHistorySection').parentNode, rig.q('#viewPanel'));
  const stage = Array.from(rig.q('.main-stage').children).map((c) => c.id || c.className);
  assert.deepEqual(stage, ['main-stage-glow', 'workspaceRailShell', 'homeView', 'chatView', 'ideView']);
  assert.equal(rig.doc.documentElement.dataset.chatWorkbench, undefined);
  assert.equal(rig.bench.toggle('chats'), false, 'an unmounted room answers no');
  assert.equal(rig.bench.mount(), true, 'and mounts again');
});

test('New chat is the Chats stack header action and the folded strip second button', () => {
  const rig = setup();
  rig.bench.mount();
  const header = rig.q('[data-wb-stack] [data-wb-action="view:new-chat"]');
  assert.ok(header, 'header action');
  header.click();
  assert.equal(rig.calls.newChat, 1);
  rig.bench.toggle('chats');
  const strip = rig.q('.wb-strip [data-wb-action="view:new-chat"]') || rig.q('[data-wb-action="view:new-chat"]');
  assert.ok(rig.q('[data-wb-strip="chats"]'), 'the folded stack is a strip with the Chats button');
  strip.click();
  assert.equal(rig.calls.newChat, 2);
  rig.q('[data-wb-strip="chats"]').click();
  assert.equal(rig.bench.isViewVisible('chats'), true, 'the strip button reopens the stack');
});

test('Ctrl+B and Ctrl+Alt+B targets fold and reopen each stack, and the layout is saved under one record', () => {
  const rig = setup();
  rig.bench.mount();
  assert.equal(rig.bench.isViewVisible('session'), true, 'a fresh profile starts with the right stack open on Session');
  rig.bench.toggle('right');
  assert.equal(rig.bench.isViewVisible('session'), false);
  assert.equal(model.findView(JSON.parse(rig.storage.getItem(LAYOUT_KEY)), 'session').collapsed, true);
  rig.bench.toggle('right');
  assert.equal(rig.bench.isViewVisible('session'), true);
  rig.bench.toggle('chats');
  assert.equal(rig.bench.isViewVisible('chats'), false);
  rig.bench.toggle('chats');
  assert.equal(rig.bench.isViewVisible('chats'), true);
});

test('layout store: the old shell widths seed the layout once; a damaged record falls back; nothing foreign is admitted', () => {
  const storage = memoryStorage({
    'jenny.panels.v2': { version: 2, byView: { chat: { width: 280, collapsed: true } } },
    'jenny.artifactReview.v1': { width: 460 },
    'jenny.sessionRail.v1': { width: 300 },
  });
  const store = createChatLayoutStore({ storage, model });
  const layout = store.loadLayout();
  const size = (view) => {
    const found = model.findView(layout, view);
    return layout.root.children.find((c) => c.node.id === found.stackId).size;
  };
  assert.equal(size('chats'), 280);
  assert.equal(model.findView(layout, 'chats').collapsed, true);
  assert.equal(size('session'), 460, 'the wider of the side panel and the session rail seeds the right stack');
  assert.ok(storage.getItem(LAYOUT_KEY), 'written at once');
  storage.setItem('jenny.panels.v2', JSON.stringify({ version: 2, byView: { chat: { width: 400 } } }));
  assert.deepEqual(store.loadLayout(), layout, 'the old keys are read once');

  const damaged = createChatLayoutStore({ storage: memoryStorage({ [LAYOUT_KEY]: '{not json' }), model }).loadLayout();
  assert.deepEqual(damaged, model.createDefaultLayout('chat'));
  const damagedAfterSeed = memoryStorage({ 'jenny.panels.v2': { version: 2, byView: { chat: { width: 280, collapsed: true } } } });
  damagedAfterSeed.map.set(LAYOUT_KEY, '{not json');
  assert.deepEqual(createChatLayoutStore({ storage: damagedAfterSeed, model }).loadLayout(), model.createDefaultLayout('chat'),
    'a damaged record resets to the default: the old shell sizes seed only a room that never saved');
  const foreign = model.createDefaultLayout();
  const fromWorkspace = createChatLayoutStore({ storage: memoryStorage({ [LAYOUT_KEY]: foreign }), model }).loadLayout();
  assert.equal(model.findView(fromWorkspace, 'explorer'), null);
  assert.equal(fromWorkspace.profile, 'chat');
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(createChatLayoutStore({ storage: blocked, model }).loadLayout(), model.createDefaultLayout('chat'));
});

test('right stack: an open side panel moves into its view; Session closes it; Close collapses the stack', () => {
  const rig = setup();
  rig.bench.mount();
  const panel = rig.q('#artifactReviewPanel');
  rig.rail.open('tasks');
  assert.equal(panel.parentNode, rig.bench.hostFor('project'), 'one live panel, moved to the Project host');
  assert.equal(panel.classList.contains('hidden'), false);
  assert.equal(rig.bench.isViewVisible('project'), true);
  // Row 195: Notes is the same tab; the tab then reopens on the side it last showed.
  rig.rail.open('notes');
  assert.equal(panel.parentNode, rig.bench.hostFor('project'));
  assert.equal(rig.bench.isViewVisible('project'), true);
  rig.q('[data-wb-tab="session"]').click();
  rig.q('[data-wb-tab="project"]').click();
  assert.equal(rig.rail.mode, 'notes', 'Project reopens on Notes');
  rig.rail.open('background_tasks');
  assert.equal(panel.parentNode, rig.bench.hostFor('runs'), 'Runs joins on demand');
  rig.rail.open('subagents');
  assert.equal(panel.parentNode, rig.bench.hostFor('runs'), "a helper's page is inside Runs");

  rig.q('[data-wb-tab="artifacts"]').click();
  assert.equal(rig.rail.mode, 'artifact', 'a tab opens its mode');
  assert.equal(panel.parentNode, rig.bench.hostFor('artifacts'));

  rig.q('[data-wb-tab="session"]').click();
  assert.equal(rig.rail.visible, false, 'Session closes the panel without a dismissal');
  assert.equal(rig.bench.isViewVisible('session'), true, 'and stays on Session');

  rig.q('[data-wb-tab="changes"]').click();
  assert.equal(rig.rail.mode, 'code_review');
  rig.rail.close(); // the panel's own Close
  assert.equal(rig.bench.isViewVisible('changes'), false, 'Close collapses the stack');
  assert.equal(rig.bench.isViewVisible('session'), false);
});

test('right stack: collapsing the stack closes the panel; an optional view joins on open and its Close removes it', () => {
  const rig = setup();
  rig.bench.mount();
  rig.rail.open('notes');
  rig.bench.toggle('right');
  assert.equal(rig.rail.visible, false, 'a collapsed stack closes the panel');
  assert.ok(rig.rail.collapses >= 1);

  rig.rail.open('file_preview');
  const layout = rig.bench.getLayout();
  assert.ok(model.findView(layout, 'preview'), 'the file preview joined the stack');
  assert.equal(rig.bench.isViewVisible('preview'), true);
  assert.equal(rig.q('#artifactReviewPanel').parentNode, rig.bench.hostFor('preview'));
  rig.q('[data-wb-action="view:close"]').click();
  assert.equal(model.findView(rig.bench.getLayout(), 'preview'), null, 'Close removes the optional tab');
  assert.equal(rig.rail.visible, false);

  rig.rail.open('terminal');
  rig.rail.close();
  assert.equal(model.findView(rig.bench.getLayout(), 'terminal'), null, 'the panel Close on an optional view closes its tab');
});

test('row 197: the Live tab joins on open like Browser, leaves on its Close, and the stack lends its width to Wide', () => {
  const rig = setup({ width: 1600 });
  rig.bench.mount();
  rig.rail.open('live');
  assert.ok(model.findView(rig.bench.getLayout(), 'live-view'), 'the Live view joined the stack');
  assert.equal(rig.q('[data-wb-tab="live-view"]').textContent.trim(), 'Live');
  assert.equal(rig.q('#artifactReviewPanel').parentNode, rig.bench.hostFor('live-view'));
  assert.equal(rig.bench.getRightStack().size.set(700), true);
  assert.ok(JSON.stringify(rig.bench.getLayout()).includes('"size":700'), 'the width is committed through the layout');
  rig.q('[data-wb-action="view:close"]').click();
  assert.equal(model.findView(rig.bench.getLayout(), 'live-view'), null, 'Close removes the tab');
  assert.equal(rig.rail.visible, false);
});

test('Activity is an optional view: open, its panel moves into the tab; closed, it goes home and the tab leaves', async () => {
  const rig = setup();
  rig.bench.mount();
  const context = rig.q('#chatContextPanel');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  context.classList.add('activity-mode');
  await tick();
  assert.ok(model.findView(rig.bench.getLayout(), 'activity'), 'Activity joined the right stack');
  assert.equal(context.parentNode, rig.bench.hostFor('activity'));
  assert.equal(rig.bench.isViewVisible('activity'), true);
  context.classList.remove('activity-mode');
  await tick();
  assert.equal(model.findView(rig.bench.getLayout(), 'activity'), null, 'its own Close takes the tab away');
  assert.equal(context.parentNode, rig.q('#chatView'), 'and the panel goes home');

  context.classList.add('activity-mode');
  await tick();
  rig.q('[data-wb-action="view:close"]').click();
  await tick();
  assert.equal(rig.calls.closeActivity, 1, 'the tab Close closes Activity');
  assert.equal(model.findView(rig.bench.getLayout(), 'activity'), null);
  // The side panel can still park in #chatView while Activity lives elsewhere.
  context.classList.add('activity-mode');
  await tick();
  rig.rail.open('terminal');
  rig.rail.close();
  assert.equal(rig.q('#artifactReviewPanel').parentNode, rig.q('#chatView'), 'never detached');
  rig.bench.unmount();
  assert.equal(context.parentNode, rig.q('#chatView'), 'unmount puts Activity home');
});

test('a saved layout: optional tabs do not come back, and a saved panel tab reopens its panel', () => {
  const saved = model.createDefaultLayout('chat');
  let layout = ops.addView(saved, 'terminal', 'session');
  layout = model.setActiveView(layout, 'project');
  const rig = setup({ storage: { [LAYOUT_KEY]: layout } });
  rig.bench.mount();
  assert.equal(model.findView(rig.bench.getLayout(), 'terminal'), null, 'the empty Terminal tab is gone');
  if (rig.bench.isViewVisible('project')) assert.deepEqual(rig.rail.opened, ['tasks'], 'the shown Project tab opened its panel');
});

test('row 195: a layout saved with Tasks and Notes tabs comes back with one Project tab in their place, still the open one', () => {
  const old = JSON.parse(JSON.stringify(model.createDefaultLayout('chat')).replace('"views":["session","artifacts","changes","project"],"active":"session"', '"views":["session","tasks","artifacts","notes","changes","background"],"active":"notes"'));
  const rig = setup({ storage: { [LAYOUT_KEY]: old } });
  rig.bench.mount();
  const stack = model.findView(rig.bench.getLayout(), 'project');
  const views = JSON.stringify(rig.bench.getLayout()).match(/"views":\["session"[^\]]*\]/)[0];
  assert.equal(views, '"views":["session","project","artifacts","changes"]', 'Project where Tasks was; the optional Runs tab does not come back empty');
  assert.ok(stack);
  assert.equal(rig.bench.isViewVisible('project') || !rig.bench.isViewVisible('session'), true, 'Project is the open tab');
});

test('a saved panel tab waits while another room is on screen, then reopens its panel when Chat shows', async () => {
  const layout = model.setActiveView(model.createDefaultLayout('chat'), 'project');
  const rig = setup({ storage: { [LAYOUT_KEY]: layout } });
  const root = rig.q('html') || rig.win.document.documentElement;
  root.dataset.activeView = 'home';
  rig.bench.mount();
  assert.deepEqual(rig.rail.opened, [], 'nothing opens (and nothing pulls the user into Chat) from Home');
  root.dataset.activeView = 'chat';
  rig.bench.render();
  await new Promise((resolve) => rig.win.requestAnimationFrame(resolve));
  if (rig.bench.isViewVisible('project')) assert.deepEqual(rig.rail.opened, ['tasks'], 'Chat on screen: the Project tab opens its panel once');
});

test('two panes keep 360px each, or the second folds once both side stacks are strips', () => {
  const rig = setup({ width: 1400 });
  rig.bench.mount();
  const view = rig.q('#chatView');
  view.dataset.paneCount = '2';
  rig.bench.render();
  return new Promise((resolve) => rig.win.requestAnimationFrame(resolve)).then(() => {
    assert.equal(view.dataset.splitFolded, undefined, '1400px holds two panes');
    rig.setWidth(780);
    rig.bench.render();
    return new Promise((resolve) => rig.win.requestAnimationFrame(resolve));
  }).then(() => {
    assert.equal(view.dataset.splitFolded, 'true', '780 - 64 < 720: the second pane folds');
    rig.setWidth(900);
    rig.bench.render();
    return new Promise((resolve) => rig.win.requestAnimationFrame(resolve));
  }).then(() => {
    assert.equal(view.dataset.splitFolded, undefined, 'and returns when the room widens');
    rig.bench.unmount();
    assert.equal(view.dataset.splitFolded, undefined);
  });
});

// The booted app (renderer-shell-harness): the workbench's scripts load at boot, then it mounts by default.
async function bootApp(t) {
  const { loadRendererApp, waitForStartupCurtainRemoval, waitForUi } = require('./helpers/renderer-shell-harness');
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  await waitForStartupCurtainRemoval(app.window);
  for (let i = 0; i < 40 && !app.window.rendererChatWorkbenchController?.isMounted?.(); i += 1) await waitForUi(app.window, 5);
  await waitForUi(app.window, 30);
  const pressCtrl = (key, extra = {}) => app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
  return { app, win: app.window, doc: app.window.document, bench: app.window.rendererChatWorkbenchController, wait: (n) => waitForUi(app.window, n), pressCtrl };
}

test('app boot: Ctrl+B folds the Chats stack, Ctrl+Alt+B and Ctrl+Backslash fold and reopen the right stack', async (t) => {
  const { doc, bench, wait, pressCtrl } = await bootApp(t);
  assert.ok(bench && bench.isMounted(), 'the Chat room mounts its workbench by default');
  assert.equal(doc.getElementById('workspace').classList.contains('panel-none'), true, 'the old Chats panel column is gone');
  assert.equal(doc.getElementById('sidebarHistorySection').closest('[data-wb-view]')?.getAttribute('data-wb-view'), 'chats');
  doc.getElementById('chatTopRailTab').focus();
  pressCtrl('b');
  await wait(30);
  assert.equal(bench.isViewVisible('chats'), false, 'Ctrl+B folds Chats');
  pressCtrl('b');
  await wait(30);
  assert.equal(bench.isViewVisible('chats'), true, 'and reopens it');
  const rightOpen = bench.isViewVisible('session');
  pressCtrl('b', { altKey: true });
  await wait(30);
  assert.equal(bench.isViewVisible('session'), !rightOpen, 'Ctrl+Alt+B flips the right stack');
  pressCtrl('\\', { code: 'Backslash' });
  await wait(30);
  assert.equal(bench.isViewVisible('session'), rightOpen, 'Ctrl+Backslash flips it back');
});

// The real side panel in the booted app: a Tasks or Changes tab must keep its view shown. The rail's
// stored prefs lag behind a non-artifact mode, so the stack reads the live mode (regression, 2026-11-23).
test('app boot: the Project and Changes tabs show their panel and keep the right stack open', async (t) => {
  const { doc, bench, wait } = await bootApp(t);
  assert.ok(bench && bench.isMounted());
  const tab = (view) => doc.querySelector(`#chatWorkbench [data-wb-tab="${view}"]`);
  // No chat yet: the panel cannot open, and the tab still shows (no phantom dismissal).
  tab('project').click();
  await wait(30);
  assert.equal(bench.isViewVisible('project'), true, 'a tab with no chat to show keeps its view');
  doc.getElementById('newChatButton').click();
  await wait(15);
  for (const view of ['project', 'changes']) {
    bench.revealView('session');
    await wait(15);
    tab(view).click();
    await wait(30);
    assert.equal(bench.isViewVisible(view), true, `${view} stays shown after the render`);
    const panel = doc.getElementById('artifactReviewPanel');
    assert.equal(panel.closest('[data-wb-view]')?.getAttribute('data-wb-view'), view, `${view}: the panel is in its host`);
    assert.equal(panel.classList.contains('hidden'), false, `${view}: the panel shows`);
  }
});

test('row 190 Wave 4: a room stack over the Workspace layout: Artifacts joins beside the chat, its Close sends the panel home', () => {
  const dom = new JSDOM('<!doctype html><body><section id="chatView"><aside id="chatContextPanel"></aside></section>'
    + '<aside id="artifactReviewPanel" class="artifact-review-panel hidden"></aside></body>');
  const doc = dom.window.document;
  let layout = model.createDefaultLayout();
  const hosts = new Map();
  const host = (id) => { if (!hosts.has(id)) { const el = doc.createElement('div'); doc.body.appendChild(el); hosts.set(id, el); } return hosts.get(id); };
  const visible = (id) => { const found = model.findView(layout, id); return Boolean(found) && !found.collapsed && found.active; };
  const wb = { hostFor: host, isViewVisible: visible, revealView: (id) => { layout = model.revealView(layout, id); return true; }, collapseStackOf: () => {}, getActiveView: (id) => { const f = model.findView(layout, id); return f && f.active ? id : null; } };
  const rail = { visible: false, mode: 'artifact', collapses: 0, collapse() { this.visible = false; this.collapses += 1; } };
  rightStackUtils.setPanelAccess({ rail: () => rail, openMode: (mode) => { rail.visible = true; rail.mode = mode; return true; } });
  const stack = rightStackUtils.createRoomStack({
    workbench: wb, getLayout: () => layout, commit: (next) => { layout = next; }, model, ops, doc,
    modeViews: { artifact: 'artifacts', tasks: 'tasks', notes: 'notes' }, near: ['notes', 'tasks', 'artifacts', 'changes', 'chat'],
  });
  assert.deepEqual(Object.keys(stack.views()), ['artifacts', 'tasks', 'notes']);
  assert.equal(stack.serves('artifact'), true);
  assert.equal(stack.serves('code_review'), false, 'no Changes mode here: the dock has its own');
  const panel = doc.getElementById('artifactReviewPanel');
  stack.present({ visible: true, mode: 'artifact', panel });
  assert.equal(model.findView(layout, 'artifacts'), null, 'a panel already open when the room came on screen adds no tab');
  stack.present({ visible: true, mode: 'artifact', panel, explicit: true });
  const found = model.findView(layout, 'artifacts');
  assert.ok(found, 'Artifacts joined the tree');
  assert.equal(found.stackId, model.findView(layout, 'chat').stackId, 'in the stack of the chat');
  assert.equal(panel.parentNode, host('artifacts'), 'the one panel moved into its host');
  assert.equal(panel.classList.contains('hidden'), false);
  rail.visible = true;
  stack.releaseViews();
  assert.equal(model.findView(layout, 'artifacts'), null, 'a reset takes the tab out first');
  assert.equal(panel.parentNode, doc.getElementById('chatView'), 'and the live panel went home, still in the document');
  stack.present({ visible: true, mode: 'artifact', panel, explicit: true });
  stack.closeView('artifacts');
  assert.equal(model.findView(layout, 'artifacts'), null, 'its Close takes the tab out');
  assert.equal(panel.parentNode, doc.getElementById('chatView'), 'the panel went home');
  assert.equal(panel.nextSibling, doc.getElementById('chatContextPanel'), 'before Activity');
  assert.equal(rail.collapses, 1, 'and closed without a dismissal');
  const leave = rightStackUtils.registerRoom('ide', () => stack);
  assert.equal(rightStackUtils.roomStack('ide'), stack);
  assert.equal(rightStackUtils.roomStack('board'), null);
  leave();
  assert.equal(rightStackUtils.roomStack('ide'), null);
  rightStackUtils.setPanelAccess({ rail: () => null, openMode: () => false });
});

test('the composition hands the side panel to the Workspace and Board room stacks, and takes it back on teardown', () => {
  const { composeChatWorkbench } = require('../renderer/app/renderer-app-chat-workbench-composition');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const given = [];
  const cleanups = [];
  const rail = { visible: true, mode: 'tasks' };
  const opened = [];
  const bridge = { getRailState: () => rail, openRailMode: (mode) => { opened.push(mode); return true; } };
  composeChatWorkbench({
    state: {}, windowRef: { rendererChatRightStack: { setPanelAccess: (access) => given.push(access) }, addEventListener() {}, removeEventListener() {} },
    documentRef: dom.window.document, getArtifactBridge: () => bridge, registerCleanup: (fn) => cleanups.push(fn),
  });
  assert.equal(given.length, 1, 'handed over at compose time, before any room stack presents');
  assert.equal(given[0].rail(), rail);
  assert.equal(given[0].openMode('notes'), true);
  assert.deepEqual(opened, ['notes']);
  cleanups.forEach((fn) => fn());
  assert.equal(given.length, 2);
  assert.equal(given[1].rail(), null, 'teardown leaves no stale state machine behind');
});

test('a room stack drops a side-panel tab its saved layout still holds, so a restart never opens on an empty tab', () => {
  let layout = ops.addView(model.createDefaultLayout(), 'artifacts', 'chat');
  assert.ok(model.findView(layout, 'artifacts'), 'precondition: the saved layout holds the tab');
  const commits = [];
  rightStackUtils.createRoomStack({
    workbench: { hostFor: () => null, isViewVisible: () => false, revealView: () => false, collapseStackOf: () => {}, getActiveView: () => null },
    getLayout: () => layout, commit: (next) => { commits.push(next); layout = next; }, model, ops, doc: new JSDOM('').window.document,
    modeViews: { artifact: 'artifacts' }, near: ['changes', 'chat'],
  });
  assert.equal(commits.length, 1);
  assert.equal(model.findView(layout, 'artifacts'), null);
});

test('a Chat workbench render while another room is on screen leaves the panel that room shows alone', async () => {
  const rig = setup();
  rig.bench.mount();
  assert.equal(rig.bench.isViewVisible('session'), true);
  rig.doc.documentElement.dataset.activeView = 'ide';
  // The Workspace opened the panel in its own stack: the rail is open on a mode Chat's stack is not showing.
  rig.rail.visible = true;
  rig.rail.mode = 'artifact';
  rig.bench.render();
  await new Promise((resolve) => rig.win.requestAnimationFrame(resolve));
  assert.equal(rig.rail.collapses, 0, 'the hidden room never closes it');
  assert.equal(rig.rail.visible, true);
});

test('a panel closed because its stack folded away comes back as it was left, not freshly opened', () => {
  const rig = setup();
  rig.bench.mount();
  rig.q('[data-wb-tab="changes"]').click();
  assert.deepEqual(rig.rail.opened, ['code_review']);
  rig.bench.toggle('right');
  assert.equal(rig.rail.visible, false, 'the collapsed stack closed the panel');
  rig.bench.toggle('right');
  assert.equal(rig.rail.visible, true);
  assert.deepEqual(rig.rail.opened, ['code_review'], 'no second open: the review on screen is not replaced');
  assert.deepEqual(rig.rail.resumed, ['code_review']);
  // A tab the person picks still opens its mode fresh.
  rig.q('[data-wb-tab="session"]').click();
  rig.q('[data-wb-tab="changes"]').click();
  assert.deepEqual(rig.rail.opened, ['code_review', 'code_review']);
});
