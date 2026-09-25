'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createControllerHarness } = require('./helpers/send-controller-harness');
const { eligible } = require('../renderer/chat/renderer-durable-send');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const receipt = (payload, i = 1) => ({ ok: true, work_id: `work_${i}`, turn_id: `turn_${i}`, session_id: payload.session_id, revision: 1, status: 'pending' });
const event = (payload, envelope = false, i = 1) => ({ ...(envelope ? { eventKind: 'started', channel: 'control' } : { type: 'started' }),
  sessionId: payload.session_id, turnId: `turn_${i}`, streamId: `stream_${i}`,
  [envelope ? 'payload' : 'runtimeAdmission']: envelope ? { runtimeAdmission: identity(payload, i) } : identity(payload, i) });
const identity = (payload, i) => ({ work_id: `work_${i}`, turn_id: `turn_${i}`, session_id: payload.session_id,
  stream_id: `stream_${i}`, user_message_id: `canonical_user_${i}`, idempotency_key: payload.idempotency_key });
for (const envelope of [false, true]) test(`admission before acknowledgement reconciles exact user identity (${envelope ? 'envelope' : 'legacy'})`, async t => {
  const ack = deferred(); let submitted;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: { submit: async payload => {
    submitted = payload; return ack.promise; } } } }); t.after(h.restore);
  const sending = h.controller.startPromptSend('hello'); await tick();
  assert.equal(h.state.sendPreflight, null); assert.equal(h.calls.startStream.length, 0);
  assert.equal(h.state.runtimeSendController.acceptAdmission(event(submitted, envelope)), true);
  assert.equal(h.state.messagesBySession.get('session-1')[0].id, 'canonical_user_1');
  assert.equal(h.state.messagesBySession.get('session-1')[0].turn_id, 'turn_1');
  assert.equal(h.state.runtimeSendController.acceptAdmission(event(submitted, envelope)), false);
  if (envelope) for (const channel of ['phase', 'tool']) {
    assert.equal(h.state.runtimeSendController.acceptAdmission({ ...event(submitted, true), channel }), true,
      'an admitted turn must retain phase/tool starts and their transport sequence');
  }
  h.state.currentSessionId = 'another-session'; h.chatInput.value = 'keep this draft';
  ack.resolve(receipt(submitted)); const result = await sending;
  assert.equal(result.queued, false); assert.equal(h.state.currentSessionId, 'another-session');
  assert.equal(h.chatInput.value, 'keep this draft'); assert.deepEqual(h.calls.cancelStream, []);
  h.controller.dispose();
});
test('two same-session durable Sends queue independently without replacing an active stream or preflight', async t => {
  const submissions = [];
  const h = createControllerHarness([], { durableRuntime: true, isSessionStreaming: true,
    shell: { sessionRuntime: { submit: async payload => { submissions.push(payload); return receipt(payload, submissions.length); } } } }); t.after(h.restore);
  h.multiStreamController.registerStream('session-1', 'existing_stream');
  const original = { pending: false, streamId: 'existing_stream', sessionId: 'session-1' };
  h.multiStreamController.registerPreflight('session-1', original);
  await h.controller.startPromptSend('one'); await h.controller.startPromptSend('two');
  assert.equal(submissions.length, 2); assert.notEqual(submissions[0].idempotency_key, submissions[1].idempotency_key);
  assert.equal(h.multiStreamController.getPreflight('session-1'), original);
  assert.equal(h.state.queuedSendBySession.size, 0);
  assert.equal(h.state.runtimeSendController.mergePending('session-1', []).length, 2); h.controller.dispose();
});
test('an idle durable Send is a direct send: its pending row is not queued', async t => {
  const ack = deferred(); let submitted;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: { submit: async payload => {
    submitted = payload; return ack.promise; } } } }); t.after(h.restore); t.after(() => h.controller.dispose());
  const sending = h.controller.startPromptSend('hello'); await tick();
  let [row] = h.state.runtimeSendController.listPending('session-1');
  assert.equal(row.queued, false); assert.equal(row.status, 'pending');
  ack.resolve(receipt(submitted)); await sending;
  [row] = h.state.runtimeSendController.listPending('session-1');
  assert.equal(row.queued, false); assert.equal(row.status, 'pending');
});
test('a Send behind an active stream is queued', async t => {
  const ack = deferred();
  const h = createControllerHarness([], { durableRuntime: true, isSessionStreaming: true,
    shell: { sessionRuntime: { submit: async payload => ack.promise.then(() => receipt(payload)) } } });
  t.after(h.restore); t.after(() => h.controller.dispose());
  h.multiStreamController.registerStream('session-1', 'existing_stream');
  const sending = h.controller.startPromptSend('hello'); await tick();
  assert.equal(h.state.runtimeSendController.listPending('session-1')[0].queued, true);
  ack.resolve(); await sending;
});
test('a second pending Send behind a first pending Send is queued', async t => {
  const ack = deferred(); let sequence = 0;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: { submit: async payload => {
    const index = ++sequence; await ack.promise; return receipt(payload, index); } } } });
  t.after(h.restore); t.after(() => h.controller.dispose());
  const first = h.controller.startPromptSend('first'); await tick();
  const second = h.controller.startPromptSend('second'); await tick();
  const rows = h.state.runtimeSendController.listPending('session-1');
  assert.equal(rows[0].queued, false); assert.equal(rows[1].queued, true);
  ack.resolve(); await Promise.all([first, second]);
});
test('an unconfirmed Send stays visible', async t => {
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: {
    submit: async () => { throw new Error('lost_ack'); },
  } } }); t.after(h.restore); t.after(() => h.controller.dispose());
  await h.controller.startPromptSend('possibly accepted');
  const [row] = h.state.runtimeSendController.listPending('session-1');
  assert.equal(row.status, 'unconfirmed'); assert.equal(row.queued, true);
});
test('a direct Send overtaken by a later admitted Send becomes queued behind it', async t => {
  const first = deferred(); let sequence = 0; const submitted = [];
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: { submit: async payload => {
    const index = ++sequence; submitted.push(payload); if (index === 1) await first.promise; return receipt(payload, index); } } } });
  t.after(h.restore); t.after(() => h.controller.dispose());
  const one = h.controller.startPromptSend('one'); await tick();
  const two = h.controller.startPromptSend('two'); await tick(); await two;
  assert.equal(h.state.runtimeSendController.acceptAdmission(event(submitted[1], false, 2)), true, 'the second Send is admitted first');
  const [row] = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual([row.prompt, row.queued], ['one', true], 'the first Send now waits behind an active turn');
  first.resolve(); await one;
  assert.equal(h.state.runtimeSendController.listPending('session-1')[0].queued, true, 'still behind the active turn after its own ack');
});
test('new-session creation rekeys the captured destination after navigation and before submission', async t => {
  const created = deferred(); const submissions = [];
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessions: { create: () => created.promise },
    sessionRuntime: { submit: async payload => { submissions.push(payload); return receipt(payload); } } } }); t.after(h.restore);
  h.state.currentSessionId = '';
  const sending = h.controller.startPromptSend('new conversation'); await tick();
  h.state.currentSessionId = 'other'; h.chatInput.value = 'other draft';
  created.resolve({ data: { id: 'canonical_session', title: 'New' } }); await sending;
  assert.equal(submissions[0].session_id, 'canonical_session');
  assert.equal(h.state.currentSessionId, 'other'); assert.equal(h.chatInput.value, 'other draft');
  assert.equal(h.state.messagesBySession.get('canonical_session').length, 1); h.controller.dispose();
});
test('lost acknowledgement retries exact submission; disposal does not cancel accepted work or delete its attachment', async t => {
  const accepted = deferred(); const payloads = []; const released = [];
  const h = createControllerHarness([], { durableRuntime: true, shell: { attachments: { releaseAssets: paths => released.push(paths) },
    sessionRuntime: { submit: async payload => { payloads.push(payload); if (payloads.length === 1) throw new Error('lost_ack'); return accepted.promise; } } } }); t.after(h.restore);
  h.state.attachments.queued = [{ kind: 'image', assetPath: 'C:/media/picture.png' }];
  const sending = h.controller.startPromptSend('picture'); await tick();
  assert.equal(payloads.length, 2); assert.deepEqual(payloads[0], payloads[1]);
  h.controller.dispose(); accepted.resolve(receipt(payloads[0])); await sending;
  assert.deepEqual(released, []); assert.deepEqual(h.calls.cancelStream, []);
});
test('durable eligibility preserves legacy edit, interaction, failure-retry, attachment-only and OFF paths', () => {
  const state = { features: { featureFlags: { session_runtime: true } } };
  const shell = { sessionRuntime: { submit() {} } };
  for (const settings of [{ editedMessageId: 'message' }, { failureRetry: true }, { failedPayloadId: 'failed' }]) assert.equal(eligible(state, shell, settings, 'hello', null), false);
  assert.equal(eligible(state, shell, {}, 'hello', {}), false);
  assert.equal(eligible(state, shell, {}, '', null), false);
  assert.equal(eligible({}, shell, {}, 'hello', null), false);
});

