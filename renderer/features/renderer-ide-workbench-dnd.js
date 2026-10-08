/* renderer/features/renderer-ide-workbench-dnd.js - Workspace workbench drag-to-move (UMD):
 * a pointer drag of a view tab or strip button onto another stack's tab row (insert at a
 * gap), a stack body or strip (append), an edge band of the workbench (a new edge stack),
 * or the half of an editor group nearest the pointer (a new stack beside it). It reads the
 * DOM rects ONCE at drag start (and on resize), resolves the pointer
 * to a target from that cached map, paints a single .wb-drop-indicator overlay and hands
 * the drop to deps.drop(viewId, target) - the workbench commits through the layout ops.
 * Esc, pointercancel, lost capture and dispose cancel with nothing committed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbenchDnd = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THRESHOLD = 5;
  const EDGE_BAND = 40;
  const DRAG_CLASS = 'wb-dragging';
  const GRAB = '[data-wb-tab],[data-wb-strip]';
  // Files, Search and Git dock only to edges, never beside an editor group (F4).
  const EDGE_ONLY = ['explorer', 'search', 'source-control'];

  function box(el) {
    const r = el.getBoundingClientRect();
    const l = Number(r.left) || 0;
    const t = Number(r.top) || 0;
    return {
      l: l,
      t: t,
      r: Number.isFinite(r.right) ? r.right : l + (Number(r.width) || 0),
      b: Number.isFinite(r.bottom) ? r.bottom : t + (Number(r.height) || 0),
    };
  }

  function inside(b, x, y) {
    return x >= b.l && x <= b.r && y >= b.t && y <= b.b;
  }

  // One read of every views stack's rect, header (tab row) rect and tab rects, and of every
  // editor group's rect.
  function measure(rootEl) {
    const stacks = [];
    rootEl.querySelectorAll('[data-wb-stack][data-kind="views"]').forEach(function (el) {
      const area = box(el);
      if (area.r <= area.l || area.b <= area.t) return;
      const head = el.querySelector('.wb-stack-header');
      const tabEls = head ? Array.from(head.querySelectorAll('[data-wb-tab]')) : [];
      stacks.push({
        id: el.getAttribute('data-wb-stack'),
        box: area,
        head: head ? box(head) : null,
        views: tabEls.map(function (t) { return t.getAttribute('data-wb-tab'); }),
        tabs: tabEls.map(box),
      });
    });
    const groups = [];
    rootEl.querySelectorAll('[data-wb-stack][data-kind="editor"]').forEach(function (el) {
      const area = box(el);
      if (area.r > area.l && area.b > area.t) groups.push({ id: el.getAttribute('data-wb-stack'), box: area });
    });
    return { root: box(rootEl), stacks: stacks, groups: groups };
  }

  // The half of group `g` nearest (x, y): the side with the smallest relative distance.
  // Left/right are physical; the layout's are the row's start/end, mirrored in RTL.
  function groupHalf(g, x, y, rtl) {
    const b = g.box;
    const w = b.r - b.l;
    const h = b.b - b.t;
    const near = [
      ['left', (x - b.l) / w, { l: b.l, t: b.t, r: b.l + w / 2, b: b.b }],
      ['right', (b.r - x) / w, { l: b.r - w / 2, t: b.t, r: b.r, b: b.b }],
      ['top', (y - b.t) / h, { l: b.l, t: b.t, r: b.r, b: b.t + h / 2 }],
      ['bottom', (b.b - y) / h, { l: b.l, t: b.b - h / 2, r: b.r, b: b.b }],
    ].reduce(function (best, c) { return c[1] < best[1] ? c : best; });
    const side = rtl && near[0] === 'left' ? 'right' : rtl && near[0] === 'right' ? 'left' : near[0];
    return { kind: 'group', drop: { group: g.id, side: side }, rect: near[2] };
  }

  // The gap nearest x, by tab midpoints (mirrored in RTL), plus the 2px insertion line.
  function insertion(stack, x, rtl, viewId) {
    const tabs = stack.tabs;
    const n = tabs.length;
    let index = 0;
    tabs.forEach(function (t) {
      const mid = (t.l + t.r) / 2;
      if (rtl ? x < mid : x > mid) index += 1;
    });
    let at;
    if (!n) at = rtl ? stack.head.r : stack.head.l;
    else if (!rtl) at = index === 0 ? tabs[0].l : index === n ? tabs[n - 1].r : (tabs[index - 1].r + tabs[index].l) / 2;
    else at = index === 0 ? tabs[0].r : index === n ? tabs[n - 1].l : (tabs[index - 1].l + tabs[index].r) / 2;
    // moveView indexes into the stack AFTER the dragged view left it.
    const from = stack.views.indexOf(viewId);
    return { index: from >= 0 && from < index ? index - 1 : index, at: at };
  }

  function stackTarget(s, kind, drop, area) {
    return { kind: kind, drop: drop, rect: area || s.box };
  }

  // Tab row first (most specific), then the edge bands, then a stack body or strip, then
  // an editor group's half.
  function resolveTarget(zones, x, y, rtl, viewId, besideFits) {
    const r = zones.root;
    if (!inside(r, x, y)) return null;
    for (let i = 0; i < zones.stacks.length; i += 1) {
      const s = zones.stacks[i];
      if (!s.head || !inside(s.head, x, y)) continue;
      const hit = insertion(s, x, rtl, viewId);
      const line = { l: hit.at - 1, t: s.head.t, r: hit.at + 1, b: s.head.b };
      return stackTarget(s, 'tabs', { stackId: s.id, index: hit.index }, line);
    }
    // The bands are physical; the layout's 'left'/'right' are the root row's start/end,
    // which a right-to-left page mirrors.
    if (x < r.l + EDGE_BAND) return { kind: 'edge-left', drop: { edge: rtl ? 'right' : 'left' }, rect: { l: r.l, t: r.t, r: r.l + EDGE_BAND, b: r.b } };
    if (x > r.r - EDGE_BAND) return { kind: 'edge-right', drop: { edge: rtl ? 'left' : 'right' }, rect: { l: r.r - EDGE_BAND, t: r.t, r: r.r, b: r.b } };
    if (y > r.b - EDGE_BAND) return { kind: 'edge-bottom', drop: { edge: 'bottom' }, rect: { l: r.l, t: r.b - EDGE_BAND, r: r.r, b: r.b } };
    for (let i = 0; i < zones.stacks.length; i += 1) {
      if (inside(zones.stacks[i].box, x, y)) return stackTarget(zones.stacks[i], 'stack', { stackId: zones.stacks[i].id });
    }
    if (EDGE_ONLY.indexOf(viewId) >= 0) return null;
    for (let i = 0; i < zones.groups.length; i += 1) {
      const g = zones.groups[i];
      if (!inside(g.box, x, y)) continue;
      const target = groupHalf(g, x, y, rtl);
      if ((target.drop.side === 'left' || target.drop.side === 'right') && typeof besideFits === 'function' && besideFits(g.id, viewId) === false) {
        return { kind: 'group', drop: { group: g.id, side: 'bottom' }, rect: { l: g.box.l, t: (g.box.t + g.box.b) / 2, r: g.box.r, b: g.box.b } };
      }
      return target;
    }
    return null;
  }

  // deps = { getRoot(), isRtl(el), drop(viewId, target), besideFits?(groupId, viewId) }
  function createDnd(deps) {
    let drag = null;
    let swallow = null;

    function disarm() {
      if (!swallow) return;
      const s = swallow;
      swallow = null;
      s.win.removeEventListener('click', s.onClick, true);
      s.win.removeEventListener('pointerdown', s.onDown, true);
      s.win.removeEventListener('pointerup', s.onUp, true);
      if (s.timer) s.win.clearTimeout(s.timer);
    }

    // The click that follows a real drag must not re-activate a tab. It is one-shot and
    // lives only until the next press, or the end of the release's own task.
    function arm(win, released) {
      disarm();
      const s = { win: win, timer: 0 };
      s.onClick = function (ev) {
        disarm();
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      };
      s.onDown = disarm;
      s.onUp = function () { s.timer = win.setTimeout(disarm, 0); };
      swallow = s;
      win.addEventListener('click', s.onClick, true);
      win.addEventListener('pointerdown', s.onDown, true);
      if (released) s.onUp();
      else win.addEventListener('pointerup', s.onUp, true);
    }

    function paint(target) {
      const cur = drag;
      const sig = target ? target.kind + ':' + target.rect.l + ':' + target.rect.t + ':' + target.rect.r + ':' + target.rect.b : '';
      cur.target = target;
      if (cur.sig === sig) return;
      cur.sig = sig;
      if (!target) {
        if (cur.indicator) cur.indicator.remove();
        cur.indicator = null;
        return;
      }
      if (!cur.indicator) {
        const el = cur.rootEl.ownerDocument.createElement('div');
        el.className = 'wb-drop-indicator';
        el.setAttribute('aria-hidden', 'true');
        cur.rootEl.appendChild(el);
        cur.indicator = el;
      }
      const base = cur.zones.root;
      const el = cur.indicator;
      el.setAttribute('data-wb-drop', target.kind);
      el.style.left = Math.round(target.rect.l - base.l) + 'px';
      el.style.top = Math.round(target.rect.t - base.t) + 'px';
      el.style.width = Math.round(target.rect.r - target.rect.l) + 'px';
      el.style.height = Math.round(target.rect.b - target.rect.t) + 'px';
    }

    function finish(doDrop) {
      const cur = drag;
      if (!cur) return;
      drag = null;
      cur.win.removeEventListener('pointermove', cur.move);
      cur.win.removeEventListener('pointerup', cur.up);
      cur.win.removeEventListener('pointercancel', cur.cancel);
      cur.win.removeEventListener('keydown', cur.esc, true);
      cur.win.removeEventListener('resize', cur.resize);
      if (!cur.started) return;
      cur.el.removeEventListener('lostpointercapture', cur.cancel);
      cur.el.removeAttribute('data-wb-drag-source');
      cur.rootEl.classList.remove(DRAG_CLASS);
      if (cur.indicator) cur.indicator.remove();
      try {
        if (typeof cur.el.releasePointerCapture === 'function' && cur.pointerId != null) cur.el.releasePointerCapture(cur.pointerId);
      } catch (_error) {
        /* capture is best-effort */
      }
      arm(cur.win, doDrop === true);
      if (doDrop === true && cur.target) deps.drop(cur.viewId, cur.target.drop);
    }

    function begin() {
      const cur = drag;
      cur.started = true;
      try {
        if (typeof cur.el.setPointerCapture === 'function' && cur.pointerId != null) cur.el.setPointerCapture(cur.pointerId);
      } catch (_error) {
        /* capture is best-effort */
      }
      cur.el.setAttribute('data-wb-drag-source', 'true');
      cur.rootEl.classList.add(DRAG_CLASS);
      cur.el.addEventListener('lostpointercapture', cur.cancel);
      cur.rtl = deps.isRtl(cur.el) === true;
      cur.zones = measure(cur.rootEl);
    }

    function resolve(x, y) {
      paint(resolveTarget(drag.zones, x, y, drag.rtl, drag.viewId, deps.besideFits));
    }

    function onPointerDown(event) {
      if (drag || !event || event.button > 0 || event.isPrimary === false) return;
      const el = event.target && typeof event.target.closest === 'function' ? event.target.closest(GRAB) : null;
      const rootEl = el ? deps.getRoot() : null;
      const viewId = el ? el.getAttribute('data-wb-tab') || el.getAttribute('data-wb-strip') : null;
      if (!rootEl || !viewId || !el.ownerDocument.defaultView) return;
      const win = el.ownerDocument.defaultView;
      const cur = { win: win, el: el, rootEl: rootEl, viewId: viewId, pointerId: event.pointerId, x0: Number(event.clientX) || 0, y0: Number(event.clientY) || 0, started: false, zones: null, target: null, sig: '', indicator: null, rtl: false, x: 0, y: 0 };
      cur.move = function (ev) {
        const x = Number(ev.clientX);
        const y = Number(ev.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y) || (cur.pointerId != null && ev.pointerId != null && ev.pointerId !== cur.pointerId)) return;
        if (!cur.started) {
          if (Math.hypot(x - cur.x0, y - cur.y0) < THRESHOLD) return;
          begin();
        }
        cur.x = x;
        cur.y = y;
        resolve(x, y);
      };
      cur.up = function (ev) {
        if (cur.started && ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) resolve(ev.clientX, ev.clientY);
        finish(true);
      };
      cur.cancel = function () { finish(false); };
      cur.esc = function (ev) {
        if (ev.key !== 'Escape' || !cur.started) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };
      cur.resize = function () {
        if (!cur.started) return;
        cur.zones = measure(cur.rootEl);
        cur.sig = '';
        resolve(cur.x, cur.y);
      };
      drag = cur;
      win.addEventListener('pointermove', cur.move);
      win.addEventListener('pointerup', cur.up);
      win.addEventListener('pointercancel', cur.cancel);
      win.addEventListener('keydown', cur.esc, true);
      win.addEventListener('resize', cur.resize);
    }

    function dispose() {
      finish(false);
      disarm();
    }

    return { onPointerDown: onPointerDown, dispose: dispose };
  }

  return { THRESHOLD: THRESHOLD, EDGE_BAND: EDGE_BAND, measure: measure, resolveTarget: resolveTarget, createDnd: createDnd };
});
