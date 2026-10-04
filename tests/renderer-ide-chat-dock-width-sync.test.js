'use strict';

/* Astra review of the 2026-09-27 gate fixes: the chat dock is budgeted
 * against the SHOWN rail and secondary sidebar (renderer-ide-layout.js), so a
 * side-panel gesture re-applies the dock width through syncWidth, and a drag
 * request that lands ON the viewport ceiling keeps a wider saved preference. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeChatDock } = require('../renderer/features/renderer-ide-chat-dock');

function setupDock(opts) {
  const dom = new JSDOM(`<!doctype html><body><section id="ideView"><div id="ideShell">
    <div id="ideMain"><div id="ideEditorHost" tabindex="0"></div></div>
    <aside id="ideChatDock" data-dock-side="right">
      <div id="ideChatDockResizer" role="separator" tabindex="0"></div>
      <header id="ideChatDockHeader"></header><div id="ideChatDockBody"></div>
    </aside></div></section></body>`);
  const byId = (id) => dom.window.document.getElementById(id);
  const ide = { chatDockOpen: true, chatDockSide: 'right', chatDockWidth: opts.width };
  const dock = createIdeChatDock({
    state: { ui: { activeView: 'ide' }, features: { featureFlags: { ide_chat_dock: true } }, sessions: [], currentSessionId: '' },
    getDom: () => ({ ideShell: byId('ideShell'), ideChatDock: byId('ideChatDock'), ideChatDockResizer: byId('ideChatDockResizer'),
      ideChatDockHeader: byId('ideChatDockHeader'), ideChatDockBody: byId('ideChatDockBody') }),
    getIde: () => ide,
    requestRender: () => {}, schedulePersist: () => {}, layoutIdeEditor: () => {},
    getMaxWidth: () => opts.maxWidth ?? Infinity,
    windowRef: dom.window,
  });
  return { dom, byId, ide, dock, shown: () => byId('ideShell').style.getPropertyValue('--ide-chat-dock-width') };
}

test('syncWidth re-applies the shown dock width through the live clamp without touching the saved preference', () => {
  const opts = { width: 1800, maxWidth: 760 };
  const { ide, dock, shown } = setupDock(opts);
  dock.render();
  assert.equal(shown(), '760px');
  opts.maxWidth = 500; // the rail grew: the dock's ceiling dropped
  dock.syncWidth();
  assert.equal(shown(), '500px', 'the new clamp shows at once');
  assert.equal(ide.chatDockWidth, 1800, 'the saved preference is untouched');
});

test('a dock drag with no horizontal delta at the viewport ceiling keeps the wider saved preference', () => {
  const { dom, byId, ide, dock, shown } = setupDock({ width: 1800, maxWidth: 760 });
  dock.render();
  dock.bindEvents();
  byId('ideChatDockResizer').dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 900, bubbles: true }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 900, clientY: 30 }));
  assert.equal(ide.chatDockWidth, 1800, 'a vertical-only move at the ceiling does not overwrite the saved 1800');
  assert.equal(shown(), '760px');
  // Right dock: the grab edge faces the editor, so moving right shrinks.
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 920 }));
  assert.equal(ide.chatDockWidth, 740, 'a shrink inside the ceiling is the new choice');
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 920 }));
  dock.dispose();
});
