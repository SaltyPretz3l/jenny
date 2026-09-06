'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
const { morphChildren } = require('../renderer/chat/renderer-stream-dom-patch-utils');
const {
  applyTurnStreamEvent,
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
} = require('../renderer/chat/renderer-turn-reducer');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'timeline-replay');
const DETERMINISTIC_ROW_OPTIONS = Object.freeze({ deterministicRowId: true });
const SCENARIOS = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildPersistedTurnEvents(projectedTurns) {
  let nextSeq = 0;
  const turns = Array.isArray(projectedTurns?.turns) ? projectedTurns.turns : [];
  return turns.flatMap((turn) => (
    Array.isArray(turn?.events) ? turn.events.map((event) => ({
      event_id: event.event_id,
      event_seq: nextSeq++,
      turn_id: event.turn_id,
      kind: event.kind,
      status: event.status || '',
      primary_message_id: event.primary_message_id || '',
      source_message_ids: Array.isArray(event.source_message_ids)
        ? event.source_message_ids.slice()
        : [],
      target_message_id: '',
      tool_call_id: event.tool_call_id || '',
      segment_group_index: event.segment_group_index ?? null,
      phase_id: event.phase_id || '',
      started_at: event.payload?.started_at || '',
      completed_at: event.payload?.completed_at || '',
      payload: JSON.parse(JSON.stringify(event.payload || {})),
    })) : []
  ));
}

function replayStreamEvents(streamEvents) {
  const reducerState = createTurnReducerState(DETERMINISTIC_ROW_OPTIONS);
  const events = Array.isArray(streamEvents) ? streamEvents : [];
  for (let index = 0; index < events.length; index += 1) {
    const entry = events[index] && typeof events[index] === 'object' ? events[index] : {};
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
    const context = entry.context && typeof entry.context === 'object' ? entry.context : {};
    const reducerEvents = buildTurnEventFromStreamPayload(payload, context);
    applyTurnStreamEvent(reducerState, reducerEvents);
  }
  return reducerState;
}

function resolveReplayTurnId(streamEvents) {
  const firstEntry = streamEvents.find((entry) => entry && typeof entry === 'object') || {};
  return String(
    firstEntry?.context?.turn_id
    || firstEntry?.payload?.streamId
    || firstEntry?.payload?.requestId
    || firstEntry?.payload?.request_id
    || ''
  ).trim();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stablePayloadMarker(row) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const value = payload.text
    || payload.summary
    || payload.tool_name
    || payload.state
    || payload.status
    || payload.prompt
    || payload.output_text
    || '';
  // Plan rows carry a summary, which would mask a live-vs-hydrated state
  // divergence (pending vs approved) behind an identical marker — keep the
  // state visible for this kind only.
  if (String(row?.kind || '') === 'plan_document') {
    return `${String(payload.state || '')}|${String(value)}`.slice(0, 80);
  }
  return String(value).slice(0, 80);
}

const rowListUtils = createTurnRowListUtils({
  buildRowBodyMarkup(row) {
    const kind = String(row?.kind || 'unknown');
    return `<span class="timeline-replay-row-marker" data-marker-kind="${escapeHtml(kind)}"`
      + ` data-marker-payload="${escapeHtml(stablePayloadMarker(row))}">${escapeHtml(kind)}</span>`;
  },
});

function loadScenario(scenarioName) {
  const scenarioDir = path.join(FIXTURE_ROOT, scenarioName);
  const messages = normalizeChatMessages(readJson(path.join(scenarioDir, 'session.json')));
  const projectedTurns = projectTurnTree({ messages });
  const hydratedTurns = projectTurnTree({
    messages,
    turn_event_log_version: 1,
    turn_events: buildPersistedTurnEvents(projectedTurns),
  });
  return {
    messages,
    projectedRows: projectedTurns.turns.map((turn) => ({
      turn_id: turn.turn_id,
      rows: projectTurnRows(turn.events, DETERMINISTIC_ROW_OPTIONS),
    })),
    hydratedRowsFromTurnEvents: hydratedTurns.turns.map((turn) => ({
      turn_id: turn.turn_id,
      rows: projectTurnRows(turn.events, DETERMINISTIC_ROW_OPTIONS),
    })),
  };
}

function renderRows(rows, messages) {
  return rowListUtils.buildTurnRowListMarkup(rows, messages, {
    responseLoopDisplayV2: false,
    turnRows: rows,
  });
}

function createMarkupHost(markup) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  host.innerHTML = markup;
  return { dom, host };
}

