'use strict';

/*
 * run-state.js — the live run view's state table (row 197, "The run" and
 * "States"). One table per project root: at most one active run per root,
 * whichever chat started it.
 *
 * transition(state, event) is pure. It returns the next state and the effects
 * the run service must carry out, or a refusal. The service owns timers, the
 * build process and the helper; this table owns every rule about what may
 * happen next:
 *
 *   - Start: only from a resting state (idle, build failed, ended before a
 *     window, closed itself). A second start while a run is live is refused
 *     and names the chat that started it.
 *   - Build, then start: a command with a build step builds first; a failed
 *     build leaves the run in build_failed with the compiler's tail.
 *   - Stop is close, then end. The owner's Stop asks the window to close
 *     (mode 'ask'); if the program is still there when the close timer fires,
 *     the run waits in close_refused for "Show window" or "Force stop".
 *     Restart, shutdown and the model's restart use mode 'force': close, then
 *     end the job after the helper's timeout. A run with no window is ended.
 *   - Every run has a generation. Events from an older generation are ignored,
 *     so a late exit from the previous program never ends the new one.
 *   - Before every stop the panel keeps the last frame as a still.
 */

const RESTING = Object.freeze(new Set(['idle', 'build_failed', 'ended_early', 'closed']));
const LIVE = Object.freeze(new Set(['starting', 'no_window', 'running', 'minimized']));
const STATES = Object.freeze([
  'idle', 'building', 'build_failed', 'starting', 'ended_early', 'no_window',
  'running', 'minimized', 'closed', 'stopping', 'close_refused',
]);

const NO_WINDOW_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const BUILD_TAIL_MAX_CHARS = 8_000;

function initialRunState() {
  return Object.freeze({
    state: 'idle',
    generation: 0,
    chatId: null,
    pid: null,
    hwnd: null,
    sourceId: null,
    hadWindow: false,
    exitCode: null,
    buildTail: '',
    stopMode: null,
    restartPending: false,
    restartChatId: null,
    restartHasBuild: false,
    reason: null,
  });
}

function next(state, patch, effects = []) {
  return { ok: true, state: Object.freeze({ ...state, ...patch }), effects: Object.freeze(effects) };
}

function refuse(state, reason, extra = {}) {
  return { ok: false, state, effects: Object.freeze([]), reason, ...extra };
}

function ignore(state) {
  return { ok: true, state, effects: Object.freeze([]), ignored: true };
}

function isResting(state) {
  return RESTING.has(state.state);
}

function isLive(state) {
  return LIVE.has(state.state);
}

// Begin a run (build first when the command has a build step).
function begin(state, { chatId, hasBuild }) {
  const generation = state.generation + 1;
  const base = {
    generation, chatId, pid: null, hwnd: null, sourceId: null, hadWindow: false,
    exitCode: null, buildTail: '', stopMode: null, restartPending: false, restartChatId: null,
    restartHasBuild: false, reason: null,
  };
  if (hasBuild) return next(state, { ...base, state: 'building' }, [{ kind: 'run_build', generation }]);
  return next(state, { ...base, state: 'starting' }, [{ kind: 'spawn', generation }]);
}

// Where a run goes once its program is gone: back to rest, or straight into
// the pending restart.
function settle(state, restingState, patch = {}) {
  const effects = [{ kind: 'clear_timers' }];
  if (state.restartPending) {
    const chatId = state.restartChatId || state.chatId;
    const restarted = begin({ ...state, ...patch }, { chatId, hasBuild: state.restartHasBuild === true });
    return { ...restarted, effects: Object.freeze([...effects, ...restarted.effects]) };
  }
  return next(state, { ...patch, state: restingState, stopMode: null, pid: null, hwnd: null, sourceId: null }, effects);
}

function stopEffects(state, mode) {
  if (state.state === 'building') return [{ kind: 'keep_last_frame' }, { kind: 'cancel_build' }];
  const effects = [{ kind: 'keep_last_frame' }, { kind: 'clear_timers' }];
  if (mode === 'ask' && state.hwnd !== null) {
    effects.push({ kind: 'close_window' }, { kind: 'arm_close_timer', ms: CLOSE_TIMEOUT_MS });
  } else {
    effects.push({ kind: 'force_stop' });
  }
  return effects;
}

/*
 * Events (every event but start, stop and restart carries the generation it
 * belongs to):
 *   start {chatId, hasBuild}           stop {mode: 'ask'|'force'}
 *   restart {chatId, hasBuild}         build_ok, build_failed {exitCode, tail}
 *   spawned {pid}                      spawn_failed {reason}
 *   window {hwnd, sourceId}            window_state {state}
 *   no_window_timeout                  close_timeout
 *   exited {exitCode}                  stopped {exitCode}
 */
