'use strict';

// The browser panel's own controls (row 117): back, forward, reload, the address, find, More and site info.

const test = require('node:test');
const assert = require('node:assert/strict');

const { settle, openPage, closedPage, setup, withOpenPanel } = require('./helpers/browser-use-panel-harness');

const flushTimers = (ctx) => ctx.timers.splice(0).forEach((fn) => fn());

test('the buttons follow the page and name it to the main process', async () => {
  const ctx = await withOpenPanel(openPage({ can_back: true, loading: true }));
  assert.equal(ctx.action('nav-back').disabled, false);
  assert.equal(ctx.action('nav-forward').disabled, true);
  assert.equal(ctx.action('nav-reload').getAttribute('aria-label'), 'Stop loading');
  ctx.action('nav-reload').click();
  ctx.action('nav-back').click();
  await settle();
  assert.deepEqual(ctx.named('navigate').map((call) => call[1].op), ['stop', 'back']);
  ctx.changed(openPage({ loading: false }));
  assert.equal(ctx.action('nav-reload').getAttribute('aria-label'), 'Reload');
});

test('the address shows the site apart from the rest, and marks a page that is not encrypted', async () => {
  const ctx = await withOpenPanel();
  assert.equal(ctx.doc.querySelector('.bu-url b').textContent, 'shop.example');
  assert.equal(ctx.doc.querySelector('.bu-url span').textContent, '/cart');
  ctx.changed(openPage({ url: 'http://plain.example/' }));
  assert.equal(ctx.doc.querySelector('.bu-lock').dataset.insecure, 'true');
});

test('a page still arriving shows where it is going, and a failed one shows what failed', async () => {
  const ctx = await withOpenPanel(openPage({ pending_url: 'https://next.example/a' }));
  assert.equal(ctx.doc.querySelector('.bu-url b').textContent, 'next.example');
  ctx.changed(openPage({ failed: 'https://gone.example/' }));
  assert.equal(ctx.doc.querySelector('.bu-url b').textContent, 'gone.example');
});

test('typing an address goes there, Escape puts the old one back, and a refusal is said out loud', async () => {
  const ctx = await withOpenPanel();
  ctx.action('edit-address').click();
  const input = ctx.doc.querySelector('.bu-bar input');
  assert.equal(input.value, 'https://shop.example/cart');
  assert.equal(ctx.doc.activeElement, input);
  ctx.key(input, 'Escape');
  assert.equal(ctx.visible('.bu-address-field'), false);
  assert.equal(ctx.named('navigate').length, 0);

  ctx.action('edit-address').click();
  input.value = 'other.example';
  ctx.answers.navigate = { ok: false, reason: 'not_address' };
  ctx.key(input, 'Enter');
  await settle();
  assert.deepEqual(ctx.named('navigate'), [['navigate', { session_id: 's1', url: 'other.example' }]]);
  assert.equal(ctx.statusText(), 'Type a full web address.');
  flushTimers(ctx);
  assert.equal(ctx.statusText(), 'Cart');
});

test('a page push never rewrites an address being typed', async () => {
  const ctx = await withOpenPanel();
  ctx.action('edit-address').click();
  const input = ctx.doc.querySelector('.bu-bar input');
  input.value = 'half-typ';
  ctx.changed(openPage({ url: 'https://elsewhere.example/' }));
  assert.equal(input.value, 'half-typ');
});

test('Ctrl+L and Ctrl+F from inside the page land in the panel', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(openPage({ command: 'focus_address' }));
  assert.equal(ctx.doc.activeElement, ctx.doc.querySelector('.bu-bar input'));
  ctx.changed(openPage({ command: 'open_find' }));
  assert.equal(ctx.doc.activeElement, ctx.doc.querySelector('.bu-find input'));
});

test('find runs in the line: typing searches, Enter walks the matches, Escape ends it', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(openPage({ command: 'open_find' }));
  assert.equal(ctx.visible('.bu-find'), true);
  const input = ctx.doc.querySelector('.bu-find input');
  input.value = 'cart';
  input.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  flushTimers(ctx);
  ctx.key(input, 'Enter');
  ctx.key(input, 'Enter', { shiftKey: true });
  await settle();
  assert.deepEqual(ctx.named('find').map((call) => [call[1].next, call[1].forward]), [[false, true], [true, true], [true, false]]);
  ctx.changed(openPage({ find: { ordinal: 2, total: 5 } }));
  assert.equal(ctx.doc.querySelector('.bu-find-count').textContent, '2 of 5');
  ctx.key(input, 'Escape');
  await settle();
  assert.equal(ctx.visible('.bu-find'), false);
  assert.equal(ctx.named('stopFind').length, 1);
});