// Attributes that the live reducer and the hydrated projector are KNOWN to
// render differently for the same row_id, measured against this corpus. Two
// families today:
//
//   data-source-message-ids  -- HALF CLOSED (Wave 3c). The live reducer used to
//     attribute both the tool_use and the tool_result message to BOTH rows; the
//     tool_call side now takes only its own, matching the hydrated projector. The
//     live tool_result row still carries both, so its two entries remain.
//   data-chat-row-v2-*       -- the live approval_gap row carries the v2 chrome
//     (state, tone, summary text); after hydration every one of them is absent.
//
// This is the divergence Wave 3 exists to remove. The aggregate test below
// asserts this list EXACTLY, not as a subset: when a fold change fixes one of
// these, its entry must be deleted here in the same commit, the same way the
// complexity ratchets must be lowered when they drop.
const DIVERGENCE_LEDGER = [
  'data-chat-row-v2-kind @ 22-approval-pending/approval_gap',
  'data-chat-row-v2-state @ 22-approval-pending/approval_gap',
  'data-chat-row-v2-summary-kind @ 22-approval-pending/approval_gap',
  'data-chat-row-v2-summary-text @ 22-approval-pending/approval_gap',
  'data-chat-row-v2-target-kind @ 22-approval-pending/approval_gap',
  'data-chat-row-v2-tone @ 22-approval-pending/approval_gap',
  'data-source-message-ids @ 07-tool-use-error-invalid-args/tool_result',
  'data-source-message-ids @ 18-stream-events-tool-call-trace/tool_result',
  // Scenario 29 exhibits the same half-closed tool_result family as 07/18 —
  // the plan_document row itself renders in lockstep.
  'data-source-message-ids @ 29-plan-approval-document/tool_result',
];

const LEDGER_ATTRIBUTES = new Set(DIVERGENCE_LEDGER.map((site) => site.split(' @ ')[0]));

function collectLiveHydratedRowPairs(scenarioName, scenario) {
  const streamEvents = readJson(path.join(FIXTURE_ROOT, scenarioName, 'stream-events.json'));
  const turnId = resolveReplayTurnId(streamEvents);
  assert.ok(turnId, `${scenarioName} stream-events fixture should identify the replay turn`);
  const liveRows = replayStreamEvents(streamEvents).turns_by_id[turnId]?.rows || [];
  const hydrated = scenario.hydratedRowsFromTurnEvents.find((turn) => turn.turn_id === turnId);
  assert.ok(hydrated, `expected hydrated rows for turn ${turnId}`);
  return liveRows.map((liveRow) => ({
    rowId: liveRow.row_id,
    kind: liveRow.kind,
    liveRow,
    hydratedRow: hydrated.rows.find((row) => row.row_id === liveRow.row_id) || null,
  }));
}

function renderRowHost(row, messages) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  dom.window.document.getElementById('host').innerHTML = renderRows([row], messages);
  return dom;
}

// Renders one live row and its hydrated twin, reports every attribute that
// differs as a "<attr> @ <scenario>/<kind>" site, then strips the ledgered
// attributes from both sides and hands back the remaining markup. Anything that
// still differs -- text, structure, or an undeclared attribute -- is a real
// regression rather than a known gap.
function diffRenderedRow(scenarioName, pair, messages) {
  const liveDom = renderRowHost(pair.liveRow, messages);
  const hydratedDom = renderRowHost(pair.hydratedRow, messages);
  try {
    const liveEls = Array.from(liveDom.window.document.querySelectorAll('*'));
    const hydratedEls = Array.from(hydratedDom.window.document.querySelectorAll('*'));
    const sites = new Set();
    if (liveEls.length !== hydratedEls.length) {
      sites.add(`<element-count> @ ${scenarioName}/${pair.kind}`);
    }
    const shared = Math.min(liveEls.length, hydratedEls.length);
    for (let index = 0; index < shared; index += 1) {
      const names = new Set([
        ...liveEls[index].getAttributeNames(),
        ...hydratedEls[index].getAttributeNames(),
      ]);
      for (const name of names) {
        if (liveEls[index].getAttribute(name) !== hydratedEls[index].getAttribute(name)) {
          sites.add(`${name} @ ${scenarioName}/${pair.kind}`);
        }
      }
    }
    for (const element of [...liveEls, ...hydratedEls]) {
      for (const name of LEDGER_ATTRIBUTES) {
        element.removeAttribute(name);
      }
    }
    return {
      sites: Array.from(sites).sort(),
      liveHtml: liveDom.window.document.getElementById('host').innerHTML,
      hydratedHtml: hydratedDom.window.document.getElementById('host').innerHTML,
    };
  } finally {
    liveDom.window.close();
    hydratedDom.window.close();
  }
}

