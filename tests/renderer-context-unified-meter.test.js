'use strict';

/* Row 63 (2026-10-19): the composer context ring and the Session summary rail read ONE next-send
   estimate, so a chat shows one context number. Same session, same moment, the live app showed
   the ring at 50% (last request against the auto-compact point) and the rail at 47% (next send
   against the window). These tests pin the shared projection, the shared store, the ring's
   resolution order and the shared breakdown markup. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventoryChip = require('../renderer/inventory/chip');
const inventoryPopover = require('../renderer/inventory/popover');
const inventoryActionButton = require('../renderer/inventory/action-button');
const contextPreview = require('../renderer/chat/renderer-context-preview');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const railModel = require('../renderer/chat/renderer-session-rail-model');

const SID = 'sess_unified';
// The live app's numbers: 15.5k next send, a 32.8k window, auto-compact at 24.6k.
const ESTIMATE = Object.freeze({
  status: 'estimated', scope: 'next_send', measurement: 'estimated',
  used_tokens: 15466, capacity_tokens: 32768, available_tokens: 17302, compact_at_tokens: 24600, reserve_tokens: 8168,
  breakdown: Object.freeze({ messages: 367, system_prompt: 1334, tools: 12560, instructions: 63, skills: 729, other: 413 }),
  sampled_at: '2026-10-19T15:27:06.104Z',
});

function fresh(t) {
  contextPreview.resetForTests();
  contextUsageUtils.clearAllUsage();
  t.after(() => {
    contextPreview.resetForTests();
    contextUsageUtils.clearAllUsage();
    delete global.inventory;
  });
}

function railContext(data) {
  return railModel.buildSection('context', { state: 'available', data }, (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d));
}

test('one estimate, one number: the rail and the ring agree on the percent of the auto-compact point', (t) => {
  fresh(t);
  contextPreview.remember(SID, ESTIMATE);
  const ring = contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true });
  const rail = railContext(ESTIMATE);
  assert.equal(ring.percentLabel, '63%');
  assert.equal(rail.valueText, ring.percentLabel);
  assert.equal(ring.targetType, 'auto_compact');
  assert.equal(ring.limit, 24600);
  assert.equal(ring.source, 'next_send');
});

test('the draft moves both surfaces by the same amount', (t) => {
  fresh(t);
  contextPreview.remember(SID, ESTIMATE);
  const draft = 'x'.repeat(4000);
  const ring = contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true, draftText: draft });
  const rail = railContext(contextPreview.withDraft(ESTIMATE, draft, []));
  assert.equal(rail.valueText, ring.percentLabel);
  assert.ok(ring.used > ESTIMATE.used_tokens);
});

test('without a compaction point both read the share of the window', (t) => {
  fresh(t);
  const windowOnly = { ...ESTIMATE, compact_at_tokens: null, reserve_tokens: null };
  contextPreview.remember(SID, windowOnly);
  const ring = contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true });
  assert.equal(ring.percentLabel, '47%');
  assert.equal(railContext(windowOnly).valueText, '47%');
  assert.equal(contextPreview.formatPercent(1, 1000), '<1%');
  assert.equal(contextPreview.formatPercent(5000, 1000), '100%', 'one rounding and cap for every surface');
});

test('a reading that landed after the estimate wins until the estimate refreshes', (t) => {
  fresh(t);
  contextPreview.remember(SID, ESTIMATE, Date.parse(ESTIMATE.sampled_at));
  let now = Date.parse(ESTIMATE.sampled_at) - 60000;
  // An older terminal reading loses to the estimate.
  contextUsageUtils.updateUsage(SID, { usage: { context_used_tokens: 9000, context_used_source: 'provider', compact_threshold_tokens: 24600, context_window: 32768 } });
  const stored = contextUsageUtils.getUsage(SID);
  stored.updatedAt = now;
  assert.equal(contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true }).source, 'next_send');
  // A finished reply after the estimate's sample shows until the refreshed estimate arrives.
  now = Date.parse(ESTIMATE.sampled_at) + 60000;
  stored.updatedAt = now;
  assert.equal(contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true }).source, 'provider');
  contextPreview.remember(SID, { ...ESTIMATE, used_tokens: 16000, sampled_at: new Date(now + 1000).toISOString() });
  assert.equal(contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true }).used, 16000);
});

test('while a reply runs the ring follows the live request; a leftover mid-turn record does not', (t) => {
  fresh(t);
  contextPreview.remember(SID, ESTIMATE);
  contextUsageUtils.updateUsage(SID, { type: 'context_usage', phase: 'iteration', streamId: 'stream_1',
    usage: { context_used_tokens: 21000, context_used_source: 'provider', compact_threshold_tokens: 24600, context_window: 32768 } });
  const live = contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true, turnActive: true });
  assert.equal(live.used, 21000);
  assert.equal(live.live, true);
  const idle = contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true, turnActive: false });
  assert.equal(idle.live, false);
});

test('a reply\'s first moment, before its first live reading, keeps the next-send estimate', (t) => {
  fresh(t);
  contextPreview.remember(SID, ESTIMATE);
  const fallbackEstimate = { usedTokens: 9200, compactThresholdTokens: 17500, contextLimit: 32768, usageSource: 'estimate' };
  const starting = contextUsageUtils.describeContextUsage(SID, { autoCompactEnabled: true, turnActive: true, fallbackEstimate });
  assert.equal(starting.source, 'next_send');
  assert.equal(starting.used, ESTIMATE.used_tokens);
  assert.equal(starting.percentLabel, '63%');
});

test('the store shares one flight, reuses a fresh answer, and never lets an older answer win', async (t) => {
  fresh(t);
  let calls = 0;
  const request = async () => { calls += 1; return { preview: { ...ESTIMATE, sampled_at: undefined } }; };
  let clock = 1000;
  await Promise.all([contextPreview.refresh(SID, request, { now: () => clock }), contextPreview.refresh(SID, request, { now: () => clock })]);
  assert.equal(calls, 1, 'concurrent refreshes share a flight');
  clock += 500;
  await contextPreview.refresh(SID, request, { now: () => clock });
  assert.equal(calls, 1, 'an answer from a moment ago is reused');
  await contextPreview.refresh(SID, request, { now: () => clock, force: true });
  assert.equal(calls, 2);
  const heard = [];
  const stop = contextPreview.subscribe((sessionId) => heard.push(sessionId));
  t.after(stop);
  assert.equal(contextPreview.remember(SID, { ...ESTIMATE, used_tokens: 20000, sampled_at: '2099-01-01T00:00:00Z' }), true);
  assert.deepEqual(heard, [SID]);
  assert.equal(contextPreview.remember(SID, { ...ESTIMATE, used_tokens: 1, sampled_at: '2001-01-01T00:00:00Z' }), false, 'older answer ignored');
  assert.equal(contextPreview.latest(SID).data.used_tokens, 20000);
  assert.equal(contextPreview.remember(SID, { ...ESTIMATE, used_tokens: 20000, sampled_at: '2099-01-01T00:00:01Z' }), false, 'an unchanged estimate is silent');
  assert.equal(contextPreview.remember(SID, { status: 'unavailable' }), false);
});

test('a forced refresh asks again once an older flight lands instead of taking its answer', async (t) => {
  fresh(t);
  const answers = [];
  const request = () => new Promise((resolve) => answers.push(resolve));
  const older = contextPreview.refresh(SID, request);
  const forced = contextPreview.refresh(SID, request, { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 1, 'one flight at a time');
  answers[0]({ preview: { ...ESTIMATE, used_tokens: 1000, sampled_at: undefined } });
  await older;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 2, 'the forced call re-asks after the older flight');
  answers[1]({ preview: { ...ESTIMATE, used_tokens: 2000, sampled_at: undefined } });
  assert.equal((await forced).data.used_tokens, 2000);
});

test('the composer feed refreshes on changed inputs outside a reply and repaints on the chat\'s estimate', async (t) => {
  fresh(t);
  const dom = new JSDOM('<textarea id="chatInput"></textarea>', { pretendToBeVisual: true });
  const win = dom.window;
  t.after(() => win.close());
  let key = 'a';
  let busy = false;
  let paints = 0;
  const requested = [];
  const feed = contextPreview.bindComposerFeed({
    win, doc: win.document, getSessionId: () => SID, getInputsKey: () => key, isTurnActive: () => busy,
    request: async (sessionId) => { requested.push(sessionId); return { preview: ESTIMATE }; },
    paint: () => { paints += 1; }, delayMs: 0,
  });
  t.after(() => feed.dispose());
  feed.sync();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requested, [SID]);
  await new Promise((resolve) => win.requestAnimationFrame(resolve));
  assert.equal(paints, 1, 'the arriving estimate repaints the ring');
  feed.sync();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requested.length, 1, 'unchanged inputs fetch nothing');
  busy = true; key = 'b'; feed.sync();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requested.length, 1, 'no refresh while a reply runs');
  busy = false; feed.sync();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requested.length, 2, 'the change is picked up once the reply ends');
  win.document.getElementById('chatInput').dispatchEvent(new win.Event('input', { bubbles: true }));
  await new Promise((resolve) => win.requestAnimationFrame(resolve));
  assert.ok(paints >= 2, 'a keystroke repaints the ring');
});

test('shared breakdown: window bar, compaction marker, categories and the room left', () => {
  const host = new JSDOM('<div id="h"></div>').window.document.getElementById('h');
  host.innerHTML = contextPreview.breakdownHtml(contextPreview.project(ESTIMATE));
  const marker = host.querySelector('.session-context-marker');
  assert.ok(marker, 'the auto-compact point is marked on the window bar');
  assert.match(marker.getAttribute('style'), /inset-inline-start:75\.0\d*%/);
  const rows = [...host.querySelectorAll('.session-context-category')].map((row) => row.dataset.rowKey);
  assert.deepEqual(rows, ['messages', 'system_prompt', 'tools', 'instructions', 'skills', 'other', 'free', 'compact_at']);
  assert.match(host.querySelector('[data-row-key="free"]').textContent, /Room before auto-compact9\.1k/);
  host.innerHTML = contextPreview.breakdownHtml(contextPreview.project({ ...ESTIMATE, compact_at_tokens: null }));
  assert.equal(host.querySelector('.session-context-marker'), null);
  assert.match(host.querySelector('[data-row-key="free"]').textContent, /Available17\.3k/);
});

test('the ring popover renders the rail\'s breakdown under the same headline', (t) => {
  fresh(t);
  global.inventory = { chip: inventoryChip, popover: inventoryPopover.popover || inventoryPopover, actionButton: inventoryActionButton.actionButton || inventoryActionButton };
  contextPreview.remember(SID, ESTIMATE);
  contextUsageUtils.updateUsage(SID, { usage: { context_used_tokens: 8800, context_used_source: 'provider', compact_threshold_tokens: 17500, context_window: 32768 } });
  contextUsageUtils.getUsage(SID).updatedAt = 0; // older than the estimate
  const host = new JSDOM('<div id="h"></div>').window.document.getElementById('h');
  host.innerHTML = contextUsageUtils.renderContextUsage(SID, { autoCompactEnabled: true, manualCompactionEnabled: true });
  const popover = host.querySelector('#composerContextDetailsPopover');
  assert.equal(popover.querySelector('.inv-context-details-percent').textContent, '63%');
  assert.match(popover.querySelector('.inv-context-details-title').textContent, /until auto-compact/);
  assert.equal(popover.querySelectorAll('.session-context-category').length, 8);
  assert.match(popover.querySelector('.inv-context-details-note').textContent, /Next send, estimated\. Last reply measured 8\.8k\./);
  assert.ok(popover.querySelector('[data-action="context-meter-compact"]'));
  assert.match(host.querySelector('#composerContextRing').getAttribute('aria-label'), /63%/);
});
