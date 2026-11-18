'use strict';

// new-test-file: a new surface, the chat Terminal side panel (row 178 slice B); no existing test file covers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const owner = require('../renderer/chat/renderer-chat-terminal-panel');
const render = require('../renderer/chat/renderer-chat-terminal-panel-render');
const shortcuts = require('../renderer/shell/renderer-global-shortcuts');
const inlineTitleEditor = require('../renderer/inventory/inline-title-editor');
const contextMenu = require('../renderer/inventory/context-menu');

const ROOT = 'D:\\Work\\jenny';
const entry = (slot, extra = {}) => ({
  slot, viewId: `terminal-${slot}`, label: `Terminal ${slot}`, running: true, starting: false, task: false, cwd: ROOT, shell: 'PowerShell', ...extra,
});

/* A fake of window.rendererIdeTerminalPool (the shared seam slice A builds): every call is recorded. */
function makePool({ rootPath = ROOT, entries = [] } = {}) {
  const listeners = new Set();
  const calls = [];
  const pool = {
    maxTerminals: 4,
    entries,
    calls,
    selection: '',
    hosted: 0,
    root: rootPath,
    list: () => pool.entries.map((e) => ({ ...e })),
    rootPath: () => pool.root,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) { for (const fn of [...listeners]) fn(event); },
    listenerCount: () => listeners.size,
    async create(options) {
      calls.push(['create', options]);
      if (pool.entries.length >= 4) return { ok: false, reason: 'max_terminals' };
      const slot = [1, 2, 3, 4].find((n) => !pool.entries.some((e) => e.slot === n));
      pool.entries.push(entry(slot));
      return { ok: true, slot };
    },
    async start(slot) { calls.push(['start', slot]); pool.entries = pool.entries.map((e) => (e.slot === slot ? { ...e, running: true, cwd: pool.root } : e)); return true; },
    async close(slot) { calls.push(['close', slot]); pool.entries = pool.entries.filter((e) => e.slot !== slot); return true; },
    rename(slot, name) { calls.push(['rename', slot, name]); return true; },
    clear(slot) { calls.push(['clear', slot]); return true; },
    async listProfiles() { return [{ id: 'powershell', label: 'PowerShell' }, { id: 'cmd', label: 'Command Prompt' }]; },
    host(slot, el) { calls.push(['host', slot, el]); pool.hosted = slot; return true; },
    refit() { calls.push(['refit']); },
    release() { calls.push(['release']); pool.hosted = 0; },
    hostedSlot: () => pool.hosted,
    showInWorkspace(slot) { calls.push(['showInWorkspace', slot]); return true; },
    getSelection: () => pool.selection,
    focus(slot) { calls.push(['focus', slot]); },
  };
  return pool;
}

const names = (pool, kind) => pool.calls.filter((c) => c[0] === kind);

