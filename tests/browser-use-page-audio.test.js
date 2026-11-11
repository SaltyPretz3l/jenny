'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPageAudio } = require('../services/browser-use/page-audio');
const { createFakeTimers } = require('./helpers/fake-timers');

const SETTLE = 2500;
const QUIET = 30000;

function makeAudio({ appMuted = false } = {}) {
  const timers = createFakeTimers();
  const contents = new EventEmitter();
  contents.mutes = [];
  contents.audibleNow = false;
  contents.destroyed = false;
  contents.setAudioMuted = (muted) => {
    if (contents.destroyed) throw new Error('Object has been destroyed');
    contents.mutes.push(muted);
  };
  contents.isCurrentlyAudible = () => contents.audibleNow;
  const app = { muted: appMuted };
  const changes = { count: 0 };
  const audio = createPageAudio({
    webContents: contents,
    isAppMuted: () => app.muted,
    onChanged: () => { changes.count += 1; },
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    settleMs: SETTLE,
    quietMs: QUIET,
  });
  const emit = (audible) => {
    contents.audibleNow = audible;
    contents.emit('audio-state-changed', { audible });
  };
  const lastMute = () => contents.mutes[contents.mutes.length - 1];
  return { audio, contents, timers, app, changes, emit, lastMute };
}

test('a new page starts muted and silent', () => {
  const { audio, contents } = makeAudio();
  assert.deepEqual(contents.mutes, [true]);
  assert.equal(audio.sound(), null);
  assert.equal(audio.chatMuted(), false);
  assert.equal(audio.keepsPageAlive(), false);
});

test('placing the page on screen unmutes it and a rise is reported at once', () => {
  const { audio, emit, lastMute } = makeAudio();
  audio.place();
  assert.equal(lastMute(), false);
  emit(true);
  assert.equal(audio.sound(), 'playing');
  assert.equal(audio.keepsPageAlive(), true);
});

test('parking a page that is making sound keeps it heard', () => {
  const { audio, emit, lastMute, contents } = makeAudio();
  audio.place();
  emit(true);
  audio.park();
  assert.equal(lastMute(), false);
  assert.equal(contents.mutes.length, 2);
  assert.equal(audio.sound(), 'playing');
});

test('parking a silent page mutes it', () => {
  const { audio, lastMute } = makeAudio();
  audio.place();
  audio.park();
  assert.equal(lastMute(), true);
  assert.equal(audio.sound(), null);
});

test('a page that starts sounding while parked and unheard stays muted but reports muted', () => {
  const { audio, emit, lastMute, contents } = makeAudio();
  audio.place();
  audio.park();
  const mutesBefore = contents.mutes.length;
  emit(true);
  assert.equal(lastMute(), true);
  assert.equal(contents.mutes.length, mutesBefore);
  assert.equal(audio.sound(), 'muted');
  assert.equal(audio.keepsPageAlive(), false);
});

test('parking a page that is audible only because Electron ignores the mute does not keep it heard', () => {
  const { audio, emit, lastMute } = makeAudio();
  audio.place();
  emit(true);
  audio.toggleChat();
  assert.equal(audio.chatMuted(), true);
  audio.park();
  assert.equal(lastMute(), true);
  audio.toggleChat();
  assert.equal(lastMute(), false);
});

test('a falling edge applies only after the settle time of silence', () => {
  const { audio, emit, timers } = makeAudio();
  audio.place();
  emit(true);
  emit(false);
  timers.tick(SETTLE - 1);
  assert.equal(audio.sound(), 'playing');
  timers.tick(1);
  assert.equal(audio.sound(), null);
});

test('a rise during the settle time cancels the fall', () => {
  const { audio, emit, timers } = makeAudio();
  audio.place();
  emit(true);
  emit(false);
  timers.tick(SETTLE - 100);
  emit(true);
  timers.tick(SETTLE * 2);
  assert.equal(audio.sound(), 'playing');
  assert.equal(timers.pending(), 0);
});

test('repeated falling events do not restart the settle time', () => {
  const { audio, emit, timers } = makeAudio();
  audio.place();
  emit(true);
  emit(false);
  timers.tick(1000);
  emit(false);
  timers.tick(SETTLE - 1000);
  assert.equal(audio.sound(), null);
});

test('quiet time after the sound stops ends the background allowance', () => {
  const { audio, emit, timers, lastMute } = makeAudio();
  audio.place();
  emit(true);
  audio.park();
  emit(false);
  timers.tick(SETTLE);
  assert.equal(lastMute(), false);
  timers.tick(QUIET - 1);
  assert.equal(lastMute(), false);
  timers.tick(1);
  assert.equal(lastMute(), true);
  emit(true);
  assert.equal(audio.sound(), 'muted');
});

test('a rise during the quiet time cancels it', () => {
  const { audio, emit, timers, lastMute } = makeAudio();
  audio.place();
  emit(true);
  audio.park();
  emit(false);
  timers.tick(SETTLE + QUIET - 1000);
  emit(true);
  timers.tick(QUIET * 2);
  assert.equal(lastMute(), false);
  assert.equal(audio.sound(), 'playing');
});

test('placing the page again clears the background allowance and the quiet timer', () => {
  const { audio, emit, timers } = makeAudio();
  audio.place();
  emit(true);
  audio.park();
  emit(false);
  timers.tick(SETTLE);
  audio.place();
  assert.equal(timers.pending(), 0);
  audio.park();
  assert.equal(audio.sound(), null);
});

