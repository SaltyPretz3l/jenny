/* The channel's pinned messages (row 123, slice 2b-2): the header's pin button and the list under it.
 *
 * - `buttonHtml(vm)` is the header's button, always present before search, with `pin_count` as its number (none at
 *   0 or while the count is unknown) and "Pinned messages: {n}" / "Pinned messages: none" as its name. Offline it is
 *   greyed with "Needs the team online".
 * - `createPins` (made by the timeline) opens the list in the shared popover (renderer-team-pop.js) in the channel's
 *   main area, so a redraw of the header does not close it. It asks `chatPins` each time it opens and shows
 *   "Loading…", then the pins newest first (the host sends them oldest first): who, when, three lines, "Pinned by
 *   …", "in a thread" for a reply, and Unpin (greyed with the reason for a read-only member). A row is a message
 *   link (`.team-msglink` with its target), so the tab's one jumper takes the click, jumps with the search tint and
 *   opens a reply's thread; the list closes at once. More pins than listed, an empty list and a failed read say so.
 * - Esc or a press away closes it; Esc returns the focus to the button. Disposing removes it and its timer.
 * Host text is untrusted: names and words through `escapeHtml`; message text as text. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-message-row'), require('./renderer-team-chat-writes'),
      require('./renderer-team-chat-store'), require('./renderer-team-marks'));
    return;
  }
  root.rendererTeamPins = factory(root.rendererSettingsTeamStrings, root.rendererTeamMessageRow, root.rendererTeamChatWrites, root.rendererTeamChatStore, root.rendererTeamMarks);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, rows, chatWrites, chatStore, marksModule) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const PIN = rows.PIN_ICON;
  const CLOSE = rows.CLOSE_ICON;
  const NO_ANSWER = rows.NO_ANSWER;
  const KEY = 'pins';

  function inv() { return globalThis.inventory || {}; }

  // The header's pin button for a view model (a team and its shown channel).
  function buttonHtml(vm) {
    const team = vm.team;
    const record = team && team.team_id ? chatStore.getChatStore().channel(team.team_id, vm.channelId) : null;
    const count = record && Number.isSafeInteger(record.pin_count) && record.pin_count > 0 ? record.pin_count : 0;
    const online = Boolean(team) && team.state === 'online';
    const base = count ? jt('team.pin.buttonCount', 'Pinned messages: {count}', { count }) : jt('team.pin.buttonNone', 'Pinned messages: none');
    const label = online ? base : base + ' ' + jt('team.export.needsOnline', 'Needs the team online');
    return inv().actionButton({ plain: true, className: 'team-icon-btn', domId: 'teamPinsButton', ariaLabel: label, ariaHaspopup: 'dialog', disabled: !online,
      title: online ? jt('team.pin.button', 'Pinned messages') : label, dataset: { 'team-pins': 'open' },
      trustedHtml: PIN + (count ? '<span class="team-pins__n">' + count + '</span>' : '') });
  }

  // `main`: the channel's main area (the popover's host and the header's); `call(method, payload)`: the bounded bridge call.
  function createPins({ main, chat, teamId, channelId, ctx, call, pop }) {
    let state = { phase: 'loading' };
    let turn = 0;
    let timer = null;
    let disposed = false;
    const notes = new Map(); // message id -> the words of a refused unpin

    const button = () => main.querySelector('[data-team-pins]');
    const blockOf = () => marksModule.blockWords(ctx(), 'pin');

    // Arrows, Home and End walk the rows; Enter on a row jumps (the tab's jumper takes the click). Close and Unpin stay on Tab.
    function keys(event, el) {
      const links = [...el.querySelectorAll('.team-msglink')];
      if (event.key === 'Enter' && links.includes(event.target)) { event.preventDefault(); event.target.click(); return; }
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!links.length || (!step && event.key !== 'Home' && event.key !== 'End')) return;
      event.preventDefault();
      const at = links.indexOf(el.ownerDocument.activeElement);
      let next;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = links.length - 1;
      else next = at < 0 ? (step > 0 ? 0 : links.length - 1) : Math.max(0, Math.min(links.length - 1, at + step));
      links[next].focus();
    }

    function rowHtml(message, c, block) {
      const when = [rows.dayLabel(rows.dayKey(message.created_at)), rows.timeText(message.created_at)].filter(Boolean).join(' ');
      const by = message.pinned && message.pinned.by === c.me ? jt('team.pin.byYou', 'Pinned by you')
        : jt('team.pin.by', 'Pinned by {name}', { name: c.nameOf(message.pinned && message.pinned.by) });
      const note = notes.get(message.id) || block;
      const link = { 'link-channel': channelId, 'link-message': message.id, 'link-seq': String(message.seq), ...(message.thread_root_id ? { 'link-root': message.thread_root_id } : {}) };
      return '<div class="team-pin">' + inv().actionButton({ plain: true, className: 'team-row--link team-result team-msglink', tabIndex: -1, title: jt('team.link.go', 'Go to this message'),
        dataset: link, trustedHtml: '<span class="team-result__top"><span class="team-result__who" dir="auto">' + escapeHtml(c.author(message.author).name) + '</span>'
          + '<time class="team-result__when">' + escapeHtml(when) + '</time>'
          + (message.thread_root_id ? '<span class="team-pin__thread">' + escapeHtml(jt('team.search.inThread', 'in a thread')) + '</span>' : '') + '</span>'
          + '<span class="team-result__text" dir="auto">' + escapeHtml(chatWrites.toDisplay(message.text, c.knownName, new Map())) + '</span>'
          + '<span class="team-pin__by">' + escapeHtml(by) + '</span>' + (note ? '<span class="team-pin__why">' + escapeHtml(note) + '</span>' : '') })
        + inv().actionButton({ label: jt('team.pin.unpin', 'Unpin'), size: 'sm', variant: 'ghost', className: 'team-foot-btn', disabled: Boolean(block),
          title: block || jt('team.pin.unpin', 'Unpin'), dataset: { 'team-pins-action': 'unpin', 'message-id': message.id } }) + '</div>';
    }

    function headingText() {
      const c = ctx();
      return c.direct ? jt('team.pin.headingDirect', 'Pinned in this conversation') : jt('team.pin.heading', 'Pinned in {channel}', { channel: '#' + c.channelName });
    }

    function listHtml() {
      const c = ctx();
      const close = jt('team.dm.close', 'Close (Esc)');
      let body;
      if (state.phase === 'loading') body = '<p class="team-pop__note">' + escapeHtml(jt('team.pin.loading', 'Loading pinned messages…')) + '</p>';
      else if (state.phase === 'failed') {
        body = '<p class="team-pop__note" data-tone="danger">' + escapeHtml(jt('team.pin.failed', 'The pinned messages could not be loaded. {reason}', { reason: words.errorText(state.error) })) + '</p>'
          + '<p class="team-pop__note">' + inv().actionButton({ label: jt('team.chat.tryAgain', 'Try again'), size: 'sm', dataset: { 'team-pins-action': 'retry' } }) + '</p>';
      } else if (!state.pins.length) {
        body = '<p class="team-pop__note">' + escapeHtml(jt('team.pin.empty', 'Nothing is pinned here yet. Pin a message from its More menu to keep it at hand for everyone.')) + '</p>';
      } else {
        const record = chat.channel(teamId, channelId);
        const total = Math.max(state.pins.length, record && Number.isSafeInteger(record.pin_count) ? record.pin_count : 0);
        const cut = state.trimmed || state.pins.length < total;
        const block = blockOf();
        body = state.pins.slice().reverse().map((message) => rowHtml(message, c, block)).join('')
          + (cut ? '<p class="team-pop__note team-pop__note--end">' + escapeHtml(jt('team.pin.trimmed', 'Showing {shown} of {total} pinned messages. The rest are too long to list together. They are still pinned.', { shown: state.pins.length, total })) + '</p>' : '');
      }
      return '<h3 class="team-pop__head">' + escapeHtml(headingText()) + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: close, title: close,
        dataset: { 'team-pins-action': 'close' }, trustedHtml: CLOSE }) + '</h3>' + body;
    }

    async function load() {
      const mine = ++turn;
      state = { phase: 'loading' };
      pop.set(listHtml());
      const answer = await call('chatPins', { channel_id: channelId });
      if (disposed || mine !== turn || !pop.isOpen(KEY)) return;
      state = answer && answer.ok && Array.isArray(answer.pins)
        ? { phase: 'ok', pins: answer.pins.filter((m) => m && typeof m.id === 'string' && m.pinned), trimmed: answer.trimmed === true }
        : { phase: 'failed', error: (answer && answer.error) || NO_ANSWER };
      pop.set(listHtml());
    }

    async function unpin(id) {
      const block = blockOf();
      if (block) return;
      const answer = await call('chatPin', { channel_id: channelId, message_id: id, on: false });
      if (disposed || !pop.isOpen(KEY) || state.phase !== 'ok') return;
      if (answer && answer.ok) { state.pins = state.pins.filter((m) => m.id !== id); notes.delete(id); } else {
        notes.set(id, jt('team.pin.notUnpinned', 'Not unpinned. {reason}', { reason: words.markErrorText((answer && answer.error) || NO_ANSWER, 'pin') }));
      }
      pop.set(listHtml());
    }

    function open() {
      const anchor = button();
      notes.clear();
      const el = pop.open({ key: KEY, className: 'team-pop--pins', label: headingText(), html: listHtml(), anchor: null, keep: button, onKeydown: keys,
        restore: () => { const b = button(); if (b) b.focus(); } });
      if (!el) return;
      el.addEventListener('click', (event) => {
        const target = event.target.closest && event.target.closest('[data-team-pins-action], .team-result');
        if (!target) return;
        const action = target.dataset.teamPinsAction;
        if (action === 'close') pop.close();
        else if (action === 'retry') void load();
        else if (action === 'unpin') void unpin(target.dataset.messageId);
        else if (!action) {
          // The tab's jumper takes this same click (it is a message link); the list goes after it has.
          el.hidden = true;
          clearTimeout(timer);
          timer = setTimeout(() => { timer = null; pop.close({ restore: false }); }, 0);
        }
      });
      const first = el.querySelector('button:not([disabled])');
      if (first && anchor) first.focus();
      void load();
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-pins]') : null;
      if (!target || target.disabled || !main.contains(target)) return;
      if (pop.isOpen(KEY)) pop.close(); else open();
    }

    main.addEventListener('click', onClick);
    return {
      dispose() {
        disposed = true;
        clearTimeout(timer);
        main.removeEventListener('click', onClick);
        if (pop.isOpen(KEY)) pop.close({ restore: false });
      },
    };
  }

  return { buttonHtml, createPins };
});
