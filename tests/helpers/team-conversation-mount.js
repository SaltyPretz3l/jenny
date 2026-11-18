'use strict';

// A shared conversation mounted alone (the conversation module over a fake project store), for the suites that
// drive it: tests/renderer-team-projects-conversation.test.js and its -chat sibling (row 169).

const { JSDOM } = require('jsdom');

const { P1, S1, OTHER, DOT, MAYA, LENA, snapshot } = require('./team-project-renderer-host');
const { inventory } = require('./team-settings-harness');
const { METHODS, validatePayload } = require('../../services/team/ipc-methods');
const words = require('../../renderer/shell/renderer-settings-team-strings');

const NAMES = { [DOT]: 'Dot', [MAYA]: 'Maya', [LENA]: 'Lena' };
const MINUTE = 60_000;

// The conversation module alone over a fake project store whose every call must pass main's own check, with names
// cleaned as the tab's own context does. `restore` is registered with t.after so a failed assertion still puts the
// globals back.
function mount(t, { role = 'writer', teamRole = 'member', answers = {}, open = { ok: true, snapshot: snapshot() }, projectName = 'jenny-site', hold = false, teamState = 'online', gpus, clipboard } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  const saved = ['window', 'document', 'inventory', 'inventoryTextField', 'markdownUtils'].map((k) => [k, globalThis[k]]);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  if (clipboard) dom.window.jennyShell = { clipboard };
  globalThis.inventory = inventory();
  globalThis.inventoryTextField = require('../../renderer/inventory/text-field');
  dom.window.markdownUtils = require('../../renderer/shared/markdown-utils');
  globalThis.markdownUtils = dom.window.markdownUtils;
  for (const name of ['project-box', 'project-conversation', 'project-conversation-parts', 'project-column', 'project-timeline']) delete require.cache[require.resolve(`../../renderer/team/renderer-team-${name}`)];
  const { createConversation } = require('../../renderer/team/renderer-team-project-conversation');
  const { clean } = require('../../renderer/team/renderer-team-project-column');
  // The team's GPU list as the store reads it: absent (not read yet) unless the case gives one.
  const teamStore = require('../../renderer/team/renderer-team-store').getTeamStore();
  if (gpus) teamStore.snapshot().pools = { [OTHER]: gpus };
  const calls = [];
  const refused = [];
  let now = 1_000_000;
  const timers = new Map();
  let nextTimer = 1;
  const frames = new Map();
  const held = [];
  const store = {
    call: (method, payload) => {
      calls.push({ method, payload });
      if (!Object.hasOwn(METHODS, method) || !validatePayload(method, payload).ok) refused.push(method);
      const answer = method === 'conversationOpen' ? (typeof open === 'function' ? open(payload) : open) : answers[method];
      const value = typeof answer === 'function' ? answer(payload) : (answer || { ok: true });
      if (hold && method === 'conversationOpen') return new Promise((resolve) => held.push(() => resolve(value)));
      return Promise.resolve(value);
    },
    project: () => ({ id: P1, name: projectName, role }),
    conversationsOf: () => [{ session_id: S1, project_id: P1, title: 'Palette loader cleanup' }],
  };
  const renders = { log: 0, live: 0, box: 0, head: 0 };
  const root = dom.window.document.getElementById('root');
  const conv = createConversation({ root, teamId: OTHER, projectId: P1, sessionId: S1, store, renders,
    ctx: () => ({ team: { team_id: OTHER, team_name: 'Dot lab', state: teamState, member_id: DOT, role: teamRole }, nameOf: (id) => clean(NAMES[id] || 'Former member', 64), errorText: (e) => words.errorText(e) }),
    clock: () => now, timers: { set: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; }, clear: (id) => timers.delete(id) },
    frames: { request: (fn) => { const id = nextTimer++; frames.set(id, fn); return id; }, cancel: (id) => frames.delete(id) } });
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    conv.dispose();
    teamStore.snapshot().pools = {};
    for (const [k, v] of saved) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
    if (refused.length) throw new Error('main would refuse: ' + refused.join(', '));
  };
  t.after(restore);
  const advance = (ms) => { const end = now + ms; for (;;) { const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); } now = end; };
  const frame = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  const q = (s) => root.querySelector(s);
  const text = (s = '[data-conv-region]') => [...root.querySelectorAll(s)].map((el) => el.textContent).join(' ').replace(/\s+/g, ' ');
  const event = (event_type, event) => conv.push({ kind: 'conversation_event', session_id: S1, event_type, event: { session_id: S1, ...event } });
  return { conv, root, q, text, calls, renders, timers, frames, advance, frame, restore, event, held, now: () => now, sent: (m) => calls.filter((c) => c.method === m).map((c) => c.payload), window: dom.window };
}

// What the message box says now: its shown parts, without the readers' standing line under it or the row 172
// Tools chip and model pill (tests/renderer-team-conversation-controls.test.js reads those).
function box(m) {
  const copy = m.q('[data-conv-region="box"]').cloneNode(true);
  for (const el of copy.querySelectorAll('[hidden], [data-standing], .team-conv-ctl')) el.remove();
  return copy.textContent.replace(/\s+/g, ' ').trim();
}
const field = (m) => m.q('#teamConversationInput');
function type(m, value) { field(m).value = value; field(m).dispatchEvent(new m.window.Event('input', { bubbles: true })); }

module.exports = { NAMES, MINUTE, mount, box, field, type };
