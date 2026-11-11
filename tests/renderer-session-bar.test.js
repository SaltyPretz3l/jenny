'use strict';

/* Row 115 slice 1: the session bar. The title controller (renderer/chat/renderer-session-bar.js) in
   jsdom, its wiring and script tag, and the stylesheet contract (styles/chat-session-bar.css) read
   from the real files. The geometry (never changes orientation, the Session button does not move,
   split kicker row) is gated in headless Chromium by tests/renderer-session-rail-layout.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { mountSessionBar, syncAll } = require('../renderer/chat/renderer-session-bar.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const stringUtils = require('../renderer/shared/string-utils.js');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function fixture({ paneClass = 'chat-pane', paneAttrs = '' } = {}) {
  const dom = new JSDOM(`<div class="chat-view" id="view"><div class="${paneClass}" ${paneAttrs} id="pane"><div class="chat-thread-stage"><div id="timeline"></div></div><div class="chat-timeline-utility-cluster" id="cluster"><button id="first">x</button></div></div><div id="artifactReviewPanel" class="hidden"></div></div>`);
  const { document } = dom.window;
  dom.window.inventoryActionButton = inventoryActionButton;
  dom.window.stringUtils = stringUtils;
  let hidden = false; // jsdom reports hidden=true by default; the tests drive visibility themselves
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const sessions = { sess_a: 'First chat', sess_b: 'Second chat', sess_none: '' };
  const state = { id: 'sess_a' };
  return {
    dom, document, sessions, state,
    pane: document.getElementById('pane'), cluster: document.getElementById('cluster'), timeline: document.getElementById('timeline'),
    options(extra = {}) {
      return {
        pane: document.getElementById('pane'), cluster: document.getElementById('cluster'), chatTimeline: document.getElementById('timeline'),
        getSessionId: () => state.id, getTitle: (id) => sessions[id], windowRef: dom.window, ...extra,
      };
    },
    titleNode: () => document.querySelector('[data-session-bar-title]'),
    diffNode: () => document.querySelector('[data-session-bar-diff]'),
    setHidden(value) {
      hidden = value;
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
  };
}

/* ── Diff control: fakes carry the real envelopes (services/chat-workspace-service.js listChanges). ── */
const changesData = (extra = {}) => ({
  workspace_id: 'root_1', scope: 'working_tree', ref: 'main', head: 'a551fe671', branch: 'main', files: [],
  file_count: 3, additions: 12, deletions: 4, truncated: false, ...extra,
});
const envelope = (state, data = null, reason = null) => ({ schema_version: 1, ok: true, state, reason, sampled_at: '2026-11-09T10:00:00.000Z', data });
const available = (extra) => envelope('available', changesData(extra));
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBridge(handler) {
  const calls = [];
  const listeners = new Set();
  return {
    calls, listeners,
    listChanges: async (request) => { calls.push(request); return handler(request, calls.length); },
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (event) => listeners.forEach((listener) => listener(event)),
  };
}
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
// The visible words, leaf by leaf (the gaps between them are CSS, not text).
const diffText = (f) => [...f.diffNode().querySelectorAll('span')].filter((el) => !el.querySelector('span')).map((el) => el.textContent).join(' ');
const mountDiff = async (f, handler, extra = {}) => {
  const bridge = fakeBridge(handler);
  const api = mountSessionBar(f.options({ bridge, ...extra }));
  await flush();
  return { api, bridge };
};

test('mounts one title node at the start of the cluster with the session title, text only', () => {
  const f = fixture();
  f.sessions.sess_a = '<img src=x onerror=alert(1)> chat';
  const api = mountSessionBar(f.options());
  const node = f.titleNode();
  assert.ok(node && node.classList.contains('session-bar-title'));
  assert.equal(f.cluster.firstChild, node, 'the title is a child of the cluster');
  assert.equal(f.cluster.querySelector('img'), null, 'the title is never parsed as markup');
  assert.equal(node.textContent, '<img src=x onerror=alert(1)> chat');
  assert.equal(node.getAttribute('title'), node.textContent, 'the title attribute carries the full string');
  api.dispose();
});

