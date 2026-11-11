'use strict';

// The team host's API as seen through one member bridge: hello, status, join,
// leave, bootstrap, client registration, commands and the event stream
// (TEAM_MEMBERSHIP_SPEC "Invites and joining", "Version handshake"). Hello is the
// first call on every bridge; a `team_hello_required` answer (the host forgot
// this device's hello) is answered with one more hello and one retry, which is
// safe because the hello gate runs before any route. Host answers are returned
// as they are, with the host's own code and reason; a call with no answer throws
// a TeamError with `reset: true`. Nothing here logs.

const crypto = require('node:crypto');

const { TeamError, isFailureAnswer } = require('./team-errors');

const PROTOCOL_VERSION = 1;
const API_VERSION = 1;
const APP_VERSION_MAX = 32;
// The host's id shape for a request id (server/api-contract.js `id`) and for Last-Event-ID (server/http-server.js).
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const LAST_EVENT_ID = /^[A-Za-z0-9_-]{1,128}:\d{1,16}$/u;

function newRequestId() {
  return crypto.randomUUID();
}

function createTeamSession({ http, appVersion, protocolVersion = PROTOCOL_VERSION }) {
  const app = String(appVersion || '0.0.0').slice(0, APP_VERSION_MAX);

  async function raw(method, path, options) {
    const { json } = await http.request(method, path, options);
    if (json.ok === true || isFailureAnswer(json)) return json;
    throw new TeamError('CONNECTION_FAILED', 'team_response_invalid');
  }

  function hello() {
    return raw('POST', '/api/v1/team/hello', { body: { protocol_version: protocolVersion, app_version: app } });
  }

  // Every route other than hello: one more hello and one retry when the host asks for it.
  async function call(method, path, options) {
    const first = await raw(method, path, options);
    if (!isFailureAnswer(first) || first.error.reason !== 'team_hello_required') return first;
    const again = await hello();
    if (again.ok !== true) return again;
    return raw(method, path, options);
  }

  function clientHeaders(client) {
    return { 'X-Client-Id': client.client_id, 'X-Client-Token': client.client_token };
  }

  return {
    hello,
    status: () => call('POST', '/api/v1/team/status'),
    redeem: ({ devicePublicKey, displayName, label }) => call('POST', '/api/v1/team/join',
      { body: { device_public_key: devicePublicKey, display_name: displayName, label } }),
    leave: () => call('POST', '/api/v1/team/leave'),
    bootstrap: () => call('GET', '/api/v1/team/bootstrap'),
    registerClient: () => call('POST', '/api/v1/clients'),
    // A fresh request id unless the caller passes one; the host keeps a mutation's answer under its id.
    command(operation, params, { client, bootEpoch, requestId = newRequestId() }) {
      return call('POST', '/api/v1/commands', {
        body: { api_version: API_VERSION, operation, request_id: requestId, client_id: client.client_id,
          boot_epoch: bootEpoch, params },
        headers: { 'X-Client-Token': client.client_token },
      });
    },
    // Last-Event-ID goes out only for a well-formed `<boot_epoch>:<cursor>`, the shape the host reads.
    openEvents(client, { lastEventId = null, ...streamOptions } = {}) {
      const headers = clientHeaders(client);
      if (typeof lastEventId === 'string' && LAST_EVENT_ID.test(lastEventId)) headers['Last-Event-ID'] = lastEventId;
      // onFrame, onProtocolError, idleTimeoutMs and timers go to the stream as they are.
      return http.openStream('/api/v1/events', headers, streamOptions);
    },
  };
}

module.exports = { REQUEST_ID, createTeamSession };
