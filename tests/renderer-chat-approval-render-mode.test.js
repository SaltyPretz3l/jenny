// Post-approval render-mode regression pin (chat timeline flicker RCA 2026-08-19).
//
// Symptom (owner report): the chat timeline flickers during a turn, "usually
// after accepting a tool call permission request."
//
// Measured in the app's own per-turn diagnostics (client_timing in
// diagnostics/<date>/<streamId>.json), turns split cleanly in two:
//
//   healthy  1135 deltas / 1144 patches /   14 full renders   (auto-approved tools)
//   degraded  786 deltas /   81 patches /  717 full renders   (approval-gated tools)
//
// and inside a single turn the flip lands exactly at the approval (b7394217:
// 339 patches before, 30 full renders after). Once an approval resolves
// mid-turn the renderer stops taking the stream-reveal patch path and rebuilds
// the WHOLE transcript on every subsequent token delta — that per-token
// rebuild (setTimelineMarkup + virtualizer re-measure at token rate) is the
// flicker.
//
// This file pins the ratio, not the mechanism, so a future refactor that
// reintroduces the degradation by a different route still trips it. The
// full_render_reasons tally names the offending gate when it does.
//
// Conventions mirrored from tests/renderer-chat-stream-repaint.test.js
// (loadRendererApp + shell.__emitChat replay).
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

// take() is the metrics module's own drain: it returns the counters and clears
// the entry, so consecutive calls read consecutive PHASES of one turn. The next
// noteDelta re-creates the entry, which is why each phase below starts with a
// delta.
function drainRenderCounters(window, streamId) {
  const metrics = window.rendererStreamClientMetricsModule?.getShared?.();
  return (metrics && metrics.take(streamId)) || null;
}

// Healthy turns measured 1-5% full renders; degraded turns 80-95%. 25% sits far
// outside both bands, so this fails loudly on the regression without being
// brittle about the handful of genuinely structural frames (segment boundaries,
// tool row settle) that ride along.
const MAX_FULL_RENDER_SHARE = 0.25;

function assertPatchPathDominates(counters, what) {
  assert.ok(counters, `${what} — no render counters were recorded`);
  const painted = counters.stream_reveal_patches_applied + counters.full_renders;
  assert.ok(painted > 0, `${what} — nothing painted (${summarize(counters)})`);
  const fullShare = counters.full_renders / painted;
  assert.ok(
    fullShare <= MAX_FULL_RENDER_SHARE,
    `${what} — ${Math.round(fullShare * 100)}% full renders (${summarize(counters)})`
  );
}

function summarize(counters) {
  if (!counters) {
    return 'no counters';
  }
  return `deltas=${counters.deltas_received} patches=${counters.stream_reveal_patches_applied}`
    + ` full=${counters.full_renders} reasons=${JSON.stringify(counters.full_render_reasons || {})}`;
}

test('a mid-turn tool approval does not degrade the timeline to a full render per token delta', async (t) => {
  const sessionId = 'session-approval-render-mode';
  const streamId = 'stream-approval-render-mode';
  const app = await loadRendererApp({
    shell: makeStartStreamShell(sessionId, streamId),
  });
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  const doc = window.document;

  doc.getElementById('chatInput').value = 'approval render-mode probe';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);

  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });

  // `aggregate` is CUMULATIVE across the turn (services/backend/tool-loop.js),
  // so every delta carries the monotonic prefix.
  let aggregate = '';
  // One settle per delta: the render queue coalesces bursts, and a burst that
  // paints once tells us nothing about which path each delta took. Real turns
  // paint ~once per delta (1135 deltas / 1144 patches on a healthy turn), so
  // the replay has to give each delta its own frame to be comparable.
  async function emitDeltas(count, label) {
    for (let index = 0; index < count; index += 1) {
      const content = `${label}${index}. `;
      aggregate += content;
      await emit({ type: 'delta', content, aggregate });
      await waitForUi(window, 20);
    }
  }

  await emit({ type: 'started' });

  /* ── Phase A: baseline. Plain token deltas, no tool, no approval. ── */
  await emitDeltas(20, 'before');
  // Control: without an approval the patch path must dominate. If this fails
  // the harness itself cannot patch and the phase B pin below is meaningless.
  assertPatchPathDominates(
    drainRenderCounters(window, streamId),
    'baseline deltas (no approval) must use the patch path'
  );

  /* ── Phase B: the approval cycle, then more token deltas. ── */
  await emit({
    type: 'tool_use',
    callId: 'call-1',
    toolName: 'run_command',
    summary: 'Run a command',
    input: { command: 'echo hi' },
    status: 'pending_approval',
    approvalId: 'approval-1',
  });
  await emit({
    type: 'tool_approval_needed',
    callId: 'call-1',
    approvalId: 'approval-1',
    toolName: 'run_command',
    summary: 'Run a command',
    input: { command: 'echo hi' },
    policyScope: 'session',
    policyConsequence: 'runs a shell command',
  });
  await waitForUi(window, 80);

  // The user accepts: the tool leaves pending_approval and executes.
  await emit({
    type: 'tool_use',
    callId: 'call-1',
    toolName: 'run_command',
    summary: 'Run a command',
    input: { command: 'echo hi' },
    status: 'running',
    approvalId: 'approval-1',
    approvalState: 'approved',
  });
  await emit({
    type: 'tool_result',
    callId: 'call-1',
    toolName: 'run_command',
    summary: 'Run a command',
    content: 'hi',
    isError: false,
    durationMs: 4,
  });
  await waitForUi(window, 100);

  // Drain the approval's own (legitimately structural) renders so the
  // measurement below covers only post-approval TOKEN deltas.
  drainRenderCounters(window, streamId);

  await emitDeltas(20, 'after');

  // The pin.
  assertPatchPathDominates(
    drainRenderCounters(window, streamId),
    'post-approval token deltas must keep using the stream-reveal patch path, not rebuild the transcript per delta'
  );

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 120);
});
