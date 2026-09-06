const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');

function project(messages) {
  return projectTurnTree({ messages: normalizeChatMessages(messages) });
}

test('projectTurnTree derives stable turn ids from stream-bound user and assistant messages', () => {
  const result = project([
    { id: 'user_stream_alpha', role: 'user', content: 'Hello' },
    { id: 'assistant_stream_alpha', role: 'assistant', content: 'Hi', streamId: 'stream_alpha' },
    { id: 'user_stream_beta', role: 'user', content: 'Retry' },
  ]);

  assert.deepEqual(result.turns.map((turn) => turn.turn_id), ['stream_alpha', 'stream_beta']);
  assert.equal(result.byMessageId.user_stream_alpha, 'stream_alpha');
  assert.equal(result.byMessageId.assistant_stream_alpha, 'stream_alpha');
  assert.equal(result.byMessageId.user_stream_beta, 'stream_beta');
});

test('projectTurnTree falls back to turn_<index> when no stream or request id is available', () => {
  const result = project([
    { id: 'legacy_prompt', role: 'user', content: 'Legacy prompt' },
    { id: 'legacy_answer', role: 'assistant', content: 'Legacy answer' },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].turn_id, 'turn_0');
  assert.equal(result.byMessageId.legacy_prompt, 'turn_0');
  assert.equal(result.byMessageId.legacy_answer, 'turn_0');
});

test('projectTurnTree preserves approval reasons from persisted tool calls', () => {
  const reason = 'This command can delete or overwrite files (rm). Approve to continue.';
  const result = project([
    { id: 'user_reason', role: 'user', content: 'Remove generated files' },
    {
      id: 'tool_use_reason', role: 'assistant', kind: 'tool_use', streamId: 'stream_reason',
      tool_call: {
        call_id: 'call_reason', tool_name: 'run_command', status: 'pending_approval',
        approval_state: 'pending', parent_stream_id: 'stream_reason', reason,
      },
    },
  ]);
  const events = result.turns[0].events;

  assert.equal(events.find((event) => event.kind === 'tool_use').payload.reason, reason);
  assert.equal(events.find((event) => event.kind === 'approval_requested').payload.reason, reason);
});

test('projectTurnTree emits a system notice event for unknown assistant kinds', () => {
  const result = project([
    { id: 'user_stream_unknown', role: 'user', content: 'Go' },
    { id: 'assistant_stream_unknown', role: 'assistant', kind: 'mystery_kind', content: '???', streamId: 'stream_unknown' },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].events[1].kind, 'system_notice');
  assert.equal(result.turns[0].events[1].payload.subkind, 'unknown_kind');
  assert.equal(result.turns[0].events[1].payload.unknown_kind, 'mystery_kind');
});

test('projectTurnTree preserves assistant error recovery metadata from messages', () => {
  const result = project([
    { id: 'user_error_recovery', role: 'user', content: 'Retry this' },
    {
      id: 'assistant_error_recovery',
      role: 'assistant',
      streamId: 'stream_error_recovery',
      status: 'error',
      stream_error: 'Sidecar exited unexpectedly',
      error_code: 'CMP-SIDECAR-0003',
      retryable: true,
      recovery_class: 'sidecar_transport',
      next_action: 'retry_turn',
      recovery_title: 'Sidecar connection issue',
      recovery_hint: 'Restart the local sidecar, then retry this turn.',
      next_action_label: 'Retry turn',
      recovery_actions: [
        { id: 'retry_turn', label: 'Retry turn' },
        { id: 'restart_sidecar', label: 'Restart sidecar', unsafe: '<script>alert(1)</script>' },
        { id: 'open_diagnostics', label: 'Open diagnostics' },
        { id: '', label: 'Missing id' },
        { id: { unsafe: 'object id' }, label: 'Unsafe id' },
      ],
    },
  ]);

  const errorEvent = result.turns[0].events.find((event) => event.kind === 'assistant_error');

  assert.ok(errorEvent, 'assistant_error event should be projected');
  assert.equal(errorEvent.payload.recovery_class, 'sidecar_transport');
  assert.equal(errorEvent.payload.next_action, 'retry_turn');
  assert.equal(errorEvent.payload.recovery_title, 'Sidecar connection issue');
  assert.equal(errorEvent.payload.recovery_hint, 'Restart the local sidecar, then retry this turn.');
  assert.equal(errorEvent.payload.next_action_label, 'Retry turn');
  assert.deepEqual(
    errorEvent.payload.recovery_actions.map((entry) => entry.id),
    ['retry_turn', 'restart_sidecar', 'open_diagnostics']
  );
  assert.deepEqual(errorEvent.payload.recovery_actions, [
    { id: 'retry_turn', label: 'Retry turn' },
    { id: 'restart_sidecar', label: 'Restart sidecar' },
    { id: 'open_diagnostics', label: 'Open diagnostics' },
  ]);
});

