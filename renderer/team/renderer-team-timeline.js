/* The team chat timeline (row 123, slices 2a-5a to 2a-6a). One instance per
 * shown channel, inside the timeline region the Team tab creates once for that
 * channel. It patches by key and never rebuilds: a message row is updated in
 * place only when its revision, run, author name or foot changes, and its
 * Markdown is rendered once per (message id, text and edit time). Existing rows are never
 * moved, so a push keeps the reader's scroll position, text selection and
 * focus.
 *
 * - At the bottom it follows new messages; scrolled up it holds its place and
 *   offers "Jump to latest". Reaching the top loads an older page and keeps
 *   the first visible row where it was.
 * - At most 400 message rows: at the bottom the oldest are dropped; loading
 *   older pages, or new messages while scrolled up, past 400 drops the
 *   newest, and "Jump to latest" reads them. Disposing stops the store holding
 *   the channel.
 * - A window without the newest (a jump, or the newest dropped) shows "Jump
 *   to latest" the whole time; reaching the bottom loads the next newer page
 *   (the reader keeps their place), and a page that adds no row (thread
 *   replies only) is followed by the next while the log stays at the bottom,
 *   until the newest; meanwhile nothing is marked read and pushed messages
 *   are not drawn.
 * - Read state: `chatMarkRead` with the last message shown, only while the
 *   log is laid out (shown on screen), the window has focus, the bottom is
 *   reached and the newest are held. The mark is the channel's `last_seq`
 *   when that is higher: a reply in a followed thread has a channel seq past
 *   the last timeline row and would stay unread forever. The store paces what
 *   is sent.
 * - `setNote` shows one quiet line at the end (a closed thread the host no
 *   longer has). The action row's Reply in thread and the replies button call
 *   `onReply`.
 * - A failed open or overview is asked again only by its Try again button.
 * - Queued and failed posts of this channel are dimmed rows at the end. A post
 *   is drawn once: a settled one by its message id, and a queued one whose
 *   message arrived before the outbox said so by your own message with the
 *   same text, created no earlier than a minute before it was queued. Its
 *   mentions come from the tokens in its own text, so it reads as it will.
 * - Slice 2b-2: a message's chips and pin mark come with its row parts, "Seen by" only for your own latest live
 *   message, and the Markdown is rendered once per (text, edited_at), not per revision, so a reaction does not
 *   render it again. The header's pinned list (renderer-team-pins.js) and the popovers share one popover host.
 * - Row 173: a channel's change records (made, renamed, topic, archived, brought back) are quiet lines after the message each
 *   followed (renderer-team-channel-menu.js `placeChanges`), drawn once the window shows where they go.
 * - The message actions (renderer-team-message-actions.js) draw the action
 *   row, the edit box and the foot's outbox words; after Mark unread the
 *   channel is not marked read again until it is opened again (unless the
 *   Mark unread call failed). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-message-row'), require('./renderer-team-message-actions'), require('./renderer-team-chat-writes'),
      require('./renderer-team-pop'), require('./renderer-team-pins'), require('./renderer-team-files'), require('./renderer-team-channel-menu'));
    return;
  }
  root.rendererTeamTimeline = factory(root.rendererTeamMessageRow, root.rendererTeamMessageActions, root.rendererTeamChatWrites,
    root.rendererTeamPop, root.rendererTeamPins, root.rendererTeamFiles, root.rendererTeamChannelMenu);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (rows, actions, chatWrites, popModule, pinsModule, filesModule, channelMenu) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MAX_ROWS = 400;
  const NEAR_TOP_PX = 80;
  const BOTTOM_SLACK_PX = 24;

  function inv() { return globalThis.inventory || {}; }

  // `ctx()` answers what the tab knows now about this frame's team: { online, me, nameOf(id), author(author), mentionName(id),
  // channelName, soleOwner, chatLoaded, canWrite, isOwner }. `writes` is the shown channel's writes.
  function createTimeline({ root, chat, teamId, channelId, ctx, writes, focusComposer = null, onReply = null, onAfterPatch = null }) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    root.innerHTML = '<div class="team-scroll" role="log" aria-live="off" tabindex="-1"></div>'
      + inv().actionButton({ label: jt('team.chat.jump', 'Jump to latest'), size: 'sm', className: 'team-jump', dataset: { 'team-timeline': 'jump' } });
    const scroll = root.querySelector('.team-scroll');
    const jump = root.querySelector('.team-jump');
    jump.hidden = true;
    const nodes = new Map();
    const bodies = new Map(); // message id or 'out:' + entry id -> { rev, names, html }; one per row shown
    let opened = false;
    let newAfter = null;
    let unseen = 0;
    let drawn = 0; // message rows after the last pass (the store has merged a push before it tells)
    let disposed = false;
    let readHeld = false; // Mark unread: no read mark until the channel is opened again
    let note = '';
    // Slice 2b-2: one popover in the channel's main area for the picker, the versions, "Seen by" and the pinned list.
    const main = root.closest('.team-main') || root;
    const pop = popModule.createPop({ host: main });
    const acts = actions.createActions({ root, chat, teamId, channelId, ctx, writes, focusComposer, onReply, pop,
      redraw: () => update({ type: 'acts' }), holdRead: (on) => { const was = readHeld; readHeld = on; return was; } });
    const pins = pinsModule.createPins({ main, chat, teamId, channelId, ctx, call: writes.call, pop });
    // Slice 2c: a message's pictures and files; a fetched picture or a download's state redraws only its row.
    const files = filesModule.createFiles({ teamId, channelId, scroll, ctx, onChange: () => update({ type: 'files' }) });

    const line = () => chat.timeline(teamId, channelId);
    // A log that is not laid out (the list screen under 720 px) measures 0 and is never "at the bottom".
    const laidOut = () => scroll.clientHeight > 0;
    const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_SLACK_PX;
    const toBottom = () => { scroll.scrollTop = scroll.scrollHeight; };
    const focused = () => !doc.hidden && (typeof doc.hasFocus === 'function' ? doc.hasFocus() : true);

    // `names`: the mentions as resolved now, so a member who joins the list redraws the body.
    function body(key, rev, names, text, mentions) {
      const held = bodies.get(key);
      if (held && held.rev === rev && held.names === names) return held.html;
      const html = rows.bodyHtml(text, mentions, ctx(), doc);
      bodies.set(key, { rev, names, html });
      return html;
    }

    // The posts to draw at the end: not one whose message is shown (by id once settled; before that, a
    // queued post claims one own message with its text, not one settled here and not older than it).
    function pendingEntries(all, list, me) {
      const posts = all.filter((e) => rows.isOpenPost(e) && e.channel_id === channelId && !e.thread_root_id);
      return rows.pendingPosts(posts, list, me, (id) => chat.settledId(teamId, id));
    }

    // The rows the page should hold, in order: { key, kind, sig, html, attrs }.
    function wanted() {
      const c = ctx();
      if (!chat.team(teamId)) return [];
      const current = line();
      const items = [];
      const team = chat.team(teamId);
      const failure = (!team.loaded && team.error) || current.error; // the overview's, else the channel's
      if (failure) {
        items.push({ key: 'error', kind: 'error', sig: 'e' + String(failure.code) + failure.reason, html: '<p>'
          + escapeHtml(jt('team.chat.loadFailed', 'Messages could not be loaded. {reason}', { reason: rows.words.errorText(failure) })) + '</p>'
          + inv().actionButton({ label: jt('team.chat.tryAgain', 'Try again'), size: 'sm', dataset: { 'team-tab-action': 'retry-history' } }) });
      }
      const record = chat.channel(teamId, channelId);
      const floor = Math.max(current.floorSeq || 0, (record && record.floor_seq) || 0);
      if (current.loaded && !current.hasMore && floor > 1 && (!current.list.length || current.list[0].seq >= floor)) {
        items.push({ key: 'pruned', kind: 'pruned', sig: 'p', html: escapeHtml(jt('team.chat.pruned', 'Older messages were removed by the team’s history limit.')) });
      }
      const all = chat.pending(teamId);
      const pending = pendingEntries(all, current.list, c.me);
      const related = rows.relatedEntries(all, channelId);
      // A channel's change records, placed among the messages held; none until the window is loaded.
      const placed = channelMenu.placeChanges(current.loaded && record ? record.changes : [], current.list, { hasMore: current.hasMore, hasNewer: current.hasNewer });
      const lines = (list) => list.map((change, i) => ({ key: 'chg:' + change.kind + ':' + change.at + ':' + change.seq_after + ':' + i, kind: 'chan', html: channelMenu.changeHtml(change, c) }))
        .filter((item) => item.html).map((item) => ({ ...item, sig: item.html }));
      if (current.loaded && !current.list.length && !pending.length) {
        const invite = c.soleOwner && !c.direct ? inv().actionButton({ label: jt('settings.team.invite.heading', 'Invite someone'), variant: 'primary', size: 'sm', dataset: { 'team-tab-action': 'invite' } }) : '';
        items.push({ key: 'empty', kind: 'empty', sig: 'y' + (invite ? 1 : 0) + c.channelTitle, html: '<b>' + escapeHtml(c.channelTitle) + '</b>'
          + escapeHtml(c.direct ? jt('team.dm.empty', 'No messages yet.') : jt('team.chat.empty', 'Everyone on the team can read and post here.')) + invite });
        items.push(...lines(placed.lead));
      }
      let prev = null;
      let day = '';
      let freshPlaced = false;
      // "Seen by" goes under your own latest live message only.
      const seenId = (current.list.slice().reverse().find((m) => rows.isOwnMessage(m, c.me) && !m.deleted) || {}).id;
      // E59: each followed thread's unseen replies, from the channel row (a root's link shows "N new").
      const threadNew = chat.threadCounts(teamId, channelId);
      for (const message of current.list) {
        const key = rows.dayKey(message.created_at);
        if (key && key !== day) { items.push({ key: 'day:' + key, kind: 'day', sig: rows.dayLabel(key), html: escapeHtml(rows.dayLabel(key)) }); day = key; prev = null; }
        if (message === current.list[0] && placed.lead.length) { items.push(...lines(placed.lead)); prev = null; }
        if (newAfter !== null && !freshPlaced && message.seq > newAfter && !rows.isOwnMessage(message, c.me)) {
          items.push({ key: 'new', kind: 'new', sig: 'n', html: escapeHtml(jt('team.chat.new', 'New')) });
          freshPlaced = true;
          prev = null;
        }
        const first = !rows.sameRun(prev, message);
        const author = c.author(message.author);
        const deletedBy = message.deleted ? c.nameOf(message.deleted.by) : '';
        const names = rows.mentionKey(message.mentions, c, message.text);
        const html = message.deleted ? '' : body(message.id, rows.bodyKey(message), names, message.text, message.mentions);
        const part = acts.parts(message, related.get(message.id) || [], c, { seen: message.id === seenId });
        const fresh = threadNew.get(message.id) || 0;
        const block = files.row(message, c); // built again only when its signature changed
        items.push({ key: 'msg:' + message.id, kind: 'msg', message, first, body: html, files: block.html, pending: '', edit: part.edit, chips: part.chips, facts: part.facts, foot: part.foot, acts: part.acts, fresh,
          sig: part.sig === 'edit' ? 'edit' : [message.rev, first, author.name, author.former, deletedBy, message.edited_at, message.reply_count, message.last_reply_at, fresh, names, part.sig, block.sig].join('|') });
        prev = message;
        const after = placed.after.get(message.seq);
        if (after) { items.push(...lines(after)); prev = null; }
      }
      if (note) items.push({ key: 'note', kind: 'note', sig: note, html: escapeHtml(note) });
      for (const entry of pending) {
        const message = { id: entry.entry_id, author: { kind: 'member', member_id: c.me }, created_at: entry.created_at, text: entry.text, edited_at: null, deleted: null, reply_count: 0 };
        const part = acts.pendingParts(entry, c);
        const mentions = chatWrites.tokenIds(entry.text);
        const names = rows.mentionKey(mentions, c, entry.text);
        items.push({ key: 'out:' + entry.entry_id, kind: 'msg', message, first: true, pending: entry.state, foot: part.foot,
          body: body('out:' + entry.entry_id, entry.text, names, entry.text, mentions), sig: [part.sig, c.author(message.author).name, names].join('|') });
      }
      return items;
    }

    function fill(el, item) {
      el.dataset.sig = item.sig;
      if (item.kind !== 'msg') {
        const classes = { day: 'team-day', new: 'team-new', pruned: 'team-pruned', empty: 'team-empty', error: 'team-timeline-error', note: 'team-thread-gone', chan: 'team-chan-event' };
        el.className = classes[item.kind];
        if (item.kind === 'day' || item.kind === 'new') el.setAttribute('role', 'separator');
        el.innerHTML = item.html;
        return;
      }
      el.className = 'team-msg';
      el.tabIndex = el.tabIndex === 0 ? 0 : -1;
      el.dataset.first = String(item.first);
      if (item.pending) { el.dataset.pending = 'true'; el.removeAttribute('data-message-id'); delete el.dataset.seq; } else {
        el.dataset.messageId = item.message.id;
        el.dataset.seq = String(item.message.seq);
        el.removeAttribute('data-pending');
      }
      el.innerHTML = rows.rowInnerHtml(item, ctx());
    }

    // Brings the page to `items` (renderer-team-message-row.js `patchRows`).
    // Every pass: the log's name follows the channel's title (a name resolved later, a rename).
    function patch() {
      const label = jt('team.chat.logLabel', 'Messages in {channel}', { channel: ctx().channelTitle });
      if (scroll.getAttribute('aria-label') !== label) scroll.setAttribute('aria-label', label);
      const items = wanted();
      rows.patchRows(scroll, nodes, items, fill, (key) => bodies.delete(key.startsWith('msg:') ? key.slice(4) : key));
      return items;
    }

    function syncJump() {
      const show = line().hasNewer || (!atBottom() && unseen > 0);
      if (jump.hidden === show) jump.hidden = !show;
    }

    function lastSeq() {
      const list = line().list;
      return list.length ? list[list.length - 1].seq : 0;
    }

    function markRead() {
      if (disposed || readHeld || !line().loaded || line().hasNewer || !focused() || !laidOut() || !atBottom()) return;
      const record = chat.channel(teamId, channelId);
      const seq = Math.max(lastSeq(), (record && record.last_seq) || 0);
      if (seq) void chat.markRead(teamId, channelId, seq);
    }

    function messageCount() { return line().list.length; }

    // A full redraw pass after a store change. `older` and `newer` keep the reader's place; at the bottom it follows
    // while the newest are held.
    function update(change = {}) {
      if (disposed) return;
      if (change.type === 'cleared') { opened = false; newAfter = null; unseen = 0; bodies.clear(); }
      if (change.type === 'timeline' && change.reset && newAfter === null && line().loaded) {
        const record = chat.channel(teamId, channelId);
        if (record && record.unread > 0 && record.last_read_seq < record.last_seq) newAfter = record.last_read_seq;
      }
      const newer = Array.isArray(change.newer);
      const stick = !newer && !line().hasNewer && ((laidOut() && atBottom()) || (change.type === 'timeline' && change.reset));
      const height = scroll.scrollHeight;
      const top = scroll.scrollTop;
      patch();
      if (Array.isArray(change.older) && change.older.length) {
        scroll.scrollTop = top + (scroll.scrollHeight - height);
        if (chat.trim(teamId, channelId, 'newest', MAX_ROWS)) patch();
      } else if (newer) {
        // Past the cap the oldest go; the rows the reader sees stay where they were.
        const [h2, t2] = [scroll.scrollHeight, scroll.scrollTop];
        if (chat.trim(teamId, channelId, 'oldest', MAX_ROWS)) { patch(); scroll.scrollTop = t2 - (h2 - scroll.scrollHeight); }
        if (!change.newer.length && line().hasNewer && !line().error && laidOut() && atBottom()) void chat.loadNewer(teamId, channelId);
      } else if (stick) {
        if (chat.trim(teamId, channelId, 'oldest', MAX_ROWS)) patch();
        toBottom();
        unseen = 0;
      } else {
        // Scrolled up: the place holds; past the cap the newest go (Jump to latest reads them again).
        if (change.type === 'messages' && messageCount() > drawn) unseen += messageCount() - drawn;
        if (chat.trim(teamId, channelId, 'newest', MAX_ROWS)) patch();
      }
      drawn = messageCount();
      if (line().loaded && scroll.getAttribute('aria-live') !== 'polite') scroll.setAttribute('aria-live', 'polite');
      syncJump();
      openIfReady();
      markRead();
      files.scan();
      if (onAfterPatch) onAfterPatch();
    }

    // The channel is opened once the team's chat is in and the team is connected. After a failure it
    // stays "opened": only Try again asks again.
    function openIfReady() {
      const c = ctx();
      if (opened || !c.online || !c.chatLoaded) return;
      opened = true;
      // After this pass: the store tells its readers at once that the channel is loading.
      void Promise.resolve().then(() => (disposed ? null : chat.openChannel(teamId, channelId)));
    }

    function onScroll() {
      if (disposed) return;
      // Not while a failure is shown: its Try again asks.
      if (scroll.scrollTop < NEAR_TOP_PX && line().hasMore && !line().older && !line().error) void chat.loadOlder(teamId, channelId);
      if (laidOut() && atBottom()) {
        unseen = 0;
        if (line().hasNewer) { if (!line().error) void chat.loadNewer(teamId, channelId); } else if (chat.trim(teamId, channelId, 'oldest', MAX_ROWS)) { patch(); toBottom(); }
        markRead();
      }
      syncJump();
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-timeline], [data-team-tab-action="retry-history"]') : null;
      if (!target) return;
      if (target.dataset.teamTabAction === 'retry-history') {
        const team = chat.team(teamId);
        if (team && !team.loaded && team.error) chat.retryOverview(teamId);
        else void chat.openChannel(teamId, channelId);
        return;
      }
      if (line().hasNewer) { void chat.openChannel(teamId, channelId); return; }
      toBottom();
      unseen = 0;
      syncJump();
      markRead();
    }

    // Arrow keys move between messages (one tab stop, a roving index).
    const onKeydown = (event) => rows.moveRowFocus(event, scroll);

    const onFocus = () => markRead();
    scroll.addEventListener('scroll', onScroll);
    root.addEventListener('click', onClick);
    scroll.addEventListener('keydown', onKeydown);
    if (win) win.addEventListener('focus', onFocus);
    update({ type: 'start' });

    return {
      update,
      logRoot: scroll,
      // The element F6 lands on: the message with the tab stop, else the log.
      focusTarget: () => scroll.querySelector('.team-msg[tabindex="0"]') || scroll,
      editLast: () => acts.editLast(),
      backToEdit: () => acts.backToEdit(),
      setNote(text) { note = String(text || ''); update({ type: 'note' }); },
      dispose() {
        disposed = true;
        files.dispose();
        pins.dispose();
        acts.dispose();
        pop.dispose();
        scroll.removeEventListener('scroll', onScroll);
        root.removeEventListener('click', onClick);
        scroll.removeEventListener('keydown', onKeydown);
        if (win) win.removeEventListener('focus', onFocus);
        chat.closeChannel(teamId, channelId);
        nodes.clear();
        bodies.clear();
      },
    };
  }

  return { createTimeline, MAX_ROWS };
});
