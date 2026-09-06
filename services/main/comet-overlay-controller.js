/* Comet desktop overlay window lifecycle and presence-payload helpers. */

const ALLOWED_COMET_OVERLAY_STATES = new Set([
  'idle',
  'listening',
  'thinking',
  'responding',
  'tool-use',
  'alert',
  'happy',
  'concerned',
]);
const ALLOWED_COMET_OVERLAY_PHASE_KINDS = new Set([
  '',
  'reasoning',
  'text',
  'tool_use',
  'tool_result',
  'approval_wait',
]);
const ALLOWED_COMET_OVERLAY_TERMINAL_STATUSES = new Set([
  '',
  'completed',
  'denied',
  'cancelled',
  'preempted',
  'timeout',
  'runtime_error',
]);

function clampOverlayToken(value, maxLength = 32) {
  return String(value || '').trim().toLowerCase().slice(0, maxLength);
}

function normalizeCometOverlayPresencePayload(payload = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const state = clampOverlayToken(source.state);
  const phaseKind = clampOverlayToken(source.phaseKind || source.phase_kind);
  const terminalStatus = clampOverlayToken(source.terminalStatus || source.terminal_status);
  const terminalSubcode = clampOverlayToken(source.terminalSubcode || source.terminal_subcode, 64);
  return {
    state: ALLOWED_COMET_OVERLAY_STATES.has(state) ? state : 'idle',
    phaseKind: ALLOWED_COMET_OVERLAY_PHASE_KINDS.has(phaseKind) ? phaseKind : '',
    terminalStatus: ALLOWED_COMET_OVERLAY_TERMINAL_STATUSES.has(terminalStatus) ? terminalStatus : '',
    terminalSubcode,
  };
}

function isOverlayWindowAlive(ref) {
  if (!ref) {
    return false;
  }
  const isDestroyed = ref.window && typeof ref.window.isDestroyed === 'function'
    ? ref.window.isDestroyed()
    : false;
  return isDestroyed !== true;
}

function handleCometOverlayToggle({
  data = {},
  mainWindowRef = null,
  currentOverlayRef = null,
  isOverlayEnabled = () => false,
  createOverlay = () => null,
  onOverlayDisposed = () => {},
} = {}) {
  const wantsEnabled = data && data.enabled === true;
  let nextOverlayRef = currentOverlayRef || null;

  if (!wantsEnabled) {
    if (nextOverlayRef) {
      nextOverlayRef.dispose();
    }
    return null;
  }

  if (!isOverlayEnabled()) {
    return nextOverlayRef;
  }
  if (!mainWindowRef || (typeof mainWindowRef.isDestroyed === 'function' && mainWindowRef.isDestroyed())) {
    return nextOverlayRef;
  }
  if (isOverlayWindowAlive(nextOverlayRef)) {
    return nextOverlayRef;
  }

  let createdOverlay = null;
  createdOverlay = createOverlay(mainWindowRef, {
    onDispose: () => onOverlayDisposed(createdOverlay),
  });
  return createdOverlay || null;
}

module.exports = {
  handleCometOverlayToggle,
  isOverlayWindowAlive,
  normalizeCometOverlayPresencePayload,
};
