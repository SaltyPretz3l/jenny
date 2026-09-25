'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAwayDigestReader, createAwayDigestWidget } = require('../renderer/features/renderer-dashboard-widget-away-digest');
const actionButton = require('../renderer/inventory/action-button');

const SEEN_KEY = 'jenny.ui.awayDigest.seenAt';
const SESSION_SEEN_KEY = 'jenny.ui.awayDigest.seenBySession';
const MARKUP = '<section class="dashboard-card" data-widget-id="away-digest">'
  + '<div class="dashboard-card__body"></div></section>'
  + '<div id="workspace"><div id="conversationGroups"></div></div>';
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) await tick();
}

function work(overrides = {}) {
  return {
    work_id: 'w1', session_id: 's1', status: 'completed',
    created_at: new Date(Date.now() - 7200000).toISOString(),
    updated_at: new Date(Date.now() - 180000).toISOString(),
    ...overrides,
  };
}

function session(id, title) {
  return { id, title };
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)); writes.push([key, String(value)]); },
  };
}

function harness(options = {}) {
  const dom = new JSDOM(MARKUP, { url: 'https://jenny.local/' });
  const { window } = dom;
  let visibility = options.visibility || 'visible';
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
  const timers = { timeouts: [], intervals: 0 };
  window.setTimeout = (fn, delay) => {
    const handle = { fn, delay, cleared: false };
    timers.timeouts.push(handle);
    return handle;
  };
  window.clearTimeout = (handle) => { handle.cleared = true; };
  window.setInterval = () => { timers.intervals += 1; return 1; };
  const calls = { snapshot: [], work: [], usage: [] };
  const sourceRows = options.work || [];
  window.jennyShell = {
    sessionRuntime: {
      getSnapshot: (params) => {
        calls.snapshot.push(params);
        return Promise.resolve().then(() => options.getSnapshot
          ? options.getSnapshot(params, calls.snapshot.length)
          : { ok: true, work: sourceRows });
      },
      getWork: (params) => {
        calls.work.push(params);
        return Promise.resolve().then(() => options.getWork
          ? options.getWork(params)
          : { ok: true, work: { attempt: { stream_id: `stream-${params.work_id}` } } });
      },
    },
    usage: {
      getSnapshot: (params) => {
        calls.usage.push(params);
        return Promise.resolve().then(() => options.getUsage
          ? options.getUsage(params)
          : { recent_turns: options.usageRows || [] });
      },
    },
  };
  const state = options.state || {
    sessions: options.sessions || [],
    ui: { activeView: options.activeView || 'chat' },
    currentSessionId: options.currentSessionId || '',
  };
  const storage = options.storage || makeStorage();
  const logs = [];
  const errors = [];
  const openCalls = [];
  let changes = 0;
  let widget = null;
  const body = window.document.querySelector('.dashboard-card__body');
  const reader = createAwayDigestReader({
    windowRef: window,
    documentRef: window.document,
    state,
    storage,
    callbacks: {
      appendClientLog: (level, event, data) => logs.push([level, event, data]),
      onChanged: () => {
        changes += 1;
        if (options.autoRender !== false && widget) widget.render(body, {});
      },
    },
  });
  widget = createAwayDigestWidget({
    reader,
    actionButton,
    documentRef: window.document,
    setTimeoutImpl: window.setTimeout,
    clearTimeoutImpl: window.clearTimeout,
    callbacks: {
      openSession: (id) => {
        openCalls.push(id);
        if (options.openSession) return options.openSession(id);
        return undefined;
      },
      appendClientLog: (level, event, data) => logs.push([level, event, data]),
      showComposerActionError: (error, title) => errors.push([error, title]),
    },
  });
  return {
    dom, window, document: window.document, state, storage, calls, timers, logs, errors, openCalls,
    reader, widget, body,
    setVisibility: (value) => { visibility = value; },
    render: () => widget.render(body, {}),
    button: (action) => body.querySelector(`[data-digest-action="${action}"]`),
    rows: () => [...body.querySelectorAll('.away-digest__row')],
    row: (id) => body.querySelector(`[data-digest-key="work:${id}"]`),
    changes: () => changes,
    close: () => { reader.dispose(); window.close(); },
  };
}

