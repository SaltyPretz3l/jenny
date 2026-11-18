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
 * - Row 175 F1: a project conversation message is `jenny-team:<team_id>/conv/<session_id>/<message_id>` (the
 *   host's session id `sess_...`, a message id of the host's id characters). `build` and the parser accept it only
 *   for the shown team and a conversation the project store lists for it (`ctx.conversationListed` when the caller
 *   gives one). Its chip is labelled with the conversation's title, and a click opens that conversation through the
 *   notify intent (the scroll to the message is a later slice). Channel tokens are unchanged.
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
  const CHANNEL_ID = /^(chan_team|chan_project_[A-Za-z0-9_-]{1,128}|chan_dm_[a-f0-9]{64}|chan_c_[a-z2-7]{16})$/;
  const CHANNEL_TOKEN = /jenny-team:(team_[A-Za-z0-9_-]{1,64})\/(chan_[A-Za-z0-9_-]{1,140})(?![A-Za-z0-9_/-])/g;
  const CONV_TOKEN = /jenny-team:(team_[A-Za-z0-9_-]{1,64})\/conv\/(sess_[A-Za-z0-9_-]{1,123})\/([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_/-])/g;
  const TEAM_ID = /^team_[A-Za-z0-9_-]{1,64}$/;
  const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,123}$/;
  const CONV_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
  const TITLE_MAX = 80;
  const SKIP = new Set(['CODE', 'PRE', 'A', 'BUTTON']);
  const MAX_CHIPS = 5;
  const TINT_MS = 2400;

  function inv() { return globalThis.inventory || {}; }

  // Row 175: the project store's row for a listed conversation of this team, else null (the store loads with the tab).
  function projectStore() {
    if (globalThis.rendererTeamProjectStore) return globalThis.rendererTeamProjectStore.getProjectStore();
    try { return typeof require === 'function' ? require('./renderer-team-project-store').getProjectStore() : null; } catch (_error) { return null; }
  }
  function storedConversation(teamId, sessionId) {
    const store = projectStore();
    const state = store ? store.team(teamId) : null;
    return state && Array.isArray(state.conversations) ? state.conversations.find((row) => row && row.session_id === sessionId) || null : null;
  }
  function conversationListed(ctx, teamId, sessionId) {
    return ctx && teamId === ctx.teamId && typeof ctx.conversationListed === 'function' ? ctx.conversationListed(sessionId) === true : Boolean(storedConversation(teamId, sessionId));
  }
  // What a token's team lets through: the shown team by the context itself, another team this member belongs to by
  // `ctx.otherTeam(teamId)` ({ name, listed(channelId), channelName(channelId) }), any other team not at all (it stays plain text).
  function scopeOf(ctx, teamId) {
    if (teamId === ctx.teamId) return { listed: (id) => ctx.listed(id), conversation: (sessionId) => conversationListed(ctx, teamId, sessionId) };
    const peer = typeof ctx.otherTeam === 'function' ? ctx.otherTeam(teamId) : null;
    return peer ? { listed: (id) => peer.listed(id), conversation: (sessionId) => Boolean(storedConversation(teamId, sessionId)) } : null;
  }

  // A channel message's token; with `sessionId`, a project conversation message's, '' unless its ids are valid and the
  // conversation is listed for the team (`ctx` as for the parser); with neither a message nor a session, the channel's own
  // token `jenny-team:<team_id>/<channel_id>` (the column row's Copy link).
  function build({ teamId, channelId, seq, messageId, rootId = null, sessionId = '' }, ctx = null) {
    if (!sessionId && !messageId) return TEAM_ID.test(teamId) && CHANNEL_ID.test(channelId) ? 'jenny-team:' + teamId + '/' + channelId : '';
    if (sessionId) {
      const valid = TEAM_ID.test(teamId) && SESSION_ID.test(sessionId) && CONV_MESSAGE_ID.test(String(messageId));
      return valid && conversationListed(ctx, teamId, sessionId) ? 'jenny-team:' + teamId + '/conv/' + sessionId + '/' + messageId : '';
    }
    return 'jenny-team:' + teamId + '/' + channelId + '/' + seq + '/' + messageId + (rootId ? '/' + rootId : '');
  }

  // The valid links in a string, at most five, in text order, as { teamId, channelId, seq, messageId, rootId, index,
  // length }, for a channel's own token { teamId, channelId, channelOnly, index, length }, or for a conversation message
  // { teamId, sessionId, messageId, index, length }; `other` marks one into another team this member belongs to.
  // `ctx.teamId` is the shown team; `ctx.listed(channelId)` says whether a channel is listed; `ctx.otherTeam(teamId)`
  // answers for another joined team (see `scopeOf`).
  function linksIn(text, ctx) {
    const found = [];
    if (!ctx || !ctx.teamId || !String(text).includes('jenny-team:')) return found;
    const other = (teamId) => teamId !== ctx.teamId;
    for (const m of String(text).matchAll(TOKEN)) {
      const seq = Number(m[3]);
      const scope = scopeOf(ctx, m[1]);
      if (!scope || !CHANNEL_ID.test(m[2]) || !scope.listed(m[2]) || !Number.isSafeInteger(seq) || seq <= 0) continue;
      found.push({ teamId: m[1], channelId: m[2], seq, messageId: m[4], rootId: m[5] || null, index: m.index, length: m[0].length, other: other(m[1]) });
    }
    for (const m of String(text).matchAll(CHANNEL_TOKEN)) {
      const scope = scopeOf(ctx, m[1]);
      if (!scope || !CHANNEL_ID.test(m[2]) || !scope.listed(m[2])) continue;
      found.push({ teamId: m[1], channelId: m[2], channelOnly: true, index: m.index, length: m[0].length, other: other(m[1]) });
    }
    for (const m of String(text).matchAll(CONV_TOKEN)) {
      const scope = scopeOf(ctx, m[1]);
      if (!scope || !scope.conversation(m[2])) continue;
      found.push({ teamId: m[1], sessionId: m[2], messageId: m[3], index: m.index, length: m[0].length, other: other(m[1]) });
    }
    return found.sort((a, b) => a.index - b.index).slice(0, MAX_CHIPS);
  }

  // A conversation link's words: the conversation's title, then "message" (the caller's label reads channels only).
  function conversationWords(link) {
    const row = storedConversation(link.teamId, link.sessionId);
    const chars = Array.from(String((row && row.title) || '').replace(/\s+/g, ' ').trim());
    const title = chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : chars.join('');
    return { where: (title || jt('team.link.conversation', 'Project conversation')) + ' · ' + jt('team.link.message', 'message'), text: '' };
  }
  // A link's chip words. The caller's `label` reads the shown team's channels; a link into another team (named first), and a
  // channel's own token, are worded here.
  function wordsOf(link, label, ctx) {
    const peer = link.other && ctx && typeof ctx.otherTeam === 'function' ? ctx.otherTeam(link.teamId) : null;
    const channelName = () => '#' + (peer ? peer.channelName(link.channelId) : ctx.channelNameOf(link.channelId));
    let words;
    if (link.sessionId) words = conversationWords(link);
    else if (link.channelOnly) words = { where: channelName(), text: '' };
    else if (peer) words = { where: channelName() + ' · ' + jt('team.link.message', 'message'), text: '' };
    else words = label(link);
    return peer ? { ...words, where: (peer.name || jt('settings.team.joined.unnamed', 'Unnamed team')) + ' · ' + words.where } : words;
  }

  // What a message's chips say now (part of its body's cache key): '' when it has none.
  function linkKey(text, ctx, label) {
    return linksIn(text, ctx).map((link) => { const l = wordsOf(link, label, ctx); return l.where + '\u0001' + l.text; }).join('\u0002');
  }

  function chipHtml(link, { where, text }) {
    let dataset = { 'link-channel': link.channelId, 'link-seq': String(link.seq), 'link-message': link.messageId, 'link-root': link.rootId || '' };
    if (link.sessionId) dataset = { 'link-session': link.sessionId, 'link-message': link.messageId };
    else if (link.channelOnly) dataset = { 'link-channel': link.channelId, 'link-only': 'true' };
    if (link.other) dataset['link-team'] = link.teamId;
    return inv().actionButton({ plain: true, className: 'team-msglink', title: link.channelOnly ? jt('team.link.goChannel', 'Go to this channel') : jt('team.link.go', 'Go to this message'),
      dataset,
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
        template.innerHTML = chipHtml(link, wordsOf(link, label, ctx));
        parts.appendChild(template.content.firstChild);
        last = link.index + link.length;
      }
      parts.appendChild(doc.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(parts, node);
      if (!left) break;
    }
  }

  // A chip's target, as a search match reads; a conversation chip's is { session_id, message_id }, a channel's own link's
  // { channel_id, channel_only }; a chip into another team adds `team_id`.
  function chipTarget(chip) {
    const d = chip.dataset;
    let target;
    if (d.linkSession) target = { session_id: d.linkSession, message_id: d.linkMessage };
    else if (d.linkOnly) target = { channel_id: d.linkChannel, channel_only: true };
    else target = { channel_id: d.linkChannel, message_id: d.linkMessage, seq: Number(d.linkSeq), root_id: d.linkRoot || null };
    return d.linkTeam ? { ...target, team_id: d.linkTeam } : target;
  }

  // Row 175: a conversation chip runs the notify module's conversation intent (loaded with the chat store).
  function requestIntent(intent) {
    let notify = globalThis.rendererTeamNotify || null;
    if (!notify && typeof require === 'function') { try { notify = require('./renderer-team-notify'); } catch (_error) { notify = null; } }
    if (notify && typeof notify.request === 'function') notify.request(intent);
  }
  function openConversationIntent(teamId, sessionId) { requestIntent({ kind: 'conversation', teamId, sessionId }); }

  // A chip into another joined team: the notify intent selects that team, then shows the channel (and jumps to the message
  // when the link names one); a team left since says so in the shown channel.
  function openOtherTeam(target) {
    if (typeof target.session_id === 'string') { openConversationIntent(target.team_id, target.session_id); return; }
    requestIntent({ kind: 'open', teamId: target.team_id, channelId: target.channel_id,
      ...(target.channel_only ? {} : { messageId: target.message_id, seq: target.seq, threadRootId: target.root_id || undefined }) });
  }

  // One per frame. `timeline()` answers the frame's timeline; `openThread(root)` opens a root's thread (its
  // screen under 720 px) and answers its column; `showScreen(name)` shows the channel screen; `holdEdit()` puts
  // the focus back in an edit open in the channel and answers whether there was one; `rowOf(log, id)` finds a row;
  // `elsewhere(target)` shows another channel of the team for a target there (the jump then runs in its frame) and
  // answers whether it did.
  function createJumper({ chat, teamId, channelId, call, timeline, openThread, showScreen, holdEdit, rowOf, elsewhere = null, openConversation = openConversationIntent }) {
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
      if (target && target.team_id && target.team_id !== teamId) { openOtherTeam(target); return; }
      if (target && typeof target.session_id === 'string') { openConversation(teamId, target.session_id); return; }
      if (target && target.channel_only) {
        if (target.channel_id === channelId) showScreen('channel');
        else if (!elsewhere || !elsewhere(target)) note(jt('team.jump.notListed', 'That message is in a channel this tab does not show yet.'));
        return;
      }
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
