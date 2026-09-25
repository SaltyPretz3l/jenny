'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createAwayDigestReader, createAwayDigestWidget } = require('../renderer/features/renderer-dashboard-widget-away-digest');
const actionButton = require('../renderer/inventory/action-button');

const ROOT = path.resolve(__dirname, '..');
const MARKUP = '<section class="dashboard-card" data-widget-id="away-digest">'
  + '<div class="dashboard-card__body"></div></section>'
  + '<div id="workspace"><div id="conversationGroups"></div></div>';
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) await tick();
}

function work(id, sessionId, minutes = 2) {
  return {
    work_id: id,
    session_id: sessionId,
    status: 'completed',
    created_at: new Date(Date.now() - (minutes + 5) * 60000).toISOString(),
    updated_at: new Date(Date.now() - minutes * 60000).toISOString(),
  };
}

function harness(options = {}) {
  const dom = new JSDOM(MARKUP, { url: 'https://jenny.local/' });
  const { window } = dom;
  let visibility = options.visibility || 'visible';
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
  const rows = options.work || [work('w1', 's1', 2), work('w2', 's2', 3)];
  const calls = { snapshot: [], work: [], usage: [] };
  window.jennyShell = {
    sessionRuntime: {
      getSnapshot: (params) => {
        calls.snapshot.push(params);
        return Promise.resolve().then(() => options.getSnapshot
          ? options.getSnapshot(params, calls.snapshot.length)
          : { ok: true, work: rows });
      },
      getWork: (params) => {
        calls.work.push(params);
        return Promise.resolve().then(() => options.getWork
          ? options.getWork(params)
          : { ok: true, work: { attempt: { stream_id: `stream-${params.work_id}` } } });
      },
    },
  };
  if (!options.usageAbsent) {
    window.jennyShell.usage = {
      getSnapshot: (params) => {
        calls.usage.push(params);
        return Promise.resolve().then(() => options.getUsage
          ? options.getUsage(params, calls.usage.length)
          : { recent_turns: [
            { stream_id: 'stream-w1', input_tokens: 120, output_tokens: 34, cost_usd: 9 },
            { stream_id: 'stream-w2', input_tokens: 56, output_tokens: 78, cost_usd: 8 },
          ] });
      },
    };
  }
  const timers = [];
  const tooltipCalls = [];
  const logs = [];
  const state = {
    sessions: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }],
    ui: { activeView: options.activeView || 'chat' },
    currentSessionId: '',
  };
  const body = window.document.querySelector('.dashboard-card__body');
  let widget = null;
  const reader = createAwayDigestReader({
    windowRef: window,
    documentRef: window.document,
    state,
    storage: options.storage || { getItem: () => null, setItem: () => {} },
    callbacks: {
      appendClientLog: (level, event, data) => logs.push([level, event, data]),
      onChanged: () => { if (widget) widget.render(body, {}); },
    },
  });
  widget = createAwayDigestWidget({
    reader,
    actionButton,
    tooltip: { show: (el, text) => tooltipCalls.push([el, text]), hide: () => {} },
    setTimeoutImpl: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
    documentRef: window.document,
    callbacks: {},
  });
  return {
    window, calls, timers, tooltipCalls, logs, state, body, reader, widget,
    setVisibility: (value) => { visibility = value; },
    row: (id) => reader.getSnapshot().digest.rows.find((entry) => entry.workId === id),
    open: (id) => body.querySelector(`[data-digest-key="work:${id}"] [data-digest-action="open"]`),
    close: () => { reader.dispose(); window.close(); },
  };
}

async function hover(h, workId) {
  const el = h.open(workId);
  el.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  h.timers.at(-1).fn();
  await flush();
  el.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true }));
}

