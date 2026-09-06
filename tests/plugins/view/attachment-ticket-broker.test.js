'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AttachmentTicketBroker } = require('../../../services/plugins/view/attachment-ticket-broker');

const ARTIFACT_DIGEST = 'a'.repeat(64);

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attachment-ticket-'));
  const asset = path.join(root, 'image.png');
  fs.writeFileSync(asset, Buffer.from('image bytes'));
  let now = 1_700_000_000_000;
  const session = {
    id: 'session-1',
    session_incarnation: 'incarnation-1',
    plugin_session: { publisher_id: 'jenny-official', plugin_id: 'local-image-generation' },
    messages: [{
      id: 'message-1',
      attachments: [{ id: 'attachment-1', kind: 'image', assetPath: asset }],
    }],
  };
  const sessions = new Map([[session.id, session]]);
  const revealed = [];
  const broker = new AttachmentTicketBroker({
    sessionStore: {
      getSession: (id) => sessions.get(id) || null,
      listSessions: () => [...sessions.values()],
    },
    attachmentAssetStore: {
      resolveManagedAssetRealPath: (candidate) => candidate === asset ? asset : '',
    },
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 0x11),
    revealPath: async (candidate) => { revealed.push(candidate); },
    ttlMs: 100,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { broker, asset, session, sessions, revealed, advance: (ms) => { now += ms; } };
}

function issue(value) {
  return value.broker.issueForAttachment({
    viewInstanceId: 'view-1',
    generationId: 'generation-1',
    sessionId: 'session-1',
    sessionIncarnation: 'incarnation-1',
    operationId: 'operation-1',
    attachmentId: 'attachment-1',
    webContentsId: 42,
    artifactDigest: ARTIFACT_DIGEST,
  });
}

test('ticket URL exposes no path and resolves only for its exact view authority', (t) => {
  const value = harness(t);
  const ticket = issue(value);
  assert.equal(ticket.ok, true);
  assert.match(ticket.url, /^jenny-plugin-view:\/\/[a-f0-9]{64}\/__attachment\/[a-f0-9]{64}$/);
  assert.equal(ticket.url.includes(value.asset), false);
  assert.equal(value.broker.resolve({
    token: ticket.token,
    viewInstanceId: 'view-1',
    generationId: 'generation-1',
    webContentsId: 42,
    artifactDigest: ARTIFACT_DIGEST,
  }).ok, true);
  for (const patch of [{ viewInstanceId: 'view-2' }, { generationId: 'generation-2' },
    { webContentsId: 43 }, { artifactDigest: 'b'.repeat(64) }]) {
    assert.equal(value.broker.resolve({
      token: ticket.token,
      viewInstanceId: 'view-1',
      generationId: 'generation-1',
      webContentsId: 42,
      artifactDigest: ARTIFACT_DIGEST,
      ...patch,
    }).reason, 'attachment_ticket_binding_mismatch');
  }
});

test('resolved attachments use validated image metadata and managed extensions', () => {
  function resolveMediaType(attachment) {
    const session = { id: 'session-1', session_incarnation: 'incarnation-1',
      messages: [{ attachments: [{ id: 'attachment-1', ...attachment }] }] };
    const broker = new AttachmentTicketBroker({
      sessionStore: { getSession: () => session, listSessions: () => [session] },
      attachmentAssetStore: { resolveManagedAssetRealPath: () => '' },
      randomBytes: () => Buffer.alloc(32, 0x22),
    });
    broker._readBoundedAttachment = () => ({ ok: true, bytes: Buffer.from('image') });
    const ticket = issue({ broker });
    return broker.resolve({ token: ticket.token, viewInstanceId: 'view-1', generationId: 'generation-1',
      webContentsId: 42, artifactDigest: ARTIFACT_DIGEST }).mediaType;
  }

  assert.equal(resolveMediaType({ assetPath: 'managed.webp', mimeType: 'image/jpeg' }), 'image/jpeg');
  assert.equal(resolveMediaType({ assetPath: 'managed.webp' }), 'image/webp');
});

test('expiry and view revocation invalidate tickets', (t) => {
  const value = harness(t);
  let ticket = issue(value);
  value.advance(101);
  assert.equal(value.broker.resolve({
    token: ticket.token, viewInstanceId: 'view-1', generationId: 'generation-1',
    webContentsId: 42, artifactDigest: ARTIFACT_DIGEST,
  }).reason, 'attachment_ticket_invalid');

  issue(value);
  assert.equal(value.broker.revokeView('view-1'), 1);
});

test('digest drift revokes the ticket and reveal returns no raw path', async (t) => {
  const value = harness(t);
  const ticket = issue(value);
  fs.writeFileSync(value.asset, Buffer.from('changed image bytes'));
  const rejected = value.broker.resolve({
    token: ticket.token, viewInstanceId: 'view-1', generationId: 'generation-1',
    webContentsId: 42, artifactDigest: ARTIFACT_DIGEST,
  });
  assert.equal(rejected.reason, 'attachment_ticket_digest_mismatch');
  assert.equal(value.broker.tickets.has(ticket.token), false);

  const revealed = await value.broker.reveal({
    sessionId: 'session-1', sessionIncarnation: 'incarnation-1', attachmentId: 'attachment-1',
  });
  assert.deepEqual(revealed, { ok: true, revealed: true });
  assert.deepEqual(value.revealed, [value.asset]);
  assert.equal(Object.values(revealed).includes(value.asset), false);
});

test('session-incarnation drift fails closed', (t) => {
  const value = harness(t);
  const ticket = issue(value);
  value.session.session_incarnation = 'incarnation-2';
  assert.equal(value.broker.resolve({
    token: ticket.token, viewInstanceId: 'view-1', generationId: 'generation-1',
    webContentsId: 42, artifactDigest: ARTIFACT_DIGEST,
  }).reason, 'attachment_ticket_session_stale');
  assert.equal(issue(value).reason, 'attachment_ticket_session_stale');
});

test('ticket issuance rejects an attachment that changes during its bounded read', (t) => {
  const value = harness(t);
  let fstatCalls = 0;
  const fsImpl = {
    openSync: fs.openSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
    fstatSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      fstatCalls += 1;
      return fstatCalls === 2 ? { ...stat, size: stat.size + 1 } : stat;
    },
  };
  value.broker.fs = fsImpl;

  assert.deepEqual(issue(value), { ok: false, reason: 'attachment_ticket_asset_rejected' });
});
