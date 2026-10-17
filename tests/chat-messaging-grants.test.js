'use strict';

/* Directional grants (row 59 checkpoint 5b-2, slice M1): createGrant / revokeGrant through the
 * service, the idempotent gesture receipt, the 32-live cap, the recipient decoration, and the contract
 * validators. Runs against a real ElectronSessionStore through the desktop wiring. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const contract = require('../services/chat-messaging-contract');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const V = { schema_version: 1 };
const DAY = 24 * 60 * 60 * 1000;
const UUID = '99999999-9999-4999-8999-999999999999';

const grantRequest = (f, source, destination, extra = {}) => ({
  ...V, source_session_id: source, destination_session_id: destination, purpose: 'Hand over review notes', gesture_id: f.gesture(), ...extra,
});

test('createGrant stores a seven day, 100 send directional grant and projects it without the consent id', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest', { projectId: 'project_a' });
  const request = grantRequest(f, src, dst, { purpose: '  Hand over review notes  ' });
  const created = await f.service.createGrant(request);
  assert.equal(created.ok, true);
  assert.equal(created.schema_version, 1);
  const { grant } = created;
  assert.equal(grant.kind, 'agent_directional');
  assert.equal(grant.purpose, 'Hand over review notes', 'the stored purpose is trimmed');
  assert.equal(grant.remaining_sends, 100);
  assert.equal(grant.revoked_at, null);
  assert.equal(grant.operation_id, null);
  assert.equal(grant.body_sha256, null);
  assert.equal(grant.source_session_id, src);
  assert.equal(grant.destination_session_id, dst);
  assert.equal(grant.destination_project_id, 'project_a');
  assert.equal(grant.source_session_incarnation, f.store.getSession(src).session_incarnation);
  assert.equal(grant.destination_session_incarnation, f.store.getSession(dst).session_incarnation);
  assert.equal(Date.parse(grant.expires_at), Date.parse(grant.created_at) + 7 * DAY);
  assert.equal('consent_event_id' in grant, false, 'consent_event_id is never projected');
  assert.equal(JSON.stringify(created).includes('grant:'), false);
  const stored = f.mail(src).authorizations;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].authorization_id, grant.authorization_id);
  assert.equal(stored[0].consent_event_id, `grant:${request.gesture_id}`);
  assert.equal(f.mail(dst).authorizations.length, 0, 'the grant lives on the source only');
  assert.ok(f.coordination.includes(src), 'the rail is invalidated');
  assert.equal(f.events.at(-1).session_id, src);
});

test('createGrant writes its gesture receipt in the same mutation and replays idempotently', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest');
  const other = f.sessionId('Other');
  const request = grantRequest(f, src, dst);
  const first = await f.service.createGrant(request);
  const receipts = f.store.getSession(src).coordination_receipts;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].mutation_id, request.gesture_id);
  assert.equal(receipts[0].method, 'chatMessages.createGrant');
  assert.equal(receipts[0].resource_kind, 'authorization');
  assert.equal(receipts[0].resource_id, first.grant.authorization_id);
  assert.equal(receipts[0].accepted_revision, f.store.getSession(src).coordination_revision);
  assert.notEqual(receipts[0].settled_at, null);
  const revision = f.store.getSession(src).coordination_revision;
  const replay = await f.service.createGrant(request);
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.grant, first.grant);
  assert.equal(f.mail(src).authorizations.length, 1);
  assert.equal(f.store.getSession(src).coordination_revision, revision, 'a replay writes nothing');
  for (const patch of [{ purpose: 'Something else' }, { destination_session_id: other }]) {
    const conflict = await f.service.createGrant({ ...request, ...patch });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'idempotency_conflict');
    assert.equal(conflict.error_code, CODES.IDEMPOTENCY_CONFLICT);
  }
  assert.equal(f.mail(src).authorizations.length, 1);
  f.archive(dst);
  assert.equal((await f.service.createGrant(request)).ok, true, 'a replay is answered before eligibility is re-checked');
});

test('a replay whose grant record was retired is stale_operation, never recreated', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest');
  const request = grantRequest(f, src, dst);
  assert.equal((await f.service.createGrant(request)).ok, true);
  f.store._updateSessionRecord(src, { session_mail: { ...f.mail(src), authorizations: [] } }, { bumpUpdatedAt: false });
  const replay = await f.service.createGrant(request);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'stale_operation');
  assert.equal(f.mail(src).authorizations.length, 0);
});

test('createGrant validates the purpose (1-512 UTF-8 bytes, one line) and the closed request shape', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const bad = [
    { purpose: '' }, { purpose: '   ' }, { purpose: 'x'.repeat(513) }, { purpose: 'é'.repeat(257) }, { purpose: 'two\nlines' },
    { purpose: 'tab\tinside' }, { purpose: 'bell\u0007' }, { purpose: 5 }, { purpose: null }, { purpose: '\ud800' },
    { extra: 1 }, { schema_version: 2 }, { gesture_id: 'not-a-uuid' }, { destination_session_id: '../escape' },
  ];
  for (const patch of bad) {
    const result = await f.service.createGrant({ ...grantRequest(f, src, dst), ...patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.reason, 'invalid_request', JSON.stringify(patch));
    assert.equal(result.error_code, CODES.INVALID_REQUEST);
  }
  const missing = grantRequest(f, src, dst);
  delete missing.purpose;
  assert.equal((await f.service.createGrant(missing)).reason, 'invalid_request');
  assert.equal((await f.service.createGrant(null)).reason, 'invalid_request');
  assert.equal(f.mail(src).authorizations.length, 0);
  for (const purpose of ['x'.repeat(512), 'é'.repeat(256), '漢'.repeat(170)]) {
    assert.equal((await f.service.createGrant(grantRequest(f, src, dst, { purpose }))).ok, true, `${purpose.length} chars`);
  }
});

test('createGrant refuses self, archived or missing chats with stable reasons', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const archived = f.sessionId('A');
  f.archive(archived);
  assert.equal((await f.service.createGrant(grantRequest(f, src, src))).reason, 'self_send');
  assert.equal((await f.service.createGrant(grantRequest(f, src, archived))).reason, 'recipient_archived');
  assert.equal((await f.service.createGrant(grantRequest(f, src, 'sess_missing'))).reason, 'recipient_deleted');
  assert.equal((await f.service.createGrant(grantRequest(f, 'sess_missing', dst))).reason, 'not_found');
  const fromArchived = await f.service.createGrant(grantRequest(f, archived, dst));
  assert.equal(fromArchived.reason, 'source_ineligible');
  assert.equal(f.mail(src).authorizations.length, 0);
});

test('at most 32 live grants per source: the 33rd is refused, revoking or expiry frees a slot', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const grants = [];
  for (let i = 0; i < 32; i += 1) {
    const created = await f.service.createGrant(grantRequest(f, src, dst, { purpose: `purpose ${i}` }));
    assert.equal(created.ok, true, `grant ${i}`);
    grants.push(created.grant);
  }
  const refused = await f.service.createGrant(grantRequest(f, src, dst));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'capacity');
  assert.equal(refused.error_code, CODES.SENDER_BACKPRESSURE);
  assert.equal(refused.retryable, false);
  assert.equal(f.mail(src).authorizations.length, 32);
  assert.equal((await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: grants[0].authorization_id })).ok, true);
  assert.equal((await f.service.createGrant(grantRequest(f, src, dst))).ok, true, 'a revoked grant frees its slot');
  assert.equal((await f.service.createGrant(grantRequest(f, src, dst))).reason, 'capacity');
  f.advance(7 * DAY + 1000);
  assert.equal((await f.service.createGrant(grantRequest(f, src, dst))).ok, true, 'expired grants do not count');
  const other = f.sessionId('Other source');
  assert.equal((await f.service.createGrant(grantRequest(f, other, dst))).ok, true, 'the cap is per source');
});

test('revokeGrant revokes, is idempotent and only touches the source\'s own directional grants', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const other = f.sessionId('O');
  const { grant } = await f.service.createGrant(grantRequest(f, src, dst));
  const otherGrant = (await f.service.createGrant(grantRequest(f, other, dst))).grant;
  f.advance(1000);
  const revoked = await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: grant.authorization_id });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.grant.revoked_at, new Date(f.clock.ms).toISOString());
  assert.equal('consent_event_id' in revoked.grant, false);
  assert.equal(revoked.grant.remaining_sends, 100, 'a revoked grant keeps its count');
  f.advance(5000);
  const again = await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: grant.authorization_id });
  assert.deepEqual(again.grant, revoked.grant, 'idempotent: the first revocation time stays');
  for (const [source, id] of [[src, UUID], [src, otherGrant.authorization_id], [other, grant.authorization_id]]) {
    const result = await f.service.revokeGrant({ ...V, source_session_id: source, grant_id: id });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_found');
  }
  assert.equal(f.mail(other).authorizations[0].revoked_at, null);
  assert.equal((await f.service.revokeGrant({ ...V, source_session_id: 'sess_missing', grant_id: grant.authorization_id })).reason, 'not_found');
  f.archive(src);
  assert.equal((await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: grant.authorization_id })).ok, true, 'an archived source can still revoke');
  for (const raw of [{ ...V, source_session_id: src }, { ...V, source_session_id: src, grant_id: 'nope' }, { ...V, source_session_id: src, grant_id: UUID, extra: 1 }, null]) {
    assert.equal((await f.service.revokeGrant(raw)).reason, 'invalid_request');
  }
});

test('a user-send authorization is not a grant: revokeGrant and the live count ignore it', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const { sent } = await f.sendNew(src, dst, 'hello');
  assert.equal(sent.ok, true);
  const [userAuth] = f.mail(src).authorizations;
  assert.equal(userAuth.kind, 'user_send');
  assert.equal((await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: userAuth.authorization_id })).reason, 'not_found');
});

test('listRecipients decorates each chat with the calling source\'s live grant and nothing else', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D', { projectId: 'project_a' });
  const other = f.sessionId('Other');
  const list = async (source = src) => (await f.service.listRecipients({ ...V, source_session_id: source })).items;
  const find = (items, id) => items.find((item) => item.session_id === id);
  assert.equal(find(await list(), dst).grant, null);
  const { grant } = await f.service.createGrant(grantRequest(f, src, dst, { purpose: 'Share plan' }));
  const items = await list();
  assert.deepEqual(find(items, dst).grant, {
    grant_id: grant.authorization_id, purpose: 'Share plan', expires_at: grant.expires_at, remaining_sends: 100,
  });
  assert.equal(find(items, other).grant, null, 'only the granted direction');
  assert.equal(JSON.stringify(items).includes('consent'), false);
  assert.equal(find(await list(other), src).grant, null, 'the reverse direction has no grant');
  f.store._updateSessionRecord(dst, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  assert.equal(find(await list(), dst).grant, null, 'a project reassignment invalidates the grant');
  f.store._updateSessionRecord(dst, { project_id: 'project_a' }, { bumpUpdatedAt: false });
  assert.notEqual(find(await list(), dst).grant, null);
  await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: grant.authorization_id });
  assert.equal(find(await list(), dst).grant, null, 'a revoked grant is not shown');
  const second = (await f.service.createGrant(grantRequest(f, src, dst))).grant;
  assert.equal(find(await list(), dst).grant.grant_id, second.authorization_id);
  f.advance(7 * DAY + 1000);
  assert.equal(find(await list(), dst).grant, null, 'an expired grant is not shown');
});

test('the best live grant of a direction is the one that lasts longest', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const first = (await f.service.createGrant(grantRequest(f, src, dst, { purpose: 'first' }))).grant;
  f.advance(1000);
  const second = (await f.service.createGrant(grantRequest(f, src, dst, { purpose: 'second' }))).grant;
  const { items } = await f.service.listRecipients({ ...V, source_session_id: src });
  assert.equal(items.find((item) => item.session_id === dst).grant.grant_id, second.authorization_id);
  assert.notEqual(first.authorization_id, second.authorization_id);
});

test('contract validators: createGrant trims and bounds the purpose, revokeGrant is closed', () => {
  const base = { ...V, source_session_id: 'a', destination_session_id: 'b', purpose: ' hi ', gesture_id: UUID };
  assert.deepEqual(contract.validateCreateGrantRequest(base), {
    ok: true, value: { source_session_id: 'a', destination_session_id: 'b', purpose: 'hi', gesture_id: UUID },
  });
  assert.equal(contract.validateCreateGrantRequest({ ...base, purpose: 'x'.repeat(513) }).ok, false);
  assert.equal(contract.validateCreateGrantRequest({ ...base, purpose: 'é'.repeat(256) }).ok, true);
  assert.equal(contract.validateCreateGrantRequest({ ...base, purpose: 'a\u007fb' }).ok, false);
  assert.equal(contract.validateCreateGrantRequest(Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'gesture_id'))).ok, false);
  assert.deepEqual(contract.validateRevokeGrantRequest({ ...V, source_session_id: 'a', grant_id: UUID }), {
    ok: true, value: { source_session_id: 'a', grant_id: UUID },
  });
  assert.equal(contract.validateRevokeGrantRequest({ ...V, source_session_id: 'a', grant_id: UUID, extra: 1 }).ok, false);
  assert.equal(contract.validateRevokeGrantRequest({ ...V, source_session_id: 'a' }).ok, false);
  assert.equal(contract.classify('turn_send_limit').code, CODES.SENDER_BACKPRESSURE);
  assert.equal(contract.classify('capacity').retryable, false);
});
