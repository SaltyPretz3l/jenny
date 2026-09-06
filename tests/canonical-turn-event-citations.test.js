// Citations Step 2 — collector-level tests for the flag-gated
// `source_citations` derive (services/backend/canonical-turn-event-collector.js).
// Lives in its own file: tests/canonical-turn-event-collector.test.js sits at
// the file-size cap.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalTurnEventCollector,
} = require('../services/backend/canonical-turn-event-collector');

function makeStore() {
  const db = { sessions: {} };
  return {
    getSession(sessionId) {
      return db.sessions[sessionId] || null;
    },
    appendTurnEvents(sessionId, events) {
      if (!db.sessions[sessionId]) db.sessions[sessionId] = {};
      if (!db.sessions[sessionId].turn_events) db.sessions[sessionId].turn_events = [];
      db.sessions[sessionId].turn_events.push(...events);
    },
    _db: db,
  };
}

function rawEvent(overrides = {}) {
  return {
    kind: 'tool_use',
    turn_id: 'web',
    event_id: 'evt-1',
    status: 'pending',
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// source_citations derive (Citations Step 2) - flag-gated, collector-derived
// from a web_search tool_result payload (no sidecar wire change).
// ---------------------------------------------------------------------------

function webSearchMessages() {
  return [
    { id: "user_web", role: "user", content: "search the web" },
    {
      id: "tool_use_web",
      role: "assistant",
      kind: "tool_use",
      tool_call: {
        call_id: "call_web",
        tool_name: "web_search",
        parent_stream_id: "web",
        status: "completed",
      },
    },
    {
      id: "tool_result_web",
      role: "tool",
      kind: "tool_result",
      tool_result: {
        call_id: "call_web",
        tool_name: "web_search",
        output_text: "{}",
        is_error: false,
      },
    },
  ];
}

function noteWebSearchPair(collector, payloadExtras = {}) {
  collector.noteEvent(rawEvent({
    kind: "tool_use",
    turn_id: "web",
    event_id: "evt-web-use",
    tool_call_id: "call_web",
    primary_message_id: "tool_use_web",
    status: "completed",
    payload: { tool_name: "web_search" },
  }));
  collector.noteEvent(rawEvent({
    kind: "tool_result",
    turn_id: "web",
    event_id: "evt-web-result",
    tool_call_id: "call_web",
    primary_message_id: "tool_result_web",
    status: "completed",
    payload: {
      tool_name: "web_search",
      output_text: "{}",
      ...payloadExtras,
    },
  }));
}

const WEB_CITATION_PAYLOAD = {
  citations: [
    { id: "web:1", url: "https://example.com/one", title: "One" },
    { id: "web:2", url: "javascript:alert(1)", title: "Evil" },
  ],
  sources: [
    { url: "https://example.com/one", title: "One", snippet: "s1", source_type: "web" },
  ],
};

test("flag ON: a web_search tool_result with citations derives a source_citations event beside it", () => {
  const collector = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-web",
    featureFlags: { source_citations: true },
  });
  noteWebSearchPair(collector, WEB_CITATION_PAYLOAD);
  const events = collector.buildFinalizedTurnEvents("web", webSearchMessages());
  const kinds = events.map((event) => event.kind);
  const citationIndex = kinds.indexOf("source_citations");
  assert.notEqual(citationIndex, -1, "derived event persisted");
  assert.ok(citationIndex > kinds.indexOf("tool_result"), "ordered after the producing tool_result");
  const citation = events[citationIndex];
  assert.equal(citation.tool_call_id, "call_web");
  assert.equal(citation.payload.refs.length, 1, "normalizer dropped the javascript: ref and deduped");
  assert.equal(citation.payload.refs[0].url, "https://example.com/one");
  assert.equal(citation.payload.refs[0].snippet, "s1");
});

test("flag OFF (default): no source_citations event is derived - byte-identical", () => {
  const withFlagOff = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-web",
  });
  noteWebSearchPair(withFlagOff, WEB_CITATION_PAYLOAD);
  const flagOffEvents = withFlagOff.buildFinalizedTurnEvents("web", webSearchMessages());
  assert.equal(flagOffEvents.some((event) => event.kind === "source_citations"), false);

  const baseline = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-web",
  });
  noteWebSearchPair(baseline, WEB_CITATION_PAYLOAD);
  assert.deepEqual(
    JSON.parse(JSON.stringify(flagOffEvents)),
    JSON.parse(JSON.stringify(baseline.buildFinalizedTurnEvents("web", webSearchMessages()))),
    "flag-off output identical to a collector that never saw the flag"
  );
});

test("flag ON: a tool_result without citations derives nothing", () => {
  const collector = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-web",
    featureFlags: { source_citations: true },
  });
  noteWebSearchPair(collector, {});
  const events = collector.buildFinalizedTurnEvents("web", webSearchMessages());
  assert.equal(events.some((event) => event.kind === "source_citations"), false);
});

test("flag ON: repeated noteEvent of the same tool_result derives one citations event (idempotent)", () => {
  const collector = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-web",
    featureFlags: { source_citations: true },
  });
  noteWebSearchPair(collector, WEB_CITATION_PAYLOAD);
  noteWebSearchPair(collector, WEB_CITATION_PAYLOAD);
  const events = collector.buildFinalizedTurnEvents("web", webSearchMessages());
  assert.equal(events.filter((event) => event.kind === "source_citations").length, 1);
});

