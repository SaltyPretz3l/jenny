const test = require('node:test');
const assert = require('node:assert/strict');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const transcriptTools = require('../renderer/chat/renderer-transcript-tool-calls');
const transcriptUtils = require('../renderer/chat/renderer-transcript-utils');
const { loadRendererApp } = require('./helpers/renderer-shell-harness');

test('transcript tool renderer disposal clears overrides and unregisters idempotently', () => {
  const renderer = transcriptTools.createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
  renderer.setToolCallExpansion('session:call', true);
  assert.equal(renderer.getToolCallExpansion('session:call'), true);
  assert.equal(typeof renderer.dispose, 'function', 'transcript renderer must expose dispose');
  renderer.dispose();
  renderer.dispose();
  assert.equal(renderer.getToolCallExpansion('session:call'), undefined, 'dispose clears expansion state');
  let visits = 0;
  renderer.clearToolCallExpansionOverrides = () => { visits += 1; };
  renderer.clearToolCallExpansionOverridesForSession = () => { visits += 1; };
  transcriptTools.clearToolCallExpansionOverrides();
  transcriptTools.clearToolCallExpansionOverridesForSession('session');
  assert.equal(visits, 0, 'broadcasts never visit a disposed renderer');
  renderer.setToolCallExpansion('session:call', true);
  assert.equal(renderer.getToolCallExpansion('session:call'), undefined, 'disposed expansion state stays empty');
});

test('transcript utilities forward disposal to the registered tool renderer', () => {
  const renderer = transcriptUtils.createTranscriptRenderer({ escapeHtml, toolCallUtils });
  renderer.setToolCallExpansion('forwarded:call', true);
  assert.equal(typeof renderer.dispose, 'function', 'transcript utilities must forward dispose');
  renderer.dispose();
  renderer.dispose();
  assert.equal(transcriptTools.getToolCallExpansion('forwarded:call'), undefined);
});

test('same-document app rebootstrap leaves exactly one renderer in the broadcast registry', async (t) => {
  const renderers = [];
  const app = await loadRendererApp({
    windowGlobals: {
      rendererAgentHooks: {
        installAgentTestHooks({ window }) {
          if (renderers.length) return;
          const tools = window.rendererTranscriptToolCallUtils;
          const create = tools.createTranscriptToolCallRenderer;
          tools.createTranscriptToolCallRenderer = (deps) => {
            const renderer = create(deps);
            const entry = { renderer, allVisits: 0, sessionVisits: 0 };
            for (const [method, counter] of [
              ['clearToolCallExpansionOverrides', 'allVisits'],
              ['clearToolCallExpansionOverridesForSession', 'sessionVisits'],
            ]) {
              const clear = renderer[method];
              renderer[method] = (...args) => { entry[counter] += 1; return clear(...args); };
            }
            renderers.push(entry);
            return renderer;
          };
        },
      },
    },
  });
  t.after(() => app.dispose());
  await app.window.__disposeRenderer();
  await app.reloadRendererApp();
  assert.equal(renderers.length, 2, 'both bootstraps construct a renderer');
  for (const entry of renderers) {
    entry.allVisits = 0;
    entry.sessionVisits = 0;
  }
  const tools = app.window.rendererTranscriptToolCallUtils;
  tools.clearToolCallExpansionOverrides();
  tools.clearToolCallExpansionOverridesForSession('session');
  assert.deepEqual(renderers.map(({ allVisits }) => allVisits), [0, 1], 'broadcast visits exactly one live renderer');
  assert.deepEqual(renderers.map(({ sessionVisits }) => sessionVisits), [0, 1], 'session broadcast skips the old renderer');
  await app.window.__disposeRenderer();
  tools.clearToolCallExpansionOverrides();
  assert.deepEqual(renderers.map(({ allVisits }) => allVisits), [0, 1], 'final teardown empties the registry');
});
