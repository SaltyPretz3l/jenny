// Segment-boundary render-mode pin (Phase 2 of the chat-timeline consolidation).
//
// The 2026-08-26 owner run, the first honest reading of full_render_reasons
// after 410d074d fixed the instrument, put `no_live_stream:tail_settled` at the
// top of the histogram: 19 of 37 full renders across five turns. It means the
// assistant tail had already FINALIZED while the stream window was still open,
// which sounds impossible until you look at a tool boundary.
//
// renderer-stream-handler-tools.js finalizes the pending assistant message
// (status -> complete) and deletes its pendingStreams entry the moment a tool
// starts, so derived.streamingMessage goes falsy while the turn is very much
// still running. The projection context then reads that as "no active turn"
// (renderer-render-pipeline-projection-context.js), activeTurnRootMessageId
// empties, tryPatchActiveTurnRoot declines at its first guard, and the ladder
// falls all the way through to a WHOLE-TRANSCRIPT repaint -- twice per tool, on
// a turn that may run dozens of them.
//
// tests/renderer-chat-approval-render-mode.test.js deliberately DRAINS this
// window ("the approval's own legitimately structural renders") before it
// measures, so the ratio pin there never saw it. This file measures exactly the
// window that one drops.
//
// The claim is not "no render here" -- a tool row genuinely appears and has to
// be painted. It is that painting it must not cost the whole transcript.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

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
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [buildSession(sessionId)];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId };
      },
    },
  };
}

// take() returns the counters and clears the entry; the next noteDelta
// re-creates it. So consecutive drains read consecutive PHASES, and any phase
// that must be counted has to start with a delta.
function drainRenderCounters(window, streamId) {
  const metrics = window.rendererStreamClientMetricsModule?.getShared?.();
  return (metrics && metrics.take(streamId)) || null;
}

function summarize(counters) {
  if (!counters) {
    return 'no counters';
  }
  return `deltas=${counters.deltas_received} patches=${counters.stream_reveal_patches_applied}`
    + ` full=${counters.full_renders} reasons=${JSON.stringify(counters.full_render_reasons || {})}`;
}

test('a tool boundary does not repaint the whole transcript while the turn is still live', async (t) => {
  const sessionId = 'session-segment-boundary-render-mode';
  const streamId = 'stream-segment-boundary-render-mode';
  const app = await loadRendererApp({
    shell: makeStartStreamShell(sessionId, streamId),
  });
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  const doc = window.document;

  doc.getElementById('chatInput').value = 'segment boundary probe';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);

  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });

  // `aggregate` is CUMULATIVE across the turn (services/backend/tool-loop.js).
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

  /* ── Segment 0. The pending assistant message has to carry real content, or
     the tool boundary SPLICES it out instead of finalizing it and the window
     under test never opens. ── */
  await emitDeltas(12, 'seg0-');
  const baseline = drainRenderCounters(window, streamId);
  assert.ok(baseline, 'segment 0 recorded no render counters — the harness never painted');
  assert.equal(
    baseline.full_render_reasons?.['no_live_stream:tail_settled'] || 0,
    0,
    `plain token deltas charged tail_settled, so the boundary measurement below is not isolated (${summarize(baseline)})`
  );

  /* ── The boundary. One delta first, to re-create the session->stream mapping
     the drain above deleted, so the tool renders land inside the window. ── */
  await emitDeltas(1, 'reopen-');
  await emit({
    type: 'tool_use',
    callId: 'call-boundary',
    toolName: 'run_command',
    summary: 'Run a command',
    input: { command: 'echo hi' },
    status: 'running',
  });
  await waitForUi(window, 80);
  await emit({
    type: 'tool_result',
    callId: 'call-boundary',
    toolName: 'run_command',
    summary: 'Run a command',
    content: 'hi',
    isError: false,
    durationMs: 4,
  });
  await waitForUi(window, 120);

  const boundary = drainRenderCounters(window, streamId);
  assert.ok(boundary, 'the tool boundary recorded no render counters');

  // THE PIN. Measured 2 on the unmodified tree, both from the tool boundary.
  assert.equal(
    boundary.full_render_reasons?.['no_live_stream:tail_settled'] || 0,
    0,
    'a tool boundary rebuilt the whole transcript: the turn is still live, but finalizing the '
    + `segment's assistant message made the ladder read it as settled (${summarize(boundary)})`
  );

  // Guard against a degenerate fix that suppresses the boundary render instead
  // of narrowing it. The tool row still has to reach the DOM by SOME path.
  const painted = boundary.stream_reveal_patches_applied + boundary.full_renders;
  assert.ok(
    painted > 0,
    `the tool boundary painted nothing at all (${summarize(boundary)})`
  );

  /* ── Segment 1. The post-tool text must still patch, so the fix cannot have
     cost the patch path its share. ── */
  await emitDeltas(12, 'seg1-');
  const afterTool = drainRenderCounters(window, streamId);
  assert.ok(afterTool, 'segment 1 recorded no render counters');
  const afterPainted = afterTool.stream_reveal_patches_applied + afterTool.full_renders;
  assert.ok(afterPainted > 0, `segment 1 painted nothing (${summarize(afterTool)})`);
  assert.ok(
    afterTool.full_renders / afterPainted <= 0.25,
    `post-tool token deltas stopped using the patch path (${summarize(afterTool)})`
  );

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 120);
});
