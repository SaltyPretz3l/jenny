/* A message's earlier versions and "Seen by" (row 123, slice 2b-2), for one shown channel's timeline or thread
 * column; made by the message actions (renderer-team-message-actions.js).
 *
 * - "edited" opens the earlier versions from `chatEdits` (online only): oldest first, each with its time and its
 *   text drawn through the same sanitized Markdown path as a message body. The first reads "Original, {time}" only
 *   when the list was not cut for size and its time is the message's `created_at`; ten versions without the
 *   original say the host keeps the last ten; a list cut for size says so. Asked again at each open.
 * - "Seen by" sits under your own latest live message in the channel's timeline, never in a thread, from the
 *   channel row's `reads` (other members' read positions): seen = a position at or above the message's seq. Where
 *   the audience is known (the team channel: every listed member but you; a direct conversation: its other
 *   participants; slice 2b-3, a project channel whose row names its `audience`: those listed members but you) it says
 *   "Seen by {n} of {m}", "Seen by everyone", and "Seen" for one other person; where it is not (a project row without
 *   an audience) it names who, three at most. Except for "Seen", the words open the lists "Seen by" and
 *   "Not yet". A position can move down, so the number can fall. Nothing is drawn until someone has read it.
 * Host text is untrusted: names and words through `escapeHtml`; a version's text only through `rows.bodyHtml`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-message-row'));
    return;
  }
  root.rendererTeamReceipts = factory(root.rendererSettingsTeamStrings, root.rendererTeamMessageRow);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, rows) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const VERSIONS_KEPT = 10;
  const NAMED_MAX = 3;
  const CLOSE = rows.CLOSE_ICON;
  const NO_ANSWER = rows.NO_ANSWER;

  function inv() { return globalThis.inventory || {}; }

  // `ctx()`: the tab's context. `writes.call`: the bounded bridge call. `pop`: the popover. `rowOf(id)`: a message's row.
  function createReceipts({ chat, teamId, channelId, ctx, writes, pop, rowOf }) {
    let turn = 0;
    let disposed = false;

    function focusOf(id, selector) {
      return () => { const row = rowOf(id); const el = row && (row.querySelector(selector) || row); if (el) el.focus(); };
    }

    // ------------------------------------------------------------ earlier versions

    function versionsBody(message, state, c, doc) {
      if (state.loading) return '<p class="team-pop__note">' + escapeHtml(jt('team.hist.loading', 'Loading earlier versions…')) + '</p>';
      if (state.error) {
        return '<p class="team-pop__note" data-tone="danger">' + escapeHtml(jt('team.hist.failed', 'The earlier versions could not be loaded. {reason}', { reason: words.errorText(state.error) })) + '</p>'
          + '<p class="team-pop__note">' + inv().actionButton({ label: jt('team.chat.tryAgain', 'Try again'), size: 'sm', dataset: { 'team-hist-action': 'retry' } }) + '</p>';
      }
      const original = !state.trimmed && state.edits.length > 0 && rows.toMs(state.edits[0].edited_at) === rows.toMs(message.created_at);
      const list = state.edits.map((entry, i) => {
        const time = words.formatTime(rows.toMs(entry.edited_at));
        const label = original && i === 0 ? jt('team.hist.original', 'Original, {time}', { time }) : jt('team.hist.edited', 'Edited {time}', { time });
        return '<div class="team-ver"><div class="team-ver__when">' + escapeHtml(label) + '</div><div class="team-ver__text" dir="auto">'
          + rows.bodyHtml(entry.text, message.mentions, c, doc) + '</div></div>';
      }).join('');
      const note = state.trimmed ? jt('team.hist.trimmed', 'Older versions are too long to show here.')
        : (!original && state.edits.length >= VERSIONS_KEPT ? jt('team.hist.kept', 'A message keeps its last 10 versions. Older ones are gone.') : '');
      return list + (note ? '<p class="team-pop__note team-pop__note--end">' + escapeHtml(note) + '</p>' : '');
    }

    function versionsHtml(message, state, c, doc) {
      const close = jt('team.dm.close', 'Close (Esc)');
      return '<h3 class="team-pop__head">' + escapeHtml(jt('team.hist.heading', 'Earlier versions'))
        + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: close, title: close, dataset: { 'team-hist-action': 'close' }, trustedHtml: CLOSE }) + '</h3>'
        + '<p class="team-pop__note">' + escapeHtml(jt('team.hist.audience', 'Everyone who can read this conversation can see these.')) + '</p>'
        + versionsBody(message, state, c, doc);
    }

    async function loadVersions(message, key) {
      const mine = ++turn;
      const c = ctx();
      const doc = (rowOf(message.id) || { ownerDocument: globalThis.document }).ownerDocument;
      const answer = await writes.call('chatEdits', { channel_id: channelId, message_id: message.id });
      if (disposed || mine !== turn || !pop.isOpen(key)) return;
      const ok = answer && answer.ok && Array.isArray(answer.edits);
      pop.set(versionsHtml(message, ok ? { edits: answer.edits.filter((e) => e && typeof e.text === 'string'), trimmed: answer.trimmed === true }
        : { error: (answer && answer.error) || NO_ANSWER }, c, doc));
    }

    function openVersions(message, anchor) {
      if (!message || message.deleted || !ctx().online) return;
      const key = 'hist:' + message.id;
      if (pop.isOpen(key)) { pop.close(); return; }
      const c = ctx();
      const doc = anchor.ownerDocument;
      const el = pop.open({ key, className: 'team-pop--hist', label: jt('team.hist.heading', 'Earlier versions'), html: versionsHtml(message, { loading: true }, c, doc),
        anchor, keep: rows.openerOf(rowOf, message.id, '[data-team-msg-action="versions"]'), restore: focusOf(message.id, '[data-team-msg-action="versions"]') });
      if (!el) return;
      el.addEventListener('click', (event) => {
        const control = event.target.closest && event.target.closest('[data-team-hist-action]');
        if (!control) return;
        if (control.dataset.teamHistAction === 'close') pop.close();
        else { pop.set(versionsHtml(message, { loading: true }, ctx(), doc)); void loadVersions(message, key); }
      });
      const close = el.querySelector('[data-team-hist-action="close"]');
      if (close) close.focus();
      void loadVersions(message, key);
    }

    // ------------------------------------------------------------ seen by

    // Who the channel's audience is without you, or null where this PC is not told (a project row without one).
    function audienceOf(record, c) {
      // A custom channel has the team channel's audience: everyone on the team (row 173).
      if (record && (record.kind === 'team' || record.kind === 'channel')) return c.people.map((p) => p.member_id).filter((id) => id !== c.me);
      // In the listed order, as the team channel: anyone the row names who is no longer listed is left out.
      if (record && record.kind === 'project' && Array.isArray(record.audience)) {
        return c.people.map((p) => p.member_id).filter((id) => id !== c.me && record.audience.includes(id));
      }
      if (record && record.kind === 'dm' && Array.isArray(record.participants)) return record.participants.filter((id) => id !== c.me);
      return null;
    }

    // { readers, audience, text, plain } for a message, or null when nobody has read it.
    function seenOf(message, c) {
      const record = chat.channel(teamId, channelId);
      const audience = audienceOf(record, c);
      const reads = record && Array.isArray(record.reads) ? record.reads : [];
      const readers = [...new Set(reads.filter((r) => r && typeof r.member_id === 'string' && r.member_id !== c.me && Number.isSafeInteger(r.seq) && r.seq >= message.seq
        && (!audience || audience.includes(r.member_id))).map((r) => r.member_id))];
      if (!readers.length) return null;
      const plain = Boolean(audience) && record.kind === 'dm' && audience.length === 1;
      let text;
      if (plain) text = jt('team.seen.one', 'Seen');
      else if (audience && audience.length && readers.length >= audience.length) text = jt('team.seen.everyone', 'Seen by everyone');
      else if (audience && audience.length) text = jtn('team.seen.ofm', readers.length, { total: audience.length }, 'Seen by {count} of {total}', 'Seen by {count} of {total}');
      else {
        const names = readers.map((id) => c.nameOf(id));
        text = readers.length <= NAMED_MAX ? jt('team.seen.names', 'Seen by {names}', { names: rows.listText(names) })
          : jtn('team.seen.others', readers.length - 2, { first: names[0], second: names[1] }, 'Seen by {first}, {second} and {count} other', 'Seen by {first}, {second} and {count} others');
      }
      return { readers, audience, text, plain };
    }

    // The words under your own latest message: a button that opens the lists, or plain words for one other person.
    function seenHtml(message, c) {
      const seen = seenOf(message, c);
      if (!seen) return '';
      if (seen.plain) return '<span class="team-seen">' + escapeHtml(seen.text) + '</span>';
      return inv().actionButton({ plain: true, className: 'team-seen', title: seen.text, ariaHaspopup: 'dialog', dataset: { 'team-msg-action': 'seen' }, trustedHtml: escapeHtml(seen.text) });
    }

    function openSeen(message, anchor) {
      const c = ctx();
      const seen = message && !message.deleted ? seenOf(message, c) : null;
      const key = 'seen:' + (message && message.id);
      if (!seen) return;
      if (pop.isOpen(key)) { pop.close(); return; }
      const line = (head, ids) => '<p><b>' + escapeHtml(head) + '</b> ' + escapeHtml(rows.listText(ids.map((id) => c.nameOf(id)))) + '</p>';
      const notYet = seen.audience ? seen.audience.filter((id) => !seen.readers.includes(id)) : [];
      const el = pop.open({ key, className: 'team-pop--seen', label: jt('team.seen.heading', 'Seen by'),
        html: line(jt('team.seen.heading', 'Seen by'), seen.readers) + (notYet.length ? line(jt('team.seen.notYet', 'Not yet'), notYet) : ''),
        anchor, keep: rows.openerOf(rowOf, message.id, '[data-team-msg-action="seen"]'), restore: focusOf(message.id, '.team-seen') });
      if (el) { el.tabIndex = -1; el.focus(); }
    }

    return {
      seenHtml, openVersions, openSeen,
      dispose() { disposed = true; turn += 1; },
    };
  }

  return { createReceipts };
});
