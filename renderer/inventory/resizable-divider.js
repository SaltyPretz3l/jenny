/* A horizontal, keyboard-accessible divider. The caller owns size and session state. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.inventoryResizableDivider = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createResizableDivider(options) {
    var host = options.host;
    var node = host.ownerDocument.createElement('div');
    var min = options.min;
    var max = options.max;
    var drag = null;
    var disposed = false;
    var listeners = [];
    node.className = 'inv-resizable-divider';
    node.tabIndex = 0;
    node.setAttribute('role', 'separator');
    node.setAttribute('aria-orientation', 'horizontal');
    node.setAttribute('aria-label', options.label);
    node.setAttribute('aria-controls', options.controls);
    node.setAttribute('aria-valuemin', String(min));
    node.setAttribute('aria-valuemax', String(max));
    host.appendChild(node);

    function sync() {
      node.setAttribute('aria-valuenow', String(Math.round(options.getValue())));
    }
    function set(value) {
      options.setValue(Math.max(min, Math.min(max, value)));
      sync();
    }
    function finish(cancel) {
      if (!drag) return;
      var previous = drag;
      drag = null;
      node.removeAttribute('data-resizing');
      if (cancel) set(previous.value);
      if (node.hasPointerCapture?.(previous.id)) node.releasePointerCapture(previous.id);
    }
    function listen(type, callback) {
      node.addEventListener(type, callback);
      listeners.push(function () { node.removeEventListener(type, callback); });
    }
    function enabled() { return !disposed && (!options.isEnabled || options.isEnabled()); }
    listen('pointerdown', function (event) {
      if (!enabled() || drag || event.button !== 0 || event.isPrimary === false) return;
      var size = options.measureSize();
      if (!(size > 0)) return;
      drag = { id: event.pointerId, y: event.clientY, value: options.getValue(), size: size };
      node.setPointerCapture?.(event.pointerId);
      node.setAttribute('data-resizing', '');
      node.focus({ preventScroll: true });
      event.preventDefault();
    });
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (!enabled()) { finish(true); return; }
      set(drag.value + (event.clientY - drag.y) / drag.size * 100);
    }
    listen('pointermove', move);
    listen('pointerup', function (event) {
      if (drag && event.pointerId === drag.id) { move(event); finish(false); }
    });
    listen('pointercancel', function (event) { if (drag && event.pointerId === drag.id) finish(true); });
    listen('lostpointercapture', function (event) { if (drag && event.pointerId === drag.id) finish(false); });
    listen('keydown', function (event) {
      if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return; }
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return; // leave chords to the app
      if (!enabled() || drag || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      set(event.key === 'Home' ? min : event.key === 'End' ? max
        : options.getValue() + (event.key === 'ArrowDown' ? 5 : -5));
    });
    sync();
    return {
      element: node,
      cancel: function () { finish(true); },
      dispose: function () {
        if (disposed) return;
        finish(true);
        disposed = true;
        listeners.forEach(function (remove) { remove(); });
        node.remove();
      },
    };
  }
  return Object.freeze({ createResizableDivider: createResizableDivider });
});
