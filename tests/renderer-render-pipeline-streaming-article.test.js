'use strict';

// new-test-file: renderer-render-pipeline-streaming-article.js had no test file of its own.
// The whole-article rewrite of the live turn (a structural change mid-stream):
// a predicted min-height it leaves must have a cleanup that runs, and the
// rewrite builds the turn's row list once.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createStreamingArticlePatcher } = require('../renderer/chat/renderer-render-pipeline-streaming-article');

function createPatcher({ articleOptions = [], effects = [], finds = { count: 0 }, morphs = [] } = {}) {
  const dom = new JSDOM('<!doctype html><div id="timeline"><article class="chat-entry" data-message-id="m1" data-predicted-height="900" style="min-height: 900px">old</article></div>');
  const document = dom.window.document;
  const chatTimeline = document.getElementById('timeline');
  const patcher = createStreamingArticlePatcher({
    state: { features: { featureFlags: {} }, ui: { followLatest: false } },
    chatTimeline,
    uiRuntime: {},
    streamClientMetrics: { noteRowListMorph(_sessionId, morph) { morphs.push(morph.reason); } },
    getPaneSessionId: () => 's1',
    noteStreamRender() {},
    resolveVisibleTurnArticleTarget: () => chatTimeline.querySelector('[data-message-id="m1"]'),
    resolveTurnArticleMessageId: (id) => id,
    buildMessageArticleMarkup(message, _messages, _latest, _reply, _reason, _regen, _context, options) {
      articleOptions.push(options || {});
      const reserve = options?.skipHeightPrediction === true ? '' : ' data-predicted-height="900" style="min-height: 900px"';
      return `<article class="chat-entry" data-message-id="${message.id}"${reserve}>new</article>`;
    },
    buildMessageInnerMarkup: () => ({ innerHtml: '', pending: false, status: 'streaming', finalizedAt: '' }),
    buildMessageArticleInnerHtml: (_message, innerHtml) => innerHtml,
    replayStreamRevealHandoff() {},
    stampStreamingArticleMarkerNode() {},
    runPostTimelineRenderEffects(_messages, options) { effects.push(options); },
  });
  const messages = [{ id: 'm0', role: 'user' }, { id: 'm1', role: 'assistant', status: 'streaming' }];
  messages.find = function countedFind(...args) { finds.count += 1; return Array.prototype.find.apply(this, args); };
  const ctx = {
    messages,
    latestAssistantMessageId: 'm1',
    latestReplyAssistantMessageId: 'm1',
    followUpDisabledReason: '',
    latestRegenerateRequest: null,
    projectionContext: { messageById: new Map(messages.map((message) => [message.id, message])) },
    noteStructuralRewrite() {},
    recordStreamingArticleRebuild() {},
  };
  return { patcher, ctx, chatTimeline, streaming: messages[1] };
}

test('a scrolled-away reader’s live-article rewrite leaves no min-height without a cleanup', () => {
  const articleOptions = [];
  const effects = [];
  const { patcher, ctx, chatTimeline, streaming } = createPatcher({ articleOptions, effects });

  assert.equal(patcher.patchStreamingArticle(ctx, streaming), true);
  const article = chatTimeline.querySelector('[data-message-id="m1"]');
  assert.equal(article.textContent, 'new');
  assert.equal(articleOptions.length, 1);
  assert.equal(articleOptions[0].skipHeightPrediction, true, 'the rewrite does not build a second row list for a prediction');
  assert.equal(article.style.minHeight, '', 'the rewritten live article carries no reservation');
  assert.equal(effects.length, 1);
  assert.equal(effects[0].cleanupPredictedHeights, true, 'the post-render effects clean up predicted heights');
});

test('the live-article rewrite looks its article message up by id, not by a list scan', () => {
  const finds = { count: 0 };
  const { patcher, ctx, streaming } = createPatcher({ finds });
  assert.equal(patcher.patchStreamingArticle(ctx, streaming), true);
  assert.equal(finds.count, 0);
});

// The stream-reveal row-list fallback (renderer-render-pipeline-stream-reveal-callbacks.js,
// no test file of its own) resolves its article message the same way.
test('the row-list fallback looks its article message up by id, not by a list scan', () => {
  const { createStreamRevealPatchCallbacks } = require('../renderer/chat/renderer-render-pipeline-stream-reveal-callbacks');
  const dom = new JSDOM('<!doctype html><div id="timeline"></div>');
  const messages = [{ id: 'm0', role: 'user' }, { id: 'm1', role: 'assistant', status: 'streaming' }];
  let finds = 0;
  messages.find = function countedFind(...args) { finds += 1; return Array.prototype.find.apply(this, args); };
  const built = [];
  const callbacks = createStreamRevealPatchCallbacks({
    chatTimeline: dom.window.document.getElementById('timeline'),
    messages,
    derived: { streamingMessage: messages[1] },
    projectionContext: { messageById: new Map(messages.map((message) => [message.id, message])) },
    latestReplyAssistantMessageId: 'm1',
    resolveVisibleTurnArticleTarget: () => null,
    resolveTurnArticleMessageId: (id) => id,
    buildMessageArticleMarkup(message) {
      built.push(message.id);
      return '<article><div data-turn-row-list="true"><div class="chat-row">row</div></div></article>';
    },
  });
  assert.equal(callbacks.buildTurnRowListMarkup(), '<div class="chat-row">row</div>');
  assert.deepEqual(built, ['m1']);
  assert.equal(finds, 0);
});

// cost-growth 4: the whole-article rewrite taken when the surgical patch is
// blocked names the block (describePatchBlock) instead of an anonymous patch.
test('the live-article rewrite charges the patch block that sent it there', () => {
  const morphs = [];
  const { patcher, ctx, streaming } = createPatcher({ morphs });
  assert.equal(patcher.patchStreamingArticle({ ...ctx, rewriteReason: 'signature_mismatch' }, streaming), true);
  assert.deepEqual(morphs, ['article_rewrite:signature_mismatch']);
});
