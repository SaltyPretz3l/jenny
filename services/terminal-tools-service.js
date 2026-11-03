'use strict';

/* services/terminal-tools-service.js - the port behind `terminal_read` and `terminal_run` (row 94 P4,
 * docs/plans/APP_CONTROL_P4_EXPORT_TERMINAL_2026-11-02.md section 4.2; owner picks T1 and C1).
 *
 * - `read` answers from the pty service's main-side tail (services/workspace-terminal-tail.js: ANSI-stripped,
 *   bounded, cleared when a terminal ends), with secret-looking values redacted. The Jenny chat may read any live
 *   terminal; a project chat only while the IDE has that chat's project open. Terminal text is data.
 * - `prepareRun` runs before the card (services/backend/app-control-card-refusals.js): one plain command line and a
 *   project open in the IDE, remembered under the tool call. `run` acts only under that call's card (single use,
 *   the same command), sends ONE `terminalTools.onRunRequest` push to the main window and waits for the renderer's
 *   `terminalTools.reportRun`: the IDE opens a terminal of its own for it (openTaskTerminal: an idle Jenny terminal
 *   or a new one, never a shell the user is using), starts its shell and sends the line. There is no exit code
 *   (no shell integration), so the answer is "sent to terminal N" and the model reads the output with `read`.
 * Desktop only: hosted mode has no pty bridge. Answers carry stable reasons, never exception text.
 */

const { redactExportSecrets } = require('./backend/transcript-export-redaction');
const { redactSecretLikeText } = require('./backend/tool-loop-input-sanitization');

const LIMITS = Object.freeze({ command_chars: 2000, read_chars: 16_000, cards_max: 16, tracked_max: 16 });
// Longer than the longest approval wait (an unattended-pause card waits up to 4 hours), so an approved card is never
// forgotten before the user answers it; the map is bounded by `cards_max` either way.
const CARD_TTL_MS = 4 * 60 * 60 * 1000 + 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 30_000;
// Controls, format characters (bidi overrides, zero-width), and line or paragraph separators: none may hide in a
// command the card shows as one line.
const UNSAFE_COMMAND_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RUN_REASONS = new Set(['no_free_terminal', 'start_failed', 'send_failed', 'no_ide']);

const refusal = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function read(getter) {
  try { return typeof getter === 'function' ? getter() ?? null : null; } catch (_error) { return null; }
}

function validCommand(command) {
  return typeof command === 'string' && command.trim() !== '' && command.length <= LIMITS.command_chars
    && !UNSAFE_COMMAND_RE.test(command);
}

// `printenv` / `cat .env` style lines: NAME=value where the name ends in a secret word (word-boundary key rules miss
// DB_PASSWORD, AWS_SECRET_ACCESS_KEY and the like).
const ENV_SECRET_RE = /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi;

function redactLine(text) {
  return redactSecretLikeText(redactExportSecrets(text)).replace(ENV_SECRET_RE, '$1=[redacted]');
}

// The newest lines that fit the character budget, redacted. A newest line longer than the whole budget keeps its end,
// so the model never reads an empty terminal where there was output.
function boundedLines(lines) {
  const kept = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = redactLine(String(lines[index] ?? ''));
    if (kept.length === 0 && line.length + 1 > LIMITS.read_chars) return { lines: [line.slice(-(LIMITS.read_chars - 1))], clipped: true };
    if (chars + line.length + 1 > LIMITS.read_chars) return { lines: kept.reverse(), clipped: true };
    kept.push(line);
    chars += line.length + 1;
  }
  return { lines: kept.reverse(), clipped: false };
}