/* The panel with its chrome faked: a title slot, a content host, and the rail calls the shell owns. */
async function mountPanel(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><aside id="artifactReviewPanel" class="artifact-review-panel hidden">'
    + '<div data-artifact-panel-title-slot></div><div id="content"></div></aside><textarea class="composer-input" id="composer"></textarea></body>',
  { pretendToBeVisual: true });
  const win = dom.window;
  t.after(() => win.close());
  const panelEl = win.document.getElementById('artifactReviewPanel');
  const content = win.document.getElementById('content');
  const titleSlot = win.document.querySelector('[data-artifact-panel-title-slot]');
  const pool = options.pool || makePool({ entries: options.entries || [entry(1)] });
  const pty = options.pty !== false;
  win.jennyShell = pty ? { workspacePty: {} } : {};
  let ensured = options.ensured === true;
  win.rendererIdeTerminalPool = {
    ensure: options.ensure || (async () => { ensured = true; return options.noPool ? null : pool; }),
    peek: () => (ensured ? pool : null),
  };
  win.inventoryInlineTitleEditor = inlineTitleEditor;
  win.inventoryContextMenu = contextMenu;
  const state = {
    currentSessionId: 's1',
    sessions: [{ id: 's1', project_id: options.projectId || 'project_general' }],
    ui: { artifactReview: { mode: 'artifact', enabled: false, collapsed: false } },
    features: { featureFlags: options.flags || {} },
  };
  const inserts = [];
  const frames = [];
  const clips = [];
  const closed = [];
  let maximized = false;
  const switcher = options.switcher === undefined ? {
    refresh: async () => {},
    projectById: (id) => (id === 'p1' ? { id, name: 'jenny-site', rootPath: options.projectRoot || 'D:\\Work\\jenny-site' } : null),
    switchToProject: async (id) => { switcher.switched.push(id); },
    switched: [],
  } : options.switcher;
  let controller = null;
  const doRender = () => {
    if (!controller || !controller.isOpen()) return;
    controller.renderRailContent(content);
    const html = controller.titleHtml();
    if (titleSlot.dataset.html !== html) { titleSlot.innerHTML = html; titleSlot.dataset.html = html; }
  };
  controller = owner.createChatTerminalPanel({
    state,
    windowRef: win,
    dom: { artifactReviewPanel: panelEl },
    openArtifactRail: (mode) => { state.ui.artifactReview.mode = mode; state.ui.artifactReview.enabled = true; panelEl.classList.remove('hidden'); panelEl.dataset.artifactReviewMode = mode; },
    renderArtifactReviewPanel: doRender,
    toggleArtifactReview: () => { state.ui.artifactReview.enabled = false; panelEl.classList.add('hidden'); closed.push(true); },
    claimOwner: () => {},
    getPanelSessionId: () => state.currentSessionId,
    getProjectSwitcher: async () => switcher,
    toggleMaximize: () => { maximized = !maximized; return maximized; },
    isMaximized: () => maximized,
    insertIntoComposer: (payload) => { inserts.push(payload); return true; },
    copyText: async (text) => { clips.push(text); },
    appendClientLog: () => {},
    requestFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelFrame: () => {},
  });
  controller.bind();
  t.after(() => controller.dispose());
  const head = () => panelEl.querySelector('.chat-terminal-head');
  const tabs = () => [...panelEl.querySelectorAll('[role="tab"]')];
  const tab = (slot) => panelEl.querySelector(`[data-ct-tab="${slot}"]`);
  const mount = () => panelEl.querySelector('[data-chat-terminal-mount]');
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { win, doc: win.document, panelEl, content, controller, pool, state, inserts, frames, clips, closed, switcher, head, tabs, tab, mount, flush, doRender,
    setMaximized: (v) => { maximized = v; }, text: () => panelEl.textContent };
}

test('the panel says terminals are unavailable when the pool cannot load', async (t) => {
  const h = await mountPanel(t, { noPool: true });
  assert.equal(await h.controller.open({ sessionId: 's1' }), true);
  assert.match(h.text(), /Terminals are not available here\./);
  assert.equal(h.tabs().length, 0);
  assert.equal(names(h.pool, 'host').length, 0);
});

test('while the pool loads the panel shows a quiet loading line, then the terminal', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pool = makePool({ entries: [entry(1)] });
  const h = await mountPanel(t, { pool, ensure: async () => { await gate; return pool; } });
  const pending = h.controller.open({ sessionId: 's1' });
  await h.flush();
  assert.match(h.text(), /Loading terminals/);
  release();
  await pending;
  assert.equal(h.tabs().length, 1);
  assert.doesNotMatch(h.text(), /Loading terminals/);
});

test('with no terminal yet the panel offers Start in the open project, and Start starts the first terminal and hosts it', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1, { running: false, cwd: '' })] });
  await h.controller.open({ sessionId: 's1' });
  assert.match(h.text(), /Start a terminal in jenny/);
  assert.equal(h.tabs().length, 0, 'no tabs before a terminal exists');
  assert.ok(h.head().querySelector('[data-ct-max]'), 'only Maximize on the header');
  assert.equal(h.head().querySelector('[data-ct-more]'), null);
  h.panelEl.querySelector('[data-ct-start]').click();
  await h.flush();
  assert.deepEqual(names(h.pool, 'start'), [['start', 1]], 'slot 1 is started; create only adds slots 2-4');
  assert.equal(names(h.pool, 'create').length, 0);
  assert.equal(h.tabs().length, 1);
  assert.equal(h.tab(1).getAttribute('aria-selected'), 'true', 'the started terminal is selected');
  const hosts = names(h.pool, 'host');
  assert.equal(hosts.at(-1)[1], 1);
  assert.equal(hosts.at(-1)[2], h.mount());
  h.panelEl.querySelector('[data-ct-add]').click();
  await h.flush();
  assert.deepEqual(names(h.pool, 'create'), [['create', undefined]], 'with slot 1 running, + adds another');
  assert.equal(h.tab(2).getAttribute('aria-selected'), 'true');
});

