'use strict';

// renderer-render-pipeline-article-prediction.js: the height prediction and
// predicted-height cleanup of the article-markup pipeline, split out of
// renderer-render-pipeline-article-markup.js at its line cap. Contract: the
// turn prediction measures the row list it is handed (or builds one), passes
// the collapsed-body exclusions, and the cleanup and patch sync own the
// article's min-height.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createArticlePrediction } = require('../renderer/chat/renderer-render-pipeline-article-prediction');

function installPretext(t, calls) {
  const previous = globalThis.rendererPretextUtils;
  globalThis.rendererPretextUtils = {
    isEnabled: () => true,
    resolveDefaultFontString: () => '15px Test',
    resolveElementWidth: () => 0,
    predictHtmlContentHeight(cacheKey, html, font, maxWidth, lineHeight, options) {
      calls.push({ cacheKey, html, font, maxWidth, lineHeight, options });
      return { height: 100.2 };
    },
    predictTextHeight: () => ({ height: 0 }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.rendererPretextUtils;
    else globalThis.rendererPretextUtils = previous;
  });
}

test('the turn prediction measures the handed row list with the collapsed-body exclusions', (t) => {
  const calls = [];
  installPretext(t, calls);
  const built = [];
  const prediction = createArticlePrediction({
    buildTurnRowListMarkup: (rows, messages, options) => {
      built.push({ rows, options });
      return '<div class="chat-row"><div class="tool-call-row-body">built</div></div>';
    },
  });
  const turn = { turn_id: 't1' };
  const rows = [{ kind: 'user_bubble' }, { kind: 'tool_call' }];

  assert.equal(prediction.maybePredictTurnHeight(turn, rows, [], {}, '<p>prebuilt</p>'), 101);
  assert.equal(built.length, 0, 'a prebuilt row list is measured as is');
  assert.deepEqual(calls[0], {
    cacheKey: 'turn:t1', html: '<p>prebuilt</p>', font: '15px Test', maxWidth: 760, lineHeight: 15 * 1.6, options: undefined,
  });

  assert.equal(prediction.maybePredictTurnHeight(turn, rows, [], { transcriptView: 'thinking' }), 101);
  assert.equal(built.length, 1);
  assert.deepEqual(built[0].rows, [{ kind: 'tool_call' }], 'the user bubble is not part of the prediction');
  assert.match(calls[1].options.excludeSelector, /tool-call-row\[data-expanded="false"\] \.tool-call-row-body/);
  assert.equal(prediction.maybePredictTurnHeight(turn, [{ kind: 'user_bubble' }], [], {}), null);
});

test('the patch sync and the cleanup own the article min-height', (t) => {
  const dom = new JSDOM('<!doctype html><div id="timeline"><article id="a"></article><article id="v" data-predicted-height="90" data-virtualized="true" style="min-height: 90px"></article></div>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const article = document.getElementById('a');
  const prediction = createArticlePrediction({
    chatTimeline: document.getElementById('timeline'),
    resolveVisibleTurnArticleTarget: (messageId) => (messageId === 'm1' ? article : null),
  });

  prediction.syncPatchedArticlePrediction('m1', 240);
  assert.equal(article.dataset.predictedHeight, '240');
  assert.equal(article.style.minHeight, '240px');

  // No window in Node: the cleanup runs at once and spares virtualized placeholders.
  prediction.schedulePredictedHeightCleanup();
  assert.equal(article.style.minHeight, '');
  assert.equal(document.getElementById('v').style.minHeight, '90px');

  prediction.syncPatchedArticlePrediction('m1', 240);
  prediction.syncPatchedArticlePrediction('m1', 0);
  assert.equal(article.hasAttribute('data-predicted-height'), false);
  assert.equal(article.style.minHeight, '');
});
