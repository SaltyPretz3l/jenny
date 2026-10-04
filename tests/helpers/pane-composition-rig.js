'use strict';

/* Split view: the pane composition test rig (jsdom) shared by
 * tests/renderer-pane-composition.test.js and tests/renderer-pane-composition-drop.test.js.
 * The builders are fakes that record what they were handed; see the W1-4c header
 * of the composition test for the contract they stand in for. */

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolveChatPaneDom, CHAT_PANE_NODE_NAMES } = require('../../renderer/shell/renderer-bootstrap-dom');
const { createPaneLayoutController } = require('../../renderer/shell/renderer-pane-layout-controller');
const paneModel = require('../../renderer/shell/renderer-pane-model');
const actionButton = require('../../renderer/inventory/action-button');
const { createPaneComposition, getPaneComposition } = require('../../renderer/app/renderer-app-pane-composition');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const TEMPLATE_START = INDEX_HTML.indexOf('<template id="chatPaneTemplate">');
const TEMPLATE_HTML = INDEX_HTML.slice(TEMPLATE_START, INDEX_HTML.indexOf('</template>', TEMPLATE_START) + '</template>'.length);

function buildDom() {
  return new JSDOM(`<!doctype html><html><body>
    <section class="main-view chat-view" id="chatView" data-pane-count="1">
      <div class="chat-pane" id="chatPane0" data-pane-id="0" data-pane-focused="true">
        <div class="chat-pane-kicker" id="chatPaneKicker" data-chat-node="chatPaneKicker" hidden></div>
        <div class="chat-thread-stage" id="chatThreadStage" data-chat-node="chatThreadStage"></div>
      </div>
      <div class="chat-pane-resizer artifact-review-resizer hidden" id="chatPaneResizer" role="separator" tabindex="-1"></div>
      <div class="artifact-review-resizer hidden" id="artifactReviewResizer"></div>
      <aside class="artifact-review-panel" id="artifactReviewPanel"></aside>
      ${TEMPLATE_HTML}
    </section></body></html>`, { pretendToBeVisual: true });
}