function createTerminalToolsService({
  ptyService = () => null, featureFlags = () => ({}), primarySessionId = () => null, hostMode = () => 'desktop',
  workspaceRoot = () => '', sessionSummary = () => null, projectService = () => null, projectApplicationService = () => null,
  sendBridgeEvent = () => {}, isRendererAvailable = () => true, now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, log = () => {},
} = {}) {
  const cards = new Map(); // tool_call_id -> { caller, command, expires }
  const pending = new Map(); // request_id -> { resolve, timer }
  let sequence = 0;

  function enabled() {
    return (read(featureFlags) || {}).terminal_tools !== false && read(hostMode) !== 'server';
  }

  function isPrimary(id) {
    const primary = read(primarySessionId);
    return typeof id === 'string' && id !== '' && id === primary;
  }

  // A project chat reads only while the IDE has its project open; the Jenny chat may read any terminal.
  async function mayRead(callerId) {
    if (isPrimary(callerId)) return null;
    const projectId = read(() => read(sessionSummary)?.(callerId)?.project_id);
    const project = typeof projectId === 'string' && projectId ? read(() => read(projectService)?.get?.(projectId)) : null;
    if (!project?.root_path) return 'not_in_project';
    try {
      return await read(projectApplicationService)?.isCurrentProject?.(project) === true ? null : 'not_in_project';
    } catch (_error) {
      return 'not_in_project';
    }
  }

  /** `terminal_read`: the newest lines of one live terminal, or a refusal. */
  async function readTerminal({ session_id: callerId, terminal, lines } = {}) {
    if (!enabled()) return refusal('disabled');
    if (typeof callerId !== 'string' || !callerId) return refusal('not_allowed');
    const denied = await mayRead(callerId);
    if (denied) return refusal(denied);
    const pty = read(ptyService);
    if (typeof pty?.readTail !== 'function') return refusal('unavailable');
    const tail = pty.readTail({ slot: terminal ?? null, lines: lines ?? 80 });
    if (!tail?.ok) return refusal(tail?.reason === 'invalid_input' ? 'invalid_input' : 'no_terminal');
    const bounded = boundedLines(Array.isArray(tail.lines) ? tail.lines : []);
    const at = Number.isFinite(tail.last_output_at) ? new Date(tail.last_output_at).toISOString() : null;
    return { ok: true, terminal: tail.slot, lines: bounded.lines, truncated: tail.truncated === true || bounded.clipped, last_output_at: at };
  }

  function gateRun(callerId) {
    if (!enabled()) return 'disabled';
    return isPrimary(callerId) ? null : 'not_allowed';
  }

  function remember(callId, card) {
    const at = now();
    for (const [key, entry] of cards) if (entry.expires <= at) cards.delete(key);
    cards.delete(callId);
    cards.set(callId, card);
    while (cards.size > LIMITS.cards_max) cards.delete(cards.keys().next().value);
  }

  /** Before the card: `{ok}` when the command may be asked about, else a refusal. */
  function prepareRun({ session_id: callerId, tool_call_id: callId, command } = {}) {
    const blocked = gateRun(callerId);
    if (blocked) return refusal(blocked);
    if (typeof callId !== 'string' || !callId || callId.length > 256) return refusal('unavailable');
    if (!validCommand(command)) return refusal('invalid_command');
    const folder = String(read(workspaceRoot) || '').trim();
    if (!folder) return refusal('project_not_open');
    remember(callId, { caller: callerId, command, expires: now() + CARD_TTL_MS });
    return { ok: true, folder }; // the card names the folder the command runs in
  }

  function take(callId, callerId, command) {
    const card = typeof callId === 'string' ? cards.get(callId) : null;
    if (!card) return false;
    cards.delete(callId); // one card, one run
    return card.expires > now() && card.caller === callerId && card.command === command;
  }

  // The slot of a live pty session id, or null.
  function slotOf(sessionId) {
    const live = read(() => read(ptyService)?.liveTerminals?.());
    const found = Array.isArray(live) ? live.find((entry) => entry?.session_id === sessionId) : null;
    return Number.isInteger(found?.slot) ? found.slot : null;
  }

  function awaitReport(requestId) {
    return new Promise((resolve) => {
      const timer = setTimer(() => { pending.delete(requestId); resolve(refusal('unconfirmed')); }, RUN_TIMEOUT_MS);
      pending.set(requestId, { resolve, timer });
      while (pending.size > LIMITS.tracked_max) {
        const [oldest, entry] = pending.entries().next().value;
        pending.delete(oldest);
        clearTimer(entry.timer);
        entry.resolve(refusal('unconfirmed'));
      }
    });
  }

  /** `terminal_run`, under this call's card: `{ok, terminal}` once the line is sent, or a refusal. */
  async function run({ caller_session_id: callerId, tool_call_id: callId, command } = {}) {
    const blocked = gateRun(callerId);
    if (blocked) return refusal(blocked);
    if (!take(callId, callerId, command)) return refusal('not_allowed'); // no card was shown for this call
    if (!String(read(workspaceRoot) || '').trim()) return refusal('project_not_open');
    if (!read(isRendererAvailable)) return refusal('unavailable');
    sequence += 1;
    const requestId = `trm-${now().toString(36)}-${sequence}`;
    const answer = awaitReport(requestId);
    try {
      sendBridgeEvent('terminalTools.onRunRequest', { request_id: requestId, command });
    } catch (_error) {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      clearTimer(entry?.timer);
      log('WARN', 'terminal_run.dispatch_failed', {});
      return refusal('unavailable');
    }
    return answer;
  }

  /** The renderer's report for one request this service issued. */
  function recordRun(payload = {}) {
    // Only ids issued here are keys, so any other string misses.
    const requestId = typeof payload?.request_id === 'string' ? payload.request_id : '';
    const entry = requestId ? pending.get(requestId) : null;
    if (!entry) return refusal('unknown_request');
    pending.delete(requestId);
    clearTimer(entry.timer);
    if (payload.ok === true && typeof payload.session_id === 'string') {
      entry.resolve({ ok: true, terminal: slotOf(payload.session_id) });
    } else {
      entry.resolve(refusal(RUN_REASONS.has(payload.reason) ? payload.reason : 'start_failed'));
    }
    log('INFO', 'terminal_run.reported', { ok: payload.ok === true });
    return { ok: true };
  }

  return { prepareRun, readTerminal, recordRun, run };
}

module.exports = { LIMITS, createTerminalToolsService };
