'use strict';

/* services/terminal-tools-service.js - the port behind `terminal_read` and `terminal_run` (row 94 P4,
 * docs/plans/APP_CONTROL_P4_EXPORT_TERMINAL_2026-11-02.md section 4.2; owner picks T1 and C1).
 *
 * - `read` answers from the pty service's main-side tail (services/workspace-terminal-tail.js: ANSI-stripped,
 *   bounded, cleared when a terminal ends), with secret-looking values redacted. The Jenny chat may read any live
 *   terminal; a project chat only while the IDE has that chat's project open. Terminal text is data.
 * - `prepareRun` runs before the card (services/backend/app-control-card-refusals.js): one plain command line and the
 *   folder it starts in, remembered under the tool call. The folder is the terminal start folder (Settings, else the
 *   Downloads folder; services/terminal-start-folder.js), so the Jenny chat needs no project; `where: "project"` uses
 *   the project the IDE has open instead. `run` acts only under that call's card (single use, the same command and
 *   place), sends ONE `terminalTools.onRunRequest` push to the main window and waits for the renderer's
 *   `terminalTools.reportRun`: the IDE opens a terminal of its own for it (openTaskTerminal: an idle Jenny terminal
 *   or a new one, never a shell the user is using), starts its shell and sends the line. There is no exit code
 *   (no shell integration), so the answer is "sent to terminal N" and the model reads the output with `read`.
 * A project chat may run too (row 178, owner pick D4), on its own project only: it is refused (`not_in_project`) unless
 * that project is the one the IDE has open, checked again at run time; it always runs in the project folder and may not ask
 * for the start folder. Every run is carded; the approval policy never offers "Always allow".
 * Desktop only: hosted mode has no pty bridge. Answers carry stable reasons, never exception text.
 */

const { redactExportSecrets } = require('./backend/transcript-export-redaction');
const { redactSecretLikeText } = require('./backend/tool-loop-input-sanitization');

const { GENERAL_PROJECT_ID } = require('./projects/project-schema');

