'use strict';

// Row 58 W4: the conversation index pump feeds past chats into the
// sidecar-owned conversation-index.db while the main model is idle. A fake
// clock and an in-memory store drive it; the sidecar is a recording stub.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ConversationIndexPump,
  purgeConversationIndex,
  startConversationIndexPump,
} = require('../services/backend/conversation-index-pump');

const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

function chat(id, { minutesAgo = 10, count = 2, ...extra } = {}) {
  return { id, project_id: 'project_a', title: 'Title ' + id, updated_at: iso(T0 - minutesAgo * 60_000), message_count: count, ...extra };
}
const row = (id, extra = {}) => ({ id: String(id), role: 'user', content: 'text ' + id, timestamp: 'time ' + id, ...extra });

function harness({ chats = [], messages = {}, flags = {}, state = [], answers = {}, catalog = false } = {}) {
  const clock = { now: T0 };
  const busy = { value: false };
  const calls = [];
  const logs = [];
  const timers = [];
  const service = {
    featureFlags: { memory_v2_enabled: true, session_offline_lockdown: true, ...flags },
    sessionRuntime: { lineageStore: { exportPortableSnapshot: () => ({ records: [{ document: { children: [{ session_id: 'child' }] } }] }) } },
    sessionStore: {
      listSessions: () => chats,
      peekSessionMessages: id => messages[id] || [],
      getSession: () => { throw new Error('settle-on-read is forbidden'); },
    },
    semanticCatalogService: { getSidecarConfig: () => ({ semantic_catalog: { enabled: catalog } }) },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    sidecarClient: {
      connected: true,
      async request(method, params) {
        calls.push({ method, params });
        if (answers[method]) return answers[method](params);
        if (method === 'conversations.index_state') return { ok: true, sessions: state, count: state.length, message_count: 0, vector_count: 0 };
        if (method === 'conversations.index_session') return { ok: true, indexed: params.messages.length };
        if (method === 'conversations.purge') return { ok: true, removed: (params.session_ids || []).length };
        if (method.endsWith('.embed_step')) return { ok: true, embedded: 0, remaining: 0 };
        throw new Error('unexpected ' + method);
      },
    },
  };
  const pump = new ConversationIndexPump({
    service, now: () => clock.now, isBusy: () => busy.value,
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
  });
  service.conversationIndexPump = pump;
  const methods = () => calls.map(call => call.method);
  const indexed = () => calls.filter(call => call.method === 'conversations.index_session').map(call => call.params.session_id);
  return { service, pump, clock, busy, calls, logs, timers, methods, indexed, chats };
}

test('it does nothing when memory v2 is off, the app is hosted or the sidecar is not ready', async () => {
  for (const variant of [
    h => { h.service.featureFlags.memory_v2_enabled = false; },
    h => { h.service.hostMode = 'server'; },
    h => { h.service.sidecarClient.connected = false; },
    h => { h.service.sidecarManager = { getStatus: () => ({ phase: 'starting' }) }; },
  ]) {
    const h = harness({ chats: [chat('a')] });
    variant(h);
    h.clock.now += 60_000;
    await h.pump.tick();
    assert.deepEqual(h.calls, []);
  }
});

test('it waits for a quiet model: a busy poll or a recent chat write holds it for 30 s', async () => {
  const h = harness({ chats: [chat('a', { minutesAgo: 0.25 })] });
  h.clock.now += 1_000;
  await h.pump.tick();
  assert.deepEqual(h.calls, [], 'a chat written 16 s ago is not quiet');
  h.clock.now += 20_000;
  h.busy.value = true;
  await h.pump.tick();
  assert.deepEqual(h.calls, [], 'busy');
  h.busy.value = false;
  h.clock.now += 29_000;
  await h.pump.tick();
  assert.deepEqual(h.calls, [], 'within 30 s of the last busy poll');
  h.clock.now += 1_000;
  await h.pump.tick();
  assert.deepEqual(h.methods(), ['conversations.index_state', 'conversations.index_session']);
});

