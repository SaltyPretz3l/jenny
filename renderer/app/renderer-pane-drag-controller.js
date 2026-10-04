/* renderer/app/renderer-pane-drag-controller.js -- split view drag-to-split and kicker drag (UMD) */
/**
 * Extracted from renderer-app-pane-composition.js (which injects everything
 * below), so the composition stays under the 1015-line cap.
 *
 *   setDropHover(side)  names the PANE side on #chatView ('left' = pane 0,
 *       the inline-start side); CSS draws the outline (one pane: that half of
 *       the view; two: that pane root). One write per change, removed on
 *       null: one pane carries no attribute outside a drag.
 *   dropTarget  what the rail's tab drag hovers and drops onto. It reports
 *       the VISUAL half, so RTL flips it here.
 *   startKickerDrag(event, paneId) / cancelKickerDrag()  the kicker title
 *       drags its pane onto the other one: the rail's ghost, pointer capture
 *       on the kicker, the other pane measured once at commit, the outline
 *       while the pointer is over it, swapPanes() on the drop. Escape
 *       cancels; unmounting the pane cancels a live drag.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPaneDragController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KICKER_DRAG_THRESHOLD = 5;

  function safely(fn) {
    try { fn(); } catch (_error) { /* best-effort teardown, as the cleanup registry does */ }
  }

  function createPaneDragController(deps) {
    var options = deps || {};
    var chatView = options.chatView;
    var layoutController = options.layoutController;
    var doc = options.documentRef || chatView.ownerDocument;
    var kickerFor = options.kickerFor;
    var isDisposed = options.isDisposed;

    var dropHover = null;
    function setDropHover(side) {
      var next = side === 'left' || side === 'right' ? side : null;
      if (next === dropHover) return;
      dropHover = next;
      if (next) chatView.setAttribute('data-pane-drop', next);
      else chatView.removeAttribute('data-pane-drop');
    }
    function isRtl() {
      if (typeof options.isRtl === 'function') return options.isRtl() === true;
      return Boolean(doc && doc.documentElement && doc.documentElement.dir === 'rtl');
    }
    function paneSide(visualSide) {
      if (visualSide !== 'left' && visualSide !== 'right') return null;
      if (!isRtl()) return visualSide;
      return visualSide === 'left' ? 'right' : 'left';
    }
    var dropTarget = {
      el: chatView,
      onHover: function (side) { setDropHover(paneSide(side)); },
      onDrop: function (sessionId, side) {
        setDropHover(null);
        var target = paneSide(side);
        return !isDisposed() && target ? layoutController.placeSession(sessionId, target) : false;
      },
    };

    var kickerDrag = null;
    function startKickerDrag(event, paneId) {
      if (kickerDrag && !kickerDrag.committed) cancelKickerDrag();
      if (event.button !== 0 || kickerDrag || isDisposed() || layoutController.getPaneCount() < 2) return;
      var kicker = kickerFor(paneId);
      if (!kicker) return;
      var drag = { paneId: paneId, kicker: kicker, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, committed: false, over: false, removers: [] };
      var listen = function (target, type, handler, capture) {
        target.addEventListener(type, handler, capture);
        drag.removers.push(function () { target.removeEventListener(type, handler, capture); });
      };
      listen(kicker, 'pointermove', moveKickerDrag);
      listen(kicker, 'pointerup', function (e) { endKickerDrag(e, true); });
      listen(kicker, 'pointercancel', function (e) { endKickerDrag(e, false); });
      listen(kicker, 'lostpointercapture', function (e) { endKickerDrag(e, false); });
      listen(doc, 'keydown', function (e) {
        if (e.key !== 'Escape' || !drag.committed) return;
        e.preventDefault();
        cancelKickerDrag();
      }, true);
      kickerDrag = drag;
    }
    function commitKickerDrag(drag, pointerId) {
      drag.committed = true;
      safely(function () { drag.kicker.setPointerCapture(pointerId); });
      var other = drag.paneId === 0 ? 1 : 0;
      var otherRoot = chatView.querySelector(':scope > .chat-pane[data-pane-id="' + other + '"]');
      drag.side = other === 0 ? 'left' : 'right';
      drag.rect = otherRoot ? otherRoot.getBoundingClientRect() : null;
      var title = drag.kicker.querySelector('.chat-pane-kicker-title');
      drag.ghost = doc.createElement('div');
      drag.ghost.className = 'workspace-tab-drag-ghost';
      drag.ghost.setAttribute('aria-hidden', 'true');
      drag.ghost.textContent = title ? title.textContent : '';
      doc.body.appendChild(drag.ghost);
    }
    function moveKickerDrag(event) {
      var drag = kickerDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.committed) {
        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        if (Math.sqrt(dx * dx + dy * dy) < KICKER_DRAG_THRESHOLD) return;
        commitKickerDrag(drag, event.pointerId);
      }
      drag.ghost.style.left = (event.clientX + 8) + 'px';
      drag.ghost.style.top = (event.clientY - 16) + 'px';
      var rect = drag.rect;
      var over = Boolean(rect) && event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom;
      if (over === drag.over) return;
      drag.over = over;
      setDropHover(over ? drag.side : null);
    }
    function endKickerDrag(event, drop) {
      var drag = kickerDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      var swap = drop && drag.committed && drag.over;
      cancelKickerDrag();
      if (swap && !isDisposed()) layoutController.swapPanes();
    }
    function cancelKickerDrag() {
      var drag = kickerDrag;
      if (!drag) return;
      kickerDrag = null;
      while (drag.removers.length) safely(drag.removers.pop());
      if (drag.ghost) safely(function () { drag.ghost.remove(); });
      if (drag.committed) safely(function () { drag.kicker.releasePointerCapture(drag.pointerId); });
      if (drag.over) setDropHover(null);
    }

    return {
      setDropHover: setDropHover,
      dropTarget: dropTarget,
      startKickerDrag: startKickerDrag,
      cancelKickerDrag: cancelKickerDrag,
    };
  }

  return { createPaneDragController: createPaneDragController };
});