test('hover under 400ms fetches nothing and settled rows share one lazy usage snapshot', async () => {
  const h = harness();
  await h.reader.refresh();
  h.widget.render(h.body, {});
  const first = h.open('w1');
  first.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  assert.deepEqual(h.calls.work, []);
  assert.deepEqual(h.calls.usage, []);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 400);
  h.timers[0].fn();
  await flush();
  assert.deepEqual(h.calls.work, [{ work_id: 'w1' }]);
  assert.deepEqual(h.calls.usage, [{ limit: 200 }]);

  first.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true }));
  const second = h.open('w2');
  second.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  h.timers[1].fn();
  await flush();
  assert.deepEqual(h.calls.work, [{ work_id: 'w1' }, { work_id: 'w2' }]);
  assert.equal(h.calls.usage.length, 1);

  second.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true }));
  first.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  h.timers[2].fn();
  await flush();
  assert.equal(h.calls.work.length, 2);
  assert.equal(h.calls.usage.length, 1);
  assert.match(h.tooltipCalls.at(-1)[1], /Started/);
  assert.match(h.tooltipCalls.at(-1)[1], /120 in · 34 out tokens/);
  h.close();
});

test('a rejected work detail affects only that row', async () => {
  const h = harness({
    getWork: (params) => params.work_id === 'w1'
      ? Promise.reject(new Error('work unavailable'))
      : { ok: true, work: { attempt: { stream_id: 'stream-w2' } } },
  });
  await h.reader.refresh();
  assert.equal(await h.reader.readTokens(h.row('w1')), null);
  assert.deepEqual(await h.reader.readTokens(h.row('w2')), { input: 56, output: 78 });
  assert.equal(h.calls.work.length, 2);
  assert.equal(h.logs.filter((entry) => entry[1] === 'chat.away_digest_tokens_failed').length, 1);
  h.close();
});

test('a rejected or absent usage bridge returns null and the next request retries', async (t) => {
  await t.test('rejected', async () => {
    const h = harness({
      getUsage: (_params, count) => count === 1
        ? Promise.reject(new Error('usage unavailable'))
        : { recent_turns: [{ stream_id: 'stream-w1', input_tokens: 3, output_tokens: 4 }] },
    });
    await h.reader.refresh();
    await hover(h, 'w1');
    assert.doesNotMatch(h.tooltipCalls[0][1], /tokens/);
    await hover(h, 'w1');
    assert.doesNotMatch(h.tooltipCalls[1][1], /tokens/);
    assert.equal(h.calls.usage.length, 1, 'a failed usage read is not retried on hover');
    await h.reader.refresh();
    await hover(h, 'w1');
    assert.match(h.tooltipCalls[2][1], /3 in · 4 out tokens/);
    assert.equal(h.calls.work.length, 1);
    assert.equal(h.calls.usage.length, 2, 'the next arrival read allows one retry');
    h.close();
  });
  await t.test('absent', async () => {
    const h = harness({ usageAbsent: true });
    await h.reader.refresh();
    await hover(h, 'w1');
    assert.doesNotMatch(h.tooltipCalls[0][1], /tokens/);
    h.window.jennyShell.usage = { getSnapshot: (params) => {
      h.calls.usage.push(params);
      return Promise.resolve({ recent_turns: [{ stream_id: 'stream-w1', input_tokens: 5, output_tokens: 6 }] });
    } };
    await hover(h, 'w1');
    assert.match(h.tooltipCalls[1][1], /5 in · 6 out tokens/);
    assert.equal(h.calls.work.length, 1);
    assert.equal(h.calls.usage.length, 1);
    h.close();
  });
});

test('a refused snapshot keeps prior rows and Retry starts a fresh read', async () => {
  const h = harness({
    getSnapshot: (_params, count) => count === 2
      ? { ok: false, error: 'runtime unavailable' }
      : { ok: true, work: [work('w1', 's1')] },
  });
  await h.reader.refresh();
  h.widget.render(h.body, {});
  assert.ok(h.open('w1'));
  assert.equal(await h.reader.refresh(), false);
  assert.ok(h.open('w1'));
  assert.match(h.body.querySelector('.away-digest__error').textContent, /Couldn't read the runtime list/);
  h.body.querySelector('[data-digest-action="retry"]').click();
  await flush();
  assert.equal(h.calls.snapshot.length, 3);
  h.close();
});

test('visibilitychange reads visible Home and ignores hidden documents', async () => {
  const h = harness({ activeView: 'home' });
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  await flush();
  assert.equal(h.calls.snapshot.length, 1);
  h.setVisibility('hidden');
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  await flush();
  assert.equal(h.calls.snapshot.length, 1);
  h.close();
});

test('dispose removes the visibility listener', async () => {
  const h = harness({ activeView: 'home' });
  h.reader.dispose();
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));
  await flush();
  assert.equal(h.calls.snapshot.length, 0);
  h.window.close();
});

