'use strict';

// The renderer-facing projection of a proposal record (row 59 checkpoint 3 C7, extended for the
// session kind in checkpoint 5a-1). Pure; re-exported from ./chat-proposal-records. Never
// includes the binding, hashes, dispatch keys, handoff text, grants or the stored input itself.

const R = require('./chat-proposal-records');
const S = require('./chat-proposal-session-records');

const { isDue } = R.primitives;

const availability = (available, why) => ({ available, reason: available ? null : why });
// Choice gate order: non-pending state, read_only, plan_mode, then unsupported capability (D6).
function choiceAvailability(state, { readOnly, runMode, lockdown = false }, supported) {
  if (state !== 'pending') return availability(false, state);
  if (readOnly) return availability(false, 'read_only');
  if (runMode === 'plan') return availability(false, 'plan_mode');
  if (lockdown) return availability(false, 'lockdown');
  if (!supported) return availability(false, 'unsupported_capability');
  return availability(true);
}

// Session choices are never refused by Plan, read-only or lockdown: the child inherits them and the
// continuation runs in the source's own mode.
function sessionChoiceAvailability(state, supported) {
  if (state !== 'pending') return availability(false, state);
  return supported ? availability(true) : availability(false, 'unsupported_capability');
}

// A record parked by a trusted archive restore (`restore_requires_confirmation`) takes no choice until the user
// confirms it; Dismiss stays. A restored command is inert for good: its confirmation is unsupported.
function restoredGate(record, gate) {
  if (record.restore_requires_confirmation !== true || !gate.available) return gate;
  return availability(false, record.kind === 'command' ? 'unsupported_capability' : 'authorization_required');
}

// Present only on a flagged record. A pending offer clears back to pending; an accepted needs_attention
// action is reconciled with its existing work; a command never confirms (a fresh proposal is required).
function confirmRestoredAction(record, state) {
  if (record.kind === 'command') return availability(false, 'unsupported_capability');
  const parked = record.decision_state === 'accepted' && record.action_state === 'needs_attention';
  return state === 'pending' || parked ? availability(true) : availability(false, state);
}

function displayFor(record) {
  const input = record.normalized_input;
  if (record.kind === 'git') {
    return { summary: input.summary, question: input.question, paths: [...input.paths], path_count: input.paths.length };
  }
  if (record.kind === 'session') {
    const info = record.binding.session;
    return {
      title: input.title, description: input.description, initiation: info.effective_initiation,
      authorization_required: info.authorization_required,
    };
  }
  return {
    command: input.command, cwd: input.cwd, purpose: input.purpose, timeout_seconds: input.timeout_seconds,
    expected_exit_codes: [...input.expected_exit_codes],
    preconditions: input.preconditions.map((entry) => ({ text: entry.text })),
    backend: record.binding.command.backend, shell: record.binding.command.shell,
  };
}

function sessionActions(record, state, ctx) {
  const runtime = ctx.sessionRuntimeSupported !== false;
  return {
    do_it_here: restoredGate(record, sessionChoiceAvailability(state, runtime)),
    new_session: restoredGate(record, sessionChoiceAvailability(state, runtime && ctx.sessionHandoffSupported === true)),
    dismiss: state === 'pending' ? availability(true) : availability(false, state),
    cancel: availability(S.canCancelSession(record), 'not_applicable'),
    retry: availability(S.canRetrySession(record), 'not_applicable'),
  };
}

function legacyActions(record, state, ctx) {
  const gate = { readOnly: ctx.readOnly === true, runMode: ctx.runMode === 'plan' ? 'plan' : 'agent' };
  const actions = {};
  if (record.kind === 'git') {
    actions.commit = restoredGate(record, choiceAvailability(state, gate, true));
    actions.test_first = restoredGate(record, choiceAvailability(state, gate, true));
  } else {
    // Offline lockdown withholds run_command from model turns, so it withholds Run too (Copy stays).
    actions.run = restoredGate(record, choiceAvailability(state, { ...gate, lockdown: ctx.lockdown === true }, ctx.commandRunSupported === true));
  }
  actions.dismiss = state === 'pending' ? availability(true) : availability(false, state);
  actions.cancel = availability(R.isGitLive(record) || R.isCommandLive(record), 'not_applicable');
  actions.retry = R.canRetry(record)
    ? choiceAvailability('pending', gate, true)
    : availability(false, 'not_applicable');
  return actions;
}

// ctx: {now, runMode:'agent'|'plan', readOnly:bool, lockdown:bool, commandRunSupported:bool,
// sessionRuntimeSupported:bool (default true), sessionHandoffSupported:bool, child: the derived live view of a
// New session's child chat (./chat-proposal-child-view) or null}.
function projectProposal(record, ctx = {}) {
  const state = record.decision_state === 'pending' && isDue(record, ctx.now) ? 'expired' : record.decision_state;
  const session = record.kind === 'session';
  const { decision } = record;
  const links = {
    continuation_turn_id: record.continuation_turn_id,
    continuation_work_id: record.continuation_work_id,
    command_tool_call_id: record.kind === 'command' && decision?.choice === 'run'
      ? R.commandToolCallId(record.proposal_id, decision.decision_id) : null,
  };
  const projected = {
    schema_version: 1,
    proposal_id: record.proposal_id,
    revision: record.revision,
    kind: record.kind,
    source_session_id: record.source_session_id,
    source_turn_id: record.source_turn_id,
    source_tool_call_id: record.source_tool_call_id,
    created_at: record.created_at,
    expires_at: record.expires_at,
    decision_state: state,
    action_state: record.action_state,
    display: displayFor(record),
    decision: decision
      ? { choice: decision.choice, accepted_at: decision.accepted_at, accepted_revision: decision.accepted_revision } : null,
    links,
    actions: session ? sessionActions(record, state, ctx) : legacyActions(record, state, ctx),
    execution: record.execution && { ...record.execution },
    last_error: record.last_error && { ...record.last_error },
  };
  if (record.restore_requires_confirmation === true) projected.actions.confirm_restored = confirmRestoredAction(record, state);
  if (session) {
    Object.assign(links, {
      child_session_id: record.child_session_id,
      first_turn_turn_id: record.first_turn_turn_id,
      first_turn_work_id: record.first_turn_work_id,
      preparation_turn_id: record.preparation_turn_id,
      reply_turn_id: ctx.child?.reply_turn_id || null,
    });
    projected.child = ctx.child || null;
    projected.group_id = record.group_id;
    projected.options = structuredClone(record.options);
    projected.options_editable = state === 'pending';
  }
  return projected;
}

module.exports = { projectProposal };
