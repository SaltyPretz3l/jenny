'use strict';

// /remember, /forget and /memory (memory v2, row 58 W1) over the existing
// jennyShell.memory bridge.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryCommandHandlers } = require('../renderer/chat/renderer-slash-memory-commands');

const invocation = Object.freeze({ sessionId: 's1', generation: 1 });

function row(id, text, overrides = {}) {
  return { id, project_id: 'proj-1', lesson_text: text, lesson_kind: 'fact', status: 'active', updated_at: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z`, ...overrides };
}

function setup(options = {}) {
  const calls = { save: [], delete: [], list: 0, outputs: [], toasts: [], logs: [] };
  const api = options.api === null ? null : {
    save: async (...args) => {
      calls.save.push(args);
      if (options.saveThrows) throw new Error('ipc down');
      return options.saveResult || { created: true, memory: { id: 12 }, status: 'saved', duplicate: false };
    },
    delete: async (...args) => {
      calls.delete.push(args);
      return options.deleteResult || { deleted: true, memory_id: args[0], status: 'saved' };
    },
    listApproved: async () => {
      calls.list += 1;
      return { memories: options.rows || [] };
    },
  };
  const state = { currentSessionId: 's1', sessions: [{ id: 's1', project_id: 'proj-1' }, { id: 's2' }] };
  const handlers = createMemoryCommandHandlers({
    state,
    getMemoryApi: () => api,
    injectOutput: (...args) => { calls.outputs.push(args); return true; },
    showToastMessage: (...args) => calls.toasts.push(args),
    appendClientLog: (...args) => calls.logs.push(args),
  });
  return { calls, handlers };
}

test('/remember saves a fact by default and prints the id, kind and text', async () => {
  const { calls, handlers } = setup();
  const result = await handlers.rememberHandler({ ...invocation, args: '  the deploy   runs on Fridays ' });
  assert.deepEqual(result, { ok: true, code: 'memory_saved' });
  assert.deepEqual(calls.save, [['s1', { lesson_text: 'the deploy runs on Fridays', lesson_kind: 'fact', title: 'the deploy runs on Fridays' }]]);
  assert.deepEqual(calls.outputs, [['Remembered (id 12, fact): the deploy runs on Fridays', '/remember', { ...invocation, args: '  the deploy   runs on Fridays ' }]]);
});

test('/remember takes a leading kind prefix', async () => {
  const { calls, handlers } = setup();
  await handlers.rememberHandler({ ...invocation, args: 'Preference: answers in British English' });
  assert.equal(calls.save[0][1].lesson_kind, 'preference');
  assert.equal(calls.save[0][1].lesson_text, 'answers in British English');
  assert.equal(calls.outputs[0][0], 'Remembered (id 12, preference): answers in British English');
  // An unknown prefix is just text.
  await handlers.rememberHandler({ ...invocation, args: 'note: keep this' });
  assert.equal(calls.save[1][1].lesson_kind, 'fact');
  assert.equal(calls.save[1][1].lesson_text, 'note: keep this');
});

test('/remember reports a duplicate and a refusal in plain words', async () => {
  const duplicate = setup({ saveResult: { created: false, memory: { id: 7 }, status: 'saved', duplicate: true } });
  assert.deepEqual(await duplicate.handlers.rememberHandler({ ...invocation, args: 'x' }), { ok: true, code: 'memory_duplicate' });
  assert.equal(duplicate.calls.outputs[0][0], 'Already remembered (id 7).');
  for (const [reason, words] of [['project_archived', 'archived'], ['capacity', 'full'], ['always_on_full', 'always-on']]) {
    const refused = setup({ saveResult: { created: false, memory: null, status: 'refused', reason } });
    assert.deepEqual(await refused.handlers.rememberHandler({ ...invocation, args: 'x' }), { ok: false, handled: true, code: 'memory_refused' });
    assert.match(refused.calls.outputs[0][0], new RegExp(`^Not saved: .*${words}`, 'u'));
  }
  const noEngine = setup({ saveResult: { created: false, memory: null } });
  await noEngine.handlers.rememberHandler({ ...invocation, args: 'x' });
  assert.match(noEngine.calls.outputs[0][0], /^Not saved: memory is not available/u);
});

test('empty arguments toast and are handled without a bridge call', async () => {
  const { calls, handlers } = setup();
  assert.deepEqual(await handlers.rememberHandler({ ...invocation, args: '   ' }), { ok: false, handled: true, code: 'empty_args' });
  assert.deepEqual(await handlers.rememberHandler({ ...invocation, args: 'fact:  ' }), { ok: false, handled: true, code: 'empty_args' });
  assert.deepEqual(await handlers.forgetHandler({ ...invocation, args: '' }), { ok: false, handled: true, code: 'empty_args' });
  assert.equal(calls.toasts.length, 3);
  assert.equal(calls.save.length + calls.delete.length + calls.list, 0);
  assert.equal(calls.outputs.length, 0);
});

test('a missing bridge or a thrown save is handled, and no memory text is logged', async () => {
  const missing = setup({ api: null });
  assert.deepEqual(await missing.handlers.memoryHandler(invocation), { ok: false, handled: true, code: 'memory_unavailable' });
  const thrown = setup({ saveThrows: true });
  assert.deepEqual(await thrown.handlers.rememberHandler({ ...invocation, args: 'SECRET text' }), { ok: false, handled: true, code: 'memory_failed' });
  assert.equal(JSON.stringify(thrown.calls.logs).includes('SECRET'), false);
  assert.equal(thrown.calls.toasts.length, 1);
});

const ROWS = [
  row(1, 'Deploys run on Fridays'),
  row(2, 'The staging deploy needs a VPN', { project_id: 'project_general', lesson_kind: 'convention' }),
  row(3, 'Deploy secrets live in the vault', { project_id: 'proj-other' }),
  row(4, 'Prefers short answers', { lesson_kind: 'preference' }),
  row(5, 'Old archived note', { status: 'archived' }),
  row(6, 'This chat decided on blue', { scope_session_id: 's1' }),
  row(7, 'Another chat decided on red', { scope_session_id: 'sess-other' }),
];

test('/memory and /forget see this chat\'s notes but never another chat\'s', async () => {
  const { calls, handlers } = setup({ rows: ROWS });
  assert.deepEqual(await handlers.memoryHandler(invocation), { ok: true, code: 'memory_listed' });
  const listed = calls.outputs[0][0];
  assert.equal(listed.includes('[6] (fact) This chat decided on blue'), true);
  assert.equal(listed.includes('red'), false);
  assert.deepEqual(await handlers.forgetHandler({ ...invocation, args: '7' }), { ok: false, handled: true, code: 'memory_not_found' });
  assert.equal(calls.delete.length, 0);
});

test('/forget by id deletes that row with its own project', async () => {
  const { calls, handlers } = setup({ rows: ROWS });
  assert.deepEqual(await handlers.forgetHandler({ ...invocation, args: '2' }), { ok: true, code: 'memory_forgotten' });
  assert.deepEqual(calls.delete, [[2, 'project_general']]);
  assert.equal(calls.outputs[0][0], 'Forgot (id 2): The staging deploy needs a VPN');
});

test('/forget by an id from another project or by unknown words finds nothing', async () => {
  const { calls, handlers } = setup({ rows: ROWS });
  assert.deepEqual(await handlers.forgetHandler({ ...invocation, args: '3' }), { ok: false, handled: true, code: 'memory_not_found' });
  assert.deepEqual(await handlers.forgetHandler({ ...invocation, args: 'no such words' }), { ok: false, handled: true, code: 'memory_not_found' });
  assert.deepEqual(calls.outputs.map(([text]) => text), ['Nothing matches.', 'Nothing matches.']);
  assert.equal(calls.delete.length, 0);
});

test('/forget by unique text deletes; several matches list their ids instead', async () => {
  const unique = setup({ rows: ROWS });
  assert.deepEqual(await unique.handlers.forgetHandler({ ...invocation, args: 'SHORT answers' }), { ok: true, code: 'memory_forgotten' });
  assert.deepEqual(unique.calls.delete, [[4, 'proj-1']]);
  const several = setup({ rows: ROWS });
  assert.deepEqual(await several.handlers.forgetHandler({ ...invocation, args: 'deploy' }), { ok: false, handled: true, code: 'memory_ambiguous' });
  assert.equal(several.calls.delete.length, 0);
  assert.equal(several.calls.outputs[0][0], [
    'Several memories match; use /forget <id>:',
    '[2] The staging deploy needs a VPN',
    '[1] Deploys run on Fridays',
  ].join('\n'));
});

test('/forget reports a refused delete', async () => {
  const { calls, handlers } = setup({ rows: ROWS, deleteResult: { deleted: false, status: 'refused', reason: 'project_archived' } });
  assert.deepEqual(await handlers.forgetHandler({ ...invocation, args: '1' }), { ok: false, handled: true, code: 'memory_refused' });
  assert.match(calls.outputs[0][0], /^Not forgotten: this project is archived/u);
});

test('/memory lists this project and General, newest first', async () => {
  const { calls, handlers } = setup({ rows: ROWS });
  assert.deepEqual(await handlers.memoryHandler(invocation), { ok: true, code: 'memory_listed' });
  assert.equal(calls.outputs[0][0], [
    '[6] (fact) This chat decided on blue',
    '[4] (preference) Prefers short answers',
    '[2] (convention) The staging deploy needs a VPN',
    '[1] (fact) Deploys run on Fridays',
  ].join('\n'));
  assert.equal(calls.outputs[0][1], '/memory');
});

test('/memory says when nothing is remembered and caps a long list', async () => {
  const empty = setup({ rows: [row(3, 'other', { project_id: 'proj-other' })] });
  await empty.handlers.memoryHandler(invocation);
  assert.equal(empty.calls.outputs[0][0], 'Jenny remembers nothing for this project yet. Say /remember <text> or just tell her.');
  const many = setup({ rows: Array.from({ length: 53 }, (_, index) => row(index + 1, `memory ${index + 1}`)) });
  await many.handlers.memoryHandler(invocation);
  const lines = many.calls.outputs[0][0].split('\n');
  assert.equal(lines.length, 51);
  assert.equal(lines[0], '[53] (fact) memory 53');
  assert.equal(lines[50], '…and 3 more in Settings → Memory');
});

test('a chat without a project sees General only', async () => {
  const { calls, handlers } = setup({ rows: ROWS });
  await handlers.memoryHandler({ sessionId: 's2', generation: 1 });
  assert.equal(calls.outputs[0][0], '[2] (convention) The staging deploy needs a VPN');
});
