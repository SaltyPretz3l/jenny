'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputWatch } = require('../services/browser-use/input-watch');

function setup(options = {}) {
  let clock = 1000;
  const seen = { takeOvers: [], activity: 0, chords: [] };
  const watch = createInputWatch({
    now: () => clock,
    onTakeOver: (reason) => seen.takeOvers.push(reason),
    onActivity: () => { seen.activity += 1; },
    forwardChord: (input) => seen.chords.push(input),
    ...options,
  });
  return { watch, seen, advance: (ms) => { clock += ms; } };
}

function keyEvent() {
  const event = { prevented: false, preventDefault() { event.prevented = true; } };
  return event;
}

test('a plain key press takes over and counts as activity', () => {
  const { watch, seen } = setup();
  const event = keyEvent();
  watch.onKey(event, { type: 'keyDown', key: 'h' });
  assert.deepEqual(seen.takeOvers, ['keyboard']);
  assert.equal(seen.activity, 1);
  assert.equal(event.prevented, false);
  assert.deepEqual(seen.chords, []);
});

test('rawKeyDown also takes over, keyUp is activity only', () => {
  const { watch, seen } = setup();
  watch.onKey(keyEvent(), { type: 'rawKeyDown', key: 'h' });
  watch.onKey(keyEvent(), { type: 'keyUp', key: 'h' });
  assert.deepEqual(seen.takeOvers, ['keyboard']);
  assert.equal(seen.activity, 2);
});

test('app chords are prevented and forwarded without taking over', () => {
  const { watch, seen } = setup();
  const chords = [
    { type: 'keyDown', key: 'k', control: true },
    { type: 'keyDown', key: 'n', meta: true },
    { type: 'keyDown', key: '3', control: true },
    { type: 'keyDown', key: ' ', control: true, shift: true },
  ];
  for (const input of chords) {
    const event = keyEvent();
    watch.onKey(event, input);
    assert.equal(event.prevented, true, input.key);
  }
  assert.deepEqual(seen.takeOvers, []);
  assert.equal(seen.chords.length, 4);
  assert.equal(seen.chords[0].key, 'k');
});

test('editing shortcuts and everything else reach the page, and the keyboard stays there', () => {
  const { watch, seen } = setup();
  const keys = [
    { key: 'ArrowLeft', control: true }, { key: 'Backspace', control: true }, { key: 'z', control: true, shift: true },
    { key: 'b', control: true }, { key: 't', control: true }, { key: 'k', control: true, shift: true },
  ];
  for (const input of keys) {
    const event = keyEvent();
    watch.onKey(event, { type: 'keyDown', ...input });
    assert.equal(event.prevented, false, input.key);
  }
  assert.deepEqual(seen.chords, []);
  assert.equal(seen.takeOvers.length, keys.length);
});

test('the browser shortcuts are kept from the page and named for the panel', () => {
  const named = [];
  const { watch, seen } = setup({ onBrowserChord: (chord) => named.push(chord) });
  const cases = [
    [{ key: 'l', control: true }, 'address'], [{ key: 'F', control: true }, 'find'], [{ key: 'r', control: true }, 'reload'], [{ key: 'F5' }, 'reload'],
    [{ key: 'ArrowLeft', alt: true }, 'back'], [{ key: 'ArrowRight', alt: true }, 'forward'],
    [{ key: '=', control: true }, 'zoom_in'], [{ key: '+', control: true, shift: true }, 'zoom_in'], [{ key: '-', control: true }, 'zoom_out'], [{ key: '0', control: true }, 'zoom_reset'],
  ];
  for (const [input, chord] of cases) {
    const event = keyEvent();
    watch.onKey(event, { type: 'keyDown', ...input });
    assert.equal(event.prevented, true, chord);
    assert.equal(named.at(-1), chord);
  }
  assert.deepEqual(seen.takeOvers, []);
  assert.deepEqual(seen.chords, []);
});

