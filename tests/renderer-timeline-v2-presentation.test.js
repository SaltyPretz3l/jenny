const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTimelineV2Presentation,
  compactText,
  phaseLabel,
  presenceForPhase,
  toolNameLabel,
  TERMINAL_STATES,
  APPROVAL_STATES,
  isPendingApprovalState,
  terminalPhaseForStatus,
} = require('../renderer/chat/renderer-timeline-v2-presentation');

test('timeline v2 presentation normalizes tool calls with mixed key casing', () => {
  const presentation = buildTimelineV2Presentation({
    kind: 'tool_call',
    toolCallId: 'call_read_raw',
    payload: {
      toolName: 'read_file',
      inputSummary: 'Read README.md before touching renderer code',
      state: 'running',
    },
  }, { surface: 'transcript' });

  assert.equal(presentation.kind, 'tool_call');
  assert.equal(presentation.label, 'Read File');
  assert.equal(presentation.summary, 'Read README.md before touching renderer code');
  assert.equal(presentation.tone, 'active');
  assert.equal(presentation.state, 'running');
  assert.deepEqual(presentation.target, {
    kind: 'tool',
    callId: 'call_read_raw',
    artifactId: '',
  });
  assert.equal(presentation.attrs.rowKind, 'tool_call');
  assert.equal(presentation.attrs.targetKind, 'tool');
});

test('timeline v2 presentation caps summaries by surface', () => {
  const longSummary = [
    'This summary is intentionally long so the transcript and deck surfaces each clamp',
    'at the cap owned by the shared Timeline V2 presentation helper instead of reimplementing caps.',
  ].join(' ');

  const transcript = buildTimelineV2Presentation({
    kind: 'tool_step',
    payload: { tool_name: 'search_files', summary: longSummary, state: 'running' },
  }, { surface: 'transcript' });
  const deck = buildTimelineV2Presentation({
    kind: 'tool_step',
    payload: { tool_name: 'search_files', summary: longSummary, state: 'running' },
  }, { surface: 'deck' });

  assert.equal(transcript.summary.length <= 160, true);
  assert.equal(deck.summary.length <= 140, true);
  assert.match(transcript.summary, /\.\.\.$/);
  assert.match(deck.summary, /\.\.\.$/);
});

test('timeline v2 presentation handles approvals, results, artifacts, and malformed input', () => {
  const approval = buildTimelineV2Presentation({
    kind: 'approval_gap',
    tool_call_id: 'call_write',
    payload: {
      tool_name: 'write_file',
      prompt: 'Approve writing the plan update?',
      state: 'awaiting_approval',
    },
  }, { surface: 'deck' });

  assert.equal(approval.kind, 'approval_gap');
  assert.equal(approval.label, 'Write File');
  assert.equal(approval.summary, 'Approve writing the plan update?');
  assert.equal(approval.tone, 'warning');
  assert.deepEqual(approval.target, {
    kind: 'approval',
    callId: 'call_write',
    artifactId: '',
  });

  const result = buildTimelineV2Presentation({
    kind: 'tool_result',
    payload: {
      tool_call_id: 'call_write',
      tool_name: 'write_file',
      state: 'completed',
      result_summary: '',
      generated_artifacts: [{
        artifact_id: 'artifact_plan',
        title: 'plan.md',
      }],
    },
  }, { surface: 'transcript' });

  assert.equal(result.label, 'Write File');
  assert.equal(result.summary, 'plan.md');
  assert.equal(result.tone, 'success');
  assert.equal(result.target.kind, 'tool');
  assert.equal(result.target.artifactId, 'artifact_plan');

  const errorResult = buildTimelineV2Presentation({
    kind: 'tool_result',
    payload: {
      tool_call_id: 'call_error',
      tool_name: 'read_file',
      state: 'completed',
      result_summary: 'Read failed',
      result_is_error: true,
    },
  }, { surface: 'transcript' });

  assert.equal(errorResult.summary, 'Read failed');
  assert.equal(errorResult.tone, 'danger');

  assert.deepEqual(buildTimelineV2Presentation(null, { surface: 'transcript' }), {
    kind: 'unknown',
    label: '',
    summary: '',
    tone: 'neutral',
    state: '',
    target: { kind: 'none', callId: '', artifactId: '' },
    attrs: {
      rowKind: 'unknown',
      tone: 'neutral',
      state: '',
      targetKind: 'none',
    },
  });
});

test('timeline v2 presentation exports the active-turn label helpers', () => {
  assert.equal(compactText('  A   spaced   note  ', 20), 'A spaced note');
  assert.equal(toolNameLabel('request_approval'), 'Request Approval');
  assert.equal(phaseLabel('tool_result'), 'Reading Results');
});

test('timeline v2 presentation exposes terminal and pending-approval classifiers', () => {
  for (const status of ['timeout', 'timed_out', 'denied', 'failed']) {
    assert.equal(TERMINAL_STATES.has(status), true, status);
    assert.equal(terminalPhaseForStatus(status), 'error', status);
  }

  assert.equal(terminalPhaseForStatus('preempted'), 'interrupted');
  assert.equal(terminalPhaseForStatus('cancelled'), 'cancelled');
  assert.equal(terminalPhaseForStatus('interrupted'), 'interrupted');
  assert.equal(isPendingApprovalState('awaiting_approval'), true);
  assert.equal(isPendingApprovalState('pending_approval'), true);
  assert.equal(isPendingApprovalState('pending'), true);
  assert.equal(isPendingApprovalState('denied'), false);
  assert.equal(isPendingApprovalState('timed_out'), false);
  assert.equal(isPendingApprovalState('cancelled'), false);
  assert.equal(APPROVAL_STATES.has('denied'), false);

  assert.equal(phaseLabel('timeout'), 'Timed Out');
  assert.equal(phaseLabel('preempted'), 'Preempted');
  assert.equal(presenceForPhase('denied'), 'recovery');
});
