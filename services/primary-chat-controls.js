'use strict';

/* services/primary-chat-controls.js - the primary Jenny chat's controls (row 76): the pause
 * flag, standing launch permissions and the short control history, kept in the profile's
 * `primaryChat` shell-config block (shell-config-primary-chat.js owns its shape).
 *
 * Composition-root style (like session-directory-service.js): every dependency is an
 * injected getter, a missing or throwing one yields a refusal or an "off" answer, never a
 * throw to the caller. Other slices read it through ports: the wake asks `isPaused`, the
 * proposal publish asks `matchLaunchPermission`, the IPC layer and the activity log use
 * `getState` / `recordHistory`. It only records state; it never starts a chat or sends mail.
 * Diagnostics carry reasons only, never titles, project names or ids of chats.
 */

const { randomBytes } = require('crypto');
const { findPrimarySessions, isPrimarySession } = require('./backend/primary-session');
const {
  PRIMARY_CHAT_HISTORY_KINDS, PRIMARY_CHAT_LIMITS, isLivePermission, isPermissionId, isReadOnlyPrimaryChat,
  normalizePrimaryChat, normalizeProjectId, normalizeRunModes,
} = require('./shell-config-primary-chat');

const SCHEMA_VERSION = 1;
const refusal = (reason) => ({ ok: false, reason });
const isRecordLike = (value) => Boolean(value) && typeof value === 'object' && typeof value.permission_id === 'string';

function read(getter) {
  try { return typeof getter === 'function' ? getter() || null : null; } catch (_error) { return null; }
}

function attempt(fn, fallback) {
  try { return fn(); } catch (_error) { return fallback; }
}

const sameModes = (left, right) => (left === null || right === null
  ? left === right : left.length === right.length && left.every((mode, index) => mode === right[index]));

