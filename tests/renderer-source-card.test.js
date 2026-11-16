'use strict';

// new-test-file: renderer-source-card.js is a new surface (the source hover card and list toggle controller).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

globalThis.inventoryActionButton = require('../renderer/inventory/action-button');
const { createSourceCardController } = require('../renderer/chat/renderer-source-card');

const HIDE_MS = 15;
const COPIED_MS = 15;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function inlineLink(ref, extra) {
  const o = Object.assign({ url: 'https://example.com/a', title: 'Example title', site: 'example.com', snippet: 'A short snippet.' }, extra);
  return `<a class="source-ref-link" href="${o.url}" target="_blank" rel="noopener noreferrer" data-source-ref="${ref}"`
    + ` data-source-url="${o.url}" data-source-title="${o.title}" data-source-site="${o.site}"`
    + ` data-source-snippet="${o.snippet}" data-source-kind="" aria-label="Source ${ref}">${ref}</a>`;
}

function listItem(ref, title, extra) {
  const o = Object.assign({ url: 'https://example.com/a', site: 'example.com', snippet: 'A short snippet.' }, extra);
  return `<li class="source-list-item" data-source-ref="${ref}"><span class="source-list-num">${ref}</span>`
    + `<span class="source-list-body"><a class="source-list-title" href="${o.url}" target="_blank" rel="noopener noreferrer"`
    + ` data-source-ref="${ref}" data-source-url="${o.url}" data-source-title="${title}" data-source-site="${o.site}"`
    + ` data-source-snippet="${o.snippet}" data-source-kind="">${title}</a></span></li>`;
}

function setup(options = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="chatTimeline">
    <article id="turn1">
      <p>Claim<sup class="source-ref">${inlineLink('1')}</sup> and more<sup class="source-ref">${inlineLink('2', { url: 'https://example.org/b', title: 'Other', snippet: '' })}</sup>.</p>
      <section class="source-list" data-source-list-turn="turn-1">
        <ol class="source-list-cited">${listItem('1', 'Example title')}${listItem('2', 'Other', { url: 'https://example.org/b' })}</ol>
        <button type="button" class="source-list-toggle" data-source-list-toggle="turn-1" aria-expanded="false" aria-controls="also-1">Also searched 1 more</button>
        <ul class="source-list-also" id="also-1" hidden>${listItem('', 'Extra', { url: 'https://example.net/c' })}</ul>
      </section>
    </article>
    <article id="turn2"><sup class="source-ref">${inlineLink('1', { url: 'https://example.net/z', title: 'Z' })}</sup>
      <section class="source-list"><ol class="source-list-cited">${listItem('1', 'Z', { url: 'https://example.net/z' })}</ol></section></article>
  </div></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const root = document.getElementById('chatTimeline');
  const writes = [];
  const openCalls = [];
  const chipsUtils = { setSourceListOpen: (turn, open) => openCalls.push([turn, open]) };
  const controller = createSourceCardController({
    root,
    document,
    window,
    chipsUtils,
    hideDelayMs: HIDE_MS,
    copiedMs: COPIED_MS,
    clipboardWriteText: options.clipboardWriteText || (async (text) => { writes.push(text); }),
  });
  return { dom, window, document, root, controller, writes, openCalls };
}

function pointer(window, type, target, init = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType || 'mouse' });
  if (init.relatedTarget !== undefined) Object.defineProperty(event, 'relatedTarget', { value: init.relatedTarget });
  target.dispatchEvent(event);
  return event;
}

const cardOf = (document) => document.getElementById('chatSourceCard');
const isShown = (document) => Boolean(cardOf(document)?.classList.contains('is-open'));

test('mouse pointerover shows the card with title, site and snippet', () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelector('#turn1 .source-ref-link');
  pointer(window, 'pointerover', link);
  const card = cardOf(document);
  assert.ok(card, 'card exists');
  assert.equal(card.getAttribute('role'), 'tooltip');
  assert.equal(card.parentNode, document.body);
  assert.equal(card.querySelector('.source-card-title').textContent, 'Example title');
  assert.equal(card.querySelector('.source-card-site').textContent, 'example.com');
  assert.equal(card.querySelector('.source-card-snippet').textContent, 'A short snippet.');
  const open = card.querySelector('.source-card-actions a');
  assert.equal(open.getAttribute('href'), 'https://example.com/a');
  assert.equal(open.getAttribute('target'), '_blank');
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(open.textContent, 'Open in browser');
  assert.equal(card.querySelector('.source-card-actions button').textContent, 'Copy link');
  assert.equal(link.getAttribute('aria-describedby'), 'chatSourceCard');
  controller.dispose();
});

test('an empty snippet omits the snippet line and an empty title falls back to the site', () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelectorAll('#turn1 .source-ref-link')[1];
  pointer(window, 'pointerover', link);
  assert.equal(cardOf(document).querySelector('.source-card-snippet'), null);
  link.setAttribute('data-source-title', '');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pointer(window, 'pointerover', link);
  assert.equal(cardOf(document).querySelector('.source-card-title').textContent, 'example.com');
  controller.dispose();
});

test('touch pointerover shows nothing', () => {
  const { window, document, root, controller } = setup();
  pointer(window, 'pointerover', root.querySelector('.source-ref-link'), { pointerType: 'touch' });
  assert.equal(isShown(document), false);
  controller.dispose();
});

