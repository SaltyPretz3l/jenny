const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommandInsertion,
  createSlashCommandRegistry,
  parseCommandPrompt,
  registerBuiltInSlashCommands,
} = require('../renderer/shell/renderer-slash-command-registry');

function buildHarness(overrides = {}) {
  const calls = { logs: [], outputs: [], renders: 0, toasts: [] };
  const state = overrides.state || {
    currentSessionId: 'session_1',
    sessions: [{ id: 'session_1' }],
    composerSessionState: new Map([['session_1', { generation: 2 }]]),
  };
  const registry = createSlashCommandRegistry({
    state,
    optimisticAppend: (...args) => { calls.outputs.push(args); return {}; },
    renderAll: () => { calls.renders += 1; },
    appendClientLog: (...args) => calls.logs.push(args),
    showToastMessage: (...args) => calls.toasts.push(args),
  });
  return { calls, registry, state };
}

test('parser accepts any whitespace and preserves multiline arguments', () => {
  assert.deepEqual(parseCommandPrompt('/NOTE\tfirst line\nsecond line'), {
    name: '/note',
    args: 'first line\nsecond line',
  });
  assert.equal(parseCommandPrompt('ordinary prompt'), null);
  assert.equal(parseCommandPrompt('/'), null);
});

test('registration validates names and rejects duplicates deterministically', () => {
  const { registry, calls } = buildHarness();
  assert.equal(registry.register('/ping', 'Ping', () => {}), true);
  assert.equal(registry.register('/ping', 'Duplicate', () => {}), false);
  assert.equal(registry.register('/bad space', 'Bad', () => {}), false);
  assert.equal(registry.register('/handler', 'Bad handler', null), false);
  assert.deepEqual(registry.listCommands().map((entry) => entry.name), ['/ping']);
  assert.equal(calls.logs.filter((entry) => entry[1] === 'slash.registration_rejected').length, 3);
});

test('attach commands return immutable metadata without running a handler and can be unregistered', async () => {
  const { registry } = buildHarness();
  let ran = false;
  const skill = { id: 'bundled/verify', name: 'Verification specialist', scope: 'bundled', command: 'verify' };
  assert.equal(registry.register('/verify', 'Check the work', () => { ran = true; }, { action: 'attach', skill }), true);
  const listed = registry.listCommands()[0];
  assert.equal(listed.action, 'attach');
  assert.equal(listed.actionLabel, 'Attach');
  assert.equal(listed.requiresSession, false);
  assert.equal(Object.isFrozen(listed.skill), true);

  const receipt = registry.execute('/VERIFY check this');
  assert.deepEqual(
    { status: receipt.status, command: receipt.command, prompt: receipt.prompt, skill: receipt.skill },
    { status: 'attached', command: '/verify', prompt: 'check this', skill }
  );
  assert.deepEqual(await receipt.completion, { ok: true, code: 'attached' });
  assert.equal(ran, false);
  assert.equal(registry.unregister('/verify'), true);
  assert.equal(registry.unregister('/verify'), false);
  assert.equal(registry.register('/verify', 'Check again', null, { action: 'attach', skill }), true);
});

test('unknown slash text and non-slash text remain passthrough', () => {
  const { registry } = buildHarness();
  assert.equal(registry.execute('/unknown').matched, false);
  assert.equal(registry.tryExecute('/unknown'), false);
  assert.equal(registry.execute('hello').matched, false);
});

test('command descriptors expose action, clear, concurrency, and availability metadata', () => {
  const { registry, state } = buildHarness();
  registry.register('/note', 'Save note', () => {}, { requiresSession: false, action: 'insert' });
  registry.register('/context', 'Show context', () => {});
  state.currentSessionId = '';
  const note = registry.listCommands().find((entry) => entry.name === '/note');
  const context = registry.listCommands().find((entry) => entry.name === '/context');
  assert.deepEqual(
    { action: note.action, clearPolicy: note.clearPolicy, concurrency: note.concurrency, available: note.available },
    { action: 'insert', clearPolicy: 'on_success', concurrency: 'drop_while_running', available: true }
  );
  assert.equal(context.available, false);
  assert.match(context.unavailableReason, /Start a conversation/);
});

test('execution returns an immutable receipt and invocation', async () => {
  const { registry } = buildHarness();
  let invocation;
  registry.register('/echo', 'Echo', (value) => { invocation = value; return { ok: true, code: 'echoed' }; });
  const receipt = registry.execute('/ECHO\tfoo bar');
  assert.equal(receipt.matched, true);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.clearPolicy, 'on_success');
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(await receipt.completion, { ok: true, code: 'echoed' });
  assert.deepEqual(invocation, { sessionId: 'session_1', generation: 2, args: 'foo bar' });
  assert.equal(Object.isFrozen(invocation), true);
});

test('session-required commands block with a settled receipt', async () => {
  const { registry, calls } = buildHarness({ state: { currentSessionId: '' } });
  let ran = false;
  registry.register('/context', 'Context', () => { ran = true; });
  const receipt = registry.execute('/context');
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.accepted, false);
  assert.equal((await receipt.completion).code, 'no_session');
  assert.equal(ran, false);
  assert.match(calls.toasts[0][0], /Start a conversation/);
});

