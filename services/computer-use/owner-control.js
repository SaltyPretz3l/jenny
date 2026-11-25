'use strict';

/* services/computer-use/owner-control.js: the owner's side of a computer turn (row 196, S4).
 *
 * The live turn state the frame, the pill and the chat show; the held step while the owner has the mouse
 * (D1 A: Resume carries on in the same turn); and Resume and Stop from the pill or the chat. The service
 * (computer-use-service.js) owns the chats, the mouse lock and the helper; this owns only what the owner sees
 * and answers. A Stop is never downgraded to a pause. */

const { createOwnerHold } = require('./owner-hold');
const fmt = require('./result-format');

/**
 * @param {object} deps
 * @param {object} deps.watch the service's turn watch (turn-watch.js)
 * @param {(sessionId: string) => object|undefined} deps.getChat the service's chat record
 * @param {() => object|null} deps.currentHost the helper host, or null
 * @param {(state: object) => void} [deps.onTurnState]
 * @param {object} [deps.hold] the owner-hold options
 * @param {() => number} [deps.now]
 */
function createOwnerControl({ watch, getChat, currentHost, onTurnState = null, hold: holdOptions = {}, now = Date.now }) {
  const hold = createOwnerHold({ now, ...holdOptions });
  // Per chat, the turn they apply to: a Stop pressed before the watch started (F1), and a hold that ran out (F6).
  const stops = new Map();
  const expired = new Map();
  const turnOf = (sessionId) => getChat(sessionId)?.liveTurn || null;

  function screenPointOf(chat) {
    const bounds = chat?.target?.bounds;
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  }

  /** Tell the frame, the pill and the chat. A live turn is one that has made a computer call. */
  function emit(sessionId, state, action = '') {
    const chat = getChat(sessionId);
    if (state === 'idle') {
      if (!chat?.liveTurn) return;
      chat.liveTurn = null;
    }
    try {
      onTurnState?.({ sessionId, state, action, programName: chat?.target?.grant?.name || '', screenPoint: screenPointOf(chat) });
    } catch (_error) { /* a listener never breaks a step */ }
  }

  /** The helper saw the owner's input or the Stop chord while `holder` had the mouse. */
  function onWatchEvent(holder, name) {
    const stop = name === 'watch.stop_chord';
    watch.markPaused(holder, stop ? 'stop' : 'owner');
    if (stop) hold.release(holder, 'stopped');
    else if (watch.pausedFor(holder) === 'owner') emit(holder, 'paused');
  }

  /**
   * Hold the step open until Resume, Stop, the turn's end or the limit.
   * @returns {Promise<{ status: string, message: string, waitedMs: number, cancelled?: boolean }>}
   */
  async function holdStep(c) {
    if (watch.pausedFor(c.sessionId) === 'stop') return { status: 'paused_by_user', message: fmt.OWNER_STOPPED, waitedMs: 0 };
    // The owner did not come back within the limit: the rest of this turn answers at once instead of waiting again.
    if (c.turnId && expired.get(c.sessionId) === c.turnId) return { status: 'paused_by_user', message: fmt.OWNER_ACTIVE, waitedMs: 0 };
    emit(c.sessionId, 'paused', c.action);
    const { ended, waitedMs } = await hold.wait(c.sessionId, { signal: c.signal, suspendClocks: c.ctx.suspendTurnClocks });
    if (ended !== 'resumed') emit(c.sessionId, 'thinking', c.action); // Resume already said so; the pause is over
    if (ended === 'cancelled') return { cancelled: true, waitedMs };
    if (ended === 'resumed') return { status: 'resumed', message: fmt.OWNER_RESUMED, waitedMs };
    if (ended === 'stopped' || watch.pausedFor(c.sessionId) === 'stop') {
      watch.markPaused(c.sessionId, 'stop');
      return { status: 'paused_by_user', message: fmt.OWNER_STOPPED, waitedMs };
    }
    if (c.turnId) expired.set(c.sessionId, c.turnId);
    return { status: 'paused_by_user', message: fmt.OWNER_ACTIVE, waitedMs };
  }

  /** A Stop pressed in this turn before the watch began; the service latches it once the watch is up. */
  function stopRequested(sessionId, turnId) {
    return Boolean(turnId) && stops.get(sessionId) === turnId;
  }

  /** The owner handed back control. Only an owner pause resumes; a Stop stays. */
  async function resume(sessionId) {
    if (watch.pausedFor(sessionId) !== 'owner') return { ok: true, held: false };
    const host = currentHost();
    if (!host) return { ok: false, reason: 'unavailable' };
    try {
      if (!await watch.resume(host, sessionId)) return { ok: true, held: false };
    } catch (_error) {
      // The helper restarted while the owner had control: start the watch again, which also clears the pause.
      const turnId = turnOf(sessionId);
      if (watch.running() || !turnId || watch.pausedFor(sessionId) !== 'owner') return { ok: false, reason: 'helper_failed' };
      try { await watch.begin(host, sessionId, turnId); } catch (_again) { return { ok: false, reason: 'helper_failed' }; }
    }
    expired.delete(sessionId);
    // The owner may have moved or resized the window while it was theirs: the next input needs a fresh picture.
    const chat = getChat(sessionId);
    if (chat) chat.capturedTurn = null;
    const held = hold.release(sessionId, 'resumed');
    emit(sessionId, 'thinking');
    return { ok: true, held };
  }

  /** Stop from the pill or the chat: as the Stop chord, the held step (or the next one) ends the turn. */
  function stop(sessionId) {
    watch.markPaused(sessionId, 'stop');
    const turnId = turnOf(sessionId);
    if (turnId) stops.set(sessionId, turnId);
    return { ok: true, held: hold.release(sessionId, 'stopped') };
  }

  /** The turn ended or the chat went away: release a held step and say the turn is idle. */
  function end(sessionId) {
    stops.delete(sessionId);
    expired.delete(sessionId);
    hold.release(sessionId, 'stopped');
    emit(sessionId, 'idle');
  }

  return { emit, onWatchEvent, holdStep, resume, stop, stopRequested, end };
}

module.exports = { createOwnerControl };
