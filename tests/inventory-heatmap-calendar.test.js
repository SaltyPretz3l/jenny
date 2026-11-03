'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const heatmapCalendar = require('../renderer/inventory/heatmap-calendar');
const tooltip = require('../renderer/inventory/tooltip');

function pad(value) {
  return String(value).padStart(2, '0');
}

function key(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// `count` consecutive local days ending on `end` ('YYYY-MM-DD'), oldest first.
function daysEnding(end, count, valueFor = () => 0) {
  const [year, month, day] = end.split('-').map(Number);
  const cells = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - 1, day - offset);
    cells.push({ date: key(date), value: valueFor(cells.length), tooltip: `tip ${key(date)}` });
  }
  return cells;
}

function parse(svg) {
  const dom = new JSDOM(`<body>${svg}</body>`);
  return dom.window.document;
}

// 2026-11-01 is a Sunday: 371 days ending there start on a Monday (53 full weeks).
const SUNDAY_END = '2026-11-01';

test('371 cells render as 371 rects in a 53-column, Monday-first grid', () => {
  const cells = daysEnding(SUNDAY_END, 371, (index) => index + 1);
  const svg = heatmapCalendar({ cells, today: SUNDAY_END, locale: 'en-US' });
  const doc = parse(svg);
  const rects = doc.querySelectorAll('rect.inv-heatmap-cell');
  assert.equal(rects.length, 371);
  const xs = new Set(Array.from(rects, (rect) => rect.getAttribute('x')));
  assert.equal(xs.size, 53);
  const ys = new Set(Array.from(rects, (rect) => rect.getAttribute('y')));
  assert.equal(ys.size, 7);
  const first = rects[0];
  assert.equal(first.getAttribute('data-date'), '2025-10-27'); // a Monday
  assert.equal(first.getAttribute('y'), '14', 'Monday sits on the top row');
  assert.equal(first.getAttribute('width'), '11');
  assert.equal(first.getAttribute('height'), '11');
  assert.equal(first.getAttribute('rx'), '2');
  assert.equal(rects[1].getAttribute('y'), '28', 'Tuesday is one 14px pitch below (11px cell + 3px gap)');
  assert.equal(rects[7].getAttribute('x'), String(24 + 14), 'the next Monday starts the next column');
  const root = doc.querySelector('svg');
  assert.equal(root.getAttribute('class'), 'inv-heatmap');
  assert.equal(root.getAttribute('role'), 'img');
});

test('levels are quartiles over the non-zero values and the top day is always 4', () => {
  const values = [0, 10, 20, 30, 40, 0, 0];
  const cells = daysEnding('2026-11-01', 7, (index) => values[index]);
  const doc = parse(heatmapCalendar({ cells }));
  const levels = Array.from(doc.querySelectorAll('rect'), (rect) => rect.getAttribute('data-level'));
  assert.deepEqual(levels, ['0', '1', '2', '3', '4', '0', '0']);

  const lone = parse(heatmapCalendar({ cells: daysEnding('2026-11-01', 3, (index) => (index === 1 ? 5 : 0)) }));
  assert.deepEqual(
    Array.from(lone.querySelectorAll('rect'), (rect) => rect.getAttribute('data-level')),
    ['0', '4', '0']
  );

  const level = heatmapCalendar.levelFunction([1, 2, 3, 4, 8, 8, 8, 8]);
  assert.equal(level(0), 0);
  assert.equal(level(-5), 0);
  assert.equal(level(Number.NaN), 0);
  assert.equal(level(8), 4, 'ties share the highest rank');
  assert.equal(level(1), 1);
});

test('empty input draws nothing and all-zero input is all level 0', () => {
  assert.equal(heatmapCalendar({ cells: [] }), '');
  assert.equal(heatmapCalendar({}), '');
  assert.equal(heatmapCalendar({ cells: [{ date: 'nope', value: 3 }] }), '');
  const doc = parse(heatmapCalendar({ cells: daysEnding(SUNDAY_END, 14) }));
  const levels = new Set(Array.from(doc.querySelectorAll('rect'), (rect) => rect.getAttribute('data-level')));
  assert.deepEqual([...levels], ['0']);
});

test('cells outside from..to are out of range and today is marked', () => {
  const cells = daysEnding(SUNDAY_END, 14, () => 1);
  const doc = parse(heatmapCalendar({ cells, from: '2026-10-26', to: SUNDAY_END, today: SUNDAY_END }));
  const rects = Array.from(doc.querySelectorAll('rect'));
  const out = rects.filter((rect) => rect.getAttribute('data-out-of-range') === 'true').map((rect) => rect.getAttribute('data-date'));
  assert.equal(out.length, 7);
  assert.ok(out.every((date) => date < '2026-10-26'));
  assert.equal(rects.filter((rect) => rect.hasAttribute('data-out-of-range')).length, 7, 'in-range cells carry no attribute');
  const today = rects.filter((rect) => rect.getAttribute('data-today') === 'true');
  assert.equal(today.length, 1);
  assert.equal(today[0].getAttribute('data-date'), SUNDAY_END);

  const unmarked = parse(heatmapCalendar({ cells }));
  assert.equal(unmarked.querySelectorAll('[data-out-of-range],[data-today]').length, 0);
});

