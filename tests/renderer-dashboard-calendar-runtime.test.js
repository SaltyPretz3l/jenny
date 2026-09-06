const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const runtime = require('../renderer/features/renderer-dashboard-calendar-runtime.js');
const grid = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const agenda = require('../renderer/features/renderer-dashboard-calendar-agenda.js');

test('computeRenderKey is stable and invalidates on rail projections', () => {
  const base = {
    weekStartKey: '2026-06-08',
    todayKey: '2026-06-11',
    weekInstances: [['a']],
    monthDigest: null,
    railDigest: [['June']],
    feeds: [],
    categories: [],
    mode: 'agenda',
    uiState: { weekOffset: 0 },
  };
  assert.equal(runtime.computeRenderKey(base), runtime.computeRenderKey({ ...base }));
  assert.notEqual(runtime.computeRenderKey(base), runtime.computeRenderKey({ ...base, railDigest: [['July']] }));
});

test('steady-state helpers update now, relative, and past state in place', () => {
  const dom = new JSDOM('<div id="root"><div class="cal-week__now-line"></div>'
    + '<button data-cal-end="2026-06-11T09:30" class="cal-agenda__item cal-agenda__item--next">'
    + '<span data-cal-rel="1" data-cal-start="2026-06-11T09:00"></span></button>'
    + '<span class="cal-rail__up-next-meta"><span data-cal-rel="1" data-cal-start="2026-06-11T11:00"></span></span>'
    + '</div>');
  const root = dom.window.document.getElementById('root');
  const now = new Date(2026, 5, 11, 10, 30);
  runtime.updateNowLine(root, now, grid);
  runtime.updateAgendaRelative(root, now, { gridModule: grid, agendaModule: agenda });
  assert.equal(root.querySelector('.cal-week__now-line').style.top, '630px');
  assert.equal(root.querySelector('.cal-agenda__item [data-cal-rel]').textContent, 'now');
  assert.equal(root.querySelector('.cal-rail__up-next-meta [data-cal-rel]').textContent, 'in 30m');
  assert.ok(root.querySelector('.cal-agenda__item').classList.contains('cal-agenda__item--past'));
  assert.ok(!root.querySelector('.cal-agenda__item').classList.contains('cal-agenda__item--next'));
});

test('value preservation and deferred focus/live announcement remain bounded', async () => {
  const dom = new JSDOM('<div id="root"><input data-cal-quickadd-input value="typed">'
    + '<button data-focus>Target</button><span data-cal-announce></span></div>');
  const root = dom.window.document.getElementById('root');
  assert.equal(runtime.preserveQuickAdd(root, ''), 'typed');
  runtime.applyDeferredFocusAndAnnounce(root, { focusSelector: '[data-focus]', announce: 'Updated' });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(root.querySelector('[data-cal-announce]').textContent, 'Updated');
  assert.equal(dom.window.document.activeElement, root.querySelector('[data-focus]'));
});
