'use strict';

/* services/backend/run-view-tool-gate.js - which turns are offered the Live tab's two tools (row 197).
 *
 * run_view_look and run_view_restart exist only for a chat whose project has a run command the owner
 * confirmed in the Live tab, and only where the Live tab may run at all (the holder's start gate:
 * flag on, not a hosted server, Windows). The restart is also hidden while commands run only in the
 * sandbox, and the look is hidden when the turn's model is not on this computer: its picture goes only
 * to a local engine. Strict and paranoid safety modes hide both (the bodies refuse them there anyway).
 * Every other turn gets the names on its per-request `disabled_tools`; the tool bodies check the same
 * things again at call time. Anything that cannot be read hides them (fail closed).
 *
 * The engine is known only after the turn's model is resolved (a resolve can switch engines), so the
 * turn path first gates with `{ engine: false }` and then runs withRunViewEngineGate once it is resolved,
 * which only adds the look's denial and reads nothing the first pass already decided.
 *
 * With `tools_run_view_enabled` off the tools are not registered at all, so the request is left as it was.
 */

const { isLocalEngine, openAiCompatibleUrlFromService } = require('./session-lockdown-gate');

const LOOK = 'run_view_look';
const RESTART = 'run_view_restart';
const NEVER = new Set(['disabled', 'unsupported_platform']);

function projectIdOf(service, { sessionId, session } = {}) {
  try {
    const id = service.projectAuthority?.captureSession?.(sessionId || session?.id)?.project_id;
    return typeof id === 'string' ? id : '';
  } catch (_error) {
    return '';
  }
}

function engineIsLocal(service) {
  try {
    return isLocalEngine(service.currentEngineType, openAiCompatibleUrlFromService(service));
  } catch (_error) {
    return false;
  }
}

function safetyModeOf(service) {
  try {
    return service?.configService?.getChatUiState?.()?.safetyMode || 'normal';
  } catch (_error) {
    return 'strict';
  }
}

// The run-view tool names this turn must not see. `engine: false` leaves the engine check for later.
function hiddenRunViewTools(service, target, { engine = true } = {}) {
  const flags = service?.featureFlags;
  if (flags?.tools_run_view_enabled === false || flags?.live_run_view === false) return [];
  const holder = service?.runView;
  const read = (fn, fallback) => {
    try { return fn(); } catch (_error) { return fallback; }
  };
  const refusal = read(() => (typeof holder?.startRefusal === 'function' ? holder.startRefusal() : 'disabled'), 'disabled');
  if (NEVER.has(refusal)) return [LOOK, RESTART]; // decided before any project or file is read
  if (safetyModeOf(service) !== 'normal') return [LOOK, RESTART];
  const projectId = projectIdOf(service, target);
  const confirmed = read(() => projectId !== '' && holder?.hasConfirmedCommand?.(projectId) === true, false);
  if (!confirmed) return [LOOK, RESTART];
  const hidden = [];
  if (engine && !engineIsLocal(service)) hidden.push(LOOK);
  if (refusal === 'sandbox_only') hidden.push(RESTART);
  return hidden;
}

// The turn's tool preferences with the run-view tools denied where this turn is not offered them.
function withRunViewToolGate(service, target, toolPreferences, options) {
  const hidden = hiddenRunViewTools(service, target, options);
  if (!hidden.length) return toolPreferences;
  const base = toolPreferences && typeof toolPreferences === 'object' && !Array.isArray(toolPreferences)
    ? toolPreferences : {};
  const denied = new Set([...(Array.isArray(base.disabled_tools) ? base.disabled_tools : []), ...hidden]);
  return { ...base, disabled_tools: [...denied].sort() };
}

// The second pass of a turn, after the model is resolved: denies the look when the engine is not on this
// computer. A turn whose preferences already deny the look, or that offers only a fixed list without it
// (the handoff preparation and digest turns), is left exactly as it was.
function withRunViewEngineGate(service, toolPreferences) {
  const flags = service?.featureFlags;
  if (flags?.tools_run_view_enabled === false || flags?.live_run_view === false) return toolPreferences;
  const base = toolPreferences && typeof toolPreferences === 'object' && !Array.isArray(toolPreferences)
    ? toolPreferences : {};
  const disabled = Array.isArray(base.disabled_tools) ? base.disabled_tools : [];
  const enabled = Array.isArray(base.enabled_tools) ? base.enabled_tools : [];
  if (disabled.includes(LOOK) || (enabled.length > 0 && !enabled.includes(LOOK))) return toolPreferences;
  if (engineIsLocal(service)) return toolPreferences;
  return { ...base, disabled_tools: [...new Set([...disabled, LOOK])].sort() };
}

module.exports = { engineIsLocal, hiddenRunViewTools, safetyModeOf, withRunViewEngineGate, withRunViewToolGate };
