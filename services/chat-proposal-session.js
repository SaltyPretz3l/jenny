'use strict';

/* services/chat-proposal-session.js - the bridge-facing methods of a `kind:"session"` proposal
 * (row 59 checkpoint 5a-1): publish (all three initiations, launch-grant consumption, group and
 * per-source caps), decide (Do it here / New session, with waiting_for_source for an unsettled
 * ordinary offer), startAll, setOptions and getCapabilities. Works on a ChatProposalService
 * instance (`svc`) through its record plumbing. D1: every state change is one synchronous store
 * mutation; no await runs inside one. Never logs a title, description, task or background.
 */

const flow = require('./chat-proposal-session-flow');
const grants = require('./chat-proposal-launch-grants');
const sc = require('./chat-proposal-session-contract');
const S = require('./backend/chat-proposal-session-records');
const { fail, isPlainObject, succeed } = require('./chat-proposal-contract');

const MAX_DESTINATIONS = 256;
const MAX_MODELS = 512;
const MAX_EFFORTS = 16;

// ---------- publish ----------

function publish(svc, {
  sessionId, sessionIncarnation, turnId, toolCallId, input, binding,
}) {
  const rec = svc._records;
  const read = svc._store.read(sessionId);
  if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
  if (read.frozen) return fail('unavailable');
  if (!isPlainObject(binding) || !isPlainObject(binding.session) || !isPlainObject(input)) return fail('invalid_request');
  let proposalId;
  try {
    proposalId = rec.computeProposalId(sessionIncarnation, turnId, toolCallId);
  } catch {
    return fail('invalid_request');
  }
  const asked = input.initiation === 'user_asked';
  const options = S.defaultOptions({
    sourceProjectId: binding.source_project_id,
    model: binding.model,
    effort: binding.effort,
    planMode: binding.restrictions?.plan_mode === true,
  });
  const nowDate = svc._now();
  // The binding the tool captured carries only the source's run mode and lockdown; the initiation
  // fields are resolved here, from the grant the store holds at the moment of the mutation.
  const build = (info) => rec.createProposalRecord({
    kind: 'session', sessionId, sessionIncarnation, turnId, toolCallId, input, options, now: nowDate,
    binding: { ...binding, session: { ...binding.session, ...info } },
  });
  const offerInfo = {
    effective_initiation: asked ? 'offer' : input.initiation, authorization_required: asked, launch_grant_ref: null,
  };
  const pre = build(offerInfo);
  if (!pre.ok) return fail(pre.reason === 'capacity' ? 'capacity' : 'invalid_request');
  const profileUnresolved = svc._store.countUnresolvedAcrossProfile();
  // A grant is spent only when the handoff path is negotiated; otherwise the request stays an offer.
  const canLaunch = asked && svc._handoffSupported();
  const current = { read_only: binding.restrictions.read_only === true, plan_mode: binding.restrictions.plan_mode === true, lockdown: binding.session.lockdown === true };
  const result = svc._store.mutate(sessionId, ({ records, launch_grants: stored }) => {
    const existing = records.find((entry) => entry.proposal_id === proposalId);
    if (existing) {
      return { abort: rec.canonicalJson(existing.normalized_input) === rec.canonicalJson(input)
        ? { existing } : { reason: 'idempotency_conflict', revision: existing.revision } };
    }
    const live = records.map((entry) => rec.expireIfDue(entry, nowDate) || entry);
    const groupCount = pre.record.group_id === null ? 0 : live.filter((entry) => entry.group_id === pre.record.group_id).length;
    if (live.filter(rec.isUnresolved).length >= rec.PROPOSAL_LIMITS.unresolved_per_source
      || profileUnresolved >= rec.PROPOSAL_LIMITS.unresolved_per_profile
      || groupCount >= S.SESSION_LIMITS.group_max) {
      return { abort: { reason: 'capacity' } };
    }
    let record = pre.record;
    let nextGrants = null;
    const grant = canLaunch ? grants.selectGrant(stored, {
      incarnation: sessionIncarnation, turnId, ref: input.authorization_ref, destination: options.destination_project_id,
      restrictions: current, now: nowDate,
    }) : null;
    if (grant) {
      const granted = build({ effective_initiation: 'user_asked', authorization_required: false, launch_grant_ref: grant.authorization_ref });
      const accepted = granted.ok
        ? S.acceptFromGrant(granted.record, { grantRef: grant.authorization_ref, now: nowDate, attemptId: svc._createId() }) : null;
      if (accepted) {
        record = accepted;
        nextGrants = grants.consumeGrant(stored, grant.authorization_ref);
      }
    }
    return { records: [...rec.pruneFinalized(live, nowDate), record], ...(nextGrants ? { launch_grants: nextGrants } : {}) };
  });
  if (!result.ok) return svc._storeFailure(result);
  if (result.aborted) {
    const { existing, reason, revision } = result.value;
    return existing ? succeed({ created: false, proposal: svc._project(existing) }) : fail(reason, { currentRevision: revision });
  }
  svc._changed(sessionId);
  const stored = result.records.find((entry) => entry.proposal_id === proposalId);
  if (stored.decision_state === 'accepted') {
    // An authorized request: prepare the new chat through the normal source-chat queue, after this call.
    svc._later(() => flow.dispatch(svc, sessionId, stored));
  } else if (stored.binding.session.effective_initiation === 'offer') {
    flow.registerOfferTurn(svc, turnId, sessionId);
  }
  return succeed({ created: true, proposal: svc._project(stored) });
}