test('refresh and render own no clock on the read path', async () => {
  const h = harness({ work: [work()], sessions: [session('s1', 'Chat one')] });
  await h.reader.refresh();
  h.render();
  assert.equal(h.timers.timeouts.length, 0);
  assert.equal(h.timers.intervals, 0);
  h.close();
});

test('one Chats-panel arrival reads one page and no token detail', async () => {
  const h = harness({ work: [work()], sessions: [session('s1', 'Chat one')] });
  h.reader.onChromePass();
  await flush();
  assert.deepEqual(h.calls.snapshot, [{ limit: 100, cursor: null }]);
  assert.deepEqual(h.calls.work, []);
  assert.deepEqual(h.calls.usage, []);
  h.close();
});

test('rows render title, right-side outcome metadata, and deleted sessions honestly', async () => {
  const now = Date.now();
  const h = harness({
    work: [
      work({ work_id: 'ok', session_id: 's1', updated_at: new Date(now - 60000).toISOString() }),
      work({ work_id: 'bad', session_id: 's2', status: 'failed', updated_at: new Date(now - 120000).toISOString() }),
      work({ work_id: 'stop', session_id: 's3', status: 'cancelled', updated_at: new Date(now - 180000).toISOString() }),
      work({ work_id: 'gone', session_id: 'gone', updated_at: new Date(now - 240000).toISOString() }),
    ],
    sessions: [session('s1', 'Completed chat'), session('s2', 'Failed chat'), session('s3', 'Cancelled chat')],
  });
  await h.reader.refresh();
  h.render();
  assert.equal(h.row('ok').querySelector('.away-digest__title').textContent, 'Completed chat');
  assert.equal(h.row('ok').querySelector('.away-digest__meta').textContent.includes('Finished'), false);
  assert.match(h.row('ok').querySelector('.away-digest__time').textContent, /ago|just now/);
  assert.equal(h.row('bad').querySelector('.away-digest__outcome--failed').textContent, 'Failed');
  assert.equal(h.row('stop').querySelector('.away-digest__outcome--cancelled').textContent, 'Cancelled');
  const gone = h.row('gone').querySelector('.away-digest__title--gone');
  assert.equal(gone.tagName, 'SPAN');
  assert.equal(gone.textContent, 'Chat deleted');
  assert.equal(h.row('gone').querySelector('button'), null);
  h.close();
});

test('an empty digest uses the Home empty-state and no Mark all seen control', async () => {
  const h = harness({ work: [] });
  await h.reader.refresh();
  h.render();
  assert.equal(h.body.querySelector('.dashboard-empty-note').textContent, 'Nothing finished since you last looked.');
  assert.equal(h.button('seen'), null);
  h.close();
});

test('Show all expands the page and Mark all seen writes its newest listed timestamp', async () => {
  const now = Date.now();
  const rows = Array.from({ length: 12 }, (_, index) => work({
    work_id: `w${index}`,
    updated_at: new Date(now - (index + 1) * 60000).toISOString(),
  }));
  const h = harness({ work: rows, sessions: [session('s1', 'Chat one')] });
  await h.reader.refresh();
  h.render();
  assert.equal(h.rows().length, 8);
  assert.equal(h.button('show-all').textContent, 'Show all 12');
  h.button('show-all').click();
  assert.equal(h.rows().length, 12);
  h.button('seen').click();
  await flush();
  assert.equal(h.storage.values.get(SEEN_KEY), rows[0].updated_at);
  assert.equal(h.rows().length, 0);
  assert.equal(h.calls.snapshot.length, 1, 'Mark all seen filters the page in hand; it never reads');
  h.close();
});

