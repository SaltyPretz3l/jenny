'use strict';

// Composer meta-row placement guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function loadIndexDocument() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  return new JSDOM(html).window.document;
}

test('the composer meta row follows the composer card inside composerWrap', () => {
  const doc = loadIndexDocument();
  const wrap = doc.getElementById('composerWrap');
  const composer = wrap?.querySelector(':scope > .composer');
  const row = doc.getElementById('composerModeChips');

  assert.ok(wrap, 'composer wrap present');
  assert.equal(row?.parentElement, wrap, 'meta row stays inside composerWrap');
  assert.ok(composer, 'composer card present');
  assert.ok(
    composer.compareDocumentPosition(row) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'meta row follows the composer card'
  );
  assert.equal(doc.getElementById('composerModeChipsAnnouncer')?.parentElement, row, 'announcer stays in the meta row');
  assert.equal(doc.getElementById('composerRunModeHint')?.parentElement, row, 'hint stays in the meta row');
  const timer = doc.getElementById('composerTurnTimer');
  assert.equal(timer?.parentElement, row, 'turn timer ships in the meta row');
  assert.equal(timer?.getAttribute('data-turn-timer-state'), 'idle', 'timer ships idle');
  assert.equal(row.getAttribute('role'), 'group', 'meta row exposes its grouped controls');
  assert.equal(row.getAttribute('aria-label'), 'Composer modes', 'meta row has an accessible name');
});