test('with no project open the empty state names the terminal start folder', async (t) => {
  const pool = makePool({ rootPath: '', entries: [entry(1, { running: false, cwd: '' })] });
  const h = await mountPanel(t, { pool });
  await h.controller.open({ sessionId: 's1' });
  assert.match(h.text(), /Start a terminal/);
  assert.doesNotMatch(h.text(), /Start a terminal in/);
  assert.match(h.text(), /It opens in your terminal start folder\./);
});

test('a chat of another project never starts or hosts a terminal, and offers to open its project', async (t) => {
  const h = await mountPanel(t, { projectId: 'p1' });
  await h.controller.open({ sessionId: 's1' });
  assert.match(h.text(), /This chat's project, jenny-site, isn't open in the Workspace\./);
  assert.equal(h.tabs().length, 0);
  assert.equal(names(h.pool, 'create').length + names(h.pool, 'host').length + names(h.pool, 'start').length, 0);
  const button = h.panelEl.querySelector('[data-ct-open-project]');
  assert.match(button.textContent, /Open jenny-site in the Workspace/);
  button.click();
  await h.flush();
  assert.deepEqual(h.switcher.switched, ['p1']);
});

test('a project root matches the open folder case-insensitively with unified slashes and no trailing slash', async (t) => {
  const pool = makePool({ rootPath: 'd:/work/JENNY-SITE/', entries: [entry(1)] });
  const h = await mountPanel(t, { pool, projectId: 'p1' });
  await h.controller.open({ sessionId: 's1' });
  assert.equal(h.tabs().length, 1);
  assert.doesNotMatch(h.text(), /isn't open in the Workspace/);
  assert.ok(render.sameFolder('C:\\A\\B\\', 'c:/a/b'));
  assert.ok(!render.sameFolder('C:\\A\\B', 'C:\\A\\C'));
  assert.ok(!render.sameFolder('', 'C:\\A'));
});

test('tabs come from the pool list, the plus greys out at four, and the cross closes a terminal', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2, { label: 'Dev server', cwd: 'D:\\Work\\jenny\\web' })] });
  await h.controller.open({ sessionId: 's1' });
  assert.deepEqual(h.tabs().map((n) => n.querySelector('[data-ct-label]').textContent), ['Terminal 1', 'Dev server']);
  assert.equal(h.tab(2).getAttribute('title'), 'Dev server · PowerShell · D:\\Work\\jenny\\web');
  assert.equal(h.head().querySelector('[data-ct-add]').disabled, false);
  h.pool.entries.push(entry(3), entry(4));
  h.pool.emit({ type: 'changed' });
  assert.equal(h.tabs().length, 4);
  assert.equal(h.head().querySelector('[data-ct-add]').disabled, true);
  h.tab(3).querySelector('[data-ct-close]').click();
  await h.flush();
  assert.deepEqual(names(h.pool, 'close'), [['close', 3]]);
  assert.equal(h.tabs().length, 3);
  assert.equal(h.head().querySelector('[data-ct-add]').disabled, false);
});

test('selecting a tab hosts that terminal, and a head re-render keeps the same mount element', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2)] });
  await h.controller.open({ sessionId: 's1' });
  const mount = h.mount();
  assert.ok(mount);
  assert.equal(names(h.pool, 'host').length, 1);
  assert.equal(names(h.pool, 'host')[0][1], 1);
  h.tab(2).click();
  await h.flush();
  assert.equal(h.tab(2).getAttribute('aria-selected'), 'true');
  assert.deepEqual(names(h.pool, 'host').at(-1).slice(1), [2, mount]);
  const hostCalls = names(h.pool, 'host').length;
  h.pool.entries[0].label = 'Renamed';
  h.pool.emit({ type: 'changed' });
  h.pool.emit({ type: 'changed' });
  assert.equal(h.mount(), mount, 'the live terminal stays in place');
  assert.equal(names(h.pool, 'host').length, hostCalls, 'no host call for a head-only change');
  assert.equal(h.tab(1).querySelector('[data-ct-label]').textContent, 'Renamed');
});