test('definite failure before submission removes the exact optimistic row and preserves a retryable local draft', async t => {
  let submits = 0;
  const h = createControllerHarness([], { durableRuntime: true, chatInputValue: 'restore me', shell: {
    sessions: { create: async () => { throw new Error('creation_failed'); } },
    sessionRuntime: { submit: async () => { submits++; } } } }); t.after(h.restore);
  h.state.currentSessionId = '';
  await h.controller.startPromptSend('restore me');
  assert.equal(submits, 0);
  assert.equal(h.state.messagesBySession.get(h.state.currentSessionId).length, 0);
  assert.equal(h.state.sessions.find(row => row.id === h.state.currentSessionId).local_draft, true);
  assert.equal(h.chatInput.value, 'restore me'); h.controller.dispose();
});

test('definitive runtime refusal restores the draft and media without a phantom pending Send', async t => {
  const released = [];
  const h = createControllerHarness([], { durableRuntime: true, chatInputValue: 'keep me', shell: {
    attachments: { releaseAssets: paths => released.push(paths) },
    sessionRuntime: { submit: async () => ({ ok: false, acceptance: 'rejected', error: { reason: 'runtime_disabled' } }) },
  } }); t.after(h.restore); t.after(() => h.controller.dispose());
  h.state.attachments.queued = [{ kind: 'image', assetPath: 'C:/media/keep.png' }];
  const result = await h.controller.startPromptSend('keep me');
  assert.equal(result.acceptanceUnknown, false);
  assert.equal(h.chatInput.value, 'keep me');
  assert.equal(h.state.attachments.queued[0].assetPath, 'C:/media/keep.png');
  assert.equal(h.state.failedSendPayloadsById.size, 1);
  assert.equal(h.state.runtimeSendController.mergePending('session-1', []).length, 0);
  assert.equal(h.state.messagesBySession.get('session-1').length, 0);
  assert.deepEqual(released, []);
});

