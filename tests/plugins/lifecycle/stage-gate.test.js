'use strict';

// The structural disabled-only fence. These tests are the reason the fence is
// structural rather than conventional: the permitted-state table is asserted
// against state-machine.js's own STATES list (so a new state cannot quietly
// become permitted), the forbidden set is asserted to contain exactly the
// activation-adjacent states, and the contribution gate is proven to fail
// CLOSED on kinds it has never heard of.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTROL_PLANE_STAGE,
  STAGE_PERMITTED_STATES,
  STAGE_FORBIDDEN_STATES,
  DISABLED_ONLY_STATE,
  NON_EXECUTING_CONTRIBUTION_KINDS,
  MAX_REPORTED_DOWNGRADES,
  stagePermittedStates,
  assertStagePermitsState,
  assertNoContributionExecution,
  filterToDisabledOnly,
} = require('../../../services/plugins/lifecycle/stage-gate');
const { STATES } = require('../../../services/plugins/lifecycle/state-machine');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');

test('the stage-3 permitted-state table is exactly the disabled-only vocabulary', () => {
  assert.deepEqual(
    [...STAGE_PERMITTED_STATES[3]].sort(),
    ['absent', 'blocked', 'installed_disabled', 'quarantined', 'staged', 'uninstalling']
  );
  // Exhaustive, not a floor: permitted + forbidden must partition STATES, so a
  // state added to the machine cannot land in neither bucket unnoticed.
  assert.ok(Object.isFrozen(STAGE_PERMITTED_STATES));
  assert.ok(Object.isFrozen(STAGE_PERMITTED_STATES[3]));
});