test('More holds zoom and the way to end the page', async () => {
  const ctx = await withOpenPanel(openPage({ zoom: 1.25 }));
  ctx.action('more').click();
  const pop = ctx.doc.querySelector('.bu-pop-more');
  assert.equal(pop.hidden, false);
  assert.equal(pop.querySelector('.bu-zoom-value').textContent, '125%');
  ctx.action('zoom-in').click();
  ctx.action('forget').click();
  await settle();
  assert.deepEqual(ctx.named('zoom'), [['zoom', { session_id: 's1', change: 'in' }]]);
  assert.equal(ctx.named('close').length, 1);
  assert.equal(pop.hidden, true);
});

test('the lock explains the page and takes a site back', async () => {
  const ctx = await withOpenPanel();
  ctx.answers.siteInfo = { ok: true, sites: ['<b>other.example</b>'] };
  ctx.doc.querySelector('.bu-lock').click();
  await settle();
  const pop = ctx.doc.querySelector('.bu-pop-site');
  assert.equal(pop.hidden, false);
  assert.match(pop.textContent, /encrypted/u);
  assert.equal(pop.querySelector('b'), null, 'a site name stays text');
  ctx.action('remove-site').click();
  await settle();
  assert.deepEqual(ctx.named('removeSite'), [['removeSite', { session_id: 's1', site: '<b>other.example</b>' }]]);
});

test('a failed page takes the view away and Try again goes back to the address', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(openPage({ url: '', failed: 'https://gone.example/' }));
  assert.equal(ctx.visible('.bu-message'), true);
  ctx.action('retry').click();
  await settle();
  assert.deepEqual(ctx.named('navigate'), [['navigate', { session_id: 's1', url: 'https://gone.example/' }]]);
});

test('a page that closed can be opened again from its last address', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(closedPage({ closed_reason: 'idle' }));
  assert.match(ctx.doc.querySelector('.bu-message strong').textContent, /sitting unused/u);
  assert.equal(ctx.doc.querySelector('.bu-url b').textContent, 'shop.example');
  ctx.action('retry').click();
  await settle();
  assert.deepEqual(ctx.named('navigate'), [['navigate', { session_id: 's1', url: 'https://shop.example/cart' }]]);
});

test('Close this page and forget it leaves nothing to reopen', async () => {
  const ctx = await withOpenPanel();
  ctx.action('more').click();
  ctx.action('forget').click();
  await settle();
  ctx.changed(closedPage({ closed_reason: 'user' }));
  await settle();
  assert.equal(ctx.named('close').length, 1);
  assert.equal(ctx.doc.querySelector('.bu-url b').textContent, 'Type an address');
  assert.equal(ctx.visible('[data-browser-use-action="retry"]'), false);
});

test('leaving the panel with find open clears the highlights in that chat', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(openPage({ command: 'open_find' }));
  ctx.panel.dispose();
  await settle();
  assert.deepEqual(ctx.named('stopFind'), [['stopFind', { session_id: 's1' }]]);
});

test('Tell Jenny to continue appears when a used turn stopped short and sends one message', async () => {
  const ctx = await withOpenPanel();
  ctx.streaming = true;
  ctx.changed(openPage({ busy: true, action: 'read' }));
  ctx.streaming = false;
  ctx.changed(openPage());
  assert.equal(ctx.visible(ctx.line('continue')), false, 'not offered unless the page was used by hand');
  ctx.changed(openPage({ user_touched: true }));
  assert.equal(ctx.visible(ctx.line('continue')), false, 'a task that finished has nothing to continue');
  ctx.changed(openPage({ user_touched: true, stopped_short: true }));
  assert.equal(ctx.visible(ctx.line('continue')), true);
  ctx.doc.querySelector(ctx.line('continue')).click();
  assert.deepEqual(ctx.sent, [["I'm done with the page. Please continue.", 's1']]);
  assert.equal(ctx.visible(ctx.line('continue')), false);
});

