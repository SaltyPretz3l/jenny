'use strict';

/* services/chat-proposal-launch-grants.js - launch grants for propose_session(user_asked) (row 59
 * checkpoint 5a, D7): the trusted `authorizeLaunch` bridge method and the pure grant selection the
 * session publish uses to consume a grant in the SAME store mutation that creates the accepted
 * record. A grant binds one canonical user message and its logical turn (resolved by the service
 * from the persisted row, never sent by the renderer), lives one hour, and is spent only by a live
 * call of that same turn. Nothing here logs message text or ids beyond reason tokens.
 */

const { canonicalJson } = require('./backend/chat-proposal-records');
const { SESSION_LIMITS, pruneLaunchGrants } = require('./backend/chat-proposal-session-records');
const { LAUNCH_GRANT_TTL_MS } = require('./backend/session-coordination-records');
const { fail, succeed } = require('./chat-proposal-contract');
const { validateAuthorizeLaunchRequest } = require('./chat-proposal-session-contract');

const isoOf = (date) => new Date(date).toISOString();

// Live = not revoked, not exhausted, not expired.
function isLiveGrant(grant, now) {
  return grant.revoked_at === null && grant.remaining > 0 && Date.parse(grant.expires_at) > Date.parse(isoOf(now));
}

const activeGrantCount = (grants, now) => grants.filter((grant) => isLiveGrant(grant, now)).length;

// The grant must not be weaker than what the user authorized: a source that was read-only, in Plan
// or in lockdown when the grant was made must still be (the child inherits those, never fewer).
function notWeaker(grant, current) {
  const was = grant.restrictions;
  return (!was.read_only || current.read_only) && (!was.plan_mode || current.plan_mode) && (!was.lockdown || current.lockdown);
}

// The one live grant the calling turn may spend, or null. `ref` (the model's optional
// authorization_ref) must name that same grant; an omitted ref consumes the turn's own grant.
function selectGrant(grants, {
  incarnation, turnId, ref = null, destination = null, restrictions, now,
}) {
  return grants.find((grant) => isLiveGrant(grant, now)
    && grant.source_session_incarnation === incarnation && grant.source_turn_id === turnId
    && (ref === null || grant.authorization_ref === ref)
    && grant.destination_project_ids.includes(destination)
    && notWeaker(grant, restrictions)) || null;
}

const consumeGrant = (grants, ref) => grants.map((grant) => (grant.authorization_ref === ref
  ? { ...grant, remaining: grant.remaining - 1 } : grant));

function sameRequest(grant, req, turnId) {
  return grant.source_turn_id === turnId && grant.max_children === req.max_children
    && canonicalJson([...grant.destination_project_ids].sort()) === canonicalJson([...req.destination_project_ids].sort());
}

// authorizeLaunch: idempotent by (source_user_message_id, action_id); a different payload under that
// pair is idempotency_conflict; at most 20 live grants per session (capacity).
async function authorizeLaunch(svc, raw) {
  const checked = validateAuthorizeLaunchRequest(raw);
  if (!checked.ok) return fail(checked.reason);
  const req = checked.value;
  const sessionId = req.session_id;
  const first = svc._store.read(sessionId);
  if (!first.ok) return fail(first.reason === 'not_found' ? 'not_found' : 'unavailable');
  if (first.frozen) return fail('unavailable');
  if (first.session_incarnation !== req.expected_session_incarnation) return fail('authority_changed');
  let resolved;
  try { resolved = await svc._ports.resolveUserMessageTurn(sessionId, req.source_user_message_id); } catch { resolved = null; }
  const turnId = typeof resolved?.turn_id === 'string' && resolved.turn_id ? resolved.turn_id : null;
  if (!turnId) return fail('not_found', { retryable: true });
  const read = svc._store.read(sessionId);
  if (!read.ok || read.frozen) return fail('unavailable');
  if (read.session_incarnation !== req.expected_session_incarnation) return fail('authority_changed');
  const run = svc._runState(sessionId);
  const nowDate = svc._now();
  const result = svc._store.mutate(sessionId, ({ records, launch_grants: grants }) => {
    const existing = grants.find((grant) => grant.source_user_message_id === req.source_user_message_id
      && grant.action_id === req.action_id && grant.source_session_incarnation === req.expected_session_incarnation);
    if (existing) return { abort: sameRequest(existing, req, turnId) ? { grant: existing } : { reason: 'idempotency_conflict' } };
    const kept = pruneLaunchGrants(grants, records, nowDate);
    if (activeGrantCount(kept, nowDate) >= SESSION_LIMITS.active_grants_max) return { abort: { reason: 'capacity' } };
    const grant = {
      schema_version: 1,
      authorization_ref: svc._createId(),
      source_session_incarnation: req.expected_session_incarnation,
      source_user_message_id: req.source_user_message_id,
      source_turn_id: turnId,
      action_id: req.action_id,
      destination_project_ids: [...req.destination_project_ids],
      restrictions: { read_only: run.readOnly || run.runMode === 'plan', plan_mode: run.runMode === 'plan', lockdown: run.lockdown },
      created_at: isoOf(nowDate),
      expires_at: isoOf(Date.parse(isoOf(nowDate)) + LAUNCH_GRANT_TTL_MS),
      max_children: req.max_children,
      remaining: req.max_children,
      revoked_at: null,
    };
    return { records, launch_grants: [...kept, grant], created: grant };
  });
  if (!result.ok) return svc._storeFailure(result);
  if (result.aborted) {
    const { grant, reason } = result.value;
    return grant ? succeed(describe(grant)) : fail(reason);
  }
  svc._changed(sessionId);
  const stored = result.launch_grants.find((grant) => grant.source_user_message_id === req.source_user_message_id
    && grant.action_id === req.action_id);
  return stored ? succeed(describe(stored)) : fail('unavailable');
}

const describe = (grant) => ({
  authorization_ref: grant.authorization_ref, expires_at: grant.expires_at, remaining: grant.remaining,
});

module.exports = {
  activeGrantCount,
  authorizeLaunch,
  consumeGrant,
  isLiveGrant,
  selectGrant,
};