test('one in-flight command per scope suppresses duplicate side effects and cleans up', async () => {
  const { registry, calls } = buildHarness();
  let resolveFirst;
  let runs = 0;
  registry.register('/slow', 'Slow', () => {
    runs += 1;
    return new Promise((resolve) => { resolveFirst = resolve; });
  });
  const first = registry.execute('/slow');
  await Promise.resolve();
  const duplicate = registry.execute('/slow');
  assert.equal(duplicate.status, 'busy');
  assert.equal(runs, 1);
  assert.equal((await duplicate.completion).code, 'busy');
  resolveFirst({ ok: true });
  await first.completion;
  const retry = registry.execute('/slow');
  await Promise.resolve();
  assert.equal(retry.accepted, true);
  assert.equal(runs, 2);
  resolveFirst({ ok: true });
  await retry.completion;
  assert.ok(calls.logs.some((entry) => entry[1] === 'slash.command_busy'));
});

test('handler failures remain redacted in logs and user copy', async () => {
  const { registry, calls } = buildHarness();
  registry.register('/fail', 'Fail', async () => { throw new Error('secret provider payload'); });
  const result = await registry.execute('/fail').completion;
  assert.equal(result.code, 'exception');
  assert.match(calls.toasts[0][0], /could not be completed/i);
  assert.doesNotMatch(JSON.stringify(calls.logs), /secret provider payload/);
  const log = calls.logs.find((entry) => entry[1] === 'slash.command_failed');
  assert.deepEqual(Object.keys(log[2]).sort(), ['code', 'command', 'durationMs', 'sessionId'].sort());
});

test('stale command output is dropped but original-session output survives a switch', async () => {
  const { registry, calls, state } = buildHarness();
  let invocation;
  registry.register('/slow', 'Slow', (value) => { invocation = value; return { ok: true }; });
  await registry.execute('/slow').completion;
  state.currentSessionId = 'session_2';
  state.sessions.push({ id: 'session_2' });
  assert.equal(registry.injectOutput('origin result', '/slow', invocation), true);
  assert.equal(calls.outputs[0][0], 'session_1');
  state.composerSessionState.get('session_1').generation = 3;
  assert.equal(registry.injectOutput('stale result', '/slow', invocation), false);
  assert.equal(calls.outputs.length, 1);
  assert.match(calls.toasts.at(-1)[0], /not added/i);
});

test('/help works without a session and lists only active built-ins', async () => {
  const { registry, calls } = buildHarness({ state: { currentSessionId: '' } });
  registerBuiltInSlashCommands({
    registry,
    contextHandler: () => ({ ok: true }),
    noteHandler: () => ({ ok: true }),
    compact: () => ({ accepted: false, reason: 'no_session' }),
    showToastMessage: (...args) => calls.toasts.push(args),
  });
  assert.equal((await registry.execute('/help').completion).ok, true);
  assert.match(calls.toasts[0][0], /Available now: \/help, \/note/);
  assert.match(calls.toasts[0][0], /Start a conversation for: \/context, \/compact/);
  assert.doesNotMatch(calls.toasts[0][0], /research/i);
  assert.equal(registry.listCommands().length, 4);
});

test('/help groups attachable skills before ordinary commands', async () => {
  const { registry, calls } = buildHarness();
  registerBuiltInSlashCommands({ registry, contextHandler: () => ({ ok: true }), noteHandler: () => ({ ok: true }) });
  registry.register('/verify', 'Check claims and evidence', null, {
    action: 'attach',
    skill: { id: 'bundled/verify', name: 'Verification specialist', scope: 'bundled', command: 'verify' },
  });
  await registry.execute('/help').completion;
  const output = calls.outputs[0][2];
  assert.ok(output.indexOf('Skills') < output.indexOf('Commands'));
  assert.match(output, /\/verify\s+Verification specialist \u2014 Check claims and evidence \[Attach\]/);
});

test('built-in compaction command never reports false success', async () => {
  const { registry, calls } = buildHarness();
  registerBuiltInSlashCommands({
    registry,
    contextHandler: () => ({ ok: true }),
    noteHandler: () => ({ ok: true }),
    compact: () => ({ accepted: true, activity: { state: 'error', reason: 'request_failed' } }),
    showToastMessage: (...args) => calls.toasts.push(args),
  });
  const compact = await registry.execute('/compact').completion;
  assert.equal(compact.ok, false);
  assert.equal(compact.code, 'request_failed');
  assert.equal(calls.outputs.length, 0, 'no success slash output is injected');
});

test('disposed compaction is a handled failure and never reports completion', async () => {
  const { registry } = buildHarness();
  registerBuiltInSlashCommands({
    registry,
    contextHandler: () => ({ ok: true }),
    noteHandler: () => ({ ok: true }),
    compact: () => ({ accepted: true, reason: 'disposed' }),
  });
  const result = await registry.execute('/compact').completion;
  assert.deepEqual(result, { ok: false, handled: true, code: 'disposed' });
});

test('command insertion preserves ordinary drafts and rejects conflicting commands', () => {
  assert.deepEqual(buildCommandInsertion('', '/note', 0, 0), {
    ok: true, code: 'inserted', value: '/note ', selectionStart: 6, selectionEnd: 6,
  });
  assert.deepEqual(buildCommandInsertion('remember this', '/note', 3, 8), {
    ok: true, code: 'inserted', value: '/note remember this', selectionStart: 9, selectionEnd: 14,
  });
  assert.equal(buildCommandInsertion('/note already', '/note', 5, 5).code, 'already_present');
  const conflict = buildCommandInsertion('/context', '/note', 8, 8);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.value, '/context');
});
