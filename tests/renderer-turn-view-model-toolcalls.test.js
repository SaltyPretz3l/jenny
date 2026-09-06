// Phase 2A invariant guard for the canonical turn view-model.
//
// This suite pins the row-shape and projection invariants that the forthcoming
// renderer/chat/renderer-turn-view-model.js builder, plus the projector/projection-context/live
// reconciliation consumers, must preserve as Phase 2 lands. It deliberately
// exercises the already-shipped projectTurnRows API because the view-model is a
// distillation of the same semantics; when the builder is introduced in 2B the
// assertions that name row-level invariants should continue to hold.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { buildTurnViewModel } = require('../renderer/chat/renderer-turn-view-model');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');

function buildViewModelFromMessages(messages) {
  const tree = projectTurnTree({ messages: normalizeChatMessages(messages) });
  const turn = tree.turns[0];
  const messageById = new Map();
  const toolMessageIdsByCallId = new Map();
  for (const message of normalizeChatMessages(messages)) {
    const messageId = String(message && message.id || '').trim();
    if (!messageId) continue;
    messageById.set(messageId, message);
    const kind = String(message.kind || '').trim();
    let callId = '';
    if (kind === 'tool_use') callId = String(message.tool_call?.call_id || '').trim();
    else if (kind === 'tool_result') callId = String(message.tool_result?.call_id || '').trim();
    if (!callId) continue;
    const ids = toolMessageIdsByCallId.get(callId) || [];
    if (!ids.includes(messageId)) ids.push(messageId);
    toolMessageIdsByCallId.set(callId, ids);
  }
  return buildTurnViewModel(turn, { messageById, toolMessageIdsByCallId });
}

function event(overrides) {
  return {
    event_id: 'evt',
    event_seq: 0,
    turn_id: 'turn_invariant',
    kind: 'tool_use',
    primary_message_id: 'msg_assistant',
    source_message_ids: ['msg_assistant'],
    tool_call_id: 'call_invariant',
    status: 'completed',
    sort_key: [0, 0, 0],
    payload: {},
    ...overrides,
  };
}

function userPromptEvent(overrides) {
  return event({
    event_id: 'user_prompt:0',
    kind: 'user_prompt',
    primary_message_id: 'msg_user',
    source_message_ids: ['msg_user'],
    tool_call_id: '',
    status: 'completed',
    sort_key: [0, 0, 10],
    payload: { content: 'Hello', attachments: [] },
    ...overrides,
  });
}

function toolUseEvent(overrides) {
  return event({
    event_id: 'tool_use:0',
    kind: 'tool_use',
    primary_message_id: 'msg_tool_use',
    source_message_ids: ['msg_tool_use'],
    tool_call_id: 'call_invariant',
    status: 'completed',
    sort_key: [1, 0, 40],
    payload: { tool_name: 'Read', input: { path: 'README.md' }, input_json: '{"path":"README.md"}' },
    ...overrides,
  });
}

function toolResultEvent(overrides) {
  return event({
    event_id: 'tool_result:0',
    kind: 'tool_result',
    primary_message_id: 'msg_tool_result',
    source_message_ids: ['msg_tool_result'],
    tool_call_id: 'call_invariant',
    status: 'completed',
    sort_key: [1, 2, 60],
    payload: { tool_name: 'Read', output_text: 'contents', is_error: false },
    ...overrides,
  });
}

function approvalRequestedEvent(overrides) {
  return event({
    event_id: 'approval_requested:0',
    kind: 'approval_requested',
    primary_message_id: 'msg_tool_use',
    source_message_ids: ['msg_tool_use'],
    tool_call_id: 'call_invariant',
    status: 'pending_approval',
    sort_key: [1, 1, 45],
    payload: { prompt: 'Approve?', approval_state: 'pending' },
    ...overrides,
  });
}

function approvalResolvedEvent(overrides) {
  return event({
    event_id: 'approval_resolved:0',
    kind: 'approval_resolved',
    primary_message_id: 'msg_tool_use',
    source_message_ids: ['msg_tool_use'],
    tool_call_id: 'call_invariant',
    status: 'approved',
    sort_key: [1, 1, 46],
    payload: { approval_state: 'approved' },
    ...overrides,
  });
}