test('projectTurnTree groups legacy reasoning entries into sequential reasoning events when phases are absent', () => {
  const result = project([
    { id: 'user_stream_legacy', role: 'user', content: 'Explain' },
    {
      id: 'assistant_stream_legacy',
      role: 'assistant',
      streamId: 'stream_legacy',
      content: 'Done.',
      reasoning: {
        source: 'provider',
        entries: [
          { id: 'reason_a', text: 'First', thinkingId: 'think_a' },
          { id: 'reason_b', text: 'Second', thinkingId: 'think_b' },
          { id: 'reason_c', text: 'Third', thinkingId: 'think_b' },
        ],
      },
    },
  ]);

  const turn = result.turns[0];
  const reasoningEvents = turn.events.filter((event) => event.kind === 'reasoning_phase');
  assert.deepEqual(
    reasoningEvents.map((event) => [event.phase_id, event.payload.entries.map((entry) => entry.id)]),
    [
      ['legacy_phase_think_a', ['reason_a']],
      ['legacy_phase_think_b', ['reason_b', 'reason_c']],
    ]
  );
});

test('projectTurnTree emits legacy reasoning when only text phases are present (Qwen/GPT-OSS shape)', () => {
  const result = project([
    { id: 'user_mixed_phases', role: 'user', content: 'Think then answer' },
    {
      id: 'assistant_mixed_phases',
      role: 'assistant',
      streamId: 'stream_mixed_phases',
      content: 'Answer.',
      phases: [
        { phase_id: 'text_alpha', phase_kind: 'text' },
      ],
      reasoning: {
        source: 'provider',
        entries: [
          { id: 'reason_x', text: 'Silent think', thinkingId: 'think_x' },
        ],
      },
    },
  ]);

  const turn = result.turns[0];
  const reasoningEvents = turn.events.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 1);
  assert.equal(reasoningEvents[0].phase_id, 'legacy_phase_think_x');
  assert.deepEqual(
    reasoningEvents[0].payload.entries.map((entry) => entry.id),
    ['reason_x']
  );
  assert.equal(reasoningEvents[0].payload.legacy, true);
});

test('projectTurnTree falls back to legacy reasoning when a reasoning phase is empty', () => {
  const result = project([
    { id: 'user_empty_phase', role: 'user', content: 'Think' },
    {
      id: 'assistant_empty_phase',
      role: 'assistant',
      streamId: 'stream_empty_phase',
      content: 'Answered.',
      phases: [
        { phase_id: 'reason_phase_empty', phase_kind: 'reasoning', entries: [] },
      ],
      reasoning: {
        source: 'provider',
        entries: [
          { id: 'reason_y', text: 'Stored here', thinkingId: 'think_y' },
        ],
      },
    },
  ]);

  const turn = result.turns[0];
  const reasoningEvents = turn.events.filter((event) => event.kind === 'reasoning_phase');
  const legacyEvents = reasoningEvents.filter((event) => event.payload.legacy === true);
  assert.equal(legacyEvents.length, 1);
  assert.equal(legacyEvents[0].phase_id, 'legacy_phase_think_y');
  assert.deepEqual(
    legacyEvents[0].payload.entries.map((entry) => entry.id),
    ['reason_y']
  );
});

test('projectTurnTree does not double-emit reasoning when a populated phase already covers it', () => {
  const result = project([
    { id: 'user_populated_phase', role: 'user', content: 'Think hard' },
    {
      id: 'assistant_populated_phase',
      role: 'assistant',
      streamId: 'stream_populated_phase',
      content: 'Answered.',
      phases: [
        {
          phase_id: 'reason_phase_full',
          phase_kind: 'reasoning',
          entries: [
            { id: 'phase_entry', text: 'Phase thought', thinkingId: 'think_phase' },
          ],
        },
      ],
    },
  ]);

  const turn = result.turns[0];
  const reasoningEvents = turn.events.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 1);
  assert.equal(reasoningEvents[0].phase_id, 'reason_phase_full');
  assert.deepEqual(
    reasoningEvents[0].payload.entries.map((entry) => entry.id),
    ['phase_entry']
  );
  assert.notEqual(reasoningEvents[0].payload.legacy, true);
});

