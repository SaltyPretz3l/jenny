/* renderer/features/board/board-drop-paste.js - paste and drop onto the board (UMD, global rendererBoardDropPaste), a
 * part of board-card-kinds.js with no card kind (row 150 slice B7).
 *
 * It listens on the canvas surface (ctx.surface.element) for dragover, drop and paste, and only changes the board
 * while it can be edited; on a read-only board a drop or a paste gets one notice and changes nothing.
 * - A dropped or pasted picture (PNG, JPEG, WebP or GIF by its type; the main process checks the bytes) becomes a
 *   picture card at the drop point, or at the board's next free place for a paste (board-card-media.js).
 * - A dropped file that is not a picture goes through source.resolveFile and becomes a file card, or its reason is
 *   told (board-card-file.js).
 * - Pasted or dropped text that is one http or https address becomes a link card (editor.addLink); other text becomes
 *   a note (editor.addNote), cut to the note limit.
 * - Several dropped items are added in order, each DROP_OFFSET further down and right so they do not stack exactly; at
 *   most DROP_MAX per drop, and the rest are counted in one notice.
 * - A paste while a text field or an inline editor has the focus is left alone. dragover shows the copy cursor only
 *   for files or text on a board that can be edited. dispose() removes every listener. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rendererBoardDropPaste = api;
  if (root && root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('drop-paste', api.createDropPastePart);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const DROP_MAX = 10;
  const DROP_OFFSET = 24;
  const NOTE_CHARS = 4000; // the model's LIMITS.note_chars
  const NOTE_SIZE = { w: 240, h: 160 }; // the model's default note
  const WEB_ADDRESS = /^https?:\/\/[^\s/?#]+\S*$/i;
  const TAKEN_TYPES = ['Files', 'text/plain', 'text/uri-list'];
  const FIELD_SELECTOR = 'textarea, input, select, [contenteditable=""], [contenteditable="true"], [data-board-editor], [data-board-file-form], [data-board-link-form]';

  function resolveGlobal(windowRef, name, requirePath) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function isWebAddress(text) {
    if (!WEB_ADDRESS.test(text)) return false;
    try { const parsed = new URL(text); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; } catch (_error) { return false; }
  }

  /** Note text: line breaks and tabs kept, other control characters dropped, at most NOTE_CHARS. */
  function noteText(text) {
    let out = '';
    for (const ch of String(text || '').replace(/\r\n?/g, '\n')) {
      const code = ch.codePointAt(0);
      if (code === 0x2028 || code === 0x2029) out += '\n';
      else if (code === 9 || code === 10 || !(code < 32 || (code >= 0x7f && code <= 0x9f))) out += ch;
    }
    return out.slice(0, NOTE_CHARS);
  }

  function createDropPastePart(ctx) {
    const element = ctx.surface.element;
    const doc = ctx.document;
    let disposed = false;

    function tell(message) {
      try { if (typeof ctx.notify === 'function') ctx.notify(message, { tone: 'warning' }); } catch (_error) { /* a toast must not break the board */ }
    }
    function readOnlyNotice() { tell(jt('board.drop.readOnly', 'This board cannot be changed, so nothing was added.')); }

    /** `point` is where it was dropped; a paste has none and takes the board's next free place, then is shown. */
    async function addText(text, point) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return;
      const at = point ? { x: Math.round(point.x - NOTE_SIZE.w / 2), y: Math.round(point.y - NOTE_SIZE.h / 2) } : {};
      const result = isWebAddress(trimmed) ? await ctx.editor.addLink(Object.assign({ url: trimmed }, at)) : await ctx.editor.addNote(Object.assign({ text: noteText(text) }, at));
      if (!point && result.ok && ctx.host && typeof ctx.host.reveal === 'function') ctx.host.reveal(result.id);
    }

    async function addFiles(files, origin) {
      const media = resolveGlobal(ctx.windowRef, 'rendererBoardCardMedia', './board-card-media');
      const fileCards = resolveGlobal(ctx.windowRef, 'rendererBoardCardFile', './board-card-file');
      const taken = files.slice(0, DROP_MAX);
      if (files.length > DROP_MAX) {
        tell(jt('board.drop.tooMany', '{count} more items were not added: a board takes at most 10 at a time.', { count: files.length - DROP_MAX }));
      }
      for (let index = 0; index < taken.length && !disposed; index += 1) {
        const file = taken[index];
        const point = origin ? { x: origin.x + index * DROP_OFFSET, y: origin.y + index * DROP_OFFSET } : null;
        if (media && media.isPictureFile(file)) await media.addPictureFromFile(ctx, file, point);
        else if (fileCards) await fileCards.addFileFromPath(ctx, fileCards.pathOfFile(ctx.windowRef, file), point);
      }
    }

    function takes(dataTransfer) {
      const types = dataTransfer && dataTransfer.types ? Array.from(dataTransfer.types) : [];
      return types.some((type) => TAKEN_TYPES.indexOf(type) >= 0);
    }

    function onDragOver(event) {
      if (!takes(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = ctx.editor.canEdit() ? 'copy' : 'none';
    }

    function onDrop(event) {
      const data = event.dataTransfer;
      if (!takes(data)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!ctx.editor.canEdit()) { readOnlyNotice(); return; }
      const point = ctx.surface.toBoard(event.clientX, event.clientY);
      const files = data.files ? Array.from(data.files) : [];
      if (files.length) { void addFiles(files, point); return; }
      const uris = String(data.getData('text/uri-list') || '').split(/\r?\n/).filter((line) => line && line.charAt(0) !== '#');
      void addText(uris.length === 1 ? uris[0] : data.getData('text/plain'), point);
    }

    function inField(target) {
      const active = doc.activeElement;
      return [target, active].some((node) => node && typeof node.closest === 'function' && node.closest(FIELD_SELECTOR));
    }

    function onPaste(event) {
      if (inField(event.target)) return;
      const data = event.clipboardData;
      const files = data && data.files ? Array.from(data.files) : [];
      const text = data && typeof data.getData === 'function' ? data.getData('text/plain') : '';
      if (!files.length && !String(text || '').trim()) return;
      event.preventDefault();
      if (!ctx.editor.canEdit()) { readOnlyNotice(); return; }
      if (files.length) void addFiles(files, null);
      else void addText(text, null);
    }

    element.addEventListener('dragover', onDragOver);
    element.addEventListener('drop', onDrop);
    element.addEventListener('paste', onPaste);

    return {
      dispose() {
        disposed = true;
        element.removeEventListener('dragover', onDragOver);
        element.removeEventListener('drop', onDrop);
        element.removeEventListener('paste', onPaste);
      },
    };
  }

  return { createDropPastePart, DROP_MAX };
});
