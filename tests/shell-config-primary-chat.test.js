'use strict';

/* shell-config `primaryChat` block (row 76 S1): defaults, permission and history
 * normalization, caps, read-only future schema, state round trips, the write path
 * and the portable-preferences exclusion. No CONFIG_VERSION bump. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService, CONFIG_VERSION } = require('../services/shell-config-service');
const { normalizeState, serializeState } = require('../services/shell-config-state');
const { SHELL_CONFIG_PORTABILITY, projectPortableShellConfig } = require('../services/data-lifecycle/portable-preferences-store');
const {
  DEFAULT_PRIMARY_CHAT, PRIMARY_CHAT_HISTORY_KINDS, PRIMARY_CHAT_LIMITS, PRIMARY_LAUNCH_RUN_MODES, SCHEMA_VERSION,
  applyPrimaryChatPatch, isLivePermission, isReadOnlyPrimaryChat, normalizeLaunchPermission, normalizePrimaryChat,
} = require('../services/shell-config-primary-chat');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => { await cleanupTrackedResources(); });

const PID = (n) => `lp_${n.toString(16).padStart(32, '0')}`;
const AT = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const permission = (n, extra = {}) => ({
  permission_id: PID(n), project_id: 'project_x', run_modes: null, max_children_per_turn: 1,
  created_at: AT(n), revoked_at: null, ...extra,
});

function tempService(seed) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-primary-'));
  trackDirectory(userDataPath);
  if (seed) fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify(seed));
  return { userDataPath, service: new ShellConfigService({ userDataPath, env: {} }) };
}
const readDisk = (userDataPath) => JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));

test('constants and defaults', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual([...PRIMARY_LAUNCH_RUN_MODES], ['ask', 'auto', 'plan', 'propose']);
  assert.deepEqual([...PRIMARY_CHAT_HISTORY_KINDS],
    ['paused', 'resumed', 'reset', 'forgot', 'permission_granted', 'permission_revoked']);
  assert.deepEqual({ ...PRIMARY_CHAT_LIMITS }, {
    permissions_max: 32, history_max: 50, revoked_retention_ms: 30 * 24 * 60 * 60 * 1000,
    project_id_chars: 128, max_children_per_turn_max: 3,
  });
  assert.deepEqual(DEFAULT_PRIMARY_CHAT, { schemaVersion: 1, pausedAt: null, launchPermissions: [], history: [] });
  for (const value of [undefined, null, 7, 'x', [], {}, { schemaVersion: 1 }]) {
    assert.deepEqual(normalizePrimaryChat(value), DEFAULT_PRIMARY_CHAT, JSON.stringify(value));
  }
  assert.notEqual(normalizePrimaryChat({}).launchPermissions, DEFAULT_PRIMARY_CHAT.launchPermissions, 'fresh arrays');
});

test('a valid permission keeps its canonical key order and run modes are sorted and unique', () => {
  const record = normalizeLaunchPermission({
    revoked_at: null, created_at: AT(1), max_children_per_turn: 2, run_modes: ['propose', 'ask'],
    project_id: '*', permission_id: PID(1), extra: 'dropped',
  });
  assert.deepEqual(Object.keys(record), ['permission_id', 'project_id', 'run_modes', 'max_children_per_turn', 'created_at', 'revoked_at']);
  assert.deepEqual(record.run_modes, ['ask', 'propose']);
  assert.equal(record.project_id, '*');
  assert.equal(isLivePermission(record), true);
  assert.equal(isLivePermission({ ...record, revoked_at: AT(5) }), false);
});

test('invalid permission entries are dropped', () => {
  const good = permission(1);
  const bad = [
    { ...good, permission_id: 'lp_short' }, { ...good, permission_id: PID(2).toUpperCase() },
    { ...good, project_id: '' }, { ...good, project_id: 'a'.repeat(129) }, { ...good, project_id: 'a\nb' },
    { ...good, project_id: 7 },
    { ...good, run_modes: [] }, { ...good, run_modes: ['ask', 'ask'] }, { ...good, run_modes: ['nope'] }, { ...good, run_modes: 'ask' },
    { ...good, max_children_per_turn: 0 }, { ...good, max_children_per_turn: 4 }, { ...good, max_children_per_turn: 1.5 },
    { ...good, max_children_per_turn: '1' },
    { ...good, created_at: 'yesterday' }, { ...good, created_at: '2026-10-01' }, { ...good, created_at: '2026-13-45T00:00:00.000Z' },
    { ...good, revoked_at: 'x' }, { ...good, revoked_at: undefined },
    null, 'x', [], 7,
  ];
  for (const entry of bad) assert.equal(normalizeLaunchPermission(entry), null, JSON.stringify(entry));
  const block = normalizePrimaryChat({ launchPermissions: [...bad, good] });
  assert.deepEqual(block.launchPermissions, [good]);
  assert.deepEqual(normalizePrimaryChat({ launchPermissions: 'x' }).launchPermissions, []);
});

test('duplicates by permission_id keep the first; more than 32 keep the 32 newest by created_at', () => {
  const first = permission(1, { project_id: 'first' });
  const dupe = permission(1, { project_id: 'second' });
  assert.deepEqual(normalizePrimaryChat({ launchPermissions: [first, dupe] }).launchPermissions, [first]);
  const many = Array.from({ length: 40 }, (_unused, i) => permission(i + 1));
  const kept = normalizePrimaryChat({ launchPermissions: many }).launchPermissions;
  assert.equal(kept.length, 32);
  assert.equal(kept.some((entry) => entry.permission_id === PID(1)), false, 'oldest dropped');
  assert.equal(kept.some((entry) => entry.permission_id === PID(40)), true);
});

test('history: invalid dropped, optional permission_id validated, capped at 50 newest, oldest first', () => {
  const history = [
    { kind: 'paused', at: AT(1) },
    { kind: 'permission_granted', at: AT(2), permission_id: PID(1) },
    { kind: 'permission_revoked', at: AT(3), permission_id: 'nope' },
    { kind: 'bogus', at: AT(4) },
    { kind: 'resumed', at: 'x' },
    null, 'x',
  ];
  assert.deepEqual(normalizePrimaryChat({ history }).history, [
    { kind: 'paused', at: AT(1) },
    { kind: 'permission_granted', at: AT(2), permission_id: PID(1) },
  ]);
  const many = Array.from({ length: 60 }, (_unused, i) => ({ kind: 'paused', at: AT(i) }));
  const kept = normalizePrimaryChat({ history: many }).history;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].at, AT(10));
  assert.equal(kept[49].at, AT(59));
});

test('pausedAt is null or an ISO string', () => {
  assert.equal(normalizePrimaryChat({ pausedAt: AT(3) }).pausedAt, AT(3));
  for (const bad of ['x', 7, {}, '2026-10-01', true]) assert.equal(normalizePrimaryChat({ pausedAt: bad }).pausedAt, null);
});

test('a newer schema is kept verbatim, deep-copied, read-only, and never patched', () => {
  const future = { schemaVersion: 2, pausedAt: 'weird', launchPermissions: [{ other: 1 }], nested: { deep: [1, { x: 2 }] } };
  assert.equal(isReadOnlyPrimaryChat(future), true);
  for (const bad of [{ schemaVersion: 1 }, { schemaVersion: '2' }, { schemaVersion: 1.5 }, null, undefined]) {
    assert.equal(isReadOnlyPrimaryChat(bad), false);
  }
  const normalized = normalizePrimaryChat(future);
  assert.deepEqual(normalized, future);
  assert.notEqual(normalized, future);
  assert.notEqual(normalized.nested, future.nested);
  assert.equal(applyPrimaryChatPatch(future, { pausedAt: AT(1) }), future);
});

test('applyPrimaryChatPatch merges shallowly then normalizes', () => {
  const current = normalizePrimaryChat({ pausedAt: AT(1), launchPermissions: [permission(1)] });
  const next = applyPrimaryChatPatch(current, { pausedAt: null });
  assert.equal(next.pausedAt, null);
  assert.deepEqual(next.launchPermissions, [permission(1)]);
  assert.deepEqual(applyPrimaryChatPatch(undefined, { history: [{ kind: 'reset', at: AT(2) }] }).history, [{ kind: 'reset', at: AT(2) }]);
  assert.deepEqual(applyPrimaryChatPatch(current, 'x'), current);
});

test('normalizeState carries the block and serializeState round-trips a permission', () => {
  assert.deepEqual(normalizeState({}).primaryChat, DEFAULT_PRIMARY_CHAT);
  assert.equal(normalizeState({}).version, CONFIG_VERSION);
  assert.equal(CONFIG_VERSION, 59);
  const state = normalizeState({ primaryChat: { pausedAt: AT(9), launchPermissions: [permission(1, { run_modes: ['plan'] })] } });
  assert.equal(state.primaryChat.launchPermissions.length, 1);
  const serialized = serializeState(state);
  assert.deepEqual(serialized.primaryChat, state.primaryChat);
  assert.equal(serialized.version, 59);
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(serialized))).primaryChat, state.primaryChat);
});

test('updatePrimaryChat persists, survives a restart, skips unchanged writes and leaves the version alone', () => {
  const { userDataPath, service } = tempService();
  const events = [];
  service.on('changed', (_state, meta) => events.push(meta?.reason));
  const after = service.updatePrimaryChat({ pausedAt: AT(4), launchPermissions: [permission(1)] });
  assert.equal(after.pausedAt, AT(4));
  assert.deepEqual(events, ['primary_chat_updated']);
  assert.deepEqual(readDisk(userDataPath).primaryChat, after);
  assert.equal(readDisk(userDataPath).version, CONFIG_VERSION);
  service.updatePrimaryChat({ pausedAt: AT(4) });
  assert.equal(events.length, 1, 'unchanged is not a write');
  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(reloaded.getState().primaryChat, after);
  const detached = service.getState();
  detached.primaryChat.launchPermissions.length = 0;
  assert.equal(service.getState().primaryChat.launchPermissions.length, 1);
});

test('a failed persist throws primary_chat_config_write_failed', () => {
  const { service } = tempService();
  service._persistState = () => false;
  assert.throws(() => service.updatePrimaryChat({ pausedAt: AT(1) }),
    (error) => error.message === 'primary_chat_config_write_failed' && error.reason === 'primary_chat_config_write_failed');
  assert.equal(service.getState().primaryChat.pausedAt, null);
});

test('a read-only future block survives an unrelated write and a patch attempt', () => {
  const future = { schemaVersion: 3, anything: { goes: true } };
  const { userDataPath, service } = tempService({ primaryChat: future });
  const events = [];
  service.on('changed', (_state, meta) => events.push(meta?.reason));
  assert.deepEqual(service.updatePrimaryChat({ pausedAt: AT(1) }), future);
  assert.deepEqual(events, []);
  service.updateHomeConfig({ focusMode: true });
  assert.deepEqual(readDisk(userDataPath).primaryChat, future);
});

test('primaryChat is excluded from the portable-preferences projection', () => {
  assert.equal(Object.hasOwn(SHELL_CONFIG_PORTABILITY.excluded, 'primaryChat'), true);
  assert.equal(Object.hasOwn(SHELL_CONFIG_PORTABILITY.portable, 'primaryChat'), false);
  const state = normalizeState({ primaryChat: { pausedAt: AT(2), launchPermissions: [permission(1)] } });
  const projected = projectPortableShellConfig(state);
  assert.equal(Object.hasOwn(projected, 'primaryChat'), false);
  assert.equal(JSON.stringify(projected).includes(PID(1)), false);
});
