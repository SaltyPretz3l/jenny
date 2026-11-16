/* The Team tab's one popover (row 123, slice 2b-2): the emoji picker, the pinned list, a message's earlier
 * versions and the "Seen by" list all open through here. One per host element (the channel's main area or the
 * thread column), appended to it, so a redraw of the row it came from does not close it.
 *
 * - `open({ key, className, label, html, anchor, keep, restore, onKeydown })` closes any other, appends a
 *   `role="dialog"` box, places it at `anchor` (below it, above when there is no room, clamped inside the host)
 *   unless the class places it by CSS, and answers it. `keep()` answers the element(s) whose press does not count
 *   as "away" (the opener, found when the press lands, since a redraw replaces nodes): its click then toggles the box shut. `html` is trusted markup built by the caller.
 * - Esc inside it closes it and calls `restore()` (the focus goes back where the caller says); a press outside it
 *   and its anchor closes it and leaves the focus where the person put it. `close()` answers whether one was open.
 * - Disposing removes it and its listeners. No timers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamPop = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GAP_PX = 4;
  const EDGE_PX = 12;

  function createPop({ host }) {
    const doc = host.ownerDocument;
    let cur = null; // { el, key, anchor, restore, off }
    let disposed = false;

    // Below the anchor, or above when it does not fit; the start edge follows the anchor, kept inside the host.
    function place(el, anchor) {
      const a = anchor.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const rtl = (doc.defaultView.getComputedStyle(host).direction || 'ltr') === 'rtl';
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      let start = rtl ? h.right - a.right : a.left - h.left;
      start = Math.max(EDGE_PX, Math.min(start, h.width - width - EDGE_PX));
      let top = a.bottom - h.top + GAP_PX;
      if (top + height > h.height - EDGE_PX && a.top - h.top - height - GAP_PX >= EDGE_PX) top = a.top - h.top - height - GAP_PX;
      el.style.insetInlineStart = start + 'px';
      el.style.insetBlockStart = Math.max(EDGE_PX, top) + 'px';
    }

    function close({ restore = true } = {}) {
      if (!cur) return false;
      const was = cur;
      cur = null;
      was.off();
      was.el.remove();
      if (restore && was.restore) was.restore();
      return true;
    }

    function open({ key, className, label, html, anchor = null, keep = null, restore = null, onKeydown = null }) {
      close({ restore: false });
      if (disposed) return null;
      const el = doc.createElement('div');
      el.className = 'team-pop ' + className;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', label);
      el.innerHTML = html;
      host.appendChild(el);
      if (anchor) place(el, anchor);
      const mine = { el, key, anchor, restore, off: null };
      const keydown = (event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          if (cur === mine) close();
          return;
        }
        if (onKeydown) onKeydown(event, el);
      };
      const away = (event) => {
        const target = event.target;
        if (cur !== mine || !target || el.contains(target) || (anchor && anchor.contains(target))) return;
        const spared = keep ? keep() : null;
        if (spared && (spared.nodeType ? [spared] : [...spared]).some((node) => node.contains(target))) return;
        close({ restore: false });
      };
      el.addEventListener('keydown', keydown);
      doc.addEventListener('pointerdown', away, true);
      mine.off = () => { el.removeEventListener('keydown', keydown); doc.removeEventListener('pointerdown', away, true); };
      cur = mine;
      return el;
    }

    return {
      open,
      close,
      // The open box's content, replaced; the focus stays inside when it was.
      set(html) {
        if (!cur) return;
        const had = cur.el.contains(doc.activeElement);
        cur.el.innerHTML = html;
        if (had) { const first = cur.el.querySelector('button:not([disabled])'); if (first) first.focus(); }
      },
      isOpen: (key) => Boolean(cur && (key === undefined || cur.key === key)),
      dispose() { disposed = true; close({ restore: false }); },
    };
  }

  return { createPop };
});
