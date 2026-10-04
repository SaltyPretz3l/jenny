/* Collapsed settings popover row (spec 2026-09-26 §4 step 3): the context
 * ring chip also carries a thin usage bar sized by --usage-ratio and a visible
 * percent. The stylesheet hides both on the toolbar and hides the ring in the
 * popover; aria-label, title and the severity classes stay as they were.
 * Split from renderer-context-ring.test.js (line cap). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventoryChip = require('../renderer/inventory/chip');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');

function withInventory(t) {
  global.inventory = { chip: inventoryChip };
  t.after(() => {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  });
  contextUsageUtils.clearAllUsage();
}

// Provider-truth usage with an explicit compaction budget as the denominator.
function seedUsage(sessionId, usedTokens, compactBudget) {
  contextUsageUtils.updateUsage(sessionId, {
    usage: {
      total_tokens: usedTokens,
      last_request_input_tokens: usedTokens,
      context_tokens_estimate: usedTokens,
      context_window: compactBudget,
      compact_threshold_tokens: compactBudget,
      model: 'test-model',
    },
  });
}

function renderRing(dom, sessionId) {
  const doc = dom.window.document;
  let host = doc.getElementById('ringHost');
  if (!host) {
    host = doc.createElement('div');
    host.id = 'ringHost';
    doc.body.appendChild(host);
  }
  host.innerHTML = contextUsageUtils.renderContextUsage(sessionId) || '';
  return host.querySelector('#composerContextRing');
}
test('the ring chip carries --usage-ratio, a usage bar and a visible percent after the ring', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-bar', 437, 1000);
  const ring = renderRing(dom, 'ring-bar');
  assert.equal(ring.getAttribute('style'), '--usage-ratio:0.437');
  assert.equal(ring.style.getPropertyValue('--usage-ratio'), '0.437');
  const children = Array.from(ring.children);
  assert.equal(children.length, 3, 'icon, bar, percent');
  assert.ok(children[0].classList.contains('inv-chip-icon'), 'the ring svg icon stays first');
  assert.ok(children[0].querySelector('.inv-context-ring-svg'));
  const bar = children[1];
  assert.equal(bar.className, 'inv-usage-bar');
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(bar.innerHTML, '<span class="inv-usage-bar-fill"></span>');
  const percent = children[2];
  assert.equal(percent.className, 'inv-chip-label inv-context-ring-percent');
  assert.equal(percent.textContent, '44%', 'the aria-label rounding');
  assert.equal(ring.querySelectorAll('.inv-chip-label').length, 1, 'one label, not a duplicate');
  assert.match(ring.getAttribute('aria-label'), /· 44%$/, 'aria-label unchanged and agrees with the visible percent');
  assert.match(ring.getAttribute('title'), /^Context: 44%\n/);
  assert.equal(ring.getAttribute('aria-haspopup'), null, 'no popover primitive in this harness, no popup');
});

test('the bar ratio clamps to 0..1 at 4 decimals and the severity classes still colour it', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-bar-fine', 1, 3);
  let ring = renderRing(dom, 'ring-bar-fine');
  assert.equal(ring.style.getPropertyValue('--usage-ratio'), '0.3333', 'four decimals at most');
  assert.equal(ring.querySelector('.inv-context-ring-percent').textContent, '33%');

  seedUsage('ring-bar-warn', 800, 1000);
  ring = renderRing(dom, 'ring-bar-warn');
  assert.equal(ring.style.getPropertyValue('--usage-ratio'), '0.8');
  assert.ok(ring.classList.contains('inv-context-ring--warning'), 'warning class on the chip at 0.8');
  assert.equal(ring.querySelector('.inv-context-ring-percent').textContent, '80%');

  seedUsage('ring-bar-danger', 950, 1000);
  ring = renderRing(dom, 'ring-bar-danger');
  assert.ok(ring.classList.contains('inv-context-ring--danger'), 'danger class on the chip at 0.95');
  assert.equal(ring.querySelector('.inv-context-ring-percent').textContent, '95%');

  seedUsage('ring-bar-over', 1500, 1000);
  ring = renderRing(dom, 'ring-bar-over');
  assert.equal(ring.style.getPropertyValue('--usage-ratio'), '1', 'an overshoot clamps to 1');
  assert.equal(ring.querySelector('.inv-context-ring-percent').textContent, '100%');

  seedUsage('ring-bar-tiny', 1200, 131072);
  ring = renderRing(dom, 'ring-bar-tiny');
  assert.equal(ring.querySelector('.inv-context-ring-percent').textContent, '<1%', 'the same label the aria-label reads');
  assert.equal(ring.style.getPropertyValue('--usage-ratio'), '0.0092');
});