test('toggling chat sound on a playing on-screen page mutes it, and again unmutes it', () => {
  const { audio, emit, lastMute } = makeAudio();
  audio.place();
  emit(true);
  audio.toggleChat();
  assert.equal(audio.chatMuted(), true);
  assert.equal(lastMute(), true);
  assert.equal(audio.sound(), 'muted');
  audio.toggleChat();
  assert.equal(audio.chatMuted(), false);
  assert.equal(lastMute(), false);
  assert.equal(audio.sound(), 'playing');
});

test('toggling chat sound on a parked unheard page lets it play on', () => {
  const { audio, emit, lastMute } = makeAudio();
  audio.place();
  audio.park();
  emit(true);
  assert.equal(audio.sound(), 'muted');
  audio.toggleChat();
  assert.equal(audio.chatMuted(), false);
  assert.equal(lastMute(), false);
  assert.equal(audio.sound(), 'playing');
});

test('toggling chat sound on a parked heard page mutes it, and again lets it play on', () => {
  const { audio, emit, lastMute } = makeAudio();
  audio.place();
  emit(true);
  audio.park();
  audio.toggleChat();
  assert.equal(audio.chatMuted(), true);
  assert.equal(lastMute(), true);
  audio.toggleChat();
  assert.equal(audio.chatMuted(), false);
  assert.equal(lastMute(), false);
  assert.equal(audio.sound(), 'playing');
});

test('toggling chat sound does nothing while the whole app is muted', () => {
  const { audio, app, emit, contents } = makeAudio();
  audio.place();
  emit(true);
  app.muted = true;
  audio.applyMute();
  const mutes = contents.mutes.length;
  audio.toggleChat();
  assert.equal(audio.chatMuted(), false);
  assert.equal(contents.mutes.length, mutes);
});

test('the app mute forces the page muted and lifting it restores the sound', () => {
  const { audio, app, emit, lastMute } = makeAudio();
  audio.place();
  emit(true);
  app.muted = true;
  audio.applyMute();
  assert.equal(lastMute(), true);
  assert.equal(audio.sound(), 'muted');
  assert.equal(audio.keepsPageAlive(), true, 'muted is not stopped, and closing it would lose the page');
  app.muted = false;
  audio.applyMute();
  assert.equal(lastMute(), false);
  assert.equal(audio.sound(), 'playing');
});

test('leaving the chat under the window mute still comes back when the window is unmuted', () => {
  const { audio, app, emit, lastMute } = makeAudio();
  audio.place();
  emit(true);
  app.muted = true;
  audio.applyMute();
  audio.park();
  assert.equal(lastMute(), true);
  app.muted = false;
  audio.applyMute();
  assert.equal(lastMute(), false);
  assert.equal(audio.sound(), 'playing');
});

test('a new document silences a parked page; on screen it changes nothing', () => {
  const { audio, emit, lastMute } = makeAudio();
  audio.place();
  emit(true);
  audio.navigated();
  assert.equal(lastMute(), false, 'on screen');
  audio.park();
  assert.equal(lastMute(), false, 'heard when it left');
  audio.navigated();
  assert.equal(lastMute(), true);
  assert.equal(audio.sound(), 'muted');
  assert.equal(audio.keepsPageAlive(), false);
});

test('a chat mute kept from before a crash applies from the start', () => {
  const contents = new EventEmitter();
  contents.setAudioMuted = () => {};
  contents.isCurrentlyAudible = () => false;
  const audio = createPageAudio({ webContents: contents, startMuted: true });
  audio.place();
  assert.equal(audio.chatMuted(), true);
  assert.equal(audio.sound(), 'muted');
  audio.dispose();
});

test('applying an unchanged mute does not call the page again', () => {
  const { audio, contents } = makeAudio();
  audio.place();
  audio.applyMute();
  audio.applyMute();
  assert.deepEqual(contents.mutes, [true, false]);
});

test('onChanged fires only when the reported sound changes', () => {
  const { audio, emit, timers, changes } = makeAudio();
  audio.place();
  assert.equal(changes.count, 0);
  emit(true);
  assert.equal(changes.count, 1);
  emit(true);
  assert.equal(changes.count, 1);
  emit(false);
  emit(true);
  timers.tick(SETTLE * 2);
  assert.equal(changes.count, 1);
  audio.toggleChat();
  assert.equal(changes.count, 2);
  audio.toggleChat();
  assert.equal(changes.count, 3);
  emit(false);
  timers.tick(SETTLE);
  assert.equal(changes.count, 4);
});

test('a destroyed page never makes a call throw', () => {
  const { audio, contents, emit, timers } = makeAudio();
  audio.place();
  emit(true);
  contents.destroyed = true;
  contents.isCurrentlyAudible = () => { throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => {
    audio.park();
    audio.place();
    audio.toggleChat();
    audio.applyMute();
    emit(false);
    timers.tick(SETTLE);
    audio.dispose();
  });
  assert.equal(audio.chatMuted(), true);
  assert.equal(audio.sound(), 'muted');
  assert.equal(timers.pending(), 0);
});

test('dispose clears the timers and removes the listener', () => {
  const { audio, contents, emit, timers, changes } = makeAudio();
  audio.place();
  emit(true);
  audio.park();
  emit(false);
  assert.equal(timers.pending(), 1);
  assert.equal(contents.listenerCount('audio-state-changed'), 1);
  audio.dispose();
  assert.equal(timers.pending(), 0);
  assert.equal(contents.listenerCount('audio-state-changed'), 0);
  const before = changes.count;
  timers.tick(QUIET * 2);
  assert.equal(changes.count, before);
});
