'use strict';

// The thinking pipeline's activity integration: data-sprite-activity, the per-pane
// tracker, typed-change re-derivation, and the pane-session preflight read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { appendReasoningRow, createHarness, setLiveThinkingState } = require('./helpers/thinking-pipeline-harness');
const { createSpriteViewApplier } = require('../renderer/chat/renderer-sprite-activity');
const realToolCallUtils = require('../renderer/chat/tool-call-utils');

const SESSION = 'session-1';
const USER = { id: 'u1', role: 'user', status: 'complete', content: 'Hello', turn_id: 'turn-1' };

function liveMessages() {
  return [{ ...USER }, { id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }];
}

function startTurn(harness, { sessionId = SESSION, streamId = 'stream-1' } = {}) {
  harness.setLifecycle(sessionId, 'streaming');
  harness.multiStream.streams.set(sessionId, streamId);
}

function finishTurn(harness, { sessionId = SESSION, streamId = 'stream-1' } = {}) {
  harness.setLifecycle(sessionId, '');
  harness.multiStream.streams.delete(sessionId);
  harness.multiStream.finalized.add(streamId);
  harness.multiStream.settled.add(streamId);
  harness.messages[1].status = 'complete';
}

function pass(harness) {
  harness.pipeline.updateAssistantSpritePosition();
  harness.scheduler.flushNext();
}

const activityOf = (harness) => harness.sprite.dataset.spriteActivity;

function expectActivity(harness, expected, message) {
  pass(harness);
  assert.equal(activityOf(harness), expected, message);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function close(harness) {
  harness.pipeline.dispose();
  harness.dom.window.close();
}

function createStreamWaitsStub() {
  const listeners = new Set();
  let typed = null;
  return {
    listeners,
    setTyped(value) { typed = value; },
    getTypedActivity: () => typed,
    onTypedActivityChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) { for (const listener of [...listeners]) listener(event); },
  };
}

test('a live reasoning turn writes think and a prose delta writes write', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  harness.state.streamDeltaKindByStream.set('stream-1', 'reasoning');
  expectActivity(harness, 'think');
  assert.equal(harness.sprite.dataset.spriteState, 'live');

  harness.state.streamDeltaKindByStream.set('stream-1', 'prose');
  expectActivity(harness, 'write');
  close(harness);
});

test('a running read tool writes search and another running tool writes tool', () => {
  const toolCallUtils = { ...realToolCallUtils, toolRunVerb: (name) => (name === 'read_file' ? 'read' : 'run') };
  const harness = createHarness({ messages: liveMessages(), toolCallUtils });
  startTurn(harness);
  harness.state.toolCallsByStream.set('stream-1', [{ callId: 'c1', toolName: 'read_file', status: 'running' }]);
  expectActivity(harness, 'search');

  harness.state.toolCallsByStream.set('stream-1', [{ callId: 'c2', toolName: 'bash', status: 'executing' }]);
  expectActivity(harness, 'tool');

  harness.state.toolCallsByStream.set('stream-1', [{ callId: 'c3', toolName: 'bash', status: 'requested' }]);
  expectActivity(harness, 'think', 'a requested tool is not proof of execution');
  close(harness);
});

test('an approval ref writes approve', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  harness.state.pendingToolApprovals.set('ap1', { approvalId: 'ap1', callId: 'c1', sessionId: SESSION });
  expectActivity(harness, 'approve');
  close(harness);
});

test('approval-map and question changes reach the pipeline through the timeline mutation observer', async () => {
  const harness = createHarness({ messages: liveMessages() });
  const timeline = harness.dom.window.document.getElementById('timeline');
  startTurn(harness);
  expectActivity(harness, 'think');

  harness.state.pendingToolApprovals.set('ap1', { approvalId: 'ap1', callId: 'c1', sessionId: SESSION });
  timeline.appendChild(harness.dom.window.document.createElement('div'));
  await settle();
  harness.scheduler.flushNext();
  assert.equal(activityOf(harness), 'approve');

  harness.state.pendingToolApprovals.clear();
  harness.messages.push({
    id: 'tool-q',
    role: 'assistant',
    kind: 'tool_use',
    turn_id: 'turn-1',
    tool_call: { call_id: 'q1', tool_name: 'ask_user', status: 'pending_user_input' },
  });
  timeline.appendChild(harness.dom.window.document.createElement('div'));
  await settle();
  harness.scheduler.flushNext();
  assert.equal(activityOf(harness), 'approve', 'a pending question is an approve wait');
  close(harness);
});

