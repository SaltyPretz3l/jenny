'use strict';

const {
  canonical,
  finishTurn,
  notify,
  runMultiTokenTurn,
  runReasoningTurn,
  runTextTurn,
  runToolTurn,
} = require('./canonical-turn-scenarios');
const {
  buildScopedApprovalId,
} = require('../../../services/backend/chat-stream-tool-payload-utils');

function contentText(content, key, fallback) {
  const value = content && typeof content === 'object' ? content[key] : undefined;
  return typeof value === 'string' ? value : fallback;
}

function emitCanonicalToolEvent(turn, seq, type, callId, payload) {
  notify(
    turn.runtime,
    'turn.event',
    canonical(turn, seq, type, payload, { tool_call_id: callId }),
    turn.context
  );
}

function emitLegacyToolExecuting(turn, callId, toolName, toolInput) {
  notify(turn.runtime, 'tool.executing', {
    tool_call_id: callId,
    tool_name: toolName,
    tool_input: toolInput,
  }, turn.context);
}

function emitLegacyToolResult(turn, callId, toolName, toolInput, {
  outputText,
  success,
  errorCode,
}) {
  notify(turn.runtime, 'tool.result', {
    tool_call_id: callId,
    tool_name: toolName,
    tool_input: toolInput,
    output: outputText,
    summary: 'Inspect Harness',
    success,
    duration_ms: 2,
    ...(errorCode ? { error_code: errorCode } : {}),
  }, turn.context);
}

function emitPairedText(turn, { deltaSeq, completedSeq, legacySequence, text }) {
  notify(turn.runtime, 'turn.event', canonical(turn, deltaSeq, 'text_delta', {
    delta: text,
  }), turn.context);
  notify(turn.runtime, 'chat.token', {
    delta: text,
    sequence: legacySequence,
  }, turn.context);
  notify(turn.runtime, 'turn.event', canonical(turn, completedSeq, 'text_part_completed', {
    text,
  }), turn.context);
}

async function runApprovalTurn(turn, { content } = {}) {
  const callId = `${turn.streamId}-approval-tool`;
  const toolName = 'write_file';
  const toolInput = { path: 'notes.txt', content: 'approved' };
  const toolOutput = contentText(content, 'toolOutput', 'wrote notes.txt');
  const answer = contentText(content, 'answer', 'Approved tool complete.');
  const approvalId = buildScopedApprovalId({
    sessionId: turn.sessionId,
    streamId: turn.streamId,
    callId,
  });
  emitCanonicalToolEvent(turn, 1, 'tool_call_requested', callId, {
    tool_name: toolName,
    tool_input: toolInput,
  });
  const approvalPromise = notify(turn.runtime, 'tool.request_approval', {
    tool_call_id: callId,
    tool_name: toolName,
    tool_input: toolInput,
  }, turn.context);
  emitCanonicalToolEvent(turn, 2, 'tool_approval_requested', callId, {
    approval_id: approvalId,
    approval_state: 'pending',
    tool_name: toolName,
    summary: 'Write File',
  });
  if (approvalPromise) {
    const pending = [...turn.service.pendingToolApprovals.values()].find(
      (entry) => entry.callId === callId
    );
    if (!pending) {
      throw new Error(`Approval scenario did not register ${callId}`);
    }
    pending.resolve(true, 'approved');
    await approvalPromise;
  }
  emitCanonicalToolEvent(turn, 3, 'tool_approval_resolved', callId, {
    approval_id: approvalId,
    approval_state: 'approved',
    approved: true,
    tool_name: toolName,
  });
  emitCanonicalToolEvent(turn, 4, 'tool_execution_started', callId, {
    tool_name: toolName,
    tool_input: toolInput,
  });
  emitLegacyToolExecuting(turn, callId, toolName, toolInput);
  emitCanonicalToolEvent(turn, 5, 'tool_execution_completed', callId, {
    tool_name: toolName,
    tool_input: toolInput,
    output_text: toolOutput,
    success: true,
    duration_ms: 2,
  });
  emitLegacyToolResult(turn, callId, toolName, toolInput, {
    outputText: toolOutput,
    success: true,
  });
  emitPairedText(turn, {
    deltaSeq: 6,
    completedSeq: 7,
    legacySequence: 1,
    text: answer,
  });
  await finishTurn(turn);
}

