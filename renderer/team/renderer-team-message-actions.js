/* What a person can do to a message in the team channel (row 123, slices
 * 2a-5b and 2a-6a), inside one shown channel's timeline or thread column: the
 * action row, Reply in thread, edit in place,
 * delete through a two-step confirm in the row, mark unread from here, Retry
 * and Delete (or Dismiss) on what the outbox could not send, and the single
 * keys on a focused message.
 *
 * - The action row (`role="toolbar"`) shows on hover and focus and holds
 *   Reply in thread (not inside a thread), Copy link (not on a deleted
 *   message) and More. Copy link and L write the message's link token
 *   (renderer-team-link.js) to the clipboard and say so in a toast placed
 *   over the log (`.team-copied`, inventory toast markup).
 *   More offers Edit (your own message), Delete (your own, or any for the
 *   team owner) and Mark unread; a read-only member gets Mark unread only. A
 *   message whose edit or delete is still queued offers neither until it
 *   settles. In a thread More offers Edit and Delete only.
 * - A right-click on a message (owner, 2026-11-13), the context-menu key or Shift+F10 on a focused message opens one
 *   menu with what the action row offers there: its own buttons (`rowButtons`, the one list both draw from), then
 *   More's entries, each running the same handler. A right-click on a link, a code block, a text field or selected
 *   text keeps the default menu (Copy keeps working). The menu closes on Esc, an outside click, a scroll and when
 *   its message leaves; the focus goes back to the row.
 * - R opens the message's thread (its root's, for a reply), E edits, L copies
 *   its link and Delete asks to delete, only on a focused message row, never
 *   inside a text field and never while a menu is open. Esc closes the menu
 *   (the menu's own handler), then the edit or the confirm; with nothing open
 *   it does nothing.
 * - An edit is sent with the row's `rev` as `expected_rev`. A refusal keeps
 *   the edit open with its text and says why. While an edit is open, every
 *   other way into an edit or a delete goes back to it and changes nothing: an
 *   edit ends by Save or Esc. Esc gives the composer back. The edit box is
 *   filled through `.value`.
 * - Retry on a failed entry whose re-send was queued offers Dismiss only.
 * - The timeline draws what this module answers in `parts()`: the row's edit
 *   box, foot and action row, with a signature that changes when they do. An
 *   open edit's signature is fixed, so no push redraws the text being typed.
 * Host text is untrusted: names, words and errors go through `escapeHtml`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-writes'), require('./renderer-team-message-row'), require('./renderer-team-link'),
      require('./renderer-team-marks'), require('./renderer-team-receipts'), require('./renderer-team-pop'));
    return;
  }
  root.rendererTeamMessageActions = factory(root.rendererTeamChatWrites, root.rendererTeamMessageRow, root.rendererTeamLink,
    root.rendererTeamMarks, root.rendererTeamReceipts, root.rendererTeamPop);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatWrites, rows, links, marksModule, receiptsModule, popModule) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const REPLY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10v6H7l-3 2.5V10H3z"/></svg>';
  const LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7"/></svg>';
  const COPIED_MS = 1800;
  const DOTS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
  const reason = chatWrites.failText;
  // Copy with source (row 175 F12): a link to another message means nothing in a quote, so `jenny-team:` tokens go.
  const TEAM_TOKEN = /jenny-team:[A-Za-z0-9_/-]+/gu;
  const pad = (n) => String(n).padStart(2, '0');
  function dayOf(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }
  // A Markdown quote: "> **Name**, #channel or project, date", then each line of the text behind "> ". Plain text for
  // the clipboard (the text's own markup stays as written). Attachments and previews are never part of `text`.
  function buildQuote({ name, where, date, text }) {
    const head = '> **' + String(name || '') + '**' + [where, date].filter(Boolean).map((part) => ', ' + part).join('');
    const body = String(text || '').replace(TEAM_TOKEN, '').replace(/[ \t]+$/gmu, '').trim();
    const quoted = body ? body.split(/\r\n|\r|\n/u).map((line) => '> ' + line) : [];
    return [head].concat(quoted).join('\n');
  }

  function inv() { return globalThis.inventory || {}; }
  function menuApi() { return (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null; }
  function isTextField(el) { return Boolean(el && (el.isContentEditable || /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName))); }

  // `ctx()` is the tab's context for this frame's team: { me, online, canWrite, isOwner, nameOf(id), knownName(id) }.
  // `holdRead(on)` sets the timeline's read hold and answers what it was. `list()` answers the messages shown
  // (the channel's timeline by default); `inThread` drops Reply in thread and Mark unread (so no `holdRead`);
  // `onReply(message)` opens a message's thread. Esc that cancels a text composition closes nothing.
  function createActions({ root, chat, teamId, channelId, ctx, writes, redraw, holdRead = () => false, focusComposer, list = null, inThread = false, onReply = null, pop = null }) {
    let editing = null; // { id, rev, names }
    let confirming = null; // message id
    let menuOpen = false;
    let disposed = false;
    const actsMarkup = new Map();
    let copied = null; // { el, timer }: the toast after Copy link
    const notes = new Map(); // 'msg:<id>' or 'entry:<id>' -> words of the last refusal there

    const shown = () => (list ? list() : chat.timeline(teamId, channelId).list);
    const messageOf = (id) => shown().find((m) => m.id === id) || null;
    const rowOf = (id) => rows.rowOf(root, id);
    // Reactions, pins, earlier versions and "Seen by" (slice 2b-2) open in one popover per host: the timeline's, or the thread column's.
    const pops = pop || popModule.createPop({ host: root.closest('.team-thread') || root.closest('.team-main') || root });
    const marks = marksModule.createMarks({ chat, teamId, channelId, ctx, writes, redraw, messageOf, rowOf, pop: pops });
    const receipts = receiptsModule.createReceipts({ chat, teamId, channelId, ctx, writes, pop: pops, rowOf });
    // An edit or delete of this message that is queued (not failed): a second one would be built on the old rev.
    const changing = (id) => chat.pending(teamId).some((e) => e && e.message_id === id && e.state !== 'failed' && (e.operation === 'edit' || e.operation === 'delete'));
    const canEdit = (message, c) => Boolean(c.canWrite && message && !message.deleted && rows.isOwnMessage(message, c.me) && !changing(message.id));
    const canDelete = (message, c) => Boolean(c.canWrite && message && !message.deleted && (rows.isOwnMessage(message, c.me) || c.isOwner) && !changing(message.id));

    // ------------------------------------------------------------ drawing

    function button(label, action, { entryId = '', variant = 'ghost', busy = false } = {}) {
      const dataset = { 'team-msg-action': action };
      if (entryId) dataset['entry-id'] = entryId;
      return inv().actionButton({ label, size: 'sm', variant, className: 'team-foot-btn', dataset, disabled: busy });
    }
    function failed(text) { return '<span class="team-failed">' + escapeHtml(text) + '</span>'; }

    // The foot words for an outbox entry: queued, or failed with Retry and Delete (a post) or Dismiss.
    function entryFoot(entry, c) {
      const id = entry.entry_id;
      let html;
      if (entry.state !== 'failed') {
        const text = entry.operation === 'edit' ? jt('team.out.saving', 'Saving your edit')
          : entry.operation === 'delete' ? jt('team.out.deleting', 'Deleting')
            : c.online ? jt('team.chat.sending', 'Sending') : jt('team.chat.sendsLater', 'Sends when reconnected');
        html = '<span class="team-queued">' + escapeHtml(text) + '</span>';
      } else {
        const why = reason({ error: entry.error });
        const text = entry.operation === 'edit' ? jt('team.out.editFailed', 'Your edit was not saved. {reason}', { reason: why })
          : entry.operation === 'delete' ? jt('team.out.deleteFailed', 'Not deleted. {reason}', { reason: why })
            : jt('team.out.notSent', 'Not sent. {reason}', { reason: why });
        const busy = writes.isBusy('retry:' + id) || writes.isBusy('discard:' + id);
        const resent = writes.wasResent(id); // sent again already: only its discard is owed
        html = failed(text) + (resent ? '' : button(jt('team.out.retry', 'Retry'), 'retry', { entryId: id, busy }))
          + button(entry.operation === 'post' && !resent ? jt('team.out.delete', 'Delete') : jt('team.out.dismiss', 'Dismiss'), 'discard', { entryId: id, busy });
      }
      const note = notes.get('entry:' + id);
      return html + (note ? failed(note) : '');
    }

    // The action row's own buttons between Add reaction and More: Reply in thread (not inside a thread) and Copy link
    // (not on a deleted message, never in a direct conversation: slice 2d). The row draws them and the message menu
    // lists them, so the two cannot drift; Add reaction is More's first entry, with the same reason when greyed.
    function rowButtons(deleted, c) {
      const list = [];
      if (!inThread && onReply) list.push({ action: 'reply', label: jt('team.acts.reply', 'Reply in thread'), title: jt('team.acts.replyKey', 'Reply in thread (R)'), key: 'R', icon: REPLY });
      if (!deleted && !c.direct) list.push({ action: 'copy-link', label: jt('team.link.copyLabel', 'Copy link'), title: jt('team.link.copy', 'Copy link (L)'), key: 'L', icon: LINK });
      return list;
    }
    // What a row button does (a click on it, or its entry in the message menu).
    function runButton(action, id) {
      if (action === 'reply') openThread(id);
      else if (action === 'copy-link') void copyLink(id);
    }

    // One markup for live messages (with Copy link, never in a direct conversation: slice 2d) and one for deleted ones.
    function actsHtml(deleted, c) {
      const at = deleted || c.direct ? 1 : 0;
      const key = at + (deleted ? '' : marks.actsKey(c));
      if (actsMarkup.has(key)) return actsMarkup.get(key);
      const react = deleted ? '' : marks.smileyHtml(c);
      const label = jt('team.acts.more', 'More actions');
      const own = rowButtons(deleted, c).map((b) => inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: b.label, title: b.title, tabIndex: -1,
        dataset: { 'team-msg-action': b.action }, trustedHtml: b.icon })).join('');
      const html = '<div class="team-acts" role="toolbar" aria-label="' + escapeHtml(jt('team.acts.label', 'Message actions')) + '">' + react + own
        + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: label, title: label, ariaHaspopup: 'menu', tabIndex: -1,
          dataset: { 'team-msg-action': 'more' }, trustedHtml: DOTS }) + '</div>';
      actsMarkup.set(key, html);
      return html;
    }

    function editHtml() {
      return '<div class="team-edit"><textarea class="team-edit__input" rows="2" dir="auto" aria-label="'
        + escapeHtml(jt('team.edit.label', 'Edit message')) + '"></textarea><div class="team-edit__bar">'
        + '<span class="team-edit__hint" role="status">' + escapeHtml(jt('team.edit.hint', 'Enter to save · Esc to cancel')) + '</span>'
        + button(jt('settings.team.cancel', 'Cancel'), 'edit-cancel') + button(jt('team.edit.save', 'Save'), 'edit-save', { variant: 'primary' })
        + '</div></div>';
    }

    function confirmHtml(id) {
      const ask = jt('team.delete.confirm', 'Delete this message?');
      return '<span class="team-confirm" role="group" aria-label="' + escapeHtml(ask) + '">' + escapeHtml(ask)
        + button(jt('team.out.delete', 'Delete'), 'delete-confirm', { variant: 'danger', busy: writes.isBusy('delete:' + id) })
        + button(jt('settings.team.cancel', 'Cancel'), 'delete-cancel') + '</span>';
    }

    // What the timeline draws for a message row: { sig, edit, chips, facts, foot, acts }. `related`: its edit and
    // delete entries; `c`: the pass's context; `extra.seen`: draw "Seen by" (your own latest message in the channel).
    function parts(message, related, c, extra = {}) {
      if (editing && editing.id === message.id) return { sig: 'edit', edit: editHtml(), foot: '', acts: '' };
      const mark = marks.parts(message, c);
      const seen = extra.seen && !message.deleted ? receipts.seenHtml(message, c) : '';
      const foot = related.map((entry) => entryFoot(entry, c)).join('')
        + (confirming === message.id ? confirmHtml(message.id) : '')
        + (notes.has('msg:' + message.id) ? failed(notes.get('msg:' + message.id)) : '') + mark.note;
      return { sig: [foot, mark.sig, seen, c.canWrite, c.isOwner, c.online].join('|'), edit: '', chips: mark.chips, facts: mark.facts + seen, foot, acts: actsHtml(Boolean(message.deleted), c) };
    }

    // A queued or failed post's foot.
    function pendingParts(entry, c) {
      const foot = entryFoot(entry, c);
      return { sig: foot, foot };
    }

    // ------------------------------------------------------------ edit

    // While an edit is open, any other way into an edit or a delete puts the focus back in it.
    function backToEdit() {
      if (!editing) return false;
      const box = rowOf(editing.id) && rowOf(editing.id).querySelector('.team-edit__input');
      if (!box) { editing = null; return false; } // its row is gone, so is the edit
      box.focus();
      return true;
    }

    function openEdit(id) {
      if (backToEdit()) return true;
      const c = ctx();
      const message = messageOf(id);
      if (!canEdit(message, c)) return false;
      confirming = null;
      const names = new Map();
      editing = { id, rev: message.rev, names };
      redraw();
      const box = rowOf(id) && rowOf(id).querySelector('.team-edit__input');
      if (!box) { editing = null; return false; }
      box.value = chatWrites.toDisplay(message.text, c.knownName, names);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      return true;
    }

    function closeEdit({ toComposer = true } = {}) {
      if (!editing) return;
      const id = editing.id;
      editing = null;
      redraw();
      if (toComposer && focusComposer && focusComposer()) return;
      const row = rowOf(id);
      if (row) row.focus();
    }

    async function saveEdit() {
      if (!editing) return;
      const { id, rev, names } = editing;
      const row = rowOf(id);
      const box = row && row.querySelector('.team-edit__input');
      const message = messageOf(id);
      if (!box || !message) return;
      if (!box.value.trim()) return;
      const text = chatWrites.toWire(box.value, names);
      if (text === message.text) { closeEdit({ toComposer: false }); return; }
      const save = row.querySelector('[data-team-msg-action="edit-save"]');
      if (save) save.disabled = true;
      const answer = await writes.edit(channelId, id, text, rev);
      if (answer === null || disposed || !editing || editing.id !== id) return;
      if (save && save.isConnected) save.disabled = false;
      if (answer.ok) { closeEdit({ toComposer: false }); return; }
      const hint = row.querySelector('.team-edit__hint');
      if (hint) hint.textContent = reason(answer);
    }

    // The last message of yours that can be edited (Up in an empty composer).
    function editLast() {
      if (backToEdit()) return true;
      const c = ctx();
      const messages = shown();
      for (let i = messages.length - 1; i >= 0; i -= 1) if (canEdit(messages[i], c)) return openEdit(messages[i].id);
      return false;
    }

    // Opens the message's thread; while an edit is open it goes back to the edit instead.
    function openThread(id) {
      const message = messageOf(id);
      if (backToEdit() || !message || !onReply) return false;
      onReply(message);
      return true;
    }

    // ------------------------------------------------------------ delete, unread, outbox

    function askDelete(id) {
      if (backToEdit() || !canDelete(messageOf(id), ctx())) return;
      confirming = id;
      notes.delete('msg:' + id);
      redraw();
      const cancel = rowOf(id) && rowOf(id).querySelector('[data-team-msg-action="delete-cancel"]');
      if (cancel) cancel.focus();
    }

    function endConfirm(id) {
      confirming = null;
      redraw();
      const row = rowOf(id);
      if (row) row.focus();
    }

    async function confirmDelete(id) {
      const answer = await writes.remove(channelId, id);
      if (answer === null || disposed) return;
      if (answer.ok) { endConfirm(id); return; }
      notes.set('msg:' + id, reason(answer));
      redraw();
    }

    async function markUnread(id) {
      const message = messageOf(id);
      if (!message) return;
      const held = holdRead(true);
      const answer = await chat.markUnread(teamId, channelId, message.seq);
      if (disposed) return;
      if (answer.ok) notes.delete('msg:' + id);
      else {
        holdRead(held); // the channel was not marked unread: it may be marked read again
        notes.set('msg:' + id, jt('team.out.unreadFailed', 'Could not mark this unread. {reason}', { reason: reason(answer) }));
      }
      redraw();
    }

    function entryOf(entryId) { return chat.pending(teamId).find((e) => e.entry_id === entryId) || null; }

    async function outboxAction(action, entryId) {
      const entry = entryOf(entryId);
      if (!entry) return;
      notes.delete('entry:' + entryId);
      const target = entry.message_id ? messageOf(entry.message_id) : null;
      const answer = action === 'retry' ? await writes.retry(entry, target ? target.rev : 1) : await writes.discard(entryId);
      if (answer === null || disposed) return;
      if (!answer.ok) notes.set('entry:' + entryId, reason(answer));
      redraw();
    }

    // ------------------------------------------------------------ copy link

    // The toast over the log this row is in; one at a time, gone after 1.8 s.
    function sayCopied(text) {
      const host = root.closest('.team-thread') || root.closest('.team-main') || root;
      if (copied) { clearTimeout(copied.timer); copied.el.remove(); }
      const el = root.ownerDocument.createElement('div');
      el.className = 'team-copied';
      el.innerHTML = '<div class="inv-toast" role="status" aria-live="polite"><div class="inv-toast__body"><div class="inv-toast__message">'
        + escapeHtml(text) + '</div></div></div>';
      host.appendChild(el);
      const mine = { el, timer: 0 };
      mine.timer = setTimeout(() => { el.remove(); if (copied === mine) copied = null; }, COPIED_MS);
      copied = mine;
    }

    async function copyLink(id) {
      const message = messageOf(id);
      if (!message || message.deleted || !Number.isSafeInteger(message.seq) || ctx().direct) return false;
      const token = links.build({ teamId, channelId, seq: message.seq, messageId: message.id, rootId: message.thread_root_id || null });
      const clipboard = globalThis.window && globalThis.window.jennyShell && globalThis.window.jennyShell.clipboard;
      let ok;
      try { ok = Boolean(clipboard && typeof clipboard.writeText === 'function') && (await clipboard.writeText(token), true); } catch (_error) { ok = false; }
      if (!disposed) sayCopied(ok ? jt('team.link.copied', 'Link copied') : jt('team.link.copyFailed', 'The link could not be copied.'));
      return true;
    }

    // ------------------------------------------------------------ copy with source

    async function copyWithSource(id) {
      const message = messageOf(id);
      if (!message || message.deleted) return false;
      const c = ctx();
      const where = typeof c.channelTitleOf === 'function' ? c.channelTitleOf(message.channel_id || channelId) : c.channelTitle;
      const text = chatWrites.toDisplay(message.text, c.knownName, new Map());
      const quote = buildQuote({ name: c.author(message.author).name, where, date: dayOf(message.created_at), text });
      const clipboard = globalThis.window && globalThis.window.jennyShell && globalThis.window.jennyShell.clipboard;
      let ok;
      try { ok = Boolean(clipboard && typeof clipboard.writeText === 'function') && (await clipboard.writeText(quote), true); } catch (_error) { ok = false; }
      if (!disposed) sayCopied(ok ? jt('team.message.copiedWithSource', 'Copied with source') : jt('team.message.copyFailed', 'The message could not be copied.'));
      return true;
    }

    // ------------------------------------------------------------ menu and keys

    // More's entries for a message: Add reaction and Pin, then Edit, Delete and Mark unread where they apply.
    function moreItems(message, c) {
      const id = message.id;
      const items = [];
      if (!message.deleted) items.push({ label: jt('team.message.copyWithSource', 'Copy with source'), value: 'copy-source', action: () => { void copyWithSource(id); } });
      if (canEdit(message, c)) items.push({ label: jt('team.acts.edit', 'Edit'), value: 'edit', action: () => { openEdit(id); } });
      if (canDelete(message, c)) items.push({ label: jt('team.acts.delete', 'Delete'), value: 'delete', action: () => { askDelete(id); } });
      if (!inThread) items.push({ label: jt('team.acts.unread', 'Mark unread'), value: 'unread', action: () => { void markUnread(id); } });
      const first = marks.menuItems(message);
      if (first.length && items.length) first.push({ separator: true });
      items.unshift(...first);
      return items;
    }

    // More's list from its button; `whole` (a right-click at `point`, the context-menu key, Shift+F10) puts the row's
    // own buttons first, so the menu offers what the action row offers. Closed by a scroll or its row leaving.
    function openMenu(row, { whole = false, point = null } = {}) {
      const menu = menuApi();
      const id = row && row.dataset.messageId;
      const message = id && messageOf(id);
      if (!menu || typeof menu.show !== 'function' || !message) return;
      const c = ctx();
      const items = moreItems(message, c);
      if (whole) {
        const own = rowButtons(Boolean(message.deleted), c).map((b) => ({ label: b.label, value: b.action, shortcutHint: b.key, action: () => { runButton(b.action, id); } }));
        if (own.length && items.length) own.push({ separator: true });
        items.unshift(...own);
      }
      if (!items.length) return;
      const more = row.querySelector('[data-team-msg-action="more"]');
      const anchor = more || row;
      const doc = row.ownerDocument;
      const close = () => { if (menuOpen) menu.hide(); };
      const gone = new (doc.defaultView.MutationObserver)(() => { if (!row.isConnected) close(); });
      gone.observe(root, { childList: true, subtree: true });
      root.addEventListener('scroll', close, true);
      menuOpen = true;
      anchor.setAttribute('aria-expanded', 'true');
      menu.show({ ...(point ? { anchorX: point.x, anchorY: point.y } : { anchorEl: anchor }), rootEl: anchor, restoreFocusTo: row, className: 'team-msg-menu',
        ariaLabel: jt('team.acts.label', 'Message actions'), items,
        onHide: () => { menuOpen = false; gone.disconnect(); root.removeEventListener('scroll', close, true); if (anchor.isConnected) anchor.setAttribute('aria-expanded', 'false'); } });
    }

    // A right-click on a message: the message menu, unless it lands where the default menu is the useful one.
    function onContextMenu(event) {
      const target = event.target;
      const row = target && target.closest ? target.closest('.team-msg[data-message-id]') : null;
      if (!row || !root.contains(row) || event.defaultPrevented) return;
      if (target.closest('a[href], pre, .markdown-code-block, .team-edit, .team-pop, textarea, input, select, [contenteditable="true"]')) return;
      const selection = row.ownerDocument.getSelection && row.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && String(selection).trim()) return;
      event.preventDefault();
      openMenu(row, { whole: true, point: { x: event.clientX, y: event.clientY } });
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-msg-action]') : null;
      if (!target || target.disabled || !root.contains(target)) return;
      const row = target.closest('.team-msg');
      const id = row && row.dataset.messageId;
      switch (target.dataset.teamMsgAction) {
        case 'more': openMenu(row); return;
        case 'reply':
        case 'copy-link': if (id) runButton(target.dataset.teamMsgAction, id); return;
        case 'thread': if (id) openThread(id); return;
        case 'react': if (id) void marks.react(messageOf(id), target.dataset.emoji); return;
        case 'react-pick':
        case 'react-add': if (id) marks.openPicker(messageOf(id), target); return;
        case 'versions': if (id) receipts.openVersions(messageOf(id), target); return;
        case 'seen': if (id) receipts.openSeen(messageOf(id), target); return;
        case 'edit-save': void saveEdit(); return;
        case 'edit-cancel': closeEdit(); return;
        case 'delete-confirm': if (id) void confirmDelete(id); return;
        case 'delete-cancel': if (id) endConfirm(id); return;
        case 'retry':
        case 'discard': void outboxAction(target.dataset.teamMsgAction, target.dataset.entryId); return;
        default:
      }
    }

    function onKeydown(event) {
      const target = event.target;
      if (target && target.classList && target.classList.contains('team-edit__input')) {
        if (chatWrites.isCloseKey(event)) { event.preventDefault(); closeEdit(); return; }
        if (chatWrites.isPlainEnter(event)) { event.preventDefault(); void saveEdit(); }
        return;
      }
      if (event.key === 'Escape') {
        if (!chatWrites.isCloseKey(event) || menuOpen) return;
        if (pops.isOpen()) { event.preventDefault(); pops.close(); return; }
        if (editing) { event.preventDefault(); closeEdit(); } else if (confirming) { event.preventDefault(); endConfirm(confirming); }
        return;
      }
      const row = target && target.classList && target.classList.contains('team-msg') && target.dataset.messageId ? target : null;
      if (!row || menuOpen || isTextField(target) || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); openMenu(row, { whole: true }); return; }
      if (event.shiftKey) return;
      if (event.key === 'e' || event.key === 'E') { if (openEdit(row.dataset.messageId)) event.preventDefault(); return; }
      if (event.key === 'r' || event.key === 'R') { if (openThread(row.dataset.messageId)) event.preventDefault(); return; }
      if (event.key === 'l' || event.key === 'L') { const message = messageOf(row.dataset.messageId); if (message && !message.deleted) { event.preventDefault(); void copyLink(message.id); } return; }
      if (event.key === 'p' || event.key === 'P') { const message = messageOf(row.dataset.messageId); if (message && !message.deleted) { event.preventDefault(); void marks.pin(message); } return; }
      if (event.key === 'Delete') { event.preventDefault(); askDelete(row.dataset.messageId); }
    }

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('contextmenu', onContextMenu);

    return {
      parts,
      pendingParts,
      editLast,
      backToEdit,
      dispose() {
        disposed = true;
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        root.removeEventListener('contextmenu', onContextMenu);
        if (menuOpen) { const menu = menuApi(); if (menu && typeof menu.hide === 'function') menu.hide({ restoreFocus: false }); }
        if (copied) { clearTimeout(copied.timer); copied.el.remove(); copied = null; }
        marks.dispose();
        receipts.dispose();
        if (!pop) pops.dispose();
        notes.clear();
      },
    };
  }

  return { createActions, buildQuote };
});
