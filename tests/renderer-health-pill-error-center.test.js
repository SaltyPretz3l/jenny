/**
 * EH-W11 gate: health-pill error-center integration — badge, Recent
 * errors popover section, markSeen-on-open, Clear via a real delegated
 * click, empty-state omission, Open Logs nav intact.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createHealthPillController,
} = require('../renderer/shell/renderer-health-pill-utils');
const {
  buildPillMarkup,
  buildRecentErrorsSection,
  formatRelativeTime,
} = require('../renderer/shell/renderer-health-pill-markup-utils');
const {
  deriveRuntimeHealthState,
} = require('../renderer/shell/renderer-runtime-health-utils');
const { createErrorCenterStore } = require('../renderer/shell/renderer-error-center-store');

function makeSnapshot() {
  return {
    runtime: {
      lifecycle: { available: true, state: 'ready', phase: 'ready' },
      provider_capability_profiles: [],
      recent_tool_observations: [],
    },
  };
}

function createPillHarness(t, { store } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => makeSnapshot() },
  };
  const navigations = [];
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot: window.document.getElementById('slot'),
    deriveRuntimeHealthState,
    errorCenterStore: store,
    setActiveView: (view) => navigations.push(view),
  });
  t.after(() => controller.dispose());
  return { window, controller, navigations, slot: window.document.getElementById('slot') };
}

test('pill markup shows a danger count badge only when unseen errors exist', () => {
  const tone = { tone: 'muted', label: 'Healthy', summary: '' };
  assert.doesNotMatch(buildPillMarkup(tone), /workbench-health-pill-error-badge/);
  assert.doesNotMatch(buildPillMarkup(tone, { unseenErrorCount: 0 }), /workbench-health-pill-error-badge/);
  const badged = buildPillMarkup(tone, { unseenErrorCount: 3 });
  assert.match(badged, /workbench-health-pill-error-badge/);
  assert.match(badged, /aria-label="3 recent errors"/);
  assert.match(buildPillMarkup(tone, { unseenErrorCount: 12 }), />9\+</);
});

test('recent-errors section renders at most five entries with code badge + relative time, empty omitted', () => {
  assert.equal(buildRecentErrorsSection(null), '');
  assert.equal(buildRecentErrorsSection({ recentErrors: [] }), '');
  const nowMs = 10 * 60 * 1000;
  const entries = Array.from({ length: 7 }, (_, index) => ({
    code: `CMP-AI-000${index}`,
    title: `failure ${index}`,
    severity: 'danger',
    at: nowMs - 2 * 60 * 1000,
  }));
  const html = buildRecentErrorsSection({ recentErrors: entries, nowMs });
  assert.equal((html.match(/workbench-health-popover-row"/g) || []).length, 5, 'capped at five rows');
  assert.match(html, /Recent errors/);
  assert.match(html, /CMP-AI-0000/);
  assert.match(html, /2m ago/);
  assert.doesNotMatch(html, /data-health-pill-action="clear-errors"/, 'Clear belongs in the popover action row');
  assert.doesNotMatch(html, /<button/, 'the errors section contains no controls');
});

test('formatRelativeTime buckets', () => {
  const now = 100 * 60 * 60 * 1000;
  assert.equal(formatRelativeTime(now - 5 * 1000, now), 'just now');
  assert.equal(formatRelativeTime(now - 3 * 60 * 1000, now), '3m ago');
  assert.equal(formatRelativeTime(now - 5 * 60 * 60 * 1000, now), '5h ago');
  assert.equal(formatRelativeTime(now - 49 * 60 * 60 * 1000, now), '2d ago');
});

test('pill badge appears on record, clears via markSeen on popover open', async (t) => {
  const store = createErrorCenterStore({ now: () => 1 });
  const { window, slot } = createPillHarness(t, { store });

  assert.equal(slot.querySelectorAll('.workbench-health-pill-error-badge').length, 0);
  store.record({ code: 'CMP-AI-0005', title: 'Provider issue', severity: 'danger' });
  assert.equal(slot.querySelectorAll('.workbench-health-pill-error-badge').length, 1, 'subscription re-renders the pill');

  /* Real click opens the popover -> markSeen -> badge gone. */
  slot.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(store.getUnseenCount(), 0, 'open acknowledges the badge');
  assert.equal(slot.querySelectorAll('.workbench-health-pill-error-badge').length, 0);
  /* Let the open-triggered snapshot refresh land before reading content
   * (refreshPopoverContent replaces the node, so re-query it). */
  await new Promise((resolve) => setImmediate(resolve));
  const popover = window.document.getElementById('workbenchHealthPopover');
  assert.ok(popover, 'popover mounted');
  assert.match(popover.innerHTML, /Recent errors/);
  assert.match(popover.innerHTML, /CMP-AI-0005/);
});

