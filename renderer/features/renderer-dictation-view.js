/* Dictation's in-composer surfaces (row 84, lazy: loaded on the first press).
 *
 * - The live line inside the composer, above the draft (owner pick L1, no
 *   status dot): "Listening", elapsed time, the level meter, the key hint;
 *   then "Transcribing" with the timeline shimmer; problems reuse the same
 *   line, one sentence and at most one text action.
 * - The first-use popover on the mic (F1): what dictation is, the one-time
 *   download, then its progress, driven by the model service's state.
 * The controller owns every decision; this module only paints. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDictationView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const BARS = 32;
  const PROBLEM_MS = 8000;
  const MB = 1000 * 1000;
  const MODEL_BYTES = 672947357; // services/dictation-model-manifest.js, until the state reports it
  const lines = new WeakMap(); // composer-main -> { el, levels, timer, problemTimer }
  let popover = null; // { el, button, api, getState, onOutside, onKey }
  let actions = { openMicrophoneSettings: () => {}, openSettings: () => {} };

  function configure(next) { actions = { ...actions, ...(next || {}) }; }

  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function hostOf(input) { return input && input.closest ? input.closest('.composer-main') : null; }
  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function lineFor(input) {
    const host = hostOf(input);
    if (!host) return null;
    let entry = lines.get(host);
    if (!entry || !entry.el.isConnected) {
      const node = el(host.ownerDocument, 'div', 'composer-dictation-line');
      node.setAttribute('role', 'status');
      host.insertBefore(node, host.firstChild);
      entry = { el: node, levels: new Array(BARS).fill(0), timer: 0, problemTimer: 0 };
      lines.set(host, entry);
    }
    return entry;
  }
  function stopTimers(entry) {
    const win = entry.el.ownerDocument.defaultView;
    if (entry.timer) win.clearInterval(entry.timer);
    if (entry.problemTimer) win.clearTimeout(entry.problemTimer);
    entry.timer = 0;
    entry.problemTimer = 0;
  }
  function paint(entry, children, modifier) {
    stopTimers(entry);
    entry.el.className = 'composer-dictation-line' + (modifier ? ' composer-dictation-line--' + modifier : '');
    entry.el.replaceChildren(...children);
  }

  function showListening(input, { mode, startedAt, now }) {
    const entry = lineFor(input);
    if (!entry) return;
    const doc = entry.el.ownerDocument;
    const time = el(doc, 'span', 'composer-dictation-time', clock(now() - startedAt));
    time.setAttribute('aria-hidden', 'true');
    const meter = el(doc, 'span', 'composer-dictation-level');
    meter.setAttribute('aria-hidden', 'true');
    entry.levels.forEach((level) => { const bar = doc.createElement('i'); bar.style.setProperty('--level', String(level)); meter.appendChild(bar); });
    const hint = mode === 'handsfree'
      ? jt('composer.dictation.hintHandsFree', 'Click the mic or press Enter to insert · Esc to cancel')
      : jt('composer.dictation.hintHold', 'Release to insert · Esc to cancel');
    paint(entry, [el(doc, 'b', 'composer-dictation-label', jt('composer.dictation.listening', 'Listening')), time, meter, el(doc, 'span', 'composer-dictation-hint', hint)]);
    entry.timer = doc.defaultView.setInterval(() => { time.textContent = clock(now() - startedAt); }, 250);
  }

  // One 50 ms block's level (0..1): the meter scrolls right to left.
  function pushLevel(input, level) {
    const host = hostOf(input);
    const entry = host && lines.get(host);
    if (!entry) return;
    entry.levels.shift();
    entry.levels.push(level);
    const bars = entry.el.querySelectorAll('.composer-dictation-level > i');
    for (let i = 0; i < bars.length; i += 1) bars[i].style.setProperty('--level', String(entry.levels[i]));
  }

  function showTranscribing(input, { durationMs }) {
    const entry = lineFor(input);
    if (!entry) return;
    const doc = entry.el.ownerDocument;
    entry.levels.fill(0);
    paint(entry, [
      el(doc, 'b', ['composer-dictation-label', 'composer-dictation-label--working'].join(' '), jt('composer.dictation.transcribing', 'Transcribing')),
      el(doc, 'span', 'composer-dictation-time', jt('composer.dictation.audioLength', '{length} of audio', { length: clock(durationMs) })),
    ]);
  }

  function problemCopy(reason, code) {
    switch (reason) {
      case 'blocked': return { text: jt('composer.dictation.problem.blocked', 'Windows is blocking the microphone, or another app is using it.'), action: jt('composer.dictation.problem.openWindowsSettings', 'Open Windows settings'), run: () => actions.openMicrophoneSettings() };
      case 'no_device': return { text: jt('composer.dictation.problem.noDevice', 'No microphone found.'), action: jt('composer.dictation.problem.settings', 'Settings'), run: () => actions.openSettings() };
      case 'nothing_heard': return { text: jt('composer.dictation.problem.nothingHeard', 'Didn’t catch anything. Nothing was added.') };
      case 'invalid_audio': return { text: jt('composer.dictation.problem.invalidAudio', 'That recording could not be used. Try again.') };
      case 'model_not_ready': return { text: jt('composer.dictation.problem.noModel', 'The speech model is not installed.'), action: jt('composer.dictation.problem.settings', 'Settings'), run: () => actions.openSettings() };
      case 'engine_error': return { text: code ? jt('composer.dictation.problem.engineCode', 'The speech model could not start ({code}).', { code }) : jt('composer.dictation.problem.engine', 'The speech model could not start.') };
      default: return { text: jt('composer.dictation.problem.failed', 'The microphone could not start.') };
    }
  }

  function showProblem(input, reason, code) {
    const entry = lineFor(input);
    if (!entry) return;
    const doc = entry.el.ownerDocument;
    const copy = problemCopy(reason, code);
    const children = [el(doc, 'span', 'composer-dictation-message', copy.text)];
    if (copy.action) {
      const button = el(doc, 'button', 'composer-dictation-action', copy.action);
      button.type = 'button';
      button.addEventListener('click', () => { clearLine(input); copy.run(); });
      children.push(button);
    }
    paint(entry, children, 'problem');
    entry.problemTimer = doc.defaultView.setTimeout(() => clearLine(input), PROBLEM_MS);
  }

  function clearLine(input) {
    const host = hostOf(input);
    const entry = host && lines.get(host);
    if (!entry) return;
    stopTimers(entry);
    entry.levels.fill(0);
    entry.el.remove();
    lines.delete(host);
  }
  function clearProblem(input) {
    const host = hostOf(input);
    const entry = host && lines.get(host);
    if (entry && entry.el.classList.contains('composer-dictation-line--problem')) clearLine(input);
  }

  // ── First-use popover ──
  function popoverBody(doc, state) {
    const kind = state && state.state;
    const parts = [];
    const p = (text) => parts.push(el(doc, 'p', 'composer-dictation-popover-copy', text));
    const meta = (text) => parts.push(el(doc, 'p', 'composer-dictation-popover-meta', text));
    let title;
    let buttons;
    if (kind === 'downloading' || kind === 'verifying') {
      title = jt('composer.dictation.setup.workingTitle', 'Getting dictation ready');
      p(jt('composer.dictation.setup.workingCopy', 'Downloading the speech model. You can close this; it keeps going and the mic works as soon as it finishes.'));
      const total = Number(state.totalBytes) || 0;
      const done = Math.min(Number(state.downloadedBytes) || 0, total);
      const bar = el(doc, 'div', 'composer-dictation-progress');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(total));
      bar.setAttribute('aria-valuenow', String(done));
      const fill = doc.createElement('span');
      fill.style.setProperty('--progress', total ? String(done / total) : '0');
      bar.appendChild(fill);
      parts.push(bar);
      meta(kind === 'verifying'
        ? jt('composer.dictation.setup.verifying', 'Checking the download…')
        : jt('composer.dictation.setup.progress', '{done} of {total} MB', { done: Math.round(done / MB), total: Math.round(total / MB) }));
      buttons = [['cancel', jt('composer.dictation.setup.cancel', 'Cancel download')], ['close', jt('composer.dictation.setup.close', 'Close')]];
    } else if (kind === 'ready') {
      title = jt('composer.dictation.setup.readyTitle', 'Dictation is ready');
      p(jt('composer.dictation.setup.readyCopy', 'Hold the mic or Ctrl+Space, speak, and let go.'));
      buttons = [['close', jt('composer.dictation.setup.close', 'Close')]];
    } else {
      title = jt('composer.dictation.setup.title', 'Talk instead of typing');
      p(jt('composer.dictation.setup.how', 'Hold the mic or Ctrl+Space, speak, and let go. Your words appear in the message box for you to edit and send.'));
      p(jt('composer.dictation.setup.privacy', 'Speech is turned into text on this PC by a free model that runs on your processor. Audio never leaves your computer and is not saved.'));
      if (kind === 'failed') {
        parts.push(el(doc, 'p', 'composer-dictation-popover-error', jt('composer.dictation.setup.failed', 'The last download did not finish. Try again.')));
      }
      meta(jt('composer.dictation.setup.size', 'One-time download: {size} MB', { size: Math.round((Number(state && state.totalBytes) || MODEL_BYTES) / MB) }));
      buttons = [['dismiss', jt('composer.dictation.setup.notNow', 'Not now')], ['download', kind === 'failed' ? jt('composer.dictation.setup.retry', 'Try again') : jt('composer.dictation.setup.download', 'Download')]];
    }
    const heading = el(doc, 'h3', 'composer-dictation-popover-title', title);
    heading.id = 'composerDictationPopoverTitle';
    const row = el(doc, 'div', 'composer-dictation-popover-actions');
    buttons.forEach(([action, label], index) => {
      const button = el(doc, 'button', ['btn', 'btn--sm'].concat(action === 'download' ? ['btn--primary'] : []).join(' '), label);
      button.type = 'button';
      button.dataset.dictationAction = action;
      row.appendChild(button);
    });
    return [heading, ...parts, row];
  }

  function closeSetup() {
    if (!popover) return;
    const { el: node, button, onOutside, onKey } = popover;
    const doc = node.ownerDocument;
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    node.remove();
    button?.setAttribute('aria-expanded', 'false');
    popover = null;
  }

  function updateSetup(state) {
    if (!popover) return;
    popover.el.replaceChildren(...popoverBody(popover.el.ownerDocument, state || popover.getState()));
  }

  function openSetup(button, { getState, api }) {
    if (!button) return;
    if (popover && popover.button === button) { closeSetup(); return; }
    closeSetup();
    const doc = button.ownerDocument;
    const host = button.closest('.composer') || button.parentElement;
    const node = el(doc, 'div', ['inv-popover', 'composer-dictation-popover'].join(' '));
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'false');
    node.setAttribute('aria-labelledby', 'composerDictationPopoverTitle');
    // The inventory's document click-away handler (popover.js) closes any open
    // .inv-popover whose trigger it does not know; the click that follows the
    // mic's pointerdown would hide this one the moment it opens.
    node.__invPopoverTrigger = button;
    const onOutside = (event) => { if (!node.contains(event.target) && !button.contains(event.target)) closeSetup(); };
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); closeSetup(); button.focus(); } };
    node.addEventListener('click', (event) => {
      const action = event.target && event.target.closest && event.target.closest('[data-dictation-action]');
      if (!action) return;
      const kind = action.dataset.dictationAction;
      if (kind === 'download') Promise.resolve(api && api.setup && api.setup()).catch(() => {});
      else if (kind === 'cancel') Promise.resolve(api && api.cancel && api.cancel()).catch(() => {});
      else closeSetup();
    });
    popover = { el: node, button, getState, onOutside, onKey };
    updateSetup(getState());
    host.appendChild(node);
    button.setAttribute('aria-expanded', 'true');
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    node.querySelector('[data-dictation-action="download"], [data-dictation-action="close"]')?.focus();
  }

  return { configure, showListening, pushLevel, showTranscribing, showProblem, clearLine, clearProblem, openSetup, updateSetup, closeSetup, clock, BARS };
});
