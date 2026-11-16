/* Team tab: the "GPUs" section of the left column and its popover (row 123, slice 4e; the owner's
 * picks in picks_4e.md, surface 3). Between the conversations and Online/Offline, one row per shared
 * GPU: a presence dot and a state word (ready has none, then busy, paused, offline), the name
 * "{owner}'s {PC name}" or "{PC name} (this PC)", and "{ready or busy} of {all}" on the label. The
 * section is not drawn while nobody shares a GPU; the team menu then offers "Share this PC's GPU…".
 * A row opens a popover (the inventory popover primitive: Escape and a click away close it and give
 * the focus back to the row) with the state sentence, what the hardware offers and, on this PC's row,
 * "Sharing settings".
 *
 * The list is the team's `team.node.list`, read once by main when the team comes online and then
 * replaced by each `team_pool_nodes` event; it reaches this tab in the team state push (store
 * `pools`), rebuilt by main from checked answers. Every value is escaped here. Busy shows no waiting
 * count: the host keeps no count per hardware (slice 3-10's queue work repays it). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamGpus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const POP_ID = 'teamGpuPop';
  const ROW_PREFIX = 'teamGpu-';
  const DOTS = Object.freeze({ ready: 'online', busy: 'away', inuse: 'away', paused: 'offline', offline: 'offline' });
  const FOCUS_TRIES = 20;
  const FOCUS_EVERY_MS = 100;

  function inv() { return globalThis.inventory || {}; }

  function stateOf(node) {
    if (!node.online) return 'offline';
    if (node.paused) return node.owner_busy === true ? 'inuse' : 'paused'; // E76: its owner's own work, not a pause
    return node.busy_slots > 0 ? 'busy' : 'ready';
  }

  function wordOf(state) {
    switch (state) {
      case 'busy': return jt('team.gpus.busy', 'busy');
      case 'inuse': return jt('team.gpus.inUse', 'in use by its owner');
      case 'paused': return jt('team.gpus.paused', 'paused');
      case 'offline': return jt('team.gpus.offline', 'offline');
      default: return '';
    }
  }

  // The team's GPUs as the tab draws them, or null while the team is not connected or shares none.
  // `people`: the roster or presence list ({ member_id, display_name }), for the owners' names.
  // `sharing`: this PC's sharing state; its node id marks this PC's row (a renamed PC stays this PC,
  // a second PC of the same person with the same name does not).
  function viewOf(team, pools, people, sharing = null) {
    if (!team || team.state !== 'online') return null;
    const list = pools && Object.hasOwn(pools, team.team_id) ? pools[team.team_id] : null;
    const nodes = list && Array.isArray(list.nodes) ? list.nodes : [];
    if (!nodes.length) return null;
    const someone = jt('settings.team.activity.someone', 'Someone');
    const nameOf = (id) => ((people || []).find((member) => member.member_id === id) || {}).display_name || someone;
    const rows = nodes.map((node) => {
      const pc = node.label || jt('team.gpus.pc', 'PC');
      const mine = Boolean(sharing && sharing.team_id === team.team_id && sharing.node_id && sharing.node_id === node.node_id);
      const owner = nameOf(node.member_id);
      const state = stateOf(node);
      return { node_id: node.node_id, owner, mine, state, word: wordOf(state), models: (node.models || []).map((model) => model.name),
        name: mine ? jt('team.gpus.thisPc', '{pc} (this PC)', { pc }) : jt('team.gpus.name', '{owner}’s {pc}', { owner, pc }) };
    });
    const live = rows.filter((row) => row.state === 'ready' || row.state === 'busy').length;
    return { team_id: team.team_id, rows, live, all: rows.length };
  }

  // The column's section; `label(text, count)` is the tab view's heading builder.
  function sectionHtml(view, label) {
    if (!view) return '';
    return '<div class="team-gpus" data-team-gpus>' + label(jt('team.gpus.heading', 'GPUs'), jt('team.gpus.count', '{live} of {all}', { live: view.live, all: view.all }))
      + '<ul class="team-list">' + view.rows.map((row) => '<li>' + inv().actionButton({
        plain: true, className: 'team-row team-row--member team-row--link team-gpu-row', domId: ROW_PREFIX + row.node_id,
        dataset: { 'team-tab-action': 'gpu', 'team-gpu': row.node_id }, ariaHaspopup: 'dialog', ariaExpanded: false,
        title: row.models.join(', '),
        trustedHtml: '<span class="team-dot" data-p="' + DOTS[row.state] + '" aria-hidden="true"></span>'
          + '<span class="team-row__name" dir="auto">' + escapeHtml(row.name) + '</span>'
          + '<span class="team-row__meta">' + escapeHtml(row.word) + '</span>',
      }) + '</li>').join('') + '</ul></div>';
  }

  function sentenceOf(row) {
    switch (row.state) {
      case 'ready': return jt('team.gpus.readyText', 'Ready: it takes the next request for its models.');
      case 'busy': return jt('team.gpus.busyText', 'Busy answering a request.');
      case 'inuse': return jt('team.gpus.inUseText', '{owner} is using it. It takes requests again when they are done.', { owner: row.owner });
      case 'paused': return jt('team.gpus.pausedText', '{owner} has paused it. Requests only it can answer wait up to 10 minutes.', { owner: row.owner });
      default: return jt('team.gpus.offlineText', 'Not connected. It is listed while {owner} still shares it.', { owner: row.owner });
    }
  }

  function popoverBody(row) {
    return '<h4>' + escapeHtml(row.name) + '</h4><p>' + escapeHtml(sentenceOf(row)) + '</p>'
      + (row.models.length ? '<p>' + escapeHtml(jt('team.gpus.offers', 'Offers')) + '</p><ul>'
        + row.models.map((name) => '<li><code>' + escapeHtml(name) + '</code></li>').join('') + '</ul>' : '')
      + (row.mine ? inv().actionButton({ label: jt('team.gpus.settings', 'Sharing settings'), plain: true, dataset: { 'team-tab-action': 'share-settings' } }) : '');
  }

  // Opens Settings > Team and, once its page is drawn, brings the "Share this PC's GPU" switch into view.
  function openShareSettings(openSettings) {
    if (typeof openSettings !== 'function') return;
    openSettings('team');
    const doc = globalThis.document;
    let tries = 0;
    const look = () => {
      const track = doc && doc.getElementById ? doc.getElementById('teamShareGpu') : null;
      if (track) {
        if (typeof track.scrollIntoView === 'function') track.scrollIntoView({ block: 'center' });
        if (typeof track.focus === 'function') track.focus({ preventScroll: true });
        return;
      }
      tries += 1;
      if (tries < FOCUS_TRIES) setTimeout(look, FOCUS_EVERY_MS);
    };
    setTimeout(look, 0);
  }

  // One popover per shown tab. `viewNow()` answers the current view (viewOf); `subscribe(fn)` the store's.
  function mount(container, { viewNow, subscribe }) {
    let shownId = '';
    let pop = null;
    const doc = container.ownerDocument;
    const api = () => inv().popover;

    function rowOf(id) { const view = viewNow(); return view ? view.rows.find((row) => row.node_id === id) || null : null; }
    function trigger(id) { const el = doc.getElementById(ROW_PREFIX + id); return el && container.contains(el) ? el : null; }

    function place(anchor) {
      const rect = anchor.getBoundingClientRect();
      const width = pop.offsetWidth || 280;
      const height = pop.offsetHeight || 160;
      const view = doc.defaultView || {};
      const maxLeft = Math.max(8, (view.innerWidth || 1024) - width - 8);
      const maxTop = Math.max(8, (view.innerHeight || 768) - height - 8);
      pop.style.left = Math.min(maxLeft, Math.max(8, rect.right + 8)) + 'px';
      pop.style.top = Math.min(maxTop, Math.max(8, rect.top)) + 'px';
    }

    function close(restoreFocus) {
      if (!pop) return;
      const el = pop;
      pop = null;
      shownId = '';
      if (api() && typeof api().close === 'function') api().close(el, { restoreFocus });
      el.remove();
    }

    function open(id) {
      const row = rowOf(id);
      const anchor = trigger(id);
      const popover = api();
      if (!row || !anchor || typeof popover !== 'function') return;
      close(false);
      const holder = doc.createElement('div');
      holder.innerHTML = popover({ domId: POP_ID, className: 'team-gpu-pop', ariaLabel: row.name, trustedHtml: popoverBody(row) });
      pop = holder.firstElementChild;
      pop.setAttribute('tabindex', '-1');
      container.appendChild(pop);
      shownId = id;
      popover.open(pop, { trigger: anchor, focus: false });
      place(anchor);
      pop.focus({ preventScroll: true });
    }

    // Keeps an open popover's words current; a row that left, or a popover the primitive closed, ends it.
    function follow() {
      if (!pop) return;
      if (pop.hidden || !pop.isConnected) { close(false); return; }
      const row = rowOf(shownId);
      const anchor = trigger(shownId);
      if (!row || !anchor) { close(false); return; }
      const html = popoverBody(row);
      if (pop.__teamGpuHtml !== html) { pop.innerHTML = html; pop.__teamGpuHtml = html; pop.setAttribute('aria-label', row.name); }
      pop.__invPopoverTrigger = anchor; // the column redraw may have replaced the row
      anchor.setAttribute('aria-expanded', 'true');
    }

    function onToggle(event) { if (pop && event.target === pop && event.detail && event.detail.open === false) close(false); }

    container.addEventListener('inv-popover-toggle', onToggle);
    const unsubscribe = subscribe(() => setTimeout(follow, 0));
    return {
      toggle(id) { if (shownId === id) close(true); else open(id); },
      close: () => close(false),
      release() { container.removeEventListener('inv-popover-toggle', onToggle); try { unsubscribe(); } catch (_error) { /* best effort */ } close(false); },
      get shownId() { return shownId; },
    };
  }

  return { viewOf, sectionHtml, mount, openShareSettings };
});
