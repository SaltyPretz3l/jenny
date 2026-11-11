'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPageExtras } = require('../services/browser-use/page-extras');
const { createFakeTimers } = require('./helpers/fake-timers');

const YOUTUBE = 'https://www.youtube.com/watch?v=abc';
const AD = { url: 'https://ads.example.net/banner.js', resourceType: 'script' };

function makeExtras({ url = 'https://example.com/page', blocker, loopback = false, exempt = false, acting = false, armed = true } = {}) {
  const timers = createFakeTimers();
  const contents = new EventEmitter();
  const seen = { css: [], reloads: 0, inputs: [], scripts: [], armOptions: [], mutes: [], changes: 0, blocks: [], styleUrls: [] };
  const state = { url, loopback, exempt, acting, armed, hit: null, appMuted: false, styles: 'ad{display:none}', blocks: false };
  contents.getURL = () => state.url;
  contents.setAudioMuted = (muted) => seen.mutes.push(muted);
  contents.isCurrentlyAudible = () => false;
  contents.insertCSS = (css, options) => { seen.css.push({ css, options }); return Promise.resolve('key'); };
  contents.reload = () => { seen.reloads += 1; };
  contents.executeJavaScriptInIsolatedWorld = async (worldId, scripts) => { seen.scripts.push({ worldId, scripts }); return state.hit; };
  const actionContents = { sendInputEvent: (event) => seen.inputs.push(event) };
  const adBlocker = blocker === null ? null : blocker || {
    shouldBlock: (details) => { seen.blocks.push(details); return state.blocks; },
    stylesFor: (pageUrl) => { seen.styleUrls.push(pageUrl); return state.styles; },
  };
  const extras = createPageExtras({
    webContents: contents,
    getActionContents: () => actionContents,
    worldId: 4242,
    armView: async (options) => { seen.armOptions.push(options); return state.armed; },
    adBlocker,
    isAppMuted: () => state.appMuted,
    isModelActing: () => state.acting,
    pageIsLoopback: () => state.loopback,
    isExemptRequest: () => state.exempt,
    onChanged: () => { seen.changes += 1; },
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });
  const emitAudible = (audible) => contents.emit('audio-state-changed', { audible });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { extras, contents, seen, state, timers, emitAudible, flush };
}

test('blocksAd answers false while ad blocking is off', () => {
  const { extras, state, seen } = makeExtras();
  state.blocks = true;
  assert.equal(extras.blocksAd(AD), true);
  extras.setAdBlock(false, 'user');
  assert.equal(extras.blocksAd(AD), false);
  assert.equal(seen.blocks.length, 1, 'the blocker is not asked once it is off');
});

test('blocksAd never touches a main frame, a loopback page or an exempt request', () => {
  const { extras, state, seen } = makeExtras();
  state.blocks = true;
  assert.equal(extras.blocksAd({ url: 'https://example.com/', resourceType: 'mainFrame' }), false);
  state.loopback = true;
  assert.equal(extras.blocksAd(AD), false);
  state.loopback = false;
  state.exempt = true;
  assert.equal(extras.blocksAd(AD), false);
  assert.equal(seen.blocks.length, 0, 'none of those reached the blocker');
  state.exempt = false;
  assert.equal(extras.blocksAd(AD), true);
});

test('blocksAd follows the blocker and with no blocker never blocks', () => {
  const { extras, state } = makeExtras();
  state.blocks = false;
  assert.equal(extras.blocksAd(AD), false);
  state.blocks = true;
  assert.equal(extras.blocksAd(AD), true);
  assert.equal(makeExtras({ blocker: null }).extras.blocksAd(AD), false);
});

test('blocksAd gives the blocker the referrer, else the page address, as the source', () => {
  const { extras, seen } = makeExtras({ url: 'https://news.example.com/story' });
  extras.blocksAd({ ...AD, referrer: 'https://news.example.com/other' });
  extras.blocksAd(AD);
  assert.deepEqual(seen.blocks, [
    { url: AD.url, sourceUrl: 'https://news.example.com/other', type: 'script' },
    { url: AD.url, sourceUrl: 'https://news.example.com/story', type: 'script' },
  ]);
});

test('hideAds inserts the page styles as a user-origin sheet', () => {
  const { extras, seen } = makeExtras({ url: 'https://news.example.com/story' });
  extras.hideAds();
  assert.deepEqual(seen.styleUrls, ['https://news.example.com/story']);
  assert.deepEqual(seen.css, [{ css: 'ad{display:none}', options: { cssOrigin: 'user' } }]);
});

test('hideAds does nothing when off, on a loopback page or with no styles', () => {
  const off = makeExtras();
  off.extras.setAdBlock(false, 'user');
  off.extras.hideAds();
  assert.equal(off.seen.css.length, 0);
  const local = makeExtras({ loopback: true });
  local.extras.hideAds();
  assert.equal(local.seen.css.length, 0);
  for (const empty of ['', null, undefined]) {
    const none = makeExtras();
    none.state.styles = empty;
    none.extras.hideAds();
    assert.equal(none.seen.css.length, 0, `styles ${String(empty)}`);
  }
});

test('hideAds survives a rejecting or throwing insertCSS', async () => {
  const rejecting = makeExtras();
  rejecting.contents.insertCSS = () => Promise.reject(new Error('gone'));
  rejecting.extras.hideAds();
  const throwing = makeExtras();
  throwing.contents.insertCSS = () => { throw new Error('destroyed'); };
  throwing.extras.hideAds();
  await rejecting.flush();
});

