const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolbar = require('../renderer/features/renderer-dashboard-calendar-toolbar.js');
const grid = require('../renderer/features/renderer-dashboard-calendar-grid.js');
const month = require('../renderer/features/renderer-dashboard-calendar-month.js');
const actionButton = require('../renderer/inventory/action-button.js');
const popover = require('../renderer/inventory/popover.js');

test('calendar header owns the range and exposes an accessible overflow dialog', () => {
  const root = JSDOM.fragment(toolbar.buildToolbarMarkup({
    weekStart: new Date(2026, 5, 8), now: new Date(2026, 5, 11), mode: 'agenda',
    feeds: [{ id: 'team', name: 'Team', warning: 'offline', ok: false }],
    actionButton, popover, gridModule: grid, monthModule: month,
  }));
  assert.equal(root.querySelectorAll('.cal-toolbar__range').length, 1);
  assert.match(root.querySelector('.cal-toolbar__heading').textContent, /Calendar.*Jun 8.*14/s);
  assert.equal(root.querySelector('[data-cal-view="agenda"]').getAttribute('aria-pressed'), 'true');
  const trigger = root.querySelector('[data-cal-overflow-toggle]');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-controls'), 'calToolbarOverflow');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  const dialog = root.querySelector('#calToolbarOverflow');
  assert.ok(dialog.hidden);
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.match(dialog.querySelector('[data-cal-feeds-toggle]').getAttribute('aria-label'), /1 warning/);
});
