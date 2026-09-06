// Regression: multi-segment turns blank already-streamed text while a later
// segment streams (2026-07-17).
//
// Owner repro: model reasons and states it will start the task -> the backend
// runs a tool and emits stream_reset (reason tool_continuation, aggregate
// resets) -> a fresh segment starts streaming -> the earlier segment's
// reasoning + text vanish from the timeline and only pop back at the next
// settle point (approval prompt / terminal reconcile).
//
// Root cause: isStreamingRow's last-resort fallback
// (renderer-turn-row-render-utils.js) marked EVERY assistant_text row as "the
// streaming row" whenever the turn was streaming, and a streaming-marked text
// row renders the live stream's reveal units instead of its own payload text.
// Correct for single-segment turns (the only text row IS the streaming one);
// on multi-segment turns every settled segment's bubble was replaced by the
// live segment's content — prior text disappeared, current text duplicated.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlags } = require('../services/feature-flags');

const REASON_1 = 'ReasonBlockOne unique marker';
const STATEMENT = 'StatementText I will start the task now unique marker.';
const REASON_2 = 'ReasonBlockTwo unique marker';
const REASON_3 = 'ReasonBlockThree unique marker';
const FINAL = 'FinalAnswer unique marker.';

function makeShell(sessionId) {
  let stateRef = null;
  return {
    shell: {
      tools: {
        async approve() { return { ok: true, status: 'approved' }; },
        async deny() { return { ok: true, status: 'denied' }; },
      },
      sessions: {
        async getMessages() {
          const local = (stateRef && stateRef.messagesBySession.get(sessionId)) || [];
          return { data: local.map((m) => ({ ...m })) };
        },
      },
      chat: {
        async startStream(_payload, { state }) {
          stateRef = state;
          state.sessions = [{
            id: sessionId,
            title: 'S',
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
          }];
          if (!state.messagesBySession.has(sessionId)) {
            state.messagesBySession.set(sessionId, []);
          }
          return { sessionId, streamId: 'stream-seg-blank-1' };
        },
      },
    },
  };
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('multi-segment turn keeps earlier segments visible while a later segment streams', async (t) => {
  const sessionId = 'sess-seg-blank';
  const rig = makeShell(sessionId);
  const app = await loadRendererApp({ shell: rig.shell });
  t.after(async () => { await app.dispose(); });
  const { window, shell } = app;
  await shell.__emitFeaturesChanged({ featureFlags: { ...buildFeatureFlags({}) } });
  await waitForUi(window, 30);
  const doc = window.document;
  doc.getElementById('chatInput').value = 'Create a file called notes/narrative-demo.md';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  const streamId = 'stream-seg-blank-1';
  const emit = (p) => shell.__emitChat({ sessionId, streamId, ...p });
  const timelineHtml = () => doc.getElementById('chatTimeline').innerHTML;

  await emit({ type: 'started' });
  await emit({
    type: 'delta',
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: REASON_1 }] },
  });
  await emit({ type: 'delta', content: `${STATEMENT} `, aggregate: `${STATEMENT} ` });
  await waitForUi(window, 300);
  assert.equal(timelineHtml().includes(STATEMENT), true, 'segment-0 text must stream in');

  // Auto tool + the backend's tool-continuation reset (aggregate restarts).
  await emit({
    type: 'tool_use',
    callId: 'call-read',
    toolName: 'read_file',
    summary: 'Read notes/read-target.md',
    input: { path: 'notes/read-target.md' },
    status: 'running',
  });
  await emit({
    type: 'tool_result',
    callId: 'call-read',
    toolName: 'read_file',
    content: 'file not found',
    summary: 'file not found',
    isError: true,
    durationMs: 4,
  });
  await emit({ type: 'stream_reset', reason: 'tool_continuation' });
  await emit({
    type: 'delta',
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r2', text: REASON_2 }] },
  });
  await waitForUi(window, 300);
  {
    const html = timelineHtml();
    assert.equal(html.includes(STATEMENT), true, 'segment-0 text must survive the tool continuation');
    assert.equal(html.includes(REASON_1), true, 'segment-0 reasoning must survive the tool continuation');
  }

  // Approval pause on the second tool.
  await emit({
    type: 'tool_use',
    callId: 'call-write',
    toolName: 'write_file',
    summary: 'Write notes/narrative-demo.md',
    input: { path: 'notes/narrative-demo.md' },
    status: 'pending_approval',
  });
  await emit({
    type: 'tool_approval_needed',
    callId: 'call-write',
    approvalId: 'approval-1',
    toolName: 'write_file',
    input: { path: 'notes/narrative-demo.md' },
  });
  await waitForUi(window, 500);
  const allowBtn = doc.getElementById('chatTimeline').querySelector('.tool-approve-btn');
  assert.ok(allowBtn, 'approval block must render');
  allowBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitForUi(window, 300);

  await emit({
    type: 'tool_use',
    callId: 'call-write',
    toolName: 'write_file',
    summary: 'Write notes/narrative-demo.md',
    input: { path: 'notes/narrative-demo.md' },
    status: 'approved',
  });
  await emit({
    type: 'tool_result',
    callId: 'call-write',
    toolName: 'write_file',
    content: 'Wrote notes/narrative-demo.md',
    summary: 'Wrote notes/narrative-demo.md',
    isError: false,
    approvalState: 'approved',
    durationMs: 20,
  });
  await emit({ type: 'stream_reset', reason: 'tool_continuation' });
  await emit({
    type: 'delta',
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r3', text: REASON_3 }] },
  });
  await waitForUi(window, 300);
  assert.equal(timelineHtml().includes(STATEMENT), true, 'segment-0 text must survive the post-approval continuation');

  // The owner-visible failure: while the FINAL segment streams its text, the
  // earlier segment's text vanished and the streaming content multiplied.
  await emit({ type: 'delta', content: FINAL, aggregate: FINAL });
  await waitForUi(window, 400);
  {
    const html = timelineHtml();
    assert.equal(
      html.includes(STATEMENT),
      true,
      'segment-0 text must stay visible while the final segment streams'
    );
    assert.equal(html.includes(FINAL), true, 'the streaming final segment must render');
    assert.equal(
      countOccurrences(html, FINAL),
      1,
      'the streaming text must render exactly once (settled rows must not mirror the live stream)'
    );
    // 2026-07-17 vanish RCA: presence is not enough — the live segment must
    // render at its canonical position (bottom of the turn), not hoisted to
    // the turn top with the settled interleave shoved below the fold. The
    // mid-stream order must already match the settled order.
    const posReason1 = html.indexOf(REASON_1);
    const posStatement = html.indexOf(STATEMENT);
    const posReason3 = html.indexOf(REASON_3);
    const posFinal = html.indexOf(FINAL);
    assert.ok(
      posReason1 !== -1 && posReason1 < posStatement,
      'segment-0 reasoning must render before segment-0 text mid-stream'
    );
    assert.ok(
      posStatement < posReason3,
      'the live reasoning must render AFTER the settled segment-0 text (not hoisted to the turn top)'
    );
    assert.ok(
      posReason3 < posFinal,
      'the live streaming text must render under the live reasoning block'
    );
  }

  await emit({ type: 'complete', content: `${STATEMENT} ${FINAL}` });
  await waitForUi(window, 700);
  {
    const html = timelineHtml();
    assert.equal(html.includes(STATEMENT), true, 'segment-0 text must render after settle');
    assert.equal(html.includes(FINAL), true, 'final text must render after settle');
    assert.equal(html.includes(REASON_1), true, 'segment-0 reasoning must render after settle');
  }
});
