'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProjectBrowserService } = require('../../services/projects/project-browser-service');
const { EVENT_ACTIONS } = require('../../services/tools/builtin/preview-test-arguments');

function fixture() {
  let current = true;
  const sessions = new Set();
  const calls = [];
  const owner = {
    reserveSlot(id) {
      if (!id || sessions.has(id) || sessions.size >= 1) return { ok: false };
      sessions.add(id); return { ok: true };
    },
    async open(options) { calls.push(['open', options]); return { status: 'open' }; },
    async inspect(id) { calls.push(['inspect', id]); return { console_messages: [] }; },
    async screenshot(id, options) { calls.push(['screenshot', id, options]); return { pixels: 'transient' }; },
    async eval(id, options) { calls.push(['eval', id, options.script]); return { status: 'evaluated', result: 1 }; },
    async close(id) { calls.push(['close', id]); return { closed: sessions.delete(id) }; },
  };
  const execution = { authority: { root_path: 'G:/captured' },
    assertCurrent() { if (!current) throw new Error('authority stale'); } };
  return { owner, execution, calls, sessions, invalidate: () => { current = false; } };
}

test('preview facade pins strict roots and cannot consume another operation browser', async () => {
  const h = fixture();
  const first = createProjectBrowserService(h.owner, h.execution);
  const other = createProjectBrowserService(h.owner, h.execution);
  await first.open({ sessionId: 'a', allowedFileRoots: ['G:/unrelated'], strictWorkspaceOnly: false });
  assert.deepEqual(h.calls[0][1].allowedFileRoots, ['G:/captured']);
  assert.equal(h.calls[0][1].strictWorkspaceOnly, true);
  await assert.rejects(other.open({ sessionId: 'a' }), /capacity/);
  await assert.rejects(other.inspect('a'), /does not belong/);
  await assert.rejects(other.close('a'), /does not belong/);
  assert.equal(h.sessions.has('a'), true);
  await first.close('a');
});

test('lost authority after browser open closes its owned producer before returning', async () => {
  const h = fixture();
  h.owner.open = async () => { h.invalidate(); return { status: 'open' }; };
  const facade = createProjectBrowserService(h.owner, h.execution);
  await assert.rejects(facade.open({ sessionId: 'a' }), /stale/);
  assert.deepEqual(h.calls, [['close', 'a']]);
  assert.equal(h.sessions.size, 0);
});

test('lost authority during capture discards transient pixels and permits cleanup', async () => {
  const h = fixture();
  const facade = createProjectBrowserService(h.owner, h.execution);
  await facade.open({ sessionId: 'a' });
  h.owner.screenshot = async () => { h.invalidate(); return { pixels: 'must not escape' }; };
  await assert.rejects(facade.screenshot('a'), /stale/);
  assert.equal(h.sessions.size, 0);
});

test('explicit cleanup remains available after authority revocation', async () => {
  const h = fixture();
  const facade = createProjectBrowserService(h.owner, h.execution);
  await facade.open({ sessionId: 'a' });
  h.invalidate();
  assert.equal((await facade.close('a')).closed, true);
});

test('null roots allocate no browser and unknown cleanup retains local capacity', async () => {
  const h = fixture();
  h.execution.authority.root_path = null;
  const unbound = createProjectBrowserService(h.owner, h.execution);
  await assert.rejects(unbound.open({ sessionId: 'a' }), /unavailable/);
  assert.equal(h.sessions.size, 0);
  h.execution.authority.root_path = 'G:/captured';
  const facade = createProjectBrowserService(h.owner, h.execution);
  await facade.open({ sessionId: 'a' });
  h.owner.close = async () => ({ closed: false, reason: 'cleanup_unknown' });
  await facade.close('a');
  await assert.rejects(facade.open({ sessionId: 'b' }), /already owns/);
  assert.equal(h.sessions.size, 1);
});

test('preview observation eval is granted explicitly, runs only on the owned session, and stops on lost authority', async () => {
  const h = fixture();
  assert.equal(createProjectBrowserService(h.owner, h.execution).eval, undefined, 'no eval unless granted');
  const facade = createProjectBrowserService(h.owner, h.execution, { allowEval: true });
  const other = createProjectBrowserService(h.owner, h.execution, { allowEval: true });
  await facade.open({ sessionId: 'a' });
  assert.deepEqual(await facade.eval('a', { script: 'return 1;' }), { status: 'evaluated', result: 1 });
  await assert.rejects(other.eval('a', { script: 'return 2;' }), /does not belong/);
  h.invalidate();
  await assert.rejects(facade.eval('a', { script: 'return 3;' }), /stale/);
  assert.deepEqual(h.calls.filter((call) => call[0] === 'eval').map((call) => call[2]), ['return 1;']);
  assert.equal(h.sessions.size, 0, 'lost authority closes the owned producer');
});

test('every preview_test event action is forwarded on the owned session only', async () => {
  const h = fixture();
  for (const action of EVENT_ACTIONS) {
    h.owner[action] = async (id, options) => { h.calls.push([action, id, options.key]); return { status: 'ok' }; };
  }
  const facade = createProjectBrowserService(h.owner, h.execution);
  const other = createProjectBrowserService(h.owner, h.execution);
  await facade.open({ sessionId: 'a' });
  for (const action of EVENT_ACTIONS) {
    assert.equal(typeof facade[action], 'function', `${action} is exposed`);
    assert.deepEqual(await facade[action]('a', { selector: '#x', key: 'Enter' }), { status: 'ok' });
    await assert.rejects(other[action]('a', { selector: '#x' }), /does not belong/);
  }
  assert.deepEqual(h.calls.slice(1).map((call) => call[0]), [...EVENT_ACTIONS]);
});