function assistantTextEvent(overrides) {
  return event({
    event_id: 'assistant_text_segment:0',
    kind: 'assistant_text_segment',
    primary_message_id: 'msg_assistant_text',
    source_message_ids: ['msg_assistant_text'],
    tool_call_id: '',
    status: 'completed',
    assistant_phase: 'final_answer',
    sort_key: [2, 0, 10],
    payload: {
      segment_id: 'seg_0',
      phase_id: 'phase_text_final',
      text: 'Answer',
      message_index: 0,
      segment_index: 0,
    },
    ...overrides,
  });
}

function reasoningEvent(overrides) {
  return event({
    event_id: 'reasoning_phase:0',
    kind: 'reasoning_phase',
    primary_message_id: 'msg_assistant_text',
    source_message_ids: ['msg_assistant_text'],
    tool_call_id: '',
    status: 'completed',
    phase_id: 'phase_reasoning_pre',
    sort_key: [0, 5, 10],
    payload: {
      phase_id: 'phase_reasoning_pre',
      thinking_id: 'think_0',
      entries: [{ id: 'reason_0', text: 'Plan' }],
    },
    ...overrides,
  });
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function rowSignature(row) {
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  return [
    String(row.kind || ''),
    String(row.primary_message_id || ''),
    String(row.tool_call_id || ''),
    String(row.phase_id || ''),
    String(row.assistant_phase || ''),
    String(row.segment_group_index ?? ''),
    String(payload.state || ''),
    String(payload.text || payload.content || ''),
    String(payload.summary || ''),
    String(payload.output_text || ''),
    String(payload.result_summary || ''),
    String(payload.error_code || ''),
    Array.isArray(payload.entries) ? payload.entries.map((entry) => String(entry && entry.text || '')).join('^') : '',
  ].join('|');
}

// --- 1. Row identity stability ---------------------------------------------

test('buildTurnViewModel/toolCalls: produces canonical state completed on a resolved tool lifecycle', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_tool_ok', role: 'user', content: 'Read README' },
    {
      id: 'tool_use_ok',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_ok',
        tool_name: 'Read',
        parent_stream_id: 'stream_ok',
        status: 'completed',
        input: { path: 'README.md' },
      },
    },
    {
      id: 'tool_result_ok',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_ok',
        tool_name: 'Read',
        output_text: 'contents',
        parent_stream_id: 'stream_ok',
      },
    },
  ]);
  assert.equal(viewModel.toolCalls.length, 1);
  const tool = viewModel.toolCalls[0];
  assert.equal(tool.toolCallId, 'call_ok');
  assert.equal(tool.toolName, 'Read');
  assert.equal(tool.state, 'completed');
  assert.equal(tool.rawTerminal, 'completed');
  assert.equal(tool.hasResult, true);
  assert.equal(tool.outputText, 'contents');
});

test('buildTurnViewModel/toolCalls: carries tool_result diff metadata for canonical consumers', () => {
  const viewModel = buildTurnViewModel({
    turn_id: 'turn_diff',
    source_message_ids: ['msg_tool_use', 'msg_tool_result'],
    events: [
      toolUseEvent({
        turn_id: 'turn_diff',
        tool_call_id: 'call_diff',
        status: 'completed',
        payload: {
          tool_name: 'Write',
          input: { file_path: 'src/app.js' },
        },
      }),
      toolResultEvent({
        turn_id: 'turn_diff',
        tool_call_id: 'call_diff',
        status: 'completed',
        payload: {
          tool_name: 'Write',
          output_text: 'Wrote file.',
          is_error: false,
          metadata: {
            diff: {
              additions: 1,
              deletions: 1,
              review_state: 'full',
              hunks: [{
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-old', '+new'],
              }],
            },
          },
        },
      }),
    ],
  });

  assert.equal(viewModel.toolCalls.length, 1);
  const tool = viewModel.toolCalls[0];
  assert.equal(tool.resultMetadata.diff.additions, 1);
  assert.equal(tool.resultMetadata.diff.review_state, 'full');
  assert.deepEqual(tool.resultMetadata.diff.hunks[0].lines, ['-old', '+new']);
});

