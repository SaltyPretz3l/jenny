/* renderer/features/board/board-proposals-view.js - the page's side of Jenny's proposals (UMD, global rendererBoardProposalsView).
 *
 * Jenny can answer a turn sent from the docked chat with a `board` block; the main process reads it once and stores a proposal
 * (services/boards/board-proposals.js). This part shows the newest OPEN proposal of the open board and sends the person's
 * decisions back through source.decideProposal. It never reads a reply and never applies an operation itself.
 *
 *   the bar      one line at the foot of the canvas toolbar (inside [data-board-chrome] when the toolbar is there):
 *                "Jenny proposes N changes" with Accept additions, Review, Reject; Review and Reject for edits and removals
 *                only; Review and Dismiss when every line was refused. Under Full auto (slice C4) the main process has
 *                already applied the additions: while that batch is still the board's newest change the bar says
 *                "Jenny made N changes." with Undo, then what is left ("2 more need your review."). After any later
 *                change, or the Undo, it is an ordinary proposal again (or no bar, when nothing is left).
 *   the list     fills the Changes view's host: Additions, Edits and Removals, one row per change, a row's outcome when it
 *                is decided, and the line Jenny wrote struck through with the reason when it could not be used.
 *   the ghosts   a dashed outline for each new card and group at the place the main process says it would land, in board
 *                coordinates inside the surface's layer (so they pan and zoom), above the cards, never taking the pointer.
 *                A new connection between two of them is drawn too (the connector primitive's ghost line).
 *
 * It joins the page through the card kinds seam and reads what it needs from the context the page hands in:
 *   ctx.context.getChangesHost()  the [data-board-changes-host] element      ctx.context.revealChanges()  shows the Changes view
 * The open board is the editor's; the source's onChanged tells it when proposals changed (`proposals`) or the board did
 * (`applied`, which moves where the ghosts land). Every string from a proposal is model output and reaches the page through
 * textContent only. Row 150, slice C3.
 *
 * On a team board (row 151 slice T7: `ctx.context.getTeamSource()` answers the source) the bar says who asked Jenny, the Review list opens
 * with who asked and who may answer, and a member who may not write has every decision control off, the source's sentence as its
 * tooltip. What each control sends is the same. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rendererBoardProposalsView = api;
  if (root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('proposals', api.createProposalsView);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SECTIONS = ['addition', 'edit', 'removal'];
  const APPLIED_MS = 2000; // a burst of applied batches reads the proposal list once at its start and once after this long

  function resolveText() {
    if (globalThis.rendererBoardProposalText) return globalThis.rendererBoardProposalText;
    if (typeof require === 'function') {
      try { return require('./board-proposal-text'); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function resolveConnectorLayer(ctx) {
    if (ctx && typeof ctx.connectorLayer === 'function') return ctx.connectorLayer;
    if (typeof globalThis.inventoryConnectorLayer === 'function') return globalThis.inventoryConnectorLayer;
    if (typeof require === 'function') {
      try { return require('../../inventory/connector-layer'); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function createProposalsView(ctx) {
    const doc = ctx && ctx.document;
    const { editor, source, surface } = ctx || {};
    const context = (ctx && ctx.context) || {};
    const words = resolveText();
    const connectorLayer = resolveConnectorLayer(ctx);
    const host = typeof context.getChangesHost === 'function' ? context.getChangesHost() : null;
    if (!doc || !editor || !source || typeof source.listProposals !== 'function' || !surface || !surface.element || !host || !words) return null;
    const actionButton = ctx.actionButton;
    const notify = typeof ctx.notify === 'function' ? ctx.notify : () => {};
    const teamSource = () => (typeof context.getTeamSource === 'function' ? context.getTeamSource() : null);
    // The controls that answer a proposal; a member who may not write has them off on a team board, with the source's sentence.
    const DECISIONS = new Set(['accept-additions', 'accept', 'reject', 'reject-all', 'dismiss']);
    function whyStopped(act) {
      const team = DECISIONS.has(act) ? teamSource() : null;
      return team ? team.whyNot('decideProposal') : '';
    }
    // Who asked Jenny for this proposal: { name, self }, or null when the member is not known (a name is another member's input).
    function askerOf(proposal) {
      const id = proposal && typeof proposal.prompterMemberId === 'string' ? proposal.prompterMemberId : '';
      const name = id && typeof context.nameOfMember === 'function' ? String(context.nameOfMember(id) || '') : '';
      return name ? { name, self: typeof context.isSelfMember === 'function' && context.isSelfMember(id) === true } : null;
    }

    let boardId = '';
    let shown = null; // the newest open proposal of the open board
    let done = null; // the newest proposal when it is closed and Full auto applied it: told while its Undo still applies
    let dismissed = ''; // the id of a `done` proposal the person closed the bar on
    let toldId = ''; // the proposal whose Full auto line the bar shows now
    let busy = false;
    let token = 0;
    let disposed = false;
    let ghostHolder = null;

    function made(tag, className, textContent) {
      const el = doc.createElement(tag);
      if (className) el.className = className;
      if (textContent !== undefined) el.textContent = textContent;
      return el;
    }

    // One button's markup (an inventory primitive's output, the only markup here); its label and title are literals at the call site.
    function button(label, title, act, extra) {
      const options = extra || {};
      const dataset = { 'board-act': act };
      if (options.n !== undefined) dataset.n = String(options.n);
      const stopped = whyStopped(act);
      return actionButton({ variant: options.primary ? 'primary' : options.n === undefined ? 'ghost' : 'secondary', size: 'sm', className: 'board-proposal-btn', label, title: stopped || (options.disabledTitle && options.disabled ? options.disabledTitle : title), disabled: busy || options.disabled === true || Boolean(stopped), dataset });
    }

    /* ---------------------------------------------------------------- the bar */

    const bar = made('div', 'board-proposal-bar');
    bar.setAttribute('data-board-proposal-bar', '');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', jt('board.proposal.label', "Jenny's proposed changes"));

    function placeBar() {
      const centre = surface.element.parentElement || surface.element;
      const parent = centre.querySelector('[data-board-chrome]') || centre;
      if (bar.parentElement !== parent) parent.appendChild(bar);
    }

    // What Full auto did is told, with its Undo, only while that batch is the newest change of the board the editor
    // holds: the board's Undo then takes back exactly that batch, and the sentence is still true.
    function autoTold() {
      const proposal = shown && shown.auto ? shown : (done && done.id !== dismissed ? done : null);
      const board = editor.getBoard();
      const ring = board && Array.isArray(board.recent_batches) ? board.recent_batches : [];
      return proposal && proposal.auto.batchId && ring.length && ring[ring.length - 1] === proposal.auto.batchId ? proposal : null;
    }

    function renderBar() {
      const told = autoTold();
      toldId = told ? told.id : '';
      if (!shown && !told) { bar.remove(); return; }
      bar.textContent = '';
      if (told) {
        bar.appendChild(made('span', 'board-proposal-bar__text', words.madeText(told.auto.applied)));
        bar.insertAdjacentHTML('beforeend', button(jt('board.proposal.undo', 'Undo'), jt('board.proposal.undoTitle', 'Take back what Jenny added'), 'undo'));
      }
      if (!shown) {
        bar.insertAdjacentHTML('beforeend', button(jt('board.proposal.dismiss', 'Dismiss'), jt('board.proposal.closeTitle', 'Close this line'), 'close'));
        placeBar();
        return;
      }
      const state = words.barState(shown);
      bar.appendChild(made('span', 'board-proposal-bar__text', told && state.kind === 'review' ? words.moreText(shown.counts.pending) : state.text));
      const asker = teamSource() ? askerOf(shown) : null;
      if (asker) bar.appendChild(made('span', 'board-proposal-bar__by', words.askedByText(asker)));
      const review = button(jt('board.proposal.review', 'Review'), jt('board.proposal.reviewTitle', 'Show every proposed change in the Changes view'), 'review', { primary: state.kind === 'review' });
      if (state.kind === 'additions') {
        bar.insertAdjacentHTML('beforeend', button(jt('board.proposal.acceptAdditions', 'Accept additions'), jt('board.proposal.acceptAdditionsTitle', 'Add every new card, group and connection together. One Undo takes them all back.'), 'accept-additions', { primary: true }));
      }
      bar.insertAdjacentHTML('beforeend', review);
      if (state.kind === 'unusable') bar.insertAdjacentHTML('beforeend', button(jt('board.proposal.dismiss', 'Dismiss'), jt('board.proposal.dismissTitle', 'Close this proposal without changing the board'), 'dismiss'));
      else bar.insertAdjacentHTML('beforeend', button(jt('board.proposal.reject', 'Reject'), jt('board.proposal.rejectTitle', 'Leave every proposed change out'), 'reject-all'));
      placeBar();
    }

    /* ---------------------------------------------------------------- the review list */

    const listRoot = made('div', 'board-changes');
    listRoot.setAttribute('data-board-changes', '');
    const title = made('h2', 'board-changes__title', jt('board.changes.title', 'Changes'));
    title.setAttribute('tabindex', '-1');
    title.setAttribute('data-board-changes-title', '');
    const body = made('div', 'board-changes__body');
    listRoot.appendChild(title);
    listRoot.appendChild(body);
    host.textContent = '';
    host.appendChild(listRoot);

    function rowButtons(change) {
      const n = change.n;
      if (change.class === 'edit') {
        return button(jt('board.changes.accept', 'Accept'), jt('board.changes.acceptTitle', 'Make this change'), 'accept', { n })
          + button(jt('board.changes.skip', 'Skip'), change.type === 'edit' ? jt('board.changes.skipTitle', 'Leave the text as it is') : jt('board.changes.skipPlaceTitle', 'Leave it as it is'), 'reject', { n });
      }
      if (change.class === 'removal') {
        return button(jt('board.changes.removeIt', 'Remove'), jt('board.changes.removeTitle', 'Take it off the board'), 'accept', { n })
          + button(jt('board.changes.keep', 'Keep'), jt('board.changes.keepTitle', 'Keep it on the board'), 'reject', { n });
      }
      return button(jt('board.changes.rejectOne', 'Reject'), jt('board.changes.rejectOneTitle', 'Leave this one out'), 'reject', { n });
    }

    function rowElement(change) {
      const row = made('div', 'board-change');
      row.setAttribute('data-board-change', '');
      row.setAttribute('data-n', String(change.n));
      row.setAttribute('data-state', change.state);
      if (change.state === 'refused') {
        row.appendChild(made('del', 'board-change__line', change.line));
        row.appendChild(made('p', 'board-change__reason', words.reasonText(change.reason, change.type)));
        return row;
      }
      if (change.type === 'edit') {
        const s = change.summary || {};
        row.appendChild(made('div', 'board-change__target', s.target === undefined ? '' : String(s.target)));
        row.appendChild(made('del', 'board-change__before', s.before === undefined ? '' : String(s.before)));
        row.appendChild(made('div', 'board-change__after', s.after === undefined ? '' : String(s.after)));
      } else {
        row.appendChild(made('div', 'board-change__text', words.changeText(change)));
      }
      if (change.state === 'pending') {
        const acts = made('div', 'board-change__acts');
        acts.insertAdjacentHTML('beforeend', rowButtons(change));
        row.appendChild(acts);
      } else {
        row.appendChild(made('span', 'board-change__outcome', words.outcomeText(change)));
      }
      return row;
    }

    function sectionTitle(kind, count) {
      if (kind === 'edit') return jt('board.changes.edits', 'Edits ({count})', { count });
      return kind === 'removal' ? jt('board.changes.removals', 'Removals ({count})', { count }) : jt('board.changes.additions', 'Additions ({count})', { count });
    }

    function renderList() {
      body.textContent = '';
      if (!shown) {
        const none = made('p', 'board-changes__empty', jt('board.changes.none', 'Jenny has not proposed any changes to this board.'));
        none.setAttribute('data-board-changes-empty', '');
        body.appendChild(none);
        return;
      }
      const asker = teamSource() ? askerOf(shown) : null;
      if (asker) body.appendChild(made('p', 'board-changes__asked', words.askedLine(asker)));
      SECTIONS.forEach((kind) => {
        const rows = shown.changes.filter((change) => change.class === kind);
        if (!rows.length) return;
        const section = made('section', 'board-changes__sec');
        section.setAttribute('data-board-changes-sec', kind);
        section.appendChild(made('h3', 'board-changes__heading', sectionTitle(kind, rows.length)));
        if (kind === 'addition') {
          const acts = made('div', 'board-changes__acts');
          const waiting = rows.some((change) => change.state === 'pending');
          acts.insertAdjacentHTML('beforeend', button(jt('board.proposal.acceptAdditions', 'Accept additions'), jt('board.proposal.acceptAdditionsTitle', 'Add every new card, group and connection together. One Undo takes them all back.'), 'accept-additions',
            { primary: true, disabled: !waiting, disabledTitle: jt('board.changes.nothingWaiting', 'No addition is waiting for you.') }));
          section.appendChild(acts);
        }
        rows.forEach((change) => section.appendChild(rowElement(change)));
        body.appendChild(section);
      });
      if (shown.overflow > 0) {
        const more = made('p', 'board-changes__overflow', words.overflowText(shown.overflow));
        more.setAttribute('data-board-changes-overflow', '');
        body.appendChild(more);
      }
    }

    /* ---------------------------------------------------------------- the ghosts */

    // The canvas column carries data-board-ghosting while a ghost is drawn: board-proposals.css then hides the
    // empty-board hint, which would otherwise read "nothing here" through the proposed cards.
    function markGhosting(on) {
      const centre = surface.element.parentElement;
      if (!centre) return;
      if (on) centre.setAttribute('data-board-ghosting', '');
      else centre.removeAttribute('data-board-ghosting');
    }

    function clearGhosts() {
      if (ghostHolder) ghostHolder.textContent = '';
      markGhosting(false);
    }

    function ghost(place, kind, label) {
      if (![place.x, place.y, place.w, place.h].every(Number.isFinite)) return;
      const el = made('div', `board-ghost board-ghost--${kind}`);
      el.setAttribute('data-board-ghost', '');
      el.setAttribute('data-kind', kind);
      el.setAttribute('data-n', String(place.n));
      el.setAttribute('aria-hidden', 'true');
      el.style.left = `${place.x}px`;
      el.style.top = `${place.y}px`;
      el.style.width = `${place.w}px`;
      el.style.height = `${place.h}px`;
      el.appendChild(made('span', 'board-ghost__text', label));
      ghostHolder.appendChild(el);
    }

    function renderGhosts() {
      clearGhosts();
      const preview = shown && shown.preview;
      if (!preview) return;
      if (!ghostHolder) {
        ghostHolder = made('div', 'board-ghosts');
        ghostHolder.setAttribute('data-board-ghosts', '');
        ghostHolder.setAttribute('aria-hidden', 'true');
      }
      (surface.layer || surface.element).appendChild(ghostHolder); // last: above the cards
      const byN = new Map(shown.changes.map((change) => [change.n, change]));
      (Array.isArray(preview.cards) ? preview.cards : []).forEach((place) => ghost(place, 'card', words.shortText(byN.get(place.n))));
      (Array.isArray(preview.groups) ? preview.groups : []).forEach((place) => ghost(place, 'group', words.shortText(byN.get(place.n))));
      const lines = (Array.isArray(preview.connectors) ? preview.connectors : []).filter((line) => line && line.from && line.to);
      if (lines.length && connectorLayer) {
        const drawn = connectorLayer({ document: doc });
        ghostHolder.appendChild(drawn.element);
        drawn.render(lines.map((line, i) => ({ id: `ghost-${i}`, from: line.from, to: line.to, label: line.label, style: line.style, ends: line.ends, ghost: true })));
      }
      markGhosting(ghostHolder.childElementCount > 0);
    }

    function render() {
      if (disposed) return;
      renderBar();
      renderList();
      renderGhosts();
    }

    /* ---------------------------------------------------------------- reading and deciding */

    async function load() {
      const wanted = boardId;
      if (!wanted || disposed) return;
      const mine = ++token;
      const result = await Promise.resolve().then(() => source.listProposals({ boardId: wanted })).catch(() => null);
      if (disposed || mine !== token || wanted !== boardId) return; // a board that is no longer open is not drawn
      const list = result && result.ok === true && Array.isArray(result.proposals) ? result.proposals : [];
      shown = list.find((proposal) => proposal && proposal.open === true) || null;
      done = !shown && list[0] && list[0].auto ? list[0] : null;
      render();
    }

    function setDisabled(value) {
      [bar, listRoot].forEach((part) => part.querySelectorAll('button[data-board-act]').forEach((el) => { el.disabled = value; }));
    }

    // After a decision the buttons are new ones: focus goes back to the part it was in, never to the page's body.
    function refocus(part) {
      if (!part || (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.isConnected)) return;
      const next = part.isConnected ? part.querySelector('button[data-board-act]:not([disabled])') : null;
      const target = next || (listRoot.isConnected && part === listRoot ? title : surface.element);
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    async function undoAuto() {
      if (busy || !toldId || typeof editor.undo !== 'function') return;
      busy = true;
      setDisabled(true);
      await Promise.resolve().then(() => editor.undo()).catch(() => null);
      busy = false;
      if (!disposed) { render(); refocus(bar); }
    }

    async function decide(action, n) {
      if (busy || !shown) return;
      const from = bar.contains(doc.activeElement) ? bar : (listRoot.contains(doc.activeElement) ? listRoot : null);
      const request = { boardId, proposalId: shown.id, action };
      if (n !== undefined) request.n = n;
      busy = true;
      setDisabled(true);
      const result = await Promise.resolve().then(() => source.decideProposal(request)).catch(() => null);
      if (disposed) return;
      if (result && result.ok === true) {
        if (action === 'accept_additions' && result.skipped > 0) notify(words.skippedText(result.skipped), { tone: 'warning' });
      } else {
        notify((result && typeof result.message === 'string' && result.message) || words.refusalText(result && result.reason), { tone: 'warning' });
      }
      await load();
      busy = false;
      render();
      refocus(from);
    }

    function reveal() {
      try { if (typeof context.revealChanges === 'function') context.revealChanges(); } catch (_error) { /* the page may be going away */ }
    }

    function onClick(event) {
      const target = event.target && typeof event.target.closest === 'function' ? event.target.closest('button[data-board-act]') : null;
      if (!target || target.disabled) return;
      const n = target.hasAttribute('data-n') ? Number(target.getAttribute('data-n')) : undefined;
      switch (target.getAttribute('data-board-act')) {
        case 'accept-additions': void decide('accept_additions'); break;
        case 'review': reveal(); break;
        case 'reject-all': case 'dismiss': void decide('reject'); break;
        case 'accept': void decide('accept', n); break;
        case 'reject': void decide('reject', n); break;
        case 'undo': void undoAuto(); break;
        case 'close': dismissed = done ? done.id : ''; renderBar(); refocus(bar); break;
        default: break;
      }
    }
    bar.addEventListener('click', onClick);
    listRoot.addEventListener('click', onClick);

    const openId = () => { const board = editor.getBoard(); return board && typeof board.id === 'string' ? board.id : ''; };
    const offEditor = editor.onChange(() => {
      if (disposed) return;
      // The same board changed: only whether Full auto's batch can still be undone from the bar may have moved.
      if (openId() === boardId) { const told = autoTold(); if (!busy && (told ? told.id : '') !== toldId) renderBar(); return; }
      boardId = openId();
      shown = null;
      done = null;
      busy = false;
      token += 1; // an answer still on its way is for the board that was open
      render();
      void load();
    });
    // Applied batches come as fast as people edit, and on a team board each read of the list is a call to the host
    // that counts against the member's reads: the first of a burst reads at once, the rest share one read after it.
    const timers = (ctx && ctx.windowRef) || doc.defaultView || globalThis;
    let appliedTimer = 0;
    let appliedAgain = false;
    function loadAfterApplied() {
      if (appliedTimer) { appliedAgain = true; return; }
      void load();
      appliedTimer = timers.setTimeout(() => {
        appliedTimer = 0;
        if (appliedAgain && !disposed) { appliedAgain = false; loadAfterApplied(); }
      }, APPLIED_MS);
    }
    const offSource = typeof source.onChanged === 'function' ? source.onChanged((event) => {
      if (disposed || !event || !boardId || event.boardId !== boardId) return;
      if (event.kind === 'proposals') void load();
      else if (event.kind === 'applied' && shown) loadAfterApplied();
    }) : null;

    boardId = openId();
    render();
    void load();

    return {
      reload: load,
      dispose() {
        if (disposed) return;
        disposed = true;
        timers.clearTimeout(appliedTimer);
        if (typeof offEditor === 'function') offEditor();
        if (typeof offSource === 'function') offSource();
        bar.removeEventListener('click', onClick);
        listRoot.removeEventListener('click', onClick);
        bar.remove();
        clearGhosts();
        if (ghostHolder) ghostHolder.remove();
        ghostHolder = null;
        listRoot.remove();
      },
    };
  }

  return { createProposalsView };
});