test('focusin shows the card and sets aria-describedby; focusout hides it', () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelector('.source-list-title');
  link.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  assert.equal(isShown(document), true);
  assert.equal(link.getAttribute('aria-describedby'), 'chatSourceCard');
  const out = new window.Event('focusout', { bubbles: true });
  Object.defineProperty(out, 'relatedTarget', { value: null });
  link.dispatchEvent(out);
  assert.equal(isShown(document), false);
  assert.equal(link.hasAttribute('aria-describedby'), false);
  controller.dispose();
});

test('the card hides after the delay once the pointer leaves, and entering the card cancels it', async () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelector('.source-ref-link');
  pointer(window, 'pointerover', link);
  pointer(window, 'pointerout', link, { relatedTarget: document.body });
  assert.equal(isShown(document), true, 'still shown right after leaving');
  pointer(window, 'pointerover', cardOf(document).querySelector('.source-card-title'));
  await wait(HIDE_MS * 3);
  assert.equal(isShown(document), true, 'entering the card cancelled the timer');
  pointer(window, 'pointerout', cardOf(document), { relatedTarget: document.body });
  await wait(HIDE_MS * 3);
  assert.equal(isShown(document), false);
  assert.equal(link.hasAttribute('aria-describedby'), false);
  controller.dispose();
});

test('Escape hides the card; a scroll inside the root hides it unless it comes right after show', async () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelector('.source-ref-link');
  pointer(window, 'pointerover', link);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(isShown(document), false);
  pointer(window, 'pointerover', link);
  assert.equal(isShown(document), true);
  // Focus scrolling the link into view fires a scroll right after show: the card stays.
  root.querySelector('#turn1').dispatchEvent(new window.Event('scroll', { bubbles: false }));
  assert.equal(isShown(document), true);
  await wait(170);
  root.querySelector('#turn1').dispatchEvent(new window.Event('scroll', { bubbles: false }));
  assert.equal(isShown(document), false);
  controller.dispose();
});

test('the matching list entry is lit while an inline number shows its card', () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelector('#turn1 .source-ref-link');
  const item1 = root.querySelector('#turn1 .source-list-item[data-source-ref="1"]');
  const item2 = root.querySelector('#turn1 .source-list-item[data-source-ref="2"]');
  const otherTurn = root.querySelector('#turn2 .source-list-item[data-source-ref="1"]');
  pointer(window, 'pointerover', link);
  assert.equal(item1.classList.contains('is-lit'), true);
  assert.equal(item2.classList.contains('is-lit'), false);
  assert.equal(otherTurn.classList.contains('is-lit'), false);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(item1.classList.contains('is-lit'), false);
  // A list title does not light anything.
  pointer(window, 'pointerover', root.querySelector('#turn1 .source-list-title'));
  assert.equal(root.querySelectorAll('.is-lit').length, 0);
  controller.dispose();
});

test('a hostile title renders as text and a non-http url never shows a card', () => {
  const { window, document, root, controller } = setup();
  const link = root.querySelector('.source-ref-link');
  link.setAttribute('data-source-title', '<img src=x onerror=1>');
  pointer(window, 'pointerover', link);
  const card = cardOf(document);
  assert.equal(card.querySelector('.source-card-title').textContent, '<img src=x onerror=1>');
  assert.equal(card.querySelector('img'), null);
  pointer(window, 'pointerout', link, { relatedTarget: document.body });
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  link.setAttribute('data-source-url', 'javascript:alert(1)');
  pointer(window, 'pointerover', link);
  assert.equal(isShown(document), false);
  controller.dispose();
});

test('Copy link writes the url, shows Copied, then reverts', async () => {
  const { window, document, root, controller, writes } = setup();
  pointer(window, 'pointerover', root.querySelector('.source-ref-link'));
  const copy = cardOf(document).querySelector('.source-card-actions button');
  copy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(2);
  assert.deepEqual(writes, ['https://example.com/a']);
  assert.equal(copy.textContent, 'Copied');
  await wait(COPIED_MS * 3);
  assert.equal(copy.textContent, 'Copy link');
  controller.dispose();
});

test('a failed clipboard write is swallowed and the label stays', async () => {
  const { window, document, root, controller } = setup({ clipboardWriteText: async () => { throw new Error('denied'); } });
  pointer(window, 'pointerover', root.querySelector('.source-ref-link'));
  const copy = cardOf(document).querySelector('.source-card-actions button');
  copy.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(2);
  assert.equal(copy.textContent, 'Copy link');
  controller.dispose();
});

test('the Also searched toggle flips hidden and aria-expanded and reports the open state', () => {
  const { window, root, controller, openCalls } = setup();
  const toggle = root.querySelector('[data-source-list-toggle]');
  const also = root.querySelector('#also-1');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(also.hidden, false);
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(also.hidden, true);
  assert.deepEqual(openCalls, [['turn-1', true], ['turn-1', false]]);
  controller.dispose();
});

test('dispose removes the card, the attributes it set and every listener', () => {
  const { window, document, root, controller, openCalls } = setup();
  const link = root.querySelector('#turn1 .source-ref-link');
  pointer(window, 'pointerover', link);
  assert.ok(cardOf(document));
  controller.dispose();
  assert.equal(cardOf(document), null);
  assert.equal(link.hasAttribute('aria-describedby'), false);
  assert.equal(root.querySelectorAll('.is-lit').length, 0);
  pointer(window, 'pointerover', link);
  link.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  assert.equal(cardOf(document), null);
  root.querySelector('[data-source-list-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(openCalls, []);
  assert.equal(root.querySelector('#also-1').hidden, true);
});