for (const scenarioName of SCENARIOS) {
  test(`P1 ${scenarioName}: rendered row identity is unique and complete`, () => {
    const scenario = loadScenario(scenarioName);
    for (const turn of scenario.projectedRows) {
      const { dom, host } = createMarkupHost(renderRows(turn.rows, scenario.messages));
      const renderedRows = Array.from(host.querySelectorAll('.chat-row'));
      assert.ok(renderedRows.length > 0, `${turn.turn_id} should render at least one row`);
      const rowIds = renderedRows.map((row) => row.getAttribute('data-row-id')?.trim() || '');
      assert.ok(rowIds.every(Boolean), `${turn.turn_id} should give every rendered row a data-row-id`);
      assert.equal(new Set(rowIds).size, rowIds.length, `${turn.turn_id} should not duplicate data-row-id`);
      dom.window.close();
    }
  });

  const streamEventsPath = path.join(FIXTURE_ROOT, scenarioName, 'stream-events.json');
  if (fs.existsSync(streamEventsPath)) {
    test(`P2 ${scenarioName}: live rows render in lockstep with their hydrated twins`, () => {
      const scenario = loadScenario(scenarioName);
      const pairs = collectLiveHydratedRowPairs(scenarioName, scenario);
      assert.ok(pairs.length > 0, `${scenarioName} should replay at least one live reducer row`);
      if (scenarioName === '28-reasoning-replay-after-text') {
        assert.deepEqual(
          pairs.map((pair) => pair.kind),
          ['reasoning', 'assistant_text'],
          'scenario 28 must exercise both deterministic non-tool row anchors',
        );
      }
      for (const pair of pairs) {
        // Row identity is the contract the keyed morph rests on: a live row with
        // no hydrated twin under the same row_id is a row the morph deletes and
        // re-creates on settle, which is the terminal-blink class.
        assert.ok(pair.hydratedRow, `live row ${pair.rowId} should have a hydrated twin`);
        const diff = diffRenderedRow(scenarioName, pair, scenario.messages);
        assert.deepEqual(
          diff.sites.filter((site) => !DIVERGENCE_LEDGER.includes(site)),
          [],
          `${scenarioName}/${pair.kind}: undeclared live-vs-hydrated divergence`,
        );
        assert.equal(
          diff.liveHtml,
          diff.hydratedHtml,
          `${scenarioName}/${pair.kind}: markup diverges outside the ledgered attributes`,
        );
      }
    });
  }

  test(`P3 ${scenarioName}: identical row-list morph is idempotent`, () => {
    const scenario = loadScenario(scenarioName);
    for (const turn of scenario.projectedRows) {
      const markup = renderRows(turn.rows, scenario.messages);
      const target = createMarkupHost(markup);
      const source = createMarkupHost(markup);
      const firstRowBefore = target.host.querySelector('.chat-row');
      const stats = { reused: 0, cloned: 0, removed: 0 };

      assert.ok(firstRowBefore, `${turn.turn_id} should render a row for the identity assertion`);
      morphChildren(target.host, source.host, stats);

      assert.equal(stats.removed, 0, `${turn.turn_id} should remove no nodes`);
      assert.equal(stats.cloned, 0, `${turn.turn_id} should clone no nodes`);
      assert.ok(stats.reused > 0, `${turn.turn_id} should reuse nodes`);
      assert.strictEqual(target.host.querySelector('.chat-row'), firstRowBefore);
      target.dom.window.close();
      source.dom.window.close();
    }
  });

  test(`P4 ${scenarioName}: prefix-to-full row-list morph converges`, () => {
    const scenario = loadScenario(scenarioName);
    for (const turn of scenario.projectedRows) {
      const prefixRows = turn.rows.slice(0, Math.max(0, turn.rows.length - 1));
      if (prefixRows.length === 0) continue;
      assert.ok(prefixRows.length < turn.rows.length, `${turn.turn_id} should use a proper row prefix`);
      const target = createMarkupHost(renderRows(prefixRows, scenario.messages));
      const full = createMarkupHost(renderRows(turn.rows, scenario.messages));

      morphChildren(target.host, full.host);

      assert.equal(
        target.host.innerHTML,
        full.host.innerHTML,
        `${turn.turn_id} should converge to a fresh full render`,
      );
      target.dom.window.close();
      full.dom.window.close();
    }
  });
}

// Exact-match, not subset: a Wave 3 fold change that removes a divergence turns
// this red, forcing the ledger to shrink deliberately in the same commit rather
// than leaving a stale entry that quietly re-permits the bug later.
test('P2 aggregate: the live-vs-hydrated divergence ledger is exact', () => {
  const observed = new Set();
  for (const scenarioName of SCENARIOS) {
    if (!fs.existsSync(path.join(FIXTURE_ROOT, scenarioName, 'stream-events.json'))) continue;
    const scenario = loadScenario(scenarioName);
    for (const pair of collectLiveHydratedRowPairs(scenarioName, scenario)) {
      if (!pair.hydratedRow) continue;
      for (const site of diffRenderedRow(scenarioName, pair, scenario.messages).sites) {
        observed.add(site);
      }
    }
  }
  assert.deepEqual(
    Array.from(observed).sort(),
    DIVERGENCE_LEDGER.slice().sort(),
    'live-vs-hydrated divergence changed: update DIVERGENCE_LEDGER in the same commit',
  );
});
