const test = require('node:test');
const assert = require('node:assert/strict');

const { createDisposalFence, createGenerationGate } = require('../renderer/shared/async-fence');

/* ── createDisposalFence ── */

test('a fresh fence is live; dispose flips it exactly once', () => {
  const fence = createDisposalFence();
  assert.equal(fence.isDisposed(), false);
  assert.equal(fence.dispose(), true, 'first dispose returns true');
  assert.equal(fence.isDisposed(), true);
  assert.equal(fence.dispose(), false, 'second dispose is an idempotent no-op');
});

test('guard() wraps a continuation that no-ops after dispose', () => {
  const fence = createDisposalFence();
  const calls = [];
  const guarded = fence.guard((value) => { calls.push(value); return value * 2; });
  assert.equal(guarded(2), 4, 'live fence forwards the return value');
  fence.dispose();
  assert.equal(guarded(3), undefined, 'disposed fence swallows the call');
  assert.deepEqual(calls, [2]);
});

test('guard() preserves this-binding while live', () => {
  const fence = createDisposalFence();
  const owner = { total: 0, add: null };
  owner.add = fence.guard(function add(n) { this.total += n; return this.total; });
  assert.equal(owner.add(5), 5);
  fence.dispose();
  owner.add(7);
  assert.equal(owner.total, 5, 'post-dispose call never touched state');
});

test('onDispose callbacks run once, in registration order, and late registrations fire immediately', () => {
  const fence = createDisposalFence();
  const order = [];
  fence.onDispose(() => order.push('a'));
  fence.onDispose(() => order.push('b'));
  fence.dispose();
  fence.dispose();
  assert.deepEqual(order, ['a', 'b'], 'each callback ran exactly once, in order');
  fence.onDispose(() => order.push('late'));
  assert.deepEqual(order, ['a', 'b', 'late'], 'registering on a disposed fence fires immediately');
});

test('onDispose returns an unregister function and survives a throwing callback', () => {
  const fence = createDisposalFence();
  const order = [];
  const off = fence.onDispose(() => order.push('removed'));
  fence.onDispose(() => { throw new Error('boom'); });
  fence.onDispose(() => order.push('after-throw'));
  off();
  fence.dispose();
  assert.deepEqual(order, ['after-throw'], 'unregistered callback skipped; a throw does not block later callbacks');
});

test('throwIfDisposed() throws only after dispose, with the label in the message', () => {
  const fence = createDisposalFence();
  fence.throwIfDisposed('composer');
  fence.dispose();
  assert.throws(() => fence.throwIfDisposed('composer'), /composer/);
});

/* ── createGenerationGate ── */

test('capture/isCurrent: a token is current until the next bump', () => {
  const gate = createGenerationGate();
  const token = gate.capture();
  assert.equal(gate.isCurrent(token), true);
  gate.bump();
  assert.equal(gate.isCurrent(token), false, 'bump invalidates outstanding tokens');
  assert.equal(gate.isCurrent(gate.capture()), true);
});

test('bump() returns the new generation and current() tracks it', () => {
  const gate = createGenerationGate();
  const first = gate.current();
  const next = gate.bump();
  assert.equal(next, gate.current());
  assert.notEqual(next, first);
});

test('tokens are frozen and isCurrent rejects foreign shapes', () => {
  const gate = createGenerationGate();
  const token = gate.capture();
  assert.equal(Object.isFrozen(token), true);
  assert.equal(gate.isCurrent(null), false);
  assert.equal(gate.isCurrent({}), false);
  assert.equal(gate.isCurrent({ generation: -1 }), false);
});

test('guard(token, fn) runs only while the token is current', () => {
  const gate = createGenerationGate();
  const calls = [];
  const token = gate.capture();
  const guarded = gate.guard(token, (value) => { calls.push(value); return value; });
  assert.equal(guarded('live'), 'live');
  gate.bump();
  assert.equal(guarded('stale'), undefined, 'stale continuation swallowed');
  assert.deepEqual(calls, ['live']);
});

test('the async retarget race: a post-await continuation from a stale send never lands', async () => {
  const gate = createGenerationGate();
  const applied = [];
  async function beginWork(label, delayResolve) {
    const token = gate.capture();
    await delayResolve.promise;
    if (!gate.isCurrent(token)) return false;
    applied.push(label);
    return true;
  }
  const slow = {}; slow.promise = new Promise((resolve) => { slow.resolve = resolve; });
  const fast = {}; fast.promise = new Promise((resolve) => { fast.resolve = resolve; });
  const slowRun = beginWork('stale-target', slow);
  gate.bump(); // the user retargeted before the slow work resolved
  const fastRun = beginWork('live-target', fast);
  fast.resolve(); slow.resolve();
  assert.equal(await fastRun, true);
  assert.equal(await slowRun, false);
  assert.deepEqual(applied, ['live-target'], 'only the continuation captured after the retarget applied');
});

/* ── fence + gate together ── */

test('a disposal fence combined with a generation gate covers the dispose-mid-await race', async () => {
  const fence = createDisposalFence();
  const gate = createGenerationGate();
  fence.onDispose(() => gate.bump());
  const applied = [];
  const token = gate.capture();
  const pending = {}; pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
  const run = (async () => {
    await pending.promise;
    if (fence.isDisposed() || !gate.isCurrent(token)) return false;
    applied.push('landed');
    return true;
  })();
  fence.dispose();
  pending.resolve();
  assert.equal(await run, false);
  assert.deepEqual(applied, []);
});
