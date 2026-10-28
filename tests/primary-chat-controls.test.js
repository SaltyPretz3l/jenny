'use strict';

/* services/primary-chat-controls.js (row 76 S1): pause/resume, standing launch
 * permissions, the match port, history and the change event, over a fake shell
 * config service and session store. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrimaryChatControls } = require('../services/primary-chat-controls');
const { applyPrimaryChatPatch, normalizePrimaryChat } = require('../services/shell-config-primary-chat');

const PRIMARY = 'sess_primary';
const OTHER = 'sess_other';
const DAY = 24 * 60 * 60 * 1000;

function harness(overrides = {}) {
  const config = { block: normalizePrimaryChat({}), writes: 0, failWith: null };
  const configService = {
    getState: () => ({ primaryChat: JSON.parse(JSON.stringify(config.block)) }),
    updatePrimaryChat(patch) {
      if (config.failWith) throw Object.assign(new Error(config.failWith), { reason: config.failWith });
      const next = applyPrimaryChatPatch(config.block, patch);
      if (JSON.stringify(next) !== JSON.stringify(config.block)) { config.block = next; config.writes += 1; }
      return JSON.parse(JSON.stringify(config.block));
    },
  };
  const summaries = [
    { id: OTHER, created_at: '2026-01-01T00:00:00.000Z', session_role: null },
    { id: PRIMARY, created_at: '2026-02-01T00:00:00.000Z', session_role: 'primary' },
  ];
  const sessionStore = {
    listSessions: () => summaries,
    peekSessionSummary: (id) => summaries.find((entry) => entry.id === id) || null,
  };
  const state = { flags: {}, clock: Date.parse('2026-10-25T12:00:00.000Z'), ids: 0, projects: new Set(['project_a', 'project_b']) };
  const events = [];
  const logs = [];
  const wakeCalls = [];
  const options = {
    configService: () => configService,
    sessionStore: () => sessionStore,
    featureFlags: () => state.flags,
    projectService: () => ({ get: (id) => (state.projects.has(id) ? { id, name: `Name ${id}` } : null) }),
    resumeWake: async (id) => { wakeCalls.push(id); return { outcome: 'submitted' }; },
    createId: () => `lp_${(state.ids += 1).toString(16).padStart(32, '0')}`,
    now: () => new Date(state.clock),
    log: (level, event, details) => logs.push({ level, event, details }),
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { controls: createPrimaryChatControls(options), config, state, events, logs, wakeCalls, summaries };
}

test('primary id, flags and isPaused', async () => {
  const { controls, state } = harness();
  assert.equal(controls.primarySessionId(), PRIMARY);
  assert.equal(controls.controlsEnabled(), true);
  assert.equal(controls.launchPermissionEnabled(), true);
  assert.equal(controls.isPaused(PRIMARY), false);
  await controls.pause();
  assert.equal(controls.isPaused(PRIMARY), true);
  assert.equal(controls.isPaused(OTHER), false, 'a non-primary id is never paused');
  assert.equal(controls.isPaused(''), false);
  assert.equal(controls.isPaused(undefined), false);
  state.flags = { primary_chat_controls: false };
  assert.equal(controls.isPaused(PRIMARY), false);
  assert.equal(controls.controlsEnabled(), false);
  assert.equal(controls.launchPermissionEnabled(), true);
  state.flags = { primary_chat: false };
  assert.equal(controls.isPaused(PRIMARY), false);
  assert.equal(controls.primarySessionId(), null);
  assert.equal(controls.launchPermissionEnabled(), false);
});

test('isPaused never throws when dependencies are missing or throw', () => {
  const missing = createPrimaryChatControls({});
  assert.equal(missing.isPaused(PRIMARY), false);
  assert.equal(missing.primarySessionId(), null);
  assert.equal(missing.matchLaunchPermission({ sessionId: PRIMARY, destinationProjectId: 'p', runMode: 'ask' }), null);
  const throwing = createPrimaryChatControls({
    configService: () => { throw new Error('x'); }, sessionStore: () => { throw new Error('y'); }, featureFlags: () => { throw new Error('z'); },
  });
  assert.equal(throwing.isPaused(PRIMARY), false);
  assert.equal(throwing.getState().ok, false);
});

test('pause is idempotent and records history only on a change; emit follows each write', async () => {
  const { controls, config, events } = harness();
  const first = await controls.pause();
  assert.equal(first.ok, true);
  assert.equal(first.paused, true);
  assert.match(first.paused_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const second = await controls.pause();
  assert.equal(second.ok, true);
  assert.equal(second.paused_at, first.paused_at, 'the original time is kept');
  assert.deepEqual(config.block.history.map((entry) => entry.kind), ['paused']);
  assert.equal(config.writes, 1);
  assert.deepEqual(events, [{ schema_version: 1, session_id: PRIMARY, paused: true }]);
});

test('resume wakes once with the primary id, is idempotent, and survives a throwing port', async () => {
  const { controls, config, wakeCalls, events } = harness();
  assert.deepEqual(await controls.resume(), { ok: true, paused: false, paused_at: null, woke: null }, 'resume while not paused');
  assert.deepEqual(wakeCalls, [], 'no wake when nothing was paused');
  await controls.pause();
  const resumed = await controls.resume();
  assert.deepEqual(resumed, { ok: true, paused: false, paused_at: null, woke: { outcome: 'submitted' } });
  assert.deepEqual(wakeCalls, [PRIMARY]);
  assert.deepEqual(config.block.history.map((entry) => entry.kind), ['paused', 'resumed']);
  await controls.resume();
  assert.equal(wakeCalls.length, 1);
  assert.equal(config.block.history.length, 2);
  assert.deepEqual(events.map((entry) => entry.paused), [true, false]);

  const bad = harness({ resumeWake: async () => { throw new Error('boom'); } });
  await bad.controls.pause();
  const outcome = await bad.controls.resume();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.woke, null);
  assert.equal(bad.controls.isPaused(PRIMARY), false);
  const none = harness({ resumeWake: null });
  await none.controls.pause();
  assert.equal((await none.controls.resume()).woke, null);
});

test('controls refuse when disabled, without a primary, or when the config cannot be written', async () => {
  const off = harness();
  off.state.flags = { primary_chat_controls: false };
  assert.deepEqual(await off.controls.pause(), { ok: false, reason: 'disabled' });
  assert.deepEqual(await off.controls.resume(), { ok: false, reason: 'disabled' });
  off.state.flags = { primary_chat: false };
  assert.deepEqual(await off.controls.pause(), { ok: false, reason: 'disabled' });

  const none = harness();
  none.summaries.length = 0;
  assert.deepEqual(await none.controls.pause(), { ok: false, reason: 'not_found' });

  const failing = harness();
  failing.config.failWith = 'primary_chat_config_write_failed';
  assert.deepEqual(await failing.controls.pause(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(failing.logs.map((entry) => [entry.event, entry.details?.reason]),
    [['primary_chat.write_failed', 'primary_chat_config_write_failed']]);
  assert.equal(failing.events.length, 0);

  const noConfig = harness({ configService: () => null });
  assert.deepEqual(await noConfig.controls.pause(), { ok: false, reason: 'unavailable' });

  const future = harness();
  future.config.block = { schemaVersion: 9, x: 1 };
  assert.deepEqual(await future.controls.pause(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(future.controls.grantLaunch({ project_id: '*' }), { ok: false, reason: 'unavailable' });
  // A newer build's permission record may carry narrowing fields this build cannot read: never honoured.
  future.config.block = {
    schemaVersion: 9,
    launchPermissions: [{ permission_id: `lp_${'b'.repeat(32)}`, project_id: '*', run_modes: null, max_children_per_turn: 3, created_at: '2026-01-01T00:00:00.000Z', revoked_at: null, until: 'never' }, 'junk'],
    history: 'not a list',
  };
  assert.equal(future.controls.matchLaunchPermission({ sessionId: PRIMARY, destinationProjectId: 'project_a', runMode: 'ask' }), null);
  const shown = future.controls.getState();
  assert.equal(shown.ok, true);
  assert.deepEqual([shown.permissions.length, shown.permissions[0].permission_id, shown.history], [1, `lp_${'b'.repeat(32)}`, []]);
  assert.equal(future.controls.listPermissions().length, 1);
});

test('grantLaunch: project check, wildcard, idempotence, validation, capacity', () => {
  const { controls, config, events } = harness();
  assert.deepEqual(controls.grantLaunch({ project_id: 'project_zzz' }), { ok: false, reason: 'unknown_project' });
  const star = controls.grantLaunch({ project_id: '*' });
  assert.equal(star.ok, true);
  assert.equal(star.created, true);
  assert.deepEqual(Object.keys(star.permission),
    ['permission_id', 'project_id', 'run_modes', 'max_children_per_turn', 'created_at', 'revoked_at']);
  assert.equal(star.permission.run_modes, null);
  assert.equal(star.permission.max_children_per_turn, 1);
  const again = controls.grantLaunch({ project_id: '*', run_modes: null, max_children_per_turn: 1 });
  assert.deepEqual(again, { ok: true, permission: star.permission, created: false });
  assert.equal(config.block.launchPermissions.length, 1);
  const scoped = controls.grantLaunch({ project_id: 'project_a', run_modes: ['plan', 'ask'], max_children_per_turn: 2 });
  assert.deepEqual(scoped.permission.run_modes, ['ask', 'plan']);
  assert.equal(controls.grantLaunch({ project_id: 'project_a', run_modes: ['ask', 'plan'], max_children_per_turn: 2 }).created, false);
  assert.equal(controls.grantLaunch({ project_id: 'project_a', run_modes: ['ask', 'plan'], max_children_per_turn: 3 }).created, true);
  assert.deepEqual(config.block.history.map((entry) => entry.kind), ['permission_granted', 'permission_granted', 'permission_granted']);
  assert.equal(config.block.history[0].permission_id, star.permission.permission_id);
  assert.equal(events.length, 3, 'idempotent grants emit nothing');

  for (const bad of [
    { project_id: '' }, { project_id: 7 }, {}, { project_id: '*', run_modes: [] }, { project_id: '*', run_modes: ['x'] },
    { project_id: '*', run_modes: 'ask' }, { project_id: '*', max_children_per_turn: 0 }, { project_id: '*', max_children_per_turn: 4 },
    { project_id: '*', max_children_per_turn: 1.5 }, null,
  ]) {
    assert.deepEqual(controls.grantLaunch(bad), { ok: false, reason: 'invalid_request' }, JSON.stringify(bad));
  }
});

test('grantLaunch capacity: 32 live permissions, revoked ones do not count', () => {
  const { controls, state } = harness();
  const ids = [];
  for (let i = 0; i < 32; i += 1) {
    state.projects.add(`proj_${i}`);
    const granted = controls.grantLaunch({ project_id: `proj_${i}` });
    assert.equal(granted.ok, true, String(i));
    ids.push(granted.permission.permission_id);
  }
  state.projects.add('proj_over');
  assert.deepEqual(controls.grantLaunch({ project_id: 'proj_over' }), { ok: false, reason: 'capacity' });
  assert.equal(controls.grantLaunch({ project_id: 'proj_3' }).created, false, 'an identical grant is idempotent at capacity');
  assert.equal(controls.revokeLaunch({ permission_id: ids[0] }).ok, true);
  assert.equal(controls.grantLaunch({ project_id: 'proj_over' }).ok, true);
});

test('grantLaunch refuses when launch permission is off', () => {
  const { controls, state } = harness();
  state.flags = { primary_launch_permission: false };
  assert.deepEqual(controls.grantLaunch({ project_id: '*' }), { ok: false, reason: 'disabled' });
  state.flags = { primary_chat: false };
  assert.deepEqual(controls.grantLaunch({ project_id: '*' }), { ok: false, reason: 'disabled' });
});

test('revokeLaunch is idempotent, validates the id, and keeps history', () => {
  const { controls, config, events, state } = harness();
  const { permission } = controls.grantLaunch({ project_id: 'project_a' });
  const revoked = controls.revokeLaunch({ permission_id: permission.permission_id });
  assert.equal(revoked.ok, true);
  assert.notEqual(revoked.permission.revoked_at, null);
  const revokedAt = revoked.permission.revoked_at;
  state.clock += 1000;
  const again = controls.revokeLaunch({ permission_id: permission.permission_id });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.permission.revoked_at, revokedAt, 'the first revocation time stays');
  assert.deepEqual(config.block.history.map((entry) => entry.kind), ['permission_granted', 'permission_revoked']);
  assert.equal(events.length, 2);
  assert.deepEqual(controls.revokeLaunch({ permission_id: `lp_${'f'.repeat(32)}` }), { ok: false, reason: 'not_found' });
  assert.deepEqual(controls.revokeLaunch({ permission_id: 'nope' }), { ok: false, reason: 'invalid_request' });
  assert.deepEqual(controls.revokeLaunch({}), { ok: false, reason: 'invalid_request' });
});

test('revoked permissions are pruned 30 days after revocation on the next write', () => {
  const { controls, config, state } = harness();
  const { permission } = controls.grantLaunch({ project_id: 'project_a' });
  controls.revokeLaunch({ permission_id: permission.permission_id });
  state.clock += 29 * DAY;
  controls.grantLaunch({ project_id: 'project_b' });
  assert.equal(config.block.launchPermissions.length, 2, 'inside retention');
  assert.equal(controls.listPermissions({ include_revoked: false }).length, 1);
  assert.equal(controls.listPermissions().length, 2);
  state.clock += 2 * DAY;
  controls.grantLaunch({ project_id: '*' });
  assert.deepEqual(config.block.launchPermissions.map((entry) => entry.project_id).sort(), ['*', 'project_b']);
});

test('listPermissions and getState attach project names', async () => {
  const { controls } = harness();
  controls.grantLaunch({ project_id: 'project_a' });
  controls.grantLaunch({ project_id: '*' });
  const list = controls.listPermissions();
  const byProject = Object.fromEntries(list.map((entry) => [entry.project_id, entry.project]));
  assert.deepEqual(byProject.project_a, { id: 'project_a', name: 'Name project_a' });
  assert.equal(byProject['*'], null);
  await controls.pause();
  const snapshot = controls.getState();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.session_id, PRIMARY);
  assert.equal(snapshot.paused, true);
  assert.match(snapshot.paused_at, /Z$/);
  assert.equal(snapshot.permissions.length, 2);
  assert.deepEqual(snapshot.history.map((entry) => entry.kind), ['permission_granted', 'permission_granted', 'paused']);
  assert.deepEqual(snapshot.flags, { controls: true, launch_permission: true, activity_log: true });
});

test('getState reflects flags and works when the primary chat is off', () => {
  const { controls, state } = harness();
  state.flags = { primary_chat_controls: false, primary_activity_log: false };
  assert.deepEqual(controls.getState().flags, { controls: false, launch_permission: true, activity_log: false });
  state.flags = { primary_chat: false };
  const off = controls.getState();
  assert.deepEqual(off.flags, { controls: false, launch_permission: false, activity_log: false });
  assert.equal(off.session_id, null);
});

test('matchLaunchPermission: exact project beats wildcard, run-mode scoping, revoked ignored', () => {
  const { controls, state } = harness();
  const star = controls.grantLaunch({ project_id: '*', max_children_per_turn: 2 }).permission;
  const exact = controls.grantLaunch({ project_id: 'project_a', max_children_per_turn: 3 }).permission;
  const planOnly = controls.grantLaunch({ project_id: 'project_b', run_modes: ['plan'] }).permission;
  const match = (extra) => controls.matchLaunchPermission({ sessionId: PRIMARY, destinationProjectId: 'project_a', runMode: 'ask', ...extra });

  const hit = match({});
  assert.deepEqual({ ...hit }, { permission_id: exact.permission_id, max_children_per_turn: 3 });
  assert.equal(Object.isFrozen(hit), true);
  assert.deepEqual({ ...match({ destinationProjectId: 'project_zzz' }) }, { permission_id: star.permission_id, max_children_per_turn: 2 });
  assert.equal(match({ destinationProjectId: 'project_b', runMode: 'plan' }).permission_id, planOnly.permission_id);
  assert.equal(match({ destinationProjectId: 'project_b', runMode: 'ask' }).permission_id, star.permission_id, 'falls through to the wildcard');
  controls.revokeLaunch({ permission_id: exact.permission_id });
  assert.equal(match({}).permission_id, star.permission_id, 'revoked ignored');
  controls.revokeLaunch({ permission_id: star.permission_id });
  assert.equal(match({}), null);
  assert.equal(match({ destinationProjectId: 'project_b', runMode: 'plan' }).permission_id, planOnly.permission_id);
  assert.equal(match({ destinationProjectId: 'project_b', runMode: 'auto' }), null);
  assert.equal(match({ sessionId: OTHER, destinationProjectId: 'project_b', runMode: 'plan' }), null, 'non-primary caller');
  assert.equal(match({ sessionId: undefined, destinationProjectId: 'project_b', runMode: 'plan' }), null);
  state.flags = { primary_launch_permission: false };
  assert.equal(match({ destinationProjectId: 'project_b', runMode: 'plan' }), null, 'flag off');
  state.flags = { primary_chat: false };
  assert.equal(match({ destinationProjectId: 'project_b', runMode: 'plan' }), null, 'primary chat off');
});

test('recordHistory validates the kind, bounds the log, and emits', () => {
  const { controls, config, events } = harness();
  assert.equal(controls.recordHistory('reset'), true);
  assert.equal(controls.recordHistory('forgot', { permission_id: `lp_${'a'.repeat(32)}` }), true);
  assert.equal(controls.recordHistory('bogus'), false);
  assert.equal(controls.recordHistory('reset', { permission_id: 'bad' }), true, 'a bad optional id is dropped, not fatal');
  assert.deepEqual(config.block.history.map((entry) => entry.kind), ['reset', 'forgot', 'reset']);
  assert.equal(config.block.history[2].permission_id, undefined);
  assert.equal(events.length, 3);
  for (let i = 0; i < 60; i += 1) controls.recordHistory('reset');
  assert.equal(config.block.history.length, 50);
  const off = harness();
  off.state.flags = { primary_chat: false };
  assert.equal(off.controls.recordHistory('reset'), false);
});

test('a throwing emit or log never breaks a write', async () => {
  const { controls, config } = harness({ emit: () => { throw new Error('bridge'); }, log: () => { throw new Error('log'); } });
  assert.equal((await controls.pause()).ok, true);
  assert.equal(config.block.history.length, 1);
});
