'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppSound } = require('../services/main/app-sound-service');
const { createFakeTimers } = require('./helpers/fake-timers');

function fakeContents({ managed = false, destroyed = false, throws = false } = {}) {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.managed = managed;
  emitter.destroyed = destroyed;
  emitter.calls = calls;
  emitter.isDestroyed = () => emitter.destroyed;
  emitter.setAudioMuted = (value) => {
    if (throws) throw new Error('boom');
    calls.push(value);
  };
  return emitter;
}

function makeSound({ contents = [], sendThrows = false } = {}) {
  const timers = createFakeTimers();
  const pushes = [];
  const counts = { muteChanged: 0 };
  const sound = createAppSound({
    listContents: () => contents,
    isManagedPage: (item) => item.managed === true,
    sendBridgeEvent: (channel, payload) => {
      if (sendThrows) throw new Error('bridge down');
      pushes.push({ channel, payload });
    },
    onMuteChanged: () => { counts.muteChanged += 1; },
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });
  return { sound, timers, pushes, counts };
}

test('starts unmuted, silent and with no chats', () => {
  const { sound, pushes } = makeSound();
  assert.equal(sound.isMuted(), false);
  assert.deepEqual(sound.state(), { muted: false, audible: false, chats: {} });
  assert.equal(pushes.length, 0);
});

test('muting silences unmanaged contents, skips managed and destroyed ones, notifies and pushes once', () => {
  const plain = fakeContents();
  const managed = fakeContents({ managed: true });
  const gone = fakeContents({ destroyed: true });
  const { sound, pushes, counts } = makeSound({ contents: [plain, managed, gone] });
  sound.setMuted(true);
  assert.deepEqual(plain.calls, [true]);
  assert.deepEqual(managed.calls, []);
  assert.deepEqual(gone.calls, []);
  assert.equal(counts.muteChanged, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].channel, 'appSound.onChanged');
  assert.equal(pushes[0].payload.muted, true);
  assert.equal(sound.isMuted(), true);
});

test('muting again changes nothing and pushes nothing', () => {
  const plain = fakeContents();
  const { sound, pushes, counts } = makeSound({ contents: [plain] });
  sound.setMuted(true);
  sound.setMuted(true);
  assert.deepEqual(plain.calls, [true]);
  assert.equal(counts.muteChanged, 1);
  assert.equal(pushes.length, 1);
});

test('unmuting restores the sound', () => {
  const plain = fakeContents();
  const { sound, pushes } = makeSound({ contents: [plain] });
  sound.setMuted(true);
  sound.setMuted(false);
  assert.deepEqual(plain.calls, [true, false]);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].payload.muted, false);
});

test('new contents get the current state while muted and while unmuted, and managed ones are skipped', () => {
  const { sound } = makeSound();
  const first = fakeContents();
  sound.applyToContents(first);
  sound.setMuted(true);
  const second = fakeContents();
  const managed = fakeContents({ managed: true });
  sound.applyToContents(second);
  sound.applyToContents(managed);
  assert.deepEqual(first.calls, [false]);
  assert.deepEqual(second.calls, [true]);
  assert.deepEqual(managed.calls, []);
});

test('a chat sound is added, changed and removed, and pushes only when it really changes', () => {
  const { sound, pushes } = makeSound();
  sound.noteChatSound('a', 'playing');
  sound.noteChatSound('a', 'playing');
  assert.equal(pushes.length, 1);
  sound.noteChatSound('a', 'muted');
  assert.equal(pushes.length, 2);
  assert.deepEqual(sound.state().chats, { a: 'muted' });
  sound.noteChatSound('a', null);
  assert.equal(pushes.length, 3);
  assert.deepEqual(sound.state().chats, {});
  sound.noteChatSound('a', null);
  assert.equal(pushes.length, 3);
});

test('a null sound drops a chat and an unknown id is quiet', () => {
  const { sound, pushes } = makeSound();
  sound.noteChatSound('a', 'playing');
  sound.noteChatSound('a', null);
  sound.noteChatSound('missing', null);
  assert.deepEqual(sound.state().chats, {});
  assert.equal(pushes.length, 2);
});

test('an id such as __proto__ stays an ordinary chat key', () => {
  const { sound } = makeSound();
  sound.noteChatSound('__proto__', 'playing');
  const { chats } = sound.state();
  assert.equal(Object.getPrototypeOf(chats), Object.prototype);
  assert.deepEqual(Object.keys(chats), ['__proto__']);
  assert.equal(Object.prototype.hasOwnProperty.call(chats, '__proto__'), true);
  assert.equal({}.playing, undefined);
});

test('audible comes from a chat that is playing, not from one that is muted', () => {
  const { sound } = makeSound();
  sound.noteChatSound('a', 'muted');
  assert.equal(sound.state().audible, false);
  sound.noteChatSound('b', 'playing');
  assert.equal(sound.state().audible, true);
  sound.noteChatSound('b', 'muted');
  assert.equal(sound.state().audible, false);
});

test('the main window is audible at once, falls only after the hold and a rise cancels the fall', () => {
  const main = fakeContents();
  const { sound, timers, pushes } = makeSound();
  sound.watchMainContents(main);
  main.emit('audio-state-changed', { audible: true });
  assert.equal(sound.state().audible, true);
  assert.equal(pushes.length, 1);

  main.emit('audio-state-changed', { audible: false });
  timers.tick(2499);
  assert.equal(sound.state().audible, true);
  main.emit('audio-state-changed', { audible: true });
  timers.tick(5000);
  assert.equal(sound.state().audible, true);
  assert.equal(pushes.length, 1);

  main.emit('audio-state-changed', { audible: false });
  timers.tick(2500);
  assert.equal(sound.state().audible, false);
  assert.equal(pushes.length, 2);
  assert.equal(timers.pending(), 0);
});

test('a contents that throws does not stop the others', () => {
  const bad = fakeContents({ throws: true });
  const good = fakeContents();
  const { sound, counts, pushes } = makeSound({ contents: [bad, good] });
  sound.setMuted(true);
  assert.deepEqual(good.calls, [true]);
  assert.equal(counts.muteChanged, 1);
  assert.equal(pushes.length, 1);
});

test('dispose clears the timer and listener and stops pushes', () => {
  const main = fakeContents();
  const { sound, timers, pushes } = makeSound();
  sound.watchMainContents(main);
  main.emit('audio-state-changed', { audible: true });
  main.emit('audio-state-changed', { audible: false });
  assert.equal(timers.pending(), 1);
  sound.dispose();
  assert.equal(timers.pending(), 0);
  assert.equal(main.listenerCount('audio-state-changed'), 0);
  const before = pushes.length;
  sound.noteChatSound('a', 'playing');
  sound.setMuted(true);
  assert.equal(pushes.length, before);
});

test('a bridge that throws never throws out', () => {
  const { sound } = makeSound({ sendThrows: true });
  assert.doesNotThrow(() => sound.setMuted(true));
  assert.doesNotThrow(() => sound.noteChatSound('a', 'playing'));
  assert.equal(sound.isMuted(), true);
});