test('projectTurnTree preserves complete source message coverage per turn', () => {
  const result = project([
    { id: 'user_stream_tools', role: 'user', content: 'Check this' },
    {
      id: 'tool_use_stream_tools',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_tools',
        tool_name: 'Read',
        parent_stream_id: 'stream_tools',
        status: 'running',
      },
    },
    {
      id: 'tool_result_stream_tools',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_tools',
        tool_name: 'Read',
        output_text: 'done',
        parent_stream_id: 'stream_tools',
      },
    },
    { id: 'assistant_stream_tools', role: 'assistant', streamId: 'stream_tools', content: 'All set' },
  ]);

  assert.deepEqual(
    result.turns[0].source_message_ids,
    [
      'user_stream_tools',
      'tool_use_stream_tools',
      'tool_result_stream_tools',
      'assistant_stream_tools',
    ]
  );
});

test('projectTurnTree preserves only bounded subagent report metadata from message-derived tool results', () => {
  const result = project([
    { id: 'user_stream_subagent', role: 'user', content: 'Delegate this' },
    {
      id: 'tool_result_stream_subagent',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_subagent',
        tool_name: 'sub_agent',
        output_text: '{}',
        parent_stream_id: 'stream_subagent',
        metadata: {
          subagent_report: { call_id: 'call_subagent', status: 'completed' },
          diff: { additions: 99 },
        },
      },
    },
  ]);

  const event = result.turns[0].events.find((entry) => entry.kind === 'tool_result');
  assert.deepEqual(event.payload.metadata, {
    subagent_report: { call_id: 'call_subagent', status: 'completed' },
  });
});

test('projectTurnTree normalizes timed-out and preempted approval outcomes for tool events', () => {
  const result = project([
    { id: 'user_stream_statuses', role: 'user', content: 'Run the tools' },
    {
      id: 'tool_use_timeout_status',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_timeout_status',
        tool_name: 'Read',
        parent_stream_id: 'stream_statuses',
        status: 'timed_out',
        approval_state: 'timed_out',
      },
    },
    {
      id: 'tool_use_preempted_status',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_preempted_status',
        tool_name: 'Write',
        parent_stream_id: 'stream_statuses',
        status: 'preempted',
        approval_state: 'preempted',
      },
    },
  ]);

  const approvalEvents = result.turns[0].events.filter((event) => event.kind === 'approval_resolved');
  assert.deepEqual(
    approvalEvents.map((event) => [event.tool_call_id, event.status, event.payload.approval_state]),
    [
      ['call_timeout_status', 'timed_out', 'timed_out'],
      ['call_preempted_status', 'cancelled', 'cancelled'],
    ]
  );
});

test('projectTurnTree stores adversarial stream and message ids without mutating object prototypes', () => {
  const result = project([
    { id: '__proto__', role: 'user', streamId: '__proto__', content: 'hello' },
    { id: 'assistant_proto', role: 'assistant', streamId: '__proto__', content: 'world' },
  ]);

  assert.equal(Object.getPrototypeOf(result.byTurnId), null);
  assert.equal(Object.getPrototypeOf(result.byMessageId), null);
  assert.equal(result.byTurnId.__proto__.turn_id, '__proto__');
  assert.equal(result.byMessageId.__proto__, '__proto__');
  assert.equal(result.turns[0].turn_id, '__proto__');
});

test('projectTurnTree emits assistant metadata notices before assistant text and keeps assistant errors trailing', () => {
  const result = project([
    { id: 'user_stream_notice_order', role: 'user', content: 'Status update' },
    {
      id: 'assistant_stream_notice_order',
      role: 'assistant',
      streamId: 'stream_notice_order',
      content: 'Here is the latest status.',
      context_compacted: {
        strategy: 'micro',
        tokensBefore: 1200,
        tokensAfter: 400,
      },
      agent_status: {
        taskId: 'task_1',
        status: 'running',
        summary: 'Planning the next steps',
      },
      status: 'error',
      stream_error: 'Tool failed after reply text',
    },
  ]);

  const turn = result.turns[0];
  assert.deepEqual(
    turn.events.map((event) => [
      event.kind,
      event.payload?.subkind || event.payload?.text || event.payload?.stream_error || event.payload?.content || '',
    ]),
    [
      ['user_prompt', 'Status update'],
      ['system_notice', 'context_compacted'],
      ['system_notice', 'agent_status'],
      ['assistant_text_segment', 'Here is the latest status.'],
      ['assistant_error', 'Tool failed after reply text'],
    ]
  );
  assert.deepEqual(
    turn.events
      .filter((event) => event.kind === 'system_notice')
      .map((event) => event.source_message_ids),
    [
      ['assistant_stream_notice_order'],
      ['assistant_stream_notice_order'],
    ]
  );
});

