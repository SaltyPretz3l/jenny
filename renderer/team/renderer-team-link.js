/* Links to a team message: the link token, the chips
 * drawn for it in messages and the one jump that search results and chips
 * share. No bridge of its own: the jump reads through the chat store and the
 * frame's `call`.
 *
 * - A token is `jenny-team:<team_id>/<channel_id>/<seq>/<message_id>`, plus
 *   `/<root_id>` for a reply. It is valid when each id matches its pattern,
 *   the seq is a positive safe integer, the team is the shown team and the
 *   channel is listed. Tokens are found in a message's text nodes after the
 *   Markdown is sanitized, never in code or a link, at most five per message,
 *   and become `button.team-msglink` (inventory markup, the parts escaped, the
 *   ids in `data-` attributes). A chip never reads from the host by itself.
 * - The jump: a match in a channel that is not listed changes nothing and
 *   says so; a reply asks `chatThread` for its root first; a target not held
 *   opens the window around its seq (`chatHistory`, the store's `openChannel`
 *   with `aroundSeq`). The target row is scrolled to the middle of its log,
 *   focused and tinted (`data-jumped`) for 2.4 s. A target the window or the
 *   thread does not hold, or one deleted, shows the page and one quiet line; a
 *   failed read says why in that line and changes nothing shown. A newer jump
 *   drops what an older one would still do.
 * Host text is untrusted: chip words go through `escapeHtml`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-writes'));
    return;
  }
  root.rendererTeamLink = factory(root.rendererTeamChatWrites);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatWrites) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MSG = 'msg_[0-9A-HJKMNP-TV-Z]{26}';
  const TOKEN = new RegExp('jenny-team:(team_[A-Za-z0-9_-]{1,64})/(chan_[A-Za-z0-9_-]{1,140})/([0-9]{1,16})/(' + MSG + ')(?:/(' + MSG + '))?(?![A-Za-z0-9_/-])', 'g');
  const CHANNEL_ID = /^(chan_team|chan_project_[A-Za-z0-9_-]{1,128}|chan_dm_[a-f0-9]{64})$/;
  const SKIP = new Set(['CODE', 'PRE', 'A', 'BUTTON']);
  const MAX_CHIPS = 5;
  const TINT_MS = 2400;

  function inv() { return globalThis.inventory || {}; }

  function build({ teamId, channelId, seq, messageId, rootId = null }) {
    return 'jenny-team:' + teamId + '/' + channelId + '/' + seq + '/' + messageId + (rootId ? '/' + rootId : '');
  }

  // The valid links in a string, at most five, as { teamId, channelId, seq, messageId, rootId, index, length }.
  // `ctx.teamId` is the shown team; `ctx.listed(channelId)` says whether a channel is listed.
  function linksIn(text, ctx) {
    const found = [];
    if (!ctx || !ctx.teamId || !String(text).includes('jenny-team:')) return found;
    for (const m of String(text).matchAll(TOKEN)) {
      const seq = Number(m[3]);
      if (m[1] !== ctx.teamId || !CHANNEL_ID.test(m[2]) || !ctx.listed(m[2]) || !Number.isSafeInteger(seq) || seq <= 0) continue;
      found.push({ teamId: m[1], channelId: m[2], seq, messageId: m[4], rootId: m[5] || null, index: m.index, length: m[0].length });
      if (found.length === MAX_CHIPS) break;
    }
    return found;
  }

  // What a message's chips say now (part of its body's cache key): '' when it has none.
  function linkKey(text, ctx, label) {
    return linksIn(text, ctx).map((link) => { const l = label(link); return l.where + '\u0001' + l.text; }).join('\u0002');
  }

  function chipHtml(link, { where, text }) {
    return inv().actionButton({ plain: true, className: 'team-msglink', title: jt('team.link.go', 'Go to this message'),
      dataset: { 'link-channel': link.channelId, 'link-seq': String(link.seq), 'link-message': link.messageId, 'link-root': link.rootId || '' },
      trustedHtml: '<span class="team-msglink__where">' + escapeHtml(where) + '</span>'
        + (text ? '<span class="team-msglink__text" dir="auto">' + escapeHtml(text) + '</span>' : '') });
  }

  // Turns the valid tokens in `box`'s text nodes (not in code, a link or a button) into chips.
  function markLinks(box, ctx, label) {
    const doc = box.ownerDocument;
    const walker = doc.createTreeWalker(box, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let skip = false;
      for (let parent = node.parentNode; parent && parent !== box; parent = parent.parentNode) if (SKIP.has(parent.nodeName)) { skip = true; break; }
      if (!skip && node.nodeValue.includes('jenny-team:')) nodes.push(node);
    }
    let left = MAX_CHIPS;
    for (const node of nodes) {
      const links = linksIn(node.nodeValue, ctx).slice(0, left);
      if (!links.length) continue;
      left -= links.length;
      const text = node.nodeValue;
      const parts = doc.createDocumentFragment();
      const template = doc.createElement('template');
      let last = 0;
      for (const link of links) {
        parts.appendChild(doc.createTextNode(text.slice(last, link.index)));
        template.innerHTML = chipHtml(link, label(link));
        parts.appendChild(template.content.firstChild);
        last = link.index + link.length;
      }
      parts.appendChild(doc.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(parts, node);
      if (!left) break;
    }
  }

  // A chip's target, as a search match reads.
  function chipTarget(chip) {
    const d = chip.dataset;
    return { channel_id: d.linkChannel, message_id: d.linkMessage, seq: Number(d.linkSeq), root_id: d.linkRoot || null };
  }

  // One per frame. `timeline()` answers the frame's timeline; `openThread(root)` opens a root's thread (its
  // screen under 720 px) and answers its column; `showScreen(name)` shows the channel screen; `holdEdit()` puts
  // the focus back in an edit open in the channel and answers whether there was one; `rowOf(log, id)` finds a row;
  // `elsewhere(target)` shows another channel of the team for a target there (the jump then runs in its frame) and
  // answers whether it did.
  function createJumper({ chat, teamId, channelId, call, timeline, openThread, showScreen, holdEdit, rowOf, elsewhere = null }) {
    let turn = 0;
    let tint = null; // { row, timer }
    let disposed = false;

    const note = (text) => { const line = timeline(); if (line) line.setNote(text); };
    const missing = () => note(jt('team.jump.missing', 'That message is no longer here.'));
    const failed = (answer) => note(jt('team.jump.failed', 'That message could not be shown. {reason}', { reason: chatWrites.failText(answer) }));
    const refused = (answer) => (answer && answer.error && answer.error.reason === 'team_chat_not_found' ? missing() : failed(answer));

    function clearTint() {
      if (!tint) return;
      clearTimeout(tint.timer);
      delete tint.row.dataset.jumped;
      tint = null;
    }

    // To the middle of its log, the log's tab stop, focused and tinted.
    function show(log, row) {
      const box = log.getBoundingClientRect();
      const at = row.getBoundingClientRect();
      log.scrollTop += (at.top - box.top) - (box.height - at.height) / 2;
      const held = log.querySelector('.team-msg[tabindex="0"]');
      if (held && held !== row) held.tabIndex = -1;
      row.tabIndex = 0;
      row.focus({ preventScroll: true });
      clearTint();
      const mine = { row, timer: 0 };
      mine.timer = setTimeout(() => { if (tint === mine) clearTint(); }, TINT_MS);
      tint = mine;
      row.dataset.jumped = 'true';
    }

    // `target`: { channel_id, message_id, seq, root_id } (a search match or a chip).
    async function jump(target) {
      const mine = ++turn;
      const stale = () => disposed || mine !== turn;
      note('');
      if (target && target.channel_id !== channelId && elsewhere && elsewhere(target)) return;
      if (!target || target.channel_id !== channelId) { note(jt('team.jump.notListed', 'That message is in a channel this tab does not show yet.')); return; }
      let root = null;
      if (target.root_id) {
        const answer = await call('chatThread', { channel_id: channelId, root_id: target.root_id, limit: 1 });
        if (stale()) return;
        if (!answer || !answer.ok || !answer.root || !Number.isSafeInteger(answer.root.seq)) { refused(answer); return; }
        root = answer.root;
      }
      const id = root ? root.id : target.message_id;
      const held = () => chat.timeline(teamId, channelId).list.find((m) => m.id === id) || null;
      let message = held();
      if (!message) {
        // The read around the target replaces the window: not while an edit is open in it (the edit keeps the focus).
        if (holdEdit()) return;
        const answer = await chat.openChannel(teamId, channelId, root ? root.seq : target.seq);
        if (stale() || (answer && answer.superseded)) return; // a later open of the channel won: it says nothing
        if (!answer || !answer.ok) { refused(answer); return; }
        message = held();
      }
      if (root) {
        const column = openThread(message || root);
        if (!column || stale()) return;
        column.reveal(target.message_id, (row, capped) => {
          if (stale()) return;
          const log = column.logRoot;
          if (row) { show(log, row); return; }
          const top = rowOf(log, root.id);
          if (top) show(log, top);
          if (!capped) missing();
        });
        return;
      }
      showScreen('channel');
      const line = timeline();
      const row = line && rowOf(line.logRoot, id);
      if (!row || !message || message.deleted) { missing(); return; }
      show(line.logRoot, row);
    }

    return {
      jump: (target) => { void jump(target); },
      cancel() { turn += 1; }, // a jump in flight does nothing more
      dispose() { disposed = true; clearTint(); },
    };
  }

  return { build, linkKey, markLinks, chipTarget, createJumper };
});
