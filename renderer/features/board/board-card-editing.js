/* renderer/features/board/board-card-editing.js - the inline editor for a note, a link and a group title (UMD).
 *
 * start(id) lays a small editor over the card: a note is a text box (line breaks kept, 4,000 characters), a group is
 * one line, a link is a title line and an address line with a "Fetch title" button. Escape cancels; Ctrl+Enter, Enter
 * in a one-line field, or leaving the editor commits through editor.editCard / editGroup. A refusal (a stale card, an
 * address that is not http or https, a limit) keeps the editor open with what the person typed and says why next to
 * it. "Fetch title" asks source.fetchLinkTitle only when pressed; the title it brings back is shown first and saved
 * only by "Use this title". Everything a document holds reaches the DOM as a value or textContent.
 *
 * start(id, { fresh: true }) is the editor of a note made a moment ago (the Note tool, a double-click on the canvas):
 * the note is already on the board, so cancelling its creation takes it off again. Escape removes it whatever was
 * typed; leaving the editor with nothing typed removes it too. Ctrl+Enter keeps it, empty or not, and so does the
 * window losing focus (the person went to copy something).
 *
 * The keys handled here are the editor's own: every other key on the canvas belongs to the keyboard module, so the
 * editor stops its keys from leaving it.
 *
 * On a team board (row 151 slice T7; `deps.context.getTeamSource()` answers the team source) a note's editor opens only once this
 * member holds the note: another member's hold says so and nothing opens, `presence.lock(id)` is asked first and a refusal says its
 * message, and the hold is given up when the editor closes. A board of one's own never reaches any of this. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardCardEditing = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const EDITABLE = new Set(['note', 'link', 'group']);
  const NOTE_CHARS = 4000;
  const TITLE_CHARS = 200;
  const URL_CHARS = 2048;
  const WEB_ADDRESS = /^https?:\/\/[^\s/?#]+\S*$/i;

  function fetchFailure(reason) {
    switch (reason) {
      case 'refused': return jt('board.edit.fetch.refused', 'That address is not allowed: it points to this computer or a private network.');
      case 'invalid': return jt('board.edit.fetch.invalid', 'Only http and https addresses can be fetched.');
      case 'timeout': return jt('board.edit.fetch.timeout', 'The page did not answer in time.');
      case 'not_html': return jt('board.edit.fetch.notHtml', 'That address is not a web page.');
      case 'no_title': return jt('board.edit.fetch.noTitle', 'The page has no title.');
      case 'too_large': return jt('board.edit.fetch.tooLarge', 'The page is too large to read its title.');
      case 'disabled': return jt('board.edit.fetch.disabled', 'Fetching titles is not available.');
      default: return jt('board.edit.fetch.failed', 'The title could not be fetched.');
    }
  }

  function createBoardCardEditing(deps) {
    const doc = deps.document;
    const { editor, source, host } = deps;
    const actionButton = deps.actionButton;
    const sessions = new Set();
    const context = deps.context || {};
    const teamSource = () => (typeof context.getTeamSource === 'function' ? context.getTeamSource() : null);
    const tell = (message) => { if (typeof deps.notify === 'function') deps.notify(message, { tone: 'warning' }); };
    const asking = new Set(); // note ids a lock is being asked for
    let held = null; // { id, presence }: the note this member holds on a team board, until its editor closes
    let disposed = false;

    function textarea(name, label, value, maxLength, single) {
      const el = doc.createElement('textarea');
      el.className = 'board-card-editor__field';
      el.setAttribute('data-board-field', name);
      el.setAttribute('aria-label', label);
      el.setAttribute('dir', 'auto');
      el.setAttribute('spellcheck', name === 'url' ? 'false' : 'true');
      el.rows = single ? 1 : 4;
      el.maxLength = maxLength;
      el.value = value;
      if (single) el.setAttribute('data-board-single-line', '');
      return el;
    }
    function paragraph(className, attribute) {
      const el = doc.createElement('p');
      el.className = className;
      if (attribute) el.setAttribute(attribute, '');
      return el;
    }
    function setStatus(session, text) {
      session.status.textContent = text || '';
      session.status.hidden = !text;
    }
    function firstField(session) { return session.wrapper.querySelector('textarea'); }

    function build(session, item) {
      const w = session.wrapper;
      w.className = `board-card-editor board-card-editor--${session.kind}`;
      w.setAttribute('data-board-editor', '');
      w.setAttribute('data-editing', session.id);
      if (session.kind === 'note') {
        w.appendChild(textarea('text', jt('board.edit.noteLabel', 'Note text'), item.data.text, NOTE_CHARS, false));
      } else if (session.kind === 'group') {
        w.appendChild(textarea('title', jt('board.edit.groupLabel', 'Group title'), item.title, TITLE_CHARS, true));
      } else {
        w.appendChild(textarea('title', jt('board.edit.linkTitleLabel', 'Link title'), item.data.title, TITLE_CHARS, true));
        w.appendChild(textarea('url', jt('board.edit.linkUrlLabel', 'Link address'), item.data.url, URL_CHARS, true));
        const row = doc.createElement('div');
        row.className = 'board-card-editor__row';
        const canFetch = source && typeof source.fetchLinkTitle === 'function';
        row.insertAdjacentHTML('beforeend', actionButton({
          variant: 'secondary', size: 'sm', label: jt('board.edit.fetchTitle', 'Fetch title'), disabled: !canFetch,
          title: canFetch ? jt('board.edit.fetchTitleTitle', 'Look up the page’s title. Nothing is saved until you use it.') : fetchFailure('disabled'),
          dataset: { 'board-fetch-title': '' },
        }));
        session.fetched = doc.createElement('span');
        session.fetched.className = 'board-card-editor__fetched';
        session.fetched.setAttribute('data-board-fetched', '');
        row.appendChild(session.fetched);
        row.insertAdjacentHTML('beforeend', actionButton({
          variant: 'ghost', size: 'sm', label: jt('board.edit.useTitle', 'Use this title'), disabled: true,
          title: jt('board.edit.useTitleTitle', 'Save the fetched title on this card'), dataset: { 'board-use-title': '' },
        }));
        w.appendChild(row);
      }
      session.status = paragraph('board-card-editor__status', 'data-board-editor-status');
      session.status.setAttribute('role', 'status');
      session.status.hidden = true;
      w.appendChild(session.status);
      const hint = paragraph('board-card-editor__hint');
      hint.textContent = session.kind === 'note'
        ? jt('board.edit.noteHint', 'Ctrl+Enter saves. Esc cancels.')
        : jt('board.edit.lineHint', 'Enter saves. Esc cancels.');
      w.appendChild(hint);
    }

    function release(session) {
      if (!session.lock || !held || held.session !== session) return;
      const { presence } = held;
      held = null;
      session.lock = false;
      try { void Promise.resolve(presence.unlock()).catch(() => {}); } catch (_error) { /* the hold ends with the board */ }
    }

    function close(session, refocus) {
      if (!sessions.delete(session)) return;
      release(session);
      session.wrapper.remove();
      if (refocus && typeof host.focusItem === 'function') host.focusItem(session.id);
    }

    /** What the fields hold, as the call that saves it: { run } or { error } or { skip }. */
    function plan(session) {
      const board = editor.getBoard();
      const field = (name) => session.wrapper.querySelector(`[data-board-field="${name}"]`);
      if (session.kind === 'note') return { run: () => editor.editCard(session.id, { text: field('text').value }, session.base) };
      if (session.kind === 'group') {
        const title = field('title').value.trim();
        const group = board && board.groups[session.id];
        if (!title || !group || title === group.title) return { skip: true };
        return { run: () => editor.editGroup(session.id, { title }, session.base) };
      }
      const card = board && board.cards[session.id];
      const url = field('url').value.trim();
      const title = field('title').value.trim();
      if (!WEB_ADDRESS.test(url)) return { error: jt('board.edit.urlInvalid', 'A link needs an address that starts with http:// or https://.') };
      const data = {};
      if (card && url !== card.data.url) data.url = url;
      if (card && title !== card.data.title) data.title = title;
      return Object.keys(data).length ? { run: () => editor.editCard(session.id, data, session.base) } : { skip: true };
    }

    /** A new note's creation is cancelled: its editor closes and the note leaves the board (a refusal is said by the editor). */
    function drop(session, refocus) {
      const home = refocus ? session.wrapper.closest('.inv-board-canvas') : null;
      close(session, false);
      if (home) home.focus({ preventScroll: true });
      void editor.removeCard(session.id);
    }

    async function commit(session, origin) {
      if (!sessions.has(session) || session.busy) return;
      const empty = session.fresh && origin !== 'key' && !session.wrapper.querySelector('[data-board-field="text"]').value.trim();
      if (empty && (origin !== 'blur' || typeof doc.hasFocus !== 'function' || doc.hasFocus())) { drop(session, false); return; }
      const next = plan(session);
      if (next.skip) { close(session, origin === 'key'); return; }
      if (next.error) { setStatus(session, next.error); return; }
      session.busy = true;
      const result = await next.run();
      session.busy = false;
      if (!sessions.has(session)) return;
      if (result.ok) { close(session, origin === 'key'); return; }
      setStatus(session, result.message || fetchFailure('failed'));
      if (origin === 'key') firstField(session).focus({ preventScroll: true });
    }

    async function fetchTitle(session) {
      const button = session.wrapper.querySelector('[data-board-fetch-title]');
      const use = session.wrapper.querySelector('[data-board-use-title]');
      const url = session.wrapper.querySelector('[data-board-field="url"]').value.trim();
      session.fetchToken += 1;
      const token = session.fetchToken;
      session.fetchedTitle = '';
      session.fetched.textContent = '';
      use.disabled = true;
      if (!WEB_ADDRESS.test(url)) { setStatus(session, fetchFailure('invalid')); return; }
      if (!source || typeof source.fetchLinkTitle !== 'function') { setStatus(session, fetchFailure('disabled')); return; }
      button.disabled = true;
      setStatus(session, jt('board.edit.fetching', 'Fetching the title…'));
      let answer;
      try { answer = await source.fetchLinkTitle({ url }); } catch (_error) { answer = { ok: false, reason: 'failed' }; }
      if (!sessions.has(session) || token !== session.fetchToken) return;
      button.disabled = false;
      if (answer && answer.ok === true && typeof answer.title === 'string' && answer.title) {
        session.fetchedTitle = answer.title;
        session.fetched.textContent = answer.title;
        use.disabled = false;
        setStatus(session, jt('board.edit.fetched', 'Title found. Use it to save it on the card.'));
        return;
      }
      setStatus(session, fetchFailure(answer && answer.reason));
    }

    async function useTitle(session) {
      const title = session.fetchedTitle;
      if (!title) return;
      const result = await editor.editCard(session.id, { title }, session.base);
      if (!sessions.has(session)) return;
      if (!result.ok) { setStatus(session, result.message || fetchFailure('failed')); return; }
      const saved = editor.getBoard().cards[session.id];
      if (saved) session.base.rev = saved.content_rev; // this editor's own save, not someone else's change
      session.wrapper.querySelector('[data-board-field="title"]').value = title;
      setStatus(session, jt('board.edit.titleSaved', 'Title saved.'));
    }

    function wire(session) {
      const w = session.wrapper;
      const stop = (event) => event.stopPropagation();
      ['pointerdown', 'pointerup', 'dblclick', 'wheel', 'keyup'].forEach((type) => w.addEventListener(type, stop));
      w.addEventListener('click', (event) => {
        event.stopPropagation();
        const target = event.target && event.target.closest ? event.target : null;
        if (target && target.closest('[data-board-fetch-title]')) { void fetchTitle(session); return; }
        if (target && target.closest('[data-board-use-title]')) void useTitle(session);
      });
      w.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); if (session.fresh) drop(session, true); else close(session, true); return; }
        const single = event.target && event.target.hasAttribute && event.target.hasAttribute('data-board-single-line');
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || (single && !event.shiftKey))) {
          event.preventDefault();
          void commit(session, 'key');
        }
      });
      w.addEventListener('input', (event) => {
        setStatus(session, '');
        const target = event.target;
        if (target && target.hasAttribute && target.hasAttribute('data-board-single-line') && /[\r\n]/.test(target.value)) target.value = target.value.replace(/[\r\n]+/g, ' ');
      });
      w.addEventListener('focusout', (event) => {
        if (event.relatedTarget && w.contains(event.relatedTarget)) return;
        void commit(session, 'blur');
      });
    }

    /** Opens the editor of a note, a link or a group title; false when that item has none or cannot be edited. */
    function start(id, options) {
      if (!editor.canEdit()) return false;
      const fresh = Boolean(options && options.fresh);
      const team = teamSource();
      const card = team ? editor.getBoard() && editor.getBoard().cards[id] : null;
      // A team note is held before it is edited; the open of its editor waits for the answer (true: the edit is under way).
      if (team && card && card.kind === 'note' && !isOpenFor(id)) { void startHeld(id, team, fresh).catch(() => { asking.delete(id); }); return true; }
      return open(id, fresh);
    }

    const isOpenFor = (id) => Array.from(sessions).some((session) => session.id === id);

    async function startHeld(id, team, fresh) {
      if (asking.has(id)) return;
      const presence = team.presence;
      const holder = ((presence.get() || {}).locks || []).find((lock) => lock.card_id === id);
      // This member's own earlier hold (its release did not arrive) is no one else's: the lock call below settles it.
      const mine = holder && typeof context.isSelfMember === 'function' && context.isSelfMember(holder.member_id) === true;
      if (holder && !mine) {
        const name = typeof context.nameOfMember === 'function' ? context.nameOfMember(holder.member_id) : '';
        tell(jt('board.team.noteHeld', '{name} is editing this note.', { name: name || jt('board.team.someone', 'Someone') }));
        return;
      }
      asking.add(id);
      // Another open editor is saved first, so its hold is given up before this one is asked for.
      await Promise.all(Array.from(sessions).filter((other) => other.id !== id).map((other) => commit(other, 'switch')));
      const answer = await Promise.resolve(presence.lock(id)).catch(() => ({ ok: false }));
      asking.delete(id);
      const board = editor.getBoard();
      const alive = !disposed && teamSource() === team && editor.canEdit() && board && board.cards[id] && host.itemElement(id);
      if (!answer || answer.ok !== true) { if (!disposed) tell(answer && answer.message ? answer.message : jt('board.team.noteLockFailed', 'This note could not be held for you. Try again.')); return; }
      // The host gave the hold: it is given back when no editor opens, and when opening one throws.
      let opened = false;
      try { opened = Boolean(alive && open(id, fresh)); } finally { if (!opened) void Promise.resolve(presence.unlock()).catch(() => {}); }
      const session = opened ? Array.from(sessions).find((entry) => entry.id === id) : null;
      if (session) { session.lock = true; held = { session, presence }; }
    }

    function open(id, fresh) {
      const board = editor.getBoard();
      const card = board && board.cards[id];
      const item = card || (board && board.groups[id]);
      const kind = card ? card.kind : 'group';
      if (!item || !EDITABLE.has(kind)) return false;
      const element = host.itemElement(id);
      if (!element) return false;
      for (const other of sessions) {
        if (other.id === id) { firstField(other).focus({ preventScroll: true }); return true; }
        void commit(other, 'switch');
      }
      const session = { id, kind, wrapper: doc.createElement('div'), status: null, fetched: null, fetchedTitle: '', fetchToken: 0, busy: false, fresh: Boolean(fresh) && kind === 'note',
        base: { rev: item.content_rev } }; // what the fields were filled from: a later change by someone else refuses the save once
      build(session, item);
      sessions.add(session);
      wire(session);
      element.appendChild(session.wrapper);
      const field = firstField(session);
      field.focus({ preventScroll: true });
      if (kind === 'note') field.setSelectionRange(field.value.length, field.value.length); else field.select();
      return true;
    }

    return {
      start,
      isOpen: () => sessions.size > 0,
      /** Drops an editor whose card has left the canvas. */
      prune() { sessions.forEach((session) => { if (!session.wrapper.isConnected) sessions.delete(session); }); },
      dispose() {
        disposed = true;
        Array.from(sessions).forEach((session) => { sessions.delete(session); release(session); session.wrapper.remove(); });
      },
    };
  }

  return { createBoardCardEditing, fetchFailure };
});
