/* renderer/app/renderer-pane-drag-controller.js -- split view drag-to-split (UMD) */
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
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPaneDragController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createPaneDragController(deps) {
    var options = deps || {};
    var chatView = options.chatView;
    var layoutController = options.layoutController;
    var doc = options.documentRef || chatView.ownerDocument;
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

    return {
      setDropHover: setDropHover,
      dropTarget: dropTarget,
    };
  }

  return { createPaneDragController: createPaneDragController };
});