test('projectTurnTree deduplicates identical context notices within one turn without mutating messages', () => {
  const contextCompacted = {
    strategy: 'micro',
    summaryStatus: 'not_applicable',
    reasonCode: 'summary_prefix_unavailable',
    tokensBefore: 4525,
    tokensAfter: 4525,
  };
  const messages = normalizeChatMessages([
    { id: 'user_stream_compact_dedupe', role: 'user', content: 'Continue' },
    {
      id: 'assistant_stream_compact_dedupe_seg0',
      role: 'assistant',
      streamId: 'stream_compact_dedupe',
      context_compacted: { ...contextCompacted },
    },
    {
      id: 'assistant_stream_compact_dedupe_seg1',
      role: 'assistant',
      streamId: 'stream_compact_dedupe',
      context_compacted: { ...contextCompacted },
    },
  ]);

  const result = projectTurnTree({ messages });
  const notices = result.turns[0].events.filter((event) => (
    event.kind === 'system_notice' && event.payload?.subkind === 'context_compacted'
  ));

  assert.equal(notices.length, 1);
  assert.deepEqual(messages[1].context_compacted, contextCompacted);
  assert.deepEqual(messages[2].context_compacted, contextCompacted);
});

test('projectTurnTree keeps differing context notices and never deduplicates across turns', () => {
  const baseNotice = {
    strategy: 'micro',
    summaryStatus: 'not_applicable',
    reasonCode: 'summary_prefix_unavailable',
    tokensBefore: 5000,
    tokensAfter: 4500,
  };
  const result = project([
    { id: 'user_stream_compact_first', role: 'user', content: 'First' },
    {
      id: 'assistant_stream_compact_first_seg0', role: 'assistant', streamId: 'stream_compact_first',
      context_compacted: { ...baseNotice },
    },
    {
      id: 'assistant_stream_compact_first_seg1', role: 'assistant', streamId: 'stream_compact_first',
      context_compacted: { ...baseNotice, tokensAfter: 4000 },
    },
    { id: 'user_stream_compact_second', role: 'user', content: 'Second' },
    {
      id: 'assistant_stream_compact_second', role: 'assistant', streamId: 'stream_compact_second',
      context_compacted: { ...baseNotice },
    },
  ]);

  assert.deepEqual(
    result.turns.map((turn) => turn.events.filter((event) => (
      event.kind === 'system_notice' && event.payload?.subkind === 'context_compacted'
    )).length),
    [2, 1]
  );
});

test('projectTurnTree preserves canonical progress snapshot identity during rehydration', () => {
  const steps = [{
    taskId: 'subagent_run:req:call',
    agentId: 'research@req:call:1',
    parentAgentId: 'main@req',
    status: 'completed',
    stage: 'completed',
    percent: 100,
    terminal: true,
    success: true,
  }];
  const result = project([
    { id: 'user_progress_snapshot', role: 'user', content: 'Inspect the repo' },
    {
      id: 'assistant_progress_snapshot',
      role: 'assistant',
      content: 'Done',
      agent_progress_snapshot: steps,
    },
  ]);

  const progressEvent = result.turns[0].events.find((event) => event.kind === 'agent_progress');
  assert.ok(progressEvent);
  assert.deepEqual(progressEvent.payload.steps, steps);
});

test('projectTurnTree clones tool input payloads so projected events stay mutation-safe', () => {
  const sourceInput = { path: 'plan.md' };
  const result = project([
    { id: 'user_stream_clone_input', role: 'user', content: 'Read the plan' },
    {
      id: 'tool_use_stream_clone_input',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_clone_input',
        tool_name: 'Read',
        parent_stream_id: 'stream_clone_input',
        status: 'requested',
        input: sourceInput,
      },
    },
  ]);

  const toolUseEvent = result.turns[0].events.find((event) => event.kind === 'tool_use');
  assert.ok(toolUseEvent);
  assert.notEqual(toolUseEvent.payload.input, sourceInput);

  toolUseEvent.payload.input.path = 'mutated.md';
  assert.equal(sourceInput.path, 'plan.md');
});