test('an untitled session shows "New session" and the passed jt wins over the English fallback', () => {
  const f = fixture();
  f.state.id = 'sess_none';
  const api = mountSessionBar(f.options());
  assert.equal(f.titleNode().textContent, 'New session');
  api.dispose();
  const g = fixture();
  g.state.id = 'sess_none';
  const api2 = mountSessionBar(g.options({ jt: (key, fallback) => `[${key}] ${fallback}` }));
  assert.equal(g.titleNode().textContent, '[chat.empty.newSession] New session');
  api2.dispose();
});

test('re-syncs on the focused chat event and the timeline render event, and on an explicit sync', () => {
  const f = fixture();
  const api = mountSessionBar(f.options());
  assert.equal(f.titleNode().textContent, 'First chat');
  f.state.id = 'sess_b';
  f.dom.window.dispatchEvent(new f.dom.window.CustomEvent('jenny:focused-chat-changed'));
  assert.equal(f.titleNode().textContent, 'Second chat', 'jenny:focused-chat-changed');
  f.sessions.sess_b = 'Renamed';
  f.timeline.dispatchEvent(new f.dom.window.CustomEvent('transcript-view-rendered'));
  assert.equal(f.titleNode().textContent, 'Renamed', 'transcript-view-rendered');
  f.sessions.sess_b = 'Renamed again';
  assert.equal(f.titleNode().textContent, 'Renamed', 'a rename alone raises no event');
  api.sync();
  assert.equal(f.titleNode().textContent, 'Renamed again', 'sync() reads the title again');
  api.dispose();
});

test('writes the node only when the title changed', () => {
  const f = fixture();
  const api = mountSessionBar(f.options());
  const node = f.titleNode();
  const first = node.firstChild;
  api.sync();
  api.sync();
  assert.equal(node.firstChild, first, 'the same text node: nothing was rewritten');
  api.dispose();
});

test('dispose removes the node and every listener; later events do nothing', () => {
  const f = fixture();
  let reads = 0;
  const api = mountSessionBar(f.options({ getTitle: (id) => { reads += 1; return f.sessions[id]; } }));
  const afterMount = reads;
  api.dispose();
  assert.equal(f.titleNode(), null);
  f.state.id = 'sess_b';
  f.dom.window.dispatchEvent(new f.dom.window.CustomEvent('jenny:focused-chat-changed'));
  f.timeline.dispatchEvent(new f.dom.window.CustomEvent('transcript-view-rendered'));
  api.sync();
  assert.equal(reads, afterMount, 'no listener or sync reads the title after dispose');
  assert.doesNotThrow(() => api.dispose(), 'dispose is idempotent');
});

test('honors an AbortSignal like the session rail: abort disposes, an aborted signal mounts nothing', () => {
  const f = fixture();
  const controller = new f.dom.window.AbortController();
  const api = mountSessionBar(f.options({ signal: controller.signal }));
  assert.ok(f.titleNode());
  controller.abort();
  assert.equal(f.titleNode(), null, 'abort removes the node');
  f.state.id = 'sess_b';
  f.dom.window.dispatchEvent(new f.dom.window.CustomEvent('jenny:focused-chat-changed'));
  assert.equal(f.titleNode(), null, 'abort released the listeners');
  assert.doesNotThrow(() => api.dispose());
  const g = fixture();
  const aborted = new g.dom.window.AbortController();
  aborted.abort();
  assert.equal(mountSessionBar(g.options({ signal: aborted.signal })), null);
  assert.equal(g.titleNode(), null);
});

test('a remount replaces the previous title node instead of stacking', () => {
  const f = fixture();
  mountSessionBar(f.options());
  const api = mountSessionBar(f.options());
  assert.equal(f.document.querySelectorAll('[data-session-bar-title]').length, 1);
  api.dispose();
});

test('mounts nothing for a pane hosted in the IDE dock or without the required options', () => {
  const dock = fixture({ paneClass: 'chat-pane ide-chat-dock-body' });
  assert.equal(mountSessionBar(dock.options()), null);
  assert.equal(dock.titleNode(), null);
  const hosted = fixture({ paneAttrs: 'data-pane-hosted="true"' });
  assert.equal(mountSessionBar(hosted.options()), null);
  assert.equal(hosted.titleNode(), null);
  const f = fixture();
  assert.equal(mountSessionBar(f.options({ getTitle: null })), null);
  assert.equal(mountSessionBar(f.options({ cluster: null })), null);
  assert.equal(mountSessionBar(), null);
});

