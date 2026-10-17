'use strict';

/* Fixture for the session-kind proposal service tests (row 59 checkpoint 5a-1): the cp3 service
 * fixture plus controllable session ports (source-turn settlement, user-message turns, a manual
 * timer queue) and a stub of S6's handoff module that follows the frozen S5/S6 interface. */

const R = require('../../services/backend/chat-proposal-records');
const S = require('../../services/backend/chat-proposal-session-records');
const { createFixture } = require('./chat-proposal-service-fixture');

function sessionBinding(overrides = {}) {
  const { session = {}, restrictions = {}, ...rest } = overrides;
  return {
    source_project_id: 'proj_1',
    workspace_id: null,
    root_identity: null,
    authority_revision: 1,
    run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false, ...restrictions },
    model: null,
    effort: null,
    git: null,
    command: null,
    session: { source_run_mode: 'ask', lockdown: false, ...session },
    ...rest,
  };
}

function createSessionFixture(t, opts = {}) {
  const ctl = {
    settled: new Map(), // source turn id -> true | false | null
    reasons: new Map(), // source turn id -> completion reason
    userTurns: new Map(), // user message id -> turn id
    timers: [],
    handoffSupported: true,
    destinations: [{ project_id: 'proj_1', label: 'Project one', available: true }, { project_id: 'proj_2', label: 'Project two', available: true }],
    models: [{ id: 'model_a', label: 'Model A' }],
    efforts: ['low', 'high'],
  };
  const handoff = {
    calls: [],
    completeResult: { ok: true },
    resumeResult: { ok: true },
    buildPreparationRequest(record) {
      handoff.calls.push(['build', record.proposal_id]);
      return {
        sessionId: record.source_session_id,
        prompt: 'Prepare the handoff.',
        visiblePrompt: 'Preparing a new chat',
        attachments: [],
        planMode: false,
        approvalMode: 'prompt',
        sessionHandoffPreparation: { proposal_id: record.proposal_id, attempt_id: record.attempt_id },
      };
    },
    startPreparationDeadline(ports, args) {
      handoff.calls.push(['start_deadline', args.proposalId, args.attemptId]);
      ports.deadlines.set(`${args.proposalId}:${args.attemptId}`, ports.setTimer(args.onExpire, 60000));
    },
    clearPreparationDeadline(ports, args) {
      handoff.calls.push(['clear_deadline', args.proposalId, args.attemptId]);
      const key = `${args.proposalId}:${args.attemptId}`;
      if (ports.deadlines.has(key)) ports.clearTimer(ports.deadlines.get(key));
      ports.deadlines.delete(key);
    },
    async completeSessionHandoff(ports, args) {
      handoff.calls.push(['complete', args.proposalId]);
      return handoff.completeResult;
    },
    async resumeChildCreation(ports, args) {
      handoff.calls.push(['resume', args.proposalId]);
      return handoff.resumeResult;
    },
  };
  const serviceOptions = {
    sessionHandoff: handoff,
    listDestinations: () => ctl.destinations,
    listModelOptions: () => ({ models: ctl.models, reasoning_efforts: ctl.efforts }),
    resolveUserMessageTurn: (_sessionId, messageId) => (ctl.userTurns.has(messageId) ? { turn_id: ctl.userTurns.get(messageId) } : null),
    isSourceWorkSettled: (_sessionId, turnId) => (ctl.settled.has(turnId) ? ctl.settled.get(turnId) : null),
    getTurnCompletionReason: (_sessionId, turnId) => ctl.reasons.get(turnId) ?? null,
    supportsSessionHandoff: () => ctl.handoffSupported,
    supportsProducerTool: () => true,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, fired: false };
      ctl.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    ...(opts.serviceOptions || {}),
  };
  const fx = createFixture(t, { ...opts, serviceOptions });
  fx.ctl = ctl;
  fx.handoff = handoff;
  // The source turn ends at its boundary and the runtime's work settles.
  ctl.settle = (turnId) => { ctl.settled.set(turnId, true); ctl.reasons.set(turnId, 'awaiting_proposal'); };
  ctl.liveTimers = () => ctl.timers.filter((timer) => !timer.cleared && !timer.fired);
  // Fires the live timers (optionally those at `ms`) once, oldest first.
  fx.fireTimers = async (ms = null) => {
    for (const timer of ctl.liveTimers()) {
      if (ms !== null && timer.ms !== ms) continue;
      timer.fired = true;
      timer.fn();
    }
    await fx.service.idle();
  };
  fx.publishSession = (n = 1, {
    initiation = 'offer', title = 'Fix the build', description = undefined, group_key = undefined, authorization_ref = undefined,
    binding = {}, turn = null, ...extra
  } = {}) => {
    const checked = S.normalizeSessionProposalInput({
      initiation, title, ...(description === undefined ? {} : { description }),
      ...(group_key === undefined ? {} : { group_key }),
      ...(authorization_ref === undefined ? {} : { authorization_ref }), ...extra,
    });
    if (!checked.ok) return Promise.resolve({ ok: false, input: checked });
    return fx.service.publish({
      kind: 'session', sessionId: fx.sessionId, sessionIncarnation: fx.sessionIncarnation,
      turnId: turn || `turn_${n}`, toolCallId: `call_${n}`, input: checked.value, binding: sessionBinding(binding),
    });
  };
  fx.authorize = (messageId, extra = {}) => fx.service.authorizeLaunch(fx.request({
    source_user_message_id: messageId,
    expected_session_incarnation: fx.sessionIncarnation,
    max_children: 1,
    destination_project_ids: ['proj_1'],
    action_id: '44444444-4444-4444-8444-444444444444',
    ...extra,
  }));
  fx.stream = (turnId, type, extra = {}) => fx.service.handleChatStreamEvent({ type, turnId, sessionId: fx.sessionId, ...extra });
  fx.options = (extra = {}) => ({ destination_project_id: 'proj_1', preferred_model: null, reasoning_effort: null, run_mode: 'agent', ...extra });
  fx.grants = () => fx.proposalStore.read(fx.sessionId).launch_grants;
  return fx;
}

module.exports = { R, createSessionFixture, sessionBinding };
