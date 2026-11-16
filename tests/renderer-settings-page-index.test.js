'use strict';

// "On this page": the list of a Settings page's groups beside the content
// (renderer-settings-nav-utils.js createSettingsPageIndex).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSettingsPageIndex } = require('../renderer/shell/renderer-settings-nav-utils.js');

function group(title, extra = '') {
  return `<div class="settings-group" ${extra}><h4 class="settings-group-heading">${title}</h4><div class="settings-field"></div></div>`;
}

function setup(cardInner, cardClass = '') {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="settings-content-frame">
      <div class="settings-content-scroll">
        <section class="settings-card settings-section-active ${cardClass}" data-settings-section="tools">${cardInner}</section>
        <section class="settings-card" data-settings-section="home">${group('Home behavior')}</section>
      </div>
    </div></body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const scroller = doc.querySelector('.settings-content-scroll');
  const index = createSettingsPageIndex({
    scroller,
    getActiveCard: () => scroller.querySelector('.settings-card.settings-section-active'),
  });
  const nav = () => doc.querySelector('.settings-content-frame > .settings-page-index');
  const labels = () => [...nav().querySelectorAll('.settings-page-index-link')].map((link) => link.textContent);
  return { dom, doc, scroller, index, nav, labels };
}

/* jsdom has no layout: give each group a top so "current" and scrolling can be observed. */
function layout(ctx, tops) {
  const groups = [...ctx.doc.querySelectorAll('.settings-section-active .settings-group, .settings-section-active details.settings-fold')];
  groups.forEach((node, position) => {
    node.getBoundingClientRect = () => ({ top: tops[position] - ctx.scroller.scrollTop });
  });
  ctx.scroller.getBoundingClientRect = () => ({ top: 0 });
}

const nextFrame = (dom) => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));

test('a page with four groups lists them in order, outside the scroller', () => {
  const ctx = setup(group('Files and documents') + group('Knowledge folders') + group('Web') + group('Code and commands'));
  ctx.index.refresh();
  assert.ok(ctx.nav(), 'the list is a child of the content frame, so it does not scroll with the page');
  assert.equal(ctx.nav().hidden, false);
  assert.equal(ctx.nav().getAttribute('aria-label'), 'On this page');
  assert.deepEqual(ctx.labels(), ['Files and documents', 'Knowledge folders', 'Web', 'Code and commands']);
  assert.equal(ctx.nav().getAttribute('data-wide'), 'false');
  ctx.index.dispose();
  assert.equal(ctx.nav(), null, 'dispose removes the list');
});

test('a page with fewer than four groups has no list', () => {
  const ctx = setup(group('General') + group('Notify me when') + group('Content'));
  ctx.index.refresh();
  assert.equal(ctx.nav(), null);
});

test('hidden groups, nested groups and headingless groups are left out; a fold is listed without its count', () => {
  const ctx = setup(
    group('Theme')
    + group('Performance', 'hidden')
    + `<div class="settings-group"><h4 class="settings-group-heading">General</h4>${group('Cursor and text')}</div>`
    + '<div class="settings-group settings-group--wide"><div class="list"></div></div>'
    + group('Effects')
    + '<details class="settings-fold"><summary>Advanced<span class="settings-fold-count">2</span></summary></details>'
  );
  ctx.index.refresh();
  assert.deepEqual(ctx.labels(), ['Theme', 'General', 'Effects', 'Advanced']);
});

test('a wide page marks the list so the stylesheet places it beside the wide width', () => {
  const ctx = setup(group('Your models') + group('Cloud models') + group('Local only') + group('Engines'), 'settings-card--wide');
  ctx.index.refresh();
  assert.equal(ctx.nav().getAttribute('data-wide'), 'true');
});

test('the group at the top of the scroller is current, and scrolling moves it', () => {
  const ctx = setup(group('One') + group('Two') + group('Three') + group('Four'));
  layout(ctx, [0, 300, 600, 900]);
  ctx.index.refresh();
  const current = () => ctx.nav().querySelector('[aria-current="true"]').textContent;
  assert.equal(current(), 'One');
  ctx.scroller.scrollTop = 590;
  ctx.scroller.dispatchEvent(new ctx.dom.window.Event('scroll'));
  assert.equal(current(), 'Three');
});

test('a click scrolls to the group, focuses its heading and keeps it current until the person scrolls', () => {
  const ctx = setup(group('One') + group('Two') + group('Three') + group('Four'));
  layout(ctx, [0, 300, 600, 900]);
  ctx.index.refresh();
  const link = ctx.nav().querySelectorAll('.settings-page-index-link')[3];
  const click = new ctx.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'the link never changes the location');
  assert.equal(ctx.scroller.scrollTop, 892);
  const heading = ctx.doc.querySelectorAll('.settings-section-active .settings-group-heading')[3];
  assert.equal(ctx.doc.activeElement, heading);
  // The page is too short for the last group to reach the top: it stays current anyway.
  ctx.scroller.scrollTop = 500;
  ctx.scroller.dispatchEvent(new ctx.dom.window.Event('scroll'));
  assert.equal(ctx.nav().querySelector('[aria-current="true"]').textContent, 'Four');
  ctx.scroller.dispatchEvent(new ctx.dom.window.Event('wheel'));
  ctx.scroller.dispatchEvent(new ctx.dom.window.Event('scroll'));
  assert.equal(ctx.nav().querySelector('[aria-current="true"]').textContent, 'Two');
});

test('a click on a fold opens it', () => {
  const ctx = setup(group('One') + group('Two') + group('Three') + '<details class="settings-fold"><summary>Advanced</summary></details>');
  layout(ctx, [0, 300, 600, 900]);
  ctx.index.refresh();
  ctx.nav().querySelectorAll('.settings-page-index-link')[3].dispatchEvent(new ctx.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ctx.doc.querySelector('details.settings-fold').open, true);
});

test('a page that renders its groups late is picked up, and the list goes when the page changes', async () => {
  const ctx = setup(group('One') + group('Two'));
  ctx.index.refresh();
  assert.equal(ctx.nav(), null);
  const card = ctx.doc.querySelector('.settings-section-active');
  card.insertAdjacentHTML('beforeend', group('Three') + group('Four'));
  await nextFrame(ctx.dom);
  await nextFrame(ctx.dom);
  assert.deepEqual(ctx.labels(), ['One', 'Two', 'Three', 'Four']);
  card.classList.remove('settings-section-active');
  ctx.doc.querySelector('[data-settings-section="home"]').classList.add('settings-section-active');
  ctx.index.refresh();
  assert.equal(ctx.nav().hidden, true);
});
