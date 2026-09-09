/* renderer/chat/renderer-slash-note-command.js -- /note writes its argument to the active Scratchpad note, may run without a chat session, and emits no chat output. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashNoteCommand = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}

  function createNoteCommandHandler(deps = {}) {
    const captureToScratchpad = typeof deps.captureToScratchpad === 'function' ? deps.captureToScratchpad : null;
    const showToastMessage = typeof deps.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;

    return function handleNoteCommand(invocation) {
      const text = String(invocation?.args || '').trim();
      if (!text) {
        showToastMessage(jt('composer.slash.noteTypeSomething', 'Type something after /note to save it.'), { title: jt('composer.slash.nothingToSave', 'Nothing to save'), tone: 'warning' });
        return { ok: false, handled: true, code: 'empty_args' };
      }
      if (!captureToScratchpad) {
        showToastMessage(jt('composer.slash.scratchpadUnavailable', 'Scratchpad is unavailable.'), { title: jt('composer.slash.scratchpadTitle', 'Scratchpad'), tone: 'warning' });
        return { ok: false, handled: true, code: 'scratchpad_unavailable' };
      }
      return Promise.resolve(captureToScratchpad(text)).then((result) => {
        if (result && result.ok) {
          const detail = result.noteTitle ? jt('composer.slash.addedToNote', 'Added to {noteTitle}.', { noteTitle: result.noteTitle }) : jt('composer.slash.addedToScratchpad', 'Added to scratchpad.');
          showToastMessage(detail, { title: jt('composer.slash.scratchpadTitle', 'Scratchpad'), tone: 'success' });
          return { ok: true, code: 'note_saved' };
        }
        let code = 'capture_failed';
        let safeMessage = jt('composer.slash.noteSaveFailed', 'Could not save the note.');
        switch (result?.code) {
          case 'note_full':
            code = 'note_full';
            safeMessage = jt('dashboard.scratchpad.actions.noteFull', 'This note is full — switch to another note.');
            break;
          case 'scratchpad_unavailable':
            code = 'scratchpad_unavailable';
            safeMessage = jt('composer.slash.scratchpadUnavailable', 'Scratchpad is unavailable.');
            break;
          default:
            break;
        }
        showToastMessage(safeMessage, { title: jt('composer.slash.scratchpadTitle', 'Scratchpad'), tone: 'warning' });
        return {
          ok: false,
          handled: true,
          code,
        };
      }).catch(() => {
        appendClientLog('WARN', 'slash.note_failed', { status: 'failed' });
        showToastMessage(jt('composer.slash.noteSaveFailed', 'Could not save the note.'), { title: jt('composer.slash.scratchpadTitle', 'Scratchpad'), tone: 'warning' });
        return { ok: false, handled: true, code: 'capture_exception' };
      });
    };
  }

  return { createNoteCommandHandler };
});
