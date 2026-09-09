/* renderer/features/renderer-scratchpad-capture.js — UMD
 *
 * Global quick-capture popover for the Home scratchpad (Phase 3 "capture from
 * anywhere"). A small centered dialog with a single-line field; Enter saves to
 * the active note via the injected onCapture, Esc / backdrop-click cancels. The
 * controller is pure UI — it knows nothing about app state or the shell, only an
 * onCapture(text, options) -> Promise<{ ok, noteTitle } | { error }> — so it is
 * fully testable in jsdom and reusable from any always-alive binding layer.
 *
 * It owns exactly one DOM node and one (delegated) keydown + click listener,
 * both released on dispose(); nothing leaks across an app teardown.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererScratchpadCapture = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const MAX_CAPTURE_CHARS = 4000;
  const INPUT_ID = 'scratchpadCaptureInput';

  function noop() {}

  function createScratchpadCaptureController(deps = {}) {
    const documentRef = deps.documentRef || (typeof document !== 'undefined' ? document : null);
    const onCapture = typeof deps.onCapture === 'function' ? deps.onCapture : null;
    const textFieldImpl = typeof deps.textField === 'function' ? deps.textField : null;
    const showToastMessage = typeof deps.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const escapeHtml = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    let rootEl = null;
    let keydownHandler = null;
    let clickHandler = null;
    let submitting = false;
    let disposed = false;
    // Bumped on every open()/close()/dispose() so a slow onCapture that resolves
    // after the popover was closed-and-reopened (or torn down) is recognized as
    // stale and ignored — it must not clobber the reopened input or toast late.
    let submitToken = 0;

    function buildMarkup() {
      // The single-line field comes from the inventory text-field primitive
      // (escapes its value and keeps a raw input element out of this module's
      // source, so the no-raw-html policy stays satisfied). Containers are plain
      // divs (allowed by the policy).
      const field = textFieldImpl
        ? textFieldImpl({
          id: INPUT_ID,
          ariaLabel: jt('scratchpad.capture.noteLabel', 'Note text'),
          placeholder: jt('scratchpad.capture.placeholder', 'Jot a quick note…'),
          maxLength: MAX_CAPTURE_CHARS,
          className: 'scratchpad-capture__field',
        })
        : '';
      return ''
        + '<div class="scratchpad-capture__backdrop" data-capture-dismiss="1"></div>'
        + '<div class="scratchpad-capture__card" role="document">'
        + '<div class="scratchpad-capture__title">' + escapeHtml(jt('scratchpad.capture.title', 'Capture to scratchpad')) + '</div>'
        + field
        + '<div class="scratchpad-capture__status" data-capture-status aria-live="polite"></div>'
        + '<div class="scratchpad-capture__hint">' + escapeHtml(jt('scratchpad.capture.keyboardHint', 'Enter to save · Esc to cancel')) + '</div>'
        + '</div>';
    }

    function ensureMounted() {
      if (rootEl || !documentRef?.body || !onCapture) {
        return rootEl;
      }
      const el = documentRef.createElement('div');
      el.className = 'scratchpad-capture';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', jt('scratchpad.capture.dialogLabel', 'Quick capture to scratchpad'));
      el.hidden = true;
      el.innerHTML = buildMarkup();
      documentRef.body.appendChild(el);
      rootEl = el;

      keydownHandler = (event) => {
        if (!isOpen()) {
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      };
      clickHandler = (event) => {
        if (event.target?.closest?.('[data-capture-dismiss]')) {
          close();
        }
      };
      rootEl.addEventListener('keydown', keydownHandler);
      rootEl.addEventListener('click', clickHandler);
      return rootEl;
    }

    function getInput() {
      return rootEl ? rootEl.querySelector(`#${INPUT_ID}`) : null;
    }

    function setStatus(message, isError) {
      const statusEl = rootEl ? rootEl.querySelector('[data-capture-status]') : null;
      if (!statusEl) {
        return;
      }
      statusEl.textContent = String(message || '');
      statusEl.classList.toggle('is-error', isError === true);
    }

    function isOpen() {
      return Boolean(rootEl) && rootEl.hidden !== true;
    }

    function open() {
      if (disposed || !ensureMounted()) {
        return false;
      }
      submitToken += 1;
      const input = getInput();
      if (input) {
        input.value = '';
      }
      setStatus('', false);
      submitting = false;
      rootEl.hidden = false;
      if (input && typeof input.focus === 'function') {
        try {
          input.focus();
        } catch (_error) {
          // focus is best-effort (jsdom / detached nodes).
        }
      }
      return true;
    }

    function close() {
      if (!rootEl) {
        return;
      }
      submitToken += 1;
      rootEl.hidden = true;
      const input = getInput();
      if (input) {
        input.value = '';
      }
      setStatus('', false);
      submitting = false;
    }

    function submit() {
      if (submitting || !onCapture) {
        return;
      }
      const input = getInput();
      const text = String((input && input.value) || '').trim();
      if (!text) {
        setStatus(jt('scratchpad.capture.emptyNote', 'Type something to save.'), true);
        return;
      }
      submitting = true;
      setStatus('Saving…', false);
      const token = submitToken;
      Promise.resolve(onCapture(text, {})).then((result) => {
        if (disposed || token !== submitToken) {
          return; // popover was closed/reopened/disposed; this result is stale.
        }
        submitting = false;
        if (result && result.ok) {
          const detail = result.noteTitle ? jt('scratchpad.capture.addedToNote', 'Added to {title}.', { title: result.noteTitle }) : jt('scratchpad.capture.added', 'Added to scratchpad.');
          showToastMessage(detail, { title: jt('scratchpad.title', 'Scratchpad'), tone: 'success' });
          close();
        } else {
          setStatus((result && result.error) || jt('scratchpad.capture.saveFailed', 'Could not save the note.'), true);
        }
      }).catch((error) => {
        if (disposed || token !== submitToken) {
          return;
        }
        submitting = false;
        appendClientLog('WARN', 'scratchpad.capture_failed', {
          message: String((error && error.message) || error),
        });
        setStatus(jt('scratchpad.capture.saveFailed', 'Could not save the note.'), true);
      });
    }

    function dispose() {
      disposed = true;
      submitToken += 1;
      if (rootEl) {
        if (keydownHandler) {
          rootEl.removeEventListener('keydown', keydownHandler);
        }
        if (clickHandler) {
          rootEl.removeEventListener('click', clickHandler);
        }
        if (rootEl.parentNode) {
          rootEl.parentNode.removeChild(rootEl);
        }
      }
      rootEl = null;
      keydownHandler = null;
      clickHandler = null;
      submitting = false;
    }

    return { open, close, isOpen, submit, dispose };
  }

  return { createScratchpadCaptureController };
});