function createRig(t, options = {}) {
  const dom = buildDom();
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const chatView = doc.getElementById('chatView');
  const events = [];
  const sessions = options.sessions || [
    { id: 'a', title: 'Alpha', project_id: '' },
    { id: 'b', title: 'Beta', project_id: '' },
    { id: 'c', title: 'Gamma', project_id: 'proj_work' },
  ];
  const state = {
    currentSessionId: options.currentSessionId ?? 'a',
    panes: paneModel.normalizePaneLayout({ panes: [''] }),
    sessions,
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    ui: { activeView: 'chat' },
  };
  const drafts = options.drafts ? createDrafts(doc, state) : null;
  const resolved = [];
  const persisted = [];
  const resizers = [];
  let composition = null;
  const layoutController = createPaneLayoutController({
    state,
    paneModel,
    getWorkspaceStateController: () => ({ persistPaneLayout: (layout) => persisted.push(layout) }),
    onLayoutChanged: (prev, next, meta) => composition?.handleLayoutChanged(prev, next, meta),
  });
  const primaryRenders = [];
  const fullRenders = [];
  const loads = [];
  const built = { surface: [], pipeline: [], shell: [] }; // the argument bag each builder was handed
  composition = createPaneComposition({
    documentRef: doc,
    windowRef: dom.window,
    state,
    chatView,
    layoutController,
    resolvePane: (root) => { resolved.push(root); return resolveChatPaneDom(doc, root); },
    createPaneRuntime: ({ paneId }) => {
      events.push(['runtime', paneId]);
      return { paneId, dispose: () => events.push(['dispose', 'runtime']) };
    },
    buildPaneSurface: (pane) => {
      built.surface.push(pane);
      events.push(['surface', pane.paneId, pane.dom.chatView]);
      return { scrollCoordinator: null, viewportApi: {}, dispose: () => events.push(['dispose', 'surface']) };
    },
    buildRenderPipeline: (pane) => {
      built.pipeline.push(pane);
      events.push(['pipeline', pane.runtime.uiRuntime.paneId, pane.dom.chatTimeline]);
      return {
        renderMessages: () => events.push(['render', 'pane1']),
        dispose: () => events.push(['dispose', 'pipeline']),
      };
    },
    buildChatShellController: (pane) => {
      built.shell.push(pane);
      events.push(['shell', pane.sessionContext.paneId, pane.dom.chatInput]);
      return {
        bind: () => events.push(['bind', 'shell']),
        dispose: () => events.push(['dispose', 'shell']),
        onPaneSessionChanged: (sessionId) => events.push(['session-changed', pane.sessionContext.paneId, sessionId]),
        syncTurnElapsedClock() {},
      };
    },
    // Opt-in: pane 1's own reasoning controller factory (renderer/app.js wires ThinkingPanelController).
    ...(options.createThinkingController ? { createThinkingController: options.createThinkingController } : {}),
    // Opt-in: pane 0's follow re-latch (renderer/app.js wires the app controller and setFollowLatest).
    ...(options.relatchPrimaryFollow ? { relatchPrimaryFollow: options.relatchPrimaryFollow } : {}),
    getPrimaryShell: () => ({ onPaneSessionChanged: (sessionId) => events.push(['session-changed', 0, sessionId]) }),
    // Opt-in: the real session-keyed composer store over a pane-0 #chatInput.
    ...(drafts ? { getComposerSessionState: () => drafts.controller } : {}),
    createResizer: (resizerDeps) => {
      const resizer = {
        deps: resizerDeps,
        bind: () => events.push(['resizer', 'bind']),
        sync: () => events.push(['resizer', 'sync']),
        dispose: () => events.push(['resizer', 'dispose']),
      };
      resizers.push(resizer);
      return resizer;
    },
    persistSplitRatio: (ratio) => persisted.push({ splitRatio: ratio }),
    renderPrimaryMessages: () => primaryRenders.push(state.currentSessionId),
    requestFullRender: () => fullRenders.push(1),
    getSessionSummary: (id) => sessions.find((session) => session.id === id) || null,
    getProjectName: (projectId) => ({ proj_work: 'Work', project_general: 'General' })[projectId] || '',
    getSessionMessages: () => [],
    loadSessionMessages: async (id) => { loads.push(id); return false; },
    listSwitchCandidates: () => options.candidates || ['c', 'b', 'a'],
    isSessionStreaming: (id) => (options.streaming || []).includes(id),
    // Opt-in: pane 1's queue ({ sessionId: [entries] }) with a tray renderer that writes nothing.
    ...(options.queuedAttachments ? { getQueuedAttachments: (id) => options.queuedAttachments[id] || [], renderAttachmentTray: () => {} } : {}),
    actionButton,
    scheduleMicrotask: (fn) => fn(),
    // Opt-in: the real side panel owner, with the collapse recorded as an event.
    ...(options.sidePanel ? { sidePanelOwner: require('../../renderer/chat/renderer-side-panel-owner'), collapseSidePanel: () => events.push(['collapse-side-panel']) } : {}),
  });
  return { dom, doc, chatView, state, events, resolved, persisted, resizers, layoutController, composition, primaryRenders, fullRenders, loads, drafts, built };
}

function createDrafts(doc, state) {
  const input = doc.createElement('textarea');
  input.id = 'chatInput';
  doc.getElementById('chatPane0').appendChild(input);
  const { createComposerSessionState } = require('../../renderer/chat/renderer-composer-session-state');
  return { input, controller: createComposerSessionState({ state, getChatInput: () => input }) };
}

function paneRoot(chatView, paneId) {
  return chatView.querySelector(`:scope > .chat-pane[data-pane-id="${paneId}"]`);
}

function kickerOf(rig, paneId) {
  return paneId === 0
    ? rig.doc.getElementById('chatPaneKicker')
    : paneRoot(rig.chatView, paneId).querySelector('[data-chat-node="chatPaneKicker"]');
}

module.exports = { createRig, paneRoot, kickerOf, resolveChatPaneDom, CHAT_PANE_NODE_NAMES, getPaneComposition, paneModel };