test('projectTurnTree uses event_seq as primary sort key when present, overriding message_index order', () => {
  // Simulate two assistant messages in a turn where the array order (message_index)
  // and the backend-assigned event_seq disagree. The projector must follow event_seq.
  //
  // message_index 0 has event_seq 5  → should sort AFTER the message with event_seq 3
  // message_index 1 has event_seq 3  → should sort BEFORE the message with event_seq 5
  const result = project([
    {
      id: 'user_seq_test',
      role: 'user',
      content: 'go',
      parent_stream_id: 'stream_seq',
    },
    {
      id: 'asst_seq_high',
      role: 'assistant',
      content: 'I came second by seq',
      parent_stream_id: 'stream_seq',
      event_seq: 5,
    },
    {
      id: 'asst_seq_low',
      role: 'assistant',
      content: 'I came first by seq',
      parent_stream_id: 'stream_seq',
      event_seq: 3,
    },
  ]);

  assert.equal(result.turns.length, 1);
  const turn = result.turns[0];
  // Events from the message with event_seq 3 must appear before events from event_seq 5.
  const assistantTextEvents = turn.events.filter((e) => e.kind === 'assistant_text_segment');
  assert.equal(assistantTextEvents.length, 2);
  assert.equal(assistantTextEvents[0].primary_message_id, 'asst_seq_low',
    'event_seq 3 must sort before event_seq 5 regardless of array position');
  assert.equal(assistantTextEvents[1].primary_message_id, 'asst_seq_high');

  // sort_key[0] for the low-seq event must be 3, for the high-seq event must be 5.
  assert.equal(assistantTextEvents[0].sort_key[0], 3);
  assert.equal(assistantTextEvents[1].sort_key[0], 5);
});

test('projectTurnTree hydrates from persisted turn_events when a supported event log is present', () => {
  const result = projectTurnTree({
    messages: normalizeChatMessages([
      { id: 'user_eventlog', role: 'user', content: 'hello', parent_stream_id: 'stream_eventlog' },
      { id: 'assistant_eventlog', role: 'assistant', content: 'ignored legacy text', parent_stream_id: 'stream_eventlog' },
    ]),
    turn_event_log_version: 1,
    turn_events: [
      {
        event_id: 'stream_eventlog:user_prompt:0',
        event_seq: 0,
        turn_id: 'stream_eventlog',
        kind: 'user_prompt',
        primary_message_id: 'user_eventlog',
        source_message_ids: ['user_eventlog'],
        payload: { content: 'hello', attachments: [] },
      },
      {
        event_id: 'stream_eventlog:assistant_text_segment:0',
        event_seq: 1,
        turn_id: 'stream_eventlog',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_eventlog',
        source_message_ids: ['assistant_eventlog'],
        payload: { text: 'hydrated from events', segment_group_index: 0 },
      },
    ],
  });

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].turn_id, 'stream_eventlog');
  assert.equal(result.turns[0].events[1].payload.text, 'hydrated from events');
});

test('projectTurnTree (persisted) claims a reasoning-only segment whose entries the event log already covers', () => {
  // Pre-2026-07-06 recorder mis-retarget shape fossilized in old sessions:
  // seg0 carries a reasoning entry, but the reasoning_phase event referencing
  // that SAME entry id was retargeted onto a sibling segment. Unclaimed, seg0
  // flip-flops between a legacy standalone article and a compat anchor across
  // renders (history blink during streams) and duplicates the reasoning.
  const result = projectTurnTree({
    messages: normalizeChatMessages([
      { id: 'user_stream_covered', role: 'user', content: 'go', parent_stream_id: 'stream_covered' },
      {
        id: 'assistant_stream_covered_seg0',
        role: 'assistant',
        content: '',
        parent_stream_id: 'stream_covered',
        reasoning: { entries: [{ id: 'entry_covered_1', text: 'thinking...', timestamp: 't1' }] },
      },
      { id: 'assistant_stream_covered_seg1', role: 'assistant', content: 'answer', parent_stream_id: 'stream_covered' },
    ]),
    turn_event_log_version: 2,
    turn_events: [
      {
        event_id: 'stream_covered:user_prompt:0',
        event_seq: 0,
        turn_id: 'stream_covered',
        kind: 'user_prompt',
        primary_message_id: 'user_stream_covered',
        source_message_ids: ['user_stream_covered'],
        payload: { content: 'go', attachments: [] },
      },
      {
        event_id: 'stream_covered:reasoning_phase:live:0',
        event_seq: 1,
        turn_id: 'stream_covered',
        kind: 'reasoning_phase',
        // Mis-retargeted: points at seg1, not the seg0 that carries the entry.
        primary_message_id: 'assistant_stream_covered_seg1',
        source_message_ids: ['assistant_stream_covered_seg1'],
        payload: { phase_id: 'phase_r1', entries: [{ id: 'entry_covered_1', text: 'thinking...' }] },
      },
      {
        event_id: 'stream_covered:assistant_text_segment:0',
        event_seq: 2,
        turn_id: 'stream_covered',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_stream_covered_seg1',
        source_message_ids: ['assistant_stream_covered_seg1'],
        payload: { text: 'answer', segment_group_index: 0 },
      },
    ],
  });

  // seg0 joins the turn membership-only (compat anchor), no legacy fallback.
  assert.equal(result.byMessageId['assistant_stream_covered_seg0'], 'stream_covered');
  assert.ok(result.turns[0].source_message_ids.includes('assistant_stream_covered_seg0'));
});