test('the first tick diffs the index state, purges hidden or deleted chats and indexes changed ones', async () => {
  const chats = [
    chat('same'), chat('changed', { count: 3 }), chat('fresh'),
    chat('optout', { context_preferences: { memory_opt_out: true } }), chat('locked', { lockdown: true }),
    chat('child'), chat('diag', { diagnostic_mode: true }), chat('plugin', { session_type: 'plugin' }),
    chat('empty', { count: 0 }), chat('other', { project_id: 'project_b' }), chat('general', { project_id: null }),
  ];
  const fp = c => `${c.updated_at}|${c.message_count}`;
  const state = [
    { session_id: 'same', fingerprint: fp(chats[0]) },
    { session_id: 'changed', fingerprint: `${chats[1].updated_at}|2` },
    ...['deleted', 'optout', 'locked', 'child', 'diag', 'plugin', 'empty'].map(session_id => ({ session_id, fingerprint: 'x' })),
  ];
  const h = harness({ chats, state, messages: { changed: [row(1)], fresh: [row(2)], other: [row(3)], general: [row(4)] } });
  h.clock.now += 60_000;
  await h.pump.tick();
  assert.equal(h.calls[0].method, 'conversations.index_state');
  assert.equal(h.calls[0].params.accept_version !== undefined, true);
  assert.equal(h.calls[1].method, 'conversations.purge');
  assert.deepEqual(h.calls[1].params.session_ids.sort(), ['child', 'deleted', 'diag', 'empty', 'locked', 'optout', 'plugin']);
  assert.deepEqual(h.indexed(), ['changed', 'fresh', 'other']);
  const changed = h.calls.find(call => call.params.session_id === 'changed').params;
  assert.deepEqual(changed, {
    accept_version: changed.accept_version, session_id: 'changed', project_id: 'project_a', title: 'Title changed',
    updated_at: chats[1].updated_at, fingerprint: fp(chats[1]),
    messages: [{ message_id: '1', role: 'user', created_at: 'time 1', text: 'text 1' }],
  });
  assert.equal(h.calls.find(call => call.params.session_id === 'other').params.project_id, 'project_b');
  h.calls.length = 0;
  await h.pump.tick();
  assert.deepEqual(h.methods(), ['conversations.index_session'], 'the cache holds; only the 4th changed chat remains');
  assert.equal(h.calls[0].params.project_id, 'project_general');
  h.calls.length = 0;
  await h.pump.tick();
  assert.deepEqual(h.calls, [], 'caught up');
});

