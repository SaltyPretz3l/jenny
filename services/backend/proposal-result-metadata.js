'use strict';

// Canonical persistence allowlist for the `propose_git_action`, `propose_command`,
// `propose_session` and `complete_session_handoff` tool results (row 59 checkpoints
// 3 and 5a). Only these keys survive; the command text, summaries, titles, paths
// and handoff text never do. The proposal record stays the source of truth, the
// card resolves it by `proposal_id`.
const RESULT_KINDS = new Set(['git_proposal', 'command_proposal', 'session_proposal', 'session_handoff']);
const INITIATIONS = new Set(['offer', 'own_initiative', 'user_asked']);
const TURN_BOUNDARIES = new Set(['awaiting_proposal', 'session_handoff_completed']);
const ADMISSION_STATES = new Set(['queued', 'admitted', 'needs_attention']);
const GROUP_ID_PATTERN = /^group_[0-9a-f]{64}$/;
const ID_KEYS = ['child_session_id', 'first_turn_work_id', 'first_turn_turn_id'];
const DECISION_STATES = new Set(['pending', 'accepted', 'dismissed', 'expired', 'withdrawn', 'stale']);
const ACTION_STATES = new Set([
  'none', 'waiting_for_source', 'queued', 'preparing', 'child_created', 'admitted',
  'succeeded', 'failed', 'cancelled', 'needs_attention',
]);
const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f]{64}$/;
const { isPlainObject } = require('../value-utils');

const isShortId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

// Optional session keys: each is kept only when present and well formed, never invented.
function sessionExtras(source) {
  const extras = {};
  if (INITIATIONS.has(source.effective_initiation)) extras.effective_initiation = source.effective_initiation;
  if (typeof source.authorization_required === 'boolean') extras.authorization_required = source.authorization_required;
  if (source.group_id === null || (typeof source.group_id === 'string' && GROUP_ID_PATTERN.test(source.group_id))) {
    if (Object.hasOwn(source, 'group_id')) extras.group_id = source.group_id;
  }
  if (TURN_BOUNDARIES.has(source.turn_boundary)) extras.turn_boundary = source.turn_boundary;
  if (ADMISSION_STATES.has(source.admission_state)) extras.admission_state = source.admission_state;
  for (const key of ID_KEYS) if (isShortId(source[key])) extras[key] = source[key];
  return extras;
}

function normalizeProposalResultMetadata(source) {
  try {
    if (!isPlainObject(source) || !RESULT_KINDS.has(source.result_kind)) return null;
    if (source.schema_version !== 1) return null;
    if (typeof source.proposal_id !== 'string' || !PROPOSAL_ID_PATTERN.test(source.proposal_id)) return null;
    if (!Number.isSafeInteger(source.revision) || source.revision < 1) return null;
    // A handoff result reports the child and first-turn admission; it carries no decision/action state.
    const handoff = source.result_kind === 'session_handoff';
    const stateOk = DECISION_STATES.has(source.decision_state) && ACTION_STATES.has(source.action_state);
    if (!handoff && !stateOk) return null;
    const result = {
      schema_version: 1,
      result_kind: source.result_kind,
      proposal_id: source.proposal_id,
      revision: source.revision,
    };
    if (stateOk) Object.assign(result, { decision_state: source.decision_state, action_state: source.action_state });
    if (source.result_kind === 'session_proposal' || handoff) Object.assign(result, sessionExtras(source));
    return result;
  } catch (_error) {
    return null;
  }
}

module.exports = { normalizeProposalResultMetadata };
