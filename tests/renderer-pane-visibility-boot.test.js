'use strict';

/* Split view W0-3 -- the stream handler's render gate really goes through the
 * pane predicate in a real boot.
 *
 * renderer-stream-handler.js resolves window.rendererPaneVisibilityUtils at
 * CALL time with the old expression as its fallback, so a plain `node --test`
 * over the stream-handler suites (no window global) exercises the fallback and
 * never the new module. The independent review proved it: a predicate
 * hard-wired to "never visible" passed every stream suite. This file is the
 * gate that fails: it boots the real renderer over the real index.html, wraps
 * the global the handler reads, and asserts (1) the handler asks it for the
 * streaming session and (2) its answer decides whether the deltas paint.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const paneVisibility = require('../renderer/chat/renderer-pane-visibility-utils');

function buildSession(sessionId) {
  return {
    id: sessionId,
    title: `Session ${sessionId}`,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function makeStartStreamShell(sessionId, streamId) {
  return {
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [buildSession(sessionId)];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId };
      },
    },
  };
}

async function streamThreeDeltas({ sessionId, streamId, predicate, label }) {
  const asked = [];
  const app = await loadRendererApp({
    shell: makeStartStreamShell(sessionId, streamId),
    windowGlobals: {
      rendererPaneVisibilityUtils: {
        isSessionVisibleInPane: paneVisibility.isSessionVisibleInPane,
        isSessionVisibleInAnyPane(state, candidate) {
          asked.push(String(candidate || ''));
          return predicate(state, candidate);
        },
      },
    },
  });
  try {
    const { window, shell } = app;
    const doc = window.document;
    doc.getElementById('chatInput').value = `${label} probe`;
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 30);

    const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
    await emit({ type: 'started' });
    let aggregate = '';
    for (let index = 0; index < 3; index += 1) {
      const content = `${label}-${index}. `;
      aggregate += content;
      await emit({ type: 'delta', content, aggregate });
      await waitForUi(window, 20);
    }
    await waitForUi(window, 60);
    // queueSessionRender (renderer-stream-handler-runtime.js) is the DI consumer
    // that turns the predicate's answer into "paint or not"; it logs that answer
    // as `visible` on every queued render, and the renderer log ring is exposed
    // to real-boot tests as window.__rendererState.logs.
    const logs = (window.__rendererState && window.__rendererState.logs) || [];
    const queued = logs
      .filter((entry) => String(entry?.event || '') === 'stream.queue_session_render')
      .map((entry) => entry?.details || entry?.data || {})
      .filter((details) => String(details.sessionId || '') === sessionId);
    return { asked, visibleAnswers: queued.map((details) => details.visible) };
  } finally {
    await app.dispose();
  }
}

test('a real boot routes the stream render gate through the pane predicate and queues renders on its answer', async () => {
  const sessionId = 'session-pane-gate-real';
  const real = await streamThreeDeltas({
    sessionId,
    streamId: 'stream-pane-gate-real',
    predicate: paneVisibility.isSessionVisibleInAnyPane,
    label: 'real',
  });
  assert.ok(real.asked.includes(sessionId), `the stream handler asked the pane predicate about ${sessionId}; asked: ${real.asked.join(',')}`);
  assert.ok(real.visibleAnswers.length >= 1, 'the stream queued at least one session render');
  assert.ok(real.visibleAnswers.every((visible) => visible === true), `the real predicate's "visible" reached queueSessionRender: ${JSON.stringify(real.visibleAnswers)}`);

  const neverId = 'session-pane-gate-never';
  const never = await streamThreeDeltas({
    sessionId: neverId,
    streamId: 'stream-pane-gate-never',
    predicate: () => false,
    label: 'never',
  });
  assert.ok(never.asked.includes(neverId), 'the handler still asks when the answer is no');
  assert.ok(never.visibleAnswers.length >= 1, 'the stream still queued session renders (chrome-only) when hidden');
  assert.ok(never.visibleAnswers.every((visible) => visible === false), `a "not visible" answer reached queueSessionRender: ${JSON.stringify(never.visibleAnswers)}`);
});
