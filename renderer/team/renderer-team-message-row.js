/* One row of the team chat timeline and thread column (row 123, slices 2a-5a to 2a-6a): the body of a
 * message and the row around it. Text from the host is untrusted: a message's
 * Markdown reaches the page only through `markdownUtils.renderMarkdown` (raw
 * HTML escaped, images omitted, sanitized), and mentions are marked afterwards
 * on its text nodes, from the message's own `mentions` field, with elements
 * built by the DOM. Names, times and words go through `escapeHtml`. Links stay
 * plain sanitized links: the main window's navigation guard opens an http(s)
 * link in the system browser and refuses anything else, as in the chat
 * timeline. The edit box, the foot's outbox words and buttons and the action
 * row come ready-made (and escaped) from renderer-team-message-actions.js.
 * "N replies, last HH:MM" is a button that opens the thread (not inside the
 * thread itself). The timeline and the thread column share from here the
 * once-only rule for queued posts (`pendingPosts`), each message's own edit
 * and delete entries, the mention key, the keyed patch of a log and its arrow
 * keys; each keeps its own `fill`. Message links become chips
 * (renderer-team-link.js) after the mentions; a chip's words join the mention key.
 * Pure apart from the detached element used to mark mentions. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-chat-store'), require('./renderer-team-link'));
    return;
  }
  root.rendererTeamMessageRow = factory(root.rendererSettingsTeamStrings, root.rendererTeamChatStore, root.rendererTeamLink);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, chatStore, links) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const RUN_MS = 5 * 60 * 1000;
  const MENTION = /<@(member_[A-Za-z0-9_-]{1,64}|jenny|channel)>/g;
  const SKIP_MENTIONS = new Set(['CODE', 'PRE', 'A']);
  const MARKDOWN_OPTIONS = Object.freeze({ mermaid: 'plain', images: 'omit' });
  const CLAIM_SKEW_MS = 60_000;

  function inv() { return globalThis.inventory || {}; }

  function markdown() {
    const win = globalThis.window;
    return (win && win.markdownUtils) || globalThis.markdownUtils || null;
  }

  function toMs(value) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  // ------------------------------------------------------------------ times

  const formats = new Map();
  function format(kind) {
    const tag = globalThis.jennyI18n?.tag?.();
    const clock = globalThis.jennyI18n?.timeOptions?.() || {};
    const key = kind + '|' + String(tag || '') + '|' + JSON.stringify(clock);
    if (!formats.has(key)) {
      const options = kind === 'time' ? { hour: 'numeric', minute: '2-digit', ...clock }
        : kind === 'day' ? { dateStyle: 'medium' } : { month: 'short', day: 'numeric' };
      formats.set(key, new Intl.DateTimeFormat(tag, options));
    }
    return formats.get(key);
  }
  function timeText(value) { const ms = toMs(value); return ms ? format('time').format(new Date(ms)) : ''; }
  function localDay(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayKey(value) { const ms = toMs(value); return ms ? localDay(ms) : ''; }
  function dayLabel(key, now = Date.now()) {
    if (!key) return ''; // no date (a host record without one)
    if (key === localDay(now)) return jt('team.chat.today', 'Today');
    if (key === localDay(now - 86_400_000)) return jt('team.chat.yesterday', 'Yesterday');
    const [y, m, d] = key.split('-').map(Number);
    return format('day').format(new Date(y, m - 1, d));
  }
  // When an offline member was last seen: a time today, else a short date.
  function lastSeenText(value, now = Date.now()) {
    const ms = toMs(value);
    if (!ms) return '';
    return localDay(ms) === localDay(now) ? format('time').format(new Date(ms)) : format('short').format(new Date(ms));
  }

  // Names joined the way the locale does ("A, B and C").
  const listFormats = new Map();
  function listText(names) {
    const tag = String(globalThis.jennyI18n?.tag?.() || '');
    if (!listFormats.has(tag)) listFormats.set(tag, typeof Intl.ListFormat === 'function' ? new Intl.ListFormat(tag || 'en', { style: 'long', type: 'conjunction' }) : null);
    const f = listFormats.get(tag);
    return f ? f.format(names) : names.join(', ');
  }

  // A run is consecutive messages by one author within 5 minutes.
  function sameRun(prev, next) {
    if (!prev || !next || !prev.author || !next.author) return false;
    return prev.author.kind === next.author.kind && prev.author.member_id === next.author.member_id
      && toMs(next.created_at) - toMs(prev.created_at) <= RUN_MS;
  }

  // ------------------------------------------------------------------ body

  // Replaces each listed mention token in the text nodes of `box` (not inside code or links).
  function markMentions(box, mentions, ctx) {
    const doc = box.ownerDocument;
    const listed = new Set(mentions);
    const walker = doc.createTreeWalker(box, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let parent = node.parentNode;
      let skip = false;
      while (parent && parent !== box) { if (SKIP_MENTIONS.has(parent.nodeName)) { skip = true; break; } parent = parent.parentNode; }
      if (!skip && node.nodeValue.includes('<@')) nodes.push(node);
    }
    for (const node of nodes) {
      const text = node.nodeValue;
      const parts = doc.createDocumentFragment();
      let last = 0;
      let marked = false;
      for (const match of text.matchAll(MENTION)) {
        if (!listed.has(match[1])) continue;
        parts.appendChild(doc.createTextNode(text.slice(last, match.index)));
        const span = doc.createElement('span');
        span.className = 'team-mention';
        span.textContent = '@' + ctx.mentionName(match[1]);
        if (match[1] === 'channel' || match[1] === ctx.me) span.dataset.me = 'true';
        parts.appendChild(span);
        last = match.index + match[0].length;
        marked = true;
      }
      if (!marked) continue;
      parts.appendChild(doc.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(parts, node);
    }
  }

  // What a chip says: "#channel · Author · time" and the first line for a message held in the window,
  // the thread or the results (`ctx.heldMessage`), else "#channel · message".
  function chipLabel(link, ctx) {
    const channel = '#' + ctx.channelNameOf(link.channelId);
    const held = ctx.heldMessage(link.messageId);
    if (!held || held.deleted) return { where: channel + ' · ' + jt('team.link.message', 'message'), text: '' };
    const first = String(held.text || '').split('\n').find((part) => part.trim()) || '';
    return { where: [channel, ctx.author(held.author).name, timeText(held.created_at)].join(' · '), text: first.trim() };
  }

  // What a drawn body depends on besides the names in it: its text and when it was last edited. A reaction or a
  // pin raises the revision and changes neither, so the Markdown is not rendered again for it (slice 2b-2).
  function bodyKey(message) { return String(message.edited_at || '') + '\u0000' + String(message.text || ''); }

  // Sanitized HTML for a message text; `doc` builds the detached element mentions and chips are marked in.
  function bodyHtml(text, mentions, ctx, doc) {
    const md = markdown();
    const html = String((md && typeof md.renderMarkdown === 'function'
      ? md.renderMarkdown(String(text || ''), MARKDOWN_OPTIONS)
      : '<p>' + escapeHtml(String(text || '')) + '</p>') || '');
    const mark = Array.isArray(mentions) && mentions.length > 0 && html.includes('&lt;@');
    const link = Boolean(ctx && ctx.teamId) && html.includes('jenny-team:');
    if (!mark && !link) return html;
    const box = doc.createElement('div');
    box.innerHTML = html;
    if (mark) markMentions(box, mentions, ctx);
    if (link) links.markLinks(box, ctx, (l) => chipLabel(l, ctx));
    return box.innerHTML;
  }

  // ------------------------------------------------------------------- rows

  function avatarHtml(author) {
    return '<span class="team-avatar"' + (author.jenny ? ' data-jenny="true"' : '') + (author.former ? ' data-former="true"' : '')
      + ' aria-hidden="true">' + (author.former ? '' : escapeHtml(author.initial)) + '</span>';
  }

  function metaHtml(author, message) {
    const who = '<span class="team-msg__author" dir="auto"' + (author.former ? ' data-former="true" title="' + escapeHtml(jt('team.chat.formerTitle', 'This person is no longer on the team')) + '"' : '')
      + '>' + escapeHtml(author.name) + '</span>';
    return '<div class="team-msg__meta">' + who + (author.jenny ? '<span class="team-msg__role">' + escapeHtml(jt('team.chat.model', 'model')) + '</span>' : '')
      + '<time class="team-msg__time" datetime="' + escapeHtml(String(message.created_at || '')) + '">' + escapeHtml(timeText(message.created_at)) + '</time></div>';
  }

  // The replies button's words (E59): "{count} replies, {n} new, last {time}" while a followed thread has replies
  // you have not seen (`fresh` > 0), the "{n} new" part in its own span; else "{count} replies, last {time}". Every
  // part is escaped; the span is the only markup. A translation without the {new} slot gets the words at the end.
  const NEW_SLOT = '\u2063';
  // `text` is the same words unmarked (the button's title).
  function threadLink(message, fresh) {
    const time = timeText(message.last_reply_at);
    const n = Number.isSafeInteger(fresh) && fresh > 0 ? fresh : 0;
    if (!n) {
      const text = jtn('team.chat.replies', message.reply_count, { time }, '{count} reply, last {time}', '{count} replies, last {time}');
      return { text, html: escapeHtml(text) };
    }
    const fresher = jtn('team.chat.repliesNewCount', n, {}, '{count} new', '{count} new');
    const words = '<span class="team-thread-link__new">' + escapeHtml(fresher) + '</span>';
    const parts = jtn('team.chat.repliesNew', message.reply_count, { time, new: NEW_SLOT }, '{count} reply, {new}, last {time}', '{count} replies, {new}, last {time}').split(NEW_SLOT);
    if (parts.length === 2) return { text: parts[0] + fresher + parts[1], html: escapeHtml(parts[0]) + words + escapeHtml(parts[1]) };
    return { text: parts.join('') + ' ' + fresher, html: escapeHtml(parts.join('')) + ' ' + words };
  }

  // The row's inner markup. `row` is { message, first, body, files, edit, foot, acts, inThread, fresh }: `files` (slice 2c,
  // renderer-team-files.js) goes between the text and the foot, never for a deleted message; `edit` replaces the
  // text while the message is edited; `foot` (outbox words, the delete confirm) and `acts` (the action row) are
  // trusted markup. A root shown inside its own thread (`inThread`) has no replies button; `fresh` is its followed
  // thread's unseen replies (E59).
  function rowInnerHtml(row, ctx) {
    const message = row.message;
    const author = ctx.author(message.author);
    const gutter = row.first ? avatarHtml(author) : '<span class="team-msg__gutter-time" aria-hidden="true">' + escapeHtml(timeText(message.created_at)) + '</span>';
    let body;
    if (row.edit) {
      body = row.edit;
    } else if (message.deleted) {
      body = '<div class="team-msg__deleted">' + escapeHtml(jt('team.chat.deletedBy', 'Message deleted by {name}', { name: chatStore.isolate(ctx.nameOf(message.deleted.by)) })) + '</div>';
    } else {
      let html = row.body;
      if (message.edited_at) {
        // "edited" opens the earlier versions (slice 2b-2); offline it is greyed and says so.
        const time = timeText(message.edited_at);
        const edited = inv().actionButton({ plain: true, className: 'team-msg__edited', ariaHaspopup: 'dialog', disabled: ctx.online === false,
          title: ctx.online === false ? jt('team.chat.editedOffline', 'Edited {time}. Earlier versions need the team online.', { time }) : jt('team.chat.editedShow', 'Edited {time}. Show earlier versions.', { time }),
          dataset: { 'team-msg-action': 'versions' }, trustedHtml: escapeHtml(jt('team.chat.edited', 'edited')) });
        html = /<\/p>\s*$/.test(html) ? html.replace(/<\/p>\s*$/, edited + '</p>') : html + edited;
      }
      // `chat-bubble-markdown`: markdown.css scopes its code-block, list and table rules to it (as the project conversation does).
      body = '<div class="team-msg__text chat-bubble-markdown" dir="auto">' + html + '</div>';
    }
    // The foot (slice 2b-2): the chips on a line of their own, then in words the replies link, the pin mark and "Seen by",
    // then the outbox words, the delete confirm and a refusal.
    let foot = row.chips || '';
    // A deleted root still opens: its replies stay readable.
    if (!row.inThread && message.reply_count > 0) {
      const words = threadLink(message, row.fresh);
      foot += inv().actionButton({ plain: true, className: 'team-thread-link', dataset: { 'team-msg-action': 'thread' },
        title: words.text, trustedHtml: words.html });
    }
    foot += (row.facts || '') + (row.foot || '');
    return gutter + '<div class="team-msg__body">' + (row.first ? metaHtml(author, message) : '') + body
      + (row.files && !message.deleted ? row.files : '')
      + (foot ? '<div class="team-msg__foot">' + foot + '</div>' : '') + '</div>' + (row.acts || '');
  }

  // A message this Jenny's member wrote.
  function isOwnMessage(message, me) { return Boolean(message && message.author && message.author.kind === 'member' && message.author.member_id === me); }

  // The queued and failed posts to draw at the end of a list, oldest first: `entries` already chosen for
  // this channel or thread. Not one whose message is shown (by id once settled; before that, a queued post
  // claims one own message with its text, not one settled here and created no earlier than a minute before).
  function pendingPosts(entries, list, me, isSettled) {
    if (!entries.length) return entries;
    const shown = new Set(list.map((m) => m.id));
    const own = list.filter((m) => isOwnMessage(m, me) && !isSettled(m.id));
    const claimed = new Set();
    return entries.slice().sort((a, b) => toMs(a.created_at) - toMs(b.created_at)).filter((e) => {
      if (e.message_id) return !shown.has(e.message_id);
      if (e.state !== 'queued') return true;
      const since = toMs(e.created_at) - CLAIM_SKEW_MS;
      const match = own.find((m) => !claimed.has(m.id) && m.text === e.text && toMs(m.created_at) >= since);
      if (match) claimed.add(match.id);
      return !match;
    });
  }
  // A post entry still to draw (queued or failed).
  const isOpenPost = (e) => Boolean(e && e.operation === 'post' && (e.state === 'queued' || e.state === 'failed'));

  // Each message's own queued or failed edits and deletes in a channel: message id -> entries.
  function relatedEntries(entries, channelId) {
    const by = new Map();
    for (const e of entries) {
      if (!e || e.channel_id !== channelId || !e.message_id || (e.operation !== 'edit' && e.operation !== 'delete')) continue;
      if (!by.has(e.message_id)) by.set(e.message_id, []);
      by.get(e.message_id).push(e);
    }
    return by;
  }

  // The names a body was drawn with, as one key ('' for none): its mentions and, with `text`, its chips' words.
  function mentionKey(ids, c, text = '') {
    const names = Array.isArray(ids) && ids.length ? JSON.stringify(ids.map((id) => c.mentionName(id))) : '';
    const chips = text && c.teamId ? links.linkKey(text, c, (l) => chipLabel(l, c)) : '';
    return chips ? names + '\u0003' + chips : names;
  }

  // The message row with this id in a log (any element holding rows), else null.
  function rowOf(box, id) { return (box && [...box.querySelectorAll('.team-msg[data-message-id]')].find((el) => el.dataset.messageId === id)) || null; }

  // Brings a log to `items` ({ key, sig }) through `nodes` (key -> element): what is gone is dropped first, so
  // no row that stays is ever moved; `fill(el, item)` draws a new or changed row; `onDrop(key)` for each
  // dropped row. The last message takes the tab stop when none has it.
  function patchRows(scroll, nodes, items, fill, onDrop) {
    const keep = new Set(items.map((item) => item.key));
    for (const [key, el] of nodes) {
      if (keep.has(key)) continue;
      el.remove();
      nodes.delete(key);
      onDrop(key);
    }
    let ref = scroll.firstElementChild;
    for (const item of items) {
      let el = nodes.get(item.key);
      if (!el) { el = scroll.ownerDocument.createElement('div'); el.dataset.key = item.key; fill(el, item); nodes.set(item.key, el); } else if (el.dataset.sig !== item.sig) fill(el, item);
      if (el !== ref) scroll.insertBefore(el, ref);
      else ref = ref.nextElementSibling;
    }
    const messages = scroll.querySelectorAll('.team-msg');
    if (messages.length && !scroll.querySelector('.team-msg[tabindex="0"]')) messages[messages.length - 1].tabIndex = 0;
  }

  // Arrow keys, Home and End on a focused message move between the log's messages (one tab stop, a roving index).
  function moveRowFocus(event, scroll) {
    const row = event.target && event.target.classList && event.target.classList.contains('team-msg') ? event.target : null;
    if (!row || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey) return;
    const list = [...scroll.querySelectorAll('.team-msg')];
    const index = list.indexOf(row);
    const next = event.key === 'Home' ? list[0] : event.key === 'End' ? list[list.length - 1] : list[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!next) return;
    event.preventDefault();
    row.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  }

  // Shared by the 2b-2 modules (marks, receipts, pins): the icons and the answer to a call that came back malformed.
  const PIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4l-.6 4 2.1 2.5H4.5L6.6 6.5zM8 9v4.5"/></svg>';
  const CLOSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const NO_ANSWER = { code: '', reason: 'team_chat_answer_invalid' };
  // The elements of a message's row that open a popover, found when a press lands (a redraw replaces the row's nodes).
  function openerOf(rowOf, id, selector) {
    return () => { const row = rowOf(id); return row ? row.querySelectorAll(selector) : null; };
  }

  return { PIN_ICON, CLOSE_ICON, NO_ANSWER, openerOf, bodyHtml, bodyKey, listText, rowInnerHtml, threadLink, dayKey, dayLabel, timeText, lastSeenText, sameRun, toMs, isOwnMessage, pendingPosts, isOpenPost,
    relatedEntries, mentionKey, rowOf, patchRows, moveRowFocus, words };
});
