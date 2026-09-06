const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'styles/views-home-calendar.css',
  'styles/views-home-calendar-agenda.css',
  'styles/views-home-calendar-week.css',
  'styles/views-home-calendar-month.css',
  'styles/views-home-calendar-form.css',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('calendar styles contain no accent side bars, raw colors, or literal motion durations', () => {
  const css = FILES.map(read).join('\n');
  assert.doesNotMatch(css, /border-left:\s*3px/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /rgba?\(/i);
  assert.doesNotMatch(css, /\b\d+(?:\.\d+)?ms\b/);
});

test('calendar shell, agenda, week, and month retain their load-bearing contracts', () => {
  const base = read(FILES[0]);
  const agenda = read(FILES[1]);
  const week = read(FILES[2]);
  const month = read(FILES[3]);
  assert.match(base, /\.dashboard-card\[data-widget-id="calendar"\] \.dashboard-card__header\s*\{[\s\S]*?display:\s*none/);
  assert.match(base, /@container \(max-width: 720px\)/);
  assert.match(agenda, /\.cal-agenda__list::before/);
  assert.match(agenda, /left:\s*64px/);
  assert.match(week, /grid-template-columns:\s*44px repeat\(7/);
  assert.match(week, /height:\s*1440px/);
  assert.match(week, /\.cal-week__allday-cell\s*\{[\s\S]*?position:\s*relative/);
  assert.match(week, /\.cal-week__allday-pop/);
  assert.match(month, /\.cal-month__event-dot/);
  assert.doesNotMatch(month, /\.cal-month__scroll\s*\{[^}]*border-radius/);
});

test('the Daybook week strip and reminder rows are styled from palette tokens only', () => {
  const agenda = read(FILES[1]);
  const month = read(FILES[3]);
  const week = read(FILES[2]);
  // Week strip lives in the agenda card's stylesheet, next to what it leads.
  assert.match(agenda, /\.cal-week-strip\s*\{[\s\S]*?grid-template-columns:\s*repeat\(7/);
  assert.match(agenda, /\.cal-week-strip__day--today/);
  assert.match(agenda, /\.cal-week-strip__dot\s*\{[\s\S]*?background:\s*var\(--cal-event-hue/);
  // Reminder rows read as their own kind: a violet-family palette accent, not
  // a category hue and not a hard-coded color.
  assert.match(agenda, /\.cal-agenda__item--reminder\s*\{[\s\S]*?--cal-event-hue:\s*var\(--accent-strong\)/);
  assert.match(agenda, /\.cal-agenda__standing/);
  // Weekend styling is CLASS-driven on both grids, so the Sunday-first column
  // order is decided in JS and the CSS follows for free (no nth-child anchors).
  assert.doesNotMatch(month, /nth-child/);
  assert.doesNotMatch(week, /nth-child/);
  assert.match(month, /\.cal-month__weekday--weekend/);
  assert.match(month, /\.cal-month__cell--weekend/);
});
