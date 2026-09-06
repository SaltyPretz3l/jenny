/* comet-overlay-bootstrap.js — wires the comet glow renderer to the overlay
 * presence bridge inside the transparent overlay BrowserWindow. */
(function () {
  'use strict';

  var canvas = document.getElementById('overlayCanvas');
  var renderer = window.overlayCometRenderer
    ? window.overlayCometRenderer.create(canvas)
    : null;

  if (!window.overlayBridge) {
    return;
  }

  window.overlayBridge.onStateChanged(function (data) {
    if (renderer && typeof renderer.applyPresence === 'function') {
      renderer.applyPresence(data);
    } else if (renderer) {
      renderer.setState(data.state || 'idle');
    }
  });

  window.overlayBridge.onDispose(function () {
    if (renderer) {
      renderer.dispose();
      renderer = null;
    }
  });
}());
