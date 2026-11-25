'use strict';

// Team timeline, opening an unread channel (team review fixes, H22.1): the log lands on the first unread message (the
// "New" line) instead of the bottom, and the channel is marked read only once the reader has got there, not on open.
// Real modules over the harness bridge; the layout stub gives the log a height and this file adds the geometry of its rows.
// new-test-file: a new surface (where an unread channel opens and when it counts as read); tests/renderer-team-timeline.test.js is near its line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAYA, flush, memberTeam, harness, layout, chatChannel, message, overview } = require('./helpers/team-settings-harness');

const at = (ms) => new Date(ms).toISOString();
const HOUR = 3_600_000;

// The layout stub measures the log (400 px) and its rows (40 px a message, 20 px anything else); this gives each row its box
// as a browser would, so the timeline can find where "New" is.
function rows(h) {
  const proto = h.window.HTMLElement.prototype;
  const saved = proto.getBoundingClientRect;
  const box = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top });
  proto.getBoundingClientRect = function measure() {
    if (this.classList && this.classList.contains('team-scroll')) return box(0, 400);
    const parent = this.parentElement;
    if (!parent || !parent.classList.contains('team-scroll')) return box(0, 0);
    let top = -parent.scrollTop;
    for (const child of parent.children) {
      const height = child.classList.contains('team-msg') ? 40 : 20;
      if (child === this) return box(top, height);
      top += height;
    }
    return box(0, 0);
  };
  h.cleanups.push(() => { proto.getBoundingClientRect = saved; });
}

async function open({ count = 30, lastRead = 10, focused = true } = {}) {
  const messages = Array.from({ length: count }, (_v, i) => message(i + 1, { author: { kind: 'member', member_id: MAYA }, created_at: at(Date.now() - 2 * HOUR) }));
  const h = harness({ show: false, teams: [memberTeam()], answers: {
    chatOverview: overview({ channels: [chatChannel({ last_read_seq: lastRead, last_seq: count, unread: count - lastRead })] }),
    chatHistory: { ok: true, messages, has_more: false },
  } });
  const box = layout(h, { focused });
  rows(h);
  h.cleanups.push(h.chat.use());
  h.showTab();
  await flush();
  return { h, box, log: () => h.view.q('.team-scroll') };
}
const marked = (h) => h.sent('chatMarkRead').map((call) => call.payload.seq);

test('H22.1: opening an unread channel lands on the New line and marks nothing read until the reader reaches the end', async (t) => {
  const { h, box, log } = await open();
  t.after(h.restore);
  const line = h.view.q('.team-new');
  assert.ok(line, 'the New line is drawn above the first unread message');
  assert.equal(line.nextElementSibling.dataset.seq, '11');
  assert.equal(log().scrollTop, 420, 'the log is scrolled to the New line, not to the bottom (the day line and ten messages above it)');
  assert.equal(line.getBoundingClientRect().top, 0, 'it sits at the top of the log');
  assert.deepEqual(marked(h), [], 'opening is not reading');
  box.scroll(log(), 100_000);
  await flush();
  assert.deepEqual(marked(h), [30], 'at the end it is read');
});

test('H22.1: when all the unread fits in view the channel is read at once, the New line still drawn', async (t) => {
  const { h, log } = await open({ count: 12, lastRead: 8 });
  t.after(h.restore);
  assert.ok(h.view.q('.team-new'));
  assert.equal(log().scrollTop, log().scrollHeight - 400, 'the end is reached by landing on New');
  assert.deepEqual(marked(h), [12]);
});

test('H22.1: a channel with nothing unread still opens at the bottom', async (t) => {
  const { h, log } = await open({ lastRead: 30 });
  t.after(h.restore);
  assert.equal(h.view.q('.team-new'), null);
  assert.equal(log().scrollTop, log().scrollHeight - 400);
});