test('projectTurnTree (persisted) leaves a reasoning segment unclaimed when the event log lost its entries', () => {
  // Canary preservation: a reasoning entry the event log does NOT hold means
  // real store damage — the message must stay unclaimed so the legacy
  // fallback renders it (content is not hidden) and the rollout canary fires.
  const result = projectTurnTree({
    messages: normalizeChatMessages([
      { id: 'user_stream_lost', role: 'user', content: 'go', parent_stream_id: 'stream_lost' },
      {
        id: 'assistant_stream_lost_seg0',
        role: 'assistant',
        content: '',
        parent_stream_id: 'stream_lost',
        reasoning: { entries: [{ id: 'entry_lost_1', text: 'lost thinking', timestamp: 't1' }] },
      },
      { id: 'assistant_stream_lost_seg1', role: 'assistant', content: 'answer', parent_stream_id: 'stream_lost' },
    ]),
    turn_event_log_version: 2,
    turn_events: [
      {
        event_id: 'stream_lost:user_prompt:0',
        event_seq: 0,
        turn_id: 'stream_lost',
        kind: 'user_prompt',
        primary_message_id: 'user_stream_lost',
        source_message_ids: ['user_stream_lost'],
        payload: { content: 'go', attachments: [] },
      },
      {
        event_id: 'stream_lost:assistant_text_segment:0',
        event_seq: 1,
        turn_id: 'stream_lost',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_stream_lost_seg1',
        source_message_ids: ['assistant_stream_lost_seg1'],
        payload: { text: 'answer', segment_group_index: 0 },
      },
    ],
  });

  assert.equal(result.byMessageId['assistant_stream_lost_seg0'], undefined);
});

test('projectTurnTree ignores future turn_event_log versions and falls back to messages', () => {
  const input = {
    messages: normalizeChatMessages([
      { id: 'user_future_eventlog', role: 'user', content: 'hello', parent_stream_id: 'stream_future_eventlog' },
      { id: 'assistant_future_eventlog', role: 'assistant', content: 'message fallback wins', parent_stream_id: 'stream_future_eventlog' },
    ]),
    turn_event_log_version: 99,
    turn_events: [
      {
        event_id: 'stream_future_eventlog:assistant_text_segment:0',
        event_seq: 0,
        turn_id: 'stream_future_eventlog',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_future_eventlog',
        source_message_ids: ['assistant_future_eventlog'],
        payload: { text: 'do not use me' },
      },
    ],
  };
  const snapshot = structuredClone(input);
  const result = projectTurnTree(input);

  const assistantTextEvent = result.turns[0].events.find((event) => event.kind === 'assistant_text_segment');
  assert.equal(assistantTextEvent.payload.text, 'message fallback wins');
  assert.deepEqual(input, snapshot);
});

test('projectTurnTree hydrates v4 plan_document events on current builds', () => {
  const result = projectTurnTree({
    messages: [],
    turn_event_log_version: 4,
    turn_events: [{
      event_id: 'stream_plan:plan_document:p:approved', event_seq: 0,
      turn_id: 'stream_plan', kind: 'plan_document',
      primary_message_id: 'plan_document_p', source_message_ids: ['plan_document_p'],
      payload: { plan_id: 'p', transition: 'approved', title: 'Build', steps: ['Ship'] },
    }],
  });
  assert.equal(result.turns[0].events[0].kind, 'plan_document');
  assert.equal(result.turns[0].events[0].payload.transition, 'approved');
});

test('projectTurnTree (persisted) honors an explicit commentary phase even when no tool survives (H-R2a)', () => {
  // A preserved mid-turn commentary segment carries payload.assistant_phase from
  // the canonical capture path. Without honoring it, assignAssistantPhases would
  // re-tag it 'final_answer' (no tool in the turn) and render it as a duplicate
  // final-answer bubble — the orphaned-commentary regression.
  const result = projectTurnTree({
    messages: normalizeChatMessages([
      { id: 'user_keep_commentary', role: 'user', content: 'go', parent_stream_id: 'stream_keep_commentary' },
      { id: 'assistant_keep_commentary', role: 'assistant', content: '', parent_stream_id: 'stream_keep_commentary' },
    ]),
    turn_event_log_version: 2,
    turn_events: [
      {
        event_id: 'stream_keep_commentary:assistant_text_segment:0',
        event_seq: 0,
        turn_id: 'stream_keep_commentary',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_keep_commentary',
        source_message_ids: ['assistant_keep_commentary'],
        payload: { text: 'Let me check that.', assistant_phase: 'commentary', segment_id: 'seg-0' },
      },
      {
        event_id: 'stream_keep_commentary:assistant_text_segment:1',
        event_seq: 1,
        turn_id: 'stream_keep_commentary',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_keep_commentary',
        source_message_ids: ['assistant_keep_commentary'],
        payload: { text: 'Here is the answer.', assistant_phase: 'final_answer', segment_id: 'seg-1' },
      },
    ],
  });

  const segments = result.turns[0].events.filter((event) => event.kind === 'assistant_text_segment');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].assistant_phase, 'commentary');
  assert.equal(segments[1].assistant_phase, 'final_answer');
});

