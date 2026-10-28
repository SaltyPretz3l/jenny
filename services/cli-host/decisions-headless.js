'use strict';

// Non-interactive decisions (Jenny CLI plan, decision 4). A run without a
// person settles every decision the moment the backend raises it, and always
// closed: a tool that reached the ask path was not pre-allowed by the run, so
// it is denied; a question has nobody to answer it, so it is declined; a plan
// has nobody to accept it, so its approval is denied and the plan text is the
// run's result. Nothing here grants anything, and nothing is persisted.
//
// The backend emits `tool_approval_needed` before it records the pending
// entry, so a decision is deferred until the entry exists; a decision that
// never finds its entry (the approval was withdrawn) is dropped and logged.

const { DESKTOP_ONLY_TOOLS } = require('./run-permission-policy');

const PLAN_TOOL = 'exit_plan_mode';
const DEFER_ATTEMPTS = 200;

function text(value, limit = 200) {
  return String(value || '').trim().slice(0, limit);
}

function whenPending(hasEntry, act, onGiveUp, attempts = DEFER_ATTEMPTS) {
  if (hasEntry()) {
    act();
    return;
  }
  if (attempts <= 0) {
    onGiveUp();
    return;
  }
  setImmediate(() => whenPending(hasEntry, act, onGiveUp, attempts - 1));
}

// Promise form for the interactive decider: true once the entry exists,
// false when it never appears.
function waitForPending(hasEntry) {
  return new Promise((resolve) => whenPending(hasEntry, () => resolve(true), () => resolve(false)));
}

// The name of the rule that closed the request, for the `decision` frame and
// the result's `permission_denials`.
function denialRule(policy, toolName, action = '') {
  if (toolName === PLAN_TOOL) return 'plan_requires_human';
  if (policy?.isDisallowed?.(toolName, action)) return 'disallowed_tools';
  if (DESKTOP_ONLY_TOOLS.includes(toolName) && !policy?.isAllowed?.(toolName)) return 'desktop_only_tool';
  return 'not_pre_allowed';
}

function actionOf(event) {
  const action = event?.input && typeof event.input === 'object' ? event.input.action : undefined;
  return typeof action === 'string' ? text(action, 120) : '';
}

function createHeadlessDecider({ service, policy = null, onDecision = () => {}, logger = () => {} } = {}) {
  if (!service || typeof service.on !== 'function' || typeof service.denyToolCall !== 'function'
    || typeof service.declineUserQuestions !== 'function') {
    throw new TypeError('A backend service with denyToolCall and declineUserQuestions is required.');
  }
  let disposed = false;
  const settle = (payload) => {
    try { onDecision(payload); } catch (error) {
      logger('WARN', 'cli.decision_listener_failed', { message: text(error?.message, 300) });
    }
  };
  const giveUp = (ref, type) => () => logger('WARN', 'cli.decision_never_pending', { ref, type });

  const onEvent = (event) => {
    if (disposed || !event || typeof event !== 'object') return;
    if (event.type === 'tool_approval_needed') {
      const ref = text(event.approvalId || event.callId);
      if (!ref) return;
      const toolName = text(event.toolName, 120);
      whenPending(() => !disposed && service.pendingToolApprovals?.has(ref), () => {
        if (!service.denyToolCall(ref)) return;
        settle({ ref, request: toolName === PLAN_TOOL ? 'plan_proposal' : 'tool_approval', outcome: 'deny',
          by: 'policy', rule: denialRule(policy, toolName, actionOf(event)), call_id: text(event.callId), tool_name: toolName });
      }, giveUp(ref, event.type));
      return;
    }
    if (event.type === 'user_questions_requested') {
      const ref = text(event.questionRef || event.questionId);
      if (!ref) return;
      whenPending(() => !disposed && service.pendingUserQuestions?.has(ref), () => {
        if (!service.declineUserQuestions(ref)) return;
        settle({ ref, request: 'user_questions', outcome: 'decline', by: 'policy', rule: 'non_interactive',
          call_id: text(event.callId), tool_name: 'ask_user' });
      }, giveUp(ref, event.type));
    }
  };
  service.on('chat-stream', onEvent);
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      service.off('chat-stream', onEvent);
    },
  });
}

module.exports = { PLAN_TOOL, createHeadlessDecider, denialRule, waitForPending };