test('month labels sit above the first Monday of each month, 9px, in the given locale', () => {
  const cells = daysEnding(SUNDAY_END, 371, () => 1);
  const doc = parse(heatmapCalendar({ cells, locale: 'en-US', dayLabels: ['Mon', 'Wed', 'Fri'] }));
  const labels = Array.from(doc.querySelectorAll('text.inv-heatmap-label'));
  assert.ok(labels.every((label) => label.getAttribute('font-size') === '9'));
  const months = labels.filter((label) => label.getAttribute('y') === '9').map((label) => label.textContent);
  assert.deepEqual(months, ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  const novLabel = labels.find((label) => label.textContent === 'Nov');
  const novRect = doc.querySelector('rect[data-date="2025-11-03"]'); // first Monday of November
  assert.equal(novLabel.getAttribute('x'), novRect.getAttribute('x'));
  const side = labels.filter((label) => label.getAttribute('x') === '0');
  assert.deepEqual(side.map((label) => label.textContent), ['Mon', 'Wed', 'Fri']);
  assert.deepEqual(side.map((label) => label.getAttribute('y')), ['23', '51', '79']);
});

test('a first column that starts mid-week leaves the leading rows empty', () => {
  // Wed 2026-10-28 .. Sun 2026-11-01
  const cells = daysEnding('2026-11-01', 5, () => 1);
  const doc = parse(heatmapCalendar({ cells }));
  const rects = Array.from(doc.querySelectorAll('rect'));
  assert.equal(rects.length, 5);
  assert.equal(rects[0].getAttribute('y'), String(14 + 2 * 14), 'Wednesday is row 2');
  assert.equal(rects[4].getAttribute('y'), String(14 + 6 * 14), 'Sunday is row 6');
  assert.equal(new Set(rects.map((rect) => rect.getAttribute('x'))).size, 1);
});

test('maxWeeks keeps the newest columns', () => {
  // 371 days ending on a Wednesday spans 54 columns; maxWeeks 53 drops the oldest partial week.
  const cells = daysEnding('2026-10-28', 371, () => 1);
  const full = parse(heatmapCalendar({ cells }));
  assert.equal(new Set(Array.from(full.querySelectorAll('rect'), (rect) => rect.getAttribute('x'))).size, 54);
  const capped = parse(heatmapCalendar({ cells, maxWeeks: 53 }));
  const rects = Array.from(capped.querySelectorAll('rect'));
  assert.equal(new Set(rects.map((rect) => rect.getAttribute('x'))).size, 53);
  assert.equal(rects[0].getAttribute('y'), '14', 'the first kept cell is a Monday');
  assert.equal(rects[rects.length - 1].getAttribute('data-date'), '2026-10-28', 'the newest day is kept');
});

test('tooltip text rides data-tooltip and the figure has an accessible name', () => {
  const svg = heatmapCalendar({
    cells: [{ date: '2026-10-21', value: 5, tooltip: 'Wed, Oct 21 · 48.2K tokens · "23" <replies>' }],
    ariaLabel: 'Token use per day',
  });
  const doc = parse(svg);
  const rect = doc.querySelector('rect');
  assert.equal(rect.getAttribute('data-tooltip'), 'Wed, Oct 21 · 48.2K tokens · "23" <replies>');
  assert.equal(rect.getAttribute('tabindex'), '-1');
  assert.equal(doc.querySelector('svg').getAttribute('aria-label'), 'Token use per day');
  assert.equal(doc.querySelectorAll('script, [onmouseover]').length, 0);
});

test('legend returns five swatches, levels 0 to 4', () => {
  const doc = parse(heatmapCalendar.legend());
  const swatches = Array.from(doc.querySelectorAll('span.inv-heatmap-swatch'));
  assert.deepEqual(swatches.map((swatch) => swatch.getAttribute('data-level')), ['0', '1', '2', '3', '4']);
});

test('the delegated tooltip shows a heatmap cell on hover (data-tooltip works on SVG elements)', async () => {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  document.body.innerHTML = heatmapCalendar({
    cells: [{ date: '2026-10-21', value: 5, tooltip: 'Wed, Oct 21 · 48.2K tokens · 23 replies' }],
  });
  tooltip.initTooltipHandlers(document);
  const rect = document.querySelector('rect.inv-heatmap-cell');
  rect.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
  await new Promise((resolve) => setTimeout(resolve, 520));
  const shown = document.getElementById('inv-tooltip-singleton');
  assert.ok(shown, 'the shared tooltip element was created');
  assert.equal(shown.textContent, 'Wed, Oct 21 · 48.2K tokens · 23 replies');
  assert.ok(shown.classList.contains('inv-tooltip--visible'));
  tooltip.hide({ force: true });
});
