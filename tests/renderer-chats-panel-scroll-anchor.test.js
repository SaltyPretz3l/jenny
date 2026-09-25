const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');

const ROW_HEIGHT = 40;
const CLIENT_HEIGHT = 200;

function buildSessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `Chat ${index}`,
    updated_at: new Date(Date.UTC(2026, 7, 14, 12, 0, 0) - index * 1000).toISOString(),
    pinned: false,
    archived_at: null,
  }));
}

// jsdom has no layout: rows sit at index * ROW_HEIGHT - scrollTop.
function createHarness() {
  const dom = new JSDOM('<!doctype html><html><body><div id="groups"></div></body></html>');
  const document = dom.window.document;
  const groups = document.getElementById('groups');
  const state = { sessions: buildSessions(120), currentSessionId: 'session-0', ui: { pendingSessionDeletes: [] }, sendOutboxBySession: new Map() };
  const controller = createChatsPanelController({
    state,
    documentRef: document,
    windowRef: { Event: dom.window.Event, requestAnimationFrame: () => 0, cancelAnimationFrame() {} },
    dom: { conversationGroups: groups },
    inventory: { actionButton, segmentedControl },
    callbacks: { escapeHtml: actionButton.escapeHtml },
  });
  controller.renderNow();
  const rows = () => [...controller.getVisibleSessionElements()];
  Object.defineProperty(groups, 'clientHeight', { configurable: true, value: CLIENT_HEIGHT });
  Object.defineProperty(groups, 'scrollHeight', { configurable: true, get: () => rows().length * ROW_HEIGHT });
  groups.getBoundingClientRect = () => ({ top: 0, bottom: CLIENT_HEIGHT });
  rows().forEach((row) => {
    row.getBoundingClientRect = () => {
      const top = rows().indexOf(row) * ROW_HEIGHT - groups.scrollTop;
      return { top, bottom: top + ROW_HEIGHT };
    };
  });
  return { dom, document, groups, state, controller };
}

test('a chat that moves to the top shows there when the list sits at its top', () => {
  const { dom, groups, state, controller } = createHarness();
  groups.scrollTop = 0;

  state.sessions[50].pinned = true;
  controller.renderNow();

  assert.equal(groups.scrollTop, 0, 'the list does not shove down a row to keep the old first row');
  assert.equal(controller.getVisibleSessionElements()[0].dataset.sessionId, 'session-50');
  controller.dispose();
  dom.window.close();
});

test('scroll restoration keeps the browser\'s own anchoring adjustment instead of undoing it', () => {
  const { dom, document, groups, state, controller } = createHarness();
  groups.scrollTop = 50 * ROW_HEIGHT + 7;
  const anchorRow = document.querySelector('[data-session-id="session-50"]');
  const baseRect = anchorRow.getBoundingClientRect;
  let reads = 0;
  anchorRow.getBoundingClientRect = function () {
    reads += 1;
    // Read 1 is the capture; read 2 is the restore, whose forced layout has
    // already applied Chromium's scroll anchoring for the row pinned above.
    if (reads === 2) groups.scrollTop += ROW_HEIGHT;
    return baseRect.call(this);
  };

  state.sessions[80].pinned = true;
  controller.renderNow();

  assert.equal(anchorRow.getBoundingClientRect().top, -7, 'the anchor row keeps its viewport offset');
  assert.equal(groups.scrollTop, 51 * ROW_HEIGHT + 7);
  controller.dispose();
  dom.window.close();
});