// ---------- decide ----------

// The caller (service.decide) has passed the closed request, replay, revision, expiry and the
// capability gate. Persist the choice BEFORE any submission; an unsettled ordinary offer waits.
async function decide(svc, req, record) {
  const status = flow.sourceStatus(svc, record);
  if (status === 'ended') {
    flow.withdrawOffer(svc, record);
    return fail('not_pending', { currentRevision: svc._latest(req.session_id, record.proposal_id)?.revision ?? record.revision });
  }
  const waitForSource = status === 'waiting';
  const accepted = svc._persistDecision(req, record, (current) => S.acceptSessionDecision(current, {
    decisionId: req.decision_id, choice: req.choice, now: svc._now(), attemptId: svc._createId(), waitForSource,
  }), { envelope: false });
  if (!accepted.ok) return accepted.failure;
  if (waitForSource) flow.watchWaiting(svc, accepted.record);
  else await flow.dispatch(svc, req.session_id, accepted.record);
  return succeed({ created: true, proposal: svc._project(svc._latest(req.session_id, record.proposal_id) || accepted.record) });
}

// Start all: one New session decision per snapshot row; the row's decision id derives from the
// group decision id, so a replay of the whole request replays every row. A stale, already-started
// or failed row never stops the others.
async function startAll(svc, raw) {
  const checked = sc.validateStartAllRequest(raw);
  if (!checked.ok) return fail(checked.reason);
  const req = checked.value;
  const results = [];
  for (const item of req.items) {
    const found = svc._find(req.session_id, item.proposal_id);
    let outcome;
    if (!found.ok) outcome = fail(found.reason);
    else if (found.record.kind !== 'session' || found.record.group_id !== req.group_id) outcome = fail('invalid_request');
    else {
      outcome = await svc.decide({
        schema_version: 1,
        session_id: req.session_id,
        proposal_id: item.proposal_id,
        expected_revision: item.expected_revision,
        decision_id: S.derivedUuid('start_all', req.decision_id, item.proposal_id),
        choice: 'new_session',
      });
    }
    const { schema_version: _version, ...row } = outcome;
    results.push({ proposal_id: item.proposal_id, ...row });
  }
  return succeed({ results });
}

// ---------- capabilities and options ----------

