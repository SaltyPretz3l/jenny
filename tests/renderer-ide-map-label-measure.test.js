'use strict';

/* tests/renderer-ide-map-label-measure.test.js - coverage for
 * renderer/features/renderer-ide-map-label-measure.js: the canvas label
 * measurer (jsdom estimator fallback, injected-context path with caching,
 * header weight, font-change invalidation, 5000-entry cap) and
 * buildAtlasLayoutOptions. jsdom directly; getContext is never called on a
 * real jsdom canvas. Dispose via t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createLabelMeasurer, buildAtlasLayoutOptions, CACHE_CAP,
} = require('../renderer/features/renderer-ide-map-label-measure');
const { estimateLabelWidth } = require('../renderer/features/renderer-ide-map-atlas-layout');
const { FIT_SCALE_MAX } = require('../renderer/features/renderer-ide-map-transform');

function setup() {
  const dom = new JSDOM('<div id="content"></div>');
  const contentEl = dom.window.document.getElementById('content');
  const fonts = { size: '12px', family: 'Inter', weight: '400', style: 'normal' };
  dom.window.getComputedStyle = () => ({
    fontSize: fonts.size, fontFamily: fonts.family, fontWeight: fonts.weight, fontStyle: fonts.style,
  });
  return { dom, contentEl, fonts };
}

function stubContext() {
  const ctx = {
    font: '',
    calls: [],
    measureText(text) {
      ctx.calls.push({ text, font: ctx.font });
      return { width: text.length * 6.2 };
    },
  };
  return ctx;
}

test('falls back to the estimator under jsdom and never touches getContext', () => {
  const { contentEl } = setup();
  let touched = false;
  const doc = contentEl.ownerDocument;
  const realCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    if (tag === 'canvas') touched = true;
    return realCreate(tag);
  };
  const measure = createLabelMeasurer(contentEl);
  assert.equal(measure('README.md', 'tile'), estimateLabelWidth('README.md'));
  assert.equal(measure('src', 'header'), estimateLabelWidth('src'));
  assert.equal(touched, false);
  measure.beginLayout();
  measure.dispose();
});

test('falls back when there is no document or the context is unusable', () => {
  const noDoc = createLabelMeasurer(null);
  assert.equal(noDoc('abc', 'tile'), estimateLabelWidth('abc'));
  const { contentEl } = setup();
  assert.equal(createLabelMeasurer(contentEl, { createContext: () => null })('abc', 'tile'), estimateLabelWidth('abc'));
  const throwing = createLabelMeasurer(contentEl, { createContext: () => { throw new Error('nope'); } });
  assert.equal(throwing('abc', 'tile'), estimateLabelWidth('abc'));
  const noMeasure = createLabelMeasurer(contentEl, { createContext: () => ({}) });
  assert.equal(noMeasure('abc', 'tile'), estimateLabelWidth('abc'));
});

test('measures through the context, caches per text+kind, header uses weight 500', () => {
  const { contentEl } = setup();
  const ctx = stubContext();
  const measure = createLabelMeasurer(contentEl, { createContext: () => ctx });
  assert.equal(measure('index.js', 'tile'), Math.ceil(8 * 6.2));
  assert.equal(measure('index.js', 'tile'), Math.ceil(8 * 6.2));
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].font, 'normal 400 12px Inter');
  measure('index.js', 'header');
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].font, 'normal 500 12px Inter');
  measure('index.js', 'header');
  assert.equal(ctx.calls.length, 2);
});

test('the probe is removed from the DOM after the font is read', () => {
  const { contentEl } = setup();
  const measure = createLabelMeasurer(contentEl, { createContext: stubContext });
  measure('a', 'tile');
  assert.equal(contentEl.children.length, 0);
});

test('beginLayout keeps the cache while the font is unchanged and drops it when it changes', () => {
  const { contentEl, fonts } = setup();
  const ctx = stubContext();
  const measure = createLabelMeasurer(contentEl, { createContext: () => ctx });
  measure('alpha', 'tile');
  measure.beginLayout();
  measure('alpha', 'tile');
  assert.equal(ctx.calls.length, 1);
  fonts.size = '14px';
  measure('alpha', 'tile');
  assert.equal(ctx.calls.length, 1, 'font is only re-read on beginLayout');
  measure.beginLayout();
  measure('alpha', 'tile');
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].font, 'normal 400 14px Inter');
});

test('an unreadable computed font falls back to the estimator', () => {
  const { dom, contentEl } = setup();
  dom.window.getComputedStyle = () => ({ fontSize: '', fontFamily: '' });
  const measure = createLabelMeasurer(contentEl, { createContext: stubContext });
  assert.equal(measure('abc', 'tile'), estimateLabelWidth('abc'));
});

test('the cache clears when it reaches the cap', () => {
  const { contentEl } = setup();
  const ctx = stubContext();
  const measure = createLabelMeasurer(contentEl, { createContext: () => ctx });
  assert.equal(CACHE_CAP, 5000);
  for (let i = 0; i < CACHE_CAP; i += 1) measure(`n${i}`, 'tile');
  assert.equal(ctx.calls.length, CACHE_CAP);
  measure('n0', 'tile');
  assert.equal(ctx.calls.length, CACHE_CAP, 'still cached at the cap');
  measure('overflow', 'tile');
  assert.equal(ctx.calls.length, CACHE_CAP + 1);
  measure('n0', 'tile');
  assert.equal(ctx.calls.length, CACHE_CAP + 2, 'cache was cleared when the cap was hit');
});

test('buildAtlasLayoutOptions derives aspect and availWidth from the viewport', () => {
  const measure = () => 1;
  const viewport = { getBoundingClientRect: () => ({ width: 1000, height: 500 }) };
  const opts = buildAtlasLayoutOptions(viewport, measure);
  assert.equal(opts.aspect, 2);
  assert.equal(opts.availWidth, (1000 * 0.9) / FIT_SCALE_MAX);
  assert.equal(opts.measureLabel, measure);
});

test('buildAtlasLayoutOptions starts a layout pass on the measurer', () => {
  let begun = 0;
  const measure = () => 1;
  measure.beginLayout = () => { begun += 1; };
  buildAtlasLayoutOptions({ clientWidth: 10, clientHeight: 10 }, measure);
  assert.equal(begun, 1);
});

test('buildAtlasLayoutOptions handles a 0x0 or missing viewport', () => {
  const zero = buildAtlasLayoutOptions({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }, null);
  assert.deepEqual(zero, { aspect: 0, availWidth: 0, measureLabel: null });
  assert.equal(buildAtlasLayoutOptions(null, null).aspect, 0);
  const sized = buildAtlasLayoutOptions({ clientWidth: 800, clientHeight: 400 }, null);
  assert.equal(sized.aspect, 2);
  const noHeight = buildAtlasLayoutOptions({ getBoundingClientRect: () => ({ width: 800, height: 0 }) }, null);
  assert.equal(noHeight.aspect, 0);
  assert.ok(noHeight.availWidth > 0);
});
