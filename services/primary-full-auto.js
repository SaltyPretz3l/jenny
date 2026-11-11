'use strict';

/* services/primary-full-auto.js - the armed state of "Full auto" for the one profile-wide primary Jenny chat.
 * Full auto is a state layered over run mode `auto`: while armed, the approval path may auto-answer tool
 * approvals for that chat. The state is process memory only (nothing on disk, nothing in config), so a restart
 * returns to plain Auto. `isArmed(sessionId)` is the security read and fails closed: it is true only for the
 * armed session, with the flag on, and a live run mode that is still `auto`. Dependencies are ports so the
 * module imports nothing from Electron or the session store.
 */

function createPrimaryFullAuto({
  primarySessionId = () => '', getRunMode = () => '', isEnabled = () => false, onChange = () => {}, log = () => {},
} = {}) {
  let armedId = '';

  const note = (level, event, details) => {
    try { log(level, event, details); } catch (_error) { /* logging must never throw */ }
  };
  const notify = () => {
    try { onChange(); } catch (_error) { /* the invalidation emit is best-effort */ }
  };
  // Clears the armed id; reports whether there was one so the caller notifies only a real transition.
  const clear = (reason) => {
    if (!armedId) return false;
    const sessionId = armedId;
    armedId = '';
    note('INFO', 'primary_full_auto.disarmed', { sessionId, reason: String(reason || 'unspecified') });
    notify();
    return true;
  };

  function currentPrimary() {
    const id = primarySessionId();
    return typeof id === 'string' ? id : '';
  }

  function arm() {
    let id;
    try {
      if (isEnabled() !== true) return { ok: false, armed: false, reason: 'disabled' };
      id = currentPrimary();
      if (!id) return { ok: false, armed: false, reason: 'no_primary' };
      if (getRunMode(id) !== 'auto') return { ok: false, armed: false, reason: 'not_auto' };
    } catch (_error) {
      return { ok: false, armed: false, reason: 'disabled' };
    }
    if (armedId === id) return { ok: true, armed: true };
    const previous = armedId;
    armedId = id;
    note('INFO', 'primary_full_auto.armed', { sessionId: id, replaced: previous || undefined });
    notify();
    return { ok: true, armed: true };
  }

  function disarm(reason) {
    clear(reason);
    return { ok: true, armed: false };
  }

  function isArmed(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || !armedId || sessionId !== armedId) return false;
    try {
      if (isEnabled() === true && currentPrimary() === sessionId && getRunMode(sessionId) === 'auto') return true;
    } catch (_error) {
      return false;
    }
    clear('no_longer_eligible');
    return false;
  }

  function getState() {
    const available = (() => {
      try { return isEnabled() === true && Boolean(currentPrimary()); } catch (_error) { return false; }
    })();
    const armed = isArmed(armedId); // live: the chip must never claim more than the gate will honour
    return { available, armed, session_id: armedId };
  }

  function noteRunMode(sessionId, runMode) {
    if (!armedId || sessionId !== armedId) return;
    if (String(runMode || '').trim().toLowerCase() === 'auto') return;
    clear('run_mode_changed');
  }

  return { arm, disarm, isArmed, getState, noteRunMode };
}

module.exports = { createPrimaryFullAuto };