test('a live activity is idempotent: a repeated pass writes no attributes and queues no frame', async () => {
  const harness = createHarness({ messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'Working' }] });
  const article = harness.dom.window.document.querySelector('.chat-entry[data-message-id="a1"]');
  appendReasoningRow(article, { thinkingId: 'thinking-1', label: 'Thinking' });
  setLiveThinkingState(harness, { thinkingId: 'thinking-1', text: 'Thinking' });
  startTurn(harness);
  harness.state.streamDeltaKindByStream.set('stream-1', 'reasoning');

  harness.pipeline.updateAssistantSpritePosition();
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
    harness.scheduler.flushNext();
  }
  await settle();
  harness.scheduler.flushAll();
  assert.equal(activityOf(harness), 'think');

  const observer = new harness.dom.window.MutationObserver(() => {});
  observer.observe(harness.sprite, { attributes: true });
  pass(harness);
  pass(harness);
  assert.equal(observer.takeRecords().length, 0, 'no sprite attribute is rewritten');
  await settle();
  harness.scheduler.flushAll();
  assert.equal(harness.scheduler.size, 0, 'no self-sustaining positioning frame loop');
  observer.disconnect();
  close(harness);
});

test("pane B's activity never shows in pane A", () => {
  const paneA = createHarness({
    messages: [{ ...USER }, { id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  const paneB = createHarness({
    messages: liveMessages(),
    state: paneA.state,
    multiStream: paneA.multiStream,
    paneSessionId: 'session-2',
  });
  startTurn(paneB, { sessionId: 'session-2', streamId: 'stream-2' });
  paneA.state.pendingToolApprovals.set('ap2', { approvalId: 'ap2', callId: 'c2', sessionId: 'session-2' });

  pass(paneA);
  pass(paneB);
  assert.equal(activityOf(paneA), 'rest');
  assert.equal(activityOf(paneB), 'approve');

  paneA.state.pendingToolApprovals.clear();
  paneA.state.streamDeltaKindByStream.set('stream-2', 'prose');
  pass(paneA);
  pass(paneB);
  assert.equal(activityOf(paneA), 'rest');
  assert.equal(activityOf(paneB), 'write');
  close(paneA);
  close(paneB);
});

test('done plays exactly once after a visible live turn, then rest', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  expectActivity(harness, 'think');

  finishTurn(harness);
  expectActivity(harness, 'done');
  assert.equal(harness.sprite.dataset.spriteState, 'complete');
  expectActivity(harness, 'rest');
  expectActivity(harness, 'rest');
  close(harness);
});

test('a hide invalidates the record: a turn finished while hidden shows rest, never a late done', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  expectActivity(harness, 'think');

  harness.setLayerDisplay('none');
  pass(harness);
  assert.equal(harness.sprite.hasAttribute('data-sprite-activity'), false, 'a hide removes the attribute');
  finishTurn(harness);
  harness.setLayerDisplay('block');
  expectActivity(harness, 'rest');
  close(harness);
});

test('a session change invalidates the record and restored completed history goes straight to rest', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  pass(harness);
  harness.state.currentSessionId = 'session-2';
  pass(harness);
  assert.equal(harness.spriteRuntime.sessionId, 'session-2');

  finishTurn(harness);
  harness.state.currentSessionId = SESSION;
  expectActivity(harness, 'rest');
  close(harness);

  const restored = createHarness({
    messages: [{ ...USER }, { id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  expectActivity(restored, 'rest');
  close(restored);
});

test('an error or stopped turn persists its form on the settled anchor', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  pass(harness);
  finishTurn(harness);
  harness.messages[1].status = 'error';
  expectActivity(harness, 'error');
  close(harness);

  const stopped = createHarness({ messages: liveMessages() });
  stopped.multiStream.finalized.add('stream-1');
  stopped.messages[1].streamId = 'stream-1';
  expectActivity(stopped, 'stopped', 'a stop with no terminal event leaves the bubble streaming');
  close(stopped);
});

test('an admission wait anchors below the user bubble and shows wait, or stuck when cleanup is unconfirmed', () => {
  // A durable send registers no preflight: the admission wait itself is the anchor.
  const harness = createHarness({ messages: [{ ...USER }] });
  const row = (reason) => ({ key: 'durable_x', turnId: 'turn-1', wait: { reason } });
  harness.state.runtimeSendController = { listPending: () => [row('engine_busy')] };
  pass(harness);
  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  assert.equal(activityOf(harness), 'wait');

  harness.state.runtimeSendController = { listPending: () => [row('cleanup_unconfirmed')] };
  expectActivity(harness, 'stuck');
  close(harness);
});

test('a typed-activity change for this pane schedules exactly one frame; another session schedules none', () => {
  const harness = createHarness({ messages: liveMessages() });
  const waits = createStreamWaitsStub();
  harness.state.streamWaits = waits;
  startTurn(harness);
  pass(harness);
  assert.equal(waits.listeners.size, 1);
  assert.equal(harness.scheduler.size, 0);

  waits.emit({ streamId: 'stream-9', sessionId: 'session-2' });
  assert.equal(harness.scheduler.size, 0, 'another session is ignored');

  waits.setTyped({ kind: 'compaction', toolName: '', checklist: false, waitState: '' });
  waits.emit({ streamId: 'stream-1', sessionId: SESSION });
  waits.emit({ streamId: 'stream-1', sessionId: SESSION });
  assert.equal(harness.scheduler.size, 1, 'coalesced to one positioning frame');
  harness.scheduler.flushNext();
  assert.equal(activityOf(harness), 'compact');

  waits.setTyped(null);
  waits.emit({ streamId: 'stream-1', sessionId: SESSION });
  harness.scheduler.flushNext();
  assert.equal(activityOf(harness), 'think', 'a change to null re-derives');
  close(harness);
});

test('the pipeline resubscribes when state.streamWaits is replaced or nulled, and unsubscribes on dispose', () => {
  const harness = createHarness({ messages: liveMessages() });
  const first = createStreamWaitsStub();
  const second = createStreamWaitsStub();
  harness.state.streamWaits = first;
  pass(harness);
  assert.equal(first.listeners.size, 1);

  harness.state.streamWaits = second;
  pass(harness);
  assert.equal(first.listeners.size, 0, 'the replaced controller is released');
  assert.equal(second.listeners.size, 1);
  pass(harness);
  assert.equal(second.listeners.size, 1, 'an unchanged controller is not resubscribed');

  harness.state.streamWaits = null;
  pass(harness);
  assert.equal(second.listeners.size, 0);

  harness.state.streamWaits = first;
  pass(harness);
  assert.equal(first.listeners.size, 1);
  harness.pipeline.dispose();
  assert.equal(first.listeners.size, 0, 'dispose unsubscribes');
  harness.dom.window.close();
});

test('a controller without onTypedActivityChange is tolerated', () => {
  const harness = createHarness({ messages: liveMessages() });
  harness.state.streamWaits = { getTypedActivity: () => null };
  startTurn(harness);
  expectActivity(harness, 'think');
  close(harness);
});

test('preflight is read for the pane session, not the focused one', () => {
  const harness = createHarness({ messages: [{ ...USER }], paneSessionId: 'session-2' });
  harness.multiStream.preflights.set('session-1', { pending: true });
  pass(harness);
  assert.equal(harness.layer.classList.contains('visible'), false, 'the focused pane preflight does not anchor this pane');
  assert.equal(harness.layer.dataset.suppressionReason, 'empty_thread');

  harness.multiStream.preflights.set('session-2', { pending: true });
  pass(harness);
  assert.equal(harness.sprite.dataset.spriteState, 'live');
  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  close(harness);
});

test('pipeline: the dot root follows the derived activity and suspends when the sprite hides', () => {
  const harness = createHarness({ messages: liveMessages() });
  startTurn(harness);
  harness.state.streamDeltaKindByStream.set('stream-1', 'reasoning');
  const root = harness.sprite.querySelector('.chat-sprite-dot');
  assert.ok(root, 'the pipeline builds one dot for its sprite');
  assert.equal(root.dataset.activity, 'rest');

  expectActivity(harness, 'think');
  assert.equal(root.dataset.activity, 'think');
  assert.equal(root.hasAttribute('data-suspended'), false);

  harness.state.pendingToolApprovals.set('ap1', { approvalId: 'ap1', callId: 'c1', sessionId: 'session-1' });
  pass(harness);
  assert.equal(root.dataset.activity, 'approve');

  harness.state.ui.activeView = 'settings';
  pass(harness);
  assert.equal(harness.layer.classList.contains('visible'), false);
  assert.ok(root.hasAttribute('data-suspended'));

  harness.state.ui.activeView = 'chat';
  pass(harness);
  assert.equal(root.hasAttribute('data-suspended'), false, 'a visible write resumes the engine');
  assert.equal(root.dataset.activity, 'approve');

  harness.pipeline.dispose();
  assert.equal(harness.sprite.querySelector('.chat-sprite-dot'), null, 'dispose removes the dot');
  harness.dom.window.close();
});

test('pipeline: a settled turn leaves the dot at rest in front of the glyph slot', () => {
  const harness = createHarness({
    messages: [{ id: 'a1', role: 'assistant', status: 'complete', content: 'Done' }],
  });
  pass(harness);
  const root = harness.sprite.querySelector('.chat-sprite-dot');
  assert.equal(root.dataset.activity, 'rest');
  assert.equal(harness.sprite.firstElementChild, root);
  close(harness);
});

function applierHarness(overrides) {
  const dom = new JSDOM('<div id="layer"><div id="sprite"></div></div>');
  const layer = dom.window.document.getElementById('layer');
  const sprite = dom.window.document.getElementById('sprite');
  const calls = { hidden: 0, morph: [] };
  const morph = {
    setActivity: (value) => calls.morph.push(['setActivity', value]),
    suspend: () => calls.morph.push(['suspend']),
    resume: () => calls.morph.push(['resume']),
    reset: () => calls.morph.push(['reset']),
  };
  const spriteRuntime = {};
  const applier = createSpriteViewApplier({
    chatSpriteLayer: layer,
    chatAssistantSprite: sprite,
    spriteRuntime,
    normalizeSpritePhase: (message) => (message.status === 'streaming' ? 'live' : 'complete'),
    morph,
    isDisposed: () => false,
    onHidden: () => { calls.hidden += 1; },
    ...overrides,
  });
  return { applier, layer, sprite, spriteRuntime, calls };
}

test('view applier: a visible state writes state, status and activity once', () => {
  const { applier, layer, sprite, spriteRuntime, calls } = applierHarness();
  const next = applier.createVisibleSpriteState({ id: 'a1', status: 'streaming' }, 40.4, 'think');
  assert.deepEqual(next, {
    visible: true,
    targetMessageId: 'a1',
    targetY: 40,
    status: 'streaming',
    phase: 'live',
    suppressionReason: '',
    spriteActivity: 'think',
  });
  assert.equal(applier.applySpriteViewState(next), true);
  assert.equal(sprite.dataset.spriteState, 'live');
  assert.equal(sprite.dataset.spriteActivity, 'think');
  assert.equal(sprite.style.transform, 'translate3d(0, 40px, 0)');
  assert.equal(layer.classList.contains('visible'), true);
  assert.deepEqual(calls.morph, [['resume'], ['setActivity', 'think']]);
  assert.equal(spriteRuntime.targetY, 40);
  assert.equal(applier.applySpriteViewState({ ...next }), false, 'same state is idempotent');
  assert.equal(applier.applySpriteViewState({ ...next, spriteActivity: 'write' }), true, 'activity is part of identity');
  assert.equal(sprite.dataset.spriteActivity, 'write');
});

test('view applier: a hidden state removes the activity, clears the transform and reports', () => {
  const { applier, layer, sprite, spriteRuntime, calls } = applierHarness();
  applier.applySpriteViewState(applier.createVisibleSpriteState({ id: 'a1', status: 'complete' }, 10, 'rest'));
  const hidden = applier.createHiddenSpriteState({ reason: 'responsive_hidden' });
  assert.equal(hidden.spriteActivity, '');
  assert.equal(hidden.targetMessageId, 'a1');
  assert.equal(applier.applySpriteViewState(hidden), true);
  assert.equal(sprite.hasAttribute('data-sprite-activity'), false);
  assert.equal(sprite.dataset.spriteState, 'hidden');
  assert.equal(sprite.style.transform, '');
  assert.equal(layer.dataset.suppressionReason, 'responsive_hidden');
  assert.equal(calls.hidden, 1);
  assert.equal(applier.applySpriteViewState(applier.createHiddenSpriteState({ reason: 'responsive_hidden' })), false);
  assert.equal(calls.hidden, 1, 'an unchanged hide does not report again');
  assert.equal(applier.createHiddenSpriteState({ clearTarget: true }).targetMessageId, '');
  assert.equal(spriteRuntime.targetMessageId, 'a1');
});

test('view applier: the morph resumes only after a hidden state and suspends on hide; disposal blocks writes', () => {
  let disposed = false;
  const { applier, sprite, calls } = applierHarness({ isDisposed: () => disposed });
  const next = applier.createVisibleSpriteState({ id: 'a1', status: 'complete' }, 0, 'rest');
  applier.applySpriteViewState(next);
  applier.applySpriteViewState({ ...next, spriteActivity: 'think' });
  assert.deepEqual(calls.morph, [['resume'], ['setActivity', 'rest'], ['setActivity', 'think']]);

  calls.morph.length = 0;
  applier.applySpriteViewState(applier.createHiddenSpriteState({ reason: 'responsive_hidden' }));
  assert.deepEqual(calls.morph, [['suspend']]);
  calls.morph.length = 0;
  applier.applySpriteViewState({ ...next, spriteActivity: 'think' });
  assert.deepEqual(calls.morph, [['resume'], ['setActivity', 'think']], 'a visible write after a hide resumes first');
  disposed = true;
  assert.equal(applier.applySpriteViewState({ ...next, spriteActivity: 'write' }), false);
  assert.equal(sprite.dataset.spriteActivity, 'think');
  assert.equal(calls.morph.length, 2);
});

test('view applier: a session change resets the morph so the new chat never inherits a done or live form', () => {
  const { applier, calls } = applierHarness();
  applier.applySpriteViewState(applier.createVisibleSpriteState({ id: 'a1', status: 'complete' }, 0, 'done'));
  calls.morph.length = 0;
  applier.applySpriteViewState(applier.createHiddenSpriteState({ clearTarget: true, reason: 'session_changed' }));
  assert.deepEqual(calls.morph, [['suspend'], ['reset']]);
  calls.morph.length = 0;
  applier.applySpriteViewState(applier.createVisibleSpriteState({ id: 'b1', status: 'complete' }, 0, 'rest'));
  applier.applySpriteViewState(applier.createHiddenSpriteState({ reason: 'responsive_hidden' }));
  assert.deepEqual(calls.morph, [['resume'], ['setActivity', 'rest'], ['suspend']], 'other hides keep the form');
});

test('a split pane reads its own send controller for the admission wait, not the state slot', () => {
  const paneController = { listPending: () => [{ key: 'durable_x', turnId: 'turn-1', wait: { reason: 'engine_busy' } }] };
  const harness = createHarness({ messages: [{ ...USER }], runtimeSendController: paneController });
  harness.state.runtimeSendController = { listPending: () => [] };
  pass(harness);
  assert.equal(harness.spriteRuntime.targetMessageId, 'u1');
  assert.equal(activityOf(harness), 'wait');
  close(harness);
});

// Live recheck 2026-10-05: the calm "Stopped when Jenny closed" card wore the
// red "!" dot. A calm recovery class is a stop, so it gets the square dot.
test('a calm recovery class settles the sprite as stopped, a plain error as error', () => {
  for (const [recoveryClass, expected] of [['app_restart_rerun', 'stopped'], ['app_restart', 'stopped'],
    ['run_mode_changed', 'stopped'], ['sidecar_transport', 'error'], [undefined, 'error']]) {
    const harness = createHarness({ messages: liveMessages() });
    startTurn(harness);
    pass(harness);
    finishTurn(harness);
    harness.messages[1].status = 'error';
    if (recoveryClass) harness.messages[1].recovery_class = recoveryClass;
    expectActivity(harness, expected, String(recoveryClass));
    close(harness);
  }
});
