'use strict';

// Fixtures for the GPU sharing service (row 123 slice 4e): a fake transport bridge that serves the
// team's authenticated HTTP API (/api/v1/commands and the node job routes) from the agent fixture's
// fake host, and a fake connection manager that lends that one bridge through `borrow()`. Every HTTP
// request the sharing service makes is recorded on the bridge; the manager counts its loans.

const { Readable } = require('node:stream');

const TOKEN = 'ctok-sharing-4e';

function answer(status, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const body = Readable.from([bytes]);
  return { status, body, close: () => body.destroy() };
}

// The team HTTP API as the bridge carries it, answered by `host` (createFakeHost's link).
function createBridge(host) {
  const requests = [];
  const http = {
    async openRequestStream(method, path, { body = null, headers = {}, signal = null } = {}) {
      requests.push({ method, path, headers: { ...headers }, body: body ? Buffer.from(body) : null });
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { reset: true });
      if (method === 'POST' && path === '/api/v1/commands') {
        if (headers['X-Client-Token'] !== TOKEN) return answer(401, { ok: false, error: { code: 'CMP-HOST-0002', reason: 'team_client_invalid' } });
        const request = JSON.parse(body.toString('utf8'));
        return answer(200, await host.link.command(request.operation, request.params, { signal }));
      }
      let match = /^\/api\/v1\/team\/node\/jobs\/([^/]+)\/request$/u.exec(path);
      if (method === 'GET' && match) {
        const read = await host.link.fetchRequest(match[1], { maxBytes: 1 << 20, signal });
        return read.ok ? answer(200, read.bytes) : answer(404, read);
      }
      match = /^\/api\/v1\/team\/node\/jobs\/([^/]+)\/chunks$/u.exec(path);
      if (method === 'POST' && match) {
        return answer(200, await host.link.postChunk(match[1], { seq: Number(headers['X-Chunk-Seq']), final: headers['X-Chunk-Final'] === '1',
          bytes: body || Buffer.alloc(0), signal }));
      }
      return answer(404, { ok: false, error: { code: 'CMP-HOST-0001', reason: 'not_found' } });
    },
  };
  return { http, requests, operations: () => requests.filter((r) => r.path === '/api/v1/commands').map((r) => JSON.parse(r.body.toString('utf8')).operation) };
}

// A team's connection manager: one connection, lent through borrow() while online.
function createManager(bridge, { state = 'online', member_state: memberState = 'active' } = {}) {
  const row = { state, member_state: memberState };
  let borrows = 0;
  return {
    row,
    borrows: () => borrows,
    snapshot: () => ({ ...row }),
    borrow() {
      borrows += 1;
      return { online: row.state === 'online', ensureClient: async () => null,
        link: { http: bridge.http, client: { client_id: 'client_1', client_token: TOKEN, bootEpoch: 'epoch_1' }, session: { hello: async () => ({ ok: true }) } } };
    },
  };
}

// The saved sharing part of each team's client record, in memory.
function createSavedStore(initial = {}) {
  const records = new Map(Object.entries(initial));
  const writes = [];
  return {
    records, writes,
    load: (_dir, teamId) => ({ ok: true, on: records.get(teamId)?.on === true, claim_seq: records.get(teamId)?.claim_seq ?? 0 }),
    save: (_dir, teamId, value) => { records.set(teamId, { on: value.on, claim_seq: value.claim_seq }); writes.push({ teamId, ...value }); return { ok: true }; },
  };
}

module.exports = { TOKEN, createBridge, createManager, createSavedStore };