test('assertStagePermitsState throws POLICY_BLOCKED for every forbidden state', () => {
  const stage3Forbidden = STATES.filter((state) => !STAGE_PERMITTED_STATES[3].includes(state));
  for (const state of STAGE_PERMITTED_STATES[3]) {
    assert.deepEqual(assertStagePermitsState(state, { stage: 3 }), { ok: true, stage: 3, state });
  }
  for (const state of stage3Forbidden) {
    assert.throws(
      () => assertStagePermitsState(state, { stage: 3 }),
      (error) => {
        assert.equal(error.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
        assert.equal(error.reason, 'stage_forbids_state');
        assert.equal(error.detail.state, state);
        return true;
      },
      `stage 3 must refuse ${state}`
    );
  }
});

test('the guard defaults to stage 8 and admits only stable Stage-8 states', () => {
  assert.equal(CONTROL_PLANE_STAGE, 8);
  assert.deepEqual([...STAGE_PERMITTED_STATES[8]], ['installed_disabled', 'active', 'blocked', 'quarantined']);
  assert.equal(
    STAGE_PERMITTED_STATES[8].length + STAGE_FORBIDDEN_STATES.length,
    STATES.length,
    'current permitted and forbidden sets must partition the state machine'
  );
  assert.deepEqual(
    [...STAGE_FORBIDDEN_STATES].sort(),
    STATES.filter((state) => !STAGE_PERMITTED_STATES[8].includes(state)).sort()
  );
  assert.deepEqual(assertStagePermitsState('active'), { ok: true, stage: 8, state: 'active' });
  assert.deepEqual(assertStagePermitsState('quarantined'), { ok: true, stage: 8, state: 'quarantined' });
  assert.deepEqual(assertStagePermitsState('active', { stage: 4 }), { ok: true, stage: 4, state: 'active' });
  assert.throws(() => assertStagePermitsState('preparing'), /may not commit state preparing/);
  assert.throws(() => assertStagePermitsState('disabling'), /may not commit state disabling/);
  assert.throws(() => assertStagePermitsState('not_a_state'), /is not a lifecycle state/);
  assert.throws(() => assertStagePermitsState(undefined), /is not a lifecycle state/);
  assert.equal(stagePermittedStates(9), null);
});

test('Stage 8 admits its four privileged declarations but Stage 7 still rejects them', () => {
  for (const kind of ['native_mcp', 'session_provider', 'engine_adapter', 'hook']) {
    assert.equal(assertNoContributionExecution({ contributions: [{ kind }] }).ok, true, kind);
    assert.equal(assertNoContributionExecution({ contributions: [{ kind }] }, { stage: 7 }).ok, false, kind);
  }
});

test('the contribution gate refuses each of the four still-forbidden surfaces', () => {
  const cases = [
    { descriptor: { contributions: [{ kind: 'tool', contribution_id: 'run' }] }, reason: 'contribution_kind_not_permitted' },
    { descriptor: { contributions: [{ kind: 'skill', executes: true }] }, reason: 'contribution_declares_execution' },
    { descriptor: { contributions: [{ kind: 'skill', entrypoint: 'main.js' }] }, reason: 'contribution_declares_execution' },
    { descriptor: { contributions: [], network: [{ destination: 'example.test' }] }, reason: 'plugin_network_declared' },
    { descriptor: { contributions: [], views: [{ view_id: 'panel' }] }, reason: 'plugin_view_declared' },
    { descriptor: { contributions: [], mcp_servers: [{ server_id: 'x' }] }, reason: 'mcp_server_declared' },
    { descriptor: { contributions: [], mcpServers: [{ server_id: 'x' }] }, reason: 'mcp_server_declared' },
    { descriptor: { contributions: [], networkDeclarations: ['a'] }, reason: 'plugin_network_declared' },
    { descriptor: { contributions: [], viewDeclarations: ['a'] }, reason: 'plugin_view_declared' },
  ];
  for (const item of cases) {
    const verdict = assertNoContributionExecution(item.descriptor);
    assert.equal(verdict.ok, false, `expected refusal for ${item.reason}`);
    assert.equal(verdict.reason, item.reason);
    assert.equal(verdict.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }
});

test('unknown contribution kinds fail closed rather than being ignored', () => {
  // The forward-compat case that matters: a manifest revision adds a kind this
  // gate has never seen. Refusing is the only safe answer.
  for (const kind of ['future_kind', '', 'THEME', 'view', 'mcp_server', 'host']) {
    const verdict = assertNoContributionExecution({ contributions: [{ kind }] });
    assert.equal(verdict.ok, false, `kind ${JSON.stringify(kind)} must be refused`);
  }
  assert.deepEqual(NON_EXECUTING_CONTRIBUTION_KINDS, [
    'skill',
    'prompt',
    'theme',
    'settings_schema',
    'command',
    'workflow',
    'mcp_descriptor',
    'setup_scene',
    'panel',
    'artifact_renderer',
    'provider_descriptor',
  ]);
});

test('the contribution gate admits all Stage-7 declarative manifest kinds', () => {
  const verdict = assertNoContributionExecution({
    contributions: [
      { kind: 'skill', contribution_id: 'a', name: 'A' },
      { kind: 'prompt', contribution_id: 'b', name: 'B' },
      { kind: 'theme', contribution_id: 'c', name: 'C' },
      { kind: 'settings_schema', contribution_id: 'd', name: 'D' },
      { kind: 'command', contribution_id: 'e', name: 'E' },
      { kind: 'workflow', contribution_id: 'f', name: 'F' },
      { kind: 'mcp_descriptor', contribution_id: 'g', name: 'G' },
      { kind: 'setup_scene', contribution_id: 'h', name: 'H' },
      { kind: 'panel', contribution_id: 'i', name: 'I' },
      { kind: 'artifact_renderer', contribution_id: 'j', name: 'J' },
      { kind: 'provider_descriptor', contribution_id: 'k', name: 'K' },
    ],
    network: [],
    views: [],
    mcp_servers: [],
  });
  assert.deepEqual(verdict, { ok: true, contributionCount: 11 });
  assert.deepEqual(assertNoContributionExecution({}), { ok: true, contributionCount: 0 });
});

test('a non-object descriptor is refused, not coerced', () => {
  for (const descriptor of [null, undefined, 'contributions', 42, []]) {
    const verdict = assertNoContributionExecution(descriptor);
    assert.equal(verdict.ok, false);
  }
  assert.equal(assertNoContributionExecution({ contributions: ['skill'] }).reason, 'contribution_not_an_object');
});

test('filterToDisabledOnly normalizes every entry and reports what it downgraded', () => {
  const plugins = STATES.map((state, index) => ({
    publisher_id: 'acme',
    plugin_id: `p${index}`,
    artifact_digest: 'a'.repeat(64),
    desired_state: state,
    effective_state: state,
    depends_on: [],
  }));
  const result = filterToDisabledOnly(plugins);

  assert.equal(result.plugins.length, STATES.length);
  for (const entry of result.plugins) {
    assert.equal(entry.effective_state, DISABLED_ONLY_STATE, 'every committed state must be installed_disabled');
  }
  // desired_state is intentionally preserved: it is Stage 4's durable input.
  assert.deepEqual(result.plugins.map((entry) => entry.desired_state).sort(), [...STATES].sort());

  // Everything except the already-disabled entry is reported as downgraded.
  assert.equal(result.downgradeCount, STATES.length - 1);
  assert.equal(result.downgraded.length, STATES.length - 1);
  const activeRow = result.downgraded.find((row) => row.requested_state === 'active');
  assert.deepEqual(activeRow, {
    publisher_id: 'acme',
    plugin_id: `p${STATES.indexOf('active')}`,
    requested_state: 'active',
    committed_state: DISABLED_ONLY_STATE,
  });
});

test('the downgrade report is bounded but the count is not', () => {
  const plugins = Array.from({ length: MAX_REPORTED_DOWNGRADES + 10 }, (_unused, index) => ({
    publisher_id: 'acme',
    plugin_id: `p${index}`,
    effective_state: 'active',
  }));
  const result = filterToDisabledOnly(plugins);
  assert.equal(result.downgraded.length, MAX_REPORTED_DOWNGRADES, 'the report must stay bounded');
  assert.equal(result.downgradeCount, MAX_REPORTED_DOWNGRADES + 10, 'the count must stay honest');
  assert.equal(result.plugins.length, MAX_REPORTED_DOWNGRADES + 10);
});

test('filterToDisabledOnly tolerates junk input without inventing entries', () => {
  assert.deepEqual(filterToDisabledOnly(null), { plugins: [], downgraded: [], downgradeCount: 0 });
  assert.deepEqual(filterToDisabledOnly(undefined).plugins, []);
  const junk = filterToDisabledOnly([null, 'x', ['y'], { effective_state: 'active' }]);
  assert.equal(junk.plugins.length, 1, 'only real entries are normalized');
  assert.equal(junk.downgradeCount, 1, 'junk must not inflate the downgrade count');
});
