'use strict';

// Interactive decisions (Jenny CLI plan, decision 4). A person at the terminal
// settles each request through the injected `ask` port: approve once, deny,
// or allow the tool for the rest of this run. "This run" lives in memory only:
// the decider never passes `alwaysAllow`, so a terminal decision never writes
// the profile's stored policy. Approval goes through the backend's own
// `approveToolCall`, which binds it to the session's current execution
// authority revision; a stale approval is refused there, not here.
//
// `ask(prompt, { signal })` resolves to 'allow' | 'allow_run' | 'deny' for a
// tool approval or plan, and to an answers object (or null to decline) for a
// question batch. Prompts are serialized so two never share the terminal, and
// the signal aborts when the backend withdraws the request.

const { PLAN_TOOL, denialRule, waitForPending } = require('./decisions-headless');

const CHOICES = Object.freeze(['allow', 'allow_run', 'deny']);

function text(value, limit = 200) {
  return String(value || '').trim().slice(0, limit);
}

function createTtyDecider({ service, policy = null, ask, onDecision = () => {}, logger = () => {}, allowedThisRun = new Set() } = {}) {
  if (!service || typeof service.on !== 'function' || typeof service.approveToolCall !== 'function'
    || typeof service.denyToolCall !== 'function' || typeof service.answerUserQuestions !== 'function'
    || typeof service.declineUserQuestions !== 'function') {
    throw new TypeError('A backend service with the approval and question methods is required.');
  }
  if (typeof ask !== 'function') throw new TypeError('An ask port is required.');

  if (!(allowedThisRun instanceof Set)) throw new TypeError('allowedThisRun must be a Set.');
  const controllers = new Map();
  let queue = Promise.resolve();
  let disposed = false;

  const settle = (payload) => {
    try { onDecision(payload); } catch (error) {
      logger('WARN', 'cli.decision_listener_failed', { message: text(error?.message, 300) });
    }
  };

  function prompt(ref, request) {
    const controller = new AbortController();
    controllers.set(ref, controller);
    const run = queue.then(async () => {
      if (disposed || controller.signal.aborted) return undefined;
      try { return await ask(request, { signal: controller.signal }); } catch (error) {
        logger('WARN', 'cli.prompt_failed', { ref, message: text(error?.message, 300) });
        return undefined;
      }
    });
    queue = run.then(() => {}, () => {});
    return run.finally(() => { if (controllers.get(ref) === controller) controllers.delete(ref); });
  }

  async function decideApproval(event) {
    const ref = text(event.approvalId || event.callId);
    if (!ref) return;
    const toolName = text(event.toolName, 120);
    const request = toolName === PLAN_TOOL ? 'plan_proposal' : 'tool_approval';
    const base = { ref, request, by: 'user', call_id: text(event.callId), tool_name: toolName };
    // The backend marks a request that must be approved on its own exact
    // content (`oneOffOnly`): the run allow-list neither covers nor learns it.
    const oneOff = event.oneOffOnly === true || event.one_off_only === true;
    let choice = !oneOff && allowedThisRun.has(toolName) ? 'allow' : undefined;
    let rule = choice ? 'allowed_this_run' : undefined;
    if (!choice) {
      choice = await prompt(ref, { kind: request, ref, toolName, summary: text(event.summary, 400),
        input: event.input, ...(oneOff ? { one_off_only: true } : {}), ...(event.plan ? { plan: event.plan } : {}) });
      if (!CHOICES.includes(choice)) choice = 'deny';
      if (choice === 'allow_run' && (oneOff || toolName === PLAN_TOOL)) choice = 'allow';
      if (choice === 'allow_run') allowedThisRun.add(toolName);
      rule = choice === 'deny' ? 'user_denied' : choice === 'allow_run' ? 'allowed_this_run' : 'user_allowed_once';
    }
    // The backend emits the request before it records the pending entry.
    if (!(await waitForPending(() => disposed || service.pendingToolApprovals?.has(ref)))) {
      logger('WARN', 'cli.decision_never_pending', { ref, type: 'tool_approval_needed' });
      return;
    }
    if (disposed) return;
    if (choice === 'deny') {
      if (service.denyToolCall(ref)) settle({ ...base, outcome: 'deny', rule });
      return;
    }
    // Once only, and bound to the current revision by the backend; no
    // `alwaysAllow`, so the stored policy is never widened by a run.
    if (service.approveToolCall(ref, {})) settle({ ...base, outcome: 'allow', rule });
    else logger('WARN', 'cli.decision_stale', { ref, tool_name: toolName, rule: denialRule(policy, toolName) });
  }

  async function decideQuestions(event) {
    const ref = text(event.questionRef || event.questionId);
    if (!ref) return;
    const base = { ref, request: 'user_questions', by: 'user', call_id: text(event.callId), tool_name: 'ask_user' };
    const answers = await prompt(ref, { kind: 'user_questions', ref, questions: Array.isArray(event.questions) ? event.questions : [] });
    if (disposed) return;
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      if (service.answerUserQuestions(ref, answers)) settle({ ...base, outcome: 'answer' });
      return;
    }
    if (service.declineUserQuestions(ref)) settle({ ...base, outcome: 'decline', rule: 'user_declined' });
  }

  const onEvent = (event) => {
    if (disposed || !event || typeof event !== 'object') return;
    if (event.type === 'tool_approval_needed') decideApproval(event);
    else if (event.type === 'user_questions_requested') decideQuestions(event);
    else if (event.type === 'tool_approval_withdrawn' || event.type === 'user_questions_withdrawn') {
      const ref = text(event.approvalId || event.questionRef || event.callId);
      controllers.get(ref)?.abort();
    }
  };
  service.on('chat-stream', onEvent);
  return Object.freeze({
    allowedThisRun: () => [...allowedThisRun].sort(),
    dispose() {
      if (disposed) return;
      disposed = true;
      service.off('chat-stream', onEvent);
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  });
}

module.exports = { CHOICES, createTtyDecider };