test('the bindings mount it beside the rail with the session title from state; index.html loads it before the rail', () => {
  const bindings = read('renderer/chat/renderer-chat-event-transcript-bindings.js');
  const bar = bindings.indexOf('rendererSessionBar?.mountSessionBar?.(');
  const rail = bindings.indexOf('rendererSessionRail?.mountSessionRail?.(');
  assert.ok(bar > 0 && bar < rail, 'the bar mounts just before the rail');
  assert.match(bindings.slice(bar, rail), /getTitle:\s*\(id\)\s*=>\s*state\.sessions\?\.find\?\.\(\(entry\) => entry\.id === id\)\?\.title/);
  assert.match(bindings.slice(bar, rail), /signal:\s*bindAbortController\?\.signal/);
  const html = read('index.html');
  const barTag = html.indexOf('<script defer src="renderer/chat/renderer-session-bar.js"></script>');
  const railTag = html.indexOf('<script defer src="renderer/chat/renderer-session-rail.js"></script>');
  assert.ok(barTag > 0 && barTag < railTag, 'the script tag sits before the rail controller');
  assert.equal(html.split('renderer-session-bar.js').length - 1, 1);
});

/* ── The diff control ── */
test('a repo with changes renders the branch and +N −M from listChanges, in the cluster', async () => {
  const f = fixture();
  const { api, bridge } = await mountDiff(f, () => available());
  assert.deepEqual(bridge.calls, [{ schema_version: 1, session_id: 'sess_a' }]);
  const node = f.diffNode();
  assert.ok(node && node.parentElement === f.cluster && node.classList.contains('session-bar-diff'));
  assert.equal(node.hidden, false);
  assert.equal(node.getAttribute('aria-pressed'), 'false');
  assert.equal(diffText(f), 'main +12 −4');
  assert.equal(node.querySelector('.session-bar-diff-branch').textContent, 'main');
  assert.equal(node.querySelector('.session-rail-count--add').textContent, '+12');
  assert.equal(node.querySelector('.session-rail-count--del').textContent, '−4', 'the minus sign is U+2212');
  assert.equal(node.querySelector('.session-bar-diff-branch').getAttribute('dir'), 'auto');
  api.dispose();
});

test('tooltip and aria-label are plural-aware; nothing uncommitted shows the name only', async () => {
  const f = fixture();
  let reply = available({ file_count: 3 });
  const { api, bridge } = await mountDiff(f, () => reply);
  assert.equal(f.diffNode().getAttribute('title'), 'Uncommitted on main: 3 files, +12 −4');
  assert.equal(f.diffNode().getAttribute('aria-label'), 'Uncommitted on main: 3 files, +12 −4');
  reply = available({ file_count: 1, additions: 2, deletions: 0 });
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(f.diffNode().getAttribute('title'), 'Uncommitted on main: 1 file, +2 −0');
  reply = available({ file_count: 0, additions: 0, deletions: 0 });
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(diffText(f), 'main', 'glyph and name only');
  assert.equal(f.diffNode().querySelector('.session-rail-count--add'), null);
  assert.equal(f.diffNode().getAttribute('title'), 'Nothing uncommitted on main');
  assert.ok(f.diffNode().querySelector('svg'), 'the branch glyph stays');
  api.dispose();
});

test('unknown counts show the file count only; detached HEAD shows the short commit', async () => {
  const f = fixture();
  let reply = available({ additions: null, deletions: null, file_count: 5 });
  const { api, bridge } = await mountDiff(f, () => reply);
  assert.equal(diffText(f), 'main 5 files');
  assert.equal(f.diffNode().getAttribute('title'), 'Uncommitted on main: 5 files');
  reply = available({ additions: null, deletions: null, file_count: 1 });
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(diffText(f), 'main 1 file');
  reply = available({ branch: null, ref: 'a551fe671', additions: 1, deletions: 2, file_count: 1 });
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(diffText(f), 'a551fe671 +1 −2');
  assert.equal(f.diffNode().getAttribute('title'), 'Uncommitted on a551fe671: 1 file, +1 −2');
  api.dispose();
});