test('Clear real-click empties the section and Open Logs nav stays intact', async (t) => {
  const store = createErrorCenterStore({ now: () => 1 });
  const { window, controller, navigations, slot } = createPillHarness(t, { store });
  store.record({ code: 'CMP-AI-0005', title: 'Provider issue', severity: 'danger' });
  await controller.refresh({ silent: true });
  slot.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  let popover = window.document.getElementById('workbenchHealthPopover');
  const clearButton = popover.querySelector('[data-health-pill-action="clear-errors"]');
  assert.ok(clearButton, 'Clear errors button present');
  assert.equal(clearButton.textContent.trim(), 'Clear errors');
  assert.ok(clearButton.closest('.workbench-health-popover-actions'), 'Clear errors belongs to the action row');

  clearButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(store.list(), [], 'store cleared');
  popover = window.document.getElementById('workbenchHealthPopover');
  assert.ok(popover, 'popover stays open after clear');
  assert.doesNotMatch(popover.innerHTML, /Recent errors/, 'empty section omitted on re-render');

  const logsButton = popover.querySelector('[data-health-pill-action="open-logs"]');
  assert.ok(logsButton, 'Logs action intact');
  logsButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(navigations, ['logs']);
});

test('absent store: pill renders exactly as before', (t) => {
  const { slot, window } = createPillHarness(t, {});
  assert.ok(slot.querySelector('button.workbench-health-pill'));
  assert.equal(slot.querySelectorAll('.workbench-health-pill-error-badge').length, 0);
  slot.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const popover = window.document.getElementById('workbenchHealthPopover');
  assert.ok(popover);
  assert.doesNotMatch(popover.innerHTML, /Recent errors/);
});

test('render-time recorder: timeline card + failed-send chip feed the center when flag-on', (t) => {
  const store = createErrorCenterStore({ now: () => 1 });
  const recorded = [];
  globalThis.rendererErrorCenterRecord = (entry) => {
    recorded.push(entry);
    return store.record(entry);
  };
  t.after(() => { globalThis.rendererErrorCenterRecord = null; });

  const recoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');
  recoveryUtils.renderTimelineErrorCard({
    id: 'msg-9',
    stream_error: 'generation failed',
    error_code: 'CMP-AI-0005',
    status: 'runtime_error',
  });
  recoveryUtils.renderTimelineErrorCard({
    id: 'msg-9',
    stream_error: 'generation failed',
    error_code: 'CMP-AI-0005',
    status: 'runtime_error',
  });
  assert.equal(store.list().length, 1, 'message-id key dedupes re-renders');
  assert.equal(store.list()[0].code, 'CMP-AI-0005');
  assert.equal(store.list()[0].surface, 'timeline');

  /* Calm (cancelled) cards map to info and never reach the store. */
  recoveryUtils.renderTimelineErrorCard({ id: 'msg-10', status: 'cancelled' });
  assert.equal(store.list().length, 1);

  const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
  const escapeHtml = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const renderUtils = createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderStreamingMarkdownUnits: (text) => ({ html: `<p>${escapeHtml(text)}</p>`, units: [], changedStartIndex: 0 }),
    renderThinkingWidget: () => '',
    renderToolCallBlock: () => '',
    renderAgentStatusWidget: () => '',
    renderAssistantFailureNotice: () => '',
    renderContextCompactedNotice: () => '',
  });
  renderUtils.buildTurnRowListMarkup(
    [{ row_id: 'row:user', turn_id: 'turn_1', kind: 'user_bubble', primary_message_id: 'msg-11', payload: { content: 'hello' } }],
    [{ id: 'msg-11', role: 'user', content: 'hello', send_failure: { state: 'failed' } }]
  );
  const sendEntry = store.list().find((entry) => entry.key === 'send-failure:msg-11');
  assert.ok(sendEntry, 'failed-send chip recorded');
  assert.equal(sendEntry.severity, 'warning');
});