async function runStreamResetTurn(turn, { content } = {}) {
  const firstSegment = contentText(content, 'firstSegment', 'First segment. ');
  const secondSegment = contentText(content, 'secondSegment', 'Second segment.');
  emitPairedText(turn, {
    deltaSeq: 1,
    completedSeq: 2,
    legacySequence: 1,
    text: firstSegment,
  });
  notify(turn.runtime, 'chat.stream_reset', {
    reason: 'tool_continuation',
  }, turn.context);
  emitPairedText(turn, {
    deltaSeq: 3,
    completedSeq: 4,
    legacySequence: 2,
    text: secondSegment,
  });
  await finishTurn(turn);
}

async function runToolFailureTurn(turn, { content } = {}) {
  const callId = `${turn.streamId}-failed-tool`;
  const toolName = 'inspect_harness';
  const toolInput = { sections: ['missing'] };
  const toolOutput = contentText(content, 'toolOutput', 'section missing');
  const answer = contentText(content, 'answer', 'Tool failure reported.');
  emitCanonicalToolEvent(turn, 1, 'tool_call_requested', callId, {
    tool_name: toolName,
    tool_input: toolInput,
  });
  emitLegacyToolExecuting(turn, callId, toolName, toolInput);
  emitCanonicalToolEvent(turn, 2, 'tool_execution_started', callId, {
    tool_name: toolName,
    tool_input: toolInput,
  });
  emitCanonicalToolEvent(turn, 3, 'tool_execution_failed', callId, {
    tool_name: toolName,
    tool_input: toolInput,
    output_text: toolOutput,
    success: false,
    error_code: 'CMP-HARNESS-0001',
    duration_ms: 2,
  });
  emitLegacyToolResult(turn, callId, toolName, toolInput, {
    outputText: toolOutput,
    success: false,
    errorCode: 'CMP-HARNESS-0001',
  });
  emitPairedText(turn, {
    deltaSeq: 4,
    completedSeq: 5,
    legacySequence: 1,
    text: answer,
  });
  await finishTurn(turn);
}

async function runInterleavedToolsTurn(turn, { content } = {}) {
  const toolName = 'inspect_harness';
  const calls = [
    {
      callId: `${turn.streamId}-tool-a`,
      input: { sections: ['runtime'] },
      output: contentText(content, 'firstToolOutput', 'runtime ok'),
    },
    {
      callId: `${turn.streamId}-tool-b`,
      input: { sections: ['models'] },
      output: contentText(content, 'secondToolOutput', 'models ok'),
    },
  ];
  const answer = contentText(content, 'answer', 'Both tools complete.');
  emitCanonicalToolEvent(turn, 1, 'tool_call_requested', calls[0].callId, {
    tool_name: toolName,
    tool_input: calls[0].input,
  });
  emitLegacyToolExecuting(turn, calls[0].callId, toolName, calls[0].input);
  emitCanonicalToolEvent(turn, 2, 'tool_execution_started', calls[0].callId, {
    tool_name: toolName,
    tool_input: calls[0].input,
  });
  emitCanonicalToolEvent(turn, 3, 'tool_call_requested', calls[1].callId, {
    tool_name: toolName,
    tool_input: calls[1].input,
  });
  emitLegacyToolExecuting(turn, calls[1].callId, toolName, calls[1].input);
  emitCanonicalToolEvent(turn, 4, 'tool_execution_started', calls[1].callId, {
    tool_name: toolName,
    tool_input: calls[1].input,
  });
  emitCanonicalToolEvent(turn, 5, 'tool_execution_completed', calls[1].callId, {
    tool_name: toolName,
    tool_input: calls[1].input,
    output_text: calls[1].output,
    success: true,
    duration_ms: 2,
  });
  emitLegacyToolResult(turn, calls[1].callId, toolName, calls[1].input, {
    outputText: calls[1].output,
    success: true,
  });
  emitCanonicalToolEvent(turn, 6, 'tool_execution_completed', calls[0].callId, {
    tool_name: toolName,
    tool_input: calls[0].input,
    output_text: calls[0].output,
    success: true,
    duration_ms: 2,
  });
  emitLegacyToolResult(turn, calls[0].callId, toolName, calls[0].input, {
    outputText: calls[0].output,
    success: true,
  });
  emitPairedText(turn, {
    deltaSeq: 7,
    completedSeq: 8,
    legacySequence: 1,
    text: answer,
  });
  await finishTurn(turn);
}