const LIMITS = Object.freeze({ command_chars: 2000, read_chars: 16_000, cards_max: 16, tracked_max: 16 });
// Longer than the longest approval wait (an unattended-pause card waits up to 4 hours), so an approved card is never
// forgotten before the user answers it; the map is bounded by `cards_max` either way.
const CARD_TTL_MS = 4 * 60 * 60 * 1000 + 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 30_000;
// Controls, format characters (bidi overrides, zero-width), and line or paragraph separators: none may hide in a
// command the card shows as one line.
const UNSAFE_COMMAND_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RUN_REASONS = new Set(['no_free_terminal', 'start_failed', 'send_failed', 'no_ide', 'root_missing', 'start_folder_unavailable']);
// Where the shell starts (2026-11-17 owner pick): the start folder (Settings, else Downloads) by default; the
// project the IDE has open only when the model asks for it.
const WHERE = Object.freeze({ START_FOLDER: 'start_folder', PROJECT: 'project' });
// Absent is the start folder; any word but the two is refused before a card (the tool's schema refuses it too).
const whereOf = (value) => (value === undefined || value === null ? WHERE.START_FOLDER
  : (value === WHERE.START_FOLDER || value === WHERE.PROJECT ? value : null));

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
  workspaceRoot = () => '', startFolder = () => ({ ok: false, reason: 'start_folder_unavailable' }),
  sessionSummary = () => null, projectService = () => null, projectApplicationService = () => null,
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

  // The project a chat belongs to, or '' (the General bucket is no project; a spawned child runs nothing).
  function projectIdOf(callerId) {
    const summary = read(() => read(sessionSummary)?.(callerId));
    const projectId = summary?.project_id;
    return typeof projectId === 'string' && projectId !== GENERAL_PROJECT_ID && !summary?.spawned_from ? projectId : '';
  }

  // `null` while the IDE has that project open, else `not_in_project`.
  async function inOpenProject(projectId) {
    const project = projectId ? read(() => read(projectService)?.get?.(projectId)) : null;
    if (!project?.root_path) return 'not_in_project';
    try {
      return await read(projectApplicationService)?.isCurrentProject?.(project) === true ? null : 'not_in_project';
    } catch (_error) {
      return 'not_in_project';
    }
  }

  // A project chat reads only while the IDE has its project open; the Jenny chat may read any terminal.
  async function mayRead(callerId) {
    return isPrimary(callerId) ? null : inOpenProject(projectIdOf(callerId));
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

  // The Jenny chat runs anywhere the card names; a project chat only while its own project is the one the IDE has
  // open (2026-11-17 owner pick D4); a chat with no project never.
  async function gateRun(callerId) {
    if (!enabled()) return 'disabled';
    if (isPrimary(callerId)) return null;
    const projectId = typeof callerId === 'string' && callerId ? projectIdOf(callerId) : '';
    return projectId ? inOpenProject(projectId) : 'not_allowed';
  }

  // The place a call runs in: the Jenny chat's own pick (start folder when absent); a project chat always its project.
  function placeOf(callerId, where) {
    if (isPrimary(callerId)) return whereOf(where);
    return where === undefined || where === null || where === WHERE.PROJECT ? WHERE.PROJECT : null;
  }

  function remember(callId, card) {
    const at = now();
    for (const [key, entry] of cards) if (entry.expires <= at) cards.delete(key);
    cards.delete(callId);
    cards.set(callId, card);
    while (cards.size > LIMITS.cards_max) cards.delete(cards.keys().next().value);
  }

  // The folder a run would start in, or a refusal reason.
  function folderFor(where) {
    if (where === WHERE.PROJECT) {
      const root = String(read(workspaceRoot) || '').trim();
      return root ? { folder: root } : { reason: 'project_not_open' };
    }
    const answer = read(startFolder);
    return answer?.ok === true && typeof answer.folder === 'string' && answer.folder
      ? { folder: answer.folder } : { reason: 'start_folder_unavailable' };
  }

  /** Before the card: `{ok, folder}` when the command may be asked about, else a refusal. */
  async function prepareRun({ session_id: callerId, tool_call_id: callId, command, where } = {}) {
    const blocked = await gateRun(callerId);
    if (blocked) return refusal(blocked);
    if (typeof callId !== 'string' || !callId || callId.length > 256) return refusal('unavailable');
    if (!validCommand(command)) return refusal('invalid_command');
    const place = placeOf(callerId, where);
    if (!place) return refusal(where === WHERE.START_FOLDER ? 'project_chat_runs_in_project' : 'invalid_input');
    const target = folderFor(place);
    if (!target.folder) return refusal(target.reason);
    remember(callId, { caller: callerId, command, where: place, folder: target.folder, expires: now() + CARD_TTL_MS });
    return { ok: true, folder: target.folder, where: place }; // the card names the folder the command runs in
  }

  // This call's card when it matches (spent either way), else null.
  function take(callId, callerId, command, where) {
    const card = typeof callId === 'string' ? cards.get(callId) : null;
    if (!card) return null;
    cards.delete(callId); // one card, one run
    return card.expires > now() && card.caller === callerId && card.command === command && card.where === placeOf(callerId, where) ? card : null;
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
  async function run({ caller_session_id: callerId, tool_call_id: callId, command, where } = {}) {
    const blocked = await gateRun(callerId);
    if (blocked) return refusal(blocked);
    const card = take(callId, callerId, command, where);
    if (!card) return refusal('not_allowed'); // no card was shown for this call
    const place = card.where;
    // The run starts where the approved card said, or not at all (the pty re-resolves at spawn, seconds later).
    const target = folderFor(place);
    if (!target.folder) return refusal(target.reason);
    if (target.folder !== card.folder) return refusal('folder_changed');
    if (!read(isRendererAvailable)) return refusal('unavailable');
    sequence += 1;
    const requestId = `trm-${now().toString(36)}-${sequence}`;
    const answer = awaitReport(requestId);
    try {
      // Only the closed word crosses; main's pty service resolves the start folder itself at spawn.
      sendBridgeEvent('terminalTools.onRunRequest', {
        request_id: requestId, command, ...(place === WHERE.START_FOLDER ? { place: 'start_folder' } : {}),
      });
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
