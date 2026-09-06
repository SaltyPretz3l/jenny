/* renderer/chat/renderer-slash-note-command.js -- /note writes its argument to the active Scratchpad note, may run without a chat session, and emits no chat output. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashNoteCommand = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  const SAFE_FAILURE_MESSAGES = new Map([
    ['This note is full — switch to another note.', 'This note is full — switch to another note.'],
    ['Scratchpad is unavailable.', 'Scratchpad is unavailable.'],
  ]);

  function createNoteCommandHandler(deps = {}) {
    const captureToScratchpad = typeof deps.captureToScratchpad === 'function' ? deps.captureToScratchpad : null;
    const showToastMessage = typeof deps.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;

    return function handleNoteCommand(invocation) {
      const text = String(invocation?.args || '').trim();
      if (!text) {
        showToastMessage('Type something after /note to save it.', { title: 'Nothing to save', tone: 'warning' });
        return { ok: false, handled: true, code: 'empty_args' };
      }
      if (!captureToScratchpad) {
        showToastMessage('Scratchpad is unavailable.', { title: 'Scratchpad', tone: 'warning' });
        return { ok: false, handled: true, code: 'scratchpad_unavailable' };
      }
      return Promise.resolve(captureToScratchpad(text)).then((result) => {
        if (result && result.ok) {
          const detail = result.noteTitle ? `Added to ${result.noteTitle}.` : 'Added to scratchpad.';
          showToastMessage(detail, { title: 'Scratchpad', tone: 'success' });
          return { ok: true, code: 'note_saved' };
        }
        const rawMessage = String(result?.error || '').trim();
        const safeMessage = SAFE_FAILURE_MESSAGES.get(rawMessage) || 'Could not save the note.';
        showToastMessage(safeMessage, { title: 'Scratchpad', tone: 'warning' });
        return {
          ok: false,
          handled: true,
          code: rawMessage === 'This note is full — switch to another note.' ? 'note_full' : 'capture_failed',
        };
      }).catch(() => {
        appendClientLog('WARN', 'slash.note_failed', { status: 'failed' });
        showToastMessage('Could not save the note.', { title: 'Scratchpad', tone: 'warning' });
        return { ok: false, handled: true, code: 'capture_exception' };
      });
    };
  }

  return { createNoteCommandHandler };
});