test('a refusal after a lost acknowledgement preserves ambiguous durable ownership', async t => {
  let calls = 0;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: { submit: async () => {
    if (++calls === 1) throw new Error('lost_ack');
    return { ok: false, acceptance: 'rejected' };
  } } } }); t.after(h.restore); t.after(() => h.controller.dispose());
  const result = await h.controller.startPromptSend('possibly accepted');
  assert.equal(result.acceptanceUnknown, true);
  assert.equal(h.state.failedSendPayloadsById.size, 0);
  assert.equal(h.state.runtimeSendController.mergePending('session-1', []).length, 1);
});

for (const mentionMatches of [false, true]) test(`active-file snapshot precedes asynchronous context capture (mention matches: ${mentionMatches})`, async t => {
  const mentions = deferred(); const payloads = [];
  const active = { path: 'src/first.js', content: 'original bytes' };
  let reads = 0;
  const h = createControllerHarness([], { durableRuntime: true,
    activeFileContext: { readActiveFileContextForTurn: () => { reads++; return active; } }, shell: {
    sessionRuntime: { submit: async payload => { payloads.push(payload); return receipt(payload); } },
  } }); t.after(h.restore); t.after(() => h.controller.dispose());
  global.window.rendererIdeMentionAutocomplete = { collectMentionPaths: () => ['src/first.js'], collectMentionContents: () => mentions.promise };
  const sending = h.controller.startPromptSend('context');
  assert.equal(reads, 1);
  active.path = 'src/second.js'; active.content = 'changed bytes';
  mentions.resolve(mentionMatches ? [{ path: 'src/first.js', content: 'mentioned bytes' }] : []);
  await sending;
  assert.equal(reads, 1);
  assert.deepEqual(payloads[0].active_file_context, mentionMatches ? null : { path: 'src/first.js', content: 'original bytes' });
});

