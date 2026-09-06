/* comet/comet-dom.js – persistent DOM layer for comet personality (UMD) */
/* global document */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometDomUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var LAYER_CLASS = 'comet-personality-layer';

  function createCometDomLayer(parentEl) {
    if (!parentEl) return null;
    var doc = parentEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;

    var layer = doc.createElement('div');
    layer.className = LAYER_CLASS;
    layer.setAttribute('aria-hidden', 'true');
    parentEl.appendChild(layer);

    var disposed = false;

    function show() {
      if (disposed) return;
      layer.classList.add('visible');
    }

    function getElement() {
      return disposed ? null : layer;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (layer.parentNode) {
        layer.parentNode.removeChild(layer);
      }
    }

    return {
      show: show,
      getElement: getElement,
      dispose: dispose,
    };
  }

  return { createCometDomLayer: createCometDomLayer };
});
