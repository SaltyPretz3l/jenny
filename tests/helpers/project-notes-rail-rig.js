'use strict';

// The Notes rail test rig: a jsdom panel, the stubbed projectNotes IPC, a manual
// scheduler and the controller. Shared by the rail test files.

const { JSDOM } = require('jsdom');

const { createManualScheduler } = require('./manual-scheduler');
const { flush, makeNote, makeStore } = require('./project-notes-store-stub');
const notesRail = require('../../renderer/features/renderer-project-notes-rail');

function rig(options = {}) {
  const dom = new JSDOM('<body><div id="artifactReviewPanel"><div id="host"></div></div></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const store = makeStore(options.notes || { project_alpha: makeNote(), project_beta: makeNote({ projectId: 'project_beta', text: 'beta text', revision: 4 }) });
  window.jennyShell = options.noApi ? {} : { projectNotes: store.api };
  const scheduler = createManualScheduler();
  const state = {
    sessions: [
      { id: 's1', project_id: 'project_alpha' },
      { id: 's2', project_id: 'project_beta' },
      { id: 's3' },
    ],
    currentSessionId: 's1',
    ui: { artifactReview: { mode: 'notes', enabled: true, collapsed: false } },
  };
  const panel = window.document.getElementById('artifactReviewPanel');
  const host = window.document.getElementById('host');
  const log = { opens: [], renders: 0, toggles: 0, toasts: [], logs: [], seen: [] };
  let controller = null;
  controller = notesRail.createProjectNotesRail({
    state,
    windowRef: window,
    dom: { artifactReviewPanel: panel },
    openArtifactRail: (mode) => { log.opens.push(mode); state.ui.artifactReview.mode = mode; },
    renderArtifactReviewPanel: () => { log.renders += 1; if (state.ui.artifactReview.mode === 'notes') controller.renderRailContent({ previewContent: host }); },
    toggleArtifactReview: () => { log.toggles += 1; state.ui.artifactReview.enabled = false; },
    getProjectSwitcher: options.switcher ? () => Promise.resolve(options.switcher) : undefined,
    getEntry: () => ({ markSeen: (...args) => log.seen.push(args) }),
    appendClientLog: (...args) => log.logs.push(args),
    showToastMessage: (message) => log.toasts.push(message),
    setTimeoutImpl: scheduler.setTimeout,
    clearTimeoutImpl: scheduler.clearTimeout,
    now: () => scheduler.now(),
  });
  controller.bind();
  const paint = () => controller.renderRailContent({ previewContent: host });
  const q = (selector) => host.querySelector(selector);
  const editor = () => host.querySelector('[data-notes-editor]');
  const type = (text) => {
    const el = editor();
    el.value = text;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const keydown = (el, key) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const leaveEditor = () => editor().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  const callsOf = (name) => store.calls.filter((call) => call[0] === name);
  return { controller, window, state, store, scheduler, host, panel, log, paint, q, editor, type, keydown, leaveEditor, callsOf };
}

async function openedRig(options) {
  const r = rig(options);
  r.paint();
  await flush();
  return r;
}

async function editing(r) {
  r.q('.notes-rail__preview').click();
  await flush();
  return r.editor();
}

module.exports = { rig, openedRig, editing, flush, makeNote };