test('cancelled queued work retires through the shared work projection, restores capacity and keeps durable media ownership', async t => {
  let sequence = 0; const released = [];
  const h = createControllerHarness([], { durableRuntime: true, shell: { attachments: { releaseAssets: paths => released.push(paths) },
    sessionRuntime: { submit: async payload => receipt(payload, ++sequence), getWork: async ({ work_id }) => ({ ok: true,
      work: { work_id, session_id: 'session-1', turn_id: work_id.replace('work_', 'turn_'), status: 'cancelled' } }) } } }); t.after(h.restore);
  for (let i = 0; i < 128; i++) await h.controller.startPromptSend(`queued ${i}`);
  assert.equal(h.state.runtimeSendController.hasCapacity(), false);
  await h.state.runtimeSendController.refreshPending();
  assert.equal(h.state.runtimeSendController.hasCapacity(), true);
  assert.equal(h.state.runtimeSendController.mergePending('session-1', []).length, 120);
  h.controller.dispose(); assert.deepEqual(released, []);
});

/* ── Runtime UX A1 (JEN-043/048): the visible queue, withdrawal and legible refusals ── */

const { summary, queueHarness } = require('./helpers/durable-send-queue-harness');

test('the composer queue reads one snapshot per tick and numbers each waiting message', async t => {
  const { h, calls } = queueHarness(t, { snapshot: () => ({ ok: true, work: [summary(1), summary(2), summary(3)], next_cursor: null }) });
  for (const prompt of ['first', 'second', 'third']) await h.controller.startPromptSend(prompt);
  await h.state.runtimeSendController.refreshPending();
  assert.equal(calls.snapshots.length, 1, 'one snapshot read covers every entry in the current session');
  assert.deepEqual(calls.snapshots[0], { session_id: 'session-1', limit: 100 });
  assert.deepEqual(calls.works, [], 'the current session never falls back to per-work reads');
  const rows = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual(rows.map(row => [row.prompt, row.position, row.status]),
    [['first', 1, 'pending'], ['second', 2, 'pending'], ['third', 3, 'pending']]);
  assert.deepEqual(rows.map(row => row.workId), ['work_1', 'work_2', 'work_3']);
  assert.equal(Object.isFrozen(rows[0]), true);
  assert.deepEqual(h.state.runtimeSendController.listPending('another-session'), []);
});

test('work paused by a restart shows no position and never blocks the numbering behind it', async t => {
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null,
    work: [summary(1, { status: 'paused' }), summary(2), summary(3, { status: 'running' })] }) });
  for (const prompt of ['paused one', 'waiting', 'running now']) await h.controller.startPromptSend(prompt);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.prompt, row.status, row.position]),
    [['paused one', 'paused', null], ['waiting', 'pending', 1], ['running now', 'running', null]]);
});

test('the reply in progress is not in line: the first pending send behind it runs next', async t => {
  // The running turn was submitted first, so it always carries the lowest
  // sequence; counting it as "ahead" would call the next send "#2 in line".
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null,
    work: [summary(1, { status: 'running' }), summary(2), summary(3)] }) });
  for (const prompt of ['replying now', 'next', 'after that']) await h.controller.startPromptSend(prompt);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.prompt, row.status, row.position]),
    [['replying now', 'running', null], ['next', 'pending', 1], ['after that', 'pending', 2]]);
});

test('a running snapshot leaves a direct Send out of the strip', async t => {
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null, work: [summary(1, { status: 'running' })] }) });
  await h.controller.startPromptSend('replying now');
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.status, row.queued]), [['running', false]]);
});

test('renumbering to "runs next" keeps a Send queued while the row ahead runs', async t => {
  let work = [summary(1), summary(2)];
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, next_cursor: null, work }) });
  for (const prompt of ['first', 'second']) await h.controller.startPromptSend(prompt);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.position, row.queued]), [[1, false], [2, true]]);
  work = [summary(1, { status: 'running' }), summary(2)];
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.status, row.position, row.queued]),
    [['running', null, false], ['pending', 1, true]]);
});

test('a snapshot with more rows than one page reports queued without inventing a position', async t => {
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, work: [summary(1), summary(2)], next_cursor: 'next_page' }) });
  for (const prompt of ['first', 'second']) await h.controller.startPromptSend(prompt);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.position), [null, null]);
});

test('a stale snapshot cursor is retried on the next tick instead of clearing the queue', async t => {
  let ok = false;
  const { h } = queueHarness(t, { snapshot: () => (ok
    ? { ok: true, work: [summary(1)], next_cursor: null }
    : { ok: false, error: { code: 'CMP-RUNTIME-0006', reason: 'runtime_snapshot_cursor_stale' } }) });
  await h.controller.startPromptSend('first');
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.prompt, row.position]), [['first', null]]);
  ok = true;
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => [row.prompt, row.position]), [['first', 1]]);
});

