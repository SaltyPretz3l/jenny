'use strict';

const { hostFailure } = require('./api-contract');

/**
 * The decision handlers (`approval.resolve`, `questions.answer`, `questions.decline`) and the viewing
 * heartbeat `session.view`, moved out of command-router.js (slice 3-6b). The router hands in what they
 * need, as with `createControlHandlers`; nothing here reaches back into the router.
 *
 * The single-owner host (no `teamHost`) keeps today's rule byte for byte: the live lease, the
 * control generation and the expected revision, no viewing and no audit.
 *
 * On a team host (TEAM_PROJECTS_SPEC "Approvals"; E25, E60) the three operations need no lease and
 * no revision (both are ignored when sent). The caller passes the one authorization function for
 * `decision.resolve` on the conversation (the router's identity check resolves the operation to that
 * row) and must be viewing it on the calling device, else `forbidden` / `approval_not_viewing`. Both
 * checks run again inside the conversation's queue, so a member removed or re-roled while the answer
 * waited is refused. The queue and the adapter's pending map with `decision_revision` keep it to one
 * valid decision; a second answer gets today's stale answer. The three decisions take a token from the
 * member's decision limit (`team_rate_limit`) before anything else, so a flood stores no receipts.
 * `session.view` has its own counter, taken after the readable check (`team_view_rate_limit`, slice 3-9).
 *
 * An approval is audited first, and only an answer that can still apply is written: inside the queue the
 * approval must be waiting in this conversation and stream with the command's `decision_revision`, else
 * the stale answer and nothing written. Then `approval_decided` is appended before the resolve; a log
 * that cannot take it refuses with `team_audit_unavailable` and resolves nothing. A resolve that then
 * answers not ok, or throws, appends `approval_not_applied` naming the first entry. A turn with no member
 * author cannot have its approval answered (`approval_prompter_unknown`). A conversation in no project
 * (the owner's General) has no project log: its decisions are not audited. Questions write no entry (the
 * log has no kind for them). Every `decision_changed` on a team host carries `prompter_member_id`.
 *
 * Slice 3-12 (E66): `approval.resolve` may carry `always` (`rule` | `ask`) on a team host, with `approved: true`
 * only, for write_file or edit_file in a conversation of a team project. It is checked inside the queue before the
 * audited decision (`rule` needs a project admin, `ask` a writer; anything else refuses and applies nothing); the
 * rule is saved or the request filed only after the decision applied, and its outcome rides on the answer as
 * `always_result`. A stale or not-applied answer writes neither. The single-owner host refuses the field as before.
 */
