// Lifecycle phase grammar. Pure derivation helpers only: no globals,
// no DOM, no persistence, no second lifecycle controller. Consumers
// (renderer-composer-v2-status, renderer-activity-prefs-utils,
// renderer-render-pipeline-chrome) should all call these helpers so composer
// notice copy and transcript emphasis agree on the same vocabulary.
//
// Canonical input: viewModel.phaseHint from renderer/chat/renderer-turn-view-model.js. This
// module never re-walks events or inspects session state; it only maps the
// phaseHint vocabulary onto the six-phase grammar.
//
// Six-phase grammar:
//   sending          — user sent; preflight/streaming/settling umbrella
//   thinking         — assistant reasoning or streaming text
//   needs_approval   — at least one tool call waiting on user approval
//   running_tool     — at least one tool call actively executing
//   review_artifact  — consumer-supplied: an artifact is awaiting review
//   done             — idle / completed / terminal
//
// Terminal substatus vocabulary is separate from phase and passed via context:
//   completed, cancelled, timed_out, preempted, interrupted

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnPhase = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TURN_PHASES = Object.freeze({
    SENDING: 'sending',
    THINKING: 'thinking',
    NEEDS_APPROVAL: 'needs_approval',
    RUNNING_TOOL: 'running_tool',
    REVIEW_ARTIFACT: 'review_artifact',
    DONE: 'done',
  });

  var TERMINAL_SUBSTATUS = Object.freeze({
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    TIMED_OUT: 'timed_out',
    PREEMPTED: 'preempted',
    INTERRUPTED: 'interrupted',
  });

  // Map the eleven phaseHint values from renderer/chat/renderer-turn-view-model.js into the
  // locked six-phase grammar. Unknown/missing hints fall through to 'done'.
  var PHASE_HINT_MAP = Object.freeze({
    idle: TURN_PHASES.DONE,
    awaiting_assistant: TURN_PHASES.SENDING,
    reasoning: TURN_PHASES.THINKING,
    streaming_assistant: TURN_PHASES.THINKING,
    final_answer: TURN_PHASES.DONE,
    awaiting_approval: TURN_PHASES.NEEDS_APPROVAL,
    tool_running: TURN_PHASES.RUNNING_TOOL,
    denied: TURN_PHASES.DONE,
    cancelled: TURN_PHASES.DONE,
    errored: TURN_PHASES.DONE,
    tool_settled: TURN_PHASES.DONE,
  });

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeTerminalStatus(value) {
    var token = normalizeString(value).toLowerCase();
    switch (token) {
      case TERMINAL_SUBSTATUS.COMPLETED:
      case TERMINAL_SUBSTATUS.CANCELLED:
      case TERMINAL_SUBSTATUS.TIMED_OUT:
      case TERMINAL_SUBSTATUS.PREEMPTED:
      case TERMINAL_SUBSTATUS.INTERRUPTED:
        return token;
      // Backend still emits raw 'timeout'; normalize here so callers don't have
      // to branch. The canonical viewModel keeps the raw subtype per Phase 2.
      case 'timeout':
        return TERMINAL_SUBSTATUS.TIMED_OUT;
      default:
        return '';
    }
  }

  function normalizeSendLifecycle(value) {
    var token = normalizeString(value).toLowerCase();
    if (token === 'preflight' || token === 'streaming' || token === 'settling') {
      return token;
    }
    return 'idle';
  }

  function deriveTurnPhase(viewModel) {
    if (!viewModel || typeof viewModel !== 'object') {
      return TURN_PHASES.DONE;
    }
    var hint = normalizeString(viewModel.phaseHint).toLowerCase();
    if (!hint) {
      return TURN_PHASES.DONE;
    }
    return PHASE_HINT_MAP[hint] || TURN_PHASES.DONE;
  }

  return {
    TURN_PHASES: TURN_PHASES,
    TERMINAL_SUBSTATUS: TERMINAL_SUBSTATUS,
    PHASE_HINT_MAP: PHASE_HINT_MAP,
    deriveTurnPhase: deriveTurnPhase,
    normalizeTerminalStatus: normalizeTerminalStatus,
    normalizeSendLifecycle: normalizeSendLifecycle,
  };
});