test('Open switches directly and its per-session cursor leaves other chats unseen', async () => {
  const now = Date.now();
  const h = harness({
    work: [
      work({ work_id: 'w1', session_id: 's1', updated_at: new Date(now - 60000).toISOString() }),
      work({ work_id: 'w2', session_id: 's2', updated_at: new Date(now - 120000).toISOString() }),
    ],
    sessions: [session('s1', 'One'), session('s2', 'Two')],
  });
  await h.reader.refresh();
  h.render();
  h.row('w1').querySelector('[data-digest-action="open"]').click();
  await flush();
  assert.deepEqual(h.openCalls, ['s1']);
  assert.equal(h.row('w1'), null);
  assert.ok(h.row('w2'));
  const cursor = JSON.parse(h.storage.values.get(SESSION_SEEN_KEY));
  assert.ok(Date.parse(cursor.s1) >= now - 60000, 'opening a chat marks it seen up to now');
  assert.equal('s2' in cursor, false);
  assert.equal('getResult' in h.window.jennyShell.sessionRuntime, false);
  h.close();
});

test('Mark all seen parks focus on the card body, never document.body', async () => {
  const h = harness({ work: [work()], sessions: [session('s1', 'One')] });
  await h.reader.refresh();
  h.render();
  const seen = h.button('seen');
  seen.focus();
  seen.click();
  await flush();
  assert.equal(h.document.activeElement, h.body);
  assert.equal(h.body.contains(h.document.activeElement), true);
  assert.notEqual(h.document.activeElement, h.document.body);
  h.close();
});

test('the render key preserves identical DOM and ignores loading-only changes', async () => {
  let resolveRead;
  let reads = 0;
  const h = harness({
    sessions: [session('s1', 'One')],
    getSnapshot: () => {
      reads += 1;
      if (reads === 1) return { ok: true, work: [work()] };
      return new Promise((resolve) => { resolveRead = resolve; });
    },
  });
  await h.reader.refresh();
  h.render();
  const title = h.body.querySelector('.away-digest__title');
  title.dataset.probe = 'survives';
  h.render();
  assert.equal(h.body.querySelector('.away-digest__title'), title);
  const pending = h.reader.refresh();
  assert.equal(h.body.querySelector('.away-digest__title'), title, 'loading does not repaint');
  assert.equal(title.dataset.probe, 'survives');
  await tick();
  resolveRead({ ok: true, work: [work()] });
  await pending;
  h.close();
});

test('the in-progress line counts running, pending, and paused only', async () => {
  const h = harness({ work: [
    work({ work_id: 'run', status: 'running' }),
    work({ work_id: 'pending', status: 'pending' }),
    work({ work_id: 'paused', status: 'paused' }),
    work({ work_id: 'attention', status: 'needs_attention' }),
  ] });
  await h.reader.refresh();
  h.render();
  assert.equal(h.body.querySelector('.away-digest__progress').textContent, '3 still in progress');
  h.close();
});

test('chrome passes read once on panel arrival and never read Home', async () => {
  const h = harness();
  const workspace = h.document.getElementById('workspace');
  workspace.classList.add('panel-collapsed');
  h.reader.onChromePass();
  await flush();
  assert.equal(h.calls.snapshot.length, 0);
  workspace.classList.remove('panel-collapsed');
  h.reader.onChromePass();
  await flush();
  assert.equal(h.calls.snapshot.length, 1);
  h.reader.onChromePass();
  h.reader.onChromePass();
  await flush();
  assert.equal(h.calls.snapshot.length, 1);
  h.state.ui.activeView = 'home';
  workspace.classList.add('panel-collapsed');
  h.reader.onChromePass();
  workspace.classList.remove('panel-collapsed');
  h.reader.onChromePass();
  await flush();
  assert.equal(h.calls.snapshot.length, 1);
  h.close();
});

test('a visible active chat is synchronized as watched during a read', async () => {
  const now = Date.now();
  const h = harness({
    currentSessionId: 's1',
    work: [
      work({ work_id: 'w1', session_id: 's1', updated_at: new Date(now - 60000).toISOString() }),
      work({ work_id: 'w2', session_id: 's2', updated_at: new Date(now - 120000).toISOString() }),
    ],
    sessions: [session('s1', 'One'), session('s2', 'Two')],
  });
  await h.reader.refresh();
  h.render();
  assert.equal(h.row('w1'), null);
  assert.ok(h.row('w2'));
  assert.ok(JSON.parse(h.storage.values.get(SESSION_SEEN_KEY)).s1);
  h.close();
});