function createPrimaryChatControls({
  configService = () => null, sessionStore = () => null, featureFlags = () => ({}), projectService = () => null,
  resumeWake = null, createId = () => `lp_${randomBytes(16).toString('hex')}`, now = () => new Date(),
  log = () => {}, emit = () => {},
} = {}) {
  const flags = () => read(featureFlags) || {};
  const primaryOn = () => flags().primary_chat !== false;
  const flagOn = (key) => primaryOn() && flags()[key] !== false;
  const controlsEnabled = () => flagOn('primary_chat_controls');
  const launchPermissionEnabled = () => flagOn('primary_launch_permission');
  const nowIso = () => new Date(now()).toISOString();

  function primarySessionId() {
    if (!primaryOn()) return null;
    return attempt(() => findPrimarySessions(read(sessionStore)?.listSessions())[0]?.id ?? null, null);
  }

  const currentBlock = () => attempt(() => {
    const block = read(configService)?.getState()?.primaryChat;
    return block ? normalizePrimaryChat(block) : null;
  }, null);
  const isPausedBlock = (block) => controlsEnabled() && typeof block?.pausedAt === 'string';

  function isPaused(sessionId) {
    return attempt(() => {
      if (!controlsEnabled() || typeof sessionId !== 'string' || !sessionId) return false;
      const block = currentBlock();
      return isPausedBlock(block) && sessionId === primarySessionId();
    }, false);
  }

  function projectOf(projectId) {
    if (projectId === '*') return null;
    const project = attempt(() => read(projectService)?.get?.(projectId), null);
    return project && typeof project.id === 'string' ? { id: project.id, name: String(project.name ?? '') } : null;
  }
  const withProject = (record) => ({ ...record, project: projectOf(record.project_id) });
  const permissionsOf = (block) => (Array.isArray(block?.launchPermissions) ? block.launchPermissions.filter(isRecordLike) : []);

  // Read-modify-write through the config service. `build(block, at)` returns a patch, or null for
  // "nothing to change". Revoked permissions past retention are pruned as part of every write.
  function write(build) {
    const config = read(configService);
    const current = currentBlock();
    if (!config || typeof config.updatePrimaryChat !== 'function' || !current || isReadOnlyPrimaryChat(current)) {
      return refusal('unavailable');
    }
    const at = nowIso();
    const cutoff = Date.parse(at) - PRIMARY_CHAT_LIMITS.revoked_retention_ms;
    const kept = current.launchPermissions.filter((record) => isLivePermission(record) || Date.parse(record.revoked_at) > cutoff);
    const base = { ...current, launchPermissions: kept };
    const patch = build(base, at);
    if (!patch) return { ok: true, changed: false, block: current };
    try {
      const block = normalizePrimaryChat(config.updatePrimaryChat({ launchPermissions: kept, ...patch }));
      attempt(() => emit({ schema_version: SCHEMA_VERSION, session_id: primarySessionId(), paused: isPausedBlock(block) }), null);
      return { ok: true, changed: true, block };
    } catch (error) {
      const token = typeof error?.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(error.reason) ? error.reason : 'write_failed';
      attempt(() => log('WARN', 'primary_chat.write_failed', { reason: token }), null);
      return refusal('unavailable');
    }
  }
  const withHistory = (block, entry) => [...block.history, entry];

  // Gate shared by the mutating controls: returns a refusal, or the primary id.
  function guard(enabled) {
    if (!enabled()) return refusal('disabled');
    const id = primarySessionId();
    return id ? { ok: true, id } : refusal('not_found');
  }

  function pause() {
    const gate = guard(controlsEnabled);
    if (!gate.ok) return gate;
    const written = write((block, at) => (block.pausedAt ? null
      : { pausedAt: at, history: withHistory(block, { kind: 'paused', at }) }));
    return written.ok ? { ok: true, paused: true, paused_at: written.block.pausedAt } : written;
  }

  async function resume() {
    const gate = guard(controlsEnabled);
    if (!gate.ok) return gate;
    const written = write((block, at) => (block.pausedAt === null ? null
      : { pausedAt: null, history: withHistory(block, { kind: 'resumed', at }) }));
    if (!written.ok) return written;
    let woke = null;
    if (written.changed && typeof resumeWake === 'function') {
      try { woke = (await resumeWake(gate.id)) ?? null; } catch (_error) { woke = null; }
    }
    return { ok: true, paused: false, paused_at: null, woke };
  }

  function listPermissions({ include_revoked: includeRevoked = true } = {}) {
    const block = currentBlock();
    if (!block) return [];
    return permissionsOf(block).filter((record) => includeRevoked || isLivePermission(record)).map(withProject);
  }

  function grantLaunch(input) {
    if (!launchPermissionEnabled()) return refusal('disabled');
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const projectId = normalizeProjectId(source.project_id);
    const runModes = normalizeRunModes(source.run_modes === undefined ? null : source.run_modes);
    const cap = source.max_children_per_turn === undefined ? 1 : source.max_children_per_turn;
    if (projectId === null || runModes === undefined
      || !Number.isSafeInteger(cap) || cap < 1 || cap > PRIMARY_CHAT_LIMITS.max_children_per_turn_max) return refusal('invalid_request');
    const gate = guard(launchPermissionEnabled);
    if (!gate.ok) return gate;
    if (projectId !== '*' && !attempt(() => read(projectService)?.get?.(projectId), null)) return refusal('unknown_project');
    let outcome = null;
    const written = write((block, at) => {
      const same = block.launchPermissions.find((record) => isLivePermission(record) && record.project_id === projectId
        && record.max_children_per_turn === cap && sameModes(record.run_modes, runModes));
      if (same) { outcome = { ok: true, permission: same, created: false }; return null; }
      if (block.launchPermissions.filter(isLivePermission).length >= PRIMARY_CHAT_LIMITS.permissions_max) {
        outcome = refusal('capacity');
        return null;
      }
      const record = {
        permission_id: createId(), project_id: projectId, run_modes: runModes, max_children_per_turn: cap,
        created_at: at, revoked_at: null,
      };
      if (!isPermissionId(record.permission_id)) { outcome = refusal('unavailable'); return null; }
      const list = [...block.launchPermissions, record];
      // The stored cap counts revoked entries too: make room by dropping revoked ones first.
      while (list.length > PRIMARY_CHAT_LIMITS.permissions_max) list.splice(list.findIndex((entry) => !isLivePermission(entry)), 1);
      outcome = { ok: true, permission: record, created: true };
      return { launchPermissions: list, history: withHistory(block, { kind: 'permission_granted', at, permission_id: record.permission_id }) };
    });
    return written.ok ? outcome : written;
  }

  function revokeLaunch(input) {
    const permissionId = input && typeof input === 'object' ? input.permission_id : null;
    if (!isPermissionId(permissionId)) return refusal('invalid_request');
    const gate = guard(primaryOn);
    if (!gate.ok) return gate;
    let outcome = null;
    const written = write((block, at) => {
      const found = block.launchPermissions.find((record) => record.permission_id === permissionId);
      if (!found) { outcome = refusal('not_found'); return null; }
      if (!isLivePermission(found)) { outcome = { ok: true, permission: found, created: false }; return null; }
      const revoked = { ...found, revoked_at: at };
      outcome = { ok: true, permission: revoked };
      return {
        launchPermissions: block.launchPermissions.map((record) => (record === found ? revoked : record)),
        history: withHistory(block, { kind: 'permission_revoked', at, permission_id: permissionId }),
      };
    });
    return written.ok ? outcome : written;
  }

  // The most specific live permission for the primary chat, or null. Never throws.
  function matchLaunchPermission({ sessionId, destinationProjectId, runMode } = {}) {
    return attempt(() => {
      if (!launchPermissionEnabled() || !isPrimarySession(read(sessionStore), sessionId)) return null;
      const block = currentBlock();
      if (!block || isReadOnlyPrimaryChat(block)) return null; // a newer build's record may narrow in ways this one cannot read
      const candidates = permissionsOf(block).filter((record) => isLivePermission(record)
        && (record.project_id === '*' || record.project_id === destinationProjectId)
        && (record.run_modes === null || record.run_modes.includes(runMode)));
      candidates.sort((left, right) => (right.project_id !== '*') - (left.project_id !== '*')
        || right.created_at.localeCompare(left.created_at));
      const best = candidates[0];
      return best ? Object.freeze({ permission_id: best.permission_id, max_children_per_turn: best.max_children_per_turn }) : null;
    }, null);
  }

  function recordHistory(kind, { permission_id: permissionId } = {}) {
    if (!primaryOn() || !PRIMARY_CHAT_HISTORY_KINDS.includes(kind)) return false;
    const written = write((block, at) => ({
      history: withHistory(block, isPermissionId(permissionId) ? { kind, at, permission_id: permissionId } : { kind, at }),
    }));
    return written.ok === true;
  }

  function getState() {
    const block = currentBlock();
    if (!block) return refusal('unavailable');
    const controls = controlsEnabled();
    return {
      ok: true,
      schema_version: SCHEMA_VERSION,
      session_id: primarySessionId(),
      paused: isPausedBlock(block),
      paused_at: block.pausedAt,
      permissions: permissionsOf(block).map(withProject),
      history: Array.isArray(block.history) ? block.history : [],
      flags: { controls, launch_permission: launchPermissionEnabled(), activity_log: flagOn('primary_activity_log') },
    };
  }

  return {
    controlsEnabled, getState, grantLaunch, isPaused, launchPermissionEnabled, listPermissions, matchLaunchPermission,
    pause, primarySessionId, recordHistory, resume, revokeLaunch,
  };
}

module.exports = { createPrimaryChatControls };