test('a saved file can be shown from the line', async () => {
  const ctx = await withOpenPanel(openPage({ note: { kind: 'saved', file: 'a.pdf' } }));
  ctx.doc.querySelector(ctx.line('show-download')).click();
  await settle();
  assert.equal(ctx.named('revealDownload').length, 1);
});

test('the Artifacts list comes back if the page took its column and is then closed by hand', async () => {
  const ctx = setup();
  await ctx.sync(true);
  ctx.showRail('artifact');
  ctx.changed(openPage());
  await settle();
  ctx.doc.getElementById('artifactReviewCollapseButton').click();
  ctx.panelEl.classList.add('hidden');
  await settle();
  assert.deepEqual(ctx.opens.at(-1), ['artifact', { focus: false }]);
});

test('a panel opened on an empty column closes to nothing', async () => {
  const ctx = await withOpenPanel();
  ctx.doc.getElementById('artifactReviewCollapseButton').click();
  ctx.panelEl.classList.add('hidden');
  await settle();
  assert.equal(ctx.opens.length, 1);
});

test('the page learns the panel background and the menu words once', async () => {
  const ctx = await withOpenPanel();
  ctx.panel.renderRailContent(ctx.surface);
  await settle();
  const calls = ctx.named('configure');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].background, '#141516');
  assert.equal(calls[0][1].labels.copyLink, 'Copy link address');
});

const adSwitch = (ctx) => ctx.doc.querySelector('.bu-pop-more .bu-menu-switch [role="switch"]');
const adNoteText = (ctx) => ctx.doc.querySelector('.bu-pop-more .bu-menu-note').textContent;
const withAdBridge = (ctx, answer = { ok: true }) => {
  ctx.windowRef.jennyShell.browserUse.setAdBlock = (payload) => {
    ctx.calls.push(['setAdBlock', payload]);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
};

test('More shows the ad switch from the page state, with the note that goes with it', async () => {
  const ctx = await withOpenPanel(openPage({ ad_block: true }));
  ctx.action('more').click();
  assert.equal(adSwitch(ctx).getAttribute('aria-checked'), 'true');
  assert.match(ctx.doc.querySelector('.bu-menu-switch').textContent, /Block ads/u);
  assert.equal(adSwitch(ctx).getAttribute('aria-labelledby'), ctx.doc.querySelector('.bu-menu-switch span').id);
  assert.match(adNoteText(ctx), /presses Skip/u);

  const off = await withOpenPanel(openPage({ ad_block: false, ad_block_by: 'user' }));
  off.action('more').click();
  assert.equal(adSwitch(off).getAttribute('aria-checked'), 'false');
  assert.match(adNoteText(off), /Off for this chat/u);
});

test('a page that does not say reads as ad blocking on', async () => {
  const ctx = await withOpenPanel(openPage());
  ctx.action('more').click();
  assert.equal(adSwitch(ctx).getAttribute('aria-checked'), 'true');
});

test('the switch asks for the opposite for this chat, and the open menu follows the new state', async () => {
  const ctx = await withOpenPanel(openPage({ ad_block: true }));
  withAdBridge(ctx);
  ctx.action('more').click();
  adSwitch(ctx).click();
  await settle();
  assert.deepEqual(ctx.named('setAdBlock'), [['setAdBlock', { session_id: 's1', enabled: false }]]);
  const pop = ctx.doc.querySelector('.bu-pop-more');
  assert.equal(pop.hidden, false, 'the menu stays open');
  ctx.changed(openPage({ ad_block: false, ad_block_by: 'user' }));
  assert.equal(adSwitch(ctx).getAttribute('aria-checked'), 'false');
  assert.match(adNoteText(ctx), /Off for this chat/u);
  assert.equal(pop.hidden, false);
  adSwitch(ctx).click();
  await settle();
  assert.deepEqual(ctx.named('setAdBlock').at(-1), ['setAdBlock', { session_id: 's1', enabled: true }]);
});

test('a refused or failed ad switch stays where the page says it is', async () => {
  for (const answer of [new Error('gone'), { ok: false, reason: 'no_page' }]) {
    const ctx = await withOpenPanel(openPage());
    withAdBridge(ctx, answer);
    ctx.action('more').click();
    adSwitch(ctx).click();
    await settle();
    assert.equal(adSwitch(ctx).getAttribute('aria-checked'), 'true');
  }
});
