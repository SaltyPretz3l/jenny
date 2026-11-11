/* renderer/features/renderer-change-pictures.js
 * Draws the before-and-after pictures of a web page in two places:
 *  - attachPanel fills the empty `.cp-slot` elements the Changes view leaves in
 *    each history turn and on the Working tree page with one block per page
 *    (a compare slider, or a single picture with a sentence), and
 *  - decorateChat adds two small pictures under the last reply that changed
 *    page files.
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
  const MAX_PAGES = 3;
  const MAX_REMEMBERED = 200;
  const ASK_AGAIN_MS = 6000;
  const CHAT_PIC_WIDTH = 168;
  const CHEVRON_GLYPH = '<svg class="file-diff-chevron icon-mirror-rtl" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  const DESKTOP_GLYPH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="8.2" rx="1.2"/><path d="M5.5 13.6h5M8 11v2.6"/></svg>';
  const PHONE_GLYPH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.4"/><path d="M7.3 12.2h1.4"/></svg>';

  // Small bounded memory for UI choices (open or closed, slider position).
  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
  }

  function pagesOf(record) {
    return record && Array.isArray(record.pages)
      ? record.pages.filter((pg) => pg && typeof pg === 'object' && typeof pg.path === 'string' && pg.path).slice(0, MAX_PAGES)
      : [];
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
      const body = expanded ? `<div class="cp-body">${bodyHtml(isWorkingTree, record, pg, position)}${retake}</div>` : '';
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
        const pages = pagesOf(view.record);
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
        // An undone turn's pictures leave the chat as well, and come back on Redo.
        for (const block of sid ? rootEl.querySelectorAll('[data-changes-turn-block]') : []) {
          setUndone(sid, block.getAttribute('data-changes-turn-block'), block.classList.contains('changes-history-turn--undone'));
        }
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

    /* ── Chat pictures ── */

    const decorations = new Map();
    // Session id -> whether its stored pictures have been listed yet.
    const chatList = new Map();
    // Session and turn -> when its pictures were last asked for.
    const asked = new Map();
    const pageNames = new Map();
    // Session id -> its getTurns, for every chat pane that has been decorated.
    const chatTurns = new Map();
    // Session and turn the Changes view shows as undone.
    const undone = new Map();
    let chatUnsubscribe = null;
    let lastDoc = null;

    function removeAllDecorations() {
      for (const entry of decorations.values()) entry.el.remove();
      decorations.clear();
      // After the pause the last turn may ask once more.
      asked.clear();
    }

    // Turn ids are unique across sessions, so the turn alone finds its settled article in any pane.
    function repaint(sid, turnId) {
      if (!lastDoc || !chatTurns.has(sid)) return;
      for (const article of lastDoc.querySelectorAll(ARTICLE_SELECTOR)) {
        if (article.getAttribute('data-turn-id') !== turnId || article.classList.contains('pending') || !article.querySelector('[data-jenny-code-review]')) continue;
        paint(article, sid, turnId, cache.peek(sid, turnId, 'desktop'));
      }
    }

    function setUndone(sid, turnId, on) {
      const key = sid + SEP + turnId;
      if (!turnId || undone.has(key) === on) return;
      if (on) remember(undone, key, true); else undone.delete(key);
      repaint(sid, turnId);
    }

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

    const nameOf = (path) => model.splitPath(path).name;

    function pendingName(sid, turnId) {
      const key = sid + SEP + turnId;
      if (!pageNames.has(key) && chatTurns.has(sid)) {
        const files = model.turnFiles(ledgerChanges(sid, safeCall(chatTurns.get(sid)), ''), turnId);
        pageNames.set(key, nameOf(model.firstPagePath(files)));
      }
      return pageNames.get(key) || '';
    }

    function figure(url, caption, pg) {
      const w = model.positiveInt(pg.width);
      const h = model.positiveInt(pg.height);
      const height = w && h ? ` height="${Math.max(1, Math.round((CHAT_PIC_WIDTH * h) / w))}"` : '';
      return `<figure><img class="chat-pic" src="${esc(url)}" alt="" decoding="sync" width="${CHAT_PIC_WIDTH}"${height}><figcaption>${esc(caption)}</figcaption></figure>`;
    }

    function pics(turnId, figures) {
      return actionButton({
        plain: true,
        className: 'chat-pics',
        title: jt('changePictures.chat.openTitle', 'Open in Changes'),
        dataset: { 'jenny-code-review': '', scope: 'turn', 'turn-id': turnId },
        trustedHtml: figures,
      });
    }

    function chatSpec(sid, turnId, view) {
      const record = view.record;
      const pg = pagesOf(record)[0];
      if (pg) {
        const name = nameOf(pg.path);
        const key = [record.capturedAt, pg.state, view.pending ? 1 : 0, pg.path].join('|');
        if (pg.state === 'ready' && model.isFileUrl(pg.beforeUrl) && model.isFileUrl(pg.afterUrl)) {
          return { key, html: pics(turnId, figure(pg.beforeUrl, jt('changePictures.chat.before', 'Before'), pg) + figure(pg.afterUrl, jt('changePictures.chat.after', 'After · {page}', { page: name }), pg)) };
        }
        if (pg.state === 'new' && model.isFileUrl(pg.afterUrl)) {
          return { key, html: pics(turnId, figure(pg.afterUrl, jt('changePictures.chat.newPage', '{page} · new page', { page: name }), pg)) };
        }
        if (pg.state === 'same') return { key, html: `<p class="chat-line">${esc(jt('changePictures.chat.same', '{page} looks the same before and after.', { page: name }))}</p>` };
        if (pg.state === 'after_failed') return { key, html: `<p class="chat-line">${esc(jt('changePictures.chat.afterFailed', "Couldn't take the After picture of {page}.", { page: name }))}</p>` };
        return null;
      }
      if (!record && view.pending) {
        const name = pendingName(sid, turnId);
        if (name) return { key: 'pending|' + name, html: `<p class="chat-line">${esc(jt('changePictures.chat.taking', 'Taking pictures of {page}…', { page: name }))}</p>` };
      }
      return null;
    }

    // Put the turn's element where it belongs: inside the message content,
    // right before the hover row (or last). Moves only when it is misplaced.
    function place(content, el) {
      let hover = null;
      for (let node = content.lastElementChild; node; node = node.previousElementSibling) {
        if (node.classList.contains('chat-hover-row')) { hover = node; break; }
      }
      const inPlace = el.parentNode === content && (hover ? el.nextElementSibling === hover : content.lastElementChild === el);
      if (!inPlace) content.insertBefore(el, hover);
    }

    function paint(article, sid, turnId, view) {
      const content = article.querySelector('.chat-message-content');
      const mapKey = sid + SEP + turnId;
      let entry = decorations.get(mapKey);
      const spec = content && !undone.has(mapKey) ? chatSpec(sid, turnId, view) : null;
      if (!spec) {
        if (entry) { entry.el.remove(); decorations.delete(mapKey); }
        return;
      }
      if (!entry) {
        const el = article.ownerDocument.createElement('div');
        el.className = 'chat-pics-row';
        el.setAttribute('data-cp-chat', turnId);
        entry = { el, key: '' };
        decorations.set(mapKey, entry);
        if (decorations.size > MAX_REMEMBERED) {
          for (const [k, v] of decorations) if (!v.el.isConnected && k !== mapKey) decorations.delete(k);
        }
      }
      if (entry.key !== spec.key) {
        entry.el.innerHTML = spec.html;
        entry.key = spec.key;
      }
      place(content, entry.el);
    }

    function onCacheChange(event) {
      if (!lastDoc || disposed) return;
      if (cache.isDisabled()) { removeAllDecorations(); return; }
      if (event && event.turnId && event.turnId !== WORKING_TREE) repaint(event.sessionId, event.turnId);
    }

    function askForTurn(sid, turnId, getTurns, workspaceId) {
      const files = model.turnFiles(ledgerChanges(sid, safeCall(getTurns), workspaceId), turnId);
      remember(pageNames, sid + SEP + turnId, nameOf(model.firstPagePath(files)));
      remember(asked, sid + SEP + turnId, now());
      cache.request(sid, turnId, files);
    }

    function decorateChat(options) {
      const o = options || {};
      const rootEl = o.root;
      const sid = idOf(o.sessionId);
      if (disposed || !rootEl || typeof rootEl.querySelectorAll !== 'function' || !sid) return;
      // This runs after every timeline write, streaming included: when there is nothing to do it costs one query.
      if (cache.isDisabled() || o.enabled === false) { removeAllDecorations(); return; }
      const live = liveArticles(rootEl);
      if (!live.length) return;

      lastDoc = rootEl.ownerDocument;
      remember(chatTurns, sid, o.getTurns);
      if (!chatUnsubscribe) chatUnsubscribe = cache.subscribe(onCacheChange);
      if (!chatList.has(sid)) {
        remember(chatList, sid, false);
        cache.ensureListed(sid).then(() => {
          remember(chatList, sid, true);
          if (rootEl.isConnected !== false) decorateChat(o);
        });
      }
      let last;
      for (const article of live) {
        const turnId = article.getAttribute('data-turn-id');
        const view = cache.peek(sid, turnId, 'desktop');
        // Only the last reply is asked for: again when a later edit adds a file, else not until a "busy" answer has cleared.
        const countKey = sid + SEP + turnId + '#', edits = article.querySelectorAll('[data-jenny-code-review]').length, grew = asked.has(countKey) && asked.get(countKey) !== edits;
        if (chatList.get(sid) && (grew || (!view.record && !view.answered && !view.pending && !(asked.get(sid + SEP + turnId) > now() - ASK_AGAIN_MS)))) {
          if (last === undefined) last = lastArticle(rootEl);
          if (article === last) askForTurn(sid, turnId, o.getTurns, o.workspaceId);
        }
        if (chatList.get(sid)) remember(asked, countKey, edits);
        paint(article, sid, turnId, cache.peek(sid, turnId, 'desktop'));
      }
    }

    function dispose() {
      if (disposed) return;
      Array.from(disposers).forEach((fn) => fn());
      if (chatUnsubscribe) chatUnsubscribe();
      chatUnsubscribe = null;
      removeAllDecorations();
      disposed = true;
    }

    return { cache, attachPanel, decorateChat, dispose };
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
    decorateChat(options) { return getShared().decorateChat(options); },
  };
});
