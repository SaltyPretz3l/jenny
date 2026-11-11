'use strict';

// What the browser panel says (row 117): the status line, refused addresses and the stand-in for a missing page.

const test = require('node:test');
const assert = require('node:assert/strict');

const { addressParts, noteText, pageMessage, problemText, statusFor } = require('../renderer/chat/renderer-browser-use-status');

const page = (extra = {}) => ({ open: true, mode: 'model', url: 'https://a.example/', title: 'A', ...extra });

test('a person holding the page outranks everything but a refused address', () => {
  assert.deepEqual(statusFor(page({ mode: 'user' })), { tone: 'user', text: 'You have the page.', end: 'back' });
  assert.equal(statusFor(page({ mode: 'user', waiting: true })).text, 'You have the page. Jenny is waiting.');
  assert.equal(statusFor(page({ mode: 'user' }), { problem: 'No' }).text, 'No');
});

test('a sign-in is warned about before the page goes back', () => {
  assert.match(statusFor(page({ mode: 'user', signed_in: true })).text, /Jenny can act as you/u);
  assert.match(statusFor(page({ signed_in: true }), { doneOffer: true }).text, /Jenny can act as you/u);
});

test('Tell Jenny to continue is offered once the turn is over and the page was used by hand', () => {
  const offered = statusFor(page(), { doneOffer: true });
  assert.equal(offered.end, 'continue');
  assert.equal(offered.text, 'Done with this page?');
  assert.equal(statusFor(page(), {}).end, '');
});

test('a thinking model keeps the last step; a finished one drops to the page title', () => {
  assert.deepEqual(statusFor(page(), { streaming: true, lastStep: 'Scrolling' }), { tone: 'work', text: 'Scrolling', end: 'take' });
  assert.equal(statusFor(page(), { streaming: false }).text, 'A');
});

test('a note names what happened, and only a saved file offers Show', () => {
  const blocked = statusFor(page({ note: { kind: 'blocked_site', host: 'b.example' } }));
  assert.match(blocked.text, /b\.example/u);
  assert.equal(blocked.end, '');
  assert.equal(statusFor(page({ note: { kind: 'saved', file: 'x.pdf' } })).end, 'show');
  for (const what of ['location', 'camera', 'notifications']) assert.ok(noteText({ kind: 'permission', what }));
});

test('a refused address gets words a person can act on', () => {
  assert.equal(problemText('not_address'), 'Type a full web address.');
  assert.match(problemText('private_address'), /device on your network/u);
  assert.match(problemText('too_many_pages'), /Two pages/u);
  assert.match(problemText('anything_else'), /can't open that address/u);
});

test('the missing page is explained, and every closed page can be opened again', () => {
  assert.equal(pageMessage(page()), null);
  assert.match(pageMessage(page({ failed: 'https://gone.example/' })).title, /gone\.example/u);
  assert.equal(pageMessage(page({ crashed: true })).actionLabel, 'Reload');
  for (const closed_reason of ['idle', 'evicted', 'crash', 'user']) {
    const message = pageMessage({ open: false, closed_reason });
    assert.equal(message.action, 'retry');
    assert.match(message.body, /signed in/u);
  }
  assert.equal(pageMessage({ open: false }).action, '');
});

test('the address stands out by site and admits when it is not encrypted', () => {
  assert.deepEqual(addressParts('https://www.a.example/p?q=1'), { secure: true, host: 'a.example', rest: '/p?q=1', full: 'https://www.a.example/p?q=1' });
  assert.equal(addressParts('http://a.example/').secure, false);
  assert.equal(addressParts('about:blank').host, '');
});

test('ad blocking being off is the quietest thing the line says, and names who turned it off', () => {
  assert.equal(statusFor(page({ ad_block: true })).text, 'A');
  assert.equal(statusFor(page()).text, 'A', 'a page that does not say reads as on');
  const byUser = statusFor(page({ ad_block: false, ad_block_by: 'user' }));
  assert.equal(byUser.text, 'Ad blocking is off for this chat.');
  assert.equal(byUser.quiet, true);
  const byJenny = statusFor(page({ ad_block: false, ad_block_by: 'model' }));
  assert.deepEqual(byJenny, { tone: 'note', text: 'Jenny turned ad blocking off for this chat.', end: '' });
});

test('ad blocking being off never hides an approval, a step, a hold, a note, a failure or the done offer', () => {
  const off = { ad_block: false, ad_block_by: 'model' };
  assert.equal(statusFor(page({ ...off, asking: true })).tone, 'ask');
  assert.equal(statusFor(page({ ...off, busy: true, action: 'scroll' })).text, 'Scrolling');
  assert.equal(statusFor(page({ ...off, mode: 'user' })).text, 'You have the page.');
  assert.equal(statusFor(page(off), { streaming: true, lastStep: 'Scrolling' }).text, 'Scrolling');
  assert.match(statusFor(page({ ...off, note: { kind: 'blocked_link' } })).text, /can't be opened/u);
  assert.equal(statusFor(page(off), { doneOffer: true }).text, 'Done with this page?');
  assert.equal(statusFor(page(off), { problem: 'No' }).text, 'No');
  assert.equal(statusFor(page({ ...off, failed: 'https://gone.example/' })).text, '');
});
