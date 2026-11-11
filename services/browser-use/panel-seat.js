'use strict';

/**
 * Where a chat's page sits in the window: beside the chat while its panel shows,
 * parked off screen otherwise. The panel measures in CSS pixels; a native view is
 * placed in window coordinates.
 */

const { createEntryLookup, validBounds } = require('./service-support');

function createPanelSeat({ entries, getMainWindow, touch }) {
  const { withEntry } = createEntryLookup(entries);

  function toWindowBounds(bounds) {
    let zoom = 1;
    try {
      zoom = Number(getMainWindow?.()?.webContents?.getZoomFactor?.()) || 1;
    } catch (_error) { /* the window is going away; the next layout corrects this */ }
    const scale = (value) => Math.round(value * zoom);
    return { x: scale(bounds.x), y: scale(bounds.y), width: scale(bounds.width), height: scale(bounds.height) };
  }

  function show(sessionId, bounds) {
    return withEntry(sessionId, (entry) => {
      if (!validBounds(bounds)) return { ok: false, reason: 'invalid_bounds' };
      entry.panelBounds = toWindowBounds(bounds);
      entry.lastSize = { width: entry.panelBounds.width, height: entry.panelBounds.height };
      entry.host.place(entry.panelBounds);
      touch(entry);
      return { ok: true };
    });
  }

  function setBounds(sessionId, bounds) {
    return withEntry(sessionId, (entry) => {
      if (!validBounds(bounds)) return { ok: false, reason: 'invalid_bounds' };
      // A resize that trails a hide must not bring the page back on screen.
      if (!entry.panelBounds) return { ok: false, reason: 'not_shown' };
      return show(sessionId, bounds);
    });
  }

  function hide(sessionId) {
    return withEntry(sessionId, (entry) => {
      entry.panelBounds = null;
      entry.host.offscreen(entry.lastSize);
      touch(entry);
      return { ok: true };
    });
  }

  // The app itself is reloading: the panel these pages sat in no longer exists.
  function hideAll() {
    for (const entry of entries.values()) {
      if (!entry.panelBounds) continue;
      entry.panelBounds = null;
      entry.host.offscreen(entry.lastSize);
      touch(entry);
    }
  }

  return { show, setBounds, hide, hideAll };
}

module.exports = { createPanelSeat };
