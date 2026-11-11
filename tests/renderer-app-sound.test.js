'use strict';

// Browser sound (row 119): the title-bar speaker, the chat-row speaker and the signature the chats panel keys on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const appSoundModule = require('../renderer/shell/renderer-app-sound');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const idle = { muted: false, audible: false, chats: {} };

function setup({ initial = { ok: true, ...idle }, withBridge = true, reject = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="titlebar-status"><button id="titlebarPalettePill"></button></div><ul id="rows"></ul></body>');
  const calls = [];
  const bridge = { pushed: null };
  const answer = (name, value) => (payload) => {
    calls.push([name, payload]);
    return reject ? Promise.reject(new Error('bridge down')) : Promise.resolve(value);
  };
  const root = {
    document: dom.window.document,
    inventoryActionButton: actionButton,
    jennyShell: withBridge ? {
      appSound: {
        getState: answer('getState', initial),
        setMuted: answer('setMuted', { ok: true }),
        onChanged: (fn) => { bridge.pushed = fn; return () => {}; },
      },
      browserUse: { toggleSound: answer('toggleSound', { ok: true }) },
    } : {},
  };
  const sound = appSoundModule.create(root);
  const doc = dom.window.document;
  const api = {
    doc, calls, sound, bridge,
    button: () => doc.getElementById('titlebarSoundButton'),
    push: (state) => bridge.pushed(state),
    rows: (sessions) => { doc.getElementById('rows').innerHTML = sessions.map((s) => sound.rowMarkup(s)).join(''); return doc.querySelectorAll('.session-row__sound'); },
  };
  return api;
}

test('the title-bar button is built before the palette pill and stays hidden while nothing makes sound', async () => {
  const ctx = setup();
  await settle();
  const button = ctx.button();
  assert.ok(button.classList.contains('titlebar-icon-button'));
  assert.equal(button.nextElementSibling.id, 'titlebarPalettePill');
  assert.ok(button.classList.contains('hidden'));
  assert.equal(button.querySelector('svg').getAttribute('class'), 'titlebar-icon');
  assert.equal(button.dataset.muted, 'false');
});

test('it shows while audible, and stays after Jenny is muted with nothing playing', async () => {
  const ctx = setup({ initial: { ok: true, muted: false, audible: true, chats: { s1: 'playing' } } });
  await settle();
  const button = ctx.button();
  assert.equal(button.classList.contains('hidden'), false);
  ctx.push({ muted: true, audible: false, chats: {} });
  assert.equal(button.classList.contains('hidden'), false);
  ctx.push({ muted: false, audible: false, chats: {} });
  assert.equal(button.classList.contains('hidden'), true);
  assert.equal(ctx.button(), button);
});

test('a click sends the opposite, and data-muted, the title and the icon follow the state in place', async () => {
  const ctx = setup({ initial: { ok: true, muted: false, audible: true, chats: {} } });
  await settle();
  const button = ctx.button();
  assert.equal(button.title, 'Mute Jenny');
  assert.equal(button.getAttribute('aria-label'), 'Mute Jenny');
  const onIcon = button.innerHTML;
  button.click();
  ctx.push({ muted: true, audible: false, chats: {} });
  button.click();
  await settle();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'setMuted').map((c) => c[1]), [{ muted: true }, { muted: false }]);
  assert.equal(button.dataset.muted, 'true');
  assert.equal(button.title, 'Unmute Jenny');
  assert.equal(button.getAttribute('aria-label'), 'Unmute Jenny');
  assert.notEqual(button.innerHTML, onIcon);
  assert.equal(ctx.button(), button);
});

test('a row speaker exists only for a chat with sound and names what a click does', async () => {
  const ctx = setup({ initial: { ok: true, muted: false, audible: true, chats: { a: 'playing', b: 'muted' } } });
  await settle();
  assert.equal(ctx.sound.rowMarkup({ id: 'c' }), '');
  assert.equal(ctx.sound.rowMarkup(null), '');
  const [playing, muted] = ctx.rows([{ id: 'a' }, { id: 'b' }]);
  assert.equal(playing.dataset.sessionSound, 'a');
  assert.equal(playing.title, 'Mute this chat');
  assert.equal(playing.getAttribute('aria-label'), 'Mute this chat');
  assert.equal(muted.title, 'Unmute this chat');
  assert.notEqual(playing.innerHTML, muted.innerHTML);
  assert.match(playing.innerHTML, /viewBox="0 0 20 20"/u);
  assert.equal(playing.disabled, false);
});

test('row speakers are disabled and say why while Jenny is muted', async () => {
  const ctx = setup({ initial: { ok: true, muted: true, audible: false, chats: { a: 'playing' } } });
  await settle();
  const [row] = ctx.rows([{ id: 'a' }]);
  assert.equal(row.disabled, true);
  assert.equal(row.title, 'Jenny is muted');
  assert.equal(row.getAttribute('aria-label'), 'Jenny is muted');
});

