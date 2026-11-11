'use strict';

// Follow Jenny (row 121): the one wiring object the stream handler builds around the
// follow store (createFollowWiring): the hub the Workspace reads, the saved switch,
// the chat tail's Watch link and Stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const { createFollowWiring } = require('../renderer/chat/renderer-follow-store');

const ROW_HTML = '<div class="turn-activity-row" data-turn-activity-row="st1" role="status">'
  + '<span class="status-dot turn-activity-dot"></span><span class="turn-activity-name">Writing</span>'
  + '<span class="turn-activity-label">app.js</span></div>';

function delta(callId, argumentsDelta, extra = {}) {
  return {
    type: 'tool_input_delta', sessionId: 's1', streamId: 'st1', toolCallId: callId, toolName: 'write_file',
    argumentsDelta, argumentsBytes: Buffer.byteLength(argumentsDelta), sequence: 1, ...extra,
  };
}

function makeWiring(t, { flag = true, ide, saved, noShell = false } = {}) {
  const dom = new JSDOM(`<div id="chatTimeline"><article class="chat-entry assistant pending"><div class="chat-message-content">${ROW_HTML}</div></article></div>`);
  const timeline = dom.window.document.getElementById('chatTimeline');
  const views = [];
  const stops = [];
  const asked = { count: 0 };
  const state = {
    currentSessionId: 's1',
    features: { featureFlags: { follow_jenny: flag } },
    ui: { activeView: 'chat', ...(ide === undefined ? {} : { ide }) },
    runtimeSendController: { stopChat: (sessionId) => { stops.push(sessionId); return 'stopped'; } },
  };
  const windowRef = {
    inventoryActionButton: actionButton,
    jennyShell: noShell ? {} : {
      workspaceIde: {
        getState: () => { asked.count += 1; return Promise.resolve(saved); },
      },
    },
  };
  const wiring = createFollowWiring({
    state,
    setActiveView: (view) => { views.push(view); state.ui.activeView = view; },
    getChatTimeline: () => timeline,
    windowRef,
  });
  t.after(() => wiring.dispose());
  return { wiring, state, windowRef, timeline, views, stops, asked, dom };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the wiring publishes one hub: the store and the reply\'s own Stop', (t) => {
  const h = makeWiring(t, { ide: { followJenny: true } });
  const hub = h.windowRef.rendererFollowJennyHub;
  assert.equal(hub.store, h.wiring.store);
  assert.equal(h.wiring.noteStreamEvent, h.wiring.store.noteStreamEvent);
  assert.equal(hub.stop('s1'), 'stopped');
  assert.deepEqual(h.stops, ['s1']);

  h.state.runtimeSendController = null;
  assert.equal(hub.stop('s1'), undefined, 'no send controller: Stop does nothing');
});

test('calls are followed only while the flag and the Workspace switch are both on', (t) => {
  const on = makeWiring(t, { ide: { followJenny: true } });
  on.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"a'));
  assert.equal(on.wiring.store.listCalls().length, 1);

  // Switched off in the Workspace: the store lets go of what it holds and takes no more.
  on.state.ui.ide.followJenny = false;
  on.wiring.store.refreshEnabled();
  assert.equal(on.wiring.store.listCalls().length, 0);
  on.wiring.noteStreamEvent(delta('c2', '{"path":"src/b.js","content":"b'));
  assert.equal(on.wiring.store.listCalls().length, 0);

  const flagOff = makeWiring(t, { flag: false, ide: { followJenny: true } });
  flagOff.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"a'));
  assert.equal(flagOff.wiring.store.listCalls().length, 0);
});

test('before the Workspace has loaded, the saved switch is read once and obeyed', async (t) => {
  const h = makeWiring(t, { saved: { followJenny: false } });
  h.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"a'));
  assert.equal(h.wiring.store.listCalls().length, 1, 'on until the saved answer arrives');

  await settle();
  assert.equal(h.asked.count, 1);
  assert.equal(h.wiring.store.listCalls().length, 0, 'saved off: the call is let go');
  h.wiring.noteStreamEvent(delta('c2', '{"path":"src/b.js","content":"b'));
  assert.equal(h.wiring.store.listCalls().length, 0);
  assert.equal(h.asked.count, 1, 'asked once, not per event');

  // The Workspace state, once it exists, is the live answer.
  h.state.ui.ide = { followJenny: true };
  h.wiring.noteStreamEvent(delta('c3', '{"path":"src/c.js","content":"c'));
  assert.equal(h.wiring.store.listCalls().length, 1);
});

test('a saved state without the key, or no shell bridge at all, means on', async (t) => {
  const absent = makeWiring(t, { saved: {} });
  absent.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"a'));
  await settle();
  assert.equal(absent.wiring.store.listCalls().length, 1);

  const bare = makeWiring(t, { noShell: true });
  bare.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"a'));
  await settle();
  assert.equal(bare.wiring.store.listCalls().length, 1);
});

test('Watch in Workspace asks for the file and switches to the Workspace page', (t) => {
  const h = makeWiring(t, { ide: { followJenny: true } });
  const events = [];
  h.wiring.store.subscribe((event) => events.push(event.type));
  h.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"line 1\\nline 2\\n'));

  const link = h.timeline.querySelector('[data-turn-activity-watch="c1"]');
  assert.ok(link, 'the chat row offers the link');
  link.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));

  assert.deepEqual(h.views, ['ide']);
  assert.ok(events.includes('reveal'));
  assert.equal(h.wiring.store.takePendingReveal(), 'c1', 'the request waits for a Workspace that is still loading');
  assert.equal(h.timeline.querySelector('[data-turn-activity-watch="c1"]'), null, 'on the Workspace page the chat tail steps back');
});

test('a call from another chat gets no tail in this chat\'s timeline', (t) => {
  const h = makeWiring(t, { ide: { followJenny: true } });
  h.wiring.noteStreamEvent(delta('c9', '{"path":"src/app.js","content":"x\\n', { sessionId: 'other', streamId: 'st1' }));
  assert.equal(h.timeline.querySelector('[data-turn-activity-watch]'), null);
});

test('dispose takes the hub down and empties the store, but leaves a newer hub alone', (t) => {
  const h = makeWiring(t, { ide: { followJenny: true } });
  h.wiring.noteStreamEvent(delta('c1', '{"path":"src/app.js","content":"a'));
  h.wiring.dispose();
  assert.equal(h.windowRef.rendererFollowJennyHub, null);
  assert.equal(h.wiring.store.listCalls().length, 0);
  assert.equal(h.timeline.querySelector('.turn-activity-tail, [data-turn-activity-watch]'), null);

  const newer = { store: {} };
  const again = makeWiring(t, { ide: { followJenny: true } });
  again.windowRef.rendererFollowJennyHub = newer;
  again.wiring.dispose();
  assert.equal(again.windowRef.rendererFollowJennyHub, newer);
});
