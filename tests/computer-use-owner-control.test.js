'use strict';
// new-test-file: the owner's side of a computer turn (row 196 C4: the held step, Resume, Stop, the turn state)

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOwnerHold, HOLD_LIMIT_MS } = require('../services/computer-use/owner-hold');
const { createOwnerControl } = require('../services/computer-use/owner-control');
const { createTurnWatch } = require('../services/computer-use/turn-watch');
const fmt = require('../services/computer-use/result-format');
const tool = require('../services/tools/builtin/computer-tool');
const { CLICK, focused, helperError, liveContext, setup: serviceSetup } = require('./helpers/computer-use-world');

// A virtual timer: the limit fires only when the test says so.
function manualTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    fire: () => { for (const timer of timers.filter((item) => !item.cleared)) timer.fn(); },
    timers,
  };
}

function fakeHost() {
  const calls = [];
  return { calls, request: async (op) => { calls.push(op); return op === 'watch.start' ? { stop_chord_registered: true } : {}; } };
}

async function setup({ chat = {}, hostAvailable = true } = {}) {
  const timers = manualTimers();
  const watch = createTurnWatch();
  const host = fakeHost();
  await watch.begin(host, 'chat', 'turn');
  const states = [];
  const record = { liveTurn: 'turn', target: { grant: { name: 'Game' }, bounds: { x: 100, y: 200, width: 400, height: 300 } }, ...chat };
  let clock = 1000;
  const owner = createOwnerControl({
    watch, getChat: (id) => (id === 'chat' ? record : undefined), currentHost: () => (hostAvailable ? host : null),
    onTurnState: (state) => states.push(state), hold: { setTimer: timers.setTimer, clearTimer: timers.clearTimer }, now: () => clock,
  });
  const step = (extra = {}) => ({ sessionId: 'chat', action: 'click', signal: undefined, ctx: {}, ...extra });
  return { timers, watch, host, states, record, owner, step, advance: (ms) => { clock += ms; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the hold waits until Resume, Stop, the limit or the abort, and keeps one wait per chat', async () => {
  const timers = manualTimers();
  let clock = 0;
  const hold = createOwnerHold({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => clock });
  assert.equal(HOLD_LIMIT_MS, 30 * 60 * 1000);
  assert.equal(hold.release('chat', 'resumed'), false);

  const resumed = hold.wait('chat');
  await flush();
  assert.equal(hold.isHeld('chat'), true);
  clock = 4200;
  assert.equal(hold.release('chat', 'resumed'), true);
  assert.deepEqual(await resumed, { ended: 'resumed', waitedMs: 4200 });
  assert.equal(hold.isHeld('chat'), false);
  assert.equal(timers.timers[0].cleared, true);

  const limited = hold.wait('chat');
  await flush();
  timers.fire();
  assert.equal((await limited).ended, 'limit');

  const controller = new AbortController();
  const aborted = hold.wait('chat', { signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal((await aborted).ended, 'cancelled');

  const first = hold.wait('chat');
  await flush();
  const second = hold.wait('chat');
  await flush();
  assert.equal((await first).ended, 'stopped', 'a second wait ends the first');
  assert.equal(hold.isHeld('chat'), true, 'the first wait finishing does not remove the second');
  hold.release('chat', 'resumed');
  assert.equal((await second).ended, 'resumed');
});

test('the hold suspends the turn clocks for the wait and resumes them after', async () => {
  const hold = createOwnerHold({ setTimer: () => null, clearTimer: () => {} });
  const events = [];
  const waiting = hold.wait('chat', { suspendClocks: async () => { events.push('suspend'); return () => events.push('resume'); } });
  await flush();
  assert.deepEqual(events, ['suspend']);
  hold.release('chat', 'stopped');
  assert.equal((await waiting).ended, 'stopped');
  assert.deepEqual(events, ['suspend', 'resume']);
  const throws = hold.wait('chat', { suspendClocks: async () => { throw new Error('no clocks'); } });
  await flush();
  hold.release('chat', 'resumed');
  assert.equal((await throws).ended, 'resumed', 'a clock that cannot stop still holds the step');
});

test('owner input pauses the turn, emits paused with the window centre, and Resume carries on in the same step', async () => {
  const { owner, watch, host, states, step, advance } = await setup();
  owner.onWatchEvent('chat', 'watch.owner_input');
  assert.equal(watch.pausedFor('chat'), 'owner');
  assert.deepEqual(states.at(-1), { sessionId: 'chat', state: 'paused', action: '', programName: 'Game', screenPoint: { x: 300, y: 350 } });

  const held = owner.holdStep(step());
  await flush();
  advance(2500);
  host.calls.length = 0;
  assert.deepEqual(await owner.resume('chat'), { ok: true, held: true });
  assert.deepEqual(host.calls, ['watch.resume']);
  assert.deepEqual(await held, { status: 'resumed', message: fmt.OWNER_RESUMED, waitedMs: 2500 });
  assert.equal(watch.pausedFor('chat'), null);
  assert.equal(states.at(-1).state, 'thinking');
});

test('Stop, the Stop chord and the limit end a held step; a Stop is never downgraded', async () => {
  {
    const { owner, step } = await setup();
    owner.onWatchEvent('chat', 'watch.owner_input');
    const held = owner.holdStep(step());
    await flush();
    assert.deepEqual(owner.stop('chat'), { ok: true, held: true });
    assert.deepEqual(await held, { status: 'paused_by_user', message: fmt.OWNER_STOPPED, waitedMs: 0 });
  }
  {
    const { owner, watch, step } = await setup();
    owner.onWatchEvent('chat', 'watch.owner_input');
    const held = owner.holdStep(step());
    await flush();
    owner.onWatchEvent('chat', 'watch.stop_chord');
    assert.equal((await held).message, fmt.OWNER_STOPPED);
    owner.onWatchEvent('chat', 'watch.owner_input');
    assert.equal(watch.pausedFor('chat'), 'stop', 'owner input after a Stop keeps the Stop');
    assert.deepEqual(await owner.resume('chat'), { ok: true, held: false }, 'Resume does not undo a Stop');
    assert.deepEqual(await owner.holdStep(step()), { status: 'paused_by_user', message: fmt.OWNER_STOPPED, waitedMs: 0 });
  }
  {
    const { owner, timers, step } = await setup();
    owner.onWatchEvent('chat', 'watch.owner_input');
    const held = owner.holdStep(step());
    await flush();
    timers.fire();
    assert.equal((await held).message, fmt.OWNER_ACTIVE);
  }
  {
    const { owner, step } = await setup();
    owner.onWatchEvent('chat', 'watch.owner_input');
    const controller = new AbortController();
    const held = owner.holdStep(step({ signal: controller.signal }));
    await flush();
    controller.abort();
    assert.equal((await held).cancelled, true);
  }
});

test('Resume answers plainly when nothing is paused, the helper is gone or the helper fails', async () => {
  {
    const { owner } = await setup();
    assert.deepEqual(await owner.resume('chat'), { ok: true, held: false });
    assert.deepEqual(await owner.resume('nobody'), { ok: true, held: false });
  }
  {
    const { owner } = await setup({ hostAvailable: false });
    owner.onWatchEvent('chat', 'watch.owner_input');
    assert.deepEqual(await owner.resume('chat'), { ok: false, reason: 'unavailable' });
  }
  {
    const { owner, host, watch } = await setup();
    owner.onWatchEvent('chat', 'watch.owner_input');
    host.request = async () => { throw new Error('gone'); };
    assert.deepEqual(await owner.resume('chat'), { ok: false, reason: 'helper_failed' });
    assert.equal(watch.pausedFor('chat'), 'owner', 'a failed resume leaves the pause');
  }
});

test('the turn ends idle once, only after a computer call, and a listener that throws never breaks a step', async () => {
  const { owner, states, record } = await setup();
  owner.emit('chat', 'step', 'click');
  assert.deepEqual(states.at(-1), { sessionId: 'chat', state: 'step', action: 'click', programName: 'Game', screenPoint: { x: 300, y: 350 } });
  owner.end('chat');
  assert.equal(states.at(-1).state, 'idle');
  assert.equal(record.liveTurn, null);
  const count = states.length;
  owner.end('chat');
  assert.equal(states.length, count, 'no second idle');

  const { owner: noBounds, states: plain } = await setup({ chat: { target: null } });
  noBounds.emit('chat', 'thinking');
  assert.deepEqual(plain.at(-1), { sessionId: 'chat', state: 'thinking', action: '', programName: '', screenPoint: null });

  const watch = createTurnWatch();
  const throwing = createOwnerControl({ watch, getChat: () => ({ liveTurn: 't' }), currentHost: () => null, onTurnState: () => { throw new Error('x'); } });
  assert.doesNotThrow(() => throwing.emit('chat', 'step'));
});

test('the tool saves a fixed refusal code, never an unknown one, and treats resumed as recoverable', async () => {
  const run = (outcome) => tool.execute({ action: 'click', x: 1, y: 1 }, liveContext({ messages: [{ id: 'u1', role: 'user', content: 'Click it' }], service: { execute: async () => outcome } }).context);
  const base = { ok: false, action: 'click', message: 'No.' };
  const refused = await run({ ...base, status: 'refused', refusal: 'elevated' });
  assert.deepEqual(refused.metadata, { result_kind: 'computer', status: 'refused', step_summary: refused.metadata.step_summary, refusal_reason: 'elevated' });
  assert.equal(refused.isError, false);
  assert.equal((await run({ ...base, status: 'refused', refusal: 'C:\\secret' })).metadata.refusal_reason, undefined);
  assert.equal((await run({ ...base, status: 'busy', refusal: 'elevated' })).metadata.refusal_reason, undefined);
  const resumed = await run({ ...base, status: 'resumed' });
  assert.deepEqual([resumed.isError, resumed.metadata.status], [false, 'resumed']);
});

// ---- the service with a held step (fake helper, virtual hold timer) ----------------------------

function heldService() {
  const timers = manualTimers();
  const s = serviceSetup({ options: { hold: { setTimer: timers.setTimer, clearTimer: timers.clearTimer } } });
  return { ...s, timers };
}

test('a step held from the helper\'s owner_active answers cancelled on abort and lets go of the keys', async () => {
  const s = heldService();
  await focused(s);
  s.world.errors['input.click'] = helperError('refused', 'owner_active');
  const controller = new AbortController();
  const pending = s.run(CLICK, { abortSignal: controller.signal });
  await flush(); await flush();
  s.world.reset();
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.status, 'cancelled');
  assert.deepEqual(s.world.names(), ['input.release_all']);
});

test('Resume answers resumed and the next input looks first; Stop before any input stops every later step', async () => {
  const s = heldService();
  await focused(s);
  s.world.errors['input.click'] = helperError('refused', 'owner_active');
  const pending = s.run(CLICK);
  await flush(); await flush();
  delete s.world.errors['input.click'];
  assert.deepEqual(await s.service.resume('chat-1'), { ok: true, held: true });
  assert.equal((await pending).status, 'resumed');
  s.world.reset();
  const next = await s.run(CLICK);
  assert.equal(s.world.ops('input.click').length, 0, 'a fresh picture first, the old one may be stale');
  assert.equal(next.status, 'done');

  const early = heldService();
  await focused(early); // looking and focusing only: the owner's watch has not started yet
  assert.deepEqual(early.service.stop('chat-1'), { ok: true, held: false });
  early.world.reset();
  assert.equal((await early.run(CLICK)).message, fmt.OWNER_STOPPED);
  assert.equal((await early.run({ action: 'screenshot' })).message, fmt.OWNER_STOPPED);
  assert.equal(early.world.ops('input.click').length, 0, 'the Stop held although it came before the watch');
  await early.service.onTurnEnd('chat-1');
  assert.notEqual((await early.run(CLICK, { turnId: 'turn-2' })).message, fmt.OWNER_STOPPED, 'a new turn goes on');
});

test('after the limit the rest of the turn answers at once instead of waiting again', async () => {
  const s = heldService();
  await focused(s);
  s.world.errors['input.click'] = helperError('refused', 'owner_active');
  const first = s.run(CLICK);
  await flush(); await flush();
  s.timers.fire();
  assert.equal((await first).message, fmt.OWNER_ACTIVE);
  const count = s.timers.timers.length;
  assert.equal((await s.run(CLICK)).message, fmt.OWNER_ACTIVE);
  assert.equal(s.timers.timers.length, count, 'no second hold');
});

test('Resume after the helper restarted starts the watch again', async () => {
  const { owner, watch, host, step } = await setup();
  owner.onWatchEvent('chat', 'watch.owner_input');
  const held = owner.holdStep(step());
  await flush();
  watch.lost();
  let resumes = 0;
  host.request = async (op) => {
    host.calls.push(op);
    if (op === 'watch.resume' && resumes++ === 0) throw new Error('no watch');
    return op === 'watch.start' ? { stop_chord_registered: true } : {};
  };
  host.calls.length = 0;
  assert.deepEqual(await owner.resume('chat'), { ok: true, held: true });
  assert.deepEqual(host.calls, ['watch.resume', 'watch.start', 'watch.resume']);
  assert.equal((await held).status, 'resumed');
  assert.equal(watch.running(), true);
});
