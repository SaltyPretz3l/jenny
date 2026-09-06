// Lifecycle phase grammar. Pure derivation helpers only: no globals,
// no DOM, no persistence, no second lifecycle controller. Consumers
// (renderer-composer-v2-status, renderer-activity-prefs-utils,
// renderer-render-pipeline-chrome, renderer/app.js presence bridge,
// renderer-comet-personality) should all call these helpers so composer notice
// copy, transcript emphasis, and comet presence agree on the same vocabulary.
//
// Canonical input: viewModel.phaseHint from renderer/chat/renderer-turn-view-model.js. This
// module never re-walks events or inspects session state; it only maps the
// phaseHint vocabulary onto the six-phase grammar and surfaces
// the copy/presence mappings callers need.
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

  function normalizePhase(value) {
    var token = normalizeString(value).toLowerCase();
    switch (token) {
      case TURN_PHASES.SENDING:
      case TURN_PHASES.THINKING:
      case TURN_PHASES.NEEDS_APPROVAL:
      case TURN_PHASES.RUNNING_TOOL:
      case TURN_PHASES.REVIEW_ARTIFACT:
      case TURN_PHASES.DONE:
        return token;
      default:
        return TURN_PHASES.DONE;
    }
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

  function resolveToolLabel(context) {
    if (!context || typeof context !== 'object') return '';
    return normalizeString(context.toolDisplayName || context.toolName);
  }

  function resolveApprovalLabel(context) {
    if (!context || typeof context !== 'object') return '';
    return normalizeString(
      context.approvalToolDisplayName
        || context.approvalToolName
        || context.toolDisplayName
        || context.toolName
    );
  }

  // Returns a copy descriptor. Consumers can use any subset:
  //   message    — the primary notice string (may be empty)
  //   tone       — 'default' | 'pending' | 'success' | 'danger'
  //   spinner    — boolean: show a spinner affordance
  //   badgeText  — short chip text (may be empty)
  //   phase      — the derived phase (echoed for diagnostics)
  function phaseToComposerCopy(phase, context) {
    var resolvedPhase = normalizePhase(phase);
    var resolvedContext = context && typeof context === 'object' ? context : {};
    var sendLifecycle = normalizeSendLifecycle(resolvedContext.sendLifecycle);
    var terminalStatus = normalizeTerminalStatus(resolvedContext.terminalStatus);
    var toolLabel = resolveToolLabel(resolvedContext);
    var approvalLabel = resolveApprovalLabel(resolvedContext);
    var artifactReviewActive = resolvedContext.artifactReviewActive === true;

    switch (resolvedPhase) {
      case TURN_PHASES.SENDING: {
        var sendingMessage;
        if (sendLifecycle === 'preflight') {
          sendingMessage = 'Sending\u2026';
        } else if (sendLifecycle === 'settling') {
          sendingMessage = 'Finishing\u2026';
        } else {
          sendingMessage = 'Sending\u2026';
        }
        return {
          phase: resolvedPhase,
          message: sendingMessage,
          tone: 'pending',
          spinner: true,
          badgeText: 'Sending',
        };
      }
      case TURN_PHASES.THINKING: {
        var assistantStreaming = resolvedContext.assistantStreaming === true;
        return {
          phase: resolvedPhase,
          message: assistantStreaming ? 'Responding\u2026' : 'Thinking\u2026',
          tone: 'pending',
          spinner: true,
          badgeText: assistantStreaming ? 'Responding' : 'Thinking',
        };
      }
      case TURN_PHASES.NEEDS_APPROVAL: {
        var approvalMessage = approvalLabel
          ? 'Approval needed for ' + approvalLabel
          : 'Approval needed';
        return {
          phase: resolvedPhase,
          message: approvalMessage,
          tone: 'default',
          spinner: false,
          badgeText: 'Approval',
        };
      }
      case TURN_PHASES.RUNNING_TOOL: {
        var runningMessage = toolLabel
          ? 'Running ' + toolLabel + '\u2026'
          : 'Running tool\u2026';
        return {
          phase: resolvedPhase,
          message: runningMessage,
          tone: 'pending',
          spinner: true,
          badgeText: 'Tool',
        };
      }
      case TURN_PHASES.REVIEW_ARTIFACT: {
        if (!artifactReviewActive) {
          return {
            phase: resolvedPhase,
            message: '',
            tone: 'default',
            spinner: false,
            badgeText: '',
          };
        }
        return {
          phase: resolvedPhase,
          message: 'Reviewing artifact\u2026',
          tone: 'default',
          spinner: false,
          badgeText: 'Artifact',
        };
      }
      case TURN_PHASES.DONE:
      default: {
        if (terminalStatus === TERMINAL_SUBSTATUS.CANCELLED
          || terminalStatus === TERMINAL_SUBSTATUS.PREEMPTED) {
          return {
            phase: TURN_PHASES.DONE,
            message: 'Cancelled',
            tone: 'default',
            spinner: false,
            badgeText: 'Cancelled',
          };
        }
        if (terminalStatus === TERMINAL_SUBSTATUS.TIMED_OUT) {
          return {
            phase: TURN_PHASES.DONE,
            message: 'Timed out',
            tone: 'danger',
            spinner: false,
            badgeText: 'Timed out',
          };
        }
        if (terminalStatus === TERMINAL_SUBSTATUS.INTERRUPTED) {
          return {
            phase: TURN_PHASES.DONE,
            message: 'Interrupted',
            tone: 'default',
            spinner: false,
            badgeText: 'Interrupted',
          };
        }
        // Completed or no terminal substatus: no composer notice; chrome owns
        // its own idle presentation.
        return {
          phase: TURN_PHASES.DONE,
          message: '',
          tone: 'default',
          spinner: false,
          badgeText: '',
        };
      }
    }
  }

  // Returns a comet presence state. Consumers pass context hints that
  // still influence the existing comet vocabulary so the bridge in renderer/app.js
  // and renderer/features/renderer-comet-personality.js can stay source-of-truth for comet
  // behavior without introducing a second controller.
  function phaseToPresenceState(phase, context) {
    var resolvedPhase = normalizePhase(phase);
    var resolvedContext = context && typeof context === 'object' ? context : {};
    var terminalStatus = normalizeTerminalStatus(resolvedContext.terminalStatus);
    var assistantStreaming = resolvedContext.assistantStreaming === true;

    switch (resolvedPhase) {
      case TURN_PHASES.SENDING:
        return 'listening';
      case TURN_PHASES.THINKING:
        return assistantStreaming ? 'responding' : 'thinking';
      case TURN_PHASES.NEEDS_APPROVAL:
        return 'alert';
      case TURN_PHASES.RUNNING_TOOL:
        return 'tool-use';
      case TURN_PHASES.REVIEW_ARTIFACT:
        return 'alert';
      case TURN_PHASES.DONE:
      default: {
        if (terminalStatus === TERMINAL_SUBSTATUS.CANCELLED
          || terminalStatus === TERMINAL_SUBSTATUS.PREEMPTED) {
          return 'idle';
        }
        if (terminalStatus === TERMINAL_SUBSTATUS.TIMED_OUT
          || terminalStatus === TERMINAL_SUBSTATUS.INTERRUPTED) {
          return 'concerned';
        }
        if (terminalStatus === TERMINAL_SUBSTATUS.COMPLETED) {
          return 'happy';
        }
        return 'idle';
      }
    }
  }

  function phaseKindToPresenceState(phaseKind, context) {
    var normalizedKind = normalizeString(phaseKind).toLowerCase();
    switch (normalizedKind) {
      case 'reasoning':
        return phaseToPresenceState(TURN_PHASES.THINKING, {
          ...(context && typeof context === 'object' ? context : {}),
          assistantStreaming: false,
        });
      case 'text':
        return phaseToPresenceState(TURN_PHASES.THINKING, {
          ...(context && typeof context === 'object' ? context : {}),
          assistantStreaming: true,
        });
      case 'tool_use':
      case 'tool_result':
        return phaseToPresenceState(TURN_PHASES.RUNNING_TOOL, context);
      case 'approval_wait':
        return phaseToPresenceState(TURN_PHASES.NEEDS_APPROVAL, context);
      default:
        return '';
    }
  }

  return {
    TURN_PHASES: TURN_PHASES,
    TERMINAL_SUBSTATUS: TERMINAL_SUBSTATUS,
    PHASE_HINT_MAP: PHASE_HINT_MAP,
    deriveTurnPhase: deriveTurnPhase,
    phaseToComposerCopy: phaseToComposerCopy,
    phaseKindToPresenceState: phaseKindToPresenceState,
    phaseToPresenceState: phaseToPresenceState,
    normalizeTerminalStatus: normalizeTerminalStatus,
    normalizeSendLifecycle: normalizeSendLifecycle,
  };
});