function emitReasoningPhase(turn, {
  iteration,
  deltaSeq,
  completedSeq,
  text,
}) {
  const phaseId = `${turn.streamId}-reasoning-${iteration}`;
  const thinkingId = `${turn.streamId}-thinking-${iteration}`;
  notify(turn.runtime, 'chat.phase_started', {
    phase_id: phaseId,
    phase_kind: 'reasoning',
    iteration,
    thinking_id: thinkingId,
    summary: `Reasoning ${iteration}`,
  }, turn.context);
  notify(turn.runtime, 'turn.event', canonical(turn, deltaSeq, 'reasoning_delta', {
    delta: text,
    persist: true,
    thinking_id: thinkingId,
    phase_id: phaseId,
  }), turn.context);
  notify(turn.runtime, 'chat.thinking', {
    delta: text,
    thinking_id: thinkingId,
    kind: 'reasoning',
    persist: true,
  }, turn.context);
  notify(turn.runtime, 'turn.event', canonical(turn, completedSeq, 'reasoning_part_completed', {
    phase_id: phaseId,
    thinking_id: thinkingId,
    entries: [{ id: `${thinkingId}-entry`, text }],
  }), turn.context);
  notify(turn.runtime, 'chat.phase_completed', {
    phase_id: phaseId,
    phase_kind: 'reasoning',
    iteration,
    thinking_id: thinkingId,
  }, turn.context);
}

async function runMultiPhaseReasoningTurn(turn, { content } = {}) {
  emitReasoningPhase(turn, {
    iteration: 1,
    deltaSeq: 1,
    completedSeq: 2,
    text: contentText(content, 'firstReasoning', 'Inspect the first condition.'),
  });
  emitReasoningPhase(turn, {
    iteration: 2,
    deltaSeq: 3,
    completedSeq: 4,
    text: contentText(content, 'secondReasoning', 'Check the second condition.'),
  });
  notify(turn.runtime, 'chat.phase_started', {
    phase_id: `${turn.streamId}-text`,
    phase_kind: 'text',
    iteration: 1,
    summary: 'Answer',
  }, turn.context);
  emitPairedText(turn, {
    deltaSeq: 5,
    completedSeq: 6,
    legacySequence: 1,
    text: contentText(content, 'answer', 'Both conditions checked.'),
  });
  notify(turn.runtime, 'chat.phase_completed', {
    phase_id: `${turn.streamId}-text`,
    phase_kind: 'text',
    iteration: 1,
  }, turn.context);
  await finishTurn(turn);
}

const PARITY_SCENARIOS = Object.freeze([
  Object.freeze({ name: 'text', run: runTextTurn, content: 'Hello from both lanes.' }),
  Object.freeze({
    name: 'reasoning',
    run: runReasoningTurn,
    content: Object.freeze({
      reasoning: 'Checking the next step.',
      answer: 'Reasoned answer.',
    }),
  }),
  Object.freeze({
    name: 'tool',
    run: runToolTurn,
    content: Object.freeze({ answer: 'Tool turn complete.' }),
  }),
  Object.freeze({
    name: 'multi_token',
    run: runMultiTokenTurn,
    content: Object.freeze(['First ', 'second ', 'third.']),
  }),
  Object.freeze({
    name: 'approval',
    run: runApprovalTurn,
    content: Object.freeze({ toolOutput: 'wrote notes.txt', answer: 'Approved tool complete.' }),
  }),
  Object.freeze({
    name: 'stream_reset',
    run: runStreamResetTurn,
    content: Object.freeze({ firstSegment: 'First segment. ', secondSegment: 'Second segment.' }),
  }),
  Object.freeze({
    name: 'tool_failure',
    run: runToolFailureTurn,
    content: Object.freeze({ toolOutput: 'section missing', answer: 'Tool failure reported.' }),
  }),
  Object.freeze({
    name: 'interleaved_tools',
    run: runInterleavedToolsTurn,
    content: Object.freeze({
      firstToolOutput: 'runtime ok',
      secondToolOutput: 'models ok',
      answer: 'Both tools complete.',
    }),
  }),
  Object.freeze({
    name: 'multi_phase_reasoning',
    run: runMultiPhaseReasoningTurn,
    content: Object.freeze({
      firstReasoning: 'Inspect the first condition.',
      secondReasoning: 'Check the second condition.',
      answer: 'Both conditions checked.',
    }),
  }),
]);

module.exports = {
  PARITY_SCENARIOS,
  runApprovalTurn,
  runInterleavedToolsTurn,
  runMultiPhaseReasoningTurn,
  runStreamResetTurn,
  runToolFailureTurn,
};
