const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const {
  createStreamRevealController,
  settleVisibleStreamAffordances,
  captureCodeBlockScroll,
  restoreCodeBlockScroll,
  setChildrenHtmlPreservingKeyedNodes,
} = require('../../renderer/chat/renderer-stream-reveal-utils');
const {
  loadRendererApp,
  waitForUi,
} = require('./renderer-shell-harness');
const { createDeferred } = require('./deferred');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Per-file JSDOM tracker so immediate-reveal tests dispose every window in one
// afterEach. node:test runs each test file in its own process, so this array is
// per-file -- no cross-file shared-Set hazard.
const trackedRevealDoms = [];
function trackRevealDom(dom) {
  if (dom) {
    trackedRevealDoms.push(dom);
  }
  return dom;
}
function disposeTrackedRevealDoms() {
  while (trackedRevealDoms.length) {
    const dom = trackedRevealDoms.pop();
    try {
      dom.window.close();
    } catch (error) {
      void error;
    }
  }
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function buildRevealSession(sessionId, payload) {
  return {
    id: sessionId,
    title: 'Reveal Session',
    conversation_mode: 'chat',
    preferred_model: payload.preferredModel || 'gpt-test',
    reasoning_effort: payload.reasoningEffort || 'default',
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function createImmediateRevealController(html, options = {}) {
  const dom = trackRevealDom(new JSDOM(html));
  const timeline = dom.window.document.getElementById(options.timelineId || 'timeline');
  dom.window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: options.renderStreamingMarkdownUnits
      || (() => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 })),
    escapeSelectorValue: (value) => String(value || ''),
    state: options.state,
    streamClientMetrics: options.streamClientMetrics,
  });
  return { dom, timeline, controller };
}

function reasoningStackMarkup(text, options = {}) {
  const messageId = options.messageId || 'assistant_stream';
  const thinkingId = options.thinkingId || 'think_1';
  const phaseKey = options.phaseKey || thinkingId;
  return `
    <div class="reasoning-row-stack" data-reasoning-row-version="2">
      <div class="reasoning-row-block expanded" data-thinking-id="${thinkingId}" data-phase-key="${phaseKey}">
        <button class="reasoning-row-header" type="button" data-reasoning-toggle="true" data-message-id="${messageId}" data-thinking-id="${thinkingId}" data-phase-key="${phaseKey}">
          <span class="reasoning-row-main shimmer-active">${text}</span>
        </button>
        <div class="reasoning-row-panel expanded" data-thinking-id="${thinkingId}" data-phase-key="${phaseKey}">
          <div class="reasoning-row-panel-body chat-bubble-markdown"><p>${text}</p></div>
        </div>
      </div>
    </div>
  `;
}


module.exports = {
  JSDOM,
  buildRevealSession,
  captureCodeBlockScroll,
  createDeferred,
  createImmediateRevealController,
  createStreamRevealController,
  disposeTrackedRevealDoms,
  loadRendererTestApp,
  readRepoFile,
  reasoningStackMarkup,
  restoreCodeBlockScroll,
  setChildrenHtmlPreservingKeyedNodes,
  settleVisibleStreamAffordances,
  trackRevealDom,
  waitForUi,
};
