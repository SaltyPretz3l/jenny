/* Team tab: Find in a shared project conversation (row 175, item 8, owner decision D15; mockup team-find-bar, variant A).
 * The bar is the local chat's own (renderer/inventory/search-bar.js, `.chat-search-bar*`) and the matches are painted with
 * the same CSS Custom Highlight names (`chat-search-match`, `chat-search-current`): no message text is rewritten.
 *
 * Closed: a magnifier ends the conversation head. Open: the field takes the title's place in the head (`data-find-open`).
 * The count covers the channel rows and Jenny's work together, in reading order (a turn's reasoning and tool output come
 * before her answer): one number, '3 of 17'. Stepping onto a match inside her work opens the transcript popover on that turn
 * with only that row open (`openTurn`, which never moves the focus); the popover's copy of the prompt and answer is painted
 * but not counted again. Closing find keeps the query and leaves an open popover open. History not loaded yet: '+' on the
 * count and a quiet line under the head with one Load earlier button (one page, never automatic).
 *
 * Matching is case-insensitive unless Aa is on, Unicode-aware (whole word means no letter, digit or underscore beside it),
 * over rendered text only: a channel row's body, a reasoning row as its Markdown renders, a tool row's output. Limit: text
 * Jenny said between tool calls (not her last words) and a running turn's unsaved words are not searched.
 *
 * `createFind({ root, scroller, turns(), markdown(text), toLocal(messages), more(), earlier(), redrawHead(), openTurn(id, ref) })`
 * -> { head(), attach(region, hadFocus), focused(), open(), close(), refresh(), isOpen(), dispose() }. The controller owns
 * no conversation state; it draws the head's find parts through `head()` and puts the bar into the slot after each head write. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamProjectFind = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // A module: the app's global, or under Node the file (in the app `require` is the editor's loader and throws).
  function load(globalName, path) {
    if (globalThis[globalName]) return globalThis[globalName];
    try { return typeof require === 'function' ? require(path) || null : null; } catch (_error) { return null; }
  }
  const escapeHtml = (load('stringUtils', '../shared/string-utils') || {}).escapeHtml || ((v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const searchBarApi = () => load('inventorySearchBar', '../inventory/search-bar');
  const highlightApi = () => load('rendererChatSearchHighlight', '../chat/renderer-chat-search-highlight');
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);

  const NAME_ALL = 'chat-search-match';
  const NAME_CURRENT = 'chat-search-current';
  const SEED_MAX = 200;
  const WORD = '[\\p{L}\\p{N}_]';
  const FIND_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
  const ROWS = '[data-conv-region="log"] .team-msg, [data-conv-region="live"] .team-msg';
  const BODIES = '[data-conv-region="log"] .team-msg .team-msg__text, [data-conv-region="live"] .team-msg .team-msg__text';

  // The query as one global pattern, or null when there is nothing to look for.
  function patternOf(query, { caseSensitive, wholeWord }) {
    const text = String(query || '').trim();
    if (!text) return null;
    let source = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) source = '(?<!' + WORD + ')' + source + '(?!' + WORD + ')';
    try { return new RegExp(source, caseSensitive ? 'gu' : 'giu'); } catch (_error) { return null; }
  }
  const countIn = (text, re) => { let n = 0; for (const m of String(text).matchAll(re)) if (m[0]) n += 1; return n; };

  function createFind(o) {
    const { root } = o;
    const doc = root.ownerDocument;
    const st = { open: false, query: '', curKey: '', cur: 0, tried: false, region: null };
    const works = new WeakMap(); // a turn's saved messages -> its work rows
    let bar = null;
    let slotted = null;
    let list = [];
    let disposed = false;
    let refreshTimer = null;
    const REFRESH_MS = 250;

    const hl = () => highlightApi();
    const registry = () => { const win = doc.defaultView; return win && win.CSS && win.CSS.highlights && typeof win.Highlight === 'function' ? win : null; };
    const barRoot = () => (slotted && slotted.firstElementChild) || null;
    const inputEl = () => (barRoot() ? barRoot().querySelector('.chat-search-bar-input') : null);
    const popBody = () => root.querySelector('[data-conv-region="pop"] .team-turn-pop__scroll');
    const textOf = (el) => (hl() ? hl().collectSearchableText(el) : { text: '', segments: [] });
    const patternNow = () => (bar ? patternOf(bar.getQuery(), { caseSensitive: bar.getCaseSensitive(), wholeWord: bar.getWholeWord() }) : null);

    // ------------------------------------------------------------ matching

    // The ranges of every match in an element's visible text, in order.
    function rangesIn(el, re) {
      const { text, segments } = textOf(el);
      const out = [];
      const at = (offset) => segments.find((s) => offset >= s.start && offset < s.end);
      for (const m of text.matchAll(re)) {
        const from = m[0] ? at(m.index) : null;
        const to = from ? at(m.index + m[0].length - 1) : null;
        if (!to) continue;
        const range = doc.createRange();
        range.setStart(from.node, m.index - from.start);
        range.setEnd(to.node, m.index + m[0].length - to.start);
        out.push(range);
      }
      return out;
    }

    // A turn's work rows with the text each draws: a reasoning row as its Markdown renders, a tool row's output.
    function workOf(turn) {
      if (!turn.messages) return [];
      let rows = works.get(turn.messages);
      if (rows) return rows;
      const local = o.toLocal(turn.messages);
      const outputs = new Map(local.filter((m) => m.tool_result && m.tool_result.call_id).map((m) => [m.tool_result.call_id, String(m.tool_result.output_text || '')]));
      rows = [];
      for (const m of local) {
        const entries = m.reasoning && Array.isArray(m.reasoning.entries) ? m.reasoning.entries : [];
        if (entries.length) {
          const template = doc.createElement('template');
          template.innerHTML = o.markdown(entries.map((e) => e.text).join('\n\n'));
          rows.push({ kind: 'reason', id: m.id, text: textOf(template.content).text });
        }
        if (m.tool_call && m.tool_call.call_id) rows.push({ kind: 'tool', id: m.tool_call.call_id, text: outputs.get(m.tool_call.call_id) || '' });
      }
      works.set(turn.messages, rows);
      return rows;
    }

    // Every match in reading order: a turn's work, then her answer; a member's message. `key` names the row and `k` the match in it.
    function scan(re) {
      const found = [];
      if (!re || !hl()) return found;
      const turns = new Map(o.turns().map((t) => [t.id, t]));
      for (const row of root.querySelectorAll(ROWS)) {
        const turn = row.dataset.turnId ? turns.get(row.dataset.turnId) : null;
        const key = row.dataset.turnId ? 't:' + row.dataset.turnId : 'm:' + row.dataset.messageId;
        if (turn) {
          for (const w of workOf(turn)) {
            for (let k = 0, n = countIn(w.text, re); k < n; k += 1) found.push({ key: key + ':' + w.kind + ':' + w.id, k, work: { kind: w.kind, id: w.id }, turn: turn.id });
          }
        }
        const body = row.querySelector('.team-msg__text');
        if (body) for (let k = 0, n = rangesIn(body, re).length; k < n; k += 1) found.push({ key, k, row });
      }
      return found;
    }
    const keyOf = (m) => (m ? m.key + '#' + m.k : '');

    // The element a match lives in now: a channel row's body, or the open popover's row of that work.
    function hostOf(m) {
      if (!m.work) return m.row.querySelector('.team-msg__text');
      const body = popBody();
      const pop = root.querySelector('#teamTurnPop');
      if (!body || !pop || pop.dataset.turnId !== m.turn) return null;
      const attr = m.work.kind === 'tool' ? 'data-tool-call-id' : 'data-message-id';
      const hit = Array.from(body.querySelectorAll(m.work.kind === 'tool' ? '[data-tool-call-id]' : '[data-reasoning-toggle]')).find((n) => n.getAttribute(attr) === m.work.id);
      return hit ? hit.closest('[data-row-id]') || hit.closest('.reasoning-row-block') || hit : null;
    }

    // ------------------------------------------------------------ painting

    function clearPaint() {
      const win = registry();
      if (win) { win.CSS.highlights.delete(NAME_ALL); win.CSS.highlights.delete(NAME_CURRENT); }
    }
    function paint(re, scrollTo) {
      const win = registry();
      const now = list[st.cur] || null;
      if (!win || !re) { clearPaint(); return; }
      const all = [];
      for (const el of root.querySelectorAll(BODIES)) all.push(...rangesIn(el, re));
      if (popBody()) all.push(...rangesIn(popBody(), re));
      const host = now ? hostOf(now) : null;
      const current = host ? rangesIn(host, re)[now.k] : null;
      const mark = new win.Highlight(...all);
      const here = new win.Highlight(...(current ? [current] : []));
      here.priority = 1;
      win.CSS.highlights.set(NAME_ALL, mark);
      win.CSS.highlights.set(NAME_CURRENT, here);
      const target = current && current.startContainer.parentElement;
      if (scrollTo && target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    }

    // ------------------------------------------------------------ the bar and the note

    function setNote(show) {
      let note = st.region ? st.region.querySelector('.team-find-note') : null;
      if (!show) { if (note) note.remove(); return; }
      if (!note) { note = doc.createElement('p'); note.className = 'team-find-note'; note.setAttribute('role', 'status'); st.region.appendChild(note); }
      const rows = root.querySelectorAll(ROWS).length;
      const text = jt('team.find.note', 'Searched the {count} messages shown. Load earlier to search further.', { count: rows.toLocaleString() });
      const html = escapeHtml(text) + ' ' + actionButton({ plain: true, label: jt('team.find.earlier', 'Load earlier'), dataset: { 'find-action': 'earlier' } });
      if (note.dataset.html !== html) { note.innerHTML = html; note.dataset.html = html; }
    }
    function showCount(re) {
      if (!bar) return;
      const more = o.more();
      bar.setMatchInfo(st.cur + 1, list.length, { truncated: more });
      const el = barRoot() && barRoot().querySelector('.chat-search-bar-count');
      if (el && more && list.length) el.setAttribute('title', jt('team.find.moreTitle', 'There may be more in the earlier messages. Load earlier to search further.'));
      setNote(Boolean(re) && more && (list.length === 0 || st.tried));
    }

    // Everything again from the page as it is now: the list, where the current match is, the count, the paint.
    function update({ scrollTo = false } = {}) {
      if (!st.open || disposed) return;
      const re = patternNow();
      list = scan(re);
      const at = list.findIndex((m) => keyOf(m) === st.curKey);
      st.cur = at >= 0 ? at : Math.min(st.cur, Math.max(0, list.length - 1));
      st.curKey = keyOf(list[st.cur]);
      showCount(re);
      paint(re, scrollTo);
    }

    // Jenny's work opens where the match is; the popover and the focus are the controller's, the field keeps the focus.
    function reveal() {
      const m = list[st.cur];
      st.curKey = keyOf(m);
      if (m && m.work) o.openTurn(m.turn, m.work);
      update({ scrollTo: true });
    }
    function step(dir) {
      if (!list.length) return;
      if (dir < 0 && st.cur === 0 && o.more()) { st.tried = true; update(); return; }
      st.tried = false;
      st.cur = (st.cur + dir + list.length) % list.length;
      reveal();
    }
    async function loadEarlier() {
      st.tried = false;
      const field = inputEl();
      await o.earlier();
      if (field && !disposed && st.open) field.focus();
      update();
    }

    // A new query or option: back to the first match, which Jenny's work opens when it is the one.
    function restart() { st.cur = 0; st.curKey = ''; st.tried = false; update(); reveal(); }

    function build() {
      const api = searchBarApi();
      if (bar || !api) return Boolean(bar);
      bar = api.createSearchBar({ document: doc, hostId: 'team-find', extraKeys: ['F3', 'Shift+F3'] });
      bar.on('input', restart);
      bar.on('toggle-case', restart);
      bar.on('toggle-word', restart);
      bar.on('next', () => step(1));
      bar.on('prev', () => step(-1));
      bar.on('close', () => close());
      return true;
    }

    // The field again in the head after the head was written (its slot is new each time); focus goes back to it when it had it.
    function attach(region, hadFocus = false) {
      st.region = region;
      const slot = region.querySelector('[data-find-slot]');
      if (!st.open || !slot || !build()) { slotted = null; setNote(false); return; }
      slotted = slot;
      bar.mount(slot);
      const field = inputEl();
      field.placeholder = jt('team.find.placeholder', 'Find in this conversation');
      field.setAttribute('aria-label', jt('team.find.label', 'Search the messages and Jenny’s work in this conversation'));
      if (hadFocus) field.focus();
      update();
    }

    function seedOf() {
      const sel = doc.getSelection ? doc.getSelection() : null;
      const text = sel && !sel.isCollapsed ? String(sel).trim() : '';
      return text && text.length <= SEED_MAX && !/[\r\n]/.test(text) && sel.anchorNode && root.contains(sel.anchorNode) ? text : '';
    }
    function open() {
      if (disposed || !build()) return false;
      const seed = seedOf();
      const was = st.open;
      st.open = true;
      if (!was) o.redrawHead();
      if (inputEl()) bar.focusInput(true);
      if (seed) { bar.setQuery(seed); restart(); } else update();
      return true;
    }
    function close() {
      if (!st.open) return;
      st.open = false;
      st.tried = false;
      list = [];
      clearPaint();
      setNote(false);
      if (bar) bar.unmount();
      slotted = null;
      o.redrawHead();
      const toggle = root.querySelector('[data-project-action="find"]');
      if (toggle) toggle.focus({ preventScroll: true });
    }

    function onKeydown(event) {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        event.stopPropagation();
        open();
      } else if (event.key === 'F3' && st.open) {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    }
    function onClick(event) {
      const button = event.target && event.target.closest ? event.target.closest('[data-find-action="earlier"]') : null;
      if (button && root.contains(button)) { event.preventDefault(); void loadEarlier(); }
    }
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('click', onClick);

    return {
      // The head's find parts: whether the field is open, and the magnifier (closed) or the field's slot (open).
      head: () => ({ open: st.open, html: st.open ? '<div class="chat-find" data-find-slot></div>' : '<div class="team-head__actions">'
        + actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: jt('team.find.open', 'Find in this conversation (Ctrl+F)'), title: jt('team.find.open', 'Find in this conversation (Ctrl+F)'),
          dataset: { 'project-action': 'find' }, trustedHtml: FIND_ICON }) + '</div>' }),
      attach,
      focused: () => Boolean(barRoot() && barRoot().contains(doc.activeElement)),
      open,
      close,
      // A draw runs every 100 ms while Jenny streams: the page is searched again at most every REFRESH_MS.
      refresh() { if (st.open && !disposed && refreshTimer === null) refreshTimer = setTimeout(() => { refreshTimer = null; update(); }, REFRESH_MS); },
      isOpen: () => st.open,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
        root.removeEventListener('keydown', onKeydown);
        root.removeEventListener('click', onClick);
        clearPaint();
        if (bar) bar.dispose();
        bar = null;
      },
    };
  }

  return { createFind, patternOf, countIn };
});