test('buildTurnViewModel/toolCalls: preempted approval preserves raw substatus while visible state becomes cancelled', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_preempt', role: 'user', content: 'Write' },
    {
      id: 'tool_use_preempt',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_preempt',
        tool_name: 'Write',
        parent_stream_id: 'stream_preempt',
        approval_state: 'preempted',
      },
    },
  ]);
  // The tree projector collapses raw preempted → cancelled at the event layer
  // (via normalizeToolLifecycleStatus). The builder consults the original
  // tool_use message to restore the preempted raw substatus in canonical data.
  const tool = viewModel.toolCalls[0];
  assert.ok(tool);
  assert.equal(tool.state, 'cancelled');
  assert.equal(tool.rawTerminal, 'preempted');
});

test('buildTurnViewModel/toolCalls: timeout approval maps to timed_out visible state and preserves timeout raw substatus', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_timeout', role: 'user', content: 'Run' },
    {
      id: 'tool_use_timeout',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_timeout',
        tool_name: 'Write',
        parent_stream_id: 'stream_timeout',
        approval_state: 'timeout',
      },
    },
  ]);
  const tool = viewModel.toolCalls[0];
  assert.ok(tool);
  assert.equal(tool.state, 'timed_out');
  assert.equal(tool.rawTerminal, 'timeout');
});

test('buildTurnViewModel/toolCalls: errored result wins over prior approval states', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_err', role: 'user', content: 'Read' },
    {
      id: 'tool_use_err',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_err',
        tool_name: 'Read',
        parent_stream_id: 'stream_err',
        status: 'pending_approval',
      },
    },
    {
      id: 'tool_result_err',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_err',
        tool_name: 'Read',
        output_text: 'boom',
        is_error: true,
        error_code: 'E_IO',
        parent_stream_id: 'stream_err',
      },
    },
  ]);
  const tool = viewModel.toolCalls[0];
  assert.ok(tool);
  assert.equal(tool.state, 'errored');
  assert.equal(tool.rawTerminal, 'errored');
  assert.equal(tool.errorCode, 'E_IO');
  assert.equal(tool.resultIsError, true);
});

test('buildTurnViewModel/toolCalls: running tool without result is interrupted with raw substatus interrupted', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_run', role: 'user', content: 'Run' },
    {
      id: 'tool_use_run',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_run',
        tool_name: 'Read',
        parent_stream_id: 'stream_run',
        status: 'running',
      },
    },
  ]);
  const tool = viewModel.toolCalls[0];
  assert.ok(tool);
  assert.equal(tool.state, 'interrupted');
  assert.equal(tool.rawTerminal, 'interrupted');
});

test('buildTurnViewModel/toolCalls: generated artifacts normalize and flow into viewModel.artifacts de-duplicated', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_art', role: 'user', content: 'Make artifact' },
    {
      id: 'tool_use_art',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_art',
        tool_name: 'CreateArtifact',
        parent_stream_id: 'stream_art',
        status: 'completed',
      },
    },
    {
      id: 'tool_result_art',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_art',
        tool_name: 'CreateArtifact',
        output_text: 'created',
        parent_stream_id: 'stream_art',
        generated_artifacts: [{
          artifactId: 'artifact_X',
          fileName: 'x.md',
          displayPath: '.jenny/artifacts/s/x.md',
          absolutePath: 'C:/ws/.jenny/artifacts/s/x.md',
          language: 'markdown',
          sessionId: 's',
        }],
      },
    },
  ]);
  const tool = viewModel.toolCalls[0];
  assert.ok(tool);
  assert.equal(tool.generatedArtifacts.length, 1);
  assert.equal(tool.generatedArtifacts[0].artifact_id, 'artifact_X');
  assert.equal(viewModel.artifacts.length, 1);
  assert.equal(viewModel.artifacts[0].artifact_id, 'artifact_X');
  assert.equal(viewModel.artifacts[0].tool_call_id, 'call_art');
});

