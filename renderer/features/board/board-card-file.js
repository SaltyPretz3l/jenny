/* renderer/features/board/board-card-file.js - file cards on the board (UMD, global rendererBoardCardFile), a kind
 * module of board-card-kinds.js (row 150 slice B7).
 *
 * - Toolbar tool `file` ("File", order 20): a one-line field (like the Link form) for a path inside the project's
 *   folder, typed or chosen with "Choose…" (the system file chooser; the preload's getPathForFile turns the chosen file
 *   into its path). The path goes to source.resolveFile, which the main process checks against the board's own project
 *   folder, and comes back relative; the card is added with editor.addCard. With no project folder the tool says so
 *   when it is used, and the field does not open.
 * - props(card) marks { missing: true } on the cards source.fileStatus named; it is asked on the first file card drawn
 *   for a board and again when the window regains focus, then host.redraw().
 * - Enter or a double-click opens the file: source.openFile (the main process reads the path from the stored card),
 *   then the Workspace's open-file event, as renderer-sketch-open.js does. A refusal is told with ctx.notify.
 * addFileFromPath is exported for the paste and drop part (board-drop-paste.js). Paths reach the page as values only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rendererBoardCardFile = api;
  if (root && root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('file', api.createFilePart);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const OPEN_FILE_EVENT = 'ide:open-file-at-line'; // renderer-chat-path-open.js listens for it on the window
  const PATH_CHARS = 1024;
  const FILE_CARD = { w: 260, h: 72 }; // the model's default size for a file card

  function tell(ctx, message) {
    try { if (typeof ctx.notify === 'function') ctx.notify(message, { tone: 'warning' }); } catch (_error) { /* a toast must not break a card */ }
  }
  function boardIdOf(ctx) {
    const board = ctx.editor && typeof ctx.editor.getBoard === 'function' ? ctx.editor.getBoard() : null;
    return board ? board.id : '';
  }
  function resolveGlobal(windowRef, name, requirePath) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function refusalText(reason) {
    switch (reason) {
      case 'no_root': return jt('board.file.noRoot', 'This project has no folder, so its boards cannot hold files. Choose a folder for the project first.');
      case 'outside': return jt('board.file.outside', 'That file is outside this project’s folder.');
      case 'link': return jt('board.file.link', 'That path goes through a link or junction, so it cannot be opened from a board.');
      case 'not_found': return jt('board.file.notFound', 'That file is not there.');
      case 'not_file': return jt('board.file.notFile', 'That is a folder, not a file.');
      case 'invalid': return jt('board.file.invalid', 'That path cannot be used on a board.');
      case 'read_only': return jt('board.file.readOnly', 'This board cannot be changed.');
      case 'disabled': return jt('board.file.disabled', 'Files are not available here.');
      case 'unclaimed': return jt('board.file.unclaimed', 'The Workspace could not open this file.');
      case 'no_path': return jt('board.file.noPath', 'Jenny could not tell where that file is.');
      default: return jt('board.file.failed', 'That file could not be added. Try again.');
    }
  }

  /** The path of a File from a drop or the chooser, through the preload's getPathForFile; '' when there is none. */
  function pathOfFile(windowRef, file) {
    const getPath = windowRef && windowRef.jennyShell && windowRef.jennyShell.attachments && windowRef.jennyShell.attachments.getPathForFile;
    if (typeof getPath !== 'function') return '';
    try { return String(getPath(file) || '').trim(); } catch (_error) { return ''; }
  }

  /**
   * Resolves a path and adds its file card centred on `point` (the board's next free place when none); { ok, id } or
   * { ok: false, reason, message }. A refusal is told unless `quiet`.
   */
  async function addFileFromPath(ctx, rawPath, point, options) {
    const quiet = Boolean(options && options.quiet);
    const say = (reason) => { if (!quiet) tell(ctx, refusalText(reason)); return { ok: false, reason, message: refusalText(reason) }; };
    if (!ctx.editor.canEdit()) return say('read_only');
    const text = String(rawPath || '').trim();
    if (!text) return say('no_path');
    let answer;
    try { answer = await ctx.source.resolveFile({ boardId: boardIdOf(ctx), path: text.slice(0, PATH_CHARS) }); } catch (_error) { answer = null; }
    if (!answer || answer.ok !== true) return say(answer && answer.reason ? answer.reason : 'io');
    const card = { kind: 'file', data: { path: answer.path, title: '' }, w: FILE_CARD.w, h: FILE_CARD.h };
    if (point) Object.assign(card, { x: Math.round(point.x - FILE_CARD.w / 2), y: Math.round(point.y - FILE_CARD.h / 2) });
    const result = await ctx.editor.addCard(card);
    if (result.ok && ctx.host && typeof ctx.host.reveal === 'function') ctx.host.reveal(result.id);
    return result;
  }

  function createFilePart(ctx) {
    const doc = ctx.document;
    const windowRef = ctx.windowRef;
    let missing = new Set();
    let askedFor = '';
    let asking = 0;
    let form = null;
    let disposed = false;
    let hidden = false;

    async function refreshMissing() {
      const boardId = boardIdOf(ctx);
      if (!boardId || disposed || typeof ctx.source.fileStatus !== 'function') return;
      const mine = ++asking;
      let answer;
      try { answer = await ctx.source.fileStatus({ boardId }); } catch (_error) { answer = null; }
      if (disposed || mine !== asking || boardIdOf(ctx) !== boardId) return;
      const next = new Set(answer && answer.ok === true && Array.isArray(answer.missing) ? answer.missing : []);
      const changed = next.size !== missing.size || Array.from(next).some((id) => !missing.has(id));
      missing = next;
      if (changed && ctx.host && typeof ctx.host.redraw === 'function') ctx.host.redraw();
    }
    const onFocus = () => { if (askedFor && !hidden) void refreshMissing(); };
    if (windowRef && typeof windowRef.addEventListener === 'function') windowRef.addEventListener('focus', onFocus);

    async function open(card) {
      let answer;
      try { answer = await ctx.source.openFile({ boardId: boardIdOf(ctx), cardId: card.id }); } catch (_error) { answer = null; }
      if (disposed) return;
      if (!answer || answer.ok !== true || typeof answer.relativePath !== 'string') { tell(ctx, refusalText(answer && answer.reason)); return; }
      const detail = { path: answer.relativePath, line: null, column: null, preferIde: true };
      if (typeof answer.projectId === 'string' && answer.projectId) detail.projectId = answer.projectId;
      let claimed;
      try { claimed = windowRef.dispatchEvent(new windowRef.CustomEvent(OPEN_FILE_EVENT, { detail, bubbles: true, cancelable: true })) === false; } catch (_error) { claimed = false; }
      if (!claimed) tell(ctx, refusalText('unclaimed'));
    }

    /* ---------------------------------------------------------------- the path form */

    function closeForm(refocus) {
      if (!form) return;
      const opener = form.opener;
      form.element.remove();
      form = null;
      if (refocus && opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    }

    function problem(text) {
      if (!form) return;
      form.error.textContent = text || '';
      form.error.hidden = !text;
    }

    async function submit(rawPath) {
      if (!form || form.busy) return;
      form.busy = true;
      const result = await addFileFromPath(ctx, rawPath, null, { quiet: true });
      if (!form) return;
      form.busy = false;
      if (result.ok) closeForm(false); else problem(result.message);
    }

    function choose() {
      const fileInput = resolveGlobal(windowRef, 'inventoryFileInput', '../../inventory/file-input');
      if (typeof fileInput !== 'function') return;
      const input = fileInput(doc, { className: 'board-file-chooser' });
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file || !form) return;
        const chosen = pathOfFile(windowRef, file);
        if (!chosen) { problem(refusalText('no_path')); return; }
        form.field.value = chosen;
        void submit(chosen);
      }, { once: true });
      input.click();
    }

    function buildForm(opener) {
      const element = doc.createElement('div');
      element.className = 'board-link-form board-file-form';
      element.setAttribute('data-board-file-form', '');
      const field = doc.createElement('textarea');
      field.className = 'board-card-editor__field board-link-form__field';
      field.rows = 1;
      field.maxLength = PATH_CHARS;
      field.setAttribute('aria-label', jt('board.file.pathLabel', 'File path'));
      field.setAttribute('placeholder', jt('board.file.placeholder', 'src/app.js, or a full path inside the project folder'));
      field.setAttribute('spellcheck', 'false');
      element.appendChild(field);
      const canChoose = typeof resolveGlobal(windowRef, 'inventoryFileInput', '../../inventory/file-input') === 'function'
        && Boolean(windowRef && windowRef.jennyShell && windowRef.jennyShell.attachments && typeof windowRef.jennyShell.attachments.getPathForFile === 'function');
      element.insertAdjacentHTML('beforeend', ctx.actionButton({ variant: 'primary', size: 'sm', className: 'board-tool', label: jt('board.file.add', 'Add file'), title: jt('board.file.addTitle', 'Add this file to the board'), dataset: { 'board-file-add': '' } })
        + ctx.actionButton({ variant: 'ghost', size: 'sm', className: 'board-tool', label: jt('board.file.choose', 'Choose…'), disabled: !canChoose,
          title: canChoose ? jt('board.file.chooseTitle', 'Pick a file in the project folder') : jt('board.file.chooseUnavailable', 'The file chooser is not available here. Type the path instead.'), dataset: { 'board-file-choose': '' } })
        + ctx.actionButton({ variant: 'ghost', size: 'sm', className: 'board-tool', label: jt('board.file.cancel', 'Cancel'), title: jt('board.file.cancelTitle', 'Close without adding'), dataset: { 'board-file-cancel': '' } }));
      const error = doc.createElement('p');
      error.className = 'board-link-form__error';
      error.setAttribute('data-board-file-error', '');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      element.appendChild(error);
      const stop = (event) => event.stopPropagation();
      ['pointerdown', 'pointerup', 'dblclick', 'wheel', 'keyup', 'paste'].forEach((type) => element.addEventListener(type, stop));
      field.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(field.value); } else if (event.key === 'Escape') { event.preventDefault(); closeForm(true); }
      });
      field.addEventListener('input', () => { problem(''); if (/[\r\n]/.test(field.value)) field.value = field.value.replace(/[\r\n]+/g, ' '); });
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        const target = event.target && event.target.closest ? event.target : null;
        if (!target) return;
        if (target.closest('[data-board-file-add]')) void submit(field.value);
        else if (target.closest('[data-board-file-choose]')) choose();
        else if (target.closest('[data-board-file-cancel]')) closeForm(true);
      });
      return { element, field, error, opener, busy: false };
    }

    async function runTool() {
      const canvas = ctx.surface.element.parentNode;
      const opener = canvas ? canvas.querySelector('[data-board-tool="kind-file"]') : null;
      if (form) { form.field.focus({ preventScroll: true }); return; }
      // The folder is asked first: with none, the reason is told and no field opens.
      let status;
      try { status = await ctx.source.fileStatus({ boardId: boardIdOf(ctx) }); } catch (_error) { status = null; }
      if (disposed) return;
      if (status && status.ok === false && (status.reason === 'no_root' || status.reason === 'disabled')) { tell(ctx, refusalText(status.reason)); return; }
      form = buildForm(opener);
      const chrome = canvas ? canvas.querySelector('[data-board-chrome]') : null;
      (chrome || canvas || doc.body).appendChild(form.element);
      form.field.focus({ preventScroll: true });
    }

    return {
      kind: 'file',
      props: (card) => ({ missing: missing.has(card.id) }),
      decorate() {
        const boardId = boardIdOf(ctx);
        if (!boardId || askedFor === boardId) return;
        askedFor = boardId;
        void refreshMissing();
      },
      shown(isShown) {
        hidden = !isShown;
        // The files may have moved while the page was away: one read when it is back.
        if (isShown && askedFor) void refreshMissing();
      },
      activate(card) { void open(card); return true; },
      tools: [{ id: 'file', label: jt('board.toolbar.file', 'File'), title: jt('board.toolbar.fileTitle', 'Add a file from the project folder'), order: 20, run: runTool }],
      dispose() {
        disposed = true;
        closeForm(false);
        if (windowRef && typeof windowRef.removeEventListener === 'function') windowRef.removeEventListener('focus', onFocus);
      },
    };
  }

  return { createFilePart, addFileFromPath, pathOfFile, refusalText };
});