test('clicking a row speaker toggles that chat; a disabled one does nothing', async () => {
  const ctx = setup({ initial: { ok: true, muted: false, audible: true, chats: { a: 'playing' } } });
  await settle();
  ctx.rows([{ id: 'a' }])[0].querySelector('svg').dispatchEvent(new ctx.doc.defaultView.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'toggleSound'), [['toggleSound', { session_id: 'a' }]]);

  ctx.push({ muted: true, audible: false, chats: { a: 'playing' } });
  ctx.rows([{ id: 'a' }])[0].click();
  await settle();
  assert.equal(ctx.calls.filter((c) => c[0] === 'toggleSound').length, 1);
});

test('the row markup moves with the chat sound and the app mute, and silent chats stay still', async () => {
  const ctx = setup();
  await settle();
  const quiet = ctx.sound.rowMarkup({ id: 'a' });
  ctx.push({ muted: false, audible: true, chats: { a: 'playing' } });
  const playing = ctx.sound.rowMarkup({ id: 'a' });
  ctx.push({ muted: false, audible: true, chats: { a: 'muted' } });
  const chatMuted = ctx.sound.rowMarkup({ id: 'a' });
  ctx.push({ muted: true, audible: false, chats: { a: 'muted' } });
  const appMuted = ctx.sound.rowMarkup({ id: 'a' });
  assert.equal(new Set([quiet, playing, chatMuted, appMuted]).size, 4);
  assert.equal(ctx.sound.rowMarkup({ id: 'other' }), '');
});

test('onChatsChanged fires on a real change only', async () => {
  const ctx = setup();
  await settle();
  let fired = 0;
  ctx.sound.onChatsChanged(() => { fired += 1; });
  ctx.push({ muted: false, audible: true, chats: { a: 'playing' } });
  assert.equal(fired, 1);
  ctx.push({ muted: false, audible: true, chats: { a: 'playing' } });
  assert.equal(fired, 1);
  ctx.push({ muted: true, audible: true, chats: { a: 'playing' } });
  assert.equal(fired, 2);
  ctx.push({ muted: true, audible: true, chats: { a: 'muted' } });
  assert.equal(fired, 3);
});

test('a chat id of __proto__ is data, and inherited names are not chats', async () => {
  const ctx = setup();
  await settle();
  ctx.push(JSON.parse('{"muted":false,"audible":true,"chats":{"__proto__":"playing"}}'));
  assert.equal(ctx.sound.chatSound('__proto__'), 'playing');
  assert.equal(ctx.sound.chatSound('constructor'), '');
  assert.equal(ctx.sound.chatSound('toString'), '');
  assert.equal(Object.prototype.playing, undefined);
  const [row] = ctx.rows([{ id: '__proto__' }]);
  assert.equal(row.dataset.sessionSound, '__proto__');
  row.click();
  await settle();
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'toggleSound'), [['toggleSound', { session_id: '__proto__' }]]);
});

test('an id with markup characters is escaped in the row', async () => {
  const ctx = setup();
  await settle();
  const id = '"><img src=x onerror=1>';
  ctx.push({ muted: false, audible: true, chats: { [id]: 'playing' } });
  const [row] = ctx.rows([{ id }]);
  assert.equal(ctx.doc.querySelectorAll('img').length, 0);
  assert.equal(row.dataset.sessionSound, id);
});

test('a rejecting bridge never throws', async () => {
  const unhandled = [];
  const onRejection = (error) => unhandled.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    const ctx = setup({ reject: true });
    await settle();
    ctx.button().click();
    ctx.push({ muted: false, audible: true, chats: { a: 'playing' } });
    ctx.rows([{ id: 'a' }])[0].click();
    await settle();
    await settle();
    assert.deepEqual(unhandled, []);
    assert.ok(ctx.calls.some((c) => c[0] === 'toggleSound'));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a push that lands before the first read finishes is not overwritten by it', async () => {
  const ctx = setup({ initial: { ok: true, ...idle } });
  ctx.push({ muted: false, audible: true, chats: { a: 'playing' } });
  await settle();
  assert.equal(ctx.sound.chatSound('a'), 'playing');
  assert.equal(ctx.button().classList.contains('hidden'), false);
});

test('without jennyShell.appSound the script stays inert', () => {
  const ctx = setup({ withBridge: false });
  assert.equal(ctx.button(), null);
  assert.equal(ctx.sound.rowMarkup({ id: 'a' }), '');
  assert.equal(ctx.sound.chatSound('a'), '');
  assert.doesNotThrow(() => ctx.sound.onChatsChanged(() => {}));
  assert.equal(appSoundModule.rowMarkup({ id: 'a' }), '');
});
