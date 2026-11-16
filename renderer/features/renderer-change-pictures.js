/* renderer/features/renderer-change-pictures.js
 * Draws the before-and-after pictures of a web page in two places:
 *  - attachPanel fills the empty `.cp-slot` elements the Changes view leaves in
 *    each history turn and on the Working tree page with one block per page
 *    (a compare slider, or a single picture with a sentence), and
 *  - captureForChat draws nothing: it asks for the pictures of the last reply
 *    that changed page files, so the Changes view has them.
 * Both read one shared cache (renderer-change-pictures-model.js) so the panel and
 * the chat never ask twice. Everything from the bridge is untrusted: strings are
 * escaped, only file: picture URLs are drawn, and no selector is built from an id.
 * This file owns markup and listeners only; it never reads files and never polls.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-change-pictures-model'),
      require('../inventory/action-button'),
      require('../inventory/compare-slider'),
      require('../shared/string-utils')
    );
    return;
  }
  root.rendererChangePictures = factory(
    root.rendererChangePicturesModel,
    root.inventoryActionButton,
    root.inventoryCompareSlider,
    root.stringUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, actionButton, slider, stringUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const esc = stringUtils.escapeHtml;
  const { idOf, viewportOf } = model;

  const SEP = '\u0001';
  const ARTICLE_SELECTOR = 'article.chat-entry.assistant[data-turn-id]';
  const PANE_SELECTOR = '.chat-timeline, [data-chat-timeline]';
  const MAX_AUTO_TURNS = 5;
  const MAX_REMEMBERED = 200;
  const ASK_AGAIN_MS = 6000;
  const CHEVRON_GLYPH = '<svg class="file-diff-chevron icon-mirror-rtl" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  const DESKTOP_GLYPH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="8.2" rx="1.2"/><path d="M5.5 13.6h5M8 11v2.6"/></svg>';
  const PHONE_GLYPH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.4"/><path d="M7.3 12.2h1.4"/></svg>';

  // Small bounded memory for UI choices (open or closed, slider position).
  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
  }

  function createChangePictures(deps) {
    const d = deps || {};
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge : () => globalThis.jennyShell?.changePictures;
    const getLedgerBuilder = typeof d.getLedgerBuilder === 'function'
      ? d.getLedgerBuilder
      : () => globalThis.rendererJennyChangeLedger?.buildJennyChangeLedgerFromTurnViewModels;
    const log = typeof d.log === 'function' ? d.log : function () {};
    const now = typeof d.now === 'function' ? d.now : Date.now;
    const cache = model.createPictureCache({ getBridge, log, now, setTimer: d.setTimer });
    const WORKING_TREE = model.WORKING_TREE_TURN_ID;
    const disposers = new Set();
    let disposed = false;

    function safeCall(fn, ...args) {
      try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (err) { log('changePictures callback failed', err); return undefined; }
    }

    function ledgerChanges(sessionId, turns, workspaceId) {
      const builder = safeCall(getLedgerBuilder);
      if (typeof builder !== 'function') return [];
      const result = safeCall(builder, Array.isArray(turns) ? turns : [], { sessionId, workspaceId: workspaceId || '' });
      return result && Array.isArray(result.changes) ? result.changes : [];
    }

    function link(label, dataset) {
      return actionButton({ plain: true, className: 'changes-wt-link', label, dataset });
    }

    /* ── Pictures ── */

    function shot(url, alt, pg) {
      if (!model.isFileUrl(url)) return '';
      const w = model.positiveInt(pg.width);
      const h = model.positiveInt(pg.height);
      return `<img class="cp-shot" src="${esc(url)}" alt="${esc(alt)}" decoding="async"${w && h ? ` width="${w}" height="${h}"` : ''}>`;
    }

    const caps = (...parts) => `<div class="cp-caps">${parts.join('')}</div>`;

    function bodyHtml(isWorkingTree, record, pg, position) {
      const vp = viewportOf(record.viewport);
      const beforeAlt = jt('changePictures.beforeAlt', '{page} before the change', { page: pg.path });
      const afterAlt = jt('changePictures.afterAlt', '{page} after the change', { page: pg.path });
      if (pg.state === 'ready') {
        // The slider also accepts https and data URLs; only our own picture files are drawn.
        if (!model.isFileUrl(pg.beforeUrl) || !model.isFileUrl(pg.afterUrl)) return '';
        return slider({
          beforeSrc: pg.beforeUrl,
          afterSrc: pg.afterUrl,
          beforeLabel: isWorkingTree ? jt('changePictures.beforeCommit', 'Before · last commit') : jt('changePictures.beforeTurn', 'Before this turn'),
          afterLabel: isWorkingTree ? jt('changePictures.afterNow', 'After · now') : jt('changePictures.after', 'After'),
          handleLabel: jt('changePictures.handleLabel', 'Before and after'),
          alt: jt('changePictures.blockLabel', '{page}, before and after', { page: pg.path }),
          position,
          viewport: vp,
          width: pg.width,
          height: pg.height,
        });
      }
      if (pg.state === 'same') {
        const other = vp === 'phone'
          ? link(jt('changePictures.checkDesktop', 'Check desktop size'), { 'cp-action': 'viewport', 'cp-viewport': 'desktop' })
          : link(jt('changePictures.checkPhone', 'Check phone size'), { 'cp-action': 'viewport', 'cp-viewport': 'phone' });
        return shot(pg.afterUrl, afterAlt, pg) + caps(`<span>${esc(jt('changePictures.same', 'The top of the page looks the same at this size.'))}</span>`, other);
      }
      if (pg.state === 'after_failed') {
        return shot(pg.beforeUrl, beforeAlt, pg) + caps(
          `<span>${esc(jt('changePictures.afterFailed', "No After picture: the page didn't finish loading after the change."))}</span>`,
          link(jt('changePictures.tryAgain', 'Try again'), { 'cp-action': 'retry' })
        );
      }
      if (pg.state === 'new') {
        return shot(pg.afterUrl, afterAlt, pg) + caps(`<span>${esc(jt('changePictures.newPage', 'New page, so there is no Before.'))}</span>`);
      }
      if (pg.state === 'deleted') {
        return shot(pg.beforeUrl, beforeAlt, pg) + caps(`<span>${esc(jt('changePictures.deletedPage', 'This page was deleted.'))}</span>`);
      }
      return '';
    }

    function sizeTool(vp, active) {
      const label = vp === 'phone' ? jt('changePictures.phoneSize', 'Phone size') : jt('changePictures.desktopSize', 'Desktop size');
      return actionButton({
        plain: true,
        className: 'changes-scope-tool',
        ariaPressed: vp === active,
        ariaLabel: label,
        title: label,
        dataset: { 'cp-action': 'viewport', 'cp-viewport': vp },
        trustedHtml: vp === 'phone' ? PHONE_GLYPH : DESKTOP_GLYPH,
      });
    }

    function sectionHtml(isWorkingTree, view, pg, expanded, position) {
      const { name, folder } = model.splitPath(pg.path);
      const record = view.record;
      const toggle = actionButton({
        plain: true,
        className: 'cp-toggle',
        ariaExpanded: expanded, title: String(pg.path || name),
        dataset: { 'cp-action': 'toggle' },
        trustedHtml: `${CHEVRON_GLYPH}<span class="cp-title">${esc(name)}</span>${folder ? `<span class="cp-sub">${esc(folder)}</span>` : ''}`,
      });
      const tools = expanded ? sizeTool('desktop', viewportOf(record.viewport)) + sizeTool('phone', viewportOf(record.viewport)) : '';
      const retake = view.retakeFailed ? caps(`<span>${esc(jt('changePictures.cantRetake', "These pictures can't be retaken: the files have changed since."))}</span>`) : '';
      const hosts = model.blockedHostsOf(pg).join(', ');
      const blocked = hosts ? caps(`<span data-cp-blocked>${esc(jt('changePictures.blockedHosts', 'blocked: {hosts}', { hosts }))}</span>`) : '';
      const body = expanded ? `<div class="cp-body">${bodyHtml(isWorkingTree, record, pg, position)}${blocked}${retake}</div>` : '';
      return `<section class="cp" data-cp-page="${esc(pg.path)}" data-cp-state="${esc(pg.state)}" data-expanded="${expanded}" aria-label="${esc(jt('changePictures.blockLabel', '{page}, before and after', { page: pg.path }))}">`
        + `<div class="cp-head">${toggle}${tools}</div>${body}</section>`;
    }

    const pendingLine = () => `<p class="cp-pending">${esc(jt('changePictures.taking', 'Taking pictures…'))}</p>`;

    /* ── Changes panel ── */

    function attachPanel(rootEl, panelDeps) {
      const inert = { refresh() {}, dispose() {} };
      if (disposed || !rootEl || typeof rootEl.querySelectorAll !== 'function') return inert;
      const pd = panelDeps || {};
      const expandedState = new Map();
      const positions = new Map();
      const listed = new Set();
      const listBad = new Set();
      const listWaiting = new Set();
      const userAsked = new Set();
      let queued = false;
      let panelDisposed = false;
      let wtAsked = null;

      const pageKey = (sid, turnId, path) => [sid, turnId, path].join(SEP);
      const sessionId = () => idOf(safeCall(pd.getSessionId));

      function clearSlot(slot) {
        if (slot.firstChild || slot.hasAttribute('data-cp-key')) {
          slot.innerHTML = '';
          slot.removeAttribute('data-cp-key');
        }
      }

      function writeSlot(slot, sid, turnId, isWorkingTree, isNewest) {
        const view = cache.peek(sid, turnId);
        const pages = model.pagesOf(view.record);
        const open = pages.map((pg) => {
          const stored = expandedState.get(pageKey(sid, turnId, pg.path));
          return stored === undefined ? isWorkingTree || isNewest : stored;
        });
        const key = !view.record && !view.pending ? '' : [
          sid, turnId, view.record ? view.record.capturedAt : '', view.record ? viewportOf(view.record.viewport) : '',
          open.map(Number).join(''), view.retakeFailed ? 1 : 0, pages.map((pg) => pg.state).join(','),
        ].join('|');
        if ((slot.getAttribute('data-cp-key') || '') !== key) {
          slot.innerHTML = pages.map((pg, i) => sectionHtml(isWorkingTree, view, pg, open[i], positions.get(pageKey(sid, turnId, pg.path)))).join('');
          if (key) slot.setAttribute('data-cp-key', key);
          else slot.removeAttribute('data-cp-key');
        }
        // The "Taking pictures" line comes and goes on its own, so pictures already drawn stay put. Under
        // drawn pictures, and on the Working tree page, it shows only when a person asked, never for a refresh.
        if (!view.pending) userAsked.delete(sid + SEP + turnId);
        const wanted = view.pending && (userAsked.has(sid + SEP + turnId) || (!pages.length && !isWorkingTree));
        const line = slot.lastElementChild && slot.lastElementChild.classList.contains('cp-pending') ? slot.lastElementChild : null;
        if (wanted && !line) slot.insertAdjacentHTML('beforeend', pendingLine());
        else if (!wanted && line) line.remove();
      }

      function workingTreeViewport(sid) {
        const record = cache.peek(sid, WORKING_TREE).record;
        return record ? viewportOf(record.viewport) : 'desktop';
      }

      function fill() {
        queued = false;
        if (panelDisposed || disposed) return;
        const sid = sessionId();
        const slots = Array.from(rootEl.querySelectorAll('.cp-slot'));
        if (!slots.length) { wtAsked = null; return; }
        if (!sid || cache.isDisabled() || safeCall(pd.isEnabled) === false) {
          slots.forEach(clearSlot);
          wtAsked = null;
          // Once the pause is over the next fill asks for the list again.
          listBad.clear();
          return;
        }
        if (!listed.has(sid) && !listBad.has(sid)) {
          if (!listWaiting.has(sid)) {
            listWaiting.add(sid);
            cache.ensureListed(sid).then((good) => {
              listWaiting.delete(sid);
              (good ? listed : listBad).add(sid);
              schedule();
            });
          }
          return;
        }
        const turnSlots = [];
        const workingSlots = [];
        for (const slot of slots) {
          if (slot.hasAttribute('data-cp-working-tree')) workingSlots.push(slot);
          else if (slot.getAttribute('data-cp-turn')) turnSlots.push({ slot, turnId: slot.getAttribute('data-cp-turn') });
        }
        const order = new Map();
        let turns = [];
        if (turnSlots.length) {
          const given = safeCall(pd.getTurnViewModels, sid);
          turns = Array.isArray(given) ? given : [];
          turns.forEach((turn, i) => { if (turn && turn.turnId != null) order.set(String(turn.turnId), i); });
        }
        const position = (turnId) => (order.has(turnId) ? order.get(turnId) : -1);

        // Only the newest turns are ever asked for; an older turn shows what was stored at the time.
        const needy = Array.from(new Set(turnSlots.map((entry) => entry.turnId)))
          .sort((a, b) => position(b) - position(a))
          .slice(0, MAX_AUTO_TURNS)
          .filter((turnId) => {
            const view = cache.peek(sid, turnId);
            return !view.record && !view.answered && !view.pending;
          });
        if (needy.length) {
          const changes = ledgerChanges(sid, turns, safeCall(pd.getWorkspaceId));
          for (const turnId of needy) cache.request(sid, turnId, model.turnFiles(changes, turnId));
        }
        // The slot's value names the listing it was drawn for: a new listing asks again.
        const wtKey = workingSlots.length ? sid + SEP + workingSlots[0].getAttribute('data-cp-working-tree') : null;
        if (wtKey !== null && wtKey !== wtAsked) cache.requestWorkingTree(sid, { viewport: workingTreeViewport(sid) });
        wtAsked = wtKey;

        let newest = '';
        let best = -1;
        for (const { turnId } of turnSlots) {
          if (position(turnId) > best) { best = position(turnId); newest = turnId; }
        }
        for (const { slot, turnId } of turnSlots) writeSlot(slot, sid, turnId, false, turnId === newest);
        for (const slot of workingSlots) writeSlot(slot, sid, WORKING_TREE, true, true);
      }

      function schedule() {
        if (queued || panelDisposed || disposed) return;
        queued = true;
        (typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn))(fill);
      }

      function slotInfo(node) {
        const slot = node && node.closest ? node.closest('.cp-slot') : null;
        if (!slot) return null;
        const isWorkingTree = slot.hasAttribute('data-cp-working-tree');
        return { slot, isWorkingTree, turnId: isWorkingTree ? WORKING_TREE : slot.getAttribute('data-cp-turn') };
      }

      function onClick(event) {
        const target = event.target && event.target.closest ? event.target.closest('[data-cp-action]') : null;
        const info = target && rootEl.contains(target) ? slotInfo(target) : null;
        const sid = sessionId();
        if (!info || !sid || !info.turnId) return;
        const action = target.getAttribute('data-cp-action');
        if (action === 'toggle') {
          const section = target.closest('.cp');
          if (!section) return;
          remember(expandedState, pageKey(sid, info.turnId, section.getAttribute('data-cp-page')), section.getAttribute('data-expanded') !== 'true');
          schedule();
          return;
        }
        const record = cache.peek(sid, info.turnId).record;
        const retry = action === 'retry';
        const vp = retry ? viewportOf(record && record.viewport) : viewportOf(target.getAttribute('data-cp-viewport'));
        if (!retry && record && viewportOf(record.viewport) === vp) return;
        userAsked.add(sid + SEP + info.turnId);
        schedule();
        if (info.isWorkingTree) {
          // A person asking is never held back by the automatic call spacing.
          cache.requestWorkingTree(sid, { viewport: vp, force: true });
          return;
        }
        const changes = ledgerChanges(sid, safeCall(pd.getTurnViewModels, sid), safeCall(pd.getWorkspaceId));
        cache.request(sid, info.turnId, model.turnFiles(changes, info.turnId), { viewport: vp, force: retry });
      }

      function onSliderChange(event) {
        const section = event.target && event.target.closest ? event.target.closest('.cp') : null;
        const info = slotInfo(section);
        const sid = sessionId();
        const value = Number(event.detail && event.detail.position);
        if (!section || !info || !sid || !Number.isFinite(value)) return;
        remember(positions, pageKey(sid, info.turnId, section.getAttribute('data-cp-page')), value);
      }

      function onMutations(records) {
        // Our own writes land inside a slot; only the host re-rendering or renaming a slot needs a fill.
        for (const record of records) {
          const node = record.target;
          if (record.type === 'attributes' || !(node && node.closest && node.closest('.cp-slot'))) { schedule(); return; }
        }
      }

      if (slider && typeof slider.initCompareSliderHandlers === 'function') slider.initCompareSliderHandlers(rootEl);
      rootEl.addEventListener('click', onClick);
      rootEl.addEventListener('inventory-compare-slider-change', onSliderChange);
      const view = rootEl.ownerDocument && rootEl.ownerDocument.defaultView;
      const Observer = (view && view.MutationObserver) || globalThis.MutationObserver;
      const observer = typeof Observer === 'function' ? new Observer(onMutations) : null;
      if (observer) observer.observe(rootEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-cp-working-tree'] });
      const unsubscribe = cache.subscribe(() => schedule());

      function dispose() {
        if (panelDisposed) return;
        panelDisposed = true;
        if (observer) observer.disconnect();
        rootEl.removeEventListener('click', onClick);
        rootEl.removeEventListener('inventory-compare-slider-change', onSliderChange);
        unsubscribe();
        disposers.delete(dispose);
      }
      disposers.add(dispose);
      fill();
      return {
        refresh() {
          listBad.clear();
          wtAsked = null;
          schedule();
        },
        dispose,
      };
    }

    /* ── Chat: ask for the last turn's pictures ── */

    // Session id -> whether its stored pictures have been listed yet.
    const chatList = new Map();
    // Session and turn -> when its pictures were last asked for.
    const asked = new Map();

    // Settled replies that show a change, found from their change controls in one pass over the tree.
    function liveArticles(node) {
      const found = new Set();
      for (const control of node.querySelectorAll('[data-jenny-code-review]')) {
        const article = control.closest(ARTICLE_SELECTOR);
        if (article && !article.classList.contains('pending')) found.add(article);
      }
      return Array.from(found);
    }

    function lastArticle(node) {
      const all = ((node.closest && node.closest(PANE_SELECTOR)) || node).querySelectorAll(ARTICLE_SELECTOR);
      if (all.length) return all[all.length - 1];
      return node.matches && node.matches(ARTICLE_SELECTOR) ? node : null;
    }

    // The chat draws no pictures (owner, 2026-11-12): they are in Changes. A
    // turn can only be pictured while its files still match the disk, so the
    // last reply's pictures are asked for here and are ready when Changes opens.
    function captureForChat(options) {
      const o = options || {};
      const rootEl = o.root;
      const sid = idOf(o.sessionId);
      if (disposed || !rootEl || typeof rootEl.querySelectorAll !== 'function' || !sid) return;
      // This runs after every timeline write, streaming included: when there is nothing to do it costs one query.
      // After a pause the last turn may ask once more.
      if (cache.isDisabled() || o.enabled === false) { asked.clear(); return; }
      const live = liveArticles(rootEl);
      if (!live.length) return;

      if (!chatList.has(sid)) {
        remember(chatList, sid, false);
        cache.ensureListed(sid).then(() => {
          remember(chatList, sid, true);
          if (rootEl.isConnected !== false) captureForChat(o);
        });
      }
      if (!chatList.get(sid)) return;
      let last;
      for (const article of live) {
        const turnId = article.getAttribute('data-turn-id');
        const view = cache.peek(sid, turnId, 'desktop');
        // Only the last reply is asked for: again when a later edit adds a file, else not until a "busy" answer has cleared.
        const countKey = sid + SEP + turnId + '#', edits = article.querySelectorAll('[data-jenny-code-review]').length, grew = asked.has(countKey) && asked.get(countKey) !== edits;
        if (grew || (!view.record && !view.answered && !view.pending && !(asked.get(sid + SEP + turnId) > now() - ASK_AGAIN_MS))) {
          if (last === undefined) last = lastArticle(rootEl);
          if (article === last) {
            remember(asked, sid + SEP + turnId, now());
            cache.request(sid, turnId, model.turnFiles(ledgerChanges(sid, safeCall(o.getTurns), o.workspaceId), turnId));
          }
        }
        remember(asked, countKey, edits);
      }
    }

    function dispose() {
      if (disposed) return;
      Array.from(disposers).forEach((fn) => fn());
      disposed = true;
    }

    return { cache, attachPanel, captureForChat, dispose };
  }

  let shared = null;
  function getShared() {
    if (!shared) shared = createChangePictures();
    return shared;
  }

  return {
    createChangePictures,
    getShared,
    attachPanel(rootEl, panelDeps) { return getShared().attachPanel(rootEl, panelDeps); },
    captureForChat(options) { return getShared().captureForChat(options); },
  };
});
