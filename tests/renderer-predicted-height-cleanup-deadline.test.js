'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createFakeTimers } = require('./helpers/fake-timers');
const {
  createArticleMarkupPipeline,
} = require('../renderer/chat/renderer-render-pipeline-article-markup');

test('predicted-height cleanup keeps a hard deadline under per-frame scheduling churn', (t) => {
  const previousWindow = global.window;
  const dom = new JSDOM('<!doctype html><div id="timeline"></div>');
  const timers = createFakeTimers();
  const frameCallbacks = [];
  let nextFrameId = 1;

  t.after(() => {
    global.window = previousWindow;
    dom.window.close();
  });

  global.window = {
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return nextFrameId++;
    },
    cancelAnimationFrame() {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };

  const timeline = dom.window.document.getElementById('timeline');
  const article = dom.window.document.createElement('article');
  article.dataset.predictedHeight = '4200';
  article.style.minHeight = '4200px';
  timeline.appendChild(article);
  const pipeline = createArticleMarkupPipeline({ dom: { chatTimeline: timeline } });
  let firstClearedAt = null;

  for (let frame = 0; frame < 20; frame += 1) {
    pipeline.schedulePredictedHeightCleanup();
    timers.tick(16);
    if (firstClearedAt === null && article.style.minHeight === '') {
      firstClearedAt = timers.now();
    }
  }

  assert.equal(frameCallbacks.length, 20, 'animation-frame callbacks remain pending');
  assert.equal(firstClearedAt, 48, 'cleanup fires within 48ms of the first schedule call');
  assert.equal(article.style.minHeight, '');
});
