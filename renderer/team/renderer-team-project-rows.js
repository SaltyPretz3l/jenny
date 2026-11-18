/* Team tab: a shared conversation's log drawn as a channel (row 171). Every member message is a #team row
 * (renderer-team-message-row.js `rowInnerHtml`: avatar, name, time, Markdown body, runs of one author within 5 minutes
 * grouped, day dividers), and Jenny has one row per turn (renderer-team-project-timeline.js `groupTurns`): her avatar,
 * her name with the "model" tag, the controller's working chip line in the row's `lead` slot, and the turn's last text
 * as the body. The hover toolbar has Copy on a row with saved text and "Show work" on Jenny's rows; reactions, pins,
 * replies and edit are not here (the host has no route for them on a project conversation's messages).
 *
 * Text from the host is untrusted: names are cleaned of control, bidi and zero-width characters and escaped; a body
 * reaches the page only through the `markdown` the controller passes (the app's sanitized rendering). `lead` and `foot`
 * come from the controller as trusted markup. Each row's markup is kept by its id while what it draws stays the same,
 * and each body's Markdown by its text, so a chip that ticks every second does not render the text again. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-message-row'), require('./renderer-team-project-timeline'));
    return;
  }
  root.rendererTeamProjectRows = factory(root.rendererTeamMessageRow, root.rendererTeamProjectTimeline);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (row, tl) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // The inventory's button builder: the app's global, or under Node the module at first use (the app's `require` throws).
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);

  const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5v-7a1 1 0 0 1 1-1h7"/></svg>';
  const WORK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M9.5 3.5v9"/></svg>';
  const SEP = '\u0000';

  const str = (v) => (typeof v === 'string' ? v : '');
  const when = (v) => (typeof v === 'string' || typeof v === 'number' ? v : '');

  // `nameOf(memberId)`: the person's name ('' when not on the team); `markdown(text)`: the app's sanitized rendering;
  // `timeText(value)` and `dayLabel(dayKey)`: the #team row's words for a time and a day.
  function createRows({ nameOf, markdown, liveMarkdown = markdown, timeText, dayLabel }) {
    const cache = new Map(); // 'm:' or 't:' + id -> { key, html }
    const bodies = new Map(); // the same key -> { text, html }
    const nameFor = (id) => tl.clean(nameOf(id), 64);

    // As renderer-team-channels.js resolves an author, with the person's name ("Maya", not "You", as #team).
    function author(a) {
      if (a && a.kind === 'jenny') return { name: jt('team.conv.jenny', 'Jenny'), initial: 'J', jenny: true };
      const name = a && str(a.member_id) ? nameFor(a.member_id) : '';
      return name ? { name, initial: Array.from(name)[0] || '' } : { name: jt('team.chat.formerMember', 'Former member'), initial: '', former: true };
    }
    const ctx = { author, nameOf: nameFor };

    // An item as the row `rowInnerHtml` draws: the host message's `content` and `timestamp` as `text` and `created_at`.
    function shape(item, bodyOf) {
      if (item.kind === 'turn') {
        const messages = Array.isArray(item.messages) ? item.messages : [];
        const live = typeof bodyOf === 'function' ? bodyOf(item) : null;
        const text = typeof live === 'string' ? live : str(item.text);
        // Copy reads a saved message: the one whose words the row shows, not a live stream's.
        const spoken = text && text === item.text ? messages.findLast((m) => m && m.role === 'assistant' && m.content === text) : null;
        return { key: 't:' + str(item.id), id: str(item.id), attr: 'data-turn-id', turn: true, live: typeof live === 'string', copyId: spoken ? str(spoken.id) : '',
          message: { id: str(item.id), author: { kind: 'jenny' }, created_at: when((messages[0] || {}).timestamp) || when(item.startedAt), text, reply_count: 0 } };
      }
      const m = item.message;
      const text = str(m.content);
      const by = m.author && m.author.kind === 'member' ? str(m.author.member_id) : '';
      return { key: 'm:' + str(m.id), id: str(m.id), attr: 'data-message-id', turn: false, copyId: text ? str(m.id) : '',
        message: { id: str(m.id), author: { kind: 'member', member_id: by }, created_at: when(m.timestamp), text, reply_count: 0 } };
    }

    function body(key, text, live) {
      if (!text) return '';
      const hit = bodies.get(key);
      if (hit && hit.text === text) return hit.html;
      const html = String((live ? liveMarkdown : markdown)(text) || '');
      bodies.set(key, { text, html });
      return html;
    }

    function actsHtml(s) {
      const copyLabel = jt('team.conv.copy', 'Copy message');
      const workLabel = jt('team.turn.showWorkTitle', 'Show Jenny’s work');
      const work = s.turn ? actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: workLabel, title: workLabel, tabIndex: -1,
        dataset: { 'project-action': 'turn-open', 'turn-id': s.id }, trustedHtml: WORK_ICON }) : '';
      const copy = s.copyId ? actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: copyLabel, title: copyLabel, tabIndex: -1,
        dataset: { 'project-action': 'copy', 'message-id': s.copyId }, trustedHtml: COPY_ICON }) : '';
      if (!work && !copy) return '';
      return '<div class="team-acts" role="toolbar" aria-label="' + escapeHtml(jt('team.acts.label', 'Message actions')) + '">' + work + copy + '</div>';
    }

    return {
      // The whole log: `items` from groupTurns (and the controller's own member items); `leadOf(item)`, `footOf(item)`:
      // trusted markup or ''; `bodyOf(item)`: a turn's text to show instead of its saved one (the live stream's), or null;
      // `after`: the item drawn just before these in another region (its day and run carry on, no divider repeats).
      html(items, { leadOf, footOf, bodyOf, after } = {}) {
        let out = '';
        let prev = null;
        let day = '';
        if (after && (after.kind === 'turn' || (after.kind === 'member' && after.message))) {
          prev = shape(after, null).message;
          day = row.dayKey(prev.created_at);
        }
        for (const item of Array.isArray(items) ? items : []) {
          // Row 172: a quiet line (who changed Jenny's model or tools), the controller's trusted markup; the next row starts a run.
          if (item && item.kind === 'note') {
            const noteDay = row.dayKey(item.at);
            if (noteDay && noteDay !== day) { out += '<div class="team-day" role="separator">' + escapeHtml(dayLabel(noteDay)) + '</div>'; day = noteDay; }
            out += str(item.html);
            prev = null;
            continue;
          }
          if (!item || !(item.kind === 'turn' || (item.kind === 'member' && item.message && typeof item.message === 'object'))) continue;
          const s = shape(item, bodyOf);
          const dayKey = row.dayKey(s.message.created_at);
          if (dayKey && dayKey !== day) { out += '<div class="team-day" role="separator">' + escapeHtml(dayLabel(dayKey)) + '</div>'; day = dayKey; prev = null; }
          // Jenny's row always starts a run.
          const first = s.turn || !row.sameRun(prev, s.message);
          const lead = typeof leadOf === 'function' ? String(leadOf(item) || '') : '';
          const foot = typeof footOf === 'function' ? String(footOf(item) || '') : '';
          const who = author(s.message.author);
          const key = [first, who.name, who.former ? 1 : 0, s.message.created_at, timeText(s.message.created_at), s.message.text, s.copyId, lead, foot].join(SEP);
          const hit = cache.get(s.key);
          if (hit && hit.key === key) out += hit.html;
          else {
            const inner = row.rowInnerHtml({ message: s.message, first, lead, body: body(s.key, s.message.text, s.live), foot, acts: actsHtml(s) }, ctx);
            const html = '<div class="team-msg" data-first="' + first + '" ' + s.attr + '="' + escapeHtml(s.id) + '" tabindex="-1">' + inner + '</div>';
            cache.set(s.key, { key, html });
            out += html;
          }
          prev = s.message;
        }
        return out;
      },
      // Only the rows with these ids (message ids and turn ids) keep their markup.
      keep(ids) {
        const kept = new Set(Array.isArray(ids) ? ids : []);
        for (const key of [...cache.keys()]) if (!kept.has(key.slice(2))) { cache.delete(key); bodies.delete(key); }
      },
      size: () => cache.size,
      clear() { cache.clear(); bodies.clear(); },
    };
  }

  return { createRows };
});
