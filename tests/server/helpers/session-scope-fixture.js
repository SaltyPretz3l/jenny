'use strict';

// Shared pieces for the slice 3-3 session audience tests: a response stand-in for
// event stream subscribers, frame readers, and a BackendEvents over a stand-in
// backend and the team directory fixture, built as the team host builds it.

const { EventEmitter } = require('node:events');

const { BackendEvents } = require('../../../server/backend-events');
const { createAuthorizer } = require('../../../server/team/authorize');

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.writableLength = 0; this.destroyed = false; this.writableEnded = false; }
  write(frame) { this.frames.push(frame); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

const dataFrames = (frames) => frames.join('').split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6)));

// `sessionProject` is handed to createAuthorizer as is. Every active member of the fixture
// gets one stream, subscribed at the current cursor; `attach` adds another.
function createUnitHost(directoryFixture, sessionProject) {
  const { authorize, sessionScope } = createAuthorizer({ directory: directoryFixture.directory, sessionProject });
  const logs = [];
  const backend = new EventEmitter();
  const events = new BackendEvents({ backend, bootEpoch: 'boot', sessionScope,
    logger: (level, event, fields) => logs.push({ level, event, fields }) });
  const attach = (actor, { cursor = events.cursor } = {}) => {
    const response = new Response();
    events.subscribe({ response, deviceId: actor.device_id, authorized: () => true, bootEpoch: 'boot', cursor,
      identity: sessionScope.identity(actor) });
    return response;
  };
  const streams = {};
  for (const [name, actor] of Object.entries(directoryFixture.actors)) {
    if (!actor.member_id || actor.state !== 'active' || streams[actor.member_id]) continue;
    streams[actor.member_id] = { name, response: attach(actor) };
  }
  const stored = () => events.events.events;
  const dropLogs = () => logs.filter((entry) => entry.event === 'team.event.dropped').map((entry) => entry.fields);
  return { authorize, sessionScope, backend, events, streams, logs, attach, stored, dropLogs };
}

module.exports = { Response, createUnitHost, dataFrames };