function transition(state, event) {
  const type = event?.type;
  const current = state || initialRunState();
  if (type === 'start') {
    if (!isResting(current)) return refuse(current, 'already_running', { startedBy: current.chatId });
    return begin(current, { chatId: event.chatId ?? null, hasBuild: event.hasBuild === true });
  }
  if (type === 'restart') {
    if (isResting(current)) return begin(current, { chatId: event.chatId ?? null, hasBuild: event.hasBuild === true });
    if (current.state === 'stopping' || current.state === 'close_refused') {
      return next(current, {
        restartPending: true, restartChatId: event.chatId ?? null, restartHasBuild: event.hasBuild === true,
      }, current.state === 'close_refused' ? [{ kind: 'force_stop' }] : []);
    }
    return next(current, {
      state: 'stopping', stopMode: 'force', restartPending: true,
      restartChatId: event.chatId ?? null, restartHasBuild: event.hasBuild === true,
    }, stopEffects(current, 'force'));
  }
  if (type === 'stop') {
    const mode = event.mode === 'force' ? 'force' : 'ask';
    // A stop always cancels a pending restart: the program stays stopped.
    if (current.state === 'close_refused') {
      if (mode !== 'force') return ignore(current);
      return next(current, { state: 'stopping', stopMode: 'force', restartPending: false }, [{ kind: 'force_stop' }]);
    }
    if (current.state === 'stopping') {
      if (mode === 'force' && current.stopMode !== 'force') {
        return next(current, { stopMode: 'force', restartPending: false }, [{ kind: 'clear_timers' }, { kind: 'force_stop' }]);
      }
      if (current.restartPending) return next(current, { restartPending: false });
      return ignore(current);
    }
    if (current.state !== 'building' && !isLive(current)) return refuse(current, 'not_running');
    return next(current, { state: 'stopping', stopMode: mode, restartPending: false }, stopEffects(current, mode));
  }

  // Everything below belongs to one generation.
  if (event?.generation !== current.generation) return ignore(current);

  switch (type) {
    case 'build_ok':
      if (current.state !== 'building') return ignore(current);
      return next(current, { state: 'starting' }, [{ kind: 'spawn', generation: current.generation }]);
    case 'build_failed': {
      if (current.state === 'stopping') return settle(current, 'idle');
      if (current.state !== 'building') return ignore(current);
      const tail = String(event.tail || '').slice(-BUILD_TAIL_MAX_CHARS);
      return next(current, {
        state: 'build_failed', exitCode: event.exitCode ?? null, buildTail: tail, restartPending: false,
      }, [{ kind: 'clear_timers' }]);
    }
    case 'spawned':
      // The start reply can arrive after the run's first window event; it still names the process.
      if (current.state !== 'starting') return isLive(current) && current.pid === null ? next(current, { pid: event.pid ?? null }) : ignore(current);
      return next(current, { pid: event.pid ?? null }, [{ kind: 'arm_no_window_timer', ms: NO_WINDOW_TIMEOUT_MS }]);
    case 'spawn_failed':
      if (current.state === 'stopping') return settle(current, 'idle');
      if (current.state !== 'starting') return ignore(current);
      return next(current, { state: 'ended_early', reason: String(event.reason || 'start_failed') }, [{ kind: 'clear_timers' }]);
    case 'window':
      if (!isLive(current)) return ignore(current);
      return next(current, {
        state: 'running', hwnd: event.hwnd ?? null, sourceId: event.sourceId ?? null, hadWindow: true,
      }, [{ kind: 'clear_timers' }]);
    case 'window_state':
      if (!isLive(current)) return ignore(current);
      if (event.state === 'minimized') return next(current, { state: 'minimized' });
      if (event.state === 'restored') return next(current, { state: 'running' });
      if (event.state === 'destroyed') {
        // The helper looks for the run's next window (a splash, then the real one).
        return next(current, { state: 'starting', hwnd: null, sourceId: null },
          [{ kind: 'arm_no_window_timer', ms: NO_WINDOW_TIMEOUT_MS }]);
      }
      return ignore(current);
    case 'no_window_timeout':
      if (current.state !== 'starting') return ignore(current);
      return next(current, { state: 'no_window' });
    case 'close_timeout':
      if (current.state !== 'stopping' || current.stopMode !== 'ask') return ignore(current);
      if (current.restartPending) {
        return next(current, { stopMode: 'force' }, [{ kind: 'force_stop' }]);
      }
      return next(current, { state: 'close_refused' });
    case 'exited':
    case 'stopped': {
      const exitCode = event.exitCode ?? null;
      if (current.state === 'stopping' || current.state === 'close_refused') return settle(current, 'idle', { exitCode });
      if (!isLive(current)) return ignore(current);
      return settle(current, current.hadWindow ? 'closed' : 'ended_early', { exitCode });
    }
    default:
      return ignore(current);
  }
}

module.exports = {
  BUILD_TAIL_MAX_CHARS,
  CLOSE_TIMEOUT_MS,
  NO_WINDOW_TIMEOUT_MS,
  STATES,
  initialRunState,
  isLive,
  isResting,
  transition,
};
