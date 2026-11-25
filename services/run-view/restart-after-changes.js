'use strict';

/*
 * restart-after-changes.js — the Live tab's "Restart after Jenny's changes" switch (row 197, A4).
 *
 * Per project it keeps how many file changes the chat tools made (`count`), the count when the
 * latest build began (`mark`), the switch (`on`, default on) and whether a restart is under way.
 * A turn that ends `completed` with `count > mark` restarts a program that is already running or
 * has just stopped; it never starts one that is idle or closed. The mark moves when a build begins
 * (markBuild, fed from the run service's state pushes), so a restart the model or the owner made
 * in the middle of the turn is not repeated, and a restart that failed is retried at the next turn.
 *
 * Pure bookkeeping: no Electron, no filesystem. The run service is reached only through
 * `getRunService()`, which must never build it.
 */

const MAX_PROJECTS = 256;
const MAX_CALL_IDS = 512;
const RESTARTABLE = new Set(['running', 'minimized', 'no_window', 'build_failed', 'ended_early']);
const CHANGE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

const nonEmptyString = (value) => typeof value === 'string' && value !== '';
const positiveCount = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonEmptyArray = (value) => Array.isArray(value) && value.length > 0;

// Whether one tool result changed the project. Metadata is untrusted: check each type before use.
function isChange({ toolName, success, metadata } = {}) {
  if (success === false) return false;
  if (CHANGE_TOOLS.has(toolName)) return true;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const review = metadata.review !== null && typeof metadata.review === 'object' && !Array.isArray(metadata.review) ? metadata.review : null;
  return positiveCount(review?.changed_path_count) || nonEmptyArray(review?.changed_paths) || nonEmptyArray(metadata.changed_paths);
}

// `turnRefusal(chatId)`: null when the turn may restart the program, else a reason word (the same
// turn rules as the model's restart tool). Read only once a restart would otherwise happen.
function createRestartAfterChanges({
  getRunService = () => null, canStart = () => 'disabled', turnRefusal = () => null, logger,
} = {}) {
  const projects = new Map(); // projectId -> { count, mark, on, inFlight }; least recently touched first
  const callIds = new Set(); // oldest first

  const touch = (projectId, create) => {
    let entry = projects.get(projectId);
    if (entry) projects.delete(projectId);
    else if (create) entry = { count: 0, mark: 0, on: true, inFlight: false };
    if (!entry) return null;
    projects.set(projectId, entry);
    while (projects.size > MAX_PROJECTS) projects.delete(projects.keys().next().value);
    return entry;
  };
  const refusal = () => {
    try { return canStart(); } catch { return 'disabled'; }
  };
  const rememberCall = (key) => {
    callIds.add(key);
    while (callIds.size > MAX_CALL_IDS) callIds.delete(callIds.values().next().value);
  };

  function recordChange({ projectId, callId } = {}) {
    if (!nonEmptyString(projectId)) return;
    if (nonEmptyString(callId)) {
      const key = `${projectId}\u0000${callId}`;
      if (callIds.has(key)) return;
      rememberCall(key);
    }
    touch(projectId, true).count += 1;
  }

  function markBuild(projectId) {
    if (!nonEmptyString(projectId)) return;
    const entry = touch(projectId, true);
    entry.mark = entry.count;
  }

  const isOn = (projectId) => projects.get(projectId)?.on !== false;

  function setOn({ projectId, on } = {}) {
    if (!nonEmptyString(projectId) || typeof on !== 'boolean') return { ok: false, reason: 'bad_request' };
    touch(projectId, true).on = on;
    return { ok: true, on };
  }

  const forget = (projectId) => { projects.delete(projectId); };

  async function onTurnEnd({ projectId, chatId, status } = {}) {
    const skip = (reason) => ({ restarted: false, reason });
    try {
      if (status !== 'completed') return skip('not_completed');
      const entry = nonEmptyString(projectId) ? projects.get(projectId) : null;
      if (entry && entry.on === false) return skip('switch_off');
      if (!entry || entry.count <= entry.mark) return skip('no_changes');
      const refused = refusal();
      if (refused) return skip(refused);
      const service = getRunService();
      const state = service ? service.peekState?.(projectId) : null;
      if (!RESTARTABLE.has(state)) return skip('not_running');
      let turnRefused;
      try { turnRefused = turnRefusal(chatId); } catch { turnRefused = 'turn_unreadable'; }
      if (turnRefused) return skip(turnRefused);
      if (entry.inFlight) return skip('in_flight');
      entry.inFlight = true;
      let reply;
      try {
        reply = await service.restart({ projectId, chatId, worktree: null });
      } finally {
        entry.inFlight = false;
      }
      if (reply?.ok === true) return { restarted: true, reason: 'restarted' };
      const reason = nonEmptyString(reply?.reason) ? reply.reason : 'restart_failed';
      try { logger?.warn?.(`restart after changes did not run: ${reason}`); } catch { /* logging never throws */ }
      return skip(reason);
    } catch {
      try { logger?.warn?.('restart after changes failed'); } catch { /* logging never throws */ }
      return skip('restart_failed');
    }
  }

  return { recordChange, markBuild, isOn, setOn, forget, onTurnEnd, isChange };
}

module.exports = { createRestartAfterChanges, isChange, RESTARTABLE };