test('holding a modifier on the way to a shortcut is not touching the page', () => {
  const { watch, seen } = setup({ onUserKey: () => { seen.userKeys = (seen.userKeys || 0) + 1; } });
  for (const key of ['Control', 'Shift', 'Alt', 'Meta']) watch.onKey(keyEvent(), { type: 'rawKeyDown', key, control: key === 'Control' });
  assert.deepEqual(seen.takeOvers, []);
  assert.equal(seen.userKeys, undefined);
  watch.onKey(keyEvent(), { type: 'keyDown', key: 'h' });
  assert.equal(seen.userKeys, 1);
});

test('plain select-all, copy, paste, cut, redo and undo belong to the page', () => {
  const { watch, seen } = setup();
  for (const key of ['a', 'c', 'v', 'x', 'y', 'z', 'A']) {
    const event = keyEvent();
    watch.onKey(event, { type: 'keyDown', key, control: true });
    assert.equal(event.prevented, false, key);
  }
  watch.onKey(keyEvent(), { type: 'keyDown', key: 'c', meta: true });
  assert.equal(seen.takeOvers.length, 8);
  assert.deepEqual(seen.chords, []);
});

test('AltGr typing of a printable character is typing, not a chord', () => {
  const { watch, seen } = setup();
  const event = keyEvent();
  watch.onKey(event, { type: 'keyDown', key: '@', control: true, alt: true });
  assert.equal(event.prevented, false);
  assert.deepEqual(seen.takeOvers, ['keyboard']);
});

test('only a mouse press takes over; moves, wheel and release do not', () => {
  const { watch, seen } = setup();
  watch.onMouse({}, { type: 'mouseMove' });
  watch.onMouse({}, { type: 'mouseWheel' });
  watch.onMouse({}, { type: 'mouseUp' });
  assert.deepEqual(seen.takeOvers, []);
  assert.equal(seen.activity, 3);
  watch.onMouse({}, { type: 'mouseDown' });
  assert.deepEqual(seen.takeOvers, ['mouse']);
  assert.equal(seen.activity, 4);
});

test('input inside the grace window after our own input is ignored entirely', () => {
  const { watch, seen, advance } = setup();
  watch.noteOwnInput();
  advance(100);
  const event = keyEvent();
  watch.onKey(event, { type: 'keyDown', key: 't', control: true });
  watch.onKey(keyEvent(), { type: 'keyDown', key: 'h' });
  watch.onMouse({}, { type: 'mouseDown' });
  assert.deepEqual(seen.takeOvers, []);
  assert.deepEqual(seen.chords, []);
  assert.equal(seen.activity, 0);
  assert.equal(event.prevented, false);
});

test('the grace window ends after ownInputGraceMs and a later note extends it', () => {
  const { watch, seen, advance } = setup({ ownInputGraceMs: 250 });
  watch.noteOwnInput();
  advance(250);
  watch.onMouse({}, { type: 'mouseDown' });
  assert.deepEqual(seen.takeOvers, ['mouse']);
  watch.noteOwnInput();
  advance(200);
  watch.noteOwnInput();
  advance(200);
  watch.onMouse({}, { type: 'mouseDown' });
  assert.equal(seen.takeOvers.length, 1);
});

test('missing callbacks and malformed input never throw', () => {
  const bare = createInputWatch({ now: () => 0 });
  const event = keyEvent();
  bare.onKey(event, { type: 'keyDown', key: 'k', control: true });
  assert.equal(event.prevented, true, 'with nowhere to forward it, a chord is still kept from the page');
  assert.doesNotThrow(() => {
    bare.onKey(undefined, undefined);
    bare.onKey({}, { type: 'keyDown', key: 'k', control: true });
    bare.onMouse(undefined, undefined);
    bare.noteOwnInput();
  });
});

test('malformed input is not the user, and a chord forwards from an event with no preventDefault', () => {
  const { watch, seen } = setup();
  watch.onKey(undefined, undefined);
  watch.onMouse(undefined, undefined);
  assert.deepEqual(seen, { takeOvers: [], activity: 0, chords: [] });
  const chord = { type: 'keyDown', key: 'k', control: true };
  watch.onKey({}, chord);
  assert.deepEqual(seen.chords, [chord]);
  assert.deepEqual(seen.takeOvers, []);
});
