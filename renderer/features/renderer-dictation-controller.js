/* Push-to-talk dictation (row 84): the eager half. Owns the press/release state
 * machine, the Ctrl+Space hold shortcut, choosing the composer the words go
 * into, and inserting them. Microphone capture (renderer-dictation-capture.js)
 * and the in-composer line and popover (renderer-dictation-view.js) load on the
 * first press, so startup only pays for this file.
 *
 *   hold the mic or Ctrl+Space ......... listen until release, then insert
 *   quick press (< TAP_MS) or a click .. hands-free: the next press, Ctrl+Space
 *                                        or Enter inserts (Enter never sends)
 *   Esc ................................ discard
 *
 * The words land at the caret through execCommand('insertText'), so one Ctrl+Z
 * takes them back and the native input event saves the draft. Nothing is sent. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDictationController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };
  const TAP_MS = 300;
  const MIN_AUDIO_MS = 200;
  const MIN_AUDIO_BYTES = MIN_AUDIO_MS * 32; // 16 kHz PCM16; main refuses fewer (dictation-ipc-registration.js)
  // Below this peak the clip is silence or room noise: say so instead of
  // spending a model call on it.
  const SILENCE_PEAK_DB = -50;
  const ICON_MIC = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="2" width="4" height="7.5" rx="2"/><path d="M3.75 7.5a4.25 4.25 0 0 0 8.5 0M8 11.75V14"/></svg>';

  // The mic beside Send, built by the inventory button in both panes (pane 0 at
  // bind, pane 1 in renderer-app-pane-chrome.js); the controller finds it by class.
  function micButtonOptions() {
    return {
      className: 'composer-icon-button composer-dictate-button',
      ariaLabel: jt('composer.dictation.button', 'Dictate'),
      title: jt('composer.dictation.buttonTitle', 'Dictate: hold, or press Ctrl+Space'),
      ariaPressed: false,
      trustedHtml: ICON_MIC,
    };
  }

  // Puts the mic right before Stop (so it sits beside Send while idle); idempotent.
  function insertMicBefore(stopButton, actionButton) {
    if (!stopButton || typeof actionButton !== 'function') return null;
    const previous = stopButton.previousElementSibling;
    if (previous && previous.classList.contains('composer-dictate-button')) return previous;
    stopButton.insertAdjacentHTML('beforebegin', actionButton(Object.assign({ plain: true }, micButtonOptions())));
    return stopButton.previousElementSibling;
  }

  const LAZY_MODULES = [
    { src: 'renderer/features/renderer-dictation-capture.js', global: 'rendererDictationCapture' },
    { src: 'renderer/features/renderer-dictation-view.js', global: 'rendererDictationView' },
  ];

  function isComposerInput(el) {
    return Boolean(el && typeof el.matches === 'function' && el.matches('textarea.composer-input'));
  }
  function isUsable(el) {
    return isComposerInput(el) && el.disabled !== true && el.readOnly !== true
      && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  }
  // Other editors keep Ctrl+Space (code completion, pickers).
  function isOtherEditable(el) {
    if (!el || isComposerInput(el)) return false;
    const tag = String(el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
      || Boolean(el.closest && el.closest('[contenteditable=""], [contenteditable="true"], .monaco-editor, .cm-editor'));
  }
  function isHoldChord(event) {
    return event.code === 'Space' && event.ctrlKey === true && !event.shiftKey && !event.altKey && !event.metaKey;
  }
  // A leading space when the words would otherwise run into the text before the caret.
  function spacedInsertion(before, text) {
    return before && !/\s$/.test(before) && !/^[.,!?;:)\]}]/.test(text) ? ' ' + text : text;
  }

  function createDictationController(deps) {
    const {
      windowRef,
      documentRef = windowRef && windowRef.document,
      state,
      appendClientLog = () => {},
      getPrimaryComposerInput = () => null,
      getPaneComposition = () => null,
      isOverlayOpen = () => false,
      openSettingsSection = () => {},
      loadModules = null,
      now = () => Date.now(),
    } = deps || {};
    const api = () => (windowRef && windowRef.jennyShell && windowRef.jennyShell.dictation) || null;

    let phase = 'idle'; // idle | starting | listening | transcribing
    let mode = 'hold'; // hold | handsfree
    let heldBy = ''; // 'key' | 'pointer' while a hold is down
    let pressedAt = 0;
    let releaseRequested = false;
    let target = null;
    let capture = null;
    let generation = 0;
    let modelState = { state: 'not_installed' };
    let modules = null;
    let disposed = false;
    const cleanups = [];

    const log = (level, event, details) => { try { appendClientLog(level, event, details); } catch (_error) { /* diagnostics only */ } };
    const isEnabled = () => state?.features?.featureFlags?.dictation !== false && Boolean(api());

    function ensureModules() {
      if (modules) return Promise.resolve(modules);
      const load = loadModules || (() => Promise.all(LAZY_MODULES.map((entry) => windowRef.scriptLoaderUtils.ensureScript({
        src: entry.src, isReady: () => Boolean(windowRef[entry.global]), log: appendClientLog,
      }))).then(() => ({ capture: windowRef.rendererDictationCapture, view: windowRef.rendererDictationView })));
      return Promise.resolve(load()).then((loaded) => {
        loaded.view.configure?.({
          openMicrophoneSettings: () => Promise.resolve(api()?.openMicrophoneSettings?.()).catch(() => {}),
          openSettings: () => openSettingsSection('dictation'),
        });
        modules = loaded;
        return loaded;
      });
    }

    function resolveTarget(fromButton) {
      if (fromButton) {
        const input = fromButton.closest && fromButton.closest('.composer') && fromButton.closest('.composer').querySelector('textarea.composer-input');
        return isUsable(input) ? input : null;
      }
      const active = documentRef.activeElement;
      if (isUsable(active)) return active;
      const composition = getPaneComposition();
      if (composition && composition.getPaneCount?.() > 1 && composition.focusComposer?.() && isUsable(documentRef.activeElement)) {
        return documentRef.activeElement;
      }
      const primary = getPrimaryComposerInput();
      return isUsable(primary) ? primary : null;
    }

    function buttonFor(input) {
      const composer = input && input.closest && input.closest('.composer');
      return composer ? composer.querySelector('.composer-dictate-button') : null;
    }
    function setPressed(pressed) {
      const button = buttonFor(target);
      if (button) button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    }
    function view() { return modules && modules.view; }

    function begin(input, how) {
      target = input;
      mode = 'hold';
      heldBy = how;
      pressedAt = now();
      releaseRequested = false;
      phase = 'starting';
      const token = ++generation;
      try { api().prepare?.(); } catch (_error) { /* the model warms on transcribe instead */ }
      ensureModules().then((loaded) => {
        if (token !== generation || disposed) return null;
        loaded.view.clearProblem(target);
        return loaded.capture.startCapture({
          windowRef,
          deviceId: state?.ui?.dictation?.deviceId || '',
          onLevel: (level) => { if (token === generation) loaded.view.pushLevel(target, level); },
          onLimit: () => { if (token === generation) finish(true); },
        });
      }).then((session) => {
        if (!session) return;
        if (token !== generation || disposed) { session.cancel(); return; }
        capture = session;
        phase = 'listening';
        setPressed(true);
        view().showListening(target, { mode, startedAt: now(), now });
        if (releaseRequested) finish(true);
      }).catch((error) => {
        if (token !== generation) return;
        const reason = String(error && error.reason || 'failed');
        log('WARN', 'dictation.capture_failed', { reason, name: String(error && error.name || '').slice(0, 60) });
        reset();
        ensureModules().then((loaded) => loaded.view.showProblem(input, reason)).catch(() => {});
      });
    }

    function reset() {
      generation += 1;
      setPressed(false);
      if (capture) { try { capture.cancel(); } catch (_error) { /* already stopped */ } }
      capture = null;
      if (view() && target) view().clearLine(target);
      phase = 'idle';
      heldBy = '';
      releaseRequested = false;
    }

    // insert=false discards (Esc). Every exit goes through here or reset().
    function finish(insert) {
      if (phase === 'starting') {
        if (insert) { releaseRequested = true; return; }
        reset();
        return;
      }
      if (phase === 'transcribing' && !insert) { reset(); return; }
      if (phase !== 'listening') return;
      const session = capture;
      const input = target;
      const token = ++generation;
      capture = null;
      heldBy = '';
      setPressed(false);
      if (!insert) { session.cancel(); reset(); return; }
      phase = 'transcribing';
      session.stop().then((clip) => {
        if (token !== generation || disposed) return null;
        if (!clip || !clip.pcm || clip.pcm.byteLength < MIN_AUDIO_BYTES || clip.peakDb < SILENCE_PEAK_DB) {
          return { ok: false, reason: 'nothing_heard' };
        }
        view().showTranscribing(input, { durationMs: clip.durationMs });
        return api().transcribe(clip.pcm);
      }).then((result) => {
        if (!result || token !== generation || disposed) return;
        phase = 'idle';
        view().clearLine(input);
        if (result.ok && String(result.text || '').trim()) {
          insertText(input, String(result.text).trim());
          log('INFO', 'dictation.inserted', { durationMs: result.durationMs, engineMs: result.engineMs });
          return;
        }
        const reason = result.ok ? 'nothing_heard' : String(result.reason || 'engine_error');
        if (reason !== 'nothing_heard') log('WARN', 'dictation.transcribe_failed', { reason, code: String(result.code || '').slice(0, 40) });
        view().showProblem(input, reason, result.code);
      }).catch((error) => {
        if (token !== generation) return;
        log('WARN', 'dictation.transcribe_failed', { reason: 'exception', message: String(error && error.message || error).slice(0, 200) });
        phase = 'idle';
        if (view()) view().showProblem(input, 'engine_error');
      });
    }

    function insertText(input, text) {
      if (!input || !input.isConnected) return;
      input.focus({ preventScroll: true });
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const words = spacedInsertion(input.value.slice(0, start), text);
      let inserted;
      try { inserted = documentRef.execCommand('insertText', false, words) === true; } catch (_error) { inserted = false; }
      if (!inserted) {
        input.setRangeText(words, start, end, 'end');
        input.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
      }
    }

    // A press from the mic button or the shortcut.
    function press(how, fromButton) {
      if (disposed || !isEnabled()) return false;
      if (phase === 'listening' && mode === 'handsfree') { finish(true); return true; }
      // A stop tap while the microphone is still opening: stop as soon as it is.
      if (phase === 'starting' && mode === 'handsfree') { releaseRequested = true; return true; }
      if (phase !== 'idle') return true;
      const input = resolveTarget(fromButton);
      if (!input) return false;
      if (modelState.state !== 'ready') {
        ensureModules().then((loaded) => loaded.view.openSetup(buttonFor(input), { getState: () => modelState, api: api() }))
          .catch((error) => log('WARN', 'dictation.view_unavailable', { message: String(error && error.message || error).slice(0, 200) }));
        return true;
      }
      begin(input, how);
      return true;
    }

    function release(how) {
      if (heldBy !== how) return;
      heldBy = '';
      if (now() - pressedAt < TAP_MS) {
        mode = 'handsfree';
        if (phase === 'listening') view().showListening(target, { mode, startedAt: pressedAt, now });
        return;
      }
      finish(true);
    }

    function onKeyDown(event) {
      if (phase !== 'idle' && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
        return;
      }
      if (phase === 'listening' && mode === 'handsfree' && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(true);
        return;
      }
      if (!isHoldChord(event) || !isEnabled() || isOverlayOpen()) return;
      if (isOtherEditable(documentRef.activeElement)) return;
      if (event.repeat) { if (phase !== 'idle') event.preventDefault(); return; }
      if (press('key', null)) event.preventDefault();
    }
    function onKeyUp(event) {
      if (heldBy === 'key' && (event.code === 'Space' || event.key === 'Control')) release('key');
    }
    function onPointerDown(event) {
      const button = event.target && event.target.closest && event.target.closest('.composer-dictate-button');
      if (!button || event.button !== 0) return;
      event.preventDefault(); // keep the caret in the composer
      press('pointer', button);
    }
    function onPointerUp() { release('pointer'); }
    // Keyboard activation of the focused mic button (Enter/Space): a toggle.
    function onClick(event) {
      const button = event.target && event.target.closest && event.target.closest('.composer-dictate-button');
      if (!button || event.detail !== 0) return;
      event.preventDefault();
      if (phase === 'idle' && press('pointer', button)) { heldBy = ''; mode = 'handsfree'; } else if (phase === 'listening') finish(true);
    }
    // Losing the window ends a hold (its keyup or pointerup will never come);
    // hands-free keeps listening until the user stops it.
    function onBlur() { if (heldBy) { heldBy = ''; finish(true); } }
    function onVisibility() { if (documentRef.visibilityState === 'hidden') onBlur(); }

    function syncAvailability() {
      const off = !isEnabled();
      documentRef.documentElement.toggleAttribute('data-dictation-off', off);
      if (off && phase !== 'idle') finish(false);
    }

    function listen(node, type, handler, options) {
      node.addEventListener(type, handler, options);
      cleanups.push(() => node.removeEventListener(type, handler, options));
    }

    function bind() {
      listen(windowRef, 'keydown', onKeyDown, true);
      listen(windowRef, 'keyup', onKeyUp, true);
      listen(windowRef, 'blur', onBlur);
      listen(documentRef, 'visibilitychange', onVisibility);
      listen(documentRef, 'pointerdown', onPointerDown, true);
      listen(windowRef, 'pointerup', onPointerUp, true);
      listen(windowRef, 'pointercancel', onPointerUp, true);
      listen(documentRef, 'click', onClick, true);
      const bridge = api();
      if (bridge) {
        Promise.resolve(bridge.getState?.()).then((next) => {
          if (!next || disposed) return;
          modelState = next;
          // Set up already: load capture and view while idle, so the first press
          // after boot waits only for the microphone, not for script loads.
          if (next.state === 'ready' && isEnabled()) {
            const prefetch = () => { if (!disposed) ensureModules().catch(() => {}); };
            if (typeof windowRef.requestIdleCallback === 'function') windowRef.requestIdleCallback(prefetch, { timeout: 10000 });
            else windowRef.setTimeout(prefetch, 2000);
          }
        }).catch(() => {});
        const unsubscribe = bridge.onChanged?.((next) => {
          if (!next || disposed) return;
          modelState = next;
          view()?.updateSetup?.(next);
        });
        if (typeof unsubscribe === 'function') cleanups.push(unsubscribe);
      }
      const primaryComposer = getPrimaryComposerInput()?.closest?.('.composer');
      insertMicBefore(primaryComposer && primaryComposer.querySelector('.composer-stop-button'), windowRef.inventoryActionButton);
      syncAvailability();
    }

    function dispose() {
      if (disposed) return;
      reset();
      disposed = true;
      view()?.closeSetup?.();
      cleanups.splice(0).forEach((fn) => { try { fn(); } catch (_error) { /* best effort */ } });
    }

    return {
      bind,
      dispose,
      syncAvailability,
      press,
      release,
      cancel: () => finish(false),
      getPhase: () => phase,
      getMode: () => mode,
    };
  }

  return { createDictationController, micButtonOptions, insertMicBefore, spacedInsertion, isOtherEditable, TAP_MS, SILENCE_PEAK_DB };
});