test('projectTurnTree (persisted) still infers final_answer positionally when no explicit phase is stamped (H-R2a fallback)', () => {
  // Legacy/unlabeled events (no payload.assistant_phase) keep the positional
  // inference: no tool in the turn => every text segment is the final answer.
  const result = projectTurnTree({
    messages: normalizeChatMessages([
      { id: 'user_legacy_phase', role: 'user', content: 'go', parent_stream_id: 'stream_legacy_phase' },
      { id: 'assistant_legacy_phase', role: 'assistant', content: '', parent_stream_id: 'stream_legacy_phase' },
    ]),
    turn_event_log_version: 2,
    turn_events: [
      {
        event_id: 'stream_legacy_phase:assistant_text_segment:0',
        event_seq: 0,
        turn_id: 'stream_legacy_phase',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_legacy_phase',
        source_message_ids: ['assistant_legacy_phase'],
        payload: { text: 'First.', segment_id: 'seg-0' },
      },
      {
        event_id: 'stream_legacy_phase:assistant_text_segment:1',
        event_seq: 1,
        turn_id: 'stream_legacy_phase',
        kind: 'assistant_text_segment',
        primary_message_id: 'assistant_legacy_phase',
        source_message_ids: ['assistant_legacy_phase'],
        payload: { text: 'Second.', segment_id: 'seg-1' },
      },
    ],
  });

  const segments = result.turns[0].events.filter((event) => event.kind === 'assistant_text_segment');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].assistant_phase, 'final_answer');
  assert.equal(segments[1].assistant_phase, 'final_answer');
});

// Authoritative-stream adoption: a retried / edit-regenerated turn keeps its
// original user message (id embeds the OLD stream) while the answering
// assistant/tool messages carry the CURRENT stream. The turn must key by the
// answering stream or the projection splits into hydrated/live twins whose
// duplicated rows orphan each other in the render-bucket dedup.
test('projectTurnTree keys a retried turn by the answering stream, not the stale user anchor', () => {
  const result = project([
    { id: 'user_stream_old', role: 'user', content: 'Create the file' },
    { id: 'assistant_stream_new', role: 'assistant', content: 'On it.', streamId: 'stream_new' },
    {
      id: 'tool_use_stream_new_call1',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call1',
        tool_name: 'write_file',
        parent_stream_id: 'stream_new',
        status: 'pending_approval',
      },
    },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].turn_id, 'stream_new');
  assert.equal(result.byMessageId.user_stream_old, 'stream_new');
  assert.equal(result.byMessageId.assistant_stream_new, 'stream_new');
  assert.equal(result.byMessageId.tool_use_stream_new_call1, 'stream_new');
  for (const event of result.turns[0].events) {
    assert.equal(event.turn_id, 'stream_new');
  }
});

test('projectTurnTree adopts the answering stream for an arbitrary retained anchor id', () => {
  const result = project([
    { id: 'msg_user_edit', role: 'user', content: 'Try again' },
    { id: 'assistant_stream_c', role: 'assistant', content: 'Third attempt.', streamId: 'stream_c' },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].turn_id, 'stream_c');
  assert.equal(result.byMessageId.msg_user_edit, 'stream_c');
});

