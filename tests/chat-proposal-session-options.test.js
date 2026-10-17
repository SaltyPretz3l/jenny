'use strict';

/* Session-kind getCapabilities, setOptions and startAll (row 59 checkpoint 5a-1). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const S = require('../services/backend/chat-proposal-session-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createSessionFixture } = require('./helpers/chat-proposal-session-fixture');

async function group(fx, count, turn = 'turn_g') {
  const rows = [];
  for (let n = 1; n <= count; n += 1) {
    rows.push((await fx.publishSession(n, { initiation: 'own_initiative', title: `Task ${n}`, group_key: 'followups', turn })).proposal);
  }
  return rows;
}

const startAllRequest = (fx, rows, extra = {}) => fx.request({
  group_id: rows[0].group_id,
  decision_id: randomUUID(),
  items: rows.map((row) => ({ proposal_id: row.proposal_id, expected_revision: row.revision })),
  ...extra,
});

test('getCapabilities lists destinations, models, efforts and the run modes; a Plan source offers only plan', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  const caps = await fx.service.getCapabilities(fx.request({ proposal_id: proposal.proposal_id }));
  assert.equal(caps.ok, true, JSON.stringify(caps));
  assert.deepEqual(caps.destinations.map((d) => [d.project_id, d.available]), [['proj_1', true], ['proj_2', true]]);
  assert.deepEqual(caps.models, [{ id: 'model_a', label: 'Model A' }]);
  assert.deepEqual(caps.reasoning_efforts, ['low', 'high']);
  assert.deepEqual(caps.run_modes, ['agent', 'plan']);
  assert.deepEqual(caps.restrictions, { read_only: false, plan_mode: false, lockdown: false });
  assert.equal(caps.unavailable_reason, null);

  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
  const planned = await fx.service.getCapabilities(fx.request({ proposal_id: proposal.proposal_id }));
  assert.deepEqual(planned.run_modes, ['plan']);
  assert.deepEqual(planned.restrictions, { read_only: false, plan_mode: true, lockdown: false });

  fx.ctl.handoffSupported = false;
  assert.equal((await fx.service.getCapabilities(fx.request({ proposal_id: proposal.proposal_id }))).unavailable_reason, 'unsupported_capability');
  await fx.decide(proposal, 'dismiss');
  assert.equal((await fx.service.getCapabilities(fx.request({ proposal_id: proposal.proposal_id }))).unavailable_reason, 'dismissed');
});

test('getCapabilities clips labels to 512 bytes, drops duplicates and survives failing ports; it rejects other kinds', async (t) => {
  const fx = createSessionFixture(t, {
    serviceOptions: {
      listDestinations: () => [{ project_id: 'p', label: 'é'.repeat(400), available: true }, { project_id: 'p', label: 'dup', available: true }, { project_id: 7 }],
      listModelOptions: () => { throw new Error('C:\\secret\\catalog'); },
    },
  });
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  const caps = await fx.service.getCapabilities(fx.request({ proposal_id: proposal.proposal_id }));
  assert.equal(caps.destinations.length, 1);
  assert.ok(Buffer.byteLength(caps.destinations[0].label, 'utf8') <= 512);
  assert.deepEqual([caps.models, caps.reasoning_efforts], [[], []]);
  assert.doesNotMatch(JSON.stringify(caps), /secret/u);
  const git = (await fx.publishGit(2)).proposal;
  assert.equal((await fx.service.getCapabilities(fx.request({ proposal_id: git.proposal_id }))).reason, 'invalid_request');
  assert.equal((await fx.service.getCapabilities(fx.request({ proposal_id: proposal.proposal_id, extra: 1 }))).reason, 'invalid_request');
  assert.equal((await fx.service.getCapabilities(fx.request({ proposal_id: `proposal_${'0'.repeat(64)}` }))).reason, 'not_found');
});

test('setOptions edits a pending proposal only, with capability values, one revision per edit', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  const options = fx.options({ destination_project_id: 'proj_2', preferred_model: 'model_a', reasoning_effort: 'high', run_mode: 'plan' });
  const done = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 1, options }));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.created, false);
  assert.deepEqual([done.proposal.options, done.proposal.revision], [options, 2]);

  const stale = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 1, options }));
  assert.deepEqual([stale.reason, stale.error_code, stale.current_revision], ['stale_revision', CODES.STALE_REVISION, 2]);
  for (const bad of [
    fx.options({ destination_project_id: 'proj_unknown' }), fx.options({ preferred_model: 'model_unknown' }),
    fx.options({ reasoning_effort: 'extreme' }), { ...fx.options(), run_mode: 'danger' }, { ...fx.options(), extra: 1 },
  ]) {
    const refused = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 2, options: bad }));
    assert.equal(refused.reason, 'invalid_request', JSON.stringify(bad));
  }
  assert.equal(fx.record(proposal.proposal_id).revision, 2);

  fx.ctl.destinations = [{ project_id: 'proj_1', label: 'One', available: false }, { project_id: 'proj_2', label: 'Two', available: false }];
  const unavailable = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 2, options: fx.options({ destination_project_id: 'proj_1' }) }));
  assert.equal(unavailable.reason, 'invalid_request', 'only an available destination is a capability');
  const kept = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 2, options }));
  assert.equal(kept.ok, true, 'values unchanged from the record stay acceptable');

  await fx.decide(await fx.get(proposal.proposal_id), 'new_session');
  const locked = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 4, options: fx.options() }));
  assert.equal(locked.reason, 'not_pending');
  assert.deepEqual(fx.record(proposal.proposal_id).decision.options, options, 'the accepted snapshot is the edited options');
});

test('setOptions on a Plan source accepts only plan', async (t) => {
  const fx = createSessionFixture(t);
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative', binding: { run_mode: 'plan', restrictions: { read_only: true, plan_mode: true } } });
  const refused = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 1, options: fx.options({ run_mode: 'agent' }) }));
  assert.equal(refused.reason, 'invalid_request');
  const kept = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 1, options: fx.options({ run_mode: 'plan' }) }));
  assert.equal(kept.ok, true);
});

test('setOptions rejects an expired proposal and another kind', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  const git = (await fx.publishGit(2)).proposal;
  assert.equal((await fx.service.setOptions(fx.request({ proposal_id: git.proposal_id, expected_revision: 1, options: fx.options() }))).reason, 'invalid_request');
  fx.advanceDays(8);
  const expired = await fx.service.setOptions(fx.request({ proposal_id: proposal.proposal_id, expected_revision: 1, options: fx.options() }));
  assert.deepEqual([expired.ok, expired.reason, expired.error_code], [false, 'expired', CODES.EXPIRED]);
});

test('startAll starts a snapshot of pending rows; one stale and one already-started row do not stop the rest', async (t) => {
  const fx = createSessionFixture(t);
  const rows = await group(fx, 4);
  await fx.decide(rows[1], 'do_it_here'); // already started by hand
  await fx.service.setOptions(fx.request({ proposal_id: rows[2].proposal_id, expected_revision: 1, options: fx.options({ run_mode: 'plan' }) })); // makes the snapshot revision stale
  const request = startAllRequest(fx, rows);
  const outcome = await fx.service.startAll(request);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.results.map((row) => row.proposal_id), rows.map((row) => row.proposal_id));
  assert.deepEqual(outcome.results.map((row) => row.ok), [true, false, false, true]);
  assert.equal(outcome.results[1].reason, 'stale_revision');
  assert.equal(outcome.results[2].reason, 'stale_revision');
  assert.equal('schema_version' in outcome.results[0], false);
  assert.equal(outcome.results[0].proposal.action_state, 'queued');
  const decisionOf = (row) => fx.record(row.proposal_id).decision.decision_id;
  assert.equal(decisionOf(rows[0]), S.derivedUuid('start_all', request.decision_id, rows[0].proposal_id));
  assert.equal(fx.record(rows[1].proposal_id).decision.choice, 'do_it_here', 'the manual choice is untouched');
  assert.equal(fx.record(rows[2].proposal_id).decision_state, 'pending');
  assert.equal(fx.runtime.submits.length, 3, 'one do_it_here and two preparation turns');
});

test('replaying the group decision replays every row without a second start', async (t) => {
  const fx = createSessionFixture(t);
  const rows = await group(fx, 3);
  const request = startAllRequest(fx, rows);
  const first = await fx.service.startAll(request);
  assert.deepEqual(first.results.map((row) => [row.ok, row.created]), [[true, true], [true, true], [true, true]]);
  const submits = fx.runtime.submits.length;
  const replay = await fx.service.startAll(request);
  assert.deepEqual(replay.results.map((row) => [row.ok, row.created]), [[true, false], [true, false], [true, false]]);
  assert.equal(fx.runtime.submits.length, submits);
  const conflict = await fx.service.startAll({ ...request, items: request.items.slice(0, 2) });
  assert.equal(conflict.ok, true);
  assert.equal(conflict.results.every((row) => row.created === false), true);
});

test('startAll validates the closed request, group membership and the ten-row cap', async (t) => {
  const fx = createSessionFixture(t);
  const rows = await group(fx, 2);
  const other = (await fx.publishSession(9, { initiation: 'own_initiative', title: 'Loose' })).proposal;
  const good = startAllRequest(fx, rows);
  for (const bad of [
    { ...good, items: [] }, { ...good, items: [good.items[0], good.items[0]] }, { ...good, group_id: 'nope' }, { ...good, decision_id: 'nope' },
    { ...good, items: Array.from({ length: 11 }, (_, n) => ({ proposal_id: `proposal_${String(n).padStart(64, '0')}`, expected_revision: 1 })) },
    { ...good, items: [{ proposal_id: good.items[0].proposal_id }] }, { ...good, extra: 1 },
  ]) {
    assert.equal((await fx.service.startAll(bad)).reason, 'invalid_request', JSON.stringify(bad).slice(0, 80));
  }
  const mixed = await fx.service.startAll({ ...good, items: [good.items[0], { proposal_id: other.proposal_id, expected_revision: 1 }, { proposal_id: `proposal_${'0'.repeat(64)}`, expected_revision: 1 }] });
  assert.deepEqual(mixed.results.map((row) => row.ok), [true, false, false]);
  assert.deepEqual(mixed.results.slice(1).map((row) => row.reason), ['invalid_request', 'not_found']);
  assert.equal(fx.record(other.proposal_id).decision_state, 'pending');
});

test('grouped rows are unsolicited suggestions: Start all never makes them wait', async (t) => {
  const fx = createSessionFixture(t);
  const rows = await group(fx, 1);
  const outcome = await fx.service.startAll(startAllRequest(fx, rows));
  assert.equal(outcome.results[0].proposal.action_state, 'queued', 'unsolicited suggestions never wait');
});
