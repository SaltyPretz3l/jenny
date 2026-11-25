'use strict';

/* services/computer-use/computer-use-service.js: the `computer` tool's service (row 196).
 *
 * Electron owns the grants, the mouse, the step budget and the owner's watch; the native helper owns the
 * pictures and the input and checks every input again at the moment it sends it (expect.js). One gate
 * (grant-gate.js) lives per chat, so a grant lasts the chat and a person answers every card. This file is
 * the policy between the tool body (services/tools/builtin/computer-tool.js) and the helper host
 * (services/computer-helper/host.js, shared with the live run view). It never throws: every outcome is a
 * status the model can read (result-format.js). Whatever is on screen, a window title or a program name is
 * untrusted data: it reaches the model only as text and never shapes a path, a command or a log line. */

const { buildExpect } = require('./expect');
const { createGrantGate } = require('./grant-gate');
const { createMouseLock } = require('./mouse-lock');
const { createOwnerControl } = require('./owner-control');
const { allowsInput, normalizeProgramPath } = require('./program-rules');
const fmt = require('./result-format');
const { createTurnWatch } = require('./turn-watch');
const { HELPER_TIMEOUT_MS, parseInput, helperTimeoutMs } = require('./parse-input');

const MAX_LONG_EDGE = 1280;
const MAX_IDENTIFY = 40;
const MAX_LISTED = 20;
const OPEN_POLL_MS = 250;
const OPEN_WAIT_MS = 15000;
const CAPTURE_TIMEOUT_MS = 15000;
const DIALOG_CLASS = '#32770';
const CANCELLED = Symbol('cancelled');

const TEXT = Object.freeze({
  lookFirst: 'Here is the window; look before acting.',
  busy: 'Another chat is using the mouse.',
  declined: 'The owner said no.',
  unanswerable: 'There is no one to ask here, so that program cannot be used.',
  never: 'That program cannot be used by Jenny.',
  tooMany: 'Too many programs are granted in this chat.',
  viewOnly: 'That program is view only: Jenny can look at it but not click or type in it.',
  notGranted: 'That program is not granted in this chat. Use focus or open first.',
  noProgramFile: 'That program can be focused once it is open, but not started from here.',
  notOpen: 'It is not open. Use open to start it.',
  notFound: 'No program by that name was found.',
  noInput: 'Jenny cannot send input to that window.',
  // Sitting B: the model said "done" from panel text when the program had not taken the order.
  checkIt: 'Done means the input was sent, not that it worked: check the change itself on this picture before you say it did.',
});

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The answer of an async step, or null when it throws: a failed look or ask is treated as no answer. */
async function attempt(step) {
  try { return await step(); } catch (_error) { return null; }
}

function baseName(programPath) {
  const file = normalizeProgramPath(programPath).split('\\').pop() || '';
  return file.endsWith('.exe') ? file.slice(0, -4) : file;
}

