'use strict';

// Relative-date tokens for the demo clips. A replay script and a typed prompt
// are static text, but a calendar clip has to talk about "this week" on
// whatever day it is re-recorded, so both carry tokens that the recorder
// resolves against the recording clock:
//
//   {{date+N}}     local calendar date N days from now, YYYY-MM-DD
//   {{weekday+N}}  long weekday name for that day (Thursday)
//   {{md+N}}       short month and day for that day (Sep 10)
//
// N may be negative ({{date-1}}). Pure module: no I/O, no globals.

const TOKEN_PATTERN = /\{\{(date|weekday|md)([+-]\d+)?\}\}/g;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function addLocalDays(now, days) {
  const base = new Date(now);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, 12, 0, 0, 0);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// Local calendar date as YYYY-MM-DD (the calendar store's wall-clock format).
function localDateStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function resolveDateTokens(text, now = Date.now()) {
  return String(text || '').replace(TOKEN_PATTERN, (_match, kind, offset) => {
    const day = addLocalDays(now, Number(offset || 0));
    if (kind === 'date') return localDateStamp(day);
    if (kind === 'weekday') return WEEKDAYS[day.getDay()];
    return `${MONTHS[day.getMonth()]} ${day.getDate()}`;
  });
}

function hasDateTokens(text) {
  TOKEN_PATTERN.lastIndex = 0;
  return TOKEN_PATTERN.test(String(text || ''));
}

module.exports = { resolveDateTokens, hasDateTokens, localDateStamp, addLocalDays };
