'use strict';

/* Row 122: how the transcript reaches the before and after pictures. The chat
 * render calls the eager rail module after every timeline write; the pictures
 * modules load only the first time a chat shows a change, and never when the
 * feature is off. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rail = require('../renderer/features/renderer-code-review-rail');
const { createRenderEffectsPipeline } = require('../renderer/chat/renderer-render-pipeline-render-effects');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function timelineOf(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div class="chat-timeline" id="chatTimeline">${html}</div></body></html>`);
  return dom.window.document.getElementById('chatTimeline');
}

const ARTICLE = '<article class="chat-entry assistant" data-turn-id="t1"><span data-jenny-code-review></span></article>';

// A window whose loader "arrives" by defining each script's global.
function fakeWindow({ fail = false } = {}) {
  const loaded = [];
  const decorated = [];
  const windowRef = {
    scriptLoaderUtils: {
      ensureScript: async ({ src }) => {
        loaded.push(src);
        if (fail) return false;
        const pair = rail.CHANGE_PICTURES_SCRIPTS.find(([path]) => path === src);
        windowRef[pair[1]] = pair[1] === 'rendererChangePictures'
          ? { decorateChat: (options) => decorated.push(options) }
          : {};
        return true;
      },
    },
  };
  return { windowRef, loaded, decorated };
}

test('a loaded pictures module is handed the root, the session and that session\'s turns', () => {
  const timeline = timelineOf(ARTICLE);
  const decorated = [];
  const asked = [];
  let sessionId = ' s1 ';
  rail.decorateChatPictures({
    root: timeline.firstElementChild,
    timeline,
    getSessionId: () => sessionId,
    getTurns: (id) => { asked.push(id); return [{ turnId: 't1' }]; },
    windowRef: { rendererChangePictures: { decorateChat: (options) => decorated.push(options) } },
  });
  assert.equal(decorated.length, 1);
  assert.equal(decorated[0].root, timeline.firstElementChild);
  assert.equal(decorated[0].sessionId, 's1');
  assert.equal(decorated[0].enabled, true);
  sessionId = 's2';
  assert.deepEqual(decorated[0].getTurns(), [{ turnId: 't1' }]);
  assert.deepEqual(asked, ['s1'], 'the turns stay those of the session that was decorated');
});

test('the modules load once, the first time a chat shows a change, and then decorate the whole timeline', async () => {
  const { windowRef, loaded, decorated } = fakeWindow();
  const plain = timelineOf('<article class="chat-entry assistant" data-turn-id="t0"></article>');
  const deps = { getSessionId: () => 's1', getTurns: () => [], windowRef };
  rail.decorateChatPictures({ ...deps, root: plain, timeline: plain });
  await flush();
  assert.deepEqual(loaded, [], 'a chat with no change loads nothing');

  const timeline = timelineOf(ARTICLE);
  rail.decorateChatPictures({ ...deps, root: timeline.firstElementChild, timeline });
  rail.decorateChatPictures({ ...deps, root: timeline.firstElementChild, timeline });
  await flush();
  assert.deepEqual(loaded, rail.CHANGE_PICTURES_SCRIPTS.map(([src]) => src));
  assert.equal(decorated.length, 1);
  assert.equal(decorated[0].root, timeline);
});

test('a failed load is not retried on later renders', async () => {
  const { windowRef, loaded, decorated } = fakeWindow({ fail: true });
  const timeline = timelineOf(ARTICLE);
  const deps = { root: timeline, timeline, getSessionId: () => 's1', getTurns: () => [], windowRef };
  rail.decorateChatPictures(deps);
  await flush();
  rail.decorateChatPictures(deps);
  await flush();
  assert.equal(loaded.length, 1);
  assert.equal(decorated.length, 0);
});

test('with the feature off nothing loads, and a loaded module is told so', async () => {
  const { windowRef, loaded } = fakeWindow();
  const timeline = timelineOf(ARTICLE);
  const deps = { root: timeline, timeline, getSessionId: () => 's1', getTurns: () => [], isEnabled: () => false };
  rail.decorateChatPictures({ ...deps, windowRef });
  await flush();
  assert.deepEqual(loaded, []);
  const decorated = [];
  rail.decorateChatPictures({ ...deps, windowRef: { rendererChangePictures: { decorateChat: (options) => decorated.push(options) } } });
  assert.equal(decorated[0].enabled, false);
});

test('every timeline write and every remounted entry reaches the pictures hook, and a throwing hook is harmless', (t) => {
  const timeline = timelineOf(ARTICLE);
  const calls = [];
  const previous = globalThis.rendererCodeReviewRail;
  t.after(() => { globalThis.rendererCodeReviewRail = previous; });
  globalThis.rendererCodeReviewRail = { decorateChatPictures: (options) => calls.push(options) };
  const state = { currentSessionId: 's1', features: { featureFlags: {} } };
  const turns = new Map([['t1', { turnId: 't1' }]]);
  const uiRuntime = { projectionContextBySession: new Map([['s1', { currentContext: { viewModelByTurnId: turns } }]]) };
  const effects = createRenderEffectsPipeline({ state, dom: { chatTimeline: timeline }, runtime: { uiRuntime } });

  effects.runPostTimelineRenderEffects([], { liveThinking: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, timeline);
  assert.equal(calls[0].timeline, timeline);
  assert.equal(calls[0].getSessionId(), 's1');
  assert.deepEqual(calls[0].getTurns('s1'), [{ turnId: 't1' }]);
  assert.deepEqual(calls[0].getTurns('other'), []);
  assert.equal(calls[0].isEnabled(), true);
  state.features.featureFlags.change_pictures = false;
  assert.equal(calls[0].isEnabled(), false);

  effects.redecorateVirtualizedEntry(timeline.firstElementChild);
  assert.equal(calls[1].root, timeline.firstElementChild);

  globalThis.rendererCodeReviewRail = { decorateChatPictures: () => { throw new Error('boom'); } };
  assert.doesNotThrow(() => effects.runPostTimelineRenderEffects([], { liveThinking: false }));
  assert.doesNotThrow(() => effects.redecorateVirtualizedEntry(timeline.firstElementChild));
});
