/* renderer/chat/renderer-chat-layout-store.js - what the Chat room's layout remembers (UMD).
 *
 * Row 190: the Chat room is a workbench (renderer-chat-workbench.js) with the `chat` profile. Its layout
 * is one localStorage record, `jenny.chat.layout.v1` (owner decision D3: one record for the room, like the
 * Board), read back through `normalizeLayout(value, 'chat')`, so a stored tree can never gain a Workspace
 * or Board view.
 *
 * Migration, once: with no record yet, the old shell's saved sizes seed the default layout and the record
 * is written at once, so a later change to those old keys is never read again:
 *   - the Chats panel's width and collapsed state (`jenny.panels.v2` byView.chat);
 *   - the side panel's width (`jenny.artifactReview.v1` width) and the session rail's width
 *     (`jenny.sessionRail.v1` width): the wider one seeds the right stack.
 * The old keys are left in place and never read after that first seed (a damaged record resets to the default). Every access is guarded: no storage, a
 * full one or a damaged value reads as "nothing saved". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatLayoutStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LAYOUT_KEY = 'jenny.chat.layout.v1';
  const LEGACY_PANELS_KEY = 'jenny.panels.v2';
  const LEGACY_SIDE_PANEL_KEY = 'jenny.artifactReview.v1';
  const LEGACY_SESSION_RAIL_KEY = 'jenny.sessionRail.v1';
  const LEGACY_MIN = 120;
  const LEGACY_MAX = 2400;

  function legacyWidth(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= LEGACY_MIN && n <= LEGACY_MAX ? Math.round(n) : null;
  }

  // Row 195: Tasks and Notes became one Project tab, Helpers and Background tasks one Runs tab. A saved tree
  // keeps the tab's place and whether it was the open one; a second old tab of the pair is dropped.
  const RENAMED_VIEWS = Object.freeze({ tasks: 'project', notes: 'project', helpers: 'runs', background: 'runs' });
  const renamed = (id) => (Object.prototype.hasOwnProperty.call(RENAMED_VIEWS, id) ? RENAMED_VIEWS[id] : id);
  function upgradeViews(node, depth) {
    if (!node || typeof node !== 'object' || depth > 32) return node;
    if (Array.isArray(node.children)) {
      return Object.assign({}, node, { children: node.children.map((child) => (child && typeof child === 'object' ? Object.assign({}, child, { node: upgradeViews(child.node, depth + 1) }) : child)) });
    }
    if (!Array.isArray(node.views)) return node;
    const views = node.views.map(renamed).filter((id, at, list) => list.indexOf(id) === at);
    return Object.assign({}, node, { views, active: renamed(node.active) });
  }

  function createChatLayoutStore({ storage, model }) {
    function read(key) {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (_error) {
        return null;
      }
    }
    function write(key, value) {
      try { storage.setItem(key, JSON.stringify(value)); } catch (_error) { /* a full or blocked store only costs the memory */ }
    }

    // The old shell's sizes, or null for each one it never saved.
    function readLegacy() {
      const panels = read(LEGACY_PANELS_KEY);
      const chat = panels && panels.byView && typeof panels.byView === 'object' ? panels.byView.chat : null;
      const side = read(LEGACY_SIDE_PANEL_KEY);
      const rail = read(LEGACY_SESSION_RAIL_KEY);
      const sideWidth = legacyWidth(side && side.width);
      const railWidth = legacyWidth(rail && rail.width);
      return {
        chatsWidth: legacyWidth(chat && chat.width),
        chatsCollapsed: Boolean(chat && chat.collapsed === true),
        rightWidth: sideWidth === null ? railWidth : railWidth === null ? sideWidth : Math.max(sideWidth, railWidth),
      };
    }

    function seededDefault() {
      let layout = model.createDefaultLayout('chat');
      const legacy = readLegacy();
      const chats = model.findView(layout, 'chats');
      const right = model.findView(layout, 'session');
      if (chats && legacy.chatsWidth !== null) layout = model.setStackSize(layout, chats.stackId, legacy.chatsWidth);
      if (chats && legacy.chatsCollapsed) layout = model.setCollapsed(layout, chats.stackId, true);
      if (right && legacy.rightWidth !== null) layout = model.setStackSize(layout, right.stackId, legacy.rightWidth);
      return layout;
    }

    // Whether the room ever saved a layout, readable or not.
    function hasRecord() {
      try { return storage.getItem(LAYOUT_KEY) !== null; } catch (_error) { return false; }
    }

    function loadLayout() {
      const saved = read(LAYOUT_KEY);
      const layout = saved && typeof saved === 'object' ? model.normalizeLayout(Object.assign({}, saved, { root: upgradeViews(saved.root, 0) }), 'chat') : null;
      if (layout) return layout;
      // The old shell seeds a room that never saved; a damaged record gets the plain default, not sizes from before it.
      const seeded = hasRecord() ? model.createDefaultLayout('chat') : seededDefault();
      write(LAYOUT_KEY, seeded);
      return seeded;
    }

    function saveLayout(layout) {
      write(LAYOUT_KEY, layout);
    }

    return { loadLayout, saveLayout };
  }

  return { createChatLayoutStore, LAYOUT_KEY };
});
