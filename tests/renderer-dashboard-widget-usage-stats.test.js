'use strict';

// Deterministic copy and number formats whatever the machine locale is.
globalThis.jennyI18n = { tag: () => 'en-US' };

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createUsageStatsWidget } = require('../renderer/features/renderer-dashboard-widget-usage-stats');
const { createDashboardRegistry } = require('../renderer/features/renderer-dashboard-registry');
const segmentedControl = require('../renderer/inventory/segmented-control');
const emptyNote = require('../renderer/inventory/empty-note');
const heatmapCalendar = require('../renderer/inventory/heatmap-calendar');

const TODAY = '2026-11-01'; // a Sunday
const MARKUP = '<main><section id="grid"></section></main>';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) await tick();
}

function key(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function heatmapCells(firstActive = '0000-00-00') {
  const cells = [];
  for (let offset = 370; offset >= 0; offset -= 1) {
    const date = key(new Date(2026, 10, 1 - offset));
    const active = date >= firstActive && offset % 3 === 0;
    cells.push({ date, total_tokens: active ? 1000 * (offset + 1) : 0, turns: active ? 5 : 0 });
  }
  return cells;
}

function range(from, over = {}) {
  return {
    from,
    to: TODAY,
    turns: 156,
    input_tokens: 591000,
    output_tokens: 242000,
    total_tokens: 833000,
    favorite_model: { model: 'qwen3', provider: 'ollama', turns: 84, share: 0.5385 },
    top_models: [
      { model: 'qwen3', provider: 'ollama', turns: 84, total_tokens: 500000, share: 0.5385 },
      { model: 'gpt-x', provider: 'chatgpt', turns: 40, total_tokens: 200000, share: 0.2564 },
      { model: 'llama', provider: 'ollama', turns: 20, total_tokens: 100000, share: 0.1282 },
    ],
    local_share: 0.72,
    active_days: 6,
    busiest_day: { date: '2026-10-29', total_tokens: 489000, turns: 41 },
    peak_hour: 21,
    avg_tokens_per_second: 44.3,
    estimated_share: 0,
    ...over,
  };
}

function statsPayload(over = {}) {
  return {
    available: true,
    since: '2025-10-03',
    ranges: {
      '1d': range(TODAY, { turns: 12, total_tokens: 12300, input_tokens: 9000, output_tokens: 3300 }),
      '7d': range('2026-10-26'),
      '30d': range('2026-10-03', { turns: 400, total_tokens: 2100000, input_tokens: 1500000, output_tokens: 600000 }),
      '6mo': range('2026-05-04', { total_tokens: 9000000 }),
      '1y': range('2025-11-02', { total_tokens: 27300000 }),
      all: range('2025-10-03', { total_tokens: 30000000 }),
    },
    streak: { current: 2, longest: 36 },
    heatmap: heatmapCells(),
    ...over,
  };
}

function emptyPayload() {
  const blank = (from) => range(from, {
    turns: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, favorite_model: null, top_models: [],
    local_share: null, active_days: 0, busiest_day: null, peak_hour: null, avg_tokens_per_second: null, estimated_share: null,
  });
  return {
    available: true,
    since: null,
    ranges: { '1d': blank(TODAY), '7d': blank('2026-10-26'), '30d': blank('2026-10-03'), '6mo': blank('2026-05-04'), '1y': blank('2025-11-02'), all: blank(TODAY) },
    streak: { current: 0, longest: 0 },
    heatmap: heatmapCells('9999-99-99'),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const dom = new JSDOM(MARKUP, { url: 'https://jenny.local/', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  document.documentElement.dataset.activeView = 'chat';
  segmentedControl.initSegmentedHandlers(document);
  const calls = { stats: 0, updateConfig: [], homeConfig: [], logs: [] };
  const getStats = options.getStats || (() => Promise.resolve(statsPayload()));
  const shell = {
    usage: { getStats: () => { calls.stats += 1; return getStats(calls.stats); } },
    home: {
      updateConfig: (patch) => {
        calls.updateConfig.push(patch);
        return Promise.resolve({ echoed: patch });
      },
    },
  };
  const widget = createUsageStatsWidget({
    shell,
    documentRef: document,
    segmentedControl,
    emptyNote,
    heatmapCalendar,
    appendClientLog: (level, event, data) => calls.logs.push({ level, event, data }),
    onHomeConfig: (payload) => calls.homeConfig.push(payload),
  });
  const grid = document.getElementById('grid');
  const state = { ui: { activeView: 'home' }, homeConfig: options.homeConfig || { usageStats: { range: '7d' } } };
  const ctx = { state, documentRef: document, slotHosts: {} };
  const registry = createDashboardRegistry({ documentRef: document });
  assert.equal(registry.register(widget), true);
  const paint = () => registry.renderInto(grid, ctx);
  const card = () => grid.querySelector('[data-widget-id="usage-stats"]');
  const activate = () => {
    document.documentElement.dataset.activeView = 'chat';
    document.documentElement.dataset.activeView = 'home';
  };
  return { window, document, widget, registry, grid, card, state, ctx, calls, paint, activate };
}

const text = (node) => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

test('renders the header, a six-option range control, the headline, six stats and the heatmap', async () => {
  const h = harness();
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');

  assert.equal(h.calls.stats, 1);
  assert.equal(h.card().querySelectorAll(':scope > .dashboard-card__header').length, 0, 'the registry draws no header');
  const header = body.querySelector(':scope > .dashboard-card__header');
  assert.ok(header, 'the widget draws its own header inside the body');
  assert.equal(text(header.querySelector('.dashboard-card__title')), 'Usage');
  assert.equal(text(header.querySelector('.us-span')), 'Oct 26 – Nov 1');

  const group = header.querySelector('.us-head-tail .inv-segmented.inv-segmented--compact.us-range');
  assert.ok(group);
  assert.equal(group.getAttribute('aria-label'), 'Usage range');
  const options = Array.from(group.querySelectorAll('.inv-segmented-option'));
  assert.deepEqual(options.map((option) => option.dataset.value), ['1d', '7d', '30d', '6mo', '1y', 'all']);
  assert.deepEqual(options.map((option) => text(option)), ['1d', '7d', '30d', '6mo', '1yr', 'All']);
  assert.deepEqual(options.filter((option) => option.getAttribute('aria-checked') === 'true').map((option) => option.dataset.value), ['7d']);

  assert.equal(text(body.querySelector('.us-big')), '833Ktokens');
  assert.equal(text(body.querySelector('.us-big small')), 'tokens');
  assert.equal(text(body.querySelector('.us-split')), '156 replies · 591K in · 242K out');
  assert.equal(body.querySelector('.us-big').dataset.tooltip, "591K in (your messages, files and tool results) · 242K out (Jenny's replies)");

  const stats = Array.from(body.querySelectorAll('dl.us-stats > .us-stat'));
  assert.deepEqual(stats.map((stat) => text(stat.querySelector('dt'))), ['Favorite model', 'Streak', 'Local', 'Busiest day', 'Peak hour', 'Speed']);
  const values = stats.map((stat) => stat.querySelector('dd').innerHTML);
  assert.deepEqual(values, ['qwen3<span>54%</span>', '2 days<span>best 36</span>', '72%', 'Oct 29<span>489K</span>', '9 pm', '44 tok/s']);
  assert.equal(stats[0].dataset.tooltip, 'qwen3 on ollama. Replies: 84 of 156. Next: gpt-x 26%, llama 13%');
  assert.equal(stats[1].dataset.tooltip, 'Days in a row with at least one reply. Active days in this range: 6 of 7');
  assert.equal(stats[2].dataset.tooltip, 'Replies from models on this PC');
  assert.equal(stats[3].dataset.tooltip, 'Thu, Oct 29: 41 replies');
  assert.equal(stats[4].dataset.tooltip, 'When you use Jenny most in this range');
  assert.equal(stats[5].dataset.tooltip, 'Average generation speed across replies');

  const heat = body.querySelector('.us-heat');
  assert.equal(heat.querySelectorAll('svg.inv-heatmap rect.inv-heatmap-cell').length, 371);
  assert.equal(heat.querySelectorAll('.inv-heatmap-cell[data-today="true"]').length, 1);
  assert.equal(heat.querySelectorAll('.inv-heatmap-cell[data-out-of-range="true"]').length, 371 - 7);
  assert.equal(heat.querySelectorAll('.us-heat-foot .inv-heatmap-swatch').length, 5);
  assert.equal(text(heat.querySelector('.us-heat-foot > span:first-child')), '27.3M tokens in the last year');
  assert.match(text(heat.querySelector('.us-legend')), /^Less\s*More$/);
  const quietCell = heat.querySelector('.inv-heatmap-cell[data-date="2026-10-31"]');
  assert.equal(quietCell.dataset.tooltip, 'Sat, Oct 31 · no replies');
  const activeCell = heat.querySelector('.inv-heatmap-cell[data-date="2026-10-29"]');
  assert.equal(activeCell.dataset.tooltip, 'Thu, Oct 29 · 4K tokens · 5 replies');
});

test('a range click re-renders from the cache with one IPC read and persists the pick', async () => {
  const h = harness();
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');
  assert.equal(h.calls.stats, 1);

  body.querySelector('.inv-segmented-option[data-value="30d"]').click();
  assert.equal(text(body.querySelector('.us-span')), 'Oct 3 – Nov 1');
  assert.equal(text(body.querySelector('.us-big')), '2.1Mtokens');
  assert.equal(text(body.querySelector('.us-split')), '400 replies · 1.5M in · 600K out');
  assert.equal(body.querySelector('.inv-segmented-option[data-value="30d"]').getAttribute('aria-checked'), 'true');
  assert.equal(h.calls.stats, 1, 'switching range never calls the bridge again');
  assert.deepEqual(h.calls.updateConfig, [{ usageStats: { range: '30d' } }]);
  await flush();
  assert.deepEqual(h.calls.homeConfig, [{ echoed: { usageStats: { range: '30d' } } }]);

  body.querySelector('.inv-segmented-option[data-value="1d"]').click();
  assert.equal(text(body.querySelector('.us-span')), 'Today');
  assert.equal(text(body.querySelector('.us-big')), '12.3Ktokens');
  body.querySelector('.inv-segmented-option[data-value="1y"]').click();
  assert.equal(text(body.querySelector('.us-span')), 'Nov 2, 2025 – Nov 1', 'a year shows when the range crosses one');
  body.querySelector('.inv-segmented-option[data-value="all"]').click();
  assert.equal(text(body.querySelector('.us-span')), 'Since Oct 3, 2025');
  assert.equal(h.calls.stats, 1);
  assert.deepEqual(h.calls.updateConfig.map((patch) => patch.usageStats.range), ['30d', '1d', '1y', 'all']);

  // A repaint with unchanged data keeps the DOM and makes no read.
  const marker = body.querySelector('.us-big');
  h.paint();
  assert.equal(body.querySelector('.us-big'), marker);
  assert.equal(h.calls.stats, 1);
});

test('a touched range sticks; an untouched one follows the persisted config; junk falls back to 7d', async () => {
  const h = harness({ homeConfig: { usageStats: { range: '30d' } } });
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');
  assert.equal(body.querySelector('.inv-segmented-option--on').dataset.value, '30d');
  h.state.homeConfig = { usageStats: { range: '6mo' } };
  h.paint();
  assert.equal(body.querySelector('.inv-segmented-option--on').dataset.value, '6mo');

  const junk = harness({ homeConfig: { usageStats: { range: 'forever' } } });
  junk.paint();
  await flush();
  assert.equal(junk.card().querySelector('.inv-segmented-option--on').dataset.value, '7d');
  const bare = harness({ homeConfig: {} });
  bare.paint();
  await flush();
  assert.equal(bare.card().querySelector('.inv-segmented-option--on').dataset.value, '7d');
});

test('empty state: no range control, one empty note', async () => {
  const h = harness({ getStats: () => Promise.resolve(emptyPayload()) });
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');
  assert.equal(text(body.querySelector('.dashboard-card__title')), 'Usage');
  assert.equal(body.querySelector('.inv-segmented'), null);
  assert.equal(body.querySelector('.us-span'), null);
  assert.equal(body.querySelector('.us-stats'), null);
  assert.equal(body.querySelector('svg'), null);
  const notes = body.querySelectorAll('.inv-empty-note');
  assert.equal(notes.length, 1);
  assert.equal(text(notes[0]), 'No usage yet. Your token stats and a year heatmap fill in after your first reply.');
});

test('read error: a one-line danger-toned body, retried on the next activation', async () => {
  let fail = true;
  const h = harness({ getStats: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(statsPayload())) });
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');
  assert.equal(text(body.querySelector('.dashboard-card__title')), 'Usage');
  assert.equal(body.querySelector('.inv-segmented'), null);
  assert.equal(text(body.querySelector('.us-error')), 'Usage stats could not be loaded.');
  assert.equal(h.calls.logs.filter((entry) => entry.event === 'home.usage_stats_read_failed').length, 1);
  assert.equal(h.calls.stats, 1);

  fail = false;
  h.activate();
  await flush();
  assert.equal(h.calls.stats, 2);
  assert.equal(body.querySelector('.us-error'), null);
  assert.ok(body.querySelector('.us-big'));
});

test('available:false from main shows the same error body', async () => {
  const h = harness({ getStats: () => Promise.resolve({ ...emptyPayload(), available: false, error: 'usage_stats_unavailable' }) });
  h.paint();
  await flush();
  assert.equal(text(h.card().querySelector('.us-error')), 'Usage stats could not be loaded.');
  assert.equal(h.card().querySelector('.us-big'), null);
});

test('at most one read is in flight; each Home activation after it settles reads again', async () => {
  const pending = [];
  const h = harness({ getStats: () => { const next = deferred(); pending.push(next); return next.promise; } });
  h.paint();
  h.paint();
  h.activate();
  h.activate();
  await flush();
  assert.equal(h.calls.stats, 1, 'repaints and activations during one pending read share it');
  assert.equal(h.card().querySelector('.us-big'), null, 'nothing to show before the first read lands');

  pending[0].resolve(statsPayload());
  await flush();
  assert.ok(h.card().querySelector('.us-big'));
  assert.equal(h.calls.stats, 1);

  h.paint(); // a plain repaint (clock tick, config echo) never reads
  assert.equal(h.calls.stats, 1);

  h.activate();
  await flush();
  assert.equal(h.calls.stats, 2, 'a new activation reads once');
  assert.ok(h.card().querySelector('.us-big'), 'the cached numbers stay on screen while it reads');
  pending[1].resolve(statsPayload({ streak: { current: 5, longest: 36 } }));
  await flush();
  assert.match(text(h.card().querySelectorAll('.us-stat dd')[1]), /^5 days/);
});

test('just-upgraded: the heatmap foot says when counting began', async () => {
  const payload = statsPayload({
    since: '2026-10-15',
    heatmap: heatmapCells('2026-10-15'),
  });
  payload.ranges.all = range('2026-10-15', { total_tokens: 700000 });
  const h = harness({ getStats: () => Promise.resolve(payload) });
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');
  assert.equal(text(body.querySelector('.us-heat-foot > span:first-child')), 'Counting since Oct 15 (Jenny kept 30 days before this update)');
  body.querySelector('.inv-segmented-option[data-value="all"]').click();
  assert.equal(text(body.querySelector('.us-span')), 'Since Oct 15');

  // Older history on the map means no upgrade note.
  const older = harness({ getStats: () => Promise.resolve(statsPayload({ since: '2026-10-15' })) });
  older.paint();
  await flush();
  assert.equal(text(older.card().querySelector('.us-heat-foot > span:first-child')), '27.3M tokens in the last year');
});

test('a range with no replies shows dashes, not zeros', async () => {
  const payload = statsPayload();
  payload.ranges['1d'] = range(TODAY, {
    turns: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, favorite_model: null, top_models: [],
    local_share: null, active_days: 0, busiest_day: null, peak_hour: null, avg_tokens_per_second: null, estimated_share: null,
  });
  const h = harness({ getStats: () => Promise.resolve(payload) });
  h.paint();
  await flush();
  const body = h.card().querySelector('.dashboard-card__body');
  body.querySelector('.inv-segmented-option[data-value="1d"]').click();
  assert.equal(text(body.querySelector('.us-big')), '0tokens');
  const values = Array.from(body.querySelectorAll('.us-stat dd')).map((node) => node.innerHTML);
  assert.deepEqual(values, ['—', '2 days<span>best 36</span>', '—', '—', '—', '—']);
  assert.ok(body.querySelector('.us-heat svg'), 'the year heatmap stays');
});

test('headerless: the registry draws no header but keeps the title for the hidden strip', () => {
  const h = harness();
  assert.equal(h.widget.headerless, true);
  assert.equal(h.widget.id, 'usage-stats');
  assert.deepEqual(h.registry.list().map((entry) => [entry.id, entry.title]), [['usage-stats', 'Usage']]);
  h.paint();
  assert.equal(h.card().querySelectorAll(':scope > .dashboard-card__header').length, 0);
});

test('a missing bridge reads as an error, never a throw', async () => {
  const dom = new JSDOM(MARKUP, { url: 'https://jenny.local/' });
  const widget = createUsageStatsWidget({
    shell: {}, documentRef: dom.window.document, segmentedControl, emptyNote, heatmapCalendar,
  });
  const body = dom.window.document.createElement('div');
  widget.render(body, { state: { ui: { activeView: 'home' }, homeConfig: {} }, documentRef: dom.window.document });
  await flush();
  assert.ok(body.querySelector('.us-error'));
});

test('a failed refresh keeps the last good stats on screen', async () => {
  const h = harness({
    getStats: (n) => (n === 1 ? Promise.resolve(statsPayload()) : Promise.reject(new Error('boom'))),
  });
  h.paint();
  await flush();
  assert.ok(h.card().querySelector('.us-big'), 'first read renders stats');
  h.activate();
  await flush();
  assert.equal(h.calls.stats, 2);
  assert.ok(h.card().querySelector('.us-big'), 'stats survive the failed refresh');
  assert.equal(h.card().querySelector('.us-error'), null);
  assert.ok(h.calls.logs.some((entry) => entry.event === 'home.usage_stats_read_failed'));
});

test('a refresh with identical data leaves the painted card untouched', async () => {
  const h = harness();
  h.paint();
  await flush();
  const before = h.card().querySelector('.us-body');
  h.activate();
  await flush();
  assert.equal(h.calls.stats, 2);
  assert.equal(h.card().querySelector('.us-body'), before, 'same DOM node: no innerHTML rebuild');
});