test('arrow keys move between tabs with a roving tabindex', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2), entry(3)] });
  await h.controller.open({ sessionId: 's1' });
  assert.equal(h.panelEl.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Terminals');
  assert.deepEqual(h.tabs().map((n) => n.getAttribute('tabindex')), ['0', '-1', '-1']);
  h.tab(1).dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await h.flush();
  assert.equal(h.tab(2).getAttribute('aria-selected'), 'true');
  assert.deepEqual(h.tabs().map((n) => n.getAttribute('tabindex')), ['-1', '0', '-1']);
  h.tab(2).dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await h.flush();
  assert.equal(h.tab(3).getAttribute('aria-selected'), 'true');
});

test('a new task terminal that appears while the panel is open is selected', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  await h.controller.open({ sessionId: 's1' });
  h.pool.entries.push(entry(2, { task: true, label: 'Terminal 2' }));
  h.pool.emit({ type: 'changed' });
  await h.flush();
  assert.equal(h.tabs().length, 2);
  assert.equal(h.tab(2).getAttribute('aria-selected'), 'true');
  assert.equal(names(h.pool, 'host').at(-1)[1], 2);
});

test('opening with a slot selects that terminal', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2, { task: true })] });
  await h.controller.open({ sessionId: 's1', slot: 2 });
  assert.equal(h.tab(2).getAttribute('aria-selected'), 'true');
  assert.equal(names(h.pool, 'host').at(-1)[1], 2);
});

test('when the project changes every terminal ends: the ended state, Start again, and the terminal is released', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2)] });
  await h.controller.open({ sessionId: 's1' });
  h.pool.entries = h.pool.entries.map((e) => ({ ...e, running: false, cwd: '' }));
  h.pool.emit({ type: 'root_reset' });
  await h.flush();
  h.pool.emit({ type: 'changed' }); // a change event after the reset keeps the ended state
  assert.match(h.text(), /Ended: the project changed\./);
  assert.equal(h.tabs().length, 2, 'the tab strip stays with stopped tabs');
  assert.ok(names(h.pool, 'release').length >= 1);
  assert.equal(h.pool.hosted, 0);
  assert.equal(h.mount(), null, 'nothing is hosted in the ended state');
  const again = h.panelEl.querySelector('[data-ct-start-again]');
  assert.match(again.textContent, /Start again/);
  again.click();
  await h.flush();
  assert.equal(names(h.pool, 'start').length + names(h.pool, 'create').length, 1);
  assert.doesNotMatch(h.text(), /Ended: the project changed\./);
});

test('closing the panel and disposing release the hosted terminal and drop the subscription', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  await h.controller.open({ sessionId: 's1' });
  assert.equal(h.pool.hosted, 1);
  assert.equal(h.controller.close(), true);
  assert.equal(h.pool.hosted, 0);
  assert.equal(names(h.pool, 'release').length, 1);
  assert.equal(h.closed.length, 1);
  await h.controller.open({ sessionId: 's1' });
  assert.equal(h.pool.hosted, 1);
  h.controller.dispose();
  assert.equal(h.pool.hosted, 0);
  assert.equal(h.pool.listenerCount(), 0);
});

test('leaving the terminal mode releases the hosted terminal', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  await h.controller.open({ sessionId: 's1' });
  assert.equal(h.pool.hosted, 1);
  h.state.ui.artifactReview.mode = 'background_tasks';
  h.panelEl.dataset.artifactReviewMode = 'background_tasks';
  await h.flush();
  assert.equal(h.pool.hosted, 0);
});

test('Maximize drives the panel maximize state and Show in Workspace hands the terminal over and closes the panel', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2)] });
  await h.controller.open({ sessionId: 's1' });
  const max = h.head().querySelector('[data-ct-max]');
  assert.equal(max.getAttribute('aria-pressed'), 'false');
  max.click();
  await h.flush();
  assert.equal(h.head().querySelector('[data-ct-max]').getAttribute('aria-pressed'), 'true');
  h.frames.splice(0).forEach((cb) => cb());
  assert.ok(names(h.pool, 'refit').length >= 1, 'a maximize re-fits the terminal');
  h.tab(2).click();
  await h.flush();
  h.head().querySelector('[data-ct-workspace]').click();
  await h.flush();
  assert.deepEqual(names(h.pool, 'showInWorkspace'), [['showInWorkspace', 2]]);
  assert.equal(h.closed.length, 1);
});

