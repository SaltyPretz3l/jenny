'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

const GAP_MS = 6 * 60 * 1000;

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
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function makeStartStreamShell(sessionId, streamId) {
  return {
    // The harness's minimal bootstrap seed predates this production default.
    // Supply the normal getState payload at boot; do not mutate flags through
    // __emitFeaturesChanged after the renderer has initialized.
    features: {
      async getState() {
        return { featureFlags: { turn_activity_envelope: true } };
      },
    },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [buildSession(sessionId)];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId };
      },
    },
  };
}

function installClockOffset(window) {
  const RealDate = window.Date;
  let offsetMs = 0;
  class OffsetDate extends RealDate {
    constructor(...args) {
      if (!args.length) {
        super(RealDate.now() + offsetMs);
        return;
      }
      super(...args);
    }

    static now() {
      return RealDate.now() + offsetMs;
    }
  }
  OffsetDate.parse = RealDate.parse;
  OffsetDate.UTC = RealDate.UTC;
  window.Date = OffsetDate;
  return {
    advance(ms) {
      offsetMs += ms;
    },
  };
}

function messageWithMarker(window, sessionId, marker) {
  const messages = window.__rendererState?.messagesBySession?.get(sessionId) || [];
  return messages.find((message) => String(message?.content || '').includes(marker)) || null;
}

function splitTimelineTextAtDivider(timeline, divider) {
  let before = '';
  let after = '';
  let reachedDivider = false;

  function visit(node) {
    if (node === divider) {
      reachedDivider = true;
      return;
    }
    if (node.nodeType === node.TEXT_NODE) {
      if (reachedDivider) after += node.nodeValue || '';
      else before += node.nodeValue || '';
      return;
    }
    for (const child of node.childNodes || []) {
      visit(child);
    }
  }

  visit(timeline);
  return { before, after, reachedDivider };
}

function assertDividerAnchored(document, window, sessionId, phaseLabel, { expectSeg2 = false } = {}) {
  const timeline = document.getElementById('chatTimeline');
  const dividers = [...timeline.querySelectorAll(
    '.chat-timeline-divider[data-timeline-divider="time-gap"]'
  )];
  assert.equal(
    dividers.length,
    1,
    `${phaseLabel}: expected exactly one time-gap divider in the timeline`
  );

  const divider = dividers[0];
  const postGapMessage = messageWithMarker(window, sessionId, 'seg1-0.');
  assert.ok(postGapMessage, `${phaseLabel}: renderer state has no post-gap seg1 message`);
  assert.equal(
    divider.getAttribute('data-before-message-id'),
    postGapMessage.id,
    `${phaseLabel}: divider does not name the first post-gap continuation segment`
  );

  const split = splitTimelineTextAtDivider(timeline, divider);
  assert.equal(split.reachedDivider, true, `${phaseLabel}: divider was not found while walking the timeline`);
  assert.equal(
    split.before.includes('seg0-0.')
      && !split.before.includes('seg1-0.')
      && split.after.includes('seg1-0.'),
    true,
    `${phaseLabel}: divider not anchored: no seg1 content after divider — coalesced turn card precedes it`
  );

  if (expectSeg2) {
    assert.equal(
      split.after.includes('seg2-0.'),
      true,
      `${phaseLabel}: post-divider content does not include the later seg2 continuation`
    );
    assert.notEqual(
      split.after.trim(),
      '',
      `${phaseLabel}: divider is the last content-bearing element in the timeline`
    );
  }

  const label = String(divider.querySelector('.chat-timeline-divider-label')?.textContent || '').trim();
  assert.match(label, /^\d+ min later$/, `${phaseLabel}: divider label is not a minute-gap label`);
  assert.ok(
    Number.parseInt(label, 10) >= 5,
    `${phaseLabel}: divider label reports a gap below the five-minute threshold`
  );
}

async function recordDividerAssertion(failures, callback) {
  try {
    callback();
  } catch (error) {
    failures.push(error);
  }
}

