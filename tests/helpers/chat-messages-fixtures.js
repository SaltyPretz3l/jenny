'use strict';

// Shared fakes for the addressed-messaging renderer tests (row 59 checkpoint 4): a stateful fake
// of window.jennyShell.chatMessages and builders for the frozen inbox/outbox item shapes.

const COUNTS = Object.freeze({
  unread: 0, queued: 0, reserved: 0, excluded_by_user: 0, included: 0, pending_delivery: 0, failed_delivery: 0, deferred_reason: null,
});

let sequence = 0;
function uuid() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function inboxItem(overrides = {}) {
  const messageId = overrides.message_id || uuid();
  const { message_id: _drop, context, source, envelope, ...rest } = overrides;
  return {
    envelope: { schema_version: 1, message_id: messageId, body: 'The 8-bit cache keeps 178 tok/s.', created_at: '2026-10-15T15:38:00.000Z', kind: 'user_message', ...(envelope || {}) },
    receipt_id: uuid(),
    receive_sequence: 1,
    delivered_at: '2026-10-15T15:38:00.000Z',
    read_at: null,
    context: { state: 'queued', ...(context || {}) },
    source: { session_id: 'source-1', title: 'Benchmark the 128k setting', project_name: 'jenny', available: true, ...(source || {}) },
    ...rest,
  };
}

function outboxItem(overrides = {}) {
  const { destination, ...rest } = overrides;
  return {
    operation_id: uuid(),
    state: 'pending',
    envelope: { schema_version: 1, message_id: uuid(), body: 'hello' },
    destination: { session_id: 'dest-1', title: 'Review the sidebar nesting copy', project_name: 'jenny-site', available: true, ...(destination || {}) },
    prepared_at: '2026-10-15T15:39:00.000Z',
    send_requested_at: '2026-10-15T15:39:30.000Z',
    delivered_at: null,
    last_error: null,
    ...rest,
  };
}

/** A fake chatMessages bridge. `data[sessionId] = {inbox, outbox, counts}`; every call is recorded. */
function makeBridge(data = {}, options = {}) {
  const calls = [];
  let listener = null;
  let revision = 1;
  const record = (method, request) => { calls.push({ method, request }); };
  const answer = (method, request) => (options.responses && options.responses[method]
    ? (typeof options.responses[method] === 'function' ? options.responses[method](request) : options.responses[method])
    : { schema_version: 1, ok: true, updated_count: 1, revision });
  const bridge = {
    calls,
    data,
    listRecipients: async (request) => {
      record('listRecipients', request);
      return answer('listRecipients', request);
    },
    prepare: async (request) => { record('prepare', request); return answer('prepare', request); },
    send: async (request) => { record('send', request); return answer('send', request); },
    retry: async (request) => { record('retry', request); return answer('retry', request); },
    cancel: async (request) => { record('cancel', request); return answer('cancel', request); },
    confirmRestored: async (request) => { record('confirmRestored', request); return answer('confirmRestored', request); },
    createGrant: async (request) => { record('createGrant', request); return answer('createGrant', request); },
    revokeGrant: async (request) => { record('revokeGrant', request); return answer('revokeGrant', request); },
    list: async (request) => {
      record('list', request);
      if (options.responses && options.responses.list) return answer('list', request);
      const entry = data[request.session_id] || {};
      return {
        schema_version: 1, ok: true,
        items: (request.direction === 'inbox' ? entry.inbox : entry.outbox) || [],
        next_cursor: null, revision: entry.revision || revision, counts: { ...COUNTS, ...(entry.counts || {}) },
      };
    },
    markRead: async (request) => {
      record('markRead', request);
      const entry = data[request.session_id];
      if (entry && entry.inbox && !(options.responses && options.responses.markRead)) {
        for (const item of entry.inbox) if (request.message_ids.includes(item.envelope.message_id)) item.read_at = '2026-10-15T15:40:00.000Z';
        if (entry.counts) entry.counts.unread = 0;
        revision += 1; entry.revision = revision;
      }
      return answer('markRead', request);
    },
    setContextDisposition: async (request) => { record('setContextDisposition', request); return answer('setContextDisposition', request); },
    discard: async (request) => { record('discard', request); return answer('discard', request); },
    onChanged: (fn) => { listener = fn; return () => { listener = null; }; },
    emit: (event) => listener && listener({ schema_version: 1, revision, ...event }),
    hasListener: () => Boolean(listener),
  };
  return bridge;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Manual timers so debounces and coalescing run on demand. */
function makeTimers() {
  const queue = [];
  return {
    queue,
    setTimeout: (fn) => { queue.push(fn); return queue.length; },
    clearTimeout: () => {},
    run() { while (queue.length) queue.shift()(); },
  };
}

module.exports = { COUNTS, uuid, inboxItem, outboxItem, makeBridge, flush, makeTimers };
