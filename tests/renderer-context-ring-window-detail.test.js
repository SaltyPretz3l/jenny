/* The composer ring's detail text names the full context window next to the
 * auto-compact threshold it renders against (owner gate 2026-09-20). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventoryChip = require('../renderer/inventory/chip');
const inventoryTooltip = require('../renderer/inventory/tooltip');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const contextMeterDetails = require('../renderer/chat/renderer-context-meter-details');

function withInventory(t) {
  global.inventory = { chip: inventoryChip };
  t.after(() => {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
    contextMeterDetails.dispose();
    inventoryTooltip.unpin();
    inventoryTooltip.hide();
  });
  contextUsageUtils.clearAllUsage();
}

function renderRing(dom, sessionId) {
  const doc = dom.window.document;
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  host.innerHTML = contextUsageUtils.renderContextUsage(sessionId) || '';
  return host.querySelector('#composerContextRing');
}

test('ring tooltip names the full window when the target is the auto-compact threshold', (t) => {
  // Owner gate 2026-09-20: "the meter said the window was only 38K".
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  contextUsageUtils.updateUsage('ring-window', {
    usage: {
      total_tokens: 12000,
      last_request_input_tokens: 12000,
      context_tokens_estimate: 12000,
      context_window: 65536,
      compact_threshold_tokens: 38000,
      model: 'test-model',
    },
  });
  const ring = renderRing(dom, 'ring-window');
  const title = ring.getAttribute('title');
  assert.match(title, /12\.0k of 38\.0k tokens before auto-compact/);
  assert.match(title, /12\.0k of 65\.5k token context window/);
  assert.match(ring.getAttribute('aria-label'), /12\.0k \/ 38\.0k/);
});