// ---------------------------------------------------------------------------
// Review-P0 regression: the LIVE wire never carries structured
// `sources`/`citations` keys. chat-stream-tool-handling.js builds the noteEvent
// payload from a fixed whitelist, and the web tool's whole payload arrives as
// JSON text in `output_text`. The derive must fire from THAT shape.
// ---------------------------------------------------------------------------

const LIVE_WEB_TOOL_OUTPUT = JSON.stringify({
  query: "jenny electron",
  provider: "ddg",
  results: [{ title: "One", url: "https://example.com/one", snippet: "s1" }],
  sources: [{ url: "https://example.com/one", title: "One", snippet: "s1", source_type: "web" }],
  citations: [{ id: "web:1", url: "https://example.com/one", title: "One" }],
});

test("flag ON: live wire shape (citations only as JSON inside output_text) still derives", () => {
  const collector = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-web",
    featureFlags: { source_citations: true },
  });
  // Exactly the handler whitelist — NO structured sources/citations keys;
  // the citations exist only inside the serialized output_text JSON.
  collector.noteEvent(rawEvent({
    kind: "tool_use",
    turn_id: "web",
    event_id: "evt-web-use",
    tool_call_id: "call_web",
    primary_message_id: "tool_use_web",
    status: "completed",
    payload: { tool_name: "web_search" },
  }));
  collector.noteEvent(rawEvent({
    kind: "tool_result",
    turn_id: "web",
    event_id: "evt-web-result",
    tool_call_id: "call_web",
    primary_message_id: "tool_result_web",
    status: "completed",
    payload: {
      tool_name: "web_search",
      output_text: LIVE_WEB_TOOL_OUTPUT,
      summary: "Web Search",
      is_error: false,
      error_code: "",
      approval_state: "auto",
      parent_stream_id: "web",
      generated_artifacts: [],
    },
  }));
  const events = collector.buildFinalizedTurnEvents("web", webSearchMessages());
  const citation = events.find((event) => event.kind === "source_citations");
  assert.ok(citation, "derive fires from the live output_text-only shape");
  assert.equal(citation.payload.refs.length, 1);
  assert.equal(citation.payload.refs[0].url, "https://example.com/one");
  assert.equal(citation.payload.refs[0].snippet, "s1");
});

test("e2e: the ACTUAL tool.result handler drives a real collector and the derive fires", () => {
  const { handleToolNotification } = require("../services/backend/chat-stream-tool-handling");
  const os = require("node:os");
  const messagesBySession = new Map([["sess-e2e", [
    { id: "user_web", role: "user", content: "search the web" },
  ]]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || "") === String(messageId || ""));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: "mock-model",
    options: { userDataPath: os.tmpdir() },
  };
  const collector = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-e2e",
    featureFlags: { source_citations: true },
  });
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: "mock-model",
    resolvedSessionId: "sess-e2e",
    streamId: "web",
    eventBase: { sessionId: "sess-e2e", streamId: "web", model: "mock-model" },
    turnEventCollector: collector,
  };
  handleToolNotification(service, context, {
    method: "tool.result",
    params: {
      request_id: "web",
      tool_call_id: "call_web",
      tool_name: "web_search",
      success: true,
      output: LIVE_WEB_TOOL_OUTPUT,
    },
  });
  const captured = collector.capturedEvents;
  const toolResultIndex = captured.findIndex((event) => event.kind === "tool_result");
  const citationIndex = captured.findIndex((event) => event.kind === "source_citations");
  assert.notEqual(toolResultIndex, -1, "handler noted the tool_result");
  assert.notEqual(citationIndex, -1, "derive fired from the handler-built payload");
  assert.ok(citationIndex > toolResultIndex, "derived event captured after the producing tool_result");
  const citation = captured[citationIndex];
  assert.equal(citation.tool_call_id, "call_web");
  assert.equal(citation.payload.refs.length, 1);
  assert.equal(citation.payload.refs[0].url, "https://example.com/one");
  assert.equal(citation.payload.refs[0].snippet, "s1");
  const events = collector.buildFinalizedTurnEvents("web", sessionStore.getSessionMessages("sess-e2e"));
  const persisted = events.find((event) => event.kind === "source_citations");
  assert.ok(persisted, "derived event survives finalize/merge into turn_events[]");
});

test("e2e flag OFF: same handler drive derives nothing", () => {
  const { handleToolNotification } = require("../services/backend/chat-stream-tool-handling");
  const os = require("node:os");
  const messagesBySession = new Map([["sess-e2e-off", [
    { id: "user_web", role: "user", content: "search the web" },
  ]]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage() {},
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: "mock-model",
    options: { userDataPath: os.tmpdir() },
  };
  const collector = new CanonicalTurnEventCollector({
    store: makeStore(),
    turnId: "web",
    sessionId: "sess-e2e-off",
  });
  handleToolNotification(service, {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: "mock-model",
    resolvedSessionId: "sess-e2e-off",
    streamId: "web",
    eventBase: { sessionId: "sess-e2e-off", streamId: "web", model: "mock-model" },
    turnEventCollector: collector,
  }, {
    method: "tool.result",
    params: {
      request_id: "web",
      tool_call_id: "call_web",
      tool_name: "web_search",
      success: true,
      output: LIVE_WEB_TOOL_OUTPUT,
    },
  });
  assert.equal(collector.capturedEvents.some((event) => event.kind === "source_citations"), false);
});
