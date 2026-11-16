/* renderer/features/board/board-card-media.js - picture cards on the board (UMD, global rendererBoardCardMedia), a kind
 * module of board-card-kinds.js (row 150 slice B7).
 *
 * - A picture card shows its picture in boardCard.media(element) as an <img> whose src is a blob URL made from the
 *   bytes source.readAsset answers (the page's policy allows img-src blob:; there is no custom protocol). One object
 *   URL per picture, shared by every card that shows it; a URL is revoked when no card shows it any more, when the
 *   cache passes URL_CACHE pictures (oldest first), and on dispose(). A picture that cannot be read shows one quiet line.
 * - Toolbar tool `picture` ("Picture", order 30): choose a picture file; it is stored with source.addAsset (the main
 *   process decides the type by content and reads the size) and added with editor.addCard, at most 320 px wide keeping
 *   its shape, its description starting as the file's name without the extension. Each refusal has its own sentence.
 * - Enter or a double-click opens a one-line field for the description (the alt text), saved with editor.editCard;
 *   Enter saves, Esc cancels, leaving the field saves, and the focus goes back to the card.
 * addPictureFromFile and isPictureFile are exported for the paste and drop part (board-drop-paste.js). Text from a
 * card or a file name reaches the page as a value, an attribute or textContent only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rendererBoardCardMedia = api;
  if (root && root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('image', api.createMediaPart);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const URL_CACHE = 64;
  const PICTURE_WIDTH = 320;
  const ALT_CHARS = 1000; // the model's FIELD_MAX.alt
  const ASSET_MAX_BYTES = 10 * 1024 * 1024; // the model's LIMITS.image_asset_bytes, checked before the bytes are read
  const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  /** One line of at most `max` characters: control characters and line or paragraph separators become spaces. */
  function oneLine(text, max) {
    let out = '';
    for (const ch of String(text == null ? '' : text)) {
      const code = ch.codePointAt(0);
      out += code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : ch;
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /** A file's name without its extension, as a picture's first description. */
  function baseTitle(name) {
    const plain = String(name || '').split(/[\\/]/).pop();
    const dot = plain.lastIndexOf('.');
    return oneLine(dot > 0 ? plain.slice(0, dot) : plain, ALT_CHARS);
  }

  function isPictureFile(file) {
    return Boolean(file) && PICTURE_TYPES.indexOf(String(file.type || '').toLowerCase()) >= 0;
  }

  function boardIdOf(ctx) {
    const board = ctx.editor && typeof ctx.editor.getBoard === 'function' ? ctx.editor.getBoard() : null;
    return board ? board.id : '';
  }

  function tell(ctx, message) {
    try { if (typeof ctx.notify === 'function') ctx.notify(message, { tone: 'warning' }); } catch (_error) { /* a toast must not break a card */ }
  }

  function refusalText(reason) {
    switch (reason) {
      case 'too_large': return jt('board.picture.tooLarge', 'That picture is larger than 10 MB.');
      case 'unsupported': return jt('board.picture.unsupported', 'Only PNG, JPEG, WebP and GIF pictures can go on a board.');
      case 'dimensions': return jt('board.picture.dimensions', 'That picture is too wide or too tall for a board.');
      case 'full': return jt('board.picture.full', 'Board pictures have used their 200 MB. Remove some pictures from your boards first.');
      case 'read_only': return jt('board.picture.readOnly', 'This board cannot be changed.');
      case 'not_found': return jt('board.picture.noBoard', 'This board is no longer here.');
      case 'disabled': return jt('board.picture.disabled', 'Pictures are not available here.');
      case 'unreadable': return jt('board.picture.unreadable', 'That picture could not be read.');
      default: return jt('board.picture.failed', 'The picture could not be added. Try again.');
    }
  }

  function readBytes(file, windowRef) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    return new Promise((resolve, reject) => {
      const reader = new windowRef.FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Stores a picture file and adds its card, centred on `point` (board coordinates; the board's next free place when none).
   * Resolves { ok: true, id } or { ok: false, reason }; a refusal is told. Never rejects.
   */
  async function addPictureFromFile(ctx, file, point) {
    if (!ctx.editor.canEdit()) { tell(ctx, refusalText('read_only')); return { ok: false, reason: 'read_only' }; }
    if (!file || typeof file.size !== 'number') return { ok: false, reason: 'invalid' };
    if (file.size > ASSET_MAX_BYTES) { tell(ctx, refusalText('too_large')); return { ok: false, reason: 'too_large' }; }
    let answer;
    try {
      const bytes = await readBytes(file, ctx.windowRef);
      answer = await ctx.source.addAsset({ boardId: boardIdOf(ctx), bytes });
    } catch (_error) {
      answer = { ok: false, reason: 'unreadable' };
    }
    if (!answer || answer.ok !== true) {
      const reason = answer && answer.reason ? answer.reason : 'io';
      tell(ctx, (answer && typeof answer.message === 'string' && answer.message) || refusalText(reason)); // a team board's own sentence first
      return { ok: false, reason };
    }
    // The model's own default for a picture: at most PICTURE_WIDTH wide, keeping its shape.
    const w = Math.max(8, Math.min(PICTURE_WIDTH, answer.width));
    const h = Math.max(8, Math.round((w * answer.height) / answer.width));
    const card = { kind: 'image', data: { asset: answer.asset, width: answer.width, height: answer.height, alt: baseTitle(file.name) }, w, h };
    if (point) Object.assign(card, { x: Math.round(point.x - w / 2), y: Math.round(point.y - h / 2) });
    const result = await ctx.editor.addCard(card);
    if (result.ok && ctx.host && typeof ctx.host.reveal === 'function') ctx.host.reveal(result.id);
    return result;
  }

  function resolveGlobal(windowRef, name, requirePath) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function createMediaPart(ctx) {
    const doc = ctx.document;
    const urls = new Map(); // asset -> { url, cards: Set, promise }, oldest first
    const shown = new Map(); // card id -> { asset, token }
    let token = 0;
    let altSession = null;
    let disposed = false;

    function revoke(asset) {
      const entry = urls.get(asset);
      if (!entry) return;
      urls.delete(asset);
      if (entry.url) try { ctx.windowRef.URL.revokeObjectURL(entry.url); } catch (_error) { /* already gone */ }
    }

    function touch(asset, entry) {
      urls.delete(asset);
      urls.set(asset, entry);
      while (urls.size > URL_CACHE) revoke(urls.keys().next().value);
    }

    // The picture's blob URL, made once per asset; null when it cannot be read.
    function urlFor(asset, cardId) {
      let entry = urls.get(asset);
      if (!entry) {
        entry = { url: '', cards: new Set(), promise: null };
        entry.promise = Promise.resolve()
          .then(() => ctx.source.readAsset({ boardId: boardIdOf(ctx), asset }))
          .then((answer) => {
            if (disposed || urls.get(asset) !== entry || !answer || answer.ok !== true || !answer.bytes) return null;
            entry.url = ctx.windowRef.URL.createObjectURL(new ctx.windowRef.Blob([answer.bytes], { type: answer.mime || '' }));
            return entry.url;
          }, () => null);
      }
      entry.cards.add(cardId);
      touch(asset, entry);
      return entry.promise.then((url) => (urls.get(asset) === entry ? url : null));
    }

    function drop(cardId) {
      const was = shown.get(cardId);
      if (!was) return;
      shown.delete(cardId);
      const entry = urls.get(was.asset);
      if (!entry) return;
      entry.cards.delete(cardId);
      if (!entry.cards.size) revoke(was.asset);
    }

    function decorate(element, card) {
      const slot = ctx.boardCard.media(element);
      if (!slot) return;
      let img = slot.querySelector('img[data-board-picture]');
      let line = slot.querySelector('[data-board-picture-missing]');
      if (!img) {
        img = doc.createElement('img');
        img.className = 'board-picture';
        img.setAttribute('data-board-picture', '');
        img.draggable = false;
        img.decoding = 'async';
        slot.appendChild(img);
        line = doc.createElement('p');
        line.className = 'board-picture__missing';
        line.setAttribute('data-board-picture-missing', '');
        line.textContent = jt('board.picture.notShown', 'This picture could not be shown.');
        line.hidden = true;
        slot.appendChild(line);
      }
      img.alt = card.data.alt || '';
      const was = shown.get(card.id);
      if (was && was.asset === card.data.asset) return;
      if (was) drop(card.id);
      const mine = { asset: card.data.asset, token: ++token };
      shown.set(card.id, mine);
      void urlFor(mine.asset, card.id).then((url) => {
        if (disposed || shown.get(card.id) !== mine) return;
        if (url) { img.src = url; img.hidden = false; line.hidden = true; } else { img.removeAttribute('src'); img.hidden = true; line.hidden = false; }
      });
    }

    /* ---------------------------------------------------------------- the description field */

    function closeAlt(refocus) {
      const session = altSession;
      if (!session) return;
      altSession = null;
      session.wrapper.remove();
      if (refocus && ctx.host && typeof ctx.host.focusItem === 'function') ctx.host.focusItem(session.id);
    }

    async function commitAlt(session, origin) {
      if (altSession !== session || session.busy) return;
      const board = ctx.editor.getBoard();
      const card = board && board.cards[session.id];
      const alt = oneLine(session.field.value, ALT_CHARS);
      if (!card || alt === card.data.alt) { closeAlt(origin === 'key'); return; }
      session.busy = true;
      const result = await ctx.editor.editCard(session.id, { alt });
      session.busy = false;
      if (altSession !== session) return;
      if (result.ok) { closeAlt(origin === 'key'); return; }
      session.status.textContent = result.message || refusalText('io');
      session.status.hidden = false;
      if (origin === 'key') session.field.focus({ preventScroll: true });
    }

    function openAlt(card) {
      if (!ctx.editor.canEdit()) return false;
      const element = ctx.host.itemElement(card.id);
      if (!element) return false;
      if (altSession && altSession.id === card.id) { altSession.field.focus({ preventScroll: true }); return true; }
      if (altSession) void commitAlt(altSession, 'switch');
      const wrapper = doc.createElement('div');
      wrapper.className = 'board-card-editor board-card-editor--image';
      wrapper.setAttribute('data-board-editor', '');
      wrapper.setAttribute('data-editing', card.id);
      const field = doc.createElement('textarea');
      field.className = 'board-card-editor__field';
      field.setAttribute('data-board-field', 'alt');
      field.setAttribute('data-board-single-line', '');
      field.setAttribute('aria-label', jt('board.picture.altLabel', 'Picture description'));
      field.setAttribute('dir', 'auto');
      field.rows = 1;
      field.maxLength = ALT_CHARS;
      field.value = card.data.alt || '';
      const status = doc.createElement('p');
      status.className = 'board-card-editor__status';
      status.setAttribute('data-board-editor-status', '');
      status.setAttribute('role', 'status');
      status.hidden = true;
      const hint = doc.createElement('p');
      hint.className = 'board-card-editor__hint';
      hint.textContent = jt('board.picture.altHint', 'Describe the picture for someone who cannot see it. Enter saves. Esc cancels.');
      wrapper.appendChild(field);
      wrapper.appendChild(status);
      wrapper.appendChild(hint);
      const session = { id: card.id, wrapper, field, status, busy: false };
      const stop = (event) => event.stopPropagation();
      ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'keyup', 'paste'].forEach((type) => wrapper.addEventListener(type, stop));
      wrapper.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); closeAlt(true); return; }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void commitAlt(session, 'key'); }
      });
      wrapper.addEventListener('input', () => {
        status.hidden = true;
        if (/[\r\n]/.test(field.value)) field.value = field.value.replace(/[\r\n]+/g, ' ');
      });
      wrapper.addEventListener('focusout', (event) => {
        if (event.relatedTarget && wrapper.contains(event.relatedTarget)) return;
        void commitAlt(session, 'blur');
      });
      altSession = session;
      element.appendChild(wrapper);
      field.focus({ preventScroll: true });
      field.select();
      return true;
    }

    /* ---------------------------------------------------------------- the toolbar tool */

    function choosePicture() {
      const fileInput = resolveGlobal(ctx.windowRef, 'inventoryFileInput', '../../inventory/file-input');
      if (typeof fileInput !== 'function') { tell(ctx, jt('board.picture.noChooser', 'Choosing a picture is not available here.')); return; }
      const input = fileInput(doc, { accept: PICTURE_TYPES.join(','), className: 'board-file-chooser' });
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file && !disposed) void addPictureFromFile(ctx, file, null);
      }, { once: true });
      input.click();
    }

    return {
      kind: 'image',
      decorate,
      release(id) {
        drop(id);
        if (altSession && altSession.id === id) closeAlt(false);
      },
      activate(card) { return openAlt(card); },
      tools: [{ id: 'picture', label: jt('board.toolbar.picture', 'Picture'), title: jt('board.toolbar.pictureTitle', 'Add a picture from a file'), order: 30, run: choosePicture }],
      dispose() {
        disposed = true;
        closeAlt(false);
        Array.from(urls.keys()).forEach(revoke);
        shown.clear();
      },
    };
  }

  return { createMediaPart, addPictureFromFile, isPictureFile, refusalText, URL_CACHE };
});