test('hidden when the chat has no folder or is not a Git repo; no placeholder before the first answer', async () => {
  for (const reply of [envelope('unavailable', null, 'no_workspace'), envelope('not_applicable', null, 'not_a_git_repository'), envelope('unavailable', null, 'not_applicable')]) {
    const f = fixture();
    const gate = defer();
    const { api } = await mountDiff(f, () => gate.promise.then(() => reply));
    assert.equal(f.diffNode().hidden, true, 'hidden while the first read is pending');
    assert.equal(f.diffNode().textContent, '', 'no Checking text and no placeholder');
    gate.resolve();
    await flush();
    assert.equal(f.diffNode().hidden, true, `hidden for ${reply.state}/${reply.reason}`);
    api.dispose();
  }
  const f = fixture();
  let reply = available();
  const { api, bridge } = await mountDiff(f, () => reply);
  assert.equal(f.diffNode().hidden, false);
  reply = envelope('not_applicable', null, 'not_a_git_repository');
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(f.diffNode().hidden, true, 'a folder that stopped being a repo removes the control');
  api.dispose();
});

test('stale keeps showing; checking and transient failures keep the last good data', async () => {
  const f = fixture();
  let reply = available();
  const { api, bridge } = await mountDiff(f, () => (typeof reply === 'function' ? reply() : reply));
  const refresh = async (next) => { reply = next; bridge.emit({ session_id: 'sess_a' }); await sleep(160); await flush(); };
  await refresh(envelope('stale', changesData({ additions: 20, deletions: 1 }), 'git_failed'));
  assert.equal(diffText(f), 'main +20 −1', 'stale data is shown');
  await refresh(envelope('checking'));
  assert.equal(diffText(f), 'main +20 −1', 'checking keeps the last good data');
  await refresh(envelope('unavailable', null, 'git_failed'));
  assert.equal(diffText(f), 'main +20 −1', 'a transient failure keeps it');
  await refresh(() => { throw new Error('ipc down'); });
  assert.equal(diffText(f), 'main +20 −1', 'a rejected read keeps it');
  await refresh({ schema_version: 1, ok: false, reason: 'unknown_session' });
  assert.equal(f.diffNode().hidden, false);
  assert.equal(diffText(f), 'main +20 −1');
  api.dispose();
});

test('a session switch clears first; an answer for the previous session is never painted', async () => {
  const f = fixture();
  const gates = { sess_a: defer(), sess_b: defer() };
  const { api, bridge } = await mountDiff(f, (request) => gates[request.session_id].promise);
  gates.sess_a.resolve(available({ branch: 'alpha', additions: 1, deletions: 1 }));
  await flush();
  assert.equal(diffText(f), 'alpha +1 −1');
  // Switch while the next read for sess_a is in flight: the late answer must be dropped.
  const late = defer();
  gates.sess_a = late;
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(bridge.calls.length, 2, 'sess_a is read again');
  f.state.id = 'sess_b';
  api.sync();
  assert.equal(f.diffNode().hidden, true, 'cleared at once; nothing of the previous chat remains');
  late.resolve(available({ branch: 'stale-alpha', additions: 9, deletions: 9 }));
  await flush();
  assert.equal(f.diffNode().hidden, true, 'the previous session answer is dropped');
  assert.equal(bridge.calls.length, 3, 'the new session is read once the in-flight read lands');
  assert.equal(bridge.calls[2].session_id, 'sess_b');
  gates.sess_b.resolve(available({ branch: 'beta', additions: 3, deletions: 0 }));
  await flush();
  assert.equal(diffText(f), 'beta +3 −0');
  api.dispose();
});

