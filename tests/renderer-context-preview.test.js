'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDraft, bindRefresh, markStale } = require('../renderer/chat/renderer-context-preview');

test('draft text and attachments share the existing local estimate without changing recorded usage', () => {
  const preview = { used_tokens: 100, capacity_tokens: 1000, breakdown: { messages: 0, system_prompt: 100 } };
  const next = withDraft(preview, '12345678', [{ kind: 'image' }]);
  assert.equal(next.used_tokens, 870);
  assert.equal(next.breakdown.messages, 770);
  assert.equal(next.available_tokens, 130);
  assert.equal(preview.used_tokens, 100);
  assert.equal(withDraft({ ...preview, capacity_tokens: null }, '', []).available_tokens, null);
  assert.equal(withDraft(null, 'draft', []), null);
});

test('preview refresh polls only visible surfaces and tears down its timer', () => {
  let tick; let calls = 0; let cleared = false; let visible = true;
  const doc = { visibilityState: 'visible' };
  const handlers = {};
  const dispose = bindRefresh({ pane: { ownerDocument: doc }, win: {
    setInterval: (callback) => { tick = callback; return 1; }, clearInterval: () => { cleared = true; },
  }, listen: (_target, type, callback) => { handlers[type] = callback; },
  syncSession: () => false, scheduleFetch: () => { calls += 1; }, paint() {}, visible: () => visible,
  options: { refreshIntervalMs: 5000, getSummaryKey: () => 'same' } });
  tick(); visible = false; tick(); visible = true; doc.visibilityState = 'hidden'; tick();
  assert.equal(calls, 1);
  handlers['composer-state-rendered'](); handlers['composer-state-rendered']();
  assert.equal(calls, 1, 'inputs unchanged since mount and since the last event fetch nothing');
  dispose(); assert.equal(cleared, true);
  const current = { context: { state: 'available', data: { used_tokens: 10 } } };
  assert.equal(markStale(current, ['context']).context.state, 'stale');
  assert.equal(current.context.state, 'available');
});

test('a poll tick re-reads the pane session and lets syncSession fetch when it changed', () => {
  let tick; let fetches = 0; let changed = false; let syncs = 0;
  bindRefresh({ pane: { ownerDocument: { visibilityState: 'visible' } }, win: {
    setInterval: (callback) => { tick = callback; return 1; }, clearInterval() {},
  }, listen() {}, syncSession: () => { syncs += 1; return changed; }, scheduleFetch: () => { fetches += 1; },
  paint() {}, visible: () => true, options: { refreshIntervalMs: 5000 } });
  tick();
  assert.deepEqual([syncs, fetches], [1, 1], 'same session: the tick polls it');
  changed = true; tick();
  assert.deepEqual([syncs, fetches], [2, 1], 'a switched session is fetched by syncSession, not polled twice');
});

test('one keystroke paints once: the bubbling input after composer-state-rendered is skipped', () => {
  const input = { value: '', matches: () => true };
  const handlers = {};
  let paints = 0;
  bindRefresh({ pane: { ownerDocument: { visibilityState: 'visible' }, querySelector: () => input }, win: {},
    listen: (_target, type, callback) => { handlers[type] = callback; },
    syncSession: () => false, scheduleFetch() {}, paint: () => { paints += 1; }, visible: () => true,
    options: { refreshIntervalMs: 0 } });
  input.value = 'a';
  handlers['composer-state-rendered']();
  handlers.input({ target: input });
  assert.equal(paints, 1);
  input.value = 'ab';
  handlers.input({ target: input });
  assert.equal(paints, 2, 'a pane without composer-state-rendered still paints its own keystrokes');
});
