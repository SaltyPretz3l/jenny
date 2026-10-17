'use strict';

/* Row 59 checkpoint 3 batch-review fixes on the Run decision path: the offline-lockdown
 * gate (failing closed), the D6 gate re-read after the binding recheck's await, and
 * lowercase-only decision ids at the IPC contract. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createCommandFixture } = require('./helpers/chat-proposal-command-fixture');

test('review #1: offline lockdown refuses Run; a throwing lockdown probe fails closed', async (t) => {
  let locked = true;
  const fx = createCommandFixture(t, { isOfflineLockdown: () => { if (locked === 'throw') throw new Error('x'); return locked; } });
  const proposal = (await fx.publishRun(1)).proposal;
  assert.deepEqual((await fx.get(proposal.proposal_id)).actions.run, { available: false, reason: 'lockdown' });
  const refused = await fx.decide(proposal, 'run');
  assert.deepEqual([refused.ok, refused.reason, refused.error_code], [false, 'lockdown', CODES.UNAVAILABLE]);
  locked = 'throw';
  assert.equal((await fx.decide(proposal, 'run')).reason, 'lockdown');
  locked = false;
  assert.equal((await fx.decide(proposal, 'run')).ok, true);
  assert.equal(fx.cmd.submits.length, 1);
});

test('review #6: a mode flip during the binding recheck still refuses Run (D6 re-read after the await)', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  // The fake reads recheckResult inside the awaited recheck: flip to Plan mode right there.
  Object.defineProperty(fx.cmd, 'recheckResult', { configurable: true, get() {
    fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
    return { ok: true };
  } });
  const refused = await fx.decide(proposal, 'run');
  assert.deepEqual([refused.ok, refused.reason], [false, 'plan_mode']);
  assert.equal(fx.cmd.submits.length, 0);
  assert.equal((await fx.get(proposal.proposal_id)).decision_state, 'pending');
});

test('review #13: an uppercase decision id is refused at the contract', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  const refused = await fx.decide(proposal, 'run', { decision_id: randomUUID().toUpperCase() });
  assert.deepEqual([refused.ok, refused.reason], [false, 'invalid_request']);
  assert.equal(fx.cmd.submits.length, 0);
});