test('live time-gap divider stays anchored before the post-gap continuation as the turn grows', async (t) => {
  const sessionId = 'session-time-divider-live';
  const streamId = 'stream-time-divider-live';
  const app = await loadRendererApp({
    shell: makeStartStreamShell(sessionId, streamId),
  });
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  const document = window.document;
  const clock = installClockOffset(window);

  document.getElementById('chatInput').value = 'time divider anchor probe';
  document.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);

  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
  let aggregate = '';
  async function emitDeltas(count, label) {
    for (let index = 0; index < count; index += 1) {
      const content = `${label}${index}. `;
      aggregate += content;
      await emit({ type: 'delta', content, aggregate });
      await waitForUi(window, 20);
    }
  }

  await emit({ type: 'started' });
  await emitDeltas(12, 'seg0-');
  await emit({
    type: 'tool_use',
    callId: 'call-pause',
    toolName: 'run_command',
    summary: 'Run the pause probe',
    input: { command: 'echo pause' },
    status: 'running',
  });
  await waitForUi(window, 120);

  clock.advance(GAP_MS);
  await emit({
    type: 'tool_result',
    callId: 'call-pause',
    toolName: 'run_command',
    summary: 'Pause probe complete',
    content: 'pause',
    isError: false,
    durationMs: 4,
  });
  await emitDeltas(12, 'seg1-');
  await waitForUi(window, 160);

  assert.equal(
    document.documentElement.dataset.turnActivityEnvelope,
    'true',
    'live repro requires turn_activity_envelope to be enabled'
  );

  const firstToolMessage = (window.__rendererState.messagesBySession.get(sessionId) || [])
    .find((message) => message?.kind === 'tool_use' && message?.tool_call?.call_id === 'call-pause');
  const firstPostGapMessage = messageWithMarker(window, sessionId, 'seg1-0.');
  assert.ok(firstToolMessage && firstPostGapMessage, 'clock verification messages were not created');
  assert.ok(
    Date.parse(firstPostGapMessage.timestamp) - Date.parse(firstToolMessage.timestamp) >= GAP_MS,
    'post-gap continuation timestamp did not pick up the six-minute harness clock offset'
  );

  const failures = [];
  await recordDividerAssertion(failures, () => {
    assertDividerAnchored(document, window, sessionId, 'after seg1');
  });

  await emit({
    type: 'tool_use',
    callId: 'call-second',
    toolName: 'run_command',
    summary: 'Run the second probe',
    input: { command: 'echo second' },
    status: 'running',
  });
  await waitForUi(window, 80);
  await emit({
    type: 'tool_result',
    callId: 'call-second',
    toolName: 'run_command',
    summary: 'Second probe complete',
    content: 'second',
    isError: false,
    durationMs: 5,
  });
  await emitDeltas(12, 'seg2-');
  await waitForUi(window, 160);
  await recordDividerAssertion(failures, () => {
    assertDividerAnchored(document, window, sessionId, 'after seg2', { expectSeg2: true });
  });

  await emit({
    type: 'complete',
    content: '',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 180);
  await recordDividerAssertion(failures, () => {
    assertDividerAnchored(document, window, sessionId, 'after complete', { expectSeg2: true });
  });

  if (failures.length) {
    throw failures[0];
  }
});