function createDecisionHandlers({
  decisionAdapter, identity, teamHost, approvals = null, trustedAuthor, mutationGuard, runReceipt,
  assertMutationAuthority, assertPostAwaitAuthority, sessionExists, bumpRevision, publish,
}) {
  function apply(command) {
    const { params } = command;
    if (command.operation === 'approval.resolve') {
      return decisionAdapter.resolveApproval({ sessionId: command.session_id, streamId: params.stream_id,
        approvalId: params.approval_id, decisionRevision: params.decision_revision, approved: params.approved });
    }
    if (command.operation === 'questions.answer') {
      return decisionAdapter.answerQuestions({ sessionId: command.session_id, streamId: params.stream_id,
        questionRef: params.question_ref, answers: params.answers });
    }
    return decisionAdapter.declineQuestions({ sessionId: command.session_id, streamId: params.stream_id,
      questionRef: params.question_ref });
  }

  // `prompter` is undefined on the single-owner host: its event gains no key. `approver` (slice 3-9) is the
  // deciding member on a team host's resolved approval: the event then names it and the decision.
  function settle(command, result, prompter, approver = undefined) {
    if (!result?.ok) return hostFailure('conflict', result?.reason || 'decision_stale', command.request_id);
    const revision = bumpRevision(command.session_id);
    publish('session_changed', { session_id: command.session_id, revision, reason: 'decision' });
    publish('decision_changed', {
      session_id: command.session_id,
      stream_id: command.params.stream_id,
      ...(command.operation === 'approval.resolve'
        ? { approval_id: command.params.approval_id }
        : { question_ref: command.params.question_ref }),
      ...(prompter !== undefined ? { prompter_member_id: prompter } : {}),
      ...(approver !== undefined ? { approver_member_id: approver, approved: command.params.approved === true } : {}),
    });
    return { ...result, revision };
  }

  async function ownerDecision(command, context) {
    // Not in the single-owner host's vocabulary: answered exactly as the closed schema answered it before 3-12.
    if (command.params?.always !== undefined) return hostFailure('invalid', 'invalid_command_parameters', command.request_id);
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      const result = apply(command);
      assertPostAwaitAuthority(command, context);
      return settle(command, result, undefined);
    });
  }

  // The identity check and the conversation's existence (a cache-neutral read): null when both pass.
  function readable(command, context) {
    const refused = identity(command, context);
    if (refused) return refused;
    return sessionExists(command.session_id) ? null : hostFailure('conflict', 'session_not_found', command.request_id);
  }

  // A team router without the approvals wiring has no limiter; its decisions are refused as not viewing.
  function limited(command, context) {
    if (!approvals || approvals.take(trustedAuthor(context)?.member_id)) return null;
    return hostFailure('limit', 'team_rate_limit', command.request_id);
  }

  // null when the caller may decide in this conversation now.
  function teamGate(command, context) {
    const refused = readable(command, context);
    if (refused) return refused;
    // A team router built without the approvals wiring has no viewers: nobody is viewing (fail closed).
    if (!approvals?.viewers.isViewing(command.session_id, context.deviceId)) {
      return hostFailure('forbidden', 'approval_not_viewing', command.request_id);
    }
    return null;
  }

  function resolveAudited(command, context) {
    const { session_id: sessionId, params, request_id: requestId } = command;
    // Only an answer that can still apply is written: waiting here, with this revision.
    const waiting = decisionAdapter.peekApproval({ sessionId, streamId: params.stream_id, approvalId: params.approval_id,
      decisionRevision: params.decision_revision });
    if (!waiting) return hostFailure('conflict', 'decision_stale', requestId);
    const prompter = approvals.prompterFor(sessionId, params.approval_id);
    if (!prompter) return hostFailure('conflict', 'approval_prompter_unknown', requestId);
    const approver = trustedAuthor(context)?.member_id ?? null;
    const projectId = approvals.projectOf(sessionId);
    if (projectId === undefined) return hostFailure('unavailable', 'team_audit_unavailable', requestId);
    const always = params.always;
    const extra = { always, projectId, sessionId, toolName: waiting.toolName, memberId: approver };
    if (always !== undefined) {
      let refused;
      if (params.approved !== true) refused = hostFailure('invalid', 'team_rule_always_invalid');
      else if (!approvals.rules) refused = hostFailure('unavailable', 'team_rules_unavailable');
      else refused = approvals.rules.precheck(extra);
      if (refused) return { ok: false, error: { ...refused.error, request_id: requestId } };
    }
    const withAlways = (settled) => (always !== undefined && settled.ok
      ? { ...settled, always_result: approvals.rules.record(extra) } : settled);
    if (projectId === null) return settle(command, apply(command), prompter, approver);
    const entry = { kind: 'approval_decided', project_id: projectId, session_id: sessionId,
      actor_member_id: approver, prompter_member_id: prompter,
      tool_name: waiting.toolName, decision: params.approved ? 'approved' : 'denied' };
    const first = approvals.append(entry);
    if (first.ok !== true) return hostFailure('unavailable', 'team_audit_unavailable', requestId);
    const notApplied = () => {
      const second = approvals.append({ ...entry, kind: 'approval_not_applied', detail: { ref_seq: first.seq } });
      if (second.ok !== true) {
        approvals.log('WARN', 'team_approval.not_applied_unrecorded', { session_id: sessionId, ref_seq: first.seq });
      }
    };
    let result;
    try {
      result = apply(command);
    } catch (error) {
      notApplied();
      throw error;
    }
    if (!result?.ok) notApplied();
    return withAlways(settle(command, result, prompter, approver));
  }

  async function teamDecision(command, context) {
    const early = limited(command, context) || teamGate(command, context); if (early) return early;
    return runReceipt(command, context, async () => {
      const refused = teamGate(command, context); if (refused) return refused;
      if (command.operation === 'approval.resolve') return resolveAudited(command, context);
      return settle(command, apply(command), approvals.prompterOf(command.session_id));
    });
  }

  // `session.view`: keeps the caller's viewing record of a conversation it may read. Not a mutation,
  // no receipt. A touch refused at capacity answers `viewing: false`. `viewers` (slice 3-9) are the member ids
  // viewing it now, the caller's own included when its touch held; only a caller who may read it gets here.
  async function view(command, context) {
    if (!approvals) return hostFailure('invalid', 'unsupported_operation', command.request_id);
    const refused = readable(command, context);
    if (refused) return refused;
    if (!approvals.takeView(trustedAuthor(context)?.member_id)) {
      return hostFailure('limit', 'team_view_rate_limit', command.request_id);
    }
    const viewing = approvals.viewers.touch(command.session_id, context.deviceId, trustedAuthor(context)?.member_id);
    return { ok: true, viewing, viewers: approvals.viewers.membersOf(command.session_id) };
  }

  // A snapshot the caller was allowed to read marks it viewing (team host only; `touch` checks the ids).
  function noteSnapshot(sessionId, context) {
    approvals?.viewers.touch(sessionId, context?.deviceId, trustedAuthor(context)?.member_id);
  }

  return Object.freeze({ decision: teamHost ? teamDecision : ownerDecision, view, noteSnapshot });
}

module.exports = { createDecisionHandlers };