/** The program file's name as it is written, without `.exe`: what a card shows. */
function displayName(programPath) {
  const file = String(programPath || '').split(/[\\/]/).pop() || '';
  return file.toLowerCase().endsWith('.exe') ? file.slice(0, -4) : file;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getHost the shared helper host; may throw or return null
 * @param {{ find: Function, launch: Function }} deps.finder the program finder
 * @param {() => { pids: number[], programs: string[] }} deps.jennyIdentity every process and program file of Jenny
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {number} [deps.settleMs] the wait between an input and the picture that follows it
 * @param {number} [deps.stepBudget] steps a chat may take in one turn
 * @param {{ warn?: Function }} [deps.logger]
 * @param {(state: object) => void} [deps.onTurnState] { sessionId, state: 'step'|'thinking'|'paused'|'idle', action,
 *   programName, screenPoint } for the frame, the pill and the chat; programName is the app's reading of the file
 * @param {object} [deps.hold] the owner-hold options (limitMs and timers, for tests)
 */
function createComputerUseService({
  getHost, finder, jennyIdentity, now = Date.now, sleep = defaultSleep, settleMs = 180, stepBudget = 60, logger,
  onTurnState = null, hold: holdOptions = {},
} = {}) {
  const chats = new Map();
  const lock = createMouseLock();
  const watch = createTurnWatch({ now });
  let attached = null;
  const owner = createOwnerControl({
    watch, getChat: (sessionId) => chats.get(sessionId), currentHost: () => currentHost(), onTurnState, hold: holdOptions, now,
  });

  function readIdentity() {
    try {
      const value = jennyIdentity();
      return { pids: Array.isArray(value?.pids) ? value.pids : [], programs: Array.isArray(value?.programs) ? value.programs : [] };
    } catch (_error) {
      return { pids: [], programs: [] };
    }
  }

  function chatFor(sessionId) {
    let chat = chats.get(sessionId);
    if (!chat) {
      chat = {
        gate: createGrantGate({ jennyPrograms: () => readIdentity().programs, now }),
        target: null, // { hwnd, program, grant, scale, width, height, signature, bounds }
        liveTurn: null,
        capturedTurn: null,
        steps: { turnId: null, count: 0 },
        tail: Promise.resolve(),
      };
      chats.set(sessionId, chat);
    }
    return chat;
  }

  // ---- the helper host ----------------------------------------------------------------------

  function currentHost() {
    let host;
    try { host = getHost?.(); } catch (_error) { return null; }
    if (!host || typeof host.request !== 'function') return null;
    if (attached?.host !== host) {
      detach();
      if (typeof host.on === 'function') {
        const onEvent = (name) => {
          if (name !== 'watch.owner_input' && name !== 'watch.stop_chord') return;
          // Only the chat holding the mouse is using the watch.
          const holder = lock.holder();
          if (holder) owner.onWatchEvent(holder, name);
        };
        const onExit = () => watch.lost();
        host.on('event', onEvent);
        host.on('helper_exited', onExit);
        attached = { host, onEvent, onExit };
      } else attached = { host };
    }
    return host;
  }

  function detach() {
    if (!attached?.onEvent) { attached = null; return; }
    const { host, onEvent, onExit } = attached;
    attached = null;
    if (typeof host.removeListener === 'function') {
      host.removeListener('event', onEvent);
      host.removeListener('helper_exited', onExit);
    }
  }

  async function bestEffort(host, op) {
    try { await host.request(op, {}, { timeoutMs: HELPER_TIMEOUT_MS }); } catch (_error) { /* nothing more to do for a helper that is gone */ }
  }

  // ---- one call -----------------------------------------------------------------------------

  const live = (c) => { if (c.signal?.aborted) throw CANCELLED; };

  function out(c, status, message, extra = {}) {
    const name = c.chat.target?.grant?.name;
    return fmt.outcome({
      status, action: c.action, message, ...(name ? { program: name } : {}),
      ...(c.waitedMs > 0 ? { humanWaitMs: c.waitedMs } : {}), ...extra,
    });
  }

  // A person's wait must not use up the turn's deadline: the clocks stop while a card is up.
  function wrapAuthorize(ctx) {
    if (typeof ctx.authorize !== 'function') return null;
    return async (params, signal) => {
      const resume = typeof ctx.suspendTurnClocks === 'function' ? await attempt(async () => ctx.suspendTurnClocks()) : null;
      try {
        return await ctx.authorize(params, signal);
      } finally {
        if (typeof resume === 'function') { try { resume(); } catch (_error) { /* a clock that cannot resume must not hide the answer */ } }
      }
    };
  }

  function denied(c, answer) {
    c.waitedMs += answer.waitedMs || 0;
    const status = answer.reason === 'declined' ? 'declined' : 'refused';
    const message = { declined: TEXT.declined, never: TEXT.never, view_only: TEXT.viewOnly, too_many: TEXT.tooMany }[answer.reason] || TEXT.unanswerable;
    const refusal = status === 'refused' ? ({ never: 'never', view_only: 'view_only', too_many: 'too_many' }[answer.reason] || 'unanswerable') : '';
    return out(c, status, message, refusal ? { refusal } : {});
  }

  /** Apply what a helper error means for the service, and answer. The owner's input mid-step holds the step. */
  async function fail(c, error) {
    const mapped = fmt.mapHelperError(error);
    if (mapped.clearTarget && c.chat.target && (c.hwnd === undefined || c.chat.target.hwnd === c.hwnd)) c.chat.target = null;
    if (mapped.pause) {
      watch.markPaused(c.sessionId, mapped.pause);
      return holdForOwner(c);
    }
    if (mapped.watchLost) watch.lost(c.sessionId);
    return out(c, mapped.status, mapped.message, mapped.refusal ? { refusal: mapped.refusal } : {});
  }

  /** The owner has the mouse: hold the step open until Resume, Stop, the turn's end or the limit (D1 A). */
  async function holdForOwner(c) {
    const held = await owner.holdStep(c);
    c.waitedMs += held.waitedMs;
    // Answered here, not thrown: a hold can start inside perform's catch (fail), where a throw would escape it.
    if (held.cancelled) return cancelled(c);
    // The owner may have moved the window while it was theirs: the next input needs a fresh picture.
    if (held.status === 'resumed') c.chat.capturedTurn = null;
    return out(c, held.status, held.message);
  }

  async function cancelled(c) {
    if (c.host) await bestEffort(c.host, 'input.release_all');
    return out(c, 'cancelled', 'The step was cancelled.');
  }

  async function takePicture(c) {
    const target = c.chat.target;
    c.hwnd = target.hwnd;
    // A closed window's handle can be reused by another program's window: look only at the granted one.
    const identity = await c.host.request('program.identify', { hwnd: target.hwnd }, { timeoutMs: HELPER_TIMEOUT_MS });
    live(c);
    if (typeof identity?.program !== 'string' || normalizeProgramPath(identity.program) !== normalizeProgramPath(target.program)) {
      throw Object.assign(new Error('window changed program'), { code: 'no_such_window' });
    }
    const shot = await c.host.request('capture', { hwnd: target.hwnd, max_long_edge: MAX_LONG_EDGE, area: 'bounds' }, { timeoutMs: CAPTURE_TIMEOUT_MS });
    live(c);
    const buffer = Buffer.from(String(shot?.png_base64 || ''), 'base64');
    if (!buffer.length || !Number.isFinite(shot.width) || !Number.isFinite(shot.height) || !(shot.scale > 0)) {
      throw new Error('unreadable picture');
    }
    const signature = String(shot.signature || '');
    const screenChanged = target.signature !== signature;
    Object.assign(target, { scale: shot.scale, width: shot.width, height: shot.height, signature });
    c.chat.capturedTurn = c.turnId;
    return { image: { buffer, width: shot.width, height: shot.height, mime_type: 'image/png' }, width: shot.width, height: shot.height, signature, screenChanged };
  }

  /** Visible, not cloaked, not tool windows, each with the program `program.identify` names (at most 40 asked). */
  async function openWindows(c, known = new Map()) {
    const list = await c.host.request('windows.list', {}, { timeoutMs: HELPER_TIMEOUT_MS });
    live(c);
    const windows = (Array.isArray(list?.windows) ? list.windows : [])
      .filter((item) => item && Number.isSafeInteger(item.hwnd) && item.visible === true && !item.cloaked && !item.tool_window)
      .slice(0, MAX_IDENTIFY);
    const found = [];
    for (const item of windows) {
      let program = known.get(item.hwnd);
      if (!program) {
        const identity = await attempt(() => c.host.request('program.identify', { hwnd: item.hwnd }, { timeoutMs: HELPER_TIMEOUT_MS }));
        live(c);
        program = typeof identity?.program === 'string' && identity.program ? identity.program : null;
        if (program) known.set(item.hwnd, program);
      }
      if (program) found.push({ hwnd: item.hwnd, pid: item.pid, title: String(item.title ?? ''), program, bounds: item.bounds || null });
    }
    return found;
  }

  async function findPrograms(name) {
    try {
      const matches = await finder.find(name);
      return Array.isArray(matches) ? matches.filter((item) => item && typeof item === 'object') : [];
    } catch (_error) {
      return [];
    }
  }

  function guard(c, target, grant) {
    try {
      return buildExpect({ hwnd: target.hwnd, grant, jenny: readIdentity() });
    } catch (_error) {
      return null;
    }
  }

  /** The mouse lock, the watch and the owner's pause. Returns an outcome to answer with, or null to go on. */
  async function acquireInput(c) {
    if (!lock.acquire(c.sessionId)) return out(c, 'busy', TEXT.busy);
    if (!watch.has(c.sessionId, c.turnId)) {
      await watch.begin(c.host, c.sessionId, c.turnId);
      live(c);
      if (owner.stopRequested(c.sessionId, c.turnId)) watch.markPaused(c.sessionId, 'stop'); // pressed before the watch ran
    }
    return watch.pausedFor(c.sessionId) ? holdForOwner(c) : null;
  }

  // ---- looking ------------------------------------------------------------------------------

  async function screenshot(c) {
    if (!c.chat.target) return out(c, 'no_target', fmt.NO_TARGET);
    const picture = await takePicture(c);
    return out(c, 'done', 'Here is the window.', picture);
  }

  async function waitAction(c) {
    if (!c.chat.target) return out(c, 'no_target', fmt.NO_TARGET);
    await sleep(c.args.seconds * 1000, c.signal);
    live(c);
    const picture = await takePicture(c);
    return out(c, 'done', `Waited ${c.args.seconds} seconds.`, picture);
  }

  async function windowsAction(c) {
    const open = await openWindows(c);
    const lines = [];
    for (const item of open) {
      const grant = c.chat.gate.check(item.program);
      if (grant && lines.length < MAX_LISTED) lines.push(`- ${grant.name}: ${fmt.oneLine(item.title, 120) || '(no title)'}`);
    }
    return out(c, 'done', lines.length ? `Open windows of granted programs:\n${lines.join('\n')}` : 'No window of a granted program is open. Use focus or open.');
  }

  // ---- focus and open -----------------------------------------------------------------------

  /** Bring a granted program's window forward, make it the target and answer with its picture. */
  async function bringForward(c, found, grant, message) {
    c.hwnd = found.hwnd;
    // Bringing any window forward takes the screen from the owner, so it waits for them like input does.
    const blocked = await acquireInput(c);
    if (blocked) return blocked;
    if (allowsInput(grant.kind)) {
      const expect = guard(c, found, grant);
      if (!expect) return out(c, 'refused', TEXT.noInput);
      await c.host.request('input.focus', { expect }, { timeoutMs: HELPER_TIMEOUT_MS });
    } else {
      await c.host.request('window.show', { hwnd: found.hwnd, mode: 'front' }, { timeoutMs: HELPER_TIMEOUT_MS });
    }
    live(c);
    c.chat.target = { hwnd: found.hwnd, program: grant.program, grant, scale: null, width: null, height: null, signature: null, bounds: found.bounds };
    c.chat.capturedTurn = null;
    await sleep(settleMs * 3, c.signal);
    live(c);
    return out(c, 'done', `${message} Here is the window.`, await takePicture(c));
  }

  async function focusAction(c) {
    const needle = c.args.name.toLowerCase();
    const open = await openWindows(c);
    const found = open.find((item) => baseName(item.program).includes(needle) || item.title.toLowerCase().includes(needle));
    if (!found) {
      const known = await findPrograms(c.args.name);
      live(c);
      return out(c, 'not_found', known.length ? TEXT.notOpen : TEXT.notFound);
    }
    // The card names the program by its file, the app's own reading, never by the model's words.
    const answer = await c.gate.ensureGranted(found.program, { name: displayName(found.program), input: false });
    live(c);
    if (!answer.allowed) return denied(c, answer);
    c.waitedMs += answer.waitedMs;
    return bringForward(c, found, answer.grant, 'Focused.');
  }

  async function waitForWindow(c, program) {
    const want = normalizeProgramPath(program);
    const known = new Map();
    const startedAt = now();
    for (let poll = 0; poll < OPEN_WAIT_MS / OPEN_POLL_MS; poll += 1) {
      const found = (await openWindows(c, known)).find((item) => normalizeProgramPath(item.program) === want);
      if (found) return found;
      if (now() - startedAt >= OPEN_WAIT_MS) break;
      await sleep(OPEN_POLL_MS, c.signal);
      live(c);
    }
    return null;
  }

  async function openAction(c) {
    const matches = await findPrograms(c.args.name);
    live(c);
    if (!matches.length) return out(c, 'not_found', TEXT.notFound);
    const match = matches.find((item) => typeof item.program === 'string' && item.program.trim());
    if (!match) return out(c, 'refused', TEXT.noProgramFile);
    const label = typeof match.name === 'string' && match.name.trim() ? match.name : c.args.name;
    const answer = await c.gate.allowOpen(match.program, { name: label });
    live(c);
    if (!answer.allowed) return denied(c, answer);
    c.waitedMs += answer.waitedMs;
    const launched = await attempt(() => finder.launch(match));
    live(c);
    if (!launched?.ok) return out(c, 'failed', 'The program could not be started.');
    const found = await waitForWindow(c, match.program);
    if (!found) return out(c, 'failed', 'The program was started, but no window for it appeared in time. Try focus in a moment.');
    return bringForward(c, found, answer.grant, 'Opened.');
  }

  // ---- input --------------------------------------------------------------------------------

  /** The first standard Open or Save dialog of the target's program in a chat asks a person (D9). */
  async function dialogCheck(c, target) {
    if (c.chat.gate.fileDialogAnswered(target.program)) return null;
    const list = await attempt(() => c.host.request('windows.list', {}, { timeoutMs: HELPER_TIMEOUT_MS }));
    live(c);
    // Fails closed: with no list, an Open or Save dialog could be showing unasked.
    if (!list) return out(c, 'failed', 'Jenny could not check for an Open or Save window. Try the step again.');
    const windows = Array.isArray(list?.windows) ? list.windows : [];
    const mine = windows.find((item) => item?.hwnd === target.hwnd);
    if (!mine || !windows.some((item) => item?.pid === mine.pid && item.visible === true && !item.cloaked && item.class === DIALOG_CLASS)) return null;
    const answer = await c.gate.allowFileDialog(target.program);
    live(c);
    if (!answer.allowed) return denied(c, answer);
    c.waitedMs += answer.waitedMs;
    return null;
  }

  async function inputAction(c) {
    const { chat } = c;
    const target = chat.target;
    if (!target) return out(c, 'no_target', fmt.NO_TARGET);
    c.hwnd = target.hwnd;
    const grant = chat.gate.check(target.program, { input: true });
    if (!grant) return out(c, 'refused', chat.gate.check(target.program) ? TEXT.viewOnly : TEXT.notGranted);
    if (chat.capturedTurn !== c.turnId) return out(c, 'done', TEXT.lookFirst, await takePicture(c));
    const blocked = await acquireInput(c);
    if (blocked) return blocked;
    const dialog = await dialogCheck(c, target);
    if (dialog) return dialog;
    const expect = guard(c, target, grant);
    if (!expect) return out(c, 'refused', TEXT.noInput);
    const request = { expect, ...(c.args.pointer ? { scale: target.scale } : {}), ...c.args.params };
    await c.host.request(c.args.op, request, { timeoutMs: helperTimeoutMs(c.args) });
    live(c);
    // Typing and keys get a longer settle: a picture right after `type` showed the window before it repainted.
    const keyboard = c.args.action === 'type' || c.args.action === 'key';
    await sleep(keyboard ? settleMs * 2 : settleMs, c.signal);
    live(c);
    const sent = `${c.args.action === 'type' ? `Typed ${c.args.params.text.length} characters.` : `Sent ${c.args.action}.`} ${TEXT.checkIt}`;
    try {
      return out(c, 'done', sent, await takePicture(c));
    } catch (error) {
      if (error === CANCELLED) throw error;
      return out(c, 'done', `${sent} The new picture could not be taken; use screenshot.`);
    }
  }

  const HANDLERS = {
    screenshot, wait: waitAction, windows: windowsAction, focus: focusAction, open: openAction,
    click: inputAction, drag: inputAction, move: inputAction, scroll: inputAction, type: inputAction, key: inputAction,
  };

  function countStep(chat, turnId) {
    if (chat.steps.turnId !== turnId) chat.steps = { turnId, count: 0 };
    chat.steps.count += 1;
    return chat.steps.count <= stepBudget;
  }

  async function perform(input, ctx, chat) {
    const parsed = parseInput(input);
    const c = {
      ctx, chat, host: null, gate: null, signal: ctx.abortSignal, args: parsed.args, hwnd: undefined, waitedMs: 0,
      sessionId: ctx.sessionId, turnId: ctx.turnId,
      action: parsed.args?.action || (fmt.ACTIONS.includes(input?.action) ? input.action : 'unknown'),
    };
    try {
      live(c);
      if (!parsed.ok) return out(c, 'invalid', parsed.message);
      c.host = currentHost();
      if (!c.host) return out(c, 'unavailable', 'Computer use is not available right now.');
      if (!countStep(chat, ctx.turnId)) {
        return out(c, 'budget', `This turn has used its ${stepBudget} computer steps. Stop and tell the owner what is left; they can say continue.`);
      }
      c.gate = chat.gate.forCall({ authorize: wrapAuthorize(ctx), callId: ctx.callId, toolInput: input, signal: ctx.abortSignal });
      chat.liveTurn = ctx.turnId;
      // After Stop (pill, chat or the Stop key) every step of the turn answers at once, looking included.
      if ((watch.has(c.sessionId, ctx.turnId) && watch.pausedFor(c.sessionId) === 'stop') || owner.stopRequested(c.sessionId, ctx.turnId)) {
        return out(c, 'paused_by_user', fmt.OWNER_STOPPED);
      }
      owner.emit(c.sessionId, 'step', c.action);
      const result = await HANDLERS[c.action](c);
      if (chat.liveTurn) owner.emit(c.sessionId, 'thinking', c.action);
      return result;
    } catch (error) {
      if (error === CANCELLED) return cancelled(c);
      if (typeof error?.code === 'string' && error.code !== 'ERR_ASSERTION') return await fail(c, error);
      // The error text can hold a path or a title: log only what kind of error it was.
      logger?.warn?.(`computer-use step failed: ${String(error?.name || 'Error').slice(0, 40)}`);
      return out(c, 'failed', 'The computer step failed.');
    }
  }

  /** @returns {Promise<object>} an outcome; never rejects */
  async function execute(input, ctx = {}) {
    const action = typeof input?.action === 'string' ? input.action : 'unknown';
    try {
      if (typeof ctx.sessionId !== 'string' || !ctx.sessionId || !ctx.turnId) {
        return fmt.outcome({ status: 'failed', action, message: 'The computer step failed.' });
      }
      const chat = chatFor(ctx.sessionId);
      // One call at a time per chat, so the target and the picture facts stay in step.
      const job = chat.tail.then(() => perform(input, ctx, chat));
      chat.tail = job.then(() => {}, () => {});
      return await job;
    } catch (_error) {
      return fmt.outcome({ status: 'failed', action, message: 'The computer step failed.' });
    }
  }

  // ---- the end of a turn --------------------------------------------------------------------

  async function finishHolding(sessionId) {
    const host = currentHost();
    if (lock.holder() === sessionId) {
      if (host) await bestEffort(host, 'input.release_all');
      lock.release(sessionId);
    }
    await watch.end(host, sessionId, { othersHold: lock.holder() !== null });
  }

  async function onTurnEnd(sessionId) {
    owner.end(sessionId);
    try { await finishHolding(sessionId); } catch (_error) { /* a turn that ends must end */ }
  }

  async function forgetChat(sessionId) {
    owner.end(sessionId);
    try { await finishHolding(sessionId); } catch (_error) { /* as above */ }
    chats.get(sessionId)?.gate.clear();
    chats.delete(sessionId);
  }

  async function shutdown() {
    for (const sessionId of [...chats.keys()]) await forgetChat(sessionId);
    detach();
  }

  function revoke(sessionId, program) {
    const chat = chats.get(sessionId);
    if (!chat) return false;
    const revoked = chat.gate.revoke(program);
    if (chat.target && normalizeProgramPath(chat.target.program) === normalizeProgramPath(program)) chat.target = null;
    return revoked;
  }

  /** How long ago the owner last used the keyboard or mouse, from the helper; null while no watch runs. */
  async function lastRealInputAgeMs() {
    const host = watch.running() ? currentHost() : null;
    if (!host) return null;
    try {
      const state = await host.request('watch.state', {}, { timeoutMs: HELPER_TIMEOUT_MS });
      if (Number.isFinite(state?.last_real_input_ms)) return state.last_real_input_ms;
      const startedAt = watch.startedAt();
      return startedAt === null ? null : Math.max(0, now() - startedAt);
    } catch (_error) {
      return null;
    }
  }

  return {
    execute,
    onTurnEnd,
    forgetChat,
    grants: (sessionId) => chats.get(sessionId)?.gate.list() ?? [],
    revoke,
    lastRealInputAgeMs,
    holder: () => lock.holder(),
    resume: owner.resume,
    stop: owner.stop,
    stopChordRegistered: () => watch.registered(),
    shutdown,
  };
}

module.exports = { createComputerUseService };
