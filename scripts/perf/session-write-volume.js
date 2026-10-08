'use strict';

// Headless measurement of what one chat turn costs the session store on disk.
// Seeds a session to a target size, runs a short turn and a tool-heavy turn
// through the real ElectronSessionStore and its conversation-store port, and
// reports the bytes and synchronous time the whole-file rewrites spend, next
// to the bytes a content-based journal would have appended instead.
//
// Stand-ins for production steps (the real claim/commit needs the whole chat
// stream stack): store.setTurnIdentity + store.setActiveTurn + flushSession
// stand in for the session-turn-actor claim, port.appendMessage/updateMessage
// for the lifecycle adapter's message writes, and port.commitTerminal with a
// hand-built identity for the terminal coordinator's commit.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');

const SESSION_ID = 'sess_bench';
const TURN_EVENT_SEED_CAP = 3000;
const WRITE_DEBOUNCE_MS = 500;
const PROBE_BYTES = 200_000;
const TURN_EVENT_LOG_NOTE = 'session_store.turn_write_volume';
const WORDS = [
  'the', 'session', 'store', 'writes', 'every', 'message', 'to', 'disk', 'tool', 'result', 'stream',
  'chunk', 'file', 'index', 'turn', 'commit', 'model', 'answer', 'context', 'window', 'review',
  'patch', 'function', 'module', 'value', 'check', 'build', 'local', 'engine', 'output',
];

