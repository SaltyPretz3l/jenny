'use strict';

// The browser panel over a JSDOM page and a logging bridge, shared by the panel and bar tests.
const { JSDOM } = require('jsdom');

const actionButton = require('../../renderer/inventory/action-button');
const chip = require('../../renderer/inventory/chip');
const popover = require('../../renderer/inventory/popover');
const textField = require('../../renderer/inventory/text-field');
const urlField = require('../../renderer/inventory/url-field');
const panelModule = require('../../renderer/chat/renderer-browser-use-panel');

const BRIDGE_METHODS = ['getState', 'show', 'setBounds', 'hide', 'capture', 'takeOver', 'handBack', 'close', 'navigate', 'zoom', 'find', 'stopFind', 'siteInfo', 'removeSite', 'revealDownload', 'configure'];

const settle = () => new Promise((resolve) => setImmediate(resolve));
const blankPage = { session_id: 's1', mode: 'model', loading: false, busy: false, action: '', target: '', asking: false, waiting: false };
const openPage = (extra = {}) => ({ ...blankPage, open: true, url: 'https://shop.example/cart', title: 'Cart', can_back: false, can_forward: false, ...extra });
const closedPage = (extra = {}) => ({ ...blankPage, open: false, url: '', title: '', ...extra });

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="composer-wrap"><div class="composer-status-notice"></div><button id="composer">composer</button><div id="chipHost"></div></div>
    <aside id="artifactReviewPanel" class="artifact-review-panel hidden">
      <div class="artifact-panel-header"><div data-artifact-panel-title-slot></div><div class="artifact-panel-header-actions"><button id="artifactReviewCollapseButton">x</button></div></div>
      <div id="content"></div>
    </aside></body>`);
  const { window } = dom;
  const doc = window.document;
  const panelEl = doc.getElementById('artifactReviewPanel');
  const surface = { previewContent: doc.getElementById('content') };
  const ctx = {
    doc, panelEl, surface, chipHost: doc.getElementById('chipHost'), calls: [], opens: [], toggles: 0, changed: null, unsubscribed: 0, sent: [], streaming: false, timers: [],
    answers: { getState: { ok: true, ...closedPage() } },
    state: { currentSessionId: 's1' }, panelSession: 's1',
  };
  const bridgeMethod = (name) => (payload) => { ctx.calls.push([name, payload]); return Promise.resolve(ctx.answers[name] ?? { ok: true }); };
  const windowRef = {
    document: doc, innerWidth: 1400, innerHeight: 900,
    MutationObserver: window.MutationObserver,
    inventory: { actionButton, chip, popover },
    inventoryTextField: textField, inventoryUrlField: urlField,
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 21, 22)' }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: (fn) => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    jennyShell: { browserUse: {
      ...Object.fromEntries(BRIDGE_METHODS.map((name) => [name, bridgeMethod(name)])),
      onChanged: (fn) => { ctx.changed = fn; return () => { ctx.unsubscribed += 1; }; },
    } },
  };
  ctx.windowRef = windowRef;
  ctx.showRail = (mode) => {
    panelEl.dataset.artifactReviewMode = mode;
    panelEl.classList.remove('hidden');
  };
  ctx.panel = panelModule.createBrowserUsePanel({
    state: ctx.state, windowRef, dom: { artifactReviewPanel: panelEl },
    openArtifactRail: (mode, options) => { ctx.opens.push([mode, options]); ctx.showRail(mode); },
    renderArtifactReviewPanel: () => ctx.panel.renderRailContent(surface),
    toggleArtifactReview: () => { ctx.toggles += 1; panelEl.classList.add('hidden'); },
    getPanelSessionId: () => ctx.panelSession,
    isSessionStreaming: () => ctx.streaming,
    sendPrompt: (text, id) => ctx.sent.push([text, id]),
  });
  ctx.panel.bind();
  ctx.sync = async (enabled, sessionId = ctx.state.currentSessionId) => {
    ctx.panel.sync({ sessionId, enabled, chipHost: ctx.chipHost });
    await settle();
  };
  ctx.chip = () => doc.getElementById('composerBrowserChip');
  ctx.status = () => doc.querySelector('.bu-status');
  ctx.statusText = () => doc.querySelector('.bu-status-text')?.textContent;
  ctx.named = (method) => ctx.calls.filter((call) => call[0] === method);
  ctx.line = (action) => `.bu-line-action[data-browser-use-action="${action}"]`;
  ctx.action = (action) => doc.querySelector(`[data-browser-use-action="${action}"]`);
  ctx.visible = (selector) => { const node = doc.querySelector(selector); return Boolean(node) && !node.classList.contains('hidden'); };
  ctx.key = (node, key, extra = {}) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  ctx.window = window;
  return ctx;
}

async function withOpenPanel(page = openPage()) {
  const ctx = setup();
  await ctx.sync(true);
  ctx.changed(page);
  await settle();
  return ctx;
}

module.exports = { settle, openPage, closedPage, setup, withOpenPanel };