test('a failed snapshot read falls back to per-work reads so completed work still retires', async t => {
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: false, error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_projection_unavailable' } }),
    getWork: payload => ({ ok: true, work: { work_id: payload.work_id, session_id: 'session-1',
      turn_id: payload.work_id.replace('work_', 'turn_'), status: 'completed', revision: 2 } }),
  });
  await h.controller.startPromptSend('done soon');
  assert.equal(h.state.messagesBySession.get('session-1').length, 1);
  await h.state.runtimeSendController.refreshPending();
  assert.equal(calls.snapshots.length, 1);
  assert.deepEqual(calls.works, [{ work_id: 'work_1' }], 'the snapshot covered nothing, so the work read did');
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1'), []);
  assert.equal(h.state.messagesBySession.get('session-1').length, 0);
});

test('a send that drops off the first page loses its number instead of keeping a stale one', async t => {
  let first = true;
  const { h } = queueHarness(t, { snapshot: () => {
    const page = first ? { ok: true, next_cursor: null, work: [summary(1)] }
      : { ok: true, next_cursor: 'older', work: [summary(9, { work_id: 'work_9' })] };
    first = false;
    return page;
  } });
  await h.controller.startPromptSend('first');
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.position), [1]);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.position), [null]);
});

test('an unacknowledged send reads as confirming and is re-asked under the same key until the runtime answers', async t => {
  const payloads = [];
  let answer = null;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: {
    submit: async payload => { payloads.push(payload); if (!answer) throw new Error('lost_ack'); return answer(payload); },
    getWork: async () => ({ ok: false }),
    getSnapshot: async () => ({ ok: true, work: [], next_cursor: null }),
  } } }); t.after(h.restore); t.after(() => h.controller.dispose());
  const result = await h.controller.startPromptSend('possibly accepted');
  assert.equal(result.acceptanceUnknown, true);
  assert.equal(payloads.length, 2);
  let [queued] = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual([queued.status, queued.workId, queued.prompt], ['unconfirmed', '', 'possibly accepted']);
  answer = payload => receipt(payload);
  await h.state.runtimeSendController.refreshPending();
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads[2], payloads[0], 'the exact captured submission is re-asked, never a new Send');
  [queued] = h.state.runtimeSendController.listPending('session-1');
  assert.deepEqual([queued.status, queued.workId], ['pending', 'work_1']);
  assert.equal(h.state.messagesBySession.get('session-1').length, 1);
});

test('a re-asked send the runtime finally rejects is retired and the refusal is named', async t => {
  let calls = 0;
  const h = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: {
    submit: async () => {
      if (++calls <= 2) throw new Error('lost_ack');
      return { ok: false, acceptance: 'rejected', error: { code: 'CMP-RUNTIME-0005', reason: 'session_pending_capacity' } };
    },
    getWork: async () => ({ ok: false }),
  } } }); t.after(h.restore); t.after(() => h.controller.dispose());
  await h.controller.startPromptSend('too many');
  assert.equal(h.state.messagesBySession.get('session-1').length, 1);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1'), []);
  assert.equal(h.state.messagesBySession.get('session-1').length, 0);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:refusal');
  assert.match(notice.message, /queue is full/i);
});

test('a terminal row in the shared snapshot retires the queued entry and its optimistic row', async t => {
  const { h } = queueHarness(t, { snapshot: () => ({ ok: true, work: [summary(1, { status: 'cancelled' })], next_cursor: null }) });
  await h.controller.startPromptSend('gone');
  assert.equal(h.state.messagesBySession.get('session-1').length, 1);
  await h.state.runtimeSendController.refreshPending();
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1'), []);
  assert.equal(h.state.messagesBySession.get('session-1').length, 0);
});

test('withdrawing cancels at the freshly read revision and keeps the row until cleanup is confirmed', async t => {
  const settle = deferred();
  const { h, calls } = queueHarness(t, { cancel: () => settle.promise });
  await h.controller.startPromptSend('withdraw me');
  const [queued] = h.state.runtimeSendController.listPending('session-1');
  const withdrawing = h.state.runtimeSendController.withdraw(queued.key);
  await tick();
  assert.deepEqual(calls.works, [{ work_id: 'work_1' }], 'the revision is re-read immediately before cancelling');
  assert.deepEqual(calls.cancels, [{ work_id: 'work_1', expected_revision: 4 }]);
  assert.equal(h.state.runtimeSendController.listPending('session-1')[0].status, 'withdrawing');
  assert.equal(h.state.messagesBySession.get('session-1').length, 1, 'nothing is withdrawn before cleanup is confirmed');
  settle.resolve({ ok: true, work_id: 'work_1', revision: 5, status: 'cancelled', cleanup_confirmed: true });
  await withdrawing;
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1'), []);
  assert.equal(h.state.messagesBySession.get('session-1').length, 0);
});