test('setAdBlock reloads only on a change and says whether it changed', () => {
  const { extras, seen } = makeExtras();
  assert.equal(extras.setAdBlock(true, 'user'), false);
  assert.equal(seen.reloads, 0);
  assert.equal(seen.changes, 0);
  assert.equal(extras.setAdBlock(false, 'user'), true);
  assert.equal(seen.reloads, 1);
  assert.equal(seen.changes, 1);
  assert.equal(extras.setAdBlock(false, 'user'), false);
  assert.equal(seen.reloads, 1);
  assert.equal(extras.setAdBlock(true, 'user'), true);
  assert.equal(seen.reloads, 2);
  assert.equal(seen.changes, 2);
});

test('setAdBlock records who turned it off, and clears it on turning on', () => {
  const { extras } = makeExtras();
  assert.deepEqual([extras.info().ad_block, extras.info().ad_block_by], [true, '']);
  extras.setAdBlock(false, 'model');
  assert.deepEqual([extras.info().ad_block, extras.info().ad_block_by], [false, 'model']);
  extras.setAdBlock(false, 'user');
  assert.equal(extras.info().ad_block_by, 'model', 'a no-op change does not rewrite who');
  extras.setAdBlock(true, 'user');
  assert.deepEqual([extras.info().ad_block, extras.info().ad_block_by], [true, '']);
  extras.setAdBlock(false);
  assert.equal(extras.info().ad_block_by, '');
});

test('setAdBlock still answers when the page cannot reload', () => {
  const { extras, contents } = makeExtras();
  contents.reload = () => { throw new Error('destroyed'); };
  assert.equal(extras.setAdBlock(false, 'user'), true);
});

test('info reports sound, the chat mute and the ad block together', () => {
  const { extras, emitAudible } = makeExtras();
  assert.deepEqual(extras.info(), { sound: null, ad_block: true, ad_block_by: '' });
  extras.place();
  emitAudible(true);
  assert.equal(extras.sound(), 'playing');
  assert.equal(extras.keepsPageAlive(), true);
  extras.toggleSound();
  assert.deepEqual(extras.info(), { sound: 'muted', ad_block: true, ad_block_by: '' });
  assert.equal(extras.keepsPageAlive(), true, 'still playing behind the mute');
});

test('a sound change reaches onChanged and applyMute follows the app mute', () => {
  const { extras, emitAudible, seen, state } = makeExtras();
  extras.place();
  const before = seen.changes;
  emitAudible(true);
  assert.equal(seen.changes, before + 1);
  assert.equal(seen.mutes.at(-1), false);
  state.appMuted = true;
  extras.applyMute();
  assert.equal(seen.mutes.at(-1), true);
  assert.equal(extras.sound(), 'muted');
  extras.park();
  extras.place();
  assert.equal(seen.mutes.at(-1), true, 'still muted by the app after a round trip');
});

async function startSkipping(options = {}) {
  const fixture = makeExtras({ url: YOUTUBE, ...options });
  fixture.state.hit = { x: 120, y: 80 };
  fixture.extras.place();
  fixture.emitAudible(true);
  fixture.timers.tick(1000);
  await fixture.flush();
  return fixture;
}

test('the skipper presses Skip with a real press after arming the view', async () => {
  const { seen } = await startSkipping();
  assert.equal(seen.scripts.length, 1);
  assert.equal(seen.scripts[0].worldId, 4242);
  assert.equal(seen.armOptions.length, 1);
  assert.equal(seen.armOptions[0].paints(), true);
  assert.deepEqual(seen.inputs.map((event) => event.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  for (const event of seen.inputs) assert.equal(event.x === 120 && event.y === 80, true);
  assert.deepEqual(seen.inputs[1], { type: 'mouseDown', x: 120, y: 80, button: 'left', clickCount: 1 });
  assert.deepEqual(seen.inputs[2], { type: 'mouseUp', x: 120, y: 80, button: 'left', clickCount: 1 });
});

test('the skipper sends no input when the view cannot be armed', async () => {
  const { seen } = await startSkipping({ armed: false });
  assert.equal(seen.armOptions.length, 1);
  assert.deepEqual(seen.inputs, []);
});

test('the skipper does not press while the model is acting', async () => {
  const { seen } = await startSkipping({ acting: true });
  assert.equal(seen.scripts.length, 0, 'it does not even look');
  assert.equal(seen.armOptions.length, 0);
  assert.deepEqual(seen.inputs, []);
});

test('the skipper stops when ad blocking is turned off and on a page that is not a video site', async () => {
  const fixture = await startSkipping();
  fixture.extras.setAdBlock(false, 'user');
  fixture.seen.inputs.length = 0;
  fixture.timers.tick(10000);
  await fixture.flush();
  assert.deepEqual(fixture.seen.inputs, []);
  const other = makeExtras({ url: 'https://example.com/video' });
  other.state.hit = { x: 1, y: 1 };
  other.extras.place();
  other.emitAudible(true);
  other.timers.tick(5000);
  await other.flush();
  assert.equal(other.seen.scripts.length, 0);
});

test('dispose ends the skipper and detaches the audio listener', async () => {
  const fixture = await startSkipping();
  assert.equal(fixture.contents.listenerCount('audio-state-changed'), 1);
  fixture.extras.dispose();
  assert.equal(fixture.contents.listenerCount('audio-state-changed'), 0);
  const looked = fixture.seen.scripts.length;
  fixture.timers.tick(10000);
  await fixture.flush();
  assert.equal(fixture.seen.scripts.length, looked);
  fixture.extras.dispose();
});
