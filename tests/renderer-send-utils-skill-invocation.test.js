'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createControllerHarness } = require('./helpers/send-controller-harness');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');
const composerState = require('../renderer/chat/renderer-composer-v2-state');

const INVOCATION = Object.freeze({
  id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled', command: 'humanize',
});
const SECOND_INVOCATION = Object.freeze({
  id: 'bundled/verifier', name: 'Verifier', scope: 'bundled', command: 'verify',
});

test('send carries skillInvocation id and the optimistic user row carries enriched metadata', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('Polish this', {
    skillInvocation: { ...INVOCATION, body: 'untrusted renderer body' },
  });

  assert.deepEqual(harness.calls.startStream[0].skillInvocation, { id: INVOCATION.id });
  assert.deepEqual(harness.calls.optimisticAppend[0].extra.skill_invocation, INVOCATION);
});

test('queued replay retains skill invocation metadata', async (t) => {
  const harness = createControllerHarness([]);
  harness.multiStreamController.registerStream('session-1', 'stream-active');
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('Queue skill', { skillInvocation: INVOCATION });
  assert.deepEqual(harness.state.queuedSendBySession.get('session-1').meta.skillInvocation, INVOCATION);
  harness.multiStreamController.clearSessionStream('session-1');
  await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.deepEqual(harness.calls.startStream[0].skillInvocation, { id: INVOCATION.id });
  assert.deepEqual(harness.calls.optimisticAppend[0].extra.skill_invocation, INVOCATION);
});

test('queued replay uses the selected entry skill instead of a parked head skill', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());
  harness.controller.stashQueuedSendForSession('session-1', {
    prompt: 'Parked A', status: 'needs_review', meta: { skillInvocation: INVOCATION },
  });
  harness.controller.stashQueuedSendForSession('session-1', {
    prompt: 'Dispatch B', status: 'ready', meta: { skillInvocation: SECOND_INVOCATION },
  });

  await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.equal(harness.calls.startStream[0].prompt, 'Dispatch B');
  assert.deepEqual(harness.calls.startStream[0].skillInvocation, { id: SECOND_INVOCATION.id });
  assert.deepEqual(harness.calls.optimisticAppend[0].extra.skill_invocation, SECOND_INVOCATION);
});

test('queued replay with no selected-entry skill does not inherit a parked head skill', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());
  harness.controller.stashQueuedSendForSession('session-1', {
    prompt: 'Parked A', status: 'needs_review', meta: { skillInvocation: INVOCATION },
  });
  harness.controller.stashQueuedSendForSession('session-1', {
    prompt: 'Dispatch without skill', status: 'ready', meta: {},
  });

  await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.equal(harness.calls.startStream[0].prompt, 'Dispatch without skill');
  assert.equal(Object.hasOwn(harness.calls.startStream[0], 'skillInvocation'), false);
  assert.equal(harness.calls.optimisticAppend[0].extra.skill_invocation, undefined);
});

test('failed-payload retry retains skill invocation metadata', async (t) => {
  let attempts = 0;
  const harness = createControllerHarness([], {
    startStream: async (payload) => {
      attempts += 1;
      if (attempts === 1) throw new Error('retry me');
      return { sessionId: payload.sessionId || 'session-1', streamId: 'stream-retry' };
    },
  });
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('Retry skill', { skillInvocation: INVOCATION });
  const [payloadId] = harness.state.failedSendPayloadsById.keys();
  assert.ok(payloadId);
  await harness.controller.retryFailedPayload(payloadId);

  assert.deepEqual(harness.calls.startStream[1].skillInvocation, { id: INVOCATION.id });
  assert.deepEqual(harness.calls.optimisticAppend.at(-1).extra.skill_invocation, INVOCATION);
});

test('attach remainder sends immediately, carries skillInvocation, and clears the accepted chip', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());
  const registry = createSlashCommandRegistry({ state: harness.state });
  registry.register('/humanize', 'Polish prose', null, { action: 'attach', skill: INVOCATION });
  harness.chatInput.value = '/humanize Polish this';
  const slash = createSendSlashDispatch({ state: harness.state, registry, chatInput: harness.chatInput });
  t.after(() => slash.dispose());

  const dispatch = await slash.dispatch('/humanize Polish this', {});
  assert.equal(dispatch.handled, false);
  assert.equal(dispatch.prompt, 'Polish this');
  assert.deepEqual(composerState.getPendingSkillInvocation(harness.state), INVOCATION);
  await harness.controller.startPromptSend(dispatch.prompt, dispatch.settings);

  assert.deepEqual(harness.calls.startStream[0].skillInvocation, { id: INVOCATION.id });
  assert.deepEqual(harness.calls.optimisticAppend[0].extra.skill_invocation, INVOCATION);
  assert.equal(composerState.getPendingSkillInvocation(harness.state), null);
});

test('a durable Send shows the skill pill from Send and clears the accepted chip', async (t) => {
  // Gate A9 2026-09-24: on the durable path the pill appeared only when the
  // turn ended, and the chip stayed, so the next Send ran the skill again.
  const submitted = [];
  const harness = createControllerHarness([], { durableRuntime: true, shell: { sessionRuntime: {
    submit: async (payload) => {
      submitted.push(payload);
      return { ok: true, work_id: 'work_1', turn_id: 'turn_1', session_id: payload.session_id, revision: 1, status: 'pending' };
    },
  } } });
  t.after(() => harness.restore());
  t.after(() => harness.controller.dispose());
  const registry = createSlashCommandRegistry({ state: harness.state });
  registry.register('/verify', 'Check work', null, { action: 'attach', skill: SECOND_INVOCATION });
  harness.chatInput.value = '/verify check README.md';
  const slash = createSendSlashDispatch({ state: harness.state, registry, chatInput: harness.chatInput });
  t.after(() => slash.dispose());

  const dispatch = await slash.dispatch('/verify check README.md', {});
  const result = await harness.controller.startPromptSend(dispatch.prompt, dispatch.settings);

  assert.equal(result.durable, true);
  assert.deepEqual(submitted[0].skill_invocation, { id: SECOND_INVOCATION.id });
  assert.deepEqual(harness.calls.optimisticAppend[0].extra.skill_invocation, SECOND_INVOCATION);
  assert.equal(composerState.getPendingSkillInvocation(harness.state), null);
});

test('empty attach remainder does not start a stream and a queued start keeps the chip', async (t) => {
  const harness = createControllerHarness([]);
  t.after(() => harness.restore());
  const registry = createSlashCommandRegistry({ state: harness.state });
  registry.register('/humanize', 'Polish prose', null, { action: 'attach', skill: INVOCATION });
  const slash = createSendSlashDispatch({ state: harness.state, registry, chatInput: harness.chatInput });
  t.after(() => slash.dispose());

  harness.chatInput.value = '/humanize';
  const empty = await slash.dispatch('/humanize', {});
  assert.equal(empty.handled, true);
  assert.equal(harness.calls.startStream.length, 0);

  harness.multiStreamController.registerStream('session-1', 'stream-active');
  await harness.controller.startPromptSend('Queue this later');
  assert.equal(harness.calls.startStream.length, 0);
  assert.deepEqual(composerState.getPendingSkillInvocation(harness.state), INVOCATION);
});
