/* The team chat's writes for one shown channel (row 123, slice 2a-5b): post,
 * edit, delete, Retry and Delete of a failed outbox entry, and the plain call
 * the composer uses for drafts and typing. Each answers `{ ok, entry_id }` or a
 * failure, through the team store's bounded `call`, with the shown team's id.
 *
 * A post to a thread (2a-6a) carries its `thread_root_id`; one with files (2c) its `attachment_ids`.
 * A write holds a busy key while its call is in flight: a second ask with the
 * same key answers null and sends nothing (a double click sends once). `onBusy`
 * is told when a key a row draws (Retry, Dismiss, Delete) comes or goes.
 * Retry is a new request with the entry's own fields; the failed entry is
 * discarded only once that answers ok. A re-send that answered ok is
 * remembered (bounded), so a Retry after a refused discard only asks for the
 * discard again and never posts twice.
 *
 * Mentions travel inside the text as tokens (`<@member_...>`, `<@channel>`),
 * which the host reads; the composer and the edit box show them as `@Name`.
 * `toDisplay` turns tokens into names and records each in `names`; `toWire`
 * turns the recorded names back. Text in, text out: never markup. No DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-store'), require('../shell/renderer-settings-team-strings'));
    return;
  }
  root.rendererTeamChatWrites = factory(root.rendererTeamStore, root.rendererSettingsTeamStrings);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (teamStore, words) {
  'use strict';

  const TOKEN = /<@(member_[A-Za-z0-9_-]{1,64}|jenny|channel)>/g;
  const NO_ANSWER = { code: '', reason: 'team_chat_answer_invalid' };
  const SHOWN_KEY = /^(retry|discard|delete):/;
  const RESENT_KEEP = 100;
  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // `nameOf(id)` answers '' for someone not known here. Such a token, or one whose shown name already
  // stands for another token, stays as written, so it goes back byte for byte.
  function toDisplay(text, nameOf, names) {
    return String(text || '').replace(TOKEN, (token, id) => {
      const name = nameOf(id);
      if (!name) return token;
      const shown = '@' + name;
      if (names.has(shown) && names.get(shown) !== token) return token;
      names.set(shown, token);
      return shown;
    });
  }
  // The longest name first, and only where the name ends (not inside a longer word).
  function toWire(text, names) {
    let out = String(text || '');
    for (const [shown, token] of [...names].sort((a, b) => b[0].length - a[0].length)) {
      out = out.replace(new RegExp(escapeRe(shown) + '(?![\\p{L}\\p{N}_])', 'gu'), token);
    }
    return out;
  }
  // The ids a text mentions, once each, in order (a queued post's mentions before the host lists them).
  function tokenIds(text) { return [...new Set(Array.from(String(text || '').matchAll(TOKEN), (match) => match[1]))]; }
  function failText(answer) { return words.errorText((answer && answer.error) || NO_ANSWER); }
  // A key that belongs to text composition (an IME): Enter and Esc then confirm or cancel the composition.
  function isComposing(event) { return Boolean(event.isComposing || event.keyCode === 229); }
  function isPlainEnter(event) { return event.key === 'Enter' && !event.shiftKey && !isComposing(event); }
  // Esc that closes something: not one that cancels a composition, not one something else took.
  function isCloseKey(event) { return event.key === 'Escape' && !event.defaultPrevented && !isComposing(event); }

  // One payload per operation, for a first send and for Retry alike.
  const OPERATIONS = {
    post: (f) => ['chatPost', { channel_id: f.channel_id, text: f.text, ...(f.thread_root_id ? { thread_root_id: f.thread_root_id } : {}),
      ...(Array.isArray(f.attachment_ids) && f.attachment_ids.length ? { attachment_ids: f.attachment_ids } : {}) }],
    edit: (f) => ['chatEdit', { channel_id: f.channel_id, message_id: f.message_id, text: f.text, expected_rev: f.rev }],
    delete: (f) => ['chatDelete', { channel_id: f.channel_id, message_id: f.message_id }],
  };

  function createWrites({ teamId, onBusy = null }) {
    const busy = new Set();
    const resent = new Set(); // failed entries whose re-send answered ok (oldest first)
    let disposed = false;

    function call(method, payload) {
      return teamStore.getTeamStore().call(method, { team_id: teamId, ...payload });
    }
    function send(operation, fields) {
      const [method, payload] = OPERATIONS[operation](fields);
      return call(method, payload);
    }

    function tell(key) { if (!disposed && onBusy && SHOWN_KEY.test(key)) onBusy(); }

    async function guarded(key, run) {
      if (busy.has(key)) return null;
      busy.add(key);
      tell(key);
      try {
        return await run();
      } finally {
        busy.delete(key);
        tell(key);
      }
    }

    async function discard(entryId) {
      const answer = await call('chatOutboxDiscard', { entry_id: entryId });
      if (answer.ok) resent.delete(entryId);
      return answer;
    }

    return {
      call,
      isBusy: (key) => busy.has(key),
      wasResent: (entryId) => resent.has(entryId),
      // `attachmentIds` (slice 2c): files staged for this post, in chip order; such a post is never queued (main).
      post: (channelId, text, threadRootId = null, attachmentIds = null) => guarded('post' + (threadRootId ? ':' + threadRootId : ''),
        () => send('post', { channel_id: channelId, text, thread_root_id: threadRootId, attachment_ids: attachmentIds })),
      edit: (channelId, messageId, text, rev) => guarded('edit:' + messageId, () => send('edit', { channel_id: channelId, message_id: messageId, text, rev })),
      remove: (channelId, messageId) => guarded('delete:' + messageId, () => send('delete', { channel_id: channelId, message_id: messageId })),
      discard: (entryId) => guarded('discard:' + entryId, () => discard(entryId)),
      // `rev` is the message's revision now, so an edit replaces whatever it conflicted with.
      retry: (entry, rev) => guarded('retry:' + entry.entry_id, async () => {
        if (!resent.has(entry.entry_id)) {
          const answer = await send(entry.operation, { ...entry, rev });
          if (!answer.ok) return answer;
          resent.add(entry.entry_id);
          if (resent.size > RESENT_KEEP) resent.delete(resent.values().next().value);
        }
        return discard(entry.entry_id);
      }),
      dispose() { disposed = true; },
    };
  }

  return { createWrites, toDisplay, toWire, tokenIds, failText, isPlainEnter, isCloseKey };
});