test('hydrated time-gap divider anchors before the persisted post-gap continuation', async (t) => {
  const sessionId = 'session-time-divider-hydrated';
  const stagingSessionId = 'session-time-divider-staging';
  const streamId = 'stream-time-divider-hydrated';
  const t0 = Date.parse('2026-08-31T12:00:00.000Z');
  const at = (offsetMs) => new Date(t0 + offsetMs).toISOString();
  const messages = [
    {
      id: 'user-time-divider-hydrated',
      role: 'user',
      content: 'hydrate the time divider',
      timestamp: at(0),
      status: 'complete',
    },
    {
      id: `assistant_${streamId}`,
      role: 'assistant',
      content: 'seg0-0.',
      timestamp: at(0),
      finalizedAt: at(0),
      status: 'complete',
      streamId,
    },
    {
      id: `tool_use_${streamId}_call-pause`,
      role: 'assistant',
      kind: 'tool_use',
      content: 'Run the pause probe',
      timestamp: at(0),
      finalizedAt: at(0),
      status: 'complete',
      tool_call: {
        call_id: 'call-pause',
        tool_name: 'run_command',
        input: { command: 'echo pause' },
        input_json: JSON.stringify({ command: 'echo pause' }),
        summary: 'Run the pause probe',
        status: 'completed',
        approval_state: 'auto',
        duration_ms: 4,
        parent_stream_id: streamId,
      },
    },
    {
      id: `tool_result_${streamId}_call-pause`,
      role: 'tool',
      kind: 'tool_result',
      content: 'Pause probe complete',
      timestamp: at(GAP_MS),
      finalizedAt: at(GAP_MS),
      status: 'complete',
      tool_result: {
        call_id: 'call-pause',
        tool_name: 'run_command',
        output_text: 'pause',
        summary: 'Pause probe complete',
        is_error: false,
        error_code: '',
        exit_code: 0,
        duration_ms: 4,
        parent_stream_id: streamId,
        generated_artifacts: [],
        trusted_attachment_refs: [],
        metadata: {},
      },
    },
    {
      id: `assistant_${streamId}_seg1`,
      role: 'assistant',
      content: 'seg1-0.',
      timestamp: at(GAP_MS),
      finalizedAt: at(GAP_MS),
      status: 'complete',
      streamId,
    },
  ];
  const turnEvents = [
    {
      event_id: `${streamId}:user_prompt:0`,
      event_seq: 0,
      turn_id: streamId,
      kind: 'user_prompt',
      primary_message_id: 'user-time-divider-hydrated',
      primary_user_message_id: 'user-time-divider-hydrated',
      source_message_ids: ['user-time-divider-hydrated'],
      payload: { content: 'hydrate the time divider' },
    },
    {
      event_id: `${streamId}:assistant_text_segment:0`,
      event_seq: 1,
      turn_id: streamId,
      kind: 'assistant_text_segment',
      status: 'completed',
      primary_message_id: `assistant_${streamId}`,
      primary_assistant_message_id: `assistant_${streamId}`,
      source_message_ids: [`assistant_${streamId}`],
      segment_group_index: 0,
      phase_id: 'phase-time-divider-0',
      payload: {
        segment_id: 'segment-time-divider-0',
        phase_id: 'phase-time-divider-0',
        text: 'seg0-0.',
        segment_index: 0,
      },
    },
    {
      event_id: `${streamId}:tool_use:call-pause`,
      event_seq: 2,
      turn_id: streamId,
      kind: 'tool_use',
      status: 'completed',
      primary_message_id: `tool_use_${streamId}_call-pause`,
      source_message_ids: [`tool_use_${streamId}_call-pause`],
      tool_call_id: 'call-pause',
      payload: {
        tool_name: 'run_command',
        summary: 'Run the pause probe',
        status: 'completed',
      },
    },
    {
      event_id: `${streamId}:tool_result:call-pause`,
      event_seq: 3,
      turn_id: streamId,
      kind: 'tool_result',
      status: 'completed',
      primary_message_id: `tool_use_${streamId}_call-pause`,
      source_message_ids: [
        `tool_use_${streamId}_call-pause`,
        `tool_result_${streamId}_call-pause`,
      ],
      tool_call_id: 'call-pause',
      tool_result_message_id: `tool_result_${streamId}_call-pause`,
      payload: {
        tool_name: 'run_command',
        summary: 'Pause probe complete',
        content: 'pause',
        is_error: false,
      },
    },
    {
      event_id: `${streamId}:assistant_text_segment:1`,
      event_seq: 4,
      turn_id: streamId,
      kind: 'assistant_text_segment',
      status: 'completed',
      primary_message_id: `assistant_${streamId}_seg1`,
      primary_assistant_message_id: `assistant_${streamId}`,
      source_message_ids: [`assistant_${streamId}_seg1`],
      segment_group_index: 1,
      phase_id: 'phase-time-divider-1',
      payload: {
        segment_id: 'segment-time-divider-1',
        phase_id: 'phase-time-divider-1',
        text: 'seg1-0.',
        segment_index: 1,
      },
    },
  ];

  const app = await loadRendererApp({
    shell: {
      // Match the production default at bootstrap for the cold-open path too.
      features: {
        async getState() {
          return { featureFlags: { turn_activity_envelope: true } };
        },
      },
    },
  });
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  shell.__state.sessions = [buildSession(stagingSessionId), buildSession(sessionId)];
  shell.__state.messagesBySession.set(stagingSessionId, []);
  shell.__state.messagesBySession.set(sessionId, messages);
  shell.sessions.getMessages = async (requestedSessionId) => ({
    data: requestedSessionId === sessionId ? messages.map((message) => ({ ...message })) : [],
    turn_event_log_version: 4,
    turn_events: requestedSessionId === sessionId ? turnEvents.map((event) => ({ ...event })) : [],
    active_turn: null,
  });

  await app.reloadRendererApp();
  await waitForUi(window, 80);

  assert.equal(
    window.__rendererState.currentSessionId,
    stagingSessionId,
    'hydration setup must begin on the staging session before switching'
  );

  const sessionRow = window.document.querySelector(
    `.conversation-item[data-session-id="${sessionId}"]`
  );
  assert.ok(sessionRow, 'persisted session did not render in the session list');
  const sessionOpenButton = sessionRow.querySelector('[data-session-open]');
  assert.ok(sessionOpenButton, 'persisted session row has no open control');
  sessionOpenButton.click();
  await waitForUi(window, 180);

  assert.equal(
    window.document.documentElement.dataset.turnActivityEnvelope,
    'true',
    'hydration repro requires turn_activity_envelope to be enabled'
  );
  assertDividerAnchored(
    window.document,
    window,
    sessionId,
    'after hydration'
  );
});