test('a run that finished while its chat was on screen is watched, not missed', async () => {
  const values = new Map();
  const storage = { getItem: (k) => (values.has(k) ? values.get(k) : null), setItem: (k, v) => values.set(k, v) };
  const later = { ...work('w3', 's1', 0), updated_at: new Date(Date.now() + 60000).toISOString() };
  const h = harness({
    storage,
    getSnapshot: (_params, count) => ({ ok: true, work: count === 1 ? [work('w1', 's1', 2), work('w2', 's2', 3)] : [work('w1', 's1', 2), work('w2', 's2', 3), later] }),
  });
  h.state.currentSessionId = 's1';
  h.reader.onChromePass();
  await h.reader.refresh();
  assert.deepEqual(h.reader.getSnapshot().digest.rows.map((row) => row.workId), ['w2'], 'the chat on screen at read time is seen');
  h.state.currentSessionId = 's2';
  h.reader.onChromePass();
  await h.reader.refresh();
  assert.deepEqual(h.reader.getSnapshot().digest.rows.map((row) => row.workId), ['w3'], 'work finishing after the chat was left is unseen; s2 is now watched');
  assert.equal(h.calls.snapshot.length, 2, 'chrome passes never read');
  h.close();
});

// Gate A5 (2026-09-22): a new chat's first run finished on screen and was acknowledged at the
// switch, but the next cursor write for another chat pruned that cursor against the page read
// before the run existed, so the following Home read showed the run as away.
async function finishedOnScreenKeepsItsCursor() {
  const values = new Map();
  const storage = { getItem: (k) => (values.has(k) ? values.get(k) : null), setItem: (k, v) => values.set(k, v) };
  const finishedOnScreen = {
    work_id: 'w3', session_id: 's3', status: 'completed',
    created_at: new Date(Date.now() - 20000).toISOString(),
    updated_at: new Date(Date.now() - 1000).toISOString(),
  };
  const h = harness({
    storage,
    getSnapshot: (_params, count) => ({ ok: true, work: count === 1
      ? [work('w1', 's1', 2), work('w2', 's2', 3)]
      : [finishedOnScreen, work('w1', 's1', 2), work('w2', 's2', 3)] }),
  });
  h.state.sessions.push({ id: 's3', title: 'PDF chat' }, { id: 's4', title: 'Next chat' });
  await h.reader.refresh();
  h.state.currentSessionId = 's3';
  h.reader.onChromePass();
  h.state.currentSessionId = 's4';
  h.reader.onChromePass();
  assert.ok(JSON.parse(values.get('jenny.ui.awayDigest.seenBySession')).s3, 'the switch commits the watched cursor');
  h.state.ui.activeView = 'home';
  h.reader.onChromePass();
  await h.reader.refresh();
  const digest = h.reader.getSnapshot().digest;
  assert.ok(JSON.parse(values.get('jenny.ui.awayDigest.seenBySession')).s3, 'the s3 cursor survives the next write');
  assert.equal(digest.rows.some((row) => row.workId === 'w3'), false, 'a run watched on screen is never away');
  assert.equal(digest.outcomeBySession.s3, undefined, 'no outcome dot for the watched chat');
  h.close();
}

test('a new chat whose first run finished on screen keeps its cursor across a later switch and read', finishedOnScreenKeepsItsCursor);

test('the watched cursor survives when it shares a millisecond with the page request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-22T12:00:00.000Z') });
  await finishedOnScreenKeepsItsCursor();
});

test('a hover timer firing on a detached card fetches nothing', async () => {
  const h = harness();
  await h.reader.refresh();
  const el = h.open('w1');
  el.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
  h.body.replaceChildren();
  h.timers.at(-1).fn();
  await flush();
  assert.equal(h.calls.work.length, 0);
  assert.equal(h.tooltipCalls.length, 0);
  h.close();
});

test('Home digest CSS uses danger emphasis without sidebar or animation rules', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'away-digest.css'), 'utf8');
  assert.match(css, /\.away-digest__outcome--failed\s*\{[^}]*color:\s*var\(--text-danger-emphasis\)/s);
  assert.doesNotMatch(css, /border-left|border-inline-start|@keyframes/);
});