test('onChanged is debounced 120ms, one request in flight with one queued rerun, other sessions ignored', async () => {
  const f = fixture();
  const gates = [];
  const { api, bridge } = await mountDiff(f, () => { const gate = defer(); gates.push(gate); return gate.promise; });
  assert.equal(bridge.calls.length, 1, 'the mount read');
  gates[0].resolve(available());
  await flush();
  bridge.emit({ session_id: 'sess_other' });
  await sleep(160);
  assert.equal(bridge.calls.length, 1, 'an event for another session does nothing');
  for (let i = 0; i < 5; i += 1) bridge.emit({ session_id: 'sess_a' });
  await sleep(40);
  assert.equal(bridge.calls.length, 1, 'inside the debounce window nothing is read');
  await sleep(120);
  assert.equal(bridge.calls.length, 2, 'a burst becomes one read');
  // While that read is in flight, two more bursts queue exactly one rerun.
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160);
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160);
  assert.equal(bridge.calls.length, 2, 'one request in flight');
  gates[1].resolve(available({ additions: 5 }));
  await flush();
  assert.equal(bridge.calls.length, 3, 'one queued rerun');
  gates[2].resolve(available({ additions: 6 }));
  await flush();
  assert.equal(bridge.calls.length, 3);
  assert.equal(diffText(f), 'main +6 −4');
  api.dispose();
});

test('reads pause while the document is hidden and refresh once on return; no timer polling', async () => {
  const f = fixture();
  const { api, bridge } = await mountDiff(f, () => available());
  f.setHidden(true);
  bridge.emit({ session_id: 'sess_a' });
  bridge.emit({ session_id: 'sess_a' });
  await sleep(160); await flush();
  assert.equal(bridge.calls.length, 1, 'no read while hidden');
  f.state.id = 'sess_b';
  api.sync();
  await flush();
  assert.equal(bridge.calls.length, 1, 'a session change while hidden waits too');
  f.setHidden(false);
  await flush();
  assert.equal(bridge.calls.length, 2, 'one refresh on return');
  assert.equal(bridge.calls[1].session_id, 'sess_b');
  f.setHidden(false);
  await flush();
  assert.equal(bridge.calls.length, 2, 'nothing owed, nothing read');
  await sleep(200);
  assert.equal(bridge.calls.length, 2, 'no polling timer');
  api.dispose();
  const g = fixture();
  g.setHidden(true);
  const b2 = fakeBridge(() => available());
  const api2 = mountSessionBar(g.options({ bridge: b2 }));
  await flush();
  assert.equal(b2.calls.length, 0, 'mounted hidden: nothing read yet');
  g.setHidden(false);
  await flush();
  assert.equal(b2.calls.length, 1);
  api2.dispose();
});

test('a hostile branch name is text, never markup', async () => {
  const f = fixture();
  const hostile = '"><img src=x onerror=alert(1)><b>x</b>';
  const { api } = await mountDiff(f, () => available({ branch: hostile, ref: hostile }));
  assert.equal(f.cluster.querySelector('img'), null);
  assert.equal(f.diffNode().querySelector('b'), null);
  assert.equal(f.diffNode().querySelector('.session-bar-diff-branch').textContent, hostile);
  assert.ok(f.diffNode().getAttribute('title').includes(hostile), 'the title attribute carries it as a string');
  assert.ok(![...f.diffNode().querySelectorAll('*'), f.diffNode()].some((el) => [...el.attributes].some((a) => a.name.startsWith('on'))), 'no injected event attribute');
  api.dispose();
});

test('no read at all for a pane hosted in the IDE dock or elsewhere', async () => {
  for (const f of [fixture({ paneClass: 'chat-pane ide-chat-dock-body' }), fixture({ paneAttrs: 'data-pane-hosted="true"' })]) {
    const bridge = fakeBridge(() => available());
    assert.equal(mountSessionBar(f.options({ bridge })), null);
    await flush();
    assert.equal(bridge.calls.length, 0);
    assert.equal(bridge.listeners.size, 0, 'and no subscription');
    assert.equal(f.diffNode(), null);
  }
});

test('mounts no diff control without the bridge (title still works), and an empty session reads nothing', async () => {
  const f = fixture();
  const api = mountSessionBar(f.options());
  assert.equal(f.diffNode(), null);
  assert.equal(f.titleNode().textContent, 'First chat');
  api.dispose();
  const g = fixture();
  g.state.id = '';
  const { api: api2, bridge } = await mountDiff(g, () => available());
  assert.equal(bridge.calls.length, 0);
  assert.equal(g.diffNode().hidden, true);
  api2.dispose();
});

