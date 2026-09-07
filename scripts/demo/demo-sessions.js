'use strict';

// Seeded history for the demo profile: the chat sessions that fill the
// history sidebar and the calendar events that give the Home agenda a week
// to summarize. Pure data + builders (no I/O); demo-profile.js writes the
// sessions through the app's own session store so the on-disk layout is
// whatever the current schema says, and the calendar through its store file.
//
// Ages are relative to the recording clock so the sidebar groups them under
// Today / Yesterday / Previous 7 days on any recording date.

const { localDateStamp, addLocalDays } = require('./demo-dates');

const DEMO_MODEL = 'ornith15:9b';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Newest first. Each session is one settled exchange so its preview reads
// like a real reply; `ageMs` is how long ago the last message landed.
const SEEDED_SESSIONS = Object.freeze([
  {
    title: 'Reconcile the Q3 expense export',
    ageMs: 2 * HOUR_MS + 13 * MINUTE_MS,
    pinned: true,
    turns: [
      ['The Q3 export has 14 rows that do not match the ledger. Can you find the pattern?',
        'All 14 are refunds: the export records them as positive amounts with a "credit" tag while the ledger stores them negative. Flip the sign on tagged credits during import and the totals agree to the cent.'],
    ],
  },
  {
    title: 'Why is the ledger total off by 12 cents?',
    ageMs: DAY_MS + 3 * HOUR_MS,
    turns: [
      ['The report total is 12 cents higher than the sum of the entries. Where does that come from?',
        'Rounding. Three entries carry three decimal places and get rounded up individually before the sum. Store cents as integers at parse time and the drift disappears.'],
    ],
  },
  {
    title: 'Regex for CSV fields with quoted commas',
    ageMs: DAY_MS + 7 * HOUR_MS,
    turns: [
      ['I need a regex that splits CSV lines but keeps commas inside double quotes together.',
        'Use a field-at-a-time pattern instead of splitting: `/("([^"]|"")*"|[^,]*)(,|$)/g`. Each match is one field, quoted or bare, and doubled quotes inside a field stay intact.'],
    ],
  },
  {
    title: 'Turn the budget spreadsheet into Markdown',
    ageMs: 3 * DAY_MS + 5 * HOUR_MS,
    turns: [
      ['Convert the department budget table to a Markdown table I can paste into the wiki.',
        'Here is the table with the totals row in bold and the variance column right-aligned. I kept the account codes as plain text so the wiki does not turn them into links.'],
    ],
  },
  {
    title: 'Explain the Node event loop, briefly',
    ageMs: 4 * DAY_MS + 2 * HOUR_MS,
    turns: [
      ['Give me the two-minute version of how the Node event loop works.',
        'One thread runs your JavaScript. Anything slow (files, network, timers) is handed off, and when it finishes its callback joins a queue. The loop drains that queue between runs of your code, which is why a long synchronous loop freezes everything else.'],
    ],
  },
  {
    title: 'Plan the Saturday hike',
    ageMs: 6 * DAY_MS + 4 * HOUR_MS,
    turns: [
      ['Seven miles, moderate climb, leaving at 8. What should go in the pack?',
        'Two litres of water, a layer for the ridge, sunscreen, a small first-aid kit, and lunch. Start early enough to be off the exposed section before the afternoon heat.'],
    ],
  },
  {
    title: 'Draft the sprint retro notes',
    ageMs: 9 * DAY_MS + HOUR_MS,
    turns: [
      ['Turn these bullet points into retro notes: parser rewrite shipped, flaky CI on Windows, onboarding doc out of date.',
        'Drafted under Went well, Needs work, and Actions. The CI flake gets an owner and a date; the onboarding doc is filed as a follow-up so it does not get lost again.'],
    ],
  },
  {
    title: 'Set up a weekly backup script',
    ageMs: 16 * DAY_MS + 6 * HOUR_MS,
    turns: [
      ['Write a PowerShell script that zips the ledger folder every Sunday night and keeps the last eight copies.',
        'The script zips the folder with a date stamp, prunes anything older than the newest eight archives, and registers itself as a scheduled task for Sunday 23:00. It logs each run to backup.log next to the archives.'],
    ],
  },
]);

// Calendar events for the week around the recording, as local wall-clock
// times (the calendar store's format). `day` is an offset from today.
const SEEDED_CALENDAR_EVENTS = Object.freeze([
  { day: 0, start: '10:00', end: '10:20', title: 'Cash-flow standup', category: 'meeting' },
  { day: 1, start: '13:30', end: '14:30', title: 'Vendor invoice review', category: 'work' },
  { day: 2, start: '09:00', end: '09:45', title: 'Dentist', category: 'personal' },
  { day: 4, allDay: true, title: 'Month-end close prep', category: 'focus' },
]);

// Session records in the shape ElectronSessionStore.createSession +
// appendMessage accept, with explicit timestamps so the sidebar groups them.
function buildSeededSessions(now = Date.now()) {
  return SEEDED_SESSIONS.map((entry, index) => {
    const lastAt = now - entry.ageMs;
    const messages = [];
    entry.turns.forEach(([userText, assistantText], turnIndex) => {
      const userAt = lastAt - (entry.turns.length - turnIndex) * 90_000;
      messages.push({ role: 'user', content: userText, timestamp: new Date(userAt).toISOString() });
      messages.push({
        role: 'assistant',
        content: assistantText,
        timestamp: new Date(userAt + 45_000).toISOString(),
        model_used: DEMO_MODEL,
      });
    });
    return {
      key: `seed-${index + 1}`,
      title: entry.title,
      pinned: entry.pinned === true,
      createdAt: new Date(messages[0] ? Date.parse(messages[0].timestamp) - 5_000 : lastAt).toISOString(),
      updatedAt: new Date(lastAt).toISOString(),
      messages,
    };
  });
}

function buildSeededCalendarEvents(now = Date.now()) {
  const stampedAt = new Date(now - 3 * DAY_MS).toISOString();
  return SEEDED_CALENDAR_EVENTS.map((entry, index) => {
    const date = localDateStamp(addLocalDays(now, entry.day));
    const allDay = entry.allDay === true;
    return {
      id: `evt_demo_${index + 1}`,
      title: entry.title,
      start: allDay ? `${date}T00:00` : `${date}T${entry.start}`,
      end: allDay ? `${localDateStamp(addLocalDays(now, entry.day + 1))}T00:00` : `${date}T${entry.end}`,
      allDay,
      categoryId: entry.category,
      notes: '',
      recurrence: 'none',
      exceptions: [],
      createdAt: stampedAt,
      updatedAt: stampedAt,
    };
  });
}

module.exports = {
  DEMO_MODEL,
  SEEDED_SESSIONS,
  SEEDED_CALENDAR_EVENTS,
  buildSeededSessions,
  buildSeededCalendarEvents,
};
