'use strict';

// Slice 2c host: the two raw chat attachment routes (server/team/chat-attachment-routes.js) over the real chat
// command fixture (real member store, chat store, authorizer and router). A request is handed to the routes as
// the team HTTP layer hands it over: a readable body, the actor's guard, `authorized`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createChatAttachmentRoutes } = require('../../../server/team/chat-attachment-routes');
const { createRouteGuard } = require('../../../server/team/route-guard');
const { createTeamChatCommandsFixture } = require('./team-chat-commands-fixture');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const turn = () => new Promise((resolve) => { setImmediate(resolve); });

async function createAttachmentsFixture(t, options = {}) {
  const f = await createTeamChatCommandsFixture(t, options);
  let admit = true;
  const routes = createChatAttachmentRoutes({ chat: () => f.chat, logger: f.fx.logger, canAdmit: () => admit });
  const actor = (who) => (who ? { member_id: f.seats[who].member_id, device_id: f.seats[who].device_id } : undefined);

  // Starts one request; `finish()` sends the rest of the body and answers { status, headers, json, bytes }.
  function start(who, method, pathname, { body = Buffer.alloc(0), length, headers = {}, authorizedNow = () => true,
    guard } = {}) {
    const request = new Readable({ read() {} });
    request.method = method;
    // The socket a 'stop' refusal destroys once the answer finished.
    request.socket = { destroyed: false, destroy() { this.destroyed = true; } };
    request.headers = { ...(length === null ? {} : { 'content-length': String(length ?? body.length) }), ...headers };
    const answer = { status: null, headers: {}, chunks: [] };
    const finished = [];
    const response = { headersSent: false, destroyed: false, writableEnded: false,
      setHeader(key, value) { answer.headers[key] = value; },
      writeHead(status, values = {}) { answer.status = status; Object.assign(answer.headers, values); response.headersSent = true; },
      end(chunk) {
        if (chunk) answer.chunks.push(Buffer.from(chunk));
        response.writableEnded = true;
        for (const fn of finished.splice(0)) fn();
      },
      destroy() { response.destroyed = true; },
      once(event, fn) { if (event === 'finish') finished.push(fn); } };
    const seat = actor(who);
    const ctx = { request, response, pathname, deviceId: seat?.device_id ?? 'device_none', requestId: 'request_att',
      actor: seat, authorized: authorizedNow,
      guard: guard ?? (seat ? createRouteGuard({ authorize: f.authorize, actor: seat, requestId: 'request_att' }) : undefined) };
    const handling = routes(ctx);
    const half = Math.floor(body.length / 2);
    if (method === 'POST') request.push(body.subarray(0, half));
    async function finish(during) {
      await turn();
      answer.endedBeforeBody = response.writableEnded;
      if (method === 'POST') {
        if (during) { await turn(); await during(); }
        request.push(body.subarray(half));
      }
      request.push(null);
      const handled = await handling;
      for (let tries = 0; tries < 1000 && handled && !response.writableEnded && !response.destroyed; tries += 1) await turn();
      const bytes = Buffer.concat(answer.chunks);
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
      return { handled, status: answer.status, headers: answer.headers, json: parsed, bytes,
        socketDestroyed: request.socket.destroyed, answeredBeforeBodyEnd: answer.endedBeforeBody === true };
    }
    return { finish, request, answer };
  }

  const upload = (who, channelId, bytes, { name = 'notes.txt', type = 'text/plain', headers, during, ...rest } = {}) => start(who,
    'POST', `/api/v1/team/chat/uploads/${channelId}`, { body: bytes, ...rest, headers: {
      ...(name === null ? {} : { 'x-file-name': encodeURIComponent(name) }), ...(type === null ? {} : { 'content-type': type }),
      ...headers } }).finish(during);
  const download = (who, channelId, id, options = {}) => start(who, 'GET',
    `/api/v1/team/chat/attachments/${channelId}/${id}`, options).finish();
  // A staged upload's item, or a thrown failure.
  async function staged(who, channelId, bytes, options) {
    const answer = await upload(who, channelId, bytes, options);
    if (answer.status !== 200) throw new Error(`upload failed: ${JSON.stringify(answer.json)}`);
    return answer.json.attachment;
  }
  const post = (who, channelId, ids, extra = {}) => f.send(f.seats[who], 'team.chat.post',
    { channel_id: channelId, text: 'with files', attachment_ids: ids, ...extra });
  const blobDir = (...parts) => path.join(f.fx.dir, 'team-chat', 'blobs', ...parts);
  const listed = (...parts) => { try { return fs.readdirSync(blobDir(...parts)).sort(); } catch { return []; } };
  return { ...f, routes, start, upload, download, staged, post, blobDir, listed, sha, turn,
    setDiskAdmit(value) { admit = value; } };
}

module.exports = { createAttachmentsFixture, sha };