test('click opens Changes for this session with the button as opener; pressed flips in the click frame', async () => {
  const f = fixture();
  const view = f.document.getElementById('view');
  const opened = [];
  const closed = [];
  let current = null;
  const detail = {
    open: (request) => { opened.push(request); current = { surface: request.surface, ownerSessionId: request.ownerSessionId }; view.classList.add('code-review-open'); return true; },
    close: () => { closed.push(true); current = null; view.classList.remove('code-review-open'); return true; },
    getCurrent: () => current,
  };
  const { api } = await mountDiff(f, () => available(), { detail });
  const button = f.diffNode();
  button.click();
  assert.equal(opened.length, 1);
  assert.deepEqual({ ...opened[0], opener: undefined }, { surface: 'changes', ownerSessionId: 'sess_a', opener: undefined });
  assert.equal(opened[0].opener, button);
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'flipped synchronously, before any observer microtask');
  await flush();
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'the observer agrees');
  button.click();
  assert.equal(closed.length, 1, 'a click while Changes is open closes it');
  assert.equal(opened.length, 1);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  api.dispose();
});

test('pressed follows the Changes page: opened elsewhere, replaced by another panel, owned by another chat', async () => {
  const f = fixture();
  const view = f.document.getElementById('view');
  let current = null;
  const detail = { open: () => true, close: () => true, getCurrent: () => current };
  const { api } = await mountDiff(f, () => available(), { detail });
  const pressed = () => f.diffNode().getAttribute('aria-pressed');
  current = { surface: 'changes', ownerSessionId: 'sess_a' };
  view.classList.add('code-review-open');
  await flush();
  assert.equal(pressed(), 'true', 'a rail row opened it');
  current = { surface: 'changes', ownerSessionId: 'sess_other' };
  view.classList.add('x'); // any class change re-reads the state
  await flush();
  assert.equal(pressed(), 'false', 'the split pane of another chat owns the page');
  current = { surface: 'changes', ownerSessionId: 'sess_a' };
  view.classList.remove('code-review-open');
  await flush();
  assert.equal(pressed(), 'false', 'the panel closed');
  api.dispose();
});

test('a click that cannot open Changes leaves the button unpressed', async () => {
  const f = fixture();
  const { api } = await mountDiff(f, () => available(), { detail: { open: () => false, close: () => true, getCurrent: () => null } });
  f.diffNode().click();
  assert.equal(f.diffNode().getAttribute('aria-pressed'), 'false');
  api.dispose();
});

test('dispose removes the node, the subscription, the observer and the pending timer; abort does the same', async () => {
  const f = fixture();
  const { api, bridge } = await mountDiff(f, () => available());
  assert.equal(bridge.listeners.size, 1);
  bridge.emit({ session_id: 'sess_a' }); // a debounce timer is pending
  api.dispose();
  assert.equal(f.diffNode(), null);
  assert.equal(bridge.listeners.size, 0, 'unsubscribed');
  await sleep(160); await flush();
  assert.equal(bridge.calls.length, 1, 'the pending timer was cleared');
  f.setHidden(true); f.setHidden(false);
  f.state.id = 'sess_b';
  f.dom.window.dispatchEvent(new f.dom.window.CustomEvent('jenny:focused-chat-changed'));
  api.sync();
  await flush();
  assert.equal(bridge.calls.length, 1, 'no event reads after dispose');
  const g = fixture();
  const controller = new g.dom.window.AbortController();
  const { bridge: b2 } = await mountDiff(g, () => available(), { signal: controller.signal });
  controller.abort();
  assert.equal(g.diffNode(), null);
  assert.equal(b2.listeners.size, 0);
});

test('a read in flight when the bar is disposed paints nothing', async () => {
  const f = fixture();
  const gate = defer();
  const { api } = await mountDiff(f, () => gate.promise);
  api.dispose();
  gate.resolve(available());
  await flush();
  assert.equal(f.diffNode(), null);
});

test('a remount replaces the diff control; syncAll still refreshes every bar', async () => {
  const f = fixture();
  const bridge = fakeBridge(() => available());
  mountSessionBar(f.options({ bridge }));
  const api = mountSessionBar(f.options({ bridge }));
  await flush();
  assert.equal(f.document.querySelectorAll('[data-session-bar-diff]').length, 1);
  f.sessions.sess_a = 'Renamed by syncAll';
  syncAll();
  assert.equal(f.titleNode().textContent, 'Renamed by syncAll');
  api.dispose();
});

/* ── The stylesheet ── */
