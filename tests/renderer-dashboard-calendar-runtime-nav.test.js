const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../renderer/features/renderer-dashboard-calendar-runtime.js');
const gridModule = require('../renderer/features/renderer-dashboard-calendar-grid.js');

const NOW = new Date(2026, 5, 11, 10, 30);

function eventFor(selector, dataset) {
  const trigger = { dataset };
  return { target: { closest: (candidate) => candidate === selector ? trigger : null } };
}

function handle(event, { weekOffset = 0, mode = 'week', body = null, monthModule = null } = {}) {
  return runtime.handleWeekNavClick(event, {
    body,
    ctx: { state: {} },
    weekOffset,
    gridModule,
    monthModule,
    currentViewMode: () => mode,
    nowProvider: () => NOW,
  });
}

test('rail navigation targets the first week of the adjacent month', () => {
  const next = handle(eventFor('[data-cal-rail-nav]', { calRailNav: 'next' }));
  assert.deepEqual(next, {
    handled: true,
    weekOffset: 3,
    pendingFocusSelector: '[data-cal-rail-nav="next"]',
    pendingAnnounce: new Date(2026, 6, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    preserveQuickAdd: true,
  });

  const previous = handle(eventFor('[data-cal-rail-nav]', { calRailNav: 'prev' }));
  assert.deepEqual(previous, {
    handled: true,
    weekOffset: -6,
    pendingFocusSelector: '[data-cal-rail-nav="prev"]',
    pendingAnnounce: new Date(2026, 4, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    preserveQuickAdd: true,
  });
});

test('week navigation returns the next, previous, and today projections', () => {
  const cases = [
    ['next', 1],
    ['prev', -1],
    ['today', 0],
  ];
  for (const [direction, expectedOffset] of cases) {
    const result = handle(eventFor('[data-cal-nav]', { calNav: direction }));
    assert.deepEqual(result, {
      handled: true,
      weekOffset: expectedOffset,
      pendingFocusSelector: '',
      pendingAnnounce: `Week of ${gridModule.formatWeekRangeLabel(
        gridModule.computeWeekStart(NOW, expectedOffset)
      )}`,
      preserveQuickAdd: false,
    });
  }
});

test('month navigation scrolls in place without returning state changes', () => {
  const scrollEl = {};
  const calls = [];
  const body = { querySelector: (selector) => selector === '[data-cal-scroll]' ? scrollEl : null };
  const monthModule = { navScroll: (...args) => calls.push(args) };

  const result = handle(eventFor('[data-cal-nav]', { calNav: 'next' }), {
    mode: 'month', body, monthModule,
  });

  assert.deepEqual(result, { handled: true, scrolled: true });
  assert.deepEqual(calls, [[scrollEl, 'next']]);
});

test('unrelated clicks are not handled', () => {
  assert.equal(handle(eventFor('[data-other]', {})), null);
});