test('it indexes at most 3 changed chats per tick, newest first', async () => {
  const chats = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id, index) => chat(id, { minutesAgo: 10 + index }));
  const h = harness({ chats: [chats[3], chats[1], chats[4], chats[0], chats[2]] });
  h.clock.now += 60_000;
  await h.pump.tick();
  assert.deepEqual(h.indexed(), ['c1', 'c2', 'c3']);
  await h.pump.tick();
  assert.deepEqual(h.indexed(), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('it sends the newest 500 text rows clipped to 2,000 chars and never mutates shared messages', async () => {
  const messages = Array.from({ length: 600 }, (_, i) => row(i, { role: i % 2 ? 'assistant' : 'user' }));
  messages.splice(10, 0, row('tool', { role: 'tool' }), row('note', { kind: 'memory_note' }), row('blank', { content: '  ' }));
  messages.push(row('tool-late', { role: 'tool' }), row('long', { content: 'y'.repeat(2500) }), row('long', { content: 'dupe' }));
  messages.forEach(Object.freeze); Object.freeze(messages);
  const snapshot = structuredClone(messages);
  const h = harness({ chats: [chat('a', { title: 't'.repeat(250) })], messages: { a: messages } });
  h.clock.now += 60_000;
  await h.pump.tick();
  const params = h.calls.find(call => call.method === 'conversations.index_session').params;
  assert.equal(params.messages.length, 500);
  assert.equal(params.title.length, 200);
  assert.equal(params.messages.at(-1).message_id, 'long');
  assert.equal(params.messages.at(-1).text, 'dupe', 'a repeated id keeps its newest row only');
  assert.equal(params.messages.at(-2).message_id, '599');
  assert.equal(params.messages[0].message_id, '101', '599..101 plus the deduplicated "long" row');
  assert.ok(params.messages.every(m => m.text.length <= 2000 && ['user', 'assistant'].includes(m.role)));
  assert.deepEqual(messages, snapshot);
});

test('a long text row is clipped to exactly 2,000 chars', async () => {
  const h = harness({ chats: [chat('a')], messages: { a: [row('long', { content: 'z'.repeat(2500) })] } });
  h.clock.now += 60_000;
  await h.pump.tick();
  const text = h.calls.find(call => call.method === 'conversations.index_session').params.messages[0].text;
  assert.equal(text, 'z'.repeat(2000));
});

test('embed steps run only with the catalog enabled, and memory vectors only with the hybrid flag', async () => {
  for (const [catalog, hybrid, expected] of [
    [false, false, []], [false, true, []],
    [true, false, ['conversations.embed_step']], [true, true, ['conversations.embed_step', 'memory.embed_step']],
  ]) {
    const h = harness({ chats: [], catalog, flags: { memory_hybrid_recall: hybrid } });
    h.clock.now += 60_000;
    await h.pump.tick();
    const embeds = h.calls.filter(call => call.method.endsWith('.embed_step'));
    assert.deepEqual(embeds.map(call => call.method), expected, `${catalog}/${hybrid}`);
    for (const call of embeds) {
      assert.equal(call.params.budget_seconds, 1.5);
      assert.equal(call.params.batch, 16);
    }
  }
});

test('the tick stops as soon as the model becomes busy', async () => {
  const h = harness({ chats: [chat('a'), chat('b'), chat('c')], catalog: true });
  let interrupted = false;
  h.service.sidecarClient.request = (original => async (method, params) => {
    const result = await original(method, params);
    if (method === 'conversations.index_session' && !interrupted) {
      interrupted = true;
      h.busy.value = true;
    }
    return result;
  })(h.service.sidecarClient.request);
  h.clock.now += 60_000;
  await h.pump.tick();
  assert.deepEqual(h.methods(), ['conversations.index_state', 'conversations.index_session']);
  h.busy.value = false;
  h.clock.now += 30_000;
  await h.pump.tick();
  assert.deepEqual(h.indexed(), ['a', 'b', 'c']);
});

test('three failures back it off for 10 minutes, then the index state is reloaded', async () => {
  let fail = true;
  const h = harness({
    chats: [chat('a')],
    answers: { 'conversations.index_state': () => { if (fail) throw new Error('private chat text'); return { ok: true, sessions: [] }; } },
  });
  h.clock.now += 60_000;
  for (let i = 0; i < 3; i += 1) await h.pump.tick();
  assert.equal(h.calls.length, 3);
  fail = false;
  h.clock.now += 9 * 60_000;
  await h.pump.tick();
  assert.equal(h.calls.length, 3, 'backing off');
  h.clock.now += 61_000;
  await h.pump.tick();
  assert.deepEqual(h.methods().slice(3), ['conversations.index_state', 'conversations.index_session']);
  assert.ok(h.logs.length > 0);
  assert.ok(!JSON.stringify(h.logs).includes('private chat text'));
  assert.ok(!JSON.stringify(h.logs).includes('text '));
});

test('an unavailable index or a refused write counts as a failure and never throws', async () => {
  const h = harness({ chats: [chat('a')], answers: { 'conversations.index_state': () => ({ ok: false, reason: 'index_unavailable' }) } });
  h.clock.now += 60_000;
  await h.pump.tick();
  assert.deepEqual(h.methods(), ['conversations.index_state']);
  const full = harness({ chats: [chat('a'), chat('b')], answers: { 'conversations.index_session': () => ({ ok: false, reason: 'index_full' }) } });
  full.clock.now += 60_000;
  await full.pump.tick();
  assert.deepEqual(full.indexed(), ['a'], 'a full index stops this tick');
});

test('a full index stops new chats but the embed steps still run on every tick', async () => {
  const h = harness({
    chats: [chat('a')], catalog: true, flags: { memory_hybrid_recall: true },
    answers: { 'conversations.index_session': () => ({ ok: false, reason: 'index_full' }) },
  });
  for (let tick = 0; tick < 2; tick += 1) {
    h.clock.now += 60_000;
    await h.pump.tick();
  }
  const embeds = h.calls.filter(call => call.method.endsWith('.embed_step')).map(call => call.method);
  assert.deepEqual(embeds, ['conversations.embed_step', 'memory.embed_step', 'conversations.embed_step', 'memory.embed_step']);
});

test('a sidecar restart reloads the index state', async () => {
  const h = harness({ chats: [chat('a')] });
  h.clock.now += 60_000;
  await h.pump.tick();
  h.service.sidecarClient = { ...h.service.sidecarClient };
  await h.pump.tick();
  assert.deepEqual(h.methods(), ['conversations.index_state', 'conversations.index_session',
    'conversations.index_state', 'conversations.index_session']);
});

test('start polls every 20 s on an unref timer and dispose clears it and stops ticks', async () => {
  const h = harness({ chats: [chat('a')] });
  h.pump.start();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 20_000);
  h.clock.now += 60_000;
  h.timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.length > 0);
  h.pump.dispose();
  assert.equal(h.timers.at(-1).cleared, true);
  const before = h.calls.length;
  await h.pump.tick();
  assert.equal(h.calls.length, before);
});

test('startConversationIndexPump attaches the pump to the service', () => {
  const service = {};
  const pump = startConversationIndexPump({ service, setTimer: () => ({ unref() {} }), clearTimer() {} });
  assert.equal(service.conversationIndexPump, pump);
  pump.dispose();
});

test('a committed delete purges that chat best-effort and drops it from the cache', async () => {
  const h = harness({ chats: [chat('a')] });
  h.clock.now += 60_000;
  await h.pump.tick();
  h.calls.length = 0;
  await purgeConversationIndex(h.service, 'a');
  assert.deepEqual(h.calls.map(call => [call.method, call.params.session_ids]), [['conversations.purge', ['a']]]);
  h.chats.length = 0;
  h.calls.length = 0;
  await h.pump.tick();
  assert.deepEqual(h.calls, [], 'already purged; nothing stale left');

  h.service.sidecarClient.request = async () => { throw new Error('boom'); };
  await purgeConversationIndex(h.service, 'b');
  h.service.sidecarClient = null;
  await purgeConversationIndex(h.service, 'c');
  h.service.sidecarClient = { connected: true, request: async () => { throw new Error('unreachable'); } };
  h.service.hostMode = 'server';
  await purgeConversationIndex(h.service, 'd');
});