test('projectTurnTree groups a straggler message from the superseded stream into the adopted turn', () => {
  const result = project([
    { id: 'user_stream_old', role: 'user', content: 'Create the file' },
    { id: 'assistant_stream_new', role: 'assistant', content: 'On it.', streamId: 'stream_new' },
    {
      id: 'tool_result_stream_old_stale',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'stale_call',
        tool_name: 'read_file',
        output_text: 'stale',
        parent_stream_id: 'stream_old',
      },
    },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(result.byMessageId.tool_result_stream_old_stale, 'stream_new');
});

test('projectTurnTree keeps the user-derived key for an unanswered tail turn', () => {
  const result = project([
    { id: 'user_stream_a', role: 'user', content: 'First' },
    { id: 'assistant_stream_a', role: 'assistant', content: 'Done.', streamId: 'stream_a' },
    { id: 'user_stream_b', role: 'user', content: 'Second, still sending' },
  ]);

  assert.deepEqual(result.turns.map((turn) => turn.turn_id), ['stream_a', 'stream_b']);
  assert.equal(result.byMessageId.user_stream_b, 'stream_b');
});

test('projectTurnTree adoption stops scanning at the next user message', () => {
  const result = project([
    { id: 'user_stream_old', role: 'user', content: 'Never answered' },
    { id: 'user_stream_b', role: 'user', content: 'Next prompt' },
    { id: 'assistant_stream_b', role: 'assistant', content: 'Answer.', streamId: 'stream_b' },
  ]);

  assert.deepEqual(result.turns.map((turn) => turn.turn_id), ['stream_old', 'stream_b']);
  assert.equal(result.byMessageId.user_stream_old, 'stream_old');
  assert.equal(result.byMessageId.user_stream_b, 'stream_b');
  assert.equal(result.byMessageId.assistant_stream_b, 'stream_b');
});

test('projectTurnTree adoption scans past an interleaved standalone message to the answering stream', () => {
  // Standalone kinds never answer a prompt. If one ever lands between a
  // retained retry anchor and its answer, treating it as a scan boundary
  // would key the anchor by its stale stream — the twin-turn row-loss shape.
  const result = project([
    { id: 'user_stream_old', role: 'user', content: 'Create the file' },
    { id: 'suggestion_1', role: 'assistant', kind: 'proactive_suggestion', content: 'Want a summary too?' },
    { id: 'assistant_stream_new', role: 'assistant', content: 'On it.', streamId: 'stream_new' },
  ]);

  assert.equal(result.byMessageId.user_stream_old, 'stream_new');
  assert.equal(result.byMessageId.assistant_stream_new, 'stream_new');
  assert.notEqual(result.byMessageId.suggestion_1, 'stream_new');
  assert.equal(result.turns.length, 2);
});

test('projectTurnTree adopts an errored attempt stream so the terminal reconcile converges', () => {
  // A retry that errors persists an assistant message with status 'error' on
  // the NEW stream. Adoption must still key the turn by that stream — the
  // live reducer and reconcileLiveTurnWithHydratedRows look the turn up by
  // it, and skipping errored answers would reopen the reconcile-miss delete.
  const result = project([
    { id: 'user_stream_old', role: 'user', content: 'Create the file' },
    {
      id: 'assistant_stream_new',
      role: 'assistant',
      content: '',
      streamId: 'stream_new',
      status: 'error',
      stream_error: 'Local engine is not reachable.',
    },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].turn_id, 'stream_new');
  assert.equal(result.byMessageId.user_stream_old, 'stream_new');
  assert.equal(result.byMessageId.assistant_stream_new, 'stream_new');
});

test('projectTurnTree keeps a durable send-failure card in its anchor turn', () => {
  // buildDurableFailureMessage cards have no stream of their own — the id
  // prefix yields a synthetic failed_* key. The invariant that matters is
  // that the anchor and the card stay in ONE turn (no split articles); the
  // exact key is unspecified.
  const result = project([
    { id: 'user_stream_old', role: 'user', content: 'Create the file' },
    {
      id: 'assistant_failed_1700000000000_ab12cd34',
      role: 'assistant',
      content: '',
      status: 'error',
      stream_error: 'Chat stream failed.',
    },
  ]);

  assert.equal(result.turns.length, 1);
  assert.equal(
    result.byMessageId.user_stream_old,
    result.byMessageId.assistant_failed_1700000000000_ab12cd34
  );
});

test('R2 persisted projection isolates malformed events and keeps later valid events', () => {
  const messages = normalizeChatMessages([
    { id: 'user_r2_mixed', role: 'user', content: 'Continue after malformed input' },
    { id: 'assistant_r2_mixed', role: 'assistant', content: 'Still here', streamId: 'stream_r2_mixed' },
  ]);
  const result = projectTurnTree({
    messages,
    turn_event_log_version: 3,
    turn_events: [
      null,
      'not-an-event',
      { turn_id: '', kind: 'assistant_text_segment' },
      {
        event_id: 'event_r2_user', event_seq: 1, turn_id: 'stream_r2_mixed', kind: 'user_prompt',
        primary_message_id: 'user_r2_mixed', source_message_ids: ['user_r2_mixed'], payload: {},
      },
      {
        event_id: 'event_r2_answer', event_seq: 2, turn_id: 'stream_r2_mixed', kind: 'assistant_text_segment',
        primary_message_id: 'assistant_r2_mixed', source_message_ids: ['assistant_r2_mixed'], payload: { text: 'Still here' },
      },
    ],
  });

  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0].events.map((event) => event.event_id), ['event_r2_user', 'event_r2_answer']);
  assert.equal(result.byMessageId.assistant_r2_mixed, 'stream_r2_mixed');
});
