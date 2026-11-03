'use strict';

// Shared fixtures and the jsdom harness for the Jenny chat's Activity dialog tests
// (renderer-primary-activity.test.js and, for row 87's rules, renderer-primary-rules.test.js).

const { JSDOM } = require('jsdom');

const { createPrimaryActivity } = require('../renderer/chat/renderer-primary-activity');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const checkbox = require('../renderer/inventory/checkbox');
const selectField = require('../renderer/inventory/select-field');
const segmentedControl = require('../renderer/inventory/segmented-control');

const SID = 'primary-1';
const RULE_A = `ar_${'a'.repeat(32)}`;
const RULE_B = `ar_${'b'.repeat(32)}`;
const RULE_C = `ar_${'c'.repeat(32)}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function entry(overrides) {
  return {
    id: 'e', kind: 'message_sent', at: '2026-10-25T09:00:00.000Z', status: null, title: null, detail: null,
    session_id: null, project: null, authorization: null, permission_id: null, ...overrides,
  };
}

function entries() {
  return [
    entry({ id: '1', kind: 'paused', at: '2026-10-25T09:05:00.000Z' }),
    entry({ id: '2', kind: 'report_received', title: 'Website <b>redesign</b>', detail: 'Finished <i>hero</i> copy', status: 'queued', project: { id: 'p1', name: 'Website' } }),
    entry({ id: '3', kind: 'proposal', title: 'Hero copy', detail: 'Draft three variants', status: 'accepted/start', authorization: 'permission', project: { id: 'p1', name: 'Website' } }),
    entry({ id: '4', kind: 'proposal', title: 'Other', status: 'declined/start', authorization: 'offer' }),
    entry({ id: '5', kind: 'message_sent', title: 'Release notes', detail: 'Mention the API bump', status: 'delivered', authorization: 'approval' }),
    entry({ id: '6', kind: 'stop', title: 'Sweep', status: 'denied' }),
    entry({ id: '7', kind: 'woken', title: 'by a report', status: 'running' }),
    entry({ id: '8', kind: 'reset' }),
  ];
}

function fixtures() {
  return {
    paused: false,
    activity: { entries: entries(), truncated: true },
    permissions: {
      launch: [
        { permission_id: 'perm-1', project_id: 'p1', run_modes: null, max_children_per_turn: 1, created_at: '2026-10-24T09:00:00.000Z', revoked_at: null, project: { id: 'p1', name: 'Website <b>x</b>' } },
        { permission_id: 'perm-2', project_id: '*', run_modes: ['auto'], max_children_per_turn: 3, created_at: '2026-10-22T09:00:00.000Z', revoked_at: null, project: null },
        { permission_id: 'perm-3', project_id: 'p2', run_modes: null, max_children_per_turn: 1, created_at: '2026-10-20T09:00:00.000Z', revoked_at: '2026-10-21T09:00:00.000Z', project: { id: 'p2', name: 'Gone' } },
      ],
      message_grants: [
        { grant_id: 'g-1', destination: { session_id: 'd1', title: 'Release notes' }, purpose: 'Keep notes in step', created_at: '2026-10-24T09:00:00.000Z', expires_at: '2026-10-31T09:00:00.000Z', remaining_sends: 97, revoked_at: null, live: true },
        { grant_id: 'g-2', destination: { session_id: 'd2', title: 'Dead' }, purpose: 'old', created_at: '2026-10-01T09:00:00.000Z', expires_at: '2026-10-02T09:00:00.000Z', remaining_sends: 0, revoked_at: null, live: false },
      ],
      turn_grants: [],
      rules: [
        { rule_id: RULE_A, action: 'message', target: { kind: 'linked_children' }, effect: 'allow', run_modes: null, created_at: '2026-10-26T09:00:00.000Z', revoked_at: null },
        { rule_id: RULE_B, action: 'stop', target: { kind: 'any' }, effect: 'deny', run_modes: null, created_at: '2026-10-27T09:00:00.000Z', revoked_at: null },
        { rule_id: RULE_C, action: 'setting', target: { kind: 'any' }, effect: 'deny', run_modes: null, created_at: '2026-10-20T09:00:00.000Z', revoked_at: '2026-10-21T09:00:00.000Z' },
      ],
    },
    flags: { controls: true, launch_permission: true, activity_log: true, action_rules: true },
  };
}

function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="trigger">open</button></main></body></html>');
  const doc = dom.window.document;
  const data = options.data || fixtures();
  const calls = [];
  const listeners = new Set();
  const bridge = options.noBridge ? null : {
    getState: async (request) => { calls.push({ method: 'getState', request }); return { schema_version: 1, ok: true, session_id: SID, paused: data.paused, paused_at: null, permissions: [], history: [], flags: data.flags }; },
    activity: async (request) => { calls.push({ method: 'activity', request }); if (options.failActivity) return { schema_version: 1, ok: false, reason: 'unavailable' }; return { schema_version: 1, ok: true, session_id: SID, ...data.activity }; },
    permissions: async (request) => { calls.push({ method: 'permissions', request }); return { schema_version: 1, ok: true, ...data.permissions }; },
    grantLaunch: async (request) => { calls.push({ method: 'grantLaunch', request }); return options.grantAnswer || { schema_version: 1, ok: true, created: true, permission: {} }; },
    revokeLaunch: async (request) => { calls.push({ method: 'revokeLaunch', request }); return { schema_version: 1, ok: true, permission: {} }; },
    addRule: async (request) => { calls.push({ method: 'addRule', request }); return options.ruleAnswer || { schema_version: 1, ok: true, created: true, rule: {} }; },
    revokeRule: async (request) => { calls.push({ method: 'revokeRule', request }); return { schema_version: 1, ok: true, rule: {} }; },
    undoSettingChange: async (request) => {
      calls.push({ method: 'undoSettingChange', request });
      if (options.undoGate) await options.undoGate;
      return options.undoAnswer || { schema_version: 1, ok: true, change_id: request.change_id, restored: [] };
    },
    undoChatChange: async (request) => {
      calls.push({ method: 'undoChatChange', request });
      return options.chatUndoAnswer || { schema_version: 1, ok: true };
    },
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const messages = { revokeGrant: async (request) => { calls.push({ method: 'revokeGrant', request }); return { schema_version: 1, ok: true }; } };
  dom.window.jennyShell = { chatMessages: messages };
  const savedWindow = globalThis.window;
  globalThis.window = dom.window;
  const activity = createPrimaryActivity({
    documentRef: doc, stepModal, actionButton, checkbox, selectField, segmentedControl,
    getBridge: () => bridge, state: options.state || {}, appendClientLog: () => {},
    listProjects: () => options.projects || [{ id: 'p1', name: 'Website' }, { id: 'p2', name: 'Perf' }],
  });
  t.after(() => { activity.dispose(); dom.window.close(); globalThis.window = savedWindow; });
  const $ = (selector) => doc.querySelector(selector);
  return {
    doc, data, calls, listeners, activity, $,
    all: (selector) => Array.from(doc.querySelectorAll(selector)),
    open: (args) => activity.open({ sessionId: SID, trigger: doc.getElementById('trigger'), ...(args || {}) }),
    calledWith: (method) => calls.filter((call) => call.method === method),
    showPermissions: () => $('[data-inv-segmented="primary-activity-tabs"] [data-value="permissions"]').click(),
    choose: (attr, value) => {
      const node = $(`[${attr}]`);
      node.value = value;
      node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    options: (attr) => Array.from($(`[${attr}]`).options).map((option) => [option.value, option.textContent]),
  };
}

module.exports = { SID, RULE_A, RULE_B, RULE_C, flush, entry, entries, fixtures, harness };
