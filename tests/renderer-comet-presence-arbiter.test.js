const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCometPresenceArbiter,
} = require('../renderer/features/renderer-comet-presence-arbiter');
const { createManualScheduler } = require('./helpers/manual-scheduler');

function createHarness(overrides = {}) {
  const scheduler = createManualScheduler();
  const calls = {
    presence: [],
    overlay: [],
    sentiment: [],
  };
  const arbiter = createCometPresenceArbiter({
    now: scheduler.now,
    scheduler,
    isVisibleSession: overrides.isVisibleSession || (() => true),
    applyPresence(payload) {
      calls.presence.push({ ...payload });
    },
    forwardOverlay(payload) {
      calls.overlay.push({ ...payload });
    },
    applySentiment(expression) {
      calls.sentiment.push(expression);
    },
  });
  return { arbiter, calls, scheduler };
}

test('stream presence suppresses delayed thinking-indicator terminal updates until stream terminal arrives', () => {
  const { arbiter, calls, scheduler } = createHarness();

  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-1',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 1);
  assert.equal(calls.presence[0].state, 'responding');

  arbiter.submitPresence({
    source: 'indicator',
    type: 'done',
    state: 'happy',
    terminalStatus: 'completed',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 1);

  arbiter.submitPresence({
    source: 'stream',
    type: 'complete',
    streamId: 'stream-1',
    sessionId: 'session-1',
    state: 'happy',
    terminalStatus: 'completed',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 2);
  assert.equal(calls.presence[1].state, 'happy');
  assert.equal(calls.overlay[1].terminalStatus, 'completed');
});

test('approval alert holds against stale lower-priority thinking updates', () => {
  const { arbiter, calls, scheduler } = createHarness();

  arbiter.submitPresence({
    source: 'stream',
    type: 'tool_approval_needed',
    streamId: 'stream-approval',
    sessionId: 'session-1',
    state: 'alert',
    phaseKind: 'approval_wait',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence[0].state, 'alert');

  scheduler.advanceBy(200);
  arbiter.submitPresence({
    source: 'indicator',
    type: 'thinking',
    state: 'thinking',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 1);

  scheduler.advanceBy(800);
  arbiter.submitPresence({
    source: 'stream',
    type: 'complete',
    streamId: 'stream-approval',
    sessionId: 'session-1',
    state: 'happy',
    terminalStatus: 'completed',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 2);
  assert.equal(calls.presence[1].state, 'happy');
});

test('presence events are deduped and coalesced to one frame application', () => {
  const { arbiter, calls, scheduler } = createHarness();

  arbiter.submitPresence({
    source: 'stream',
    type: 'phase_started',
    streamId: 'stream-2',
    sessionId: 'session-1',
    state: 'thinking',
    phaseKind: 'reasoning',
  });
  arbiter.submitPresence({
    source: 'stream',
    type: 'phase_started',
    streamId: 'stream-2',
    sessionId: 'session-1',
    state: 'thinking',
    phaseKind: 'reasoning',
  });
  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-2',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  });

  assert.equal(calls.presence.length, 0);
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 1);
  assert.equal(calls.presence[0].state, 'responding');
});

test('send-start user action enters sending without alerting and only while idle', () => {
  const { arbiter, calls, scheduler } = createHarness();

  assert.equal(arbiter.submitUserAction('new-message', { sessionId: 'session-1' }), true);
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 1);
  assert.equal(calls.presence[0].state, 'sending');

  assert.equal(arbiter.submitUserAction('new-message', { sessionId: 'session-1' }), false);
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 1);
});

test('tool-use priority holds against lower stream updates until terminal cleanup', () => {
  const { arbiter, calls, scheduler } = createHarness();

  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-tool',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence[0].state, 'responding');

  scheduler.advanceBy(300);
  arbiter.submitPresence({
    source: 'stream',
    type: 'tool_use',
    streamId: 'stream-tool',
    sessionId: 'session-1',
    state: 'tool-use',
    phaseKind: 'tool_use',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence[1].state, 'tool-use');

  scheduler.advanceBy(100);
  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-tool',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 2);

  arbiter.submitPresence({
    source: 'stream',
    type: 'complete',
    streamId: 'stream-tool',
    sessionId: 'session-1',
    state: 'happy',
    terminalStatus: 'completed',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.length, 3);
  assert.equal(calls.presence[2].state, 'happy');
});

test('background stream presence is suppressed before in-app and overlay application', () => {
  const { arbiter, calls, scheduler } = createHarness({
    isVisibleSession: (sessionId) => sessionId !== 'hidden-session',
  });

  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-hidden',
    sessionId: 'hidden-session',
    state: 'responding',
    phaseKind: 'text',
  });
  scheduler.drainFrame();

  assert.deepEqual(calls.presence, []);
  assert.deepEqual(calls.overlay, []);
});

test('terminal cleanup for an accepted stream still lands after the session becomes hidden', () => {
  let visible = true;
  const { arbiter, calls, scheduler } = createHarness({
    isVisibleSession: () => visible,
  });

  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-accepted',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.at(-1).state, 'responding');

  visible = false;
  arbiter.submitPresence({
    source: 'stream',
    type: 'complete',
    streamId: 'stream-accepted',
    sessionId: 'session-1',
    state: 'happy',
    terminalStatus: 'completed',
  });
  scheduler.drainFrame();

  assert.equal(calls.presence.at(-1).state, 'happy');
  assert.equal(calls.overlay.at(-1).terminalStatus, 'completed');
  assert.equal(arbiter.submitPresence({
    source: 'indicator',
    type: 'done',
    state: 'happy',
    terminalStatus: 'completed',
  }), true, 'terminal indicator is no longer blocked by an active stream');
});

test('terminal cleanup does not become a long-lived blocker for the next send', () => {
  const { arbiter, calls, scheduler } = createHarness();

  arbiter.submitPresence({
    source: 'stream',
    type: 'complete',
    streamId: 'stream-done',
    sessionId: 'session-1',
    state: 'happy',
    terminalStatus: 'completed',
  });
  scheduler.drainFrame();
  assert.equal(calls.presence.at(-1).state, 'happy');

  assert.equal(arbiter.submitPresence({
    source: 'indicator',
    type: 'thinking',
    state: 'thinking',
  }), false);
  assert.equal(arbiter.submitUserAction('new-message', { sessionId: 'session-1' }), true);
  scheduler.drainFrame();

  assert.equal(calls.presence.at(-1).state, 'sending');
});

test('sentiment transients apply only while accepted presence is idle', () => {
  const { arbiter, calls, scheduler } = createHarness();

  assert.equal(arbiter.submitSentiment('warm'), true);
  assert.deepEqual(calls.sentiment, ['warm']);

  arbiter.submitUserAction('new-message', { sessionId: 'session-1' });
  scheduler.drainFrame();
  assert.equal(calls.presence.at(-1).state, 'sending');

  assert.equal(arbiter.submitSentiment('happy'), false);
  assert.deepEqual(calls.sentiment, ['warm']);
});

test('dedupe cache evicts its oldest entry after 128 signatures', () => {
  const { arbiter } = createHarness();

  for (let index = 0; index < 140; index += 1) {
    arbiter.submitPresence({
      source: 'stream',
      type: 'delta',
      streamId: `stream-${index}`,
      sessionId: 'session-1',
      state: 'responding',
      phaseKind: 'text',
    });
  }

  assert.equal(arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-139',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  }), false, 'newest signature remains retained');
  assert.equal(arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-0',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  }), true, 'oldest signature was evicted');
});

test('dedupe signature bounds oversized terminal subcodes', () => {
  const { arbiter, calls, scheduler } = createHarness();
  const longPrefix = 'x'.repeat(80);

  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-long-subcode',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
    terminalSubcode: `${longPrefix}A`,
  });
  scheduler.drainFrame();
  scheduler.advanceBy(300);
  arbiter.submitPresence({
    source: 'stream',
    type: 'delta',
    streamId: 'stream-long-subcode',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
    terminalSubcode: `${longPrefix}B`,
  });
  scheduler.drainFrame();

  assert.equal(calls.presence.length, 1);
});
