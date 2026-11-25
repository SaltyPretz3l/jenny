/* What the chat shows for a computer step that did not work (row 196, C7 C8 C9): the dot and reason on its row, the
 * count under the answer, and the pause line with Resume and Stop. Reads only metadata.status and refusal_reason.
 * It also holds the computer tool's live turn state per chat (rendererComputerStepDisplay.turnState), which the pause
 * line and the Tools menu share; one file keeps the startup script count down. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rendererComputerStepDisplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count: count }, params || {})); };
  const WORKED = new Set(['done']);
  // Held while the owner had the mouse, then handed back: not a failure, but the action itself was not sent.
  const NOT_COUNTED = new Set(['done', 'resumed']);
  const RUNNING_ROW = '.tool-call-row--minimal[data-tool-name="computer"][data-tool-status="running"], .tool-call-row--minimal[data-tool-name="computer"][data-tool-status="executing"]';
  const isComputer = (metadata) => Boolean(metadata) && metadata.result_kind === 'computer';

  function reasonText(code) {
    switch (code) {
      case 'outside_window': return jt('chat.computerStep.reason.outsideWindow', 'outside the window');
      case 'refused_chord': return jt('chat.computerStep.reason.refusedChord', 'key not allowed');
      case 'password_field': return jt('chat.computerStep.reason.passwordField', 'password field');
      case 'elevated': return jt('chat.computerStep.reason.elevated', 'runs as administrator');
      case 'window_gone': return jt('chat.computerStep.reason.windowGone', 'the window closed');
      case 'wrong_program': return jt('chat.computerStep.reason.wrongProgram', 'a different program');
      case 'secure_desktop': return jt('chat.computerStep.reason.secureDesktop', 'the screen is locked');
      case 'never': return jt('chat.computerStep.reason.never', "Jenny can't use that program");
      case 'view_only': return jt('chat.computerStep.reason.viewOnly', 'view only');
      case 'too_many': return jt('chat.computerStep.reason.tooMany', 'too many programs');
      case 'unanswerable': return jt('chat.computerStep.reason.unanswerable', 'no one to ask');
      default: return jt('chat.computerStep.reason.blocked', 'blocked');
    }
  }

  function summaryFor(status, reason) {
    switch (status) {
      case 'refused': return jt('chat.computerStep.refused', "Didn't work: {reason}", { reason: reasonText(reason) });
      case 'declined': return jt('chat.computerStep.declined', 'You denied it');
      case 'paused_by_user': return jt('chat.computerStep.pausedByUser', 'Paused: you took the mouse');
      case 'resumed': return jt('chat.computerStep.resumed', 'Paused, then handed back: not done');
      case 'no_target': return jt('chat.computerStep.noTarget', "Didn't work: no window in front");
      case 'not_found': return jt('chat.computerStep.notFound', "Didn't work: no program by that name");
      case 'busy': return jt('chat.computerStep.busy', 'Waited: another chat has the mouse');
      case 'budget': return jt('chat.computerStep.budget', 'Stopped at the step limit');
      default: return jt('chat.computerStep.failed', "Didn't work");
    }
  }

  /** The dot tone and one-line reason for a computer step that did not work; null when it worked or is not one. */
  function computerStepDisplay(metadata) {
    if (!isComputer(metadata) || WORKED.has(metadata.status)) return null;
    return { tone: 'warn', failureSummary: summaryFor(metadata.status, metadata.refusal_reason) };
  }

  /** The turn's computer steps from their saved result metadata. */
  function countComputerSteps(rows) {
    let total = 0;
    let failed = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const metadata = row && row.kind === 'tool_result' ? row.payload && row.payload.metadata : null;
      if (!isComputer(metadata)) continue;
      total += 1;
      if (!NOT_COUNTED.has(metadata.status)) failed += 1;
    }
    return { failed, total };
  }

  /** The count line under a finished turn's final answer, or ''. */
  function buildTallyMarkup(row, options, escapeHtml) {
    const opts = options || {};
    const live = opts.turnLive === true || opts.isStreaming === true || opts.streamingMessageId || opts.streamingRowId;
    if (live || !row || row.assistant_phase !== 'final_answer') return '';
    const { failed, total } = countComputerSteps([opts.turnRows, opts.siblingRows].find((list) => Array.isArray(list) && list.length));
    if (!failed) return '';
    const text = jtn('chat.computerStep.tally', total, { n: failed, total },
      '{n} of {total} computer step did not work. Check the result in the program before you rely on it.',
      '{n} of {total} computer steps did not work. Check the result in the program before you rely on it.');
    return '<p class="computer-step-tally" role="note"><span class="status-dot status-dot--warn" aria-hidden="true"></span>' + escapeHtml(text) + '</p>';
  }

  function buildPauseLine(doc, sessionId, bridge) {
    const actionButton = globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    if (typeof actionButton !== 'function') return null;
    const line = doc.createElement('div');
    line.className = 'computer-pause-line';
    line.setAttribute('role', 'status');
    line.innerHTML = '<span class="status-dot status-dot--warn" aria-hidden="true"></span><span>'
      + actionButton.escapeHtml(jt('chat.computerStep.pausedLine', 'Paused while you use the mouse or keyboard.')) + '</span>'
      + actionButton({ id: 'computer-resume', label: jt('chat.computerStep.resume', 'Resume'), variant: 'primary', size: 'sm' })
      + actionButton({ id: 'computer-stop', label: jt('chat.computerStep.stop', 'Stop'), size: 'sm' });
    const buttons = [...line.querySelectorAll('button')];
    ['resume', 'stop'].forEach((method, index) => buttons[index].addEventListener('click', () => {
      buttons.forEach((b) => { b.disabled = true; });
      let pending;
      try { pending = bridge[method]({ sessionId }); } catch (_error) { pending = null; }
      Promise.resolve(pending).catch(() => {}).then(() => buttons.forEach((b) => { b.disabled = false; }));
    }));
    return line;
  }

  /** Mounts the pause line under the running computer step while the current chat's turn is held. */
  function mountComputerPauseLine({
    document: doc, getCurrentSessionId, turnState: turns = turnState, shell = globalThis.jennyShell,
    setIntervalFn = globalThis.setInterval, clearIntervalFn = globalThis.clearInterval,
  } = {}) {
    const bridge = shell && shell.computerUse;
    const inert = { dispose() {}, refresh() {} };
    if (!doc || !turns || !bridge || typeof bridge.resume !== 'function' || typeof bridge.stop !== 'function') return inert;
    const held = new Set();
    let timer = null;
    let mounted = false;
    const removeLines = (except) => doc.querySelectorAll('.computer-pause-line').forEach((el) => { if (el !== except) el.remove(); });

    function refresh() {
      if (!held.size && timer !== null) { clearIntervalFn(timer); timer = null; }
      if (!held.size && !mounted) return;
      const sessionId = typeof getCurrentSessionId === 'function' ? String(getCurrentSessionId() || '') : '';
      const paused = Boolean(sessionId) && turns.get(sessionId)?.state === 'paused';
      const rows = paused ? doc.querySelectorAll(RUNNING_ROW) : [];
      const row = rows[rows.length - 1];
      const existing = row && row.querySelector(':scope > .computer-pause-line');
      removeLines(existing);
      const line = row && !existing ? buildPauseLine(doc, sessionId, bridge) : null;
      if (line) row.querySelector(':scope > .tool-call-row-header')?.after(line);
      mounted = Boolean(existing || line);
    }

    const unsubscribe = turns.subscribe((sessionId, entry) => {
      if (entry && entry.state === 'paused') held.add(sessionId); else held.delete(sessionId);
      if (held.size && timer === null) timer = setIntervalFn(refresh, 500);
      refresh();
    });
    return {
      refresh,
      dispose() {
        unsubscribe();
        held.clear();
        if (timer !== null) { clearIntervalFn(timer); timer = null; }
        removeLines(null);
      },
    };
  }

  // ---- the live turn state per chat (for the pause line and the Tools menu's granted programs) ----------
  // Main pushes jennyShell.computerUse.onTurnState({ sessionId, state, action, programName }); this keeps the
  // last one per chat and tells subscribers. It subscribes on first use.
  const TURN_STATES = new Set(['thinking', 'step', 'paused', 'idle']);
  const MAX_CHATS = 64;

  function createComputerTurnState({ windowRef = globalThis } = {}) {
    const entries = new Map();
    const listeners = new Set();
    let unsubscribe = null;

    function accept(payload) {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
      if (!sessionId || !TURN_STATES.has(payload.state)) return;
      const entry = {
        state: payload.state,
        action: typeof payload.action === 'string' ? payload.action : '',
        programName: typeof payload.programName === 'string' ? payload.programName.slice(0, 120) : '',
      };
      entries.delete(sessionId);
      if (entry.state !== 'idle') entries.set(sessionId, entry);
      while (entries.size > MAX_CHATS) entries.delete(entries.keys().next().value);
      for (const listener of [...listeners]) {
        try { listener(sessionId, entry); } catch (_error) { /* one listener never stops the others */ }
      }
    }

    function ensureListening() {
      if (unsubscribe) return;
      const subscribe = windowRef.jennyShell?.computerUse?.onTurnState;
      if (typeof subscribe !== 'function') return;
      const off = subscribe(accept);
      unsubscribe = typeof off === 'function' ? off : () => {};
    }

    return {
      /** The chat's live state, or null when no computer turn is live there. */
      get(sessionId) {
        ensureListening();
        return entries.get(sessionId) || null;
      },
      /** fn(sessionId, entry) on every change; returns the unsubscribe. */
      subscribe(fn) {
        ensureListening();
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      accept, // for tests
    };
  }

  const sharedTurnState = createComputerTurnState();
  const turnState = { createComputerTurnState, get: sharedTurnState.get, subscribe: sharedTurnState.subscribe };

  return { computerStepDisplay, countComputerSteps, buildTallyMarkup, mountComputerPauseLine, createComputerTurnState, turnState };
});