test('the menu offers new shells, rename, clear, copy folder path and kill', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2)] });
  await h.controller.open({ sessionId: 's1' });
  h.tab(2).click();
  await h.flush();
  h.head().querySelector('[data-ct-more]').click();
  await h.flush();
  const items = () => [...h.doc.querySelectorAll('.inv-context-menu-item')];
  const labels = items().map((n) => n.textContent);
  assert.ok(labels.some((l) => l.includes('New PowerShell')) && labels.some((l) => l.includes('New Command Prompt')));
  for (const word of ['Rename', 'Clear', 'Copy folder path', 'Kill terminal']) assert.ok(labels.some((l) => l.includes(word)), word);
  items().find((n) => n.textContent.includes('Clear')).click();
  assert.deepEqual(names(h.pool, 'clear'), [['clear', 2]]);
  h.head().querySelector('[data-ct-more]').click();
  await h.flush();
  items().find((n) => n.textContent.includes('Copy folder path')).click();
  await h.flush();
  assert.deepEqual(h.clips, [ROOT]);
  h.head().querySelector('[data-ct-more]').click();
  await h.flush();
  items().find((n) => n.textContent.includes('New Command Prompt')).click();
  await h.flush();
  assert.deepEqual(names(h.pool, 'create').at(-1), ['create', { profileId: 'cmd' }]);
  h.head().querySelector('[data-ct-more]').click();
  await h.flush();
  items().find((n) => n.textContent.includes('Kill terminal')).click();
  await h.flush();
  assert.deepEqual(names(h.pool, 'close')[0], ['close', 3], 'Kill acts on the selected terminal, the one just created');
});

test('Rename edits the label in place: Enter commits, an emptied field restores the default', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  await h.controller.open({ sessionId: 's1' });
  h.head().querySelector('[data-ct-more]').click();
  await h.flush();
  [...h.doc.querySelectorAll('.inv-context-menu-item')].find((n) => n.textContent.includes('Rename')).click();
  const input = h.panelEl.querySelector('input.inv-inline-title-editor');
  assert.ok(input, 'an inline name field over the tab');
  input.value = 'API';
  input.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(names(h.pool, 'rename'), [['rename', 1, 'API']]);
  h.head().querySelector('[data-ct-more]').click();
  await h.flush();
  [...h.doc.querySelectorAll('.inv-context-menu-item')].find((n) => n.textContent.includes('Rename')).click();
  const again = h.panelEl.querySelector('input.inv-inline-title-editor');
  again.value = '';
  again.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(names(h.pool, 'rename').at(-1), ['rename', 1, '']);
});

test('Add to message puts the selection in the composer as a fenced block naming the tab, and never sends', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1), entry(2, { label: 'Build' })] });
  await h.controller.open({ sessionId: 's1' });
  h.tab(2).click();
  await h.flush();
  assert.equal(h.panelEl.querySelector('[data-ct-attach]'), null, 'no pill without a selection');
  h.pool.selection = '  modified:   src/a.css\n  modified:   src/b.css\n';
  h.mount().dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true }));
  const pill = h.panelEl.querySelector('[data-ct-attach]');
  assert.match(pill.textContent, /Add to message/);
  pill.click();
  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0].text, 'Build:\n```text\n  modified:   src/a.css\n  modified:   src/b.css\n```\n');
  assert.equal(h.panelEl.querySelector('[data-ct-attach]'), null, 'the pill hides after inserting');
  h.pool.selection = 'x';
  h.mount().dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true }));
  assert.ok(h.panelEl.querySelector('[data-ct-attach]'));
  h.pool.selection = '';
  h.mount().dispatchEvent(new h.win.KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  assert.equal(h.panelEl.querySelector('[data-ct-attach]'), null, 'the pill hides when the selection clears');
  h.pool.selection = 'again';
  h.mount().dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true }));
  h.tab(1).click();
  await h.flush();
  assert.equal(h.panelEl.querySelector('[data-ct-attach]'), null, 'the pill hides when the tab changes');
});

