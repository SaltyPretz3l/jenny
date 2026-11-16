/* Chat search: the field in the Team tab's left column and the result list
 * that replaces the Channels and people lists while the field holds text. One
 * instance per frame (one shown team); a team change, a lock and dispose end
 * it, and a `cleared` team resets it.
 *
 * - Searching: `chatSearch` 300 ms after the last key with the trimmed query
 *   (the field takes 200 units), `limit` 20, no `channel_id` (in a direct
 *   conversation, its own: slice 2d). One call out,
 *   also across a clear; a newer query waits and only the latest is sent; an
 *   answer for an older query is dropped (one that the waiting query repeats
 *   serves it); a blank field sends nothing; the same query is not sent again
 *   unless asked (Load more, Try again, the retries below). A match that is
 *   not an object with string ids and a safe-integer seq is dropped.
 * - The list: "Messages" with the count ("+" while there is a next page), one
 *   button per match, newest first (author, day and time, "in a thread", the
 *   channel when it is not the shown one, the excerpt with every occurrence of
 *   the query marked), then "End of results." or Load more (the cursor, no
 *   duplicate rows). At most 200 matches; then it says to narrow the search.
 * - States, one quiet sentence in the list (`aria-live` on it alone): while
 *   asking "Searching…" (earlier results stay, dimmed); no matches; too fast
 *   (results stay, one retry after 3 s, one timer); offline (results stay,
 *   the host-state words, asked once when the team connects again with the
 *   query still there; a not-connected refusal that lands while the team is
 *   connected offers Try again instead); any other refusal with its reason and
 *   Try again. Presence and typing changes do not redraw the list.
 * - Keys: Down from the field to the first result, Up and Down between
 *   results, Up from the first back to the field, Enter or a click jumps (the
 *   result keeps `aria-current`), Esc in the field or on a result clears.
 *   Clearing (Esc or X) brings the lists back as they were and the focus to
 *   where it was before the search began, else to the field.
 * Host text is untrusted: names, excerpts, channel names and the query go
 * through `escapeHtml`; errors are said by translated reason only. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-message-row'), require('./renderer-team-chat-writes'));
    return;
  }
  root.rendererTeamSearch = factory(root.rendererTeamMessageRow, root.rendererTeamChatWrites);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (rows, chatWrites) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const WAIT_MS = 300;
  const RETRY_MS = 3000;
  const PAGE = 20;
  const MAX_QUERY = 200;
  const MAX_MATCHES = 200;
  const CLEAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const QUIET = new Set(['presence', 'typing']); // changes that leave the list as it is

  function inv() { return globalThis.inventory || {}; }
  // The text field is its own global (index.html loads it at start): the inventory barrel does not carry it.
  function textField(options) { return globalThis.inventoryTextField(options); }

  // The query as a case-insensitive pattern, built once per answer.
  const patternOf = (query) => new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  // What a match must be to be drawn (the host is untrusted).
  const isMatch = (m) => Boolean(m && typeof m === 'object' && typeof m.message_id === 'string' && typeof m.channel_id === 'string' && Number.isSafeInteger(m.seq));

  // The excerpt escaped, every match of `pattern` in a <mark> (matched on the raw text, so an escaped entity is never split).
  function markQuery(text, pattern) {
    const raw = String(text || '');
    let html = '';
    let last = 0;
    for (const m of raw.matchAll(pattern)) {
      html += escapeHtml(raw.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return html + escapeHtml(raw.slice(last));
  }

  // `root`: the search region; `lists`: the slot it replaces; `panel`: the column that scrolls. `ctx()` is the
  // frame's context; `call` the frame's bridge call (adds the team id); `hostWords()` the tab's words for the
  // connection; `onJump(match)` jumps; `onState()` when the field starts or stops holding a search.
  function createSearch({ root, lists, panel, ctx, call, hostWords, onJump, onState }) {
    const doc = root.ownerDocument;
    root.innerHTML = textField({ className: 'search-shell rail-search-field team-search', placeholder: jt('team.search.label', 'Search messages'),
      ariaLabel: jt('team.search.label', 'Search messages'), spellcheck: false })
      + '<div class="team-results" role="region" aria-label="' + escapeHtml(jt('team.search.results', 'Search results')) + '">'
      + '<div class="team-results__rows"></div><p class="team-results__note" aria-live="polite"></p><div class="team-results__foot"></div></div>';
    const input = root.querySelector('.inv-text-field-control');
    input.setAttribute('autocomplete', 'off');
    input.maxLength = MAX_QUERY;
    const label = root.querySelector('.team-search');
    label.insertAdjacentHTML('beforeend', inv().actionButton({ plain: true, className: 'team-icon-btn team-search__clear', title: jt('team.search.clear', 'Clear the search (Esc)'),
      ariaLabel: jt('team.search.clearLabel', 'Clear the search'), dataset: { 'team-search': 'clear' }, trustedHtml: CLEAR }));
    const clearButton = root.querySelector('.team-search__clear');
    const region = root.querySelector('.team-results');
    const rowsBox = root.querySelector('.team-results__rows');
    const noteBox = root.querySelector('.team-results__note');
    const foot = root.querySelector('.team-results__foot');
    clearButton.hidden = true;
    region.hidden = true;

    let gen = 0; // bumped by a clear, a reset and dispose: an answer from before is not drawn
    let wanted = ''; // the latest query asked for
    let flight = null; // { gen, query, cursor }: the call out now; a clear does not forget it (the host allows one)
    let queued = null; // the one waiting for it
    let found = null; // { query, pattern, matches, next, capped }
    let status = 'idle'; // idle | searching | rate | offline | error
    let error = null;
    let lastFailed = null; // { cursor }: what Try again asks with `wanted`
    let current = ''; // the message id of the result jumped to last
    let before = null; // the element focused before the search began
    let panelTop = 0;
    let wait = null;
    let retry = null;
    let wasOnline = Boolean(ctx().online);
    let disposed = false;
    let drawnRows = '';

    const active = () => !region.hidden;
    const resultRows = () => [...rowsBox.querySelectorAll('.team-result')];

    function stopTimers() { clearTimeout(wait); clearTimeout(retry); wait = null; retry = null; }

    function rowHtml(match, c) {
      const where = [];
      if (match.channel_id !== c.channelId) where.push(c.channelTitleOf(match.channel_id));
      if (match.root_id) where.push(jt('team.search.inThread', 'in a thread'));
      const when = [rows.dayLabel(rows.dayKey(match.created_at)), rows.timeText(match.created_at)].filter(Boolean).join(' ');
      return inv().actionButton({ plain: true, className: 'team-row--link team-result', tabIndex: -1, title: jt('team.link.go', 'Go to this message'), dataset: { 'message-id': match.message_id },
        trustedHtml: '<span class="team-result__top"><span class="team-result__who" dir="auto">' + escapeHtml(c.author(match.author).name) + '</span>'
          + '<time class="team-result__when">' + escapeHtml(when) + '</time>'
          + (where.length ? '<span class="team-result__where" dir="auto">' + escapeHtml(where.join(' · ')) + '</span>' : '') + '</span>'
          + '<span class="team-result__text" dir="auto">' + markQuery(match.excerpt, found.pattern) + '</span>' });
    }

    function noteHtml() {
      const strong = (head, rest) => '<b>' + escapeHtml(head) + '</b>' + (rest ? ' ' + escapeHtml(rest) : '');
      if (status === 'searching') return escapeHtml(jt('team.search.searching', 'Searching…'));
      if (status === 'rate') return escapeHtml(jt('team.search.tooFast', 'Searching too fast. It goes on by itself in a moment.'));
      if (status === 'offline') return strong(jt('team.search.offline', 'Search needs the host.'), hostWords());
      if (status === 'error') return escapeHtml(chatWrites.failText({ error }));
      if (!found) return '';
      if (!found.matches.length) {
        return strong(jt('team.search.none', 'No messages match "{query}".', { query: found.query }),
          jt('team.search.noneHelp', 'Search looks at the text of messages in the channels you can read. Deleted messages are left out.'));
      }
      if (found.capped) return escapeHtml(jt('team.search.capped', 'The first 200 matches are shown. Narrow the search to find the rest.'));
      return found.next ? '' : escapeHtml(jt('team.search.end', 'End of results.'));
    }

    function footHtml() {
      if (status === 'error') return inv().actionButton({ label: jt('team.chat.tryAgain', 'Try again'), size: 'sm', className: 'team-results__more', dataset: { 'team-search': 'retry' } });
      if (status === 'idle' && found && found.next && !found.capped) {
        return inv().actionButton({ label: jt('team.search.more', 'Load more'), size: 'sm', className: 'team-results__more', dataset: { 'team-search': 'more' } });
      }
      return '';
    }

    // Brings the list to the state; the rows are rewritten only when they changed, keeping the focused result.
    function draw() {
      if (disposed) return;
      const c = ctx();
      const list = found ? found.matches : [];
      const count = found ? '<h3 class="team-panel__label"><span>' + escapeHtml(jt('team.search.heading', 'Messages')) + '</span><span>'
        + escapeHtml(String(list.length) + (found.next && !found.capped ? '+' : '')) + '</span></h3>' : '';
      const html = count + list.map((match) => rowHtml(match, c)).join('');
      if (html !== drawnRows) {
        const focusedId = doc.activeElement && doc.activeElement.classList && doc.activeElement.classList.contains('team-result') ? doc.activeElement.dataset.messageId : '';
        rowsBox.innerHTML = html;
        drawnRows = html;
        const again = focusedId && resultRows().find((el) => el.dataset.messageId === focusedId);
        if (again) again.focus();
      }
      const all = resultRows();
      const tabStop = all.find((el) => el.dataset.messageId === current) || all[0];
      for (const row of all) {
        if (row.dataset.messageId === current) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
        row.tabIndex = row === tabStop ? 0 : -1; // one tab stop
      }
      const note = noteHtml();
      if (noteBox.innerHTML !== note) noteBox.innerHTML = note;
      const more = footHtml();
      if (foot.innerHTML !== more) foot.innerHTML = more;
      if (status === 'searching' && found) region.dataset.busy = 'true'; else delete region.dataset.busy;
    }

    // Shows or hides the list in place of the lists, keeping the column's scroll for when they come back.
    function setActive(on) {
      if (on === active()) return;
      if (on) panelTop = panel.scrollTop;
      region.hidden = !on;
      lists.hidden = on;
      clearButton.hidden = !on;
      if (!on) panel.scrollTop = panelTop;
      onState();
    }

    // Asks `query` (with `cursor`, a next page). `force`: also the query already asked.
    function ask(query, { cursor = null, force = false } = {}) {
      if (disposed) return;
      if (!force && !cursor && query === wanted && (flight || found || status !== 'idle')) return;
      wanted = query;
      clearTimeout(retry);
      retry = null;
      if (!cursor) error = null;
      if (!ctx().online) { status = 'offline'; draw(); return; }
      status = 'searching';
      if (flight) { queued = { query, cursor }; draw(); return; }
      send(query, cursor);
      draw();
    }

    async function send(query, cursor) {
      const mine = { gen, query, cursor };
      flight = mine;
      const scope = ctx().direct ? { channel_id: ctx().channelId } : {};
      const answer = await call('chatSearch', { query, limit: PAGE, ...scope, ...(cursor ? { cursor } : {}) });
      if (disposed) return;
      flight = null;
      const latest = mine.gen === gen;
      const next = queued;
      queued = null;
      // The ask that waited goes now, unless it repeats this one: then this answer serves it.
      if (next && !(latest && next.query === query && next.cursor === cursor)) { send(next.query, next.cursor); return; }
      if (!latest || query !== wanted) return;
      if (answer && answer.ok && Array.isArray(answer.matches)) {
        const held = cursor && found && found.query === query ? found.matches : [];
        const seen = new Set(held.map((m) => m.message_id));
        const matches = held.concat(answer.matches.filter((m) => isMatch(m) && !seen.has(m.message_id) && seen.add(m.message_id)));
        const capped = matches.length >= MAX_MATCHES && (matches.length > MAX_MATCHES || Boolean(answer.next_cursor));
        found = { query, pattern: patternOf(query), matches: matches.slice(0, MAX_MATCHES), next: answer.next_cursor || null, capped };
        status = 'idle';
      } else {
        const reason = answer && answer.error ? answer.error.reason : '';
        if (reason === 'team_chat_rate_limit') {
          status = 'rate';
          retry = setTimeout(() => { retry = null; ask(query, { cursor, force: true }); }, RETRY_MS);
        } else if (reason === 'team_not_connected' && !ctx().online) status = 'offline';
        else { status = 'error'; error = (answer && answer.error) || null; } // connected again already: Try again
        lastFailed = { cursor };
      }
      draw();
    }

    function onInput() {
      clearTimeout(wait);
      wait = null;
      const query = input.value.trim();
      if (!query) { drop(); return; }
      setActive(true);
      wait = setTimeout(() => { wait = null; ask(query); }, WAIT_MS);
    }

    // Forgets the search: the query asked, the results, the timers and the query waiting. A call still out stays
    // out (its answer is not drawn): the next query waits for it.
    function drop() {
      gen += 1;
      stopTimers();
      queued = null;
      found = null;
      wanted = '';
      status = 'idle';
      error = null;
      current = '';
      drawnRows = '';
      rowsBox.innerHTML = '';
      draw();
      setActive(false);
    }

    function clear() {
      const back = before;
      before = null;
      input.value = '';
      drop();
      if (back && back.isConnected && !root.contains(back) && typeof back.focus === 'function') back.focus(); else input.focus();
    }

    function choose(row) {
      const match = found && found.matches.find((m) => m.message_id === row.dataset.messageId);
      if (!match) return;
      current = match.message_id;
      draw();
      onJump(match);
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-team-search], .team-result') : null;
      if (!target || !root.contains(target)) return;
      if (target.classList.contains('team-result')) { choose(target); return; }
      const action = target.dataset.teamSearch;
      if (action === 'clear') clear();
      else if (action === 'more' && found && found.next) ask(found.query, { cursor: found.next, force: true });
      else if (action === 'retry' && lastFailed && wanted) ask(wanted, { cursor: lastFailed.cursor, force: true });
    }

    function onKeydown(event) {
      const result = event.target && event.target.classList && event.target.classList.contains('team-result') ? event.target : null;
      if (event.target !== input && !result) return;
      if (event.key === 'Escape') {
        if (!chatWrites.isCloseKey(event) || (!result && !input.value)) return;
        event.preventDefault();
        clear();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const list = resultRows();
      if (event.key === 'ArrowDown') {
        const next = result ? list[list.indexOf(result) + 1] : list[0];
        if (next) { event.preventDefault(); next.focus(); }
      } else if (event.key === 'ArrowUp' && result) {
        event.preventDefault();
        (list[list.indexOf(result) - 1] || input).focus();
      } else if (result && chatWrites.isPlainEnter(event)) {
        event.preventDefault();
        choose(result);
      }
    }

    // The element focused before the search began, when the field is entered from elsewhere.
    function onFocus(event) {
      const from = event.relatedTarget;
      if (!active() && from && from !== doc.body && !root.contains(from)) before = from;
    }

    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);

    return {
      active,
      // Ctrl+F and the header button: the field focused with its text selected; `from` had the focus.
      focus(from) {
        if (disposed) return;
        if (!active() && from && from !== doc.body && !root.contains(from)) before = from;
        input.focus();
        input.select();
      },
      focusTarget: () => input,
      // A match held in the results, as a message reads (for a chip's words).
      messageOf(id) {
        const match = found && found.matches.find((m) => m.message_id === id);
        return match ? { id, author: match.author, created_at: match.created_at, text: match.excerpt, deleted: null } : null;
      },
      // A chat change for this frame's team: `cleared` resets; connected again asks an offline search once.
      update(change) {
        if (disposed) return;
        if (change && change.type === 'cleared') { input.value = ''; before = null; drop(); return; }
        const online = Boolean(ctx().online);
        const back = online && !wasOnline;
        wasOnline = online;
        if (back && status === 'offline' && wanted && input.value.trim() === wanted) { ask(wanted, { force: true }); return; }
        if (active() && !(change && QUIET.has(change.type))) draw();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        gen += 1;
        stopTimers();
        input.removeEventListener('input', onInput);
        input.removeEventListener('focus', onFocus);
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
      },
    };
  }

  return { createSearch };
});
