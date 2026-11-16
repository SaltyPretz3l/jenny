/* renderer/inventory/drag-handle.js
 *
 * Pointer-capture drag on one element. Nothing fires until the pointer has moved
 * `threshold` px, so a click stays a click. Escape cancels a live drag. Only the
 * primary button of the primary pointer starts one. The caller owns what a drag means. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.inventoryDragHandle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_THRESHOLD = 3;

  function dragHandle(element, options) {
    var settings = options || {};
    var threshold = Number.isFinite(settings.threshold) && settings.threshold >= 0 ? settings.threshold : DEFAULT_THRESHOLD;
    var doc = element.ownerDocument;
    var gesture = null;
    var swallowClick = false;
    var swallowTimer = null;
    var disposed = false;
    var removers = [];

    function listen(target, type, callback, capture) {
      target.addEventListener(type, callback, capture);
      var remove = function () { target.removeEventListener(type, callback, capture); };
      removers.push(remove);
      return remove;
    }
    function payload(event) {
      return {
        dx: event.clientX - gesture.x, dy: event.clientY - gesture.y,
        clientX: event.clientX, clientY: event.clientY, event: event,
      };
    }
    function release(id) {
      try {
        if (typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(id)) element.releasePointerCapture(id);
      } catch (ignored) { /* the pointer is already gone */ }
    }
    function finish(kind, event) {
      if (!gesture) return;
      var previous = gesture;
      var data = event ? payload(event) : { dx: previous.lastDx, dy: previous.lastDy, clientX: previous.x + previous.lastDx, clientY: previous.y + previous.lastDy, event: null };
      gesture = null;
      stopEscape();
      release(previous.id);
      if (!previous.started) return;
      if (kind === 'end') armClickSwallow();
      var callback = kind === 'end' ? settings.onEnd : settings.onCancel;
      if (typeof callback === 'function') callback(data);
    }
    // A drag that ends over its own element would otherwise be followed by a click.
    function armClickSwallow() {
      swallowClick = true;
      if (swallowTimer) clearTimeout(swallowTimer);
      swallowTimer = setTimeout(function () { swallowClick = false; swallowTimer = null; }, 0);
    }

    var stopEscape = function () {};
    function startEscape() {
      stopEscape();
      var onKey = function (event) {
        if (event.key !== 'Escape' || !gesture) return;
        if (gesture.started) event.preventDefault(); // a press that never moved leaves Escape to the page
        finish('cancel', null);
      };
      doc.addEventListener('keydown', onKey, true);
      stopEscape = function () { doc.removeEventListener('keydown', onKey, true); stopEscape = function () {}; };
    }

    listen(element, 'pointerdown', function (event) {
      if (disposed || gesture || event.button !== 0 || event.isPrimary === false) return;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, started: false, lastDx: 0, lastDy: 0 };
      try { if (typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId); } catch (ignored) { /* synthetic pointer */ }
      startEscape();
    });
    listen(element, 'pointermove', function (event) {
      if (!gesture || event.pointerId !== gesture.id) return;
      var dx = event.clientX - gesture.x;
      var dy = event.clientY - gesture.y;
      if (!gesture.started) {
        if (Math.hypot(dx, dy) < threshold) return;
        gesture.started = true;
        gesture.lastDx = dx; gesture.lastDy = dy;
        if (typeof settings.onStart === 'function') settings.onStart(payload(event));
        if (!gesture) return; // a callback ended the drag
      }
      gesture.lastDx = dx; gesture.lastDy = dy;
      if (typeof settings.onMove === 'function') settings.onMove(payload(event));
    });
    listen(element, 'pointerup', function (event) {
      if (gesture && event.pointerId === gesture.id) finish('end', event);
    });
    listen(element, 'pointercancel', function (event) {
      if (gesture && event.pointerId === gesture.id) finish('cancel', event);
    });
    listen(element, 'lostpointercapture', function (event) {
      if (gesture && event.pointerId === gesture.id) finish('cancel', event);
    });
    listen(element, 'click', function (event) {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    }, true);

    return {
      dispose: function () {
        if (disposed) return;
        finish('cancel', null);
        disposed = true;
        stopEscape();
        if (swallowTimer) clearTimeout(swallowTimer);
        removers.forEach(function (remove) { remove(); });
        removers = [];
      },
    };
  }

  return dragHandle;
});