test('an unconfirmed cleanup keeps the row visible as withdrawing rather than claiming it is gone', async t => {
  const { h } = queueHarness(t, { cancel: () => ({ ok: true, work_id: 'work_1', revision: 5, status: 'requested', cleanup_confirmed: false }) });
  await h.controller.startPromptSend('withdraw me');
  const [queued] = h.state.runtimeSendController.listPending('session-1');
  await h.state.runtimeSendController.withdraw(queued.key);
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.status), ['withdrawing']);
  assert.equal(h.state.messagesBySession.get('session-1').length, 1);
});

test('a refused withdrawal restores the row and names the refusal in the composer', async t => {
  const { h } = queueHarness(t, { cancel: () => ({ ok: false, error: { code: 'CMP-RUNTIME-0006', reason: 'revision_conflict' } }) });
  await h.controller.startPromptSend('withdraw me');
  const [queued] = h.state.runtimeSendController.listPending('session-1');
  await h.state.runtimeSendController.withdraw(queued.key);
  assert.deepEqual(h.state.runtimeSendController.listPending('session-1').map(row => row.status), ['pending']);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:withdraw');
  assert.match(notice.message, /changed first/i);
  assert.equal(h.state.messagesBySession.get('session-1').length, 1);
});

test('resuming paused work carries the freshly read revision and reports a refusal in the composer', async t => {
  let accepted = true;
  const { h, calls } = queueHarness(t, {
    snapshot: () => ({ ok: true, work: [summary(1, { status: 'paused' })], next_cursor: null }),
    resume: () => (accepted ? { ok: true, work_id: 'work_1' }
      : { ok: false, error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_disabled' } }),
  });
  await h.controller.startPromptSend('resume me');
  await h.state.runtimeSendController.refreshPending();
  const [paused] = h.state.runtimeSendController.listPending('session-1');
  assert.equal(paused.status, 'paused');
  await h.state.runtimeSendController.resume(paused.key);
  assert.deepEqual(calls.resumes, [{ work_id: 'work_1', expected_revision: 4 }]);
  accepted = false;
  await h.state.runtimeSendController.resume(paused.key);
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:resume');
  assert.match(notice.message, /Settings/);
});

test('a calm refusal explains the wait in the composer instead of raising a Send Failed dialog', async t => {
  const h = createControllerHarness([], { durableRuntime: true, chatInputValue: 'later then', shell: {
    sessionRuntime: { submit: async () => ({ ok: false, acceptance: 'rejected',
      error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_closing' } }) },
  } }); t.after(h.restore); t.after(() => h.controller.dispose());
  const result = await h.controller.startPromptSend('later then');
  assert.equal(result.acceptanceUnknown, false);
  assert.equal(h.chatInput.value, 'later then');
  assert.deepEqual(h.calls.errors, [], 'a shutdown is a wait, not a failure dialog');
  const notice = h.calls.composerNotices.at(-1);
  assert.equal(notice.options.owner, 'runtime:refusal');
  assert.equal(notice.options.tone, 'warning');
  assert.match(notice.message, /shutting down/i);
  assert.equal(h.state.messagesBySession.get('session-1').length, 0);
});

test('a refusal that needs a decision keeps the failure dialog but names the real reason', async t => {
  const h = createControllerHarness([], { durableRuntime: true, chatInputValue: 'turn it on', shell: {
    sessionRuntime: { submit: async () => ({ ok: false, acceptance: 'rejected',
      error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_disabled' } }) },
  } }); t.after(h.restore); t.after(() => h.controller.dispose());
  await h.controller.startPromptSend('turn it on');
  assert.equal(h.calls.errors.length, 1);
  assert.match(h.calls.errors[0].title, /runtime is off/i);
  assert.match(h.calls.errors[0].message, /Settings/);
  assert.equal(h.calls.errors[0].message.includes('The change could not be applied'), false);
  assert.equal(h.chatInput.value, 'turn it on');
});