async function listed(call, fallback) {
  try {
    const value = await call();
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function cleanDestinations(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const id = entry?.project_id;
    if (!(id === null || (typeof id === 'string' && id)) || seen.has(id) || out.length >= MAX_DESTINATIONS) continue;
    seen.add(id);
    out.push({ project_id: id, label: sc.clipLabel(entry.label), available: entry.available === true });
  }
  return out;
}

function cleanModels(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry?.id !== 'string' || !entry.id || seen.has(entry.id) || out.length >= MAX_MODELS) continue;
    seen.add(entry.id);
    out.push({ id: entry.id, label: sc.clipLabel(entry.label, entry.id) });
  }
  return out;
}

function cleanEfforts(list) {
  const out = [...new Set((Array.isArray(list) ? list : []).filter((value) => typeof value === 'string' && value && value.length <= 64))];
  return out.slice(0, MAX_EFFORTS);
}

async function buildCapabilities(svc, record) {
  const run = svc._runState(record.source_session_id);
  const planOnly = run.runMode === 'plan';
  const models = await listed(() => svc._ports.listModelOptions(record.source_session_id), {});
  let unavailable = null;
  if (record.decision_state !== 'pending') unavailable = record.decision_state;
  else if (!svc._handoffSupported()) unavailable = 'unsupported_capability';
  return {
    destinations: cleanDestinations(await listed(() => svc._ports.listDestinations(), [])),
    models: cleanModels(models?.models),
    reasoning_efforts: cleanEfforts(models?.reasoning_efforts),
    run_modes: planOnly ? ['plan'] : ['agent', 'plan'],
    restrictions: { read_only: run.readOnly, plan_mode: planOnly, lockdown: run.lockdown },
    unavailable_reason: unavailable,
  };
}

function findSessionRecord(svc, req) {
  const found = svc._find(req.session_id, req.proposal_id);
  if (!found.ok) return { failure: fail(found.reason) };
  if (found.record.kind !== 'session') return { failure: fail('invalid_request', { currentRevision: found.record.revision }) };
  return { record: found.record };
}

async function getCapabilities(svc, raw) {
  const checked = sc.validateCapabilitiesRequest(raw);
  if (!checked.ok) return fail(checked.reason);
  const { record, failure } = findSessionRecord(svc, checked.value);
  if (failure) return failure;
  return succeed({ ...(await buildCapabilities(svc, record)) });
}

// A value is acceptable when it is a current capability or unchanged from what the record holds
// (null model/effort = the source's automatic setting).
function optionsInCapabilities(options, current, caps) {
  const same = (key) => options[key] === current[key];
  return (same('destination_project_id') || caps.destinations.some((d) => d.available && d.project_id === options.destination_project_id))
    && (options.preferred_model === null || same('preferred_model') || caps.models.some((m) => m.id === options.preferred_model))
    && (options.reasoning_effort === null || same('reasoning_effort') || caps.reasoning_efforts.includes(options.reasoning_effort))
    && caps.run_modes.includes(options.run_mode);
}

async function setOptions(svc, raw) {
  const checked = sc.validateSetOptionsRequest(raw);
  if (!checked.ok) return fail(checked.reason);
  const req = checked.value;
  const first = findSessionRecord(svc, req);
  if (first.failure) return first.failure;
  const { record } = first;
  if (record.decision_state !== 'pending') return svc._notPending(record);
  if (record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: record.revision });
  const caps = await buildCapabilities(svc, record);
  if (!optionsInCapabilities(req.options, record.options, caps)) return fail('invalid_request', { currentRevision: record.revision });
  const applied = svc._apply(req.session_id, req.proposal_id, (cur) => {
    if (cur.revision !== req.expected_revision) return { abort: { reason: 'stale_revision', revision: cur.revision } };
    const next = S.setSessionOptions(cur, req.options);
    return next ? { record: next } : { abort: { reason: 'not_pending', revision: cur.revision } };
  });
  if (!applied.ok || applied.aborted) return applied.failure;
  return succeed({ created: false, proposal: svc._project(applied.record) });
}

module.exports = {
  authorizeLaunch: grants.authorizeLaunch,
  decide,
  getCapabilities,
  publish,
  setOptions,
  startAll,
};
