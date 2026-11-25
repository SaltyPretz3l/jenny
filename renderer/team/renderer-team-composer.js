/* The team channel's composer (row 123, slices 2a-5b and 2a-6a): one per shown
 * channel, inside the composer region the Team tab creates once for that
 * channel and never replaces, so a push never touches the text, the caret or
 * the focus. A thread column has its own, with `threadRootId`: it posts,
 * keeps its draft and sends typing for that thread, reads "Reply in thread",
 * and Up edits your last reply there.
 *
 * - A text area CSS sizes to its text (`dir="auto"`), Mention (the team's people and
 *   @channel; no @Jenny), Code block, a hint and Send. Enter sends, Shift+Enter
 *   is a new line, Enter during IME composition does nothing, and blank text
 *   is not sent. Up in an empty composer edits your last message.
 * - The hint: "Markdown · Enter to send", "Sends when reconnected" while
 *   reconnecting, "Sends when the host is back" while the host is offline.
 *   The composer stays usable in both: posts queue in the outbox. A refusal
 *   (too large, the draft limit) is said in the hint by its words and the
 *   text stays.
 * - Drafts: read once when the channel opens (an answer that comes after
 *   typing is ignored); saved 500 ms after the last input, one call in flight
 *   with the latest text after it, and once on leaving (not when the team
 *   locked). Leaving write mode (the role changed) keeps the text for a save
 *   still owed; coming back reads the draft again as a fresh composer does.
 *   An empty composer clears the draft.
 * - Your own typing goes out at most once every 3 s per channel, never for an
 *   empty composer. The typing line above the composer has a fixed height
 *   and shows who is typing, never you.
 * - A read-only member sees one sentence naming the owner instead (and saying they can download files).
 * - Row 173: in an archived channel nobody can post, so the composer is one line saying so with an Unarchive button (greyed
 *   with its reason for anyone but the owner). It follows the channel's row: archiving or unarchiving swaps it in place.
 * - Files (slice 2c renderer): renderer-team-attach.js owns the paperclip, paste, the drop, the chips and why Send
 *   is greyed; here the hint and Send's tooltip say that reason, Enter does nothing while it applies, and a post
 *   carries the files' ids in chip order. A message with files is never queued: offline it waits greyed.
 * - The mention list opens from its button or when an `@` that starts a word is typed; typing on filters it by the start of a
 *   name (any word of it), a pick replaces what was typed, and a space, no match or Esc closes it. In a direct conversation it
 *   lists only that conversation's other people, never @channel. A press on it keeps the focus in the text area (its default
 *   is prevented, so no blur follows), and Esc closes it from anywhere in the composer.
 * Names are text: escaped in markup, set through textContent elsewhere, and a
 * picked name is inserted as text, never as markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-store'), require('./renderer-team-chat-writes'), require('./renderer-team-attach'), require('./renderer-team-channel-menu'));
    return;
  }
  root.rendererTeamComposer = factory(root.rendererTeamChatStore, root.rendererTeamChatWrites, root.rendererTeamAttach, root.rendererTeamChannelMenu);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatStore, chatWrites, attachModule, channelMenu) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const DRAFT_PAUSE_MS = 500;
  const TYPING_EVERY_MS = 3_000;
  const AT = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6"/><path d="M10.6 8v1.1a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8"/></svg>';
  const CODE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/></svg>';
  const lastTyping = new Map(); // team|channel -> when your typing last went out (kept across composers)
  let seq = 0;

  function inv() { return globalThis.inventory || {}; }

  function typingText(names) {
    const shown = names.map((name) => chatStore.isolate(name));
    if (!shown.length) return '';
    if (shown.length === 1) return jt('team.typing.one', '{name} is typing', { name: shown[0] });
    if (shown.length === 2) return jt('team.typing.two', '{first} and {second} are typing', { first: shown[0], second: shown[1] });
    return jt('team.typing.many', 'Several people are typing');
  }

  // `ctx()` is the tab's context for this frame's team: { state, me, canWrite, ownerName,
  // people: [{ member_id, display_name }], nameOf(id), knownName(id), locked, channelName }.
  function createComposer({ root, chat, teamId, channelId, ctx, writes, onEditLast, threadRootId = null }) {
    const id = 'teamComposer' + (seq += 1);
    let mode = '';
    let input = null;
    let error = '';
    let disposed = false;
    let touched = false;
    const where = threadRootId ? { channel_id: channelId, thread_root_id: threadRootId } : { channel_id: channelId };
    let names = new Map();
    const draft = { saved: null, timer: null, busy: false, again: false, final: null };
    let menu = { open: false, index: 0, options: [], at: null }; // `at`: the typed `@query` a pick replaces ({ start, end }), null from the button
    const attach = attachModule.createAttach({ root, teamId, channelId, threadRootId, ctx, onChange: () => refresh() });

    const q = (selector) => root.querySelector(selector);
    // The text a draft save sends: the composer's, or once it is gone (write mode left, disposed) the text
    // kept then; null sends nothing.
    const wire = () => (mode === 'write' && !disposed && input ? chatWrites.toWire(input.value, names) : draft.final);

    // ------------------------------------------------------------ markup

    function writeHtml(c) {
      const label = threadRootId ? jt('team.composer.threadLabel', 'Reply in thread')
        : c.direct ? jt('team.dm.composerLabel', 'Message {names}', { names: c.channelTitle }) : jt('team.composer.label', 'Message #{channel}', { channel: c.channelName });
      const mention = jt('team.composer.mention', 'Mention someone');
      const code = jt('team.composer.code', 'Code block');
      return '<div class="team-typing" aria-live="polite"></div><div class="team-composer">' + attach.trayHtml()
        + '<textarea class="team-composer__input" rows="1" dir="auto" aria-label="' + escapeHtml(label) + '" placeholder="' + escapeHtml(label)
        + '" aria-autocomplete="list" aria-controls="' + id + '-list"></textarea>'
        + '<div class="team-menu team-menu--mention" id="' + id + '-list" role="listbox" aria-label="' + escapeHtml(jt('team.composer.mentionList', 'People to mention')) + '" hidden></div>'
        + '<div class="team-composer__bar">'
        + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: mention, title: mention, ariaHaspopup: 'listbox', ariaExpanded: false, dataset: { 'team-composer': 'mention' }, trustedHtml: AT })
        + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: code, title: code, dataset: { 'team-composer': 'code' }, trustedHtml: CODE })
        + attach.buttonHtml(c)
        + '<span class="team-composer__hint" role="status"></span>'
        + inv().actionButton({ label: jt('team.composer.send', 'Send'), variant: 'primary', size: 'sm', dataset: { 'team-composer': 'send' } })
        + '</div></div>';
    }

    function readText(c) {
      return c.ownerName
        ? jt('team.composer.readOnlyFiles', 'You can read this team’s channels and download its files. Ask {owner} for write access to post or attach files.', { owner: chatStore.isolate(c.ownerName) })
        : jt('team.composer.readOnlyFilesNoOwner', 'You can read this team’s channels and download its files. Ask the owner for write access to post or attach files.');
    }
    function readHtml(c) {
      return '<div class="team-typing" aria-live="polite"></div><p class="team-composer team-composer--closed">' + escapeHtml(readText(c)) + '</p>';
    }

    const archivedText = (c) => jt('team.channels.composer.archived', '#{channel} is archived. Its messages stay readable; nobody can post in it.', { channel: c.channelName });
    function archivedHtml(c) {
      return '<div class="team-typing" aria-live="polite"></div><div class="team-composer team-composer--closed"><div class="team-closed__row"><span class="team-closed__text" dir="auto">'
        + escapeHtml(archivedText(c)) + '</span>' + inv().actionButton({ label: jt('team.channels.composer.unarchive', 'Unarchive'), size: 'sm', dataset: { 'chan-composer': 'unarchive' },
          disabled: Boolean(c.unarchiveWhy), title: c.unarchiveWhy || '' }) + '</div><p class="team-closed__error team-set-note" role="alert" hidden></p></div>';
    }
    // Unarchive: the row's push swaps this line for the composer; a refusal is said under the line.
    async function unarchive() {
      const answer = await chat.manageChannel('chatChannelArchive', { team_id: teamId, channel_id: channelId, on: false });
      const note = disposed ? null : q('.team-closed__error');
      if (note) { note.textContent = answer.ok ? '' : channelMenu.failText(answer); note.hidden = Boolean(answer.ok); }
    }

    // ------------------------------------------------------------ state lines

    function hintText(c) {
      if (error) return error;
      if (c.state === 'offline') return jt('team.composer.hintOffline', 'Sends when the host is back');
      if (c.state === 'reconnecting' || c.state === 'connecting') return jt('team.composer.hintReconnecting', 'Sends when reconnected');
      return jt('team.composer.hint', 'Markdown · Enter to send');
    }
    function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
    function refresh() {
      const c = ctx();
      if (mode === 'archived') {
        setText(q('.team-closed__text'), archivedText(c));
        const button = q('[data-chan-composer="unarchive"]');
        if (button) { button.disabled = Boolean(c.unarchiveWhy); button.title = c.unarchiveWhy || ''; }
      } else if (mode === 'read') setText(q('.team-composer--closed'), readText(c));
      else {
        const reason = blocked();
        const hint = q('.team-composer__hint');
        setText(hint, error || reason || hintText(c));
        if (hint) { if (reason && !error) hint.dataset.tone = 'blocked'; else delete hint.dataset.tone; }
        const button = q('[data-team-composer="send"]');
        if (button) {
          // Nothing to send greys Send with its reason, as the desktop composer does; a files reason comes first.
          const why = reason || (input.value.trim() ? '' : jt('team.composer.sendEmpty', 'Type a message first.'));
          button.disabled = Boolean(why);
          button.title = why ? jt('team.attach.sendTitle', 'Send. {reason}', { reason: why }) : jt('team.composer.sendTitle', 'Send (Enter)');
        }
        attach.refresh();
      }
      setText(q('.team-typing'), typingText(chat.typing(teamId, channelId, threadRootId).filter((who) => who !== c.me).map((who) => c.nameOf(who))));
    }

    // ------------------------------------------------------------ drafts

    function loadDraft() {
      void writes.call('chatDraftGet', where).then((answer) => {
        if (disposed || mode !== 'write' || !answer || !answer.ok || typeof answer.text !== 'string') return;
        if (touched) return; // typed text wins over a late answer
        draft.saved = answer.text;
        if (answer.text) { input.value = chatWrites.toDisplay(answer.text, ctx().knownName, names); refresh(); }
      });
    }
    function scheduleDraft() {
      clearTimeout(draft.timer);
      draft.timer = setTimeout(saveDraft, DRAFT_PAUSE_MS);
    }
    async function saveDraft() {
      clearTimeout(draft.timer);
      draft.timer = null;
      if (draft.busy) { draft.again = true; return; }
      const text = wire();
      if (text === null || text === draft.saved || (draft.saved === null && !text)) return;
      draft.busy = true;
      const answer = await writes.call('chatDraftSet', { ...where, text });
      draft.busy = false;
      if (answer && answer.ok) draft.saved = text;
      else if (!disposed) { error = chatWrites.failText(answer); refresh(); }
      if (draft.again) { draft.again = false; void saveDraft(); }
    }

    // ------------------------------------------------------------ sending

    function typingOut() {
      if (!input.value.trim()) return;
      const key = teamId + '|' + channelId + '|' + (threadRootId || '');
      const now = Date.now();
      if (lastTyping.has(key) && now - lastTyping.get(key) < TYPING_EVERY_MS) return;
      lastTyping.set(key, now);
      void writes.call('chatTyping', where);
    }

    // Why Send is greyed now, or '' (renderer-team-attach.js `blockReason`).
    function blocked() { return mode === 'write' && input ? attach.blockReason(Boolean(input.value.trim())) : ''; }

    async function send() {
      const raw = input.value;
      if (!raw.trim() || blocked()) return;
      const ids = attach.ids();
      const answer = await writes.post(channelId, chatWrites.toWire(raw, names), threadRootId, ids);
      if (answer === null || disposed) return;
      if (answer.ok) {
        if (input.value === raw) { input.value = ''; names = new Map(); }
        if (ids.length) attach.clearSent(ids); // a file added while the post was out stays
        error = '';
        void saveDraft();
      } else {
        // A file the host no longer has (staged an hour ago, or a host restart): its chip says so and offers Retry.
        const expired = ids.length && answer.error && answer.error.reason === 'team_chat_not_found' && attach.markExpired();
        error = expired ? '' : chatWrites.failText(answer);
      }
      refresh();
    }

    function insert(text, caretBack = 0) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.setRangeText(text, start, end, 'end');
      if (caretBack) input.setSelectionRange(input.selectionEnd - caretBack, input.selectionEnd - caretBack);
      input.focus();
      onInput();
    }

    function codeBlock() {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const picked = input.value.slice(start, end);
      const lead = start > 0 && input.value[start - 1] !== '\n' ? '\n' : '';
      insert(lead + '```\n' + picked + '\n```\n', picked ? 0 : 5);
    }

    // ------------------------------------------------------------ mention list

    // The people a mention may name: in a direct conversation its other participants and no @channel; else the team and @channel.
    // `query`: what was typed after the `@`; a name matches when any word of it starts with it.
    function mentionOptions(query = '') {
      const c = ctx();
      const direct = c.direct ? new Set(c.othersOf(channelId) || []) : null;
      const people = c.people.filter((m) => m.member_id !== c.me && (!direct || direct.has(m.member_id)))
        .map((m) => ({ id: m.member_id, name: m.display_name, shown: '@' + m.display_name, note: '' }));
      const options = direct ? people : people.concat({ id: 'channel', name: '@channel', shown: '@channel', note: jt('team.composer.channelNote', 'everyone here') });
      const typed = query.toLowerCase();
      return typed ? options.filter((o) => o.name.replace(/^@/, '').toLowerCase().split(/\s+/).some((word) => word.startsWith(typed))) : options;
    }
    function drawMenu() {
      const list = q('.team-menu--mention');
      list.innerHTML = menu.options.map((o, i) => '<div class="team-row team-row--link" role="option" id="' + id + '-opt' + i + '" aria-selected="' + (i === menu.index) + '">'
        + '<span class="team-row__name" dir="auto">' + escapeHtml(o.name) + '</span>' + (o.note ? '<span class="team-row__note">' + escapeHtml(o.note) + '</span>' : '') + '</div>').join('');
      input.setAttribute('aria-activedescendant', id + '-opt' + menu.index);
    }
    function openMentions(at = null, options = mentionOptions()) {
      menu = { open: true, index: 0, options, at };
      drawMenu();
      q('.team-menu--mention').hidden = false;
      q('[data-team-composer="mention"]').setAttribute('aria-expanded', 'true');
      input.focus();
    }
    function closeMentions() {
      if (!menu.open) return;
      menu.open = false;
      q('.team-menu--mention').hidden = true;
      q('[data-team-composer="mention"]').setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function pickMention(index) {
      const option = menu.options[index];
      const at = menu.at;
      closeMentions();
      if (!option) return;
      names.set(option.shown, '<@' + option.id + '>');
      if (at) input.setSelectionRange(at.start, at.end); // the typed @query is what the name replaces
      insert(option.shown + ' ');
    }
    // An `@` that starts a word, just before the caret: the list follows what is typed after it.
    function syncMentions() {
      const caret = input.selectionStart ?? input.value.length;
      const typed = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
      if (!typed) { if (menu.open && menu.at) closeMentions(); return; }
      const options = mentionOptions(typed[2]);
      if (!options.length) { closeMentions(); return; }
      const at = { start: caret - typed[2].length - 1, end: caret };
      if (menu.open) { menu = { open: true, index: Math.min(menu.index, options.length - 1), options, at }; drawMenu(); } else openMentions(at, options);
    }

    // ------------------------------------------------------------ events

    function onInput() {
      touched = true;
      if (error) error = '';
      typingOut();
      scheduleDraft();
      refresh();
      syncMentions();
    }

    function onKeydown(event) {
      if (menu.open && chatWrites.isCloseKey(event)) { event.preventDefault(); closeMentions(); return; }
      if (event.target !== input) return;
      if (menu.open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          menu.index = (menu.index + (event.key === 'ArrowDown' ? 1 : -1) + menu.options.length) % menu.options.length;
          drawMenu();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickMention(menu.index); return; }
      }
      if (chatWrites.isPlainEnter(event)) {
        event.preventDefault();
        void send();
        return;
      }
      if (event.key === 'ArrowUp' && !input.value && !event.shiftKey && onEditLast) {
        if (onEditLast()) event.preventDefault();
      }
    }

    function onClick(event) {
      const option = event.target.closest && event.target.closest('[role="option"]');
      if (option && menu.open) { pickMention(Number(option.id.slice((id + '-opt').length))); return; }
      const control = event.target.closest && event.target.closest('[data-team-composer], [data-chan-composer]');
      if (!control || control.disabled) return;
      if (control.dataset.chanComposer === 'unarchive') { void unarchive(); return; }
      if (attach.onClick(control)) return;
      const action = control.dataset.teamComposer;
      if (action === 'send') void send();
      else if (action === 'code') codeBlock();
      else if (action === 'mention') { if (menu.open) closeMentions(); else openMentions(); }
    }

    // A press on the list would blur the text area and close the list before its click lands.
    function onMouseDown(event) {
      if (event.target.closest && event.target.closest('.team-menu--mention')) event.preventDefault();
    }
    function onFocusOut(event) {
      if (menu.open && !root.contains(event.relatedTarget)) closeMentions();
    }
    function onPaste(event) { if (mode === 'write') attach.onPaste(event); }

    // ------------------------------------------------------------ lifecycle

    function build() {
      const c = ctx();
      const next = c.archived ? 'archived' : c.canWrite ? 'write' : 'read';
      if (next === mode) { refresh(); return; }
      if (mode === 'write') { draft.final = chatWrites.toWire(input.value, names); void saveDraft(); attach.unmount(); }
      mode = next;
      root.innerHTML = next === 'write' ? writeHtml(c) : next === 'archived' ? archivedHtml(c) : readHtml(c);
      input = q('.team-composer__input');
      if (input) attach.mount();
      touched = false; // a composer entering write mode reads its draft as a fresh one does
      if (input) loadDraft();
      refresh();
    }

    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('click', onClick);
    root.addEventListener('mousedown', onMouseDown);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('paste', onPaste);
    build();

    return {
      update: build,
      // The text area F6 and Esc land on (none for a read-only member).
      focusTarget: () => input,
      focus() { if (!input) return false; input.focus(); return true; },
      dispose() {
        if (disposed) return;
        disposed = true;
        root.removeEventListener('input', onInput);
        root.removeEventListener('keydown', onKeydown);
        root.removeEventListener('click', onClick);
        root.removeEventListener('mousedown', onMouseDown);
        root.removeEventListener('focusout', onFocusOut);
        root.removeEventListener('paste', onPaste);
        attach.unmount();
        clearTimeout(draft.timer);
        draft.timer = null;
        // Leaving saves the draft once, unless this frame's team locked: then no chat call, not even one owed.
        if (ctx().locked) draft.final = null;
        else if (mode === 'write' && input) { draft.final = chatWrites.toWire(input.value, names); void saveDraft(); }
      },
    };
  }

  return { createComposer };
});
