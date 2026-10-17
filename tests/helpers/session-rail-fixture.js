'use strict';

/* Shared jsdom fixture for the session rail controller tests (row 59 checkpoint 2): a fake
   chatWorkspace bridge (contract C2) and a fake detail API (contract C3) around one pane. */

const { JSDOM } = require('jsdom');

const actionButton = require('../../renderer/inventory/action-button.js');
const { mountSessionRail } = require('../../renderer/chat/renderer-session-rail.js');

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function wrapper(data, state = 'available') {
  return { state, sampled_at: '2026-10-15T10:00:00.000Z', reason: null, data };
}

function summaryFor(sessionId, extra = {}) {
  return {
    session_id: sessionId,
    session_incarnation: `inc_${sessionId}`,
    revision: 4,
    environment: wrapper({ project_id: 'p1', project_name: `project of ${sessionId}`, workspace_id: 'w1', display_path: `G:\\work\\${sessionId}`, branch: 'main', worktree_id: null, execution_environment: 'local', run_mode: 'auto' }),
    context: wrapper({ turn_id: null, used_tokens: 20480, capacity_tokens: 32000, available_tokens: 11520, measurement: 'actual', scope: 'request' }),
    outputs: wrapper({ items: [{ artifact_id: `${sessionId}_art1`, display_name: 'context_probe.py', kind: 'code', availability: 'available' }], total_count: 1, next_cursor: null }),
    changes: wrapper({ workspace_id: 'w1', scope: 'working_tree', file_count: 6, additions: 412, deletions: 37, ref: 'main', head: 'abc1234' }),
    background_tasks: wrapper({
      scope: 'session_and_direct_children', counts: { active: 1, waiting: 0, failed: 0, completed: 12 }, coverage: 'partial', unsupported_sources: ['linked_chat_turn'],
      items: [{ source_kind: 'workspace_test', operation_id: 'op_1', session_id: sessionId, state: 'running', started_at: null, finished_at: null, output_ref: null }],
    }),
    ...extra,
  };
}

function createBridge({ respond } = {}) {
  const listeners = new Set();
  const bridge = {
    summaryCalls: [],
    setViewCalls: [],
    listeners,
    view: { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null },
    revision: 0,
    emit(event) { for (const listener of [...listeners]) listener(event); },
    async getSummary(request) {
      bridge.summaryCalls.push(request);
      if (respond) return respond(request, bridge);
      return { schema_version: 1, ok: true, summary: summaryFor(request.session_id, { revision: bridge.revision }), workspace_view: bridge.view, coordination_revision: bridge.revision };
    },
    async setView(request) {
      bridge.setViewCalls.push(request);
      if (bridge.setViewHandler) return bridge.setViewHandler(request, bridge);
      bridge.view = {
        ...bridge.view,
        ...(Object.hasOwn(request.patch, 'rail_visible') ? { rail_visible: request.patch.rail_visible } : {}),
        disclosures: { ...bridge.view.disclosures, ...(request.patch.disclosures || {}) },
      };
      bridge.revision += 1;
      return { schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: bridge.revision };
    },
    onChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return bridge;
}

function createFixture({ width = 1133, sessionId = 'sess_a', bridge = createBridge(), bridgeMissing = false, paneAttrs = '', performance = null } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="chat-view" id="chatView" data-pane-count="1">
      <div class="chat-pane" id="chatPane0" data-pane-id="0" ${paneAttrs}>
        <div class="chat-thread-stage" id="stage"><div class="chat-timeline" id="timeline"></div></div>
        <div class="chat-timeline-utility-cluster" id="cluster"><button id="other" type="button">other</button></div>
        <div class="composer-wrap" id="composerWrap"><textarea id="chatInput"></textarea></div>
      </div>
      <aside class="chat-context-panel collapsed" id="chatContextPanel"></aside>
    </div></body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  window.inventoryActionButton = actionButton;
  const resizeObservers = [];
  window.ResizeObserver = class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; resizeObservers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const state = { width, sessionId };
  const detail = { calls: [], open(request) { detail.calls.push(request); } };
  const pane = window.document.getElementById('chatPane0');
  const controller = new window.AbortController();
  const api = mountSessionRail({
    pane,
    cluster: window.document.getElementById('cluster'),
    chatTimeline: window.document.getElementById('timeline'),
    getSessionId: () => state.sessionId,
    getPaneWidth: () => state.width,
    bridge: bridgeMissing ? null : bridge,
    performance,
    detail,
    windowRef: window,
    signal: controller.signal,
  });
  const doc = window.document;
  return {
    dom, window, doc, state, bridge, detail, pane, api, controller, resizeObservers,
    chatView: doc.getElementById('chatView'),
    context: doc.getElementById('chatContextPanel'),
    toggle: () => doc.querySelector('[data-session-rail-toggle]'),
    rail: () => doc.querySelector('[data-session-rail-root]'),
    sheet: () => doc.querySelector('[data-session-rail-sheet]'),
    head: (key) => doc.querySelector(`[data-rail-section="${key}"]`),
    section: (key) => doc.querySelector(`[data-section="${key}"]`),
    text: (key) => doc.querySelector(`[data-section="${key}"]`).textContent.replace(/\s+/g, ' ').trim(),
    value: (key) => doc.querySelector(`[data-section="${key}"] [data-rail-value]`).textContent.trim(),
    changeSession(next) { state.sessionId = next; window.dispatchEvent(new window.CustomEvent('jenny:focused-chat-changed')); },
    async resize(next) { state.width = next; api.evaluateDock(); await flush(); },
  };
}

async function docked(options) {
  const f = createFixture(options);
  await flush();
  return f;
}

module.exports = { flush, sleep, deferred, wrapper, summaryFor, createBridge, createFixture, docked };
