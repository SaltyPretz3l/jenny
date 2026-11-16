/* The thread column (row 123, slice 2a-6a): one open thread beside the shown
 * channel, `aside.team-thread`, created by the Team tab's frame when a thread
 * opens and removed when it closes; never replaced while that thread shows.
 *
 * - Header: Back (under 720 px only, by CSS; it closes the thread as Close
 *   does), "Thread", the channel name, the follow toggle (drawn only while the
 *   host has said whether you follow; see renderer-team-thread-data.js) and
 *   Close.
 * - One log: the root, a "N replies" rule, the replies oldest first, then the
 *   thread's queued and failed replies by the channel's once-only rule. Rows
 *   are the channel's rows (renderer-team-message-row.js, with the keyed patch
 *   and the arrow keys the timeline uses) and the channel's message actions
 *   with `inThread` (Edit and Delete in More; no Mark unread, no Reply).
 *   Markdown is rendered once per (id, rev). At the bottom it follows new
 *   replies; scrolled up it holds its place.
 * - Then the typing line and the thread's own composer (`threadRootId`).
 * - Esc that nothing inside handled (a menu, an edit, a confirm, the mention
 *   list) and that cancels no text composition closes the thread.
 * - It watches its thread's typing in the chat store while open and follows
 *   the frame's chat changes through `update(change)`, one pass per call: a
 *   typing or presence change redraws the typing line only; a reset or coming
 *   back online reads the thread again (once per call); your own reply
 *   settling (a settled item with this `thread_root_id`) reads once more.
 * - Its own read mark (E59): when the replies are read to the end (the read
 *   finished, no error, the log laid out and at its bottom, the window
 *   focused) and the thread has unseen replies (the channel row lists it, or
 *   for a followed thread the newest reply shown lies past the mark its own
 *   page gave), the newest shown reply's seq goes to `chat.markThreadRead`
 *   (the store paces it). A capped column holds the first 400 replies: the
 *   mark covers those, and the replies past them stay unread. Checked after
 *   each pass (so after a channel-row push as after a reply), on scroll and on
 *   window focus.
 * - `reveal(id, done)` (a jump) waits for the reads to bring that
 *   reply and calls `done(row)`, or `done(null, capped)` once they end
 *   without it (or fail; the error row says why then, and `done` is not called).
 * Host text is untrusted: names and words through `escapeHtml` or text. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-message-row'), require('./renderer-team-message-actions'), require('./renderer-team-chat-writes'),
      require('./renderer-team-composer'), require('./renderer-team-thread-data'), require('./renderer-team-files'));
    return;
  }
  root.rendererTeamThread = factory(root.rendererTeamMessageRow, root.rendererTeamMessageActions, root.rendererTeamChatWrites,
    root.rendererTeamComposer, root.rendererTeamThreadData, root.rendererTeamFiles);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (rows, actions, chatWrites, composers, threadData, filesModule) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5L5 8l4.5 4.5"/></svg>';
  const BELL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3"/></svg>';
  const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const BOTTOM_SLACK_PX = 24;
  const CLASSES = { day: 'team-day', count: 'team-thread__count', capped: 'team-thread__capped', error: 'team-thread__error' };
  const LINE_ONLY = new Set(['typing', 'presence']); // changes that touch the typing line and nothing else here

  function inv() { return globalThis.inventory || {}; }

  // `ctx()` is the frame's context for its team (see renderer-team-tab.js `timelineContext`). `onClose` for
  // Close, Back and Esc; `onGone` when the host no longer has the root.
  function createThreadColumn({ shell, chat, teamId, channelId, rootId, ctx, writes, onClose, onGone, onReply }) {
    const doc = shell.ownerDocument;
    const el = doc.createElement('aside');
    el.className = 'team-thread';
    el.dataset.teamRegion = 'thread';
    el.setAttribute('aria-label', jt('team.thread.label', 'Thread'));
    el.innerHTML = headHtml(ctx()) + '<p class="team-thread__note" role="status" hidden></p>'
      + '<div class="team-scroll team-thread__scroll" role="log" aria-live="polite" tabindex="-1" aria-label="' + escapeHtml(jt('team.thread.logLabel', 'Replies')) + '"></div>'
      + '<div class="team-composer-root" data-team-region="thread-composer"></div>';
    shell.appendChild(el);
    const scroll = el.querySelector('.team-thread__scroll');
    const note = el.querySelector('.team-thread__note');
    const actionsBar = el.querySelector('.team-head__actions');
    const composerRoot = el.querySelector('[data-team-region="thread-composer"]');
    const nodes = new Map();
    const bodies = new Map();
    let disposed = false;
    let wasOnline = ctx().online;
    let toReveal = null; // { id, done }: the reply a jump waits for
    const files = filesModule.createFiles({ teamId, channelId, scroll, ctx, onChange: () => draw() }); // slice 2c: a reply's files

    const unwatch = chat.watchThread(teamId, channelId, rootId);
    const data = threadData.createThreadData({ channelId, rootId, call: writes.call, onChange: draw, onGone });
    const shown = () => (data.state.root ? [data.state.root].concat(data.state.replies) : data.state.replies);
    let composer = null;
    const acts = actions.createActions({ root: scroll, chat, teamId, channelId, ctx, writes, inThread: true, onReply, list: shown,
      redraw: draw, focusComposer: () => Boolean(composer && composer.focus()) });
    composer = composers.createComposer({ root: composerRoot, chat, teamId, channelId, ctx, writes, threadRootId: rootId, onEditLast: () => acts.editLast() });

    function headHtml(c) {
      const back = c.direct ? jt('team.dm.threadBack', 'Back to {names}', { names: c.channelTitle }) : jt('team.thread.back', 'Back to #{channel}', { channel: c.channelName });
      const close = jt('team.thread.close', 'Close thread (Esc)');
      return '<header class="team-head team-head--thread">' + inv().actionButton({ plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back,
        dataset: { 'team-thread-action': 'back' }, trustedHtml: BACK })
        + '<h2 class="team-head__name">' + escapeHtml(jt('team.thread.label', 'Thread')) + '</h2>'
        + '<span class="team-head__sub" dir="auto">' + escapeHtml(c.channelTitle) + '</span><div class="team-head__actions">'
        + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: close, title: close, dataset: { 'team-thread-action': 'close' }, trustedHtml: CLOSE })
        + '</div></header>';
    }

    // The bell: drawn only while the host has said whether you follow; busy while a change is out.
    function syncBell() {
      const st = data.state;
      let bell = actionsBar.querySelector('[data-team-thread-action="follow"]');
      if (typeof st.following !== 'boolean') { if (bell) bell.remove(); return; }
      const label = st.following ? jt('team.thread.following', 'Following this thread') : jt('team.thread.follow', 'Follow this thread');
      if (!bell) {
        actionsBar.insertAdjacentHTML('afterbegin', inv().actionButton({ plain: true, className: 'team-icon-btn', ariaPressed: st.following,
          title: label, dataset: { 'team-thread-action': 'follow' }, trustedHtml: BELL }));
        bell = actionsBar.querySelector('[data-team-thread-action="follow"]');
      }
      bell.setAttribute('aria-pressed', String(st.following));
      bell.setAttribute('aria-label', label);
      bell.title = label;
      bell.disabled = st.followBusy;
      const words = st.followError ? jt('team.thread.followFailed', 'Could not change following. {reason}', { reason: chatWrites.failText({ error: st.followError }) }) : '';
      if (note.textContent !== words) note.textContent = words;
      note.hidden = !words;
    }

    function body(key, rev, names, text, mentions, c) {
      const held = bodies.get(key);
      if (held && held.rev === rev && held.names === names) return held.html;
      const html = rows.bodyHtml(text, mentions, c, doc);
      bodies.set(key, { rev, names, html });
      return html;
    }

    // The rows the column should hold, in order: { key, kind, sig, html } or a message row. `all`: the outbox
    // entries, read once per pass.
    function wanted(all) {
      const c = ctx();
      const st = data.state;
      const items = [];
      const related = rows.relatedEntries(all, channelId);
      let prev = null;
      let day = '';
      const add = (message) => {
        const key = rows.dayKey(message.created_at);
        if (key && key !== day) { items.push({ key: 'day:' + key, kind: 'day', sig: rows.dayLabel(key), html: escapeHtml(rows.dayLabel(key)) }); day = key; prev = null; }
        const first = !rows.sameRun(prev, message);
        const author = c.author(message.author);
        const deletedBy = message.deleted ? c.nameOf(message.deleted.by) : '';
        const ids = Array.isArray(message.mentions) ? message.mentions : [];
        const names = rows.mentionKey(ids, c, message.text);
        const part = acts.parts(message, related.get(message.id) || [], c);
        const block = files.row(message, c);
        items.push({ key: 'msg:' + message.id, kind: 'msg', message, first, inThread: true, edit: part.edit, chips: part.chips, facts: part.facts, foot: part.foot, acts: part.acts,
          body: message.deleted ? '' : body(message.id, rows.bodyKey(message), names, message.text, ids, c), files: block.html,
          sig: part.sig === 'edit' ? 'edit' : [message.rev, first, author.name, author.former, deletedBy, message.edited_at, names, part.sig, block.sig].join('|') });
        prev = message;
      };
      if (st.root) {
        add(st.root);
        const count = Math.max(Number(st.root.reply_count) || 0, st.replies.length);
        const text = jtn('team.thread.count', count, {}, '{count} reply', '{count} replies');
        items.push({ key: 'count', kind: 'count', sig: text, html: escapeHtml(text) });
        prev = null;
      }
      for (const reply of st.replies) add(reply);
      if (st.capped) {
        const text = jt('team.thread.capped', 'The first 400 replies are shown.');
        items.push({ key: 'capped', kind: 'capped', sig: text, html: escapeHtml(text) });
      }
      if (st.error) {
        const text = jt('team.thread.loadFailed', 'Replies could not be loaded. {reason}', { reason: chatWrites.failText({ error: st.error }) });
        items.push({ key: 'error', kind: 'error', sig: text, html: '<p>' + escapeHtml(text) + '</p>'
          + inv().actionButton({ label: jt('team.chat.tryAgain', 'Try again'), size: 'sm', dataset: { 'team-thread-action': 'retry' } }) });
      }
      const posts = all.filter((e) => rows.isOpenPost(e) && e.channel_id === channelId && e.thread_root_id === rootId);
      for (const entry of rows.pendingPosts(posts, st.replies, c.me, (id) => chat.settledId(teamId, id))) {
        const message = { id: entry.entry_id, thread_root_id: rootId, author: { kind: 'member', member_id: c.me }, created_at: entry.created_at, text: entry.text, edited_at: null, deleted: null, reply_count: 0 };
        const ids = chatWrites.tokenIds(entry.text);
        const names = rows.mentionKey(ids, c, entry.text);
        const part = acts.pendingParts(entry, c);
        items.push({ key: 'out:' + entry.entry_id, kind: 'msg', message, first: true, inThread: true, pending: entry.state, foot: part.foot,
          body: body('out:' + entry.entry_id, entry.text, names, entry.text, ids, c), sig: [part.sig, c.author(message.author).name, names].join('|') });
      }
      return items;
    }

    function fill(node, item) {
      node.dataset.sig = item.sig;
      if (item.kind !== 'msg') {
        node.className = CLASSES[item.kind];
        if (item.kind === 'day' || item.kind === 'count') node.setAttribute('role', 'separator');
        node.innerHTML = item.html;
        return;
      }
      node.className = 'team-msg';
      node.tabIndex = node.tabIndex === 0 ? 0 : -1;
      node.dataset.first = String(item.first);
      if (item.pending) { node.dataset.pending = 'true'; node.removeAttribute('data-message-id'); delete node.dataset.seq; } else {
        node.dataset.messageId = item.message.id;
        node.dataset.seq = String(item.message.seq);
        node.removeAttribute('data-pending');
      }
      node.innerHTML = rows.rowInnerHtml(item, ctx());
    }

    // One pass: the log brought to what it should hold (renderer-team-message-row.js `patchRows`), the bell.
    function draw() {
      if (disposed) return;
      const stick = scroll.clientHeight > 0 && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_SLACK_PX;
      rows.patchRows(scroll, nodes, wanted(chat.pending(teamId)), fill, (key) => bodies.delete(key.startsWith('msg:') ? key.slice(4) : key));
      if (stick) scroll.scrollTop = scroll.scrollHeight;
      files.scan();
      syncBell();
      revealWanted();
      markRead();
    }

    const atBottom = () => scroll.clientHeight > 0 && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_SLACK_PX;
    const focused = () => !doc.hidden && (typeof doc.hasFocus === 'function' ? doc.hasFocus() : true);

    // The cheap checks first; the layout is read last.
    function markRead() {
      const st = data.state;
      if (disposed || !st.loaded || st.error || !st.replies.length || data.reading()) return;
      const newest = st.replies[st.replies.length - 1].seq;
      const behind = st.following === true && Number.isSafeInteger(st.readSeq) && newest > st.readSeq;
      if (!behind && !chat.threadUnread(teamId, channelId, rootId)) return;
      if (!focused() || !atBottom()) return;
      chat.markThreadRead(teamId, channelId, rootId, newest, behind ? st.readSeq : null);
    }

    function revealWanted() {
      if (!toReveal) return;
      const row = rows.rowOf(scroll, toReveal.id);
      if (!row && data.reading()) return;
      const { done } = toReveal;
      toReveal = null;
      if (row || !data.state.error) done(row, data.state.capped);
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-thread-action]') : null;
      if (!target || target.disabled || !el.contains(target)) return;
      switch (target.dataset.teamThreadAction) {
        case 'close':
        case 'back': onClose(); return;
        case 'follow': void data.toggleFollow(); return;
        case 'retry': data.retry(); return;
        default:
      }
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        if (chatWrites.isCloseKey(event)) { event.preventDefault(); onClose(); }
        return;
      }
      rows.moveRowFocus(event, scroll);
    }

    const win = doc.defaultView;
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKeydown);
    scroll.addEventListener('scroll', markRead, { passive: true });
    if (win) win.addEventListener('focus', markRead);
    data.load();
    draw();

    return {
      rootId,
      root: el,
      logRoot: scroll,
      composerRoot,
      // A chat change for this frame's team (from the tab's render): at most one pass and one read from the start.
      update(change) {
        if (disposed) return;
        if (change && LINE_ONLY.has(change.type)) { composer.update(); return; }
        let reload = false;
        if (change && change.type === 'messages' && change.channel_id === channelId) {
          if (change.reset) reload = true; else data.onRecords(change.records);
        }
        const online = ctx().online;
        if (online && !wasOnline) reload = true;
        wasOnline = online;
        if (reload) data.load();
        else if (change && change.type === 'outbox' && (change.settled || []).some((done) => done && done.ok === true && done.thread_root_id === rootId)) data.more();
        draw();
        composer.update();
      },
      focusTarget: () => scroll.querySelector('.team-msg[tabindex="0"]') || scroll,
      composerTarget: () => composer.focusTarget(),
      messageOf: (id) => (data.state.root && data.state.root.id === id ? data.state.root : data.state.replies.find((m) => m.id === id) || null),
      reveal(id, done) { if (disposed) return; toReveal = { id, done }; revealWanted(); },
      // Into the thread: its composer, or its log for a read-only member.
      focus() { if (!composer.focus()) (scroll.querySelector('.team-msg[tabindex="0"]') || scroll).focus(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        data.dispose();
        acts.dispose();
        composer.dispose();
        files.dispose();
        unwatch();
        el.removeEventListener('click', onClick);
        el.removeEventListener('keydown', onKeydown);
        scroll.removeEventListener('scroll', markRead);
        if (win) win.removeEventListener('focus', markRead);
        el.remove();
        nodes.clear();
        bodies.clear();
      },
    };
  }

  return { createThreadColumn };
});