test('Add to message caps a long selection and keeps the fence intact', () => {
  const long = 'x'.repeat(20000);
  const text = render.messageText('Terminal 1', long);
  assert.ok(text.startsWith('Terminal 1:\n```text\n'));
  assert.ok(text.endsWith('\n…\n```\n'));
  assert.ok(text.length < 8200);
  assert.equal(text.replace('```text', '').split('x').length - 1, render.MAX_SELECTION_CHARS);
  const fenced = render.messageText('T', 'a ``` b');
  assert.ok(fenced.startsWith('T:\n````text\n') && fenced.endsWith('\n````\n'), 'a longer fence than any run inside');
});

test('the title markup escapes terminal names', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1, { label: '<img src=x onerror=alert(1)>' })] });
  await h.controller.open({ sessionId: 's1' });
  assert.equal(h.head().querySelector('img'), null);
  assert.equal(h.tab(1).querySelector('[data-ct-label]').textContent, '<img src=x onerror=alert(1)>');
});

test('Escape typed in the terminal stays with the shell instead of reaching the panel', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  await h.controller.open({ sessionId: 's1' });
  let reached = 0;
  h.panelEl.addEventListener('keydown', () => { reached += 1; });
  const xterm = h.doc.createElement('div');
  xterm.className = 'xterm';
  h.mount().appendChild(xterm);
  xterm.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(reached, 0);
  xterm.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  assert.equal(reached, 1, 'other keys are not swallowed');
});

test('Ctrl+backquote toggles the panel; the chat chords stand down for keys typed inside the terminal', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  const api = { toggled: 0, available: true, toggle() { api.toggled += 1; return Promise.resolve(true); }, isAvailable: () => api.available };
  const saved = globalThis.rendererChatTerminalPanel;
  globalThis.rendererChatTerminalPanel = api;
  t.after(() => { globalThis.rendererChatTerminalPanel = saved; });
  h.doc.documentElement.dataset.activeView = 'chat';
  const calls = { newChat: 0, togglePanel: 0 };
  const controller = shortcuts.createGlobalShortcutsController({
    windowRef: h.win, documentRef: h.doc, callbacks: { newChat: () => { calls.newChat += 1; }, togglePanel: () => { calls.togglePanel += 1; } },
  });
  controller.bind();
  t.after(() => controller.dispose());
  const xterm = h.doc.createElement('textarea');
  xterm.className = 'xterm-helper-textarea';
  const wrap = h.doc.createElement('div');
  wrap.className = 'chat-terminal-panel';
  const screen = h.doc.createElement('div');
  screen.className = 'xterm';
  screen.appendChild(xterm);
  wrap.appendChild(screen);
  h.doc.body.appendChild(wrap);
  const press = (target, init) => {
    target.focus();
    const event = new h.win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const composer = h.doc.getElementById('composer');
  assert.equal(press(composer, { key: '`', code: 'Backquote' }).defaultPrevented, true);
  assert.equal(api.toggled, 1, 'from the composer');
  assert.equal(press(xterm, { key: '`', code: 'Backquote' }).defaultPrevented, true);
  assert.equal(api.toggled, 2, 'from inside the terminal itself');
  press(xterm, { key: 'n', code: 'KeyN' });
  press(xterm, { key: 'b', code: 'KeyB' });
  assert.deepEqual(calls, { newChat: 0, togglePanel: 0 }, 'Ctrl+N and Ctrl+B belong to the shell inside the terminal');
  h.doc.documentElement.dataset.activeView = 'ide';
  press(composer, { key: '`', code: 'Backquote' });
  assert.equal(api.toggled, 2, 'not while the Workspace is the active view');
  h.doc.documentElement.dataset.activeView = 'chat';
  api.available = false;
  assert.equal(press(composer, { key: '`', code: 'Backquote' }).defaultPrevented, false, 'a disabled feature keeps the key');
  api.available = true;
  const other = h.doc.createElement('input');
  other.type = 'text';
  h.doc.body.appendChild(other);
  assert.equal(press(other, { key: '`', code: 'Backquote' }).defaultPrevented, false, 'another text field keeps the key');
  assert.equal(api.toggled, 2);
});

test('review: a chat the panel cannot find is never treated as having no project (fail closed)', async (t) => {
  const h = await mountPanel(t, { entries: [entry(1)] });
  h.state.sessions = []; // the panel's chat (s1) is not in the loaded list
  await h.controller.open({ sessionId: 's1' });
  await h.flush();
  assert.match(h.text(), /isn't open in the Workspace/);
  assert.equal(names(h.pool, 'host').length + names(h.pool, 'create').length + names(h.pool, 'start').length, 0);
});