function filler(bytes, salt) {
  const parts = [];
  let length = 0;
  let cursor = salt;
  while (length < bytes) {
    cursor = (cursor * 1103515245 + 12345) & 0x7fffffff;
    const word = WORDS[cursor % WORDS.length];
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ').slice(0, bytes);
}

// Lets the debounce timer fire so the write goes down the background path
// (store.flushAsync would instead write dirty sessions synchronously).
async function waitDebounceWindow(store) {
  await new Promise((resolve) => setTimeout(resolve, WRITE_DEBOUNCE_MS + 25));
  // The backend's dirty-session set stays set until a durable flush, so poll
  // the file stores themselves.
  while (store.store.hasPendingWrite() || store._backend._sessionStores.get(SESSION_ID)?.hasPendingWrite()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageAt(index) {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const kind = index % 4;
  if (kind === 0) {
    return { id: `seed_u_${index}`, role: 'user', content: filler(2000, index), timestamp: stamp };
  }
  if (kind === 1) {
    return { id: `seed_a_${index}`, role: 'assistant', content: filler(2000, index), timestamp: stamp, status: 'complete' };
  }
  const callId = `seed_call_${index >> 2}`;
  if (kind === 2) {
    return {
      id: `seed_tu_${index}`, role: 'assistant', kind: 'tool_use', content: '', timestamp: stamp, status: 'complete',
      tool_call: { call_id: callId, tool_name: 'read_file', status: 'complete', arguments: { path: `src/m${index}.js` } },
    };
  }
  return {
    id: `seed_tr_${index}`, role: 'assistant', kind: 'tool_result', content: '', timestamp: stamp,
    tool_result: { call_id: callId, tool_name: 'read_file', output_text: filler(2000, index), summary: 'read file' },
  };
}

function turnEvent(turnId, eventId, kind, messageId) {
  return {
    event_id: eventId, turn_id: turnId, kind, primary_message_id: messageId, source_message_ids: [messageId],
    payload: { content: filler(240, eventId.length) },
  };
}

function sessionFileBytes(rootDir) {
  return fs.statSync(path.join(rootDir, 'sessions', `${SESSION_ID}.json`)).size;
}

// Seeds to ~targetBytes on disk. The first pass is a small probe sized by the
// serialized message length; later passes rescale by the observed on-disk ratio.
function seedSession(store, rootDir, targetBytes) {
  store.createSessionWithId(SESSION_ID, { title: 'Write volume bench' });
  const messages = [];
  let estimated = 0;
  let wanted = Math.min(targetBytes, PROBE_BYTES);
  for (let pass = 0; pass < 4; pass += 1) {
    while (estimated < wanted) {
      const message = messageAt(messages.length);
      messages.push(message);
      estimated += Buffer.byteLength(JSON.stringify(message), 'utf8');
    }
    store.replaceMessages(SESSION_ID, messages);
    store.flushSession(SESSION_ID);
    const actual = sessionFileBytes(rootDir);
    if (actual >= targetBytes * 0.97) break;
    wanted = Math.ceil(estimated * (targetBytes / actual));
  }
  const events = [];
  for (let index = 1; index < messages.length && events.length < TURN_EVENT_SEED_CAP; index += 4) {
    events.push(turnEvent(`seed_turn_${index >> 2}`, `seed_evt_${index}`, 'assistant_text', messages[index].id));
  }
  if (events.length) store.appendTurnEvents(SESSION_ID, events, { durable: true });
  store.flushSession(SESSION_ID);
  return sessionFileBytes(rootDir);
}

// Content-based journal model: serialize each message, each turn event and each
// other top-level field; a mutation costs the bytes of the entries whose
// serialized form differs from the previous persisted state.
function serializeSession(session) {
  const fields = new Map();
  for (const [key, value] of Object.entries(session)) {
    if (key === 'messages' || key === 'turn_events') continue;
    fields.set(key, JSON.stringify(value) ?? 'null');
  }
  return {
    messages: (session.messages || []).map((entry) => JSON.stringify(entry)),
    events: (session.turn_events || []).map((entry) => JSON.stringify(entry)),
    fields,
  };
}

function changedBytes(previous, next) {
  let total = 0;
  for (const kind of ['messages', 'events']) {
    next[kind].forEach((text, index) => {
      if (previous[kind][index] !== text) total += Buffer.byteLength(text, 'utf8');
    });
  }
  for (const [key, text] of next.fields) {
    if (previous.fields.get(key) !== text) total += Buffer.byteLength(key, 'utf8') + 3 + Buffer.byteLength(text, 'utf8');
  }
  return total;
}

function createDeltaTracker(store) {
  let previous = serializeSession(store.getSession(SESSION_ID));
  let total = 0;
  let largest = 0;
  return {
    mark() {
      const next = serializeSession(store.getSession(SESSION_ID));
      const delta = changedBytes(previous, next);
      previous = next;
      total += delta;
      if (delta > largest) largest = delta;
    },
    takeTurn() {
      const result = { total, largest };
      total = 0;
      largest = 0;
      return result;
    },
  };
}

function mergeVolume(first, second) {
  const merged = { ...first };
  for (const key of Object.keys(second)) {
    if (key === 'last_session_bytes') continue;
    merged[key] = key.endsWith('_max_sync_ms')
      ? Math.max(first[key] || 0, second[key])
      : Math.round(((first[key] || 0) + second[key]) * 10) / 10;
  }
  return merged;
}

function assertCommitted(label, result) {
  if (!result || result.ok !== true) {
    throw new Error(`bench step "${label}" was refused: ${result?.reason || 'unknown'}`);
  }
}

async function runTurn({ store, rootDir, delta, drainVolume, logs, kind, turnNumber, toolPairs }) {
  const port = store.conversationStore;
  const session = store.getSession(SESSION_ID);
  const incarnation = session.session_incarnation;
  const turnId = `bench_turn_${turnNumber}`;
  const streamId = `bench_stream_${turnNumber}`;
  const userMessageId = `bench_user_${turnNumber}`;
  const sizeBefore = sessionFileBytes(rootDir);
  drainVolume();
  delta.takeTurn();
  const stamp = (offset) => new Date(Date.UTC(2026, 6, 1, 0, turnNumber, offset)).toISOString();
  let mutations = 0;
  const step = () => { mutations += 1; delta.mark(); };

  store.setTurnIdentity(SESSION_ID, { session_incarnation: incarnation, turn_generation: turnNumber });
  step();
  store.setActiveTurn(SESSION_ID, {
    request_id: turnId, stream_id: streamId, turn_id: turnId, user_message_id: userMessageId,
    session_incarnation: incarnation, generation: turnNumber, started_at: stamp(0),
    last_event_at: stamp(0), status: 'awaiting_assistant',
  }, { expectedPriorStreamId: streamId });
  step();
  store.flushSession(SESSION_ID);
  assertCommitted('user message', port.appendMessage(SESSION_ID, {
    id: userMessageId, role: 'user', content: filler(2000, turnNumber), timestamp: stamp(1),
  }));
  step();
  // A first-token delay longer than one debounce window.
  await waitDebounceWindow(store);

  const events = [];
  const pairs = kind === 'tool_heavy' ? toolPairs : 0;
  for (let pair = 0; pair < pairs; pair += 1) {
    const callId = `bench_call_${turnNumber}_${pair}`;
    const toolUseId = `bench_tu_${turnNumber}_${pair}`;
    const toolResultId = `bench_tr_${turnNumber}_${pair}`;
    const textId = `bench_at_${turnNumber}_${pair}`;
    assertCommitted('tool_use', port.appendMessage(SESSION_ID, {
      id: toolUseId, role: 'assistant', kind: 'tool_use', content: '', timestamp: stamp(2 + pair), status: 'running',
      tool_call: { call_id: callId, tool_name: 'read_file', status: 'running', arguments: { path: `src/p${pair}.js` } },
    }));
    step();
    assertCommitted('tool_use complete', port.updateMessage(SESSION_ID, toolUseId, {
      status: 'complete', tool_call: { status: 'complete' },
    }));
    step();
    assertCommitted('tool_result', port.appendMessage(SESSION_ID, {
      id: toolResultId, role: 'assistant', kind: 'tool_result', content: '', timestamp: stamp(2 + pair),
      tool_result: { call_id: callId, tool_name: 'read_file', output_text: filler(2000, pair + 7), summary: 'read file' },
    }));
    step();
    assertCommitted('assistant segment', port.appendMessage(SESSION_ID, {
      id: textId, role: 'assistant', content: filler(600, pair + 3), timestamp: stamp(2 + pair), status: 'streaming',
    }));
    step();
    store.touchActiveTurn(SESSION_ID, { request_id: turnId, stream_id: streamId }, {
      status: 'streaming', last_event_at: stamp(3 + pair),
    });
    step();
    events.push(turnEvent(turnId, `bench_evt_tool_${turnNumber}_${pair}`, 'tool_result', toolResultId));
    // One debounce window per pair, the way a pair every >500 ms would land.
    await waitDebounceWindow(store);
  }
  if (!pairs) {
    store.touchActiveTurn(SESSION_ID, { request_id: turnId, stream_id: streamId }, {
      status: 'streaming', last_event_at: stamp(2),
    });
    step();
  }

  const finalId = `bench_final_${turnNumber}`;
  events.push(turnEvent(turnId, `bench_evt_final_${turnNumber}`, 'assistant_text', finalId));
  assertCommitted('terminal commit', port.commitTerminal(SESSION_ID, {
    identity: {
      sessionId: SESSION_ID, sessionIncarnation: incarnation, generation: turnNumber,
      turnId, streamId, userMessageId,
    },
    messages: [{
      id: finalId, role: 'assistant', content: filler(2000, turnNumber + 11), timestamp: stamp(900), status: 'complete',
    }],
    toolRepairs: [],
    turnEvents: events,
    preferencePatch: {},
    title: null,
    clearActiveTurnMatch: {
      requestId: turnId, streamId, turnId, sessionIncarnation: incarnation,
      generation: turnNumber, userMessageId,
    },
  }, { durable: true }));
  step();

  const logged = logs.filter((entry) => entry.event === TURN_EVENT_LOG_NOTE).pop();
  if (!logged) throw new Error('commitTerminal did not log session_store.turn_write_volume');
  logs.length = 0;
  // Not store.flushAsync(): that is the shutdown / backup flush, which also
  // compacts every journal into its base. A turn in the app does not do that.
  await waitDebounceWindow(store);
  const trailing = drainVolume();
  const volume = mergeVolume(logged.details, trailing);
  const { total, largest } = delta.takeTurn();
  const bytesWritten = volume.session_bytes + volume.index_bytes;
  return {
    turn: kind,
    session_size_bytes: sizeBefore,
    mutations,
    session_bytes: volume.session_bytes,
    session_writes: volume.session_writes,
    session_sync_writes: volume.session_sync_writes,
    session_debounced_writes: volume.session_writes - volume.session_sync_writes,
    index_bytes: volume.index_bytes,
    index_writes: volume.index_writes,
    sync_ms_total: Math.round((volume.session_sync_ms + volume.index_sync_ms) * 10) / 10,
    sync_ms_max: Math.max(volume.session_max_sync_ms, volume.index_max_sync_ms),
    serialize_ms_total: Math.round((volume.session_serialize_ms + volume.index_serialize_ms) * 10) / 10,
    write_ratio: Math.round((bytesWritten / sizeBefore) * 100) / 100,
    content_delta_bytes: total,
    content_delta_max_bytes: largest,
  };
}

async function benchOneSize(sizeMb, { toolPairs, otherSessions, tmpRoot, log }) {
  const rootDir = fs.mkdtempSync(path.join(tmpRoot, 'jenny-write-volume-'));
  const logs = [];
  const store = new ElectronSessionStore(path.join(rootDir, 'sessions.json'), {
    writeDebounceMs: WRITE_DEBOUNCE_MS,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  try {
    // The index lists every session and is rewritten whole, so its cost
    // depends on how many chats the profile holds.
    for (let other = 0; other < otherSessions; other += 1) {
      store.createSession({ title: `Other chat ${other} with a typical title length` });
    }
    log(`seeding ${sizeMb} MB session`);
    const seeded = seedSession(store, rootDir, Math.round(sizeMb * 1024 * 1024));
    log(`seeded ${(seeded / (1024 * 1024)).toFixed(2)} MB on disk`);
    const delta = createDeltaTracker(store);
    const drainVolume = () => store._backend.takeTurnWriteVolume(SESSION_ID);
    const rows = [];
    const kinds = ['short', 'tool_heavy'];
    for (let index = 0; index < kinds.length; index += 1) {
      log(`running ${kinds[index]} turn`);
      const row = await runTurn({
        store, rootDir, delta, drainVolume, logs, kind: kinds[index], turnNumber: index + 1, toolPairs,
      });
      rows.push({ size_mb_target: sizeMb, ...row });
    }
    return rows;
  } finally {
    await store.disposeAsync();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function runBench({
  sizesMb = [0.5, 5, 20], toolPairs = 20, otherSessions = 0, log = () => {}, tmpRoot = os.tmpdir(),
} = {}) {
  const rows = [];
  for (const sizeMb of sizesMb) {
    rows.push(...await benchOneSize(sizeMb, { toolPairs, otherSessions, tmpRoot, log }));
  }
  return rows;
}

const COLUMNS = [
  ['size_mb_target', 'target MB'],
  ['session_size_bytes', 'session bytes'],
  ['turn', 'turn'],
  ['mutations', 'mutations'],
  ['session_bytes', 'session bytes written'],
  ['session_writes', 'session writes'],
  ['session_sync_writes', 'sync'],
  ['session_debounced_writes', 'debounced'],
  ['index_bytes', 'index bytes written'],
  ['index_writes', 'index writes'],
  ['sync_ms_total', 'sync ms'],
  ['sync_ms_max', 'max sync ms'],
  ['serialize_ms_total', 'stringify ms (all writes)'],
  ['write_ratio', 'written / size'],
  ['content_delta_bytes', 'content delta'],
  ['content_delta_max_bytes', 'max delta'],
];

function formatMarkdownTable(rows) {
  const lines = [
    `| ${COLUMNS.map(([, title]) => title).join(' | ')} |`,
    `| ${COLUMNS.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${COLUMNS.map(([key]) => String(row[key])).join(' | ')} |`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { sizesMb: [0.5, 5, 20], toolPairs: 20, otherSessions: 0, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--sizes') {
      options.sizesMb = String(argv[index += 1] || '').split(',').map(Number);
    } else if (arg === '--tool-pairs') {
      options.toolPairs = Number(argv[index += 1]);
    } else if (arg === '--other-sessions') {
      options.otherSessions = Number(argv[index += 1]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.sizesMb.length || options.sizesMb.some((size) => !(size > 0))) {
    throw new Error('--sizes needs positive megabyte values, for example 0.5,5,20');
  }
  if (!Number.isInteger(options.toolPairs) || options.toolPairs < 0) {
    throw new Error('--tool-pairs needs a non-negative integer');
  }
  if (!Number.isInteger(options.otherSessions) || options.otherSessions < 0) {
    throw new Error('--other-sessions needs a non-negative integer');
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const rows = await runBench({
    sizesMb: options.sizesMb,
    toolPairs: options.toolPairs,
    otherSessions: options.otherSessions,
    log: (line) => process.stderr.write(`[session-write-volume] ${line}\n`),
  });
  process.stdout.write(`${options.json ? JSON.stringify(rows, null, 2) : formatMarkdownTable(rows)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { formatMarkdownTable, runBench };
