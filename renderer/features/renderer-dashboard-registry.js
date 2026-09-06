/* Home dashboard widget registry. Widgets are plain descriptors:
 *   { id, title, render(bodyEl, ctx) }
 * renderInto() owns the card chrome (section + header + body) and keeps the
 * grid idempotent: cards are keyed by data-widget-id and reused across
 * renders, and a widget that throws is contained to its own card so the rest
 * of the grid still paints. (gethomepage-inspired registry pattern, reimplemented from
 * scratch in jenny idioms — no GPL code.)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const WIDGET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

  function createDashboardRegistry(deps = {}) {
    const documentRef = deps.documentRef
      || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const appendClientLog = typeof deps.appendClientLog === 'function'
      ? deps.appendClientLog
      : function noopLog() {};
    const widgets = [];
    const widgetIds = new Set();

    function register(widget) {
      const id = String(widget?.id || '').trim();
      if (!WIDGET_ID_PATTERN.test(id) || typeof widget?.render !== 'function') {
        appendClientLog('WARN', 'home.dashboard_widget_rejected', {
          widgetId: id || '(missing)',
        });
        return false;
      }
      if (widgetIds.has(id)) {
        appendClientLog('WARN', 'home.dashboard_widget_duplicate', { widgetId: id });
        return false;
      }
      widgetIds.add(id);
      widgets.push({
        id,
        title: String(widget.title || '').trim(),
        // Daybook slot: 'rail' parks the card in the right-hand rail column,
        // anything else falls back to the main column. Whitelisted (not passed
        // through) so a typo can never invent a host the renderer cannot find.
        slot: widget.slot === 'rail' ? 'rail' : 'main',
        render: widget.render,
      });
      return true;
    }

    function list() {
      return widgets.map((widget) => ({
        id: widget.id,
        title: widget.title,
        slot: widget.slot,
      }));
    }

    // User layout config (homeConfig.widgets): ids listed in `order` render
    // first in that order; everything else keeps registration order after
    // them. Unknown ids are inert (config written by a newer build must not
    // break an older one), and the sort is deterministic so steady-state
    // repaints never churn settled DOM.
    function computeEffectiveWidgets(ctx) {
      const config = ctx?.widgetsConfig;
      const order = Array.isArray(config?.order) ? config.order : [];
      const hiddenIds = new Set(Array.isArray(config?.hidden) ? config.hidden : []);
      const orderIndex = new Map();
      order.forEach((id, index) => {
        if (!orderIndex.has(id)) {
          orderIndex.set(id, index);
        }
      });
      const sequenced = widgets.map((widget, registrationIndex) => ({
        widget,
        sortKey: orderIndex.has(widget.id)
          ? orderIndex.get(widget.id)
          : order.length + registrationIndex,
      }));
      sequenced.sort((a, b) => a.sortKey - b.sortKey);
      return {
        sequence: sequenced.map((entry) => entry.widget),
        hiddenIds,
      };
    }

    function listRenderableIds(ctx = {}) {
      const { sequence, hiddenIds } = computeEffectiveWidgets(ctx);
      return sequence
        .filter((widget) => !hiddenIds.has(widget.id))
        .map((widget) => widget.id);
    }

    // Every host a card could currently be sitting in: the main grid plus each
    // distinct ctx.slotHosts value. With no slotHosts this is [gridEl], so the
    // single-host behavior below is byte-identical to the pre-Daybook registry.
    function collectHosts(gridEl, ctx) {
      const hosts = [gridEl];
      const slotHosts = ctx?.slotHosts;
      if (slotHosts && typeof slotHosts === 'object') {
        for (const host of Object.values(slotHosts)) {
          if (host && !hosts.includes(host)) {
            hosts.push(host);
          }
        }
      }
      return hosts;
    }

    // Searches ALL hosts so a widget whose slot changed is MOVED (placeCard
    // reparents the found card) instead of leaving a duplicate behind.
    function findCard(hosts, widgetId) {
      for (const host of hosts) {
        for (const child of host.children) {
          if (child?.dataset?.widgetId === widgetId) {
            return child;
          }
        }
      }
      return null;
    }

    function resolveHost(gridEl, ctx, widget) {
      return ctx?.slotHosts?.[widget.slot] || gridEl;
    }

    function buildCard(widget) {
      const card = documentRef.createElement('section');
      card.className = 'dashboard-card';
      card.dataset.widgetId = widget.id;
      if (widget.title) {
        const header = documentRef.createElement('div');
        header.className = 'dashboard-card__header';
        const title = documentRef.createElement('h3');
        title.className = 'dashboard-card__title';
        title.textContent = widget.title;
        header.append(title);
        card.append(header);
      }
      const body = documentRef.createElement('div');
      body.className = 'dashboard-card__body';
      card.append(body);
      return card;
    }

    // Edit-layout mode: a toolbar row (markup supplied by the manager, which
    // owns the inventory primitives and the persistence handlers) appears at
    // the top of every card while ctx.editMode is on. Widgets stay oblivious.
    function syncEditToolbar(card, widget, ctx) {
      const markup = ctx?.editMode === true && typeof ctx.buildEditToolbar === 'function'
        ? ctx.buildEditToolbar(widget)
        : '';
      let toolbar = card.querySelector('.dashboard-card__edit');
      if (!markup) {
        toolbar?.remove();
        return;
      }
      if (!toolbar) {
        toolbar = documentRef.createElement('div');
        toolbar.className = 'dashboard-card__edit';
        card.insertBefore(toolbar, card.firstChild);
      }
      if (toolbar.dataset.editKey !== widget.id) {
        toolbar.innerHTML = markup;
        toolbar.dataset.editKey = widget.id;
      }
    }

    function placeCard(gridEl, card, anchor) {
      // Keep DOM order = registration order without moving settled nodes
      // (a steady-state repaint must not yank focus out of a card).
      if (card.parentNode === gridEl && card.previousElementSibling === anchor) {
        return;
      }
      const reference = anchor ? anchor.nextElementSibling : gridEl.firstElementChild;
      gridEl.insertBefore(card, reference);
    }

    function renderInto(gridEl, ctx = {}) {
      const counts = { rendered: 0, skipped: 0, failed: 0 };
      if (!gridEl || !documentRef) {
        return counts;
      }
      const hosts = collectHosts(gridEl, ctx);
      // Placement anchors are per host: each column keeps registration order
      // among its OWN cards without the other column's cards shifting it.
      const anchors = new Map();
      const { sequence, hiddenIds } = computeEffectiveWidgets(ctx);
      for (const widget of sequence) {
        const existing = findCard(hosts, widget.id);
        if (hiddenIds.has(widget.id)) {
          existing?.remove();
          counts.skipped += 1;
          continue;
        }
        const host = resolveHost(gridEl, ctx, widget);
        const card = existing || buildCard(widget);
        placeCard(host, card, anchors.get(host) || null);
        anchors.set(host, card);
        syncEditToolbar(card, widget, ctx);
        const body = card.querySelector('.dashboard-card__body');
        try {
          widget.render(body, ctx);
          delete card.dataset.widgetState;
          counts.rendered += 1;
        } catch (error) {
          card.dataset.widgetState = 'error';
          if (body) {
            body.textContent = 'This widget hit an error; it will retry on the next refresh.';
            // Widgets store render-key skips on the body; a surviving key would
            // make an identical next paint skip the promised retry.
            for (const key of Object.keys(body.dataset)) {
              if (key.endsWith('RenderKey')) {
                delete body.dataset[key];
              }
            }
          }
          counts.failed += 1;
          appendClientLog('WARN', 'home.dashboard_widget_render_failed', {
            widgetId: widget.id,
            message: String(error?.message || error || ''),
          });
        }
      }
      for (const host of hosts) {
        for (const card of Array.from(host.children)) {
          if (!widgetIds.has(card?.dataset?.widgetId || '')) {
            card.remove();
          }
        }
      }
      return counts;
    }

    return { register, list, listRenderableIds, renderInto };
  }

  return { createDashboardRegistry };
});
