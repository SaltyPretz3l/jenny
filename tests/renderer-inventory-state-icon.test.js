'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const stateIcon = require('../renderer/inventory/state-icon');
const emptyNote = require('../renderer/inventory/empty-note');

function parse(markup) {
  return new JSDOM(`<body>${markup}</body>`).window.document.body;
}

test('state icon draws a hidden 24-unit stroke glyph with an optional tone and size', () => {
  const svg = parse(stateIcon('warn', { tone: 'warn', size: 'sm' })).querySelector('svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.deepEqual([...svg.classList], ['inv-state-icon', 'inv-state-icon--warn', 'inv-state-icon--sm']);
  assert.ok(svg.querySelector('path'));
  assert.deepEqual([...parse(stateIcon('ok')).querySelector('svg').classList], ['inv-state-icon']);
});

test('state icon ignores unknown names, tones and sizes instead of emitting them', () => {
  assert.equal(stateIcon('nope'), '');
  assert.equal(stateIcon('constructor'), '');
  const svg = parse(stateIcon('ok', { tone: 'x" onload="y', size: 'huge' })).querySelector('svg');
  assert.deepEqual([...svg.classList], ['inv-state-icon']);
  assert.equal(svg.getAttribute('onload'), null);
});

test('severity icons exist for errors and warnings only', () => {
  assert.match(stateIcon.forLevel('error'), /inv-state-icon--error/);
  assert.match(stateIcon.forLevel('WARN'), /inv-state-icon--warn/);
  assert.match(stateIcon.forLevel('ERROR', { size: 'sm' }), /inv-state-icon--sm/);
  assert.equal(stateIcon.forLevel('INFO'), '');
  assert.equal(stateIcon.forLevel('DEBUG'), '');
  assert.equal(stateIcon.forLevel(undefined), '');
});

test('empty note renders one escaped sentence and an optional hint, or nothing', () => {
  const note = parse(emptyNote({ text: 'No chats <yet>.', hint: 'Send one & look again.', role: 'status' })).firstElementChild;
  assert.equal(note.tagName, 'P');
  assert.equal(note.className, 'inv-empty-note');
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(note.textContent, 'No chats <yet>. Send one & look again.');
  assert.equal(note.querySelector('.inv-empty-note-hint').textContent, 'Send one & look again.');
  assert.equal(parse(emptyNote({ text: 'Nothing here.' })).firstElementChild.getAttribute('role'), null);
  assert.equal(emptyNote({ text: '   ' }), '');
  assert.equal(emptyNote(), '');
});
