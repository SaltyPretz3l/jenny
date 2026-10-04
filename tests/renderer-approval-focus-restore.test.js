'use strict';

/* Focus hand-off when an answered approval row leaves the transcript
 * (renderer/chat/renderer-approval-focus-restore.js): the fallback is chosen at
 * click time and focused when the row is actually removed, never stolen from
 * wherever the reader moved meanwhile. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createApprovalFocusRestore } = require('../renderer/chat/renderer-approval-focus-restore');

function row(callId, variant) {
  return `<div class="approval-gap-row" data-tool-call-id="${callId}"${variant ? ` data-approval-variant="${variant}"` : ''}>`
    + (variant === 'plan' ? '' : '<button class="tool-approve-btn" type="button">Allow</button><button class="tool-deny-btn" type="button">Deny</button>')
    + '</div>';
}

function setup(t, rowsHtml) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><textarea id="chatInput"></textarea>'
    + `<div id="chatTimeline">${rowsHtml}</div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const chatTimeline = doc.getElementById('chatTimeline');
  const restore = createApprovalFocusRestore({ chatTimeline, doc });
  t.after(() => { restore.dispose(); dom.window.close(); });
  return { dom, doc, chatTimeline, restore, rows: () => Array.from(chatTimeline.querySelectorAll('.approval-gap-row')) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the fallback is the next pending row\'s first action, skipping actionless plan rows', (t) => {
  const { restore, rows } = setup(t, row('c1') + row('plan-1', 'plan') + row('c2'));
  const [first, , third] = rows();
  assert.equal(restore.resolveApprovalFocusFallback(first), third.querySelector('.tool-approve-btn'));
});

test('with no other pending row the fallback is the composer input', (t) => {
  const { doc, restore, rows } = setup(t, row('c1'));
  assert.equal(restore.resolveApprovalFocusFallback(rows()[0]), doc.getElementById('chatInput'));
});

test('removal focuses the fallback only when the row held focus and nothing else took it', async (t) => {
  const { doc, restore, rows } = setup(t, row('c1') + row('c2'));
  const [first, second] = rows();
  const fallback = restore.resolveApprovalFocusFallback(first);
  first.querySelector('.tool-approve-btn').focus();
  restore.watchApprovalRowRemoval(first, fallback, true);
  first.remove();
  await settle();
  assert.equal(doc.activeElement, second.querySelector('.tool-approve-btn'));
});

test('removal leaves focus alone when the row did not hold it or the reader moved on', async (t) => {
  const { doc, restore, rows } = setup(t, row('c1') + row('c2') + row('c3'));
  const [first, second, third] = rows();
  const composer = doc.getElementById('chatInput');

  composer.focus();
  restore.watchApprovalRowRemoval(first, restore.resolveApprovalFocusFallback(first), false);
  first.remove();
  await settle();
  assert.equal(doc.activeElement, composer, 'the row never held focus');

  second.querySelector('.tool-approve-btn').focus();
  restore.watchApprovalRowRemoval(second, restore.resolveApprovalFocusFallback(second), true);
  composer.focus(); // the reader went back to typing before the row left
  second.remove();
  await settle();
  assert.equal(doc.activeElement, composer, 'focus the reader moved is not pulled back');
  assert.ok(third.isConnected);
});

test('dispose disconnects watchers still waiting', async (t) => {
  const { doc, restore, rows } = setup(t, row('c1') + row('c2'));
  const [first] = rows();
  first.querySelector('.tool-approve-btn').focus();
  restore.watchApprovalRowRemoval(first, restore.resolveApprovalFocusFallback(first), true);
  restore.dispose();
  first.remove();
  await settle();
  assert.equal(doc.activeElement, doc.body, 'no focus move after dispose');
});
