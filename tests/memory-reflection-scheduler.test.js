'use strict';

// Reflection scheduling (agentic memory v2, row 58 W2): eligibility, throttle,
// failure breaker, idle gate, the consent re-check under the lease, apply and
// receipts. A fake clock drives the scheduler; the sidecar is a stub that
// speaks memory.reflection_state / memory.apply / memory.policy_epoch.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { buildPreparedContextHistory } = require('../services/backend/chat-stream-reasoning');
const { detectInterruptionState } = require('../services/session-recovery-service');
const { bumpMemoryPolicyEpoch, memoryPolicyEpoch } = require('../services/backend/backend-memory');
const {
  reflectionGloballyEnabled,
  sessionIneligibility,
} = require('../services/backend/memory-reflection-eligibility');
const { MemoryReflectionScheduler } = require('../services/backend/memory-reflection-scheduler');
const { buildMemoryReflectionFacet } = require('../services/backend/memory-reflection-status');
const { windowFingerprint } = require('../services/backend/memory-reflection-window');
const { applyMemorySettingsPatch } = require('../services/shell-config-normalizers');

const MINUTE = 60_000;

function harness(t, { memory = {}, engine = 'mock', flags = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-reflection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  const config = { memory: { ...memory } };
  const clock = { now: Date.now() };
  const busy = { value: false };
  const calls = [];
  const logs = [];
  const sidecar = { cursors: new Map(), applyAnswer: null, purged: false };
  const service = {
    featureFlags: { memory_v2_enabled: true, session_offline_lockdown: true, ...flags },
    currentEngineType: engine,
    configService: { getState: () => config },
    sessionStore: store,
    projectAuthority: { captureSession: id => ({ project_id: store.getSession(id)?.project_id || 'project_general' }) },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    memoryPolicyEpoch() { return memoryPolicyEpoch(this); },
    sidecarClient: {
      connected: true,
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'memory.reflection_state') {
          return { cursor: sidecar.cursors.get(params.session_id) || null, purged: sidecar.purged };
        }
        if (method === 'memory.policy_epoch') return { latest: params.policy_epoch };
        if (method === 'memory.apply') {
          if (sidecar.applyAnswer) return sidecar.applyAnswer(params);
          sidecar.cursors.set(params.session_id, { ...params.cursor, project_id: params.project_id });
          return { status: 'applied', queued: 0, skipped: 0, saved: params.proposals.map((proposal, index) => ({
            memory_id: index + 1, operation_id: `reflect:${params.session_id}:${params.cursor.window_fingerprint.slice(7, 23)}:${index}`,
            kind: proposal.kind, text_preview: proposal.text.slice(0, 80), undoable: true })) };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  const inference = { calls: [], hook: null, error: null, proposals: null };
  async function requestInference(target, method, params, options) {
    assert.equal(target, service);
    inference.calls.push({ method, params, options });
    const proposals = inference.proposals || params.new_user_ids.map(id => ({
      text: params.messages.find(m => m.id === id).content, kind: 'preference', source_message_id: id, digest: 'd' }));
    if (inference.hook) await inference.hook(params, options);
    if (inference.error) throw inference.error;
    return options.consumeResult({ proposals, recap: 'Chat about preferences.', window_fingerprint: params.window_fingerprint,
      dropped: {}, model: 'mock-v1', elapsed_ms: 5 });
  }
  const scheduler = new MemoryReflectionScheduler({ service, now: () => clock.now, isBusy: () => busy.value,
    requestInference, setTimer: () => ({ unref() {} }), clearTimer() {} });
  service.memoryReflectionScheduler = scheduler;
  let counter = 0;
  const say = (sessionId, role, content) => {
    counter += 1;
    store.appendMessage(sessionId, { id: `${role}-${counter}`, role, content, turn_id: `turn-${counter}` });
    return `${role}-${counter}`;
  };
  const chat = (title = 'Chat') => {
    const id = store.createSession({ title }).id;
    store.setTurnIdentity(id, { session_incarnation: 'inc-1', turn_generation: 1 });
    return id;
  };
  const advance = ms => { clock.now += ms; };
  const methods = () => calls.map(call => call.method);
  const applyCalls = () => calls.filter(call => call.method === 'memory.apply');
  return { service, store, config, clock, busy, calls, logs, sidecar, inference, scheduler, say, chat, advance,
    methods, applyCalls };
}

// The first run waits out the 30 s quiet period from start.
async function settleQuiet(h) {
  h.advance(31_000);
  await h.scheduler.tick();
}

test('applied: proposals and cursor go to memory.apply and receipts are appended off-turn', async t => {
  const h = harness(t);
  const id = h.chat();
  const u1 = h.say(id, 'user', 'I prefer tabs over spaces.');
  h.say(id, 'assistant', 'Tabs it is.');
  h.store.updateSession(id, { composer_draft: 'half-typed draft' });
  const updatedAt = h.store.getSession(id).updated_at;
  await settleQuiet(h);

  assert.equal(h.inference.calls.length, 1);
  const { method, params, options } = h.inference.calls[0];
  assert.equal(method, 'memory.reflect');
  assert.equal(options.sessionId, id);
  assert.equal(options.preemptible, true);
  assert.equal(options.engineType, 'mock');
  assert.deepEqual(params.new_user_ids, [u1]);
  assert.equal(params.project_id, 'project_general');
  const messages = h.store.peekSessionMessages(id);
  assert.equal(params.window_fingerprint, windowFingerprint(messages, 1));

  const [apply] = h.applyCalls();
  assert.deepEqual(Object.keys(apply.params).sort(), ['accept_version', 'capture', 'cursor', 'epoch_source',
    'expected_fingerprint', 'policy_epoch', 'project_id', 'proposals', 'recap', 'session_id']);
  assert.equal(apply.params.capture, 'auto');
  assert.equal(apply.params.expected_fingerprint, null);
  assert.deepEqual(apply.params.cursor, { message_count: 2, last_message_id: messages[1].id,
    window_fingerprint: params.window_fingerprint, session_incarnation: 'inc-1', turn_generation: 1 });
  assert.deepEqual(apply.params.proposals, [{ text: 'I prefer tabs over spaces.', kind: 'preference', source_message_id: u1 }]);
  assert.equal(apply.params.recap, 'Chat about preferences.');

  const after = h.store.getSession(id);
  const receipt = after.messages[after.messages.length - 1];
  // A standalone note, not a tool result: it renders on its own and never
  // pairs with a tool call, reaches the model or reads as an interrupted turn.
  assert.equal(receipt.role, 'assistant');
  assert.equal(receipt.kind, 'memory_note');
  assert.equal(receipt.content, '');
  assert.equal(receipt.turn_id, undefined, 'the note belongs to no turn');
  assert.equal(receipt.tool_result, null);
  assert.deepEqual(receipt.memory_notes, [{ result_kind: 'memory', action: 'remember', status: 'saved',
    memory_id: 1, operation_id: `reflect:${id}:${params.window_fingerprint.slice(7, 23)}:0`,
    scope: 'project', kind: 'preference', undoable: true, text_preview: 'I prefer tabs over spaces.', origin: 'reflection' }]);
  assert.equal(detectInterruptionState(after.messages), 'clean', 'a note after the reply is not a mid-turn tool result');
  assert.deepEqual(buildPreparedContextHistory(after.messages, { history_scope: 'session' }),
    buildPreparedContextHistory(messages, { history_scope: 'session' }), 'the note never reaches the model');
  assert.equal(after.updated_at, updatedAt, 'a background receipt does not move the chat in the list');
  assert.equal(after.composer_draft, 'half-typed draft', 'a background receipt keeps the draft');

  const facet = buildMemoryReflectionFacet(h.service);
  assert.equal(facet.last_outcome, 'applied');
  assert.equal(facet.runs, 1);
  assert.equal(facet.saved, 1);
  assert.equal(facet.state, 'idle');
});

test('a run that saves several notes appends one receipt holding all of them', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I prefer tabs over spaces.');
  h.say(id, 'user', 'Staging host is atlas-2.');
  h.say(id, 'user', 'Deploys go out on Thursdays.');
  h.say(id, 'assistant', 'Noted.');
  const before = h.store.getSession(id).messages.length;
  await settleQuiet(h);

  const after = h.store.getSession(id).messages;
  assert.equal(after.length, before + 1, 'one receipt per run, not one per note');
  const receipt = after[after.length - 1];
  assert.equal(receipt.kind, 'memory_note');
  assert.deepEqual(receipt.memory_notes.map(note => [note.memory_id, note.text_preview, note.operation_id.endsWith(`:${note.memory_id - 1}`)]), [
    [1, 'I prefer tabs over spaces.', true], [2, 'Staging host is atlas-2.', true], [3, 'Deploys go out on Thursdays.', true]]);
  assert.equal(receipt.id, `memory_note_${receipt.memory_notes[0].operation_id.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  assert.equal(buildMemoryReflectionFacet(h.service).saved, 3);
});

test('a second run reads the stored cursor and sends only the new user messages', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I live in Lisbon.');
  h.say(id, 'assistant', 'Nice.');
  await settleQuiet(h);
  const u2 = h.say(id, 'user', 'My dog is called Rex.');
  h.advance(11 * MINUTE);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 2);
  assert.deepEqual(h.inference.calls[1].params.new_user_ids, [u2]);
  assert.equal(h.applyCalls()[1].params.expected_fingerprint, h.applyCalls()[0].params.cursor.window_fingerprint);
});

test('eligibility: flag, takeNotes, capture, opt-out, lockdown, plugin, child, cloud route', async t => {
  const h = harness(t);
  assert.equal(reflectionGloballyEnabled(h.service), true, 'takeNotes missing reads as on');
  h.config.memory.takeNotes = 'no';
  assert.equal(reflectionGloballyEnabled(h.service), true, 'a non-boolean takeNotes reads as on');
  h.config.memory.takeNotes = false;
  assert.equal(reflectionGloballyEnabled(h.service), false);
  h.config.memory.takeNotes = true;
  h.config.memory.pauseSaving = true;
  assert.equal(reflectionGloballyEnabled(h.service), false, 'capture off');
  h.config.memory.pauseSaving = false;
  h.service.featureFlags.memory_v2_enabled = false;
  assert.equal(reflectionGloballyEnabled(h.service), false, 'flag off');
  h.service.featureFlags.memory_v2_enabled = true;

  const session = { id: 's1', session_type: 'chat', context_preferences: {}, lockdown: false };
  assert.equal(sessionIneligibility(h.service, session), null);
  assert.equal(sessionIneligibility(h.service, null), 'session_missing');
  assert.equal(sessionIneligibility(h.service, { ...session, context_preferences: { memory_opt_out: true } }), 'memory_opt_out');
  assert.equal(sessionIneligibility(h.service, { ...session, lockdown: true }), 'lockdown');
  // A stored lockdown marker excludes the chat even with the lockdown feature
  // off, as it hides the chat from other chats (visibleChatPredicate).
  h.service.featureFlags.session_offline_lockdown = false;
  assert.equal(sessionIneligibility(h.service, { ...session, lockdown: true }), 'lockdown');
  h.service.featureFlags.session_offline_lockdown = true;
  assert.equal(sessionIneligibility(h.service, { ...session, session_type: 'plugin' }), 'plugin_session');
  assert.equal(sessionIneligibility(h.service, { ...session, diagnostic_mode: 'eval' }), 'diagnostic_session');
  assert.equal(sessionIneligibility(h.service, { ...session, active_turn: { stream_id: 'x' } }), 'turn_active');
  h.service.sessionRuntime = { lineageStore: { exportPortableSnapshot: () => ({ records: [
    { document: { root_session_id: 'root', children: [{ session_id: 's1' }] } }] }) } };
  assert.equal(sessionIneligibility(h.service, session), 'child_session');
  assert.equal(sessionIneligibility(h.service, { ...session, id: 'root' }), null, 'a root chat is not a child');
  h.service.sessionRuntime = { lineageStore: { exportPortableSnapshot() { throw new Error('read only'); } } };
  assert.equal(sessionIneligibility(h.service, session), 'lineage_unavailable', 'lineage fails closed');
  delete h.service.sessionRuntime;
});

for (const [label, setup] of [
  ['takeNotes off', h => { h.config.memory.takeNotes = false; }],
  ['capture off', h => { h.config.memory.pauseSaving = true; }],
  ['flag off', h => { h.service.featureFlags.memory_v2_enabled = false; }],
  ['cloud route', h => { h.service.currentEngineType = 'chatgpt'; }],
  ['opt-out', (h, id) => { h.store.setSessionPreferences(id, { context_preferences: { memory_opt_out: true } }); }],
]) {
  test(`an ineligible chat never reaches the sidecar: ${label}`, async t => {
    const h = harness(t);
    const id = h.chat();
    h.say(id, 'user', 'I prefer tea.');
    setup(h, id);
    await settleQuiet(h);
    assert.equal(h.inference.calls.length, 0);
    assert.equal(h.applyCalls().length, 0);
  });
}

test('nothing new: a caught-up chat is not reflected again', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  await settleQuiet(h);
  h.advance(11 * MINUTE);
  await h.scheduler.tick();
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1);
  const stateReads = h.methods().filter(method => method === 'memory.reflection_state').length;
  h.advance(MINUTE);
  await h.scheduler.tick();
  assert.equal(h.methods().filter(method => method === 'memory.reflection_state').length, stateReads,
    'an unchanged caught-up chat is not even re-read');
});

test('throttle: one run per 10 minutes unless 4 new user messages accumulated', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  await settleQuiet(h);
  h.say(id, 'user', 'I live in Lisbon.');
  h.advance(5 * MINUTE);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1, 'throttled');
  h.advance(5 * MINUTE + 1);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 2, 'the window opened');
  for (const text of ['A one.', 'B two.', 'C three.']) h.say(id, 'user', text);
  h.advance(MINUTE);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 2, 'three new messages stay throttled');
  h.say(id, 'user', 'D four.');
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 3, 'four new user messages bypass the throttle');
});

test('breaker: 3 consecutive failures back off 30 minutes; a preemption is not a failure', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  h.inference.error = Object.assign(new Error('auxiliary_preempted'), { reason: 'auxiliary_preempted' });
  await settleQuiet(h);
  h.advance(31_000);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 2, 'a preempted run is retried at the next idle window');
  let facet = buildMemoryReflectionFacet(h.service);
  assert.equal(facet.last_outcome, 'preempted');
  assert.equal(facet.preempted, 2);
  assert.equal(facet.backoffs, 0);

  h.inference.error = new Error('engine exploded');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    h.advance(10 * MINUTE + 1);
    await h.scheduler.tick();
  }
  assert.equal(h.inference.calls.length, 5);
  facet = buildMemoryReflectionFacet(h.service);
  assert.equal(facet.last_outcome, 'failed');
  assert.equal(facet.backoffs, 1);
  assert.equal(facet.state, 'backing_off');
  h.advance(20 * MINUTE);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 5, 'backing off');
  h.inference.error = null;
  h.advance(10 * MINUTE + 1);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 6, 'the backoff expired');
  assert.equal(buildMemoryReflectionFacet(h.service).last_outcome, 'applied');
  assert.equal(h.applyCalls().length, 1, 'no failed or preempted run applied anything');
});

test('idle gate: busy main model or a quiet period under 30 s keeps reflection waiting', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  h.busy.value = true;
  h.advance(5 * MINUTE);
  await h.scheduler.tick();
  assert.equal(buildMemoryReflectionFacet(h.service).state, 'waiting_idle');
  h.busy.value = false;
  h.advance(10_000);
  await h.scheduler.tick();
  assert.equal(h.calls.length, 0, 'inside the quiet period nothing is read');
  assert.equal(buildMemoryReflectionFacet(h.service).state, 'waiting_idle');
  h.advance(20_001);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1);
});

// A short turn can start and end between two 15 s polls, so busy is never
// observed; the chat's own writes still count as activity for the quiet period.
test('idle gate: a turn finished between polls restarts the 30 s quiet period', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const h = harness(t);
  const step = ms => { t.mock.timers.tick(ms); h.clock.now = Date.now(); };
  h.clock.now = Date.now();
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  step(31_000);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1);
  step(MINUTE);
  for (const text of ['I use tabs.', 'My host is atlas-2.', 'I write Go.', 'Short answers please.']) {
    h.say(id, 'user', text);
    h.say(id, 'assistant', 'Noted.');
  }
  step(10_000);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1, 'ten seconds after the last turn ended is not quiet');
  assert.equal(buildMemoryReflectionFacet(h.service).state, 'waiting_idle');
  step(20_001);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 2);
});

test('one run at a time, most recently updated eligible chat first', async t => {
  const h = harness(t);
  const older = h.chat('Older');
  h.say(older, 'user', 'I prefer tea.');
  await new Promise(resolve => setTimeout(resolve, 5));
  const newer = h.chat('Newer');
  h.say(newer, 'user', 'I prefer coffee.');
  let release;
  h.inference.hook = () => new Promise(resolve => { release = resolve; });
  h.advance(31_000);
  const first = h.scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buildMemoryReflectionFacet(h.service).state, 'running');
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1, 'a tick during a run starts nothing');
  assert.equal(h.inference.calls[0].options.sessionId, newer);
  release();
  await first;
  h.inference.hook = null;
  h.advance(31_000);
  await h.scheduler.tick();
  assert.equal(h.inference.calls[1].options.sessionId, older);
});

const REVOCATIONS = [
  ['the epoch moved', 'policy_stale', h => { bumpMemoryPolicyEpoch(h.service, 'test'); }],
  ['capture turned off', 'policy_stale', h => { h.config.memory.pauseSaving = true; }],
  ['takeNotes turned off', 'policy_stale', h => { h.config.memory.takeNotes = false; }],
  ['the session was deleted', 'session_changed', (h, id) => { h.store.deleteSession(id); }],
  ['the incarnation changed', 'session_changed', (h, id) => {
    h.store.setTurnIdentity(id, { session_incarnation: 'inc-2', turn_generation: 1 }); }],
  ['offline lockdown turned on', 'lockdown', (h, id) => { h.store._updateSessionRecord(id, { lockdown: true }); }],
  ['a message was edited', 'cursor_moved', (h, id, first) => { h.store.updateMessage(id, first, { content: 'edited' }); }],
];

for (const [label, reason, revoke] of REVOCATIONS) {
  test(`no apply when ${label} between reflect and apply`, async t => {
    const h = harness(t);
    const id = h.chat();
    const first = h.say(id, 'user', 'I prefer tea.');
    h.inference.hook = () => revoke(h, id, first);
    await settleQuiet(h);
    assert.equal(h.inference.calls.length, 1);
    assert.equal(h.applyCalls().length, 0);
    const facet = buildMemoryReflectionFacet(h.service);
    assert.equal(facet.last_outcome, `refused:${reason}`);
    assert.equal(facet.refused[reason], 1);
    assert.equal(h.store.peekSessionMessages(id).some(message => message.role === 'tool'), false);
  });
}

test('a refused apply is recorded and not retried until new messages arrive', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  h.sidecar.applyAnswer = () => ({ status: 'refused', reason: 'project_archived', saved: [], queued: 0, skipped: 0 });
  await settleQuiet(h);
  assert.equal(buildMemoryReflectionFacet(h.service).last_outcome, 'refused:project_archived');
  h.advance(11 * MINUTE);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1, 'not retried');
  h.sidecar.applyAnswer = null;
  h.say(id, 'user', 'I live in Lisbon.');
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 2, 'new messages re-open the chat');
  assert.equal(buildMemoryReflectionFacet(h.service).last_outcome, 'applied');
});

test('capture "ask" queues instead of saving and no receipt is appended', async t => {
  const h = harness(t, { memory: { askBeforeSaving: true } });
  const id = h.chat();
  h.say(id, 'user', 'I prefer tea.');
  h.sidecar.applyAnswer = () => ({ status: 'applied', saved: [], queued: 1, skipped: 0 });
  await settleQuiet(h);
  assert.equal(h.applyCalls()[0].params.capture, 'ask');
  assert.equal(h.store.peekSessionMessages(id).some(message => message.role === 'tool'), false);
  assert.equal(buildMemoryReflectionFacet(h.service).queued, 1);
});

test('the facet and logs carry no memory text', async t => {
  const h = harness(t);
  const id = h.chat();
  h.say(id, 'user', 'My secret passphrase hint is zebra-umbrella.');
  await settleQuiet(h);
  const facet = buildMemoryReflectionFacet(h.service);
  assert.deepEqual(Object.keys(facet).sort(), ['available', 'backoffs', 'enabled', 'failed', 'last_outcome',
    'last_run_at', 'preempted', 'queued', 'refused', 'runs', 'saved', 'skipped', 'state']);
  assert.equal(facet.available, true);
  assert.equal(facet.enabled, true);
  assert.equal(facet.last_run_at, new Date(h.clock.now).toISOString());
  const serialized = JSON.stringify({ facet, logs: h.logs });
  assert.equal(serialized.includes('zebra'), false);
  assert.equal(serialized.includes('Chat about preferences'), false);
  const outcome = h.logs.find(entry => entry.event === 'memory.reflection_outcome');
  assert.equal(outcome.level, 'INFO');
  assert.equal(outcome.details.outcome, 'applied');
  assert.deepEqual(buildMemoryReflectionFacet({}), { available: false, enabled: false, state: 'idle', last_run_at: null,
    last_outcome: null, runs: 0, preempted: 0, saved: 0, queued: 0, skipped: 0, failed: 0, refused: {}, backoffs: 0 });
});

test('start polls on an unref timer and dispose stops it', () => {
  const timers = [];
  const cleared = [];
  const scheduler = new MemoryReflectionScheduler({ service: {}, now: () => 0, isBusy: () => true,
    setTimer: (fn, ms) => { const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; timers.push(timer); return timer; },
    clearTimer: timer => cleared.push(timer) });
  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15_000);
  assert.equal(timers[0].unrefed, true);
  scheduler.dispose();
  assert.deepEqual(cleared, [timers[0]]);
});


test('chat scope reaches memory.apply and a saved chat note keeps its receipt scope', async t => {
  const h = harness(t);
  const id = h.chat();
  const source = h.say(id, 'user', 'Tried the parser migration with tabs.');
  h.inference.proposals = [{ text: 'Tried the parser migration with tabs.', kind: 'decision',
    source_message_id: source, scope: 'chat' }];
  h.sidecar.applyAnswer = () => ({ status: 'applied', saved: [{ memory_id: 1,
    operation_id: 'reflect:chat-note:0', kind: 'decision', scope: 'chat', undoable: true,
    text_preview: 'Tried the parser migration with tabs.' }], queued: 0, skipped: 0 });
  await settleQuiet(h);

  const messages = h.store.peekSessionMessages(id);
  assert.equal(messages[messages.length - 1].memory_notes[0].scope, 'chat');
  assert.equal(h.applyCalls()[0].params.proposals[0].scope, 'chat');
});

// G4 (owner, 2026-10-15): turns sent while "Jenny takes notes" was off are
// never mined; turning it back on stamps takeNotesSince through the settings path.
test('notes off, four turns, notes on: no run for those turns; the next turn runs alone', async t => {
  const h = harness(t, { memory: { takeNotes: false } });
  const id = h.chat();
  let counter = 0;
  const sayAt = (role, content, timestamp) => {
    counter += 1;
    h.store.appendMessage(id, { id: `${role}-g4-${counter}`, role, content, turn_id: `turn-g4-${counter}`, timestamp });
    return `${role}-g4-${counter}`;
  };
  for (const text of ['Secret one.', 'Secret two.', 'Secret three.', 'Secret four.']) {
    sayAt('user', text, '2026-10-15T09:00:00.000Z');
    sayAt('assistant', 'Ok.', '2026-10-15T09:00:01.000Z');
  }
  await settleQuiet(h);
  assert.equal(h.inference.calls.length, 0, 'notes off: nothing runs');

  const turnedOn = applyMemorySettingsPatch(h.config.memory, { takeNotes: true }, new Date('2026-10-15T10:00:00.000Z'));
  assert.equal(turnedOn.takeNotesSince, '2026-10-15T10:00:00.000Z');
  h.config.memory = turnedOn;
  h.advance(31_000);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 0, 'the off-period turns are never mined');
  assert.equal(h.applyCalls().length, 0, 'the cursor does not move over turns nobody read');

  const fresh = sayAt('user', 'I prefer tea.', '2026-10-15T10:05:00.000Z');
  sayAt('assistant', 'Noted.', '2026-10-15T10:05:01.000Z');
  h.advance(31_000);
  await h.scheduler.tick();
  assert.equal(h.inference.calls.length, 1);
  const { params } = h.inference.calls[0];
  assert.deepEqual(params.new_user_ids, [fresh]);
  assert.deepEqual(params.messages.map(message => message.content), ['I prefer tea.', 'Noted.']);
  assert.equal(JSON.stringify(params).includes('Secret'), false);
});
