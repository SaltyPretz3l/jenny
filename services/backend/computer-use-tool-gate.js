'use strict';

/* services/backend/computer-use-tool-gate.js - which turns are offered the `computer` tool (row 196).
 *
 * The tool exists only where the real mouse and keyboard may be used for this owner: the flag on
 * (it is registered only then, on Windows), safety mode normal, the command sandbox off (driving host
 * programs is what that mode exists to prevent; the tool is never on the sandbox bridge's list), and a
 * model on this computer (its pictures and the screen go only to a local engine; a team model is not
 * local). The chat's own Computer switch, Plan and read-only modes, Offline lockdown and unattended
 * turns are decided by their own owners (tool-surface-families.js, the sidecar, session-lockdown-gate.js,
 * the tool body). Anything that cannot be read hides it (fail closed).
 *
 * As with the Live tab's look (run-view-tool-gate.js), the engine is known only after the turn's model
 * is resolved: the turn first gates with `{ engine: false }`, then withComputerEngineGate adds the engine
 * denial. Both only add `computer` to the request's `disabled_tools`.
 */

const { engineIsLocal, safetyModeOf } = require('./run-view-tool-gate');
const { getConfiguredToolsComputerUseEnabled } = require('./managed-sidecar-config-readers');

const COMPUTER = 'computer';

function flagOff(service) {
  return service?.featureFlags?.tools_computer_use_enabled !== true;
}

function sandboxOn(service) {
  try {
    return service?.configService?.getState?.()?.commandSandbox?.enabled === true;
  } catch (_error) {
    return true;
  }
}

// The checks a registered tool must pass, in order; the turn gate and the Tools menu's reason share them.
function blockedBy(service, { engine = true } = {}) {
  if (safetyModeOf(service) !== 'normal') return 'strict_safety';
  if (sandboxOn(service)) return 'sandbox';
  return engine && !engineIsLocal(service) ? 'engine_not_local' : null;
}

/** Whether this turn must not see `computer`. `engine: false` leaves the engine check for later. */
function computerHidden(service, { engine = true } = {}) {
  if (flagOff(service)) return false; // not registered at all
  return blockedBy(service, { engine }) !== null;
}

/**
 * Why the chat's Tools menu shows Computer as unavailable, for the row's reason line (row 196 C4), or null
 * when it is offered. Same checks and order as above; `disabled` covers the flag and the Settings switch.
 * @returns {null|'not_windows'|'disabled'|'strict_safety'|'sandbox'|'engine_not_local'}
 */
function computerBlockReason(service, { platform = process.platform } = {}) {
  if (platform !== 'win32') return 'not_windows';
  let switchedOn = false;
  try { switchedOn = getConfiguredToolsComputerUseEnabled(service); } catch (_error) { /* unreadable reads as off */ }
  if (flagOff(service) || !switchedOn) return 'disabled';
  return blockedBy(service);
}

function withDenied(toolPreferences) {
  const base = toolPreferences && typeof toolPreferences === 'object' && !Array.isArray(toolPreferences)
    ? toolPreferences : {};
  const disabled = Array.isArray(base.disabled_tools) ? base.disabled_tools : [];
  if (disabled.includes(COMPUTER)) return toolPreferences;
  return { ...base, disabled_tools: [...new Set([...disabled, COMPUTER])].sort() };
}

/** The first pass, before the model is resolved. */
function withComputerToolGate(service, toolPreferences, options = { engine: false }) {
  return computerHidden(service, options) ? withDenied(toolPreferences) : toolPreferences;
}

/** The second pass, once the model is resolved: denies `computer` when the engine is not on this computer.
 * A turn that offers only a fixed list without it (handoff preparation, digest) is left as it was. */
function withComputerEngineGate(service, toolPreferences) {
  if (flagOff(service)) return toolPreferences;
  const enabled = Array.isArray(toolPreferences?.enabled_tools) ? toolPreferences.enabled_tools : [];
  if (enabled.length > 0 && !enabled.includes(COMPUTER)) return toolPreferences;
  return engineIsLocal(service) ? toolPreferences : withDenied(toolPreferences);
}

module.exports = { blockedBy, computerBlockReason, computerHidden, withComputerEngineGate, withComputerToolGate };
