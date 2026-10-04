'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const figure = require('../renderer/inventory/artifact-figure');

test('figure escapes all text and attribute values and carries image identity', () => {
  const value = '<&"\'>';
  const labels = Object.fromEntries(['open', 'openAria', 'saveAs', 'copy', 'reveal', 'unavailable'].map((key) => [key, value]));
  const html = figure.renderFigure({ callId: value, artifactId: value, sessionId: value, imageKey: value,
    title: value, width: 1024, height: 768, src: value, meta: value, labels });
  assert.ok(!html.includes(value));
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('figure').dataset.artifactCallId, value);
  const img = doc.querySelector('img');
  assert.equal(img.dataset.invArtifactImageKey, value);
  assert.equal(img.alt, value);
  assert.equal(img.getAttribute('src'), value);
  assert.equal(img.getAttribute('width'), '1024');
  assert.equal(img.getAttribute('height'), '768');
  assert.equal(img.getAttribute('decoding'), 'async');
  assert.equal(doc.querySelector('.inv-artifact-figure-meta').textContent, value);
  assert.equal(doc.querySelector('.inv-artifact-figure-unavailable').textContent, value);
  for (const button of doc.querySelectorAll('button')) {
    assert.equal(button.type, 'button');
    assert.equal(button.dataset.artifactId, value);
    assert.equal(button.dataset.sessionId, value);
    assert.equal(button.dataset.artifactCallId, value);
    assert.equal(button.classList.contains('inv-artifact-figure-frame') ? button.getAttribute('aria-label') : button.textContent, value);
  }
  assert.deepEqual(Array.from(doc.querySelectorAll('button'), (button) => button.dataset.invArtifactAction), ['panel', 'panel', 'save-as', 'copy', 'reveal']);
});

test('figure omits absent source, invalid dimensions and empty meta and emits unavailable state', () => {
  const doc = new JSDOM(figure.renderFigure({ width: -1, height: 1.5, state: 'unavailable' })).window.document;
  const img = doc.querySelector('img');
  for (const name of ['src', 'width', 'height']) assert.equal(img.hasAttribute(name), false);
  assert.equal(doc.querySelector('.inv-artifact-figure-meta'), null);
  assert.equal(doc.querySelector('figure').dataset.invArtifactImageState, 'unavailable');
  assert.equal(new JSDOM(figure.renderFigure()).window.document.querySelector('figure').hasAttribute('data-inv-artifact-image-state'), false);
});

test('pending figure reserves default and custom aspect ratios and escapes its labels', () => {
  for (const [opts, ratio] of [[{}, '1 / 1'], [{ width: 0, height: 768 }, '1 / 1'], [{ width: 1024, height: 768 }, '1024 / 768']]) {
    const value = '<&"\'>';
    const html = figure.renderPendingFigure({ ...opts, labels: { title: value, note: value, cancel: value } });
    assert.ok(!html.includes(value));
    const doc = new JSDOM(html).window.document;
    assert.equal(doc.querySelector('[role="status"]').classList.contains('inv-artifact-figure--pending'), true);
    assert.equal(doc.querySelector('.inv-artifact-figure-placeholder').style.aspectRatio, ratio);
    assert.equal(doc.querySelector('.inv-artifact-figure-pending-title').textContent, value);
    assert.equal(doc.querySelector('.inv-artifact-figure-pending-note').textContent, value);
    assert.equal(doc.querySelector('[data-inv-image-cancel]').textContent, value);
  }
});
