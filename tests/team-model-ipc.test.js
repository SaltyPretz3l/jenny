'use strict';

// new-test-file: row 123 slice 6-5 IPC surface (a new surface): the closed `model…` payload table and its host
// operations, the answers rebuilt from the host, the `team_model_sharing` kill switch, nothing loaded before the first
// model call, push kinds, the import fence (MI9) and the line caps of every file this slice touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { FEATURE_FLAG_TABLE } = require('../services/feature-flag-table');
const { buildFeatureFlags } = require('../services/feature-flags');
const TEAM_DESCRIPTORS = require('../services/ipc-contract/descriptors-team');
const { MODEL_OPERATIONS, validatePayload } = require('../services/team/ipc-methods');
const { MODEL_METHOD_NAMES } = require('../services/team/model-ipc');
const { actionForOperation } = require('../server/team/operation-registry');
const answers = require('../services/team/model-answers');
const { MODEL_REASONS, modelRefusal } = require('../services/team/model-reasons');
const { MODEL_METHODS, MODEL_PUSH_KINDS } = require('./helpers/team-model-methods');
const { MODEL_TRANSFER_LIMITS } = require('../server/team/model-manifest');
const { teamModelRoots } = require('../services/main/team-model-roots');

const ROOT = path.join(__dirname, '..');
const TEAM = 'team_abcdefghijklmnop';
const MEMBER = 'member_abcdefghijklmnop';
const OFFER = `offer_${'a'.repeat(22)}`;
const TRANSFER = `mxfer_${'b'.repeat(22)}`;

// One good payload per method; every other case is derived from it.
const GOOD = {
  modelState: { team_id: TEAM }, modelSendable: { team_id: TEAM }, modelFiles: { team_id: TEAM, tag: 'qwen3:8b' },
  modelReceivers: { team_id: TEAM },
  modelOffer: { team_id: TEAM, tag: 'qwen3:8b', files: ['Qwen3-8B-Q4_K_M.gguf'], member_id: MEMBER, display_name: 'Qwen',
    licence: 'Apache-2.0\nText', source_url: 'https://example.test/q', note: 'Hi' },
  modelWithdraw: { team_id: TEAM, request_id: 'mAbc_123' },
  modelSendPause: { team_id: TEAM, transfer_id: TRANSFER }, modelSendResume: { team_id: TEAM, transfer_id: TRANSFER },
  modelSendStop: { team_id: TEAM, transfer_id: TRANSFER }, modelOfferRead: { team_id: TEAM, offer_id: OFFER },
  modelAccept: { team_id: TEAM, offer_id: OFFER, root_index: 0 }, modelDecline: { team_id: TEAM, offer_id: OFFER },
  modelReceivePause: { team_id: TEAM, offer_id: OFFER }, modelReceiveResume: { team_id: TEAM, offer_id: OFFER },
  modelReceiveCancel: { team_id: TEAM, offer_id: OFFER }, modelReceiveRetry: { team_id: TEAM, offer_id: OFFER },
  modelSetRate: { team_id: TEAM, mb_per_second: 25 }, modelProvenance: { team_id: TEAM, tag: 'qwen3:8b' },
};
const OPTIONAL = { modelOffer: ['member_id', 'licence', 'source_url', 'note'] };
// Per field, values of the wrong type or past a bound.
const BAD = {
  team_id: [null, 'team-1', 42], tag: ['', 'x'.repeat(257), 'a\u0007b', 5], files: ['x', [1], ['a', 'a'], Array(9).fill('a').map((a, i) => `${a}${i}`)],
  member_id: ['member', 1], display_name: ['', 'x'.repeat(129)], licence: ['x'.repeat(4097), 'a\u0000'], source_url: ['x'.repeat(513), 3],
  note: ['x'.repeat(1025)], request_id: ['', 'a b', 'x'.repeat(65)], transfer_id: ['mxfer_short', OFFER], offer_id: ['offer_x', TRANSFER],
  root_index: [-1, 16, 1.5, '0'], mb_per_second: [-1, 1001, 2.5, '5'],
};

test('the model methods are a closed list with descriptors, one host operation each where they send one', () => {
  assert.deepEqual([...MODEL_METHOD_NAMES], [...MODEL_METHODS]);
  assert.deepEqual(Object.keys(GOOD), [...MODEL_METHODS]);
  for (const method of MODEL_METHODS) {
    assert.deepEqual(TEAM_DESCRIPTORS[`team.${method}`], { kind: 'invoke', channel: `team:${method.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`)}` });
    const operation = MODEL_OPERATIONS[method];
    if (operation) assert.ok(actionForOperation(operation, {}), `${method} -> ${operation}`);
  }
  assert.deepEqual(TEAM_DESCRIPTORS['team.onModel'], { kind: 'subscribe', channel: 'team:model' });
  assert.ok(Object.isFrozen(MODEL_OPERATIONS));
});

test('every model payload: the good one passes; an extra field, a missing field and every bad value refuse', () => {
  for (const [method, good] of Object.entries(GOOD)) {
    assert.deepEqual(validatePayload(method, good), { ok: true, value: good }, method);
    assert.equal(validatePayload(method, { ...good, extra: 1 }).ok, false, `${method} extra`);
    assert.equal(validatePayload(method, null).ok, false, `${method} null`);
    assert.equal(validatePayload(method, [good]).ok, false, `${method} array`);
    for (const field of Object.keys(good)) {
      const { [field]: _dropped, ...missing } = good;
      assert.equal(validatePayload(method, missing).ok, (OPTIONAL[method] || []).includes(field), `${method} without ${field}`);
      for (const value of BAD[field] || []) {
        assert.equal(validatePayload(method, { ...good, [field]: value }).ok, false, `${method}.${field} = ${JSON.stringify(value)}`);
      }
    }
  }
  assert.equal(validatePayload('modelOffer', { team_id: TEAM, tag: 't', files: [], display_name: 'Q' }).ok, true, 'a team offer');
  assert.equal(validatePayload('modelOffer', { ...GOOD.modelOffer, path: 'C:\\models' }).ok, false, 'no path is ever taken');
});

// Per field: the accepted edge beside each value one past it (the edge passes, the next one refuses).
const name = (n) => `${'m'.repeat(n - 5)}.gguf`;
const EDGES = {
  tag: [['x'.repeat(256), 'x'.repeat(257)], ['x', '']],
  files: [[Array.from({ length: 8 }, (_unused, index) => `f${index}.gguf`), Array.from({ length: 9 }, (_unused, index) => `f${index}.gguf`)],
    [[name(MODEL_TRANSFER_LIMITS.maxNameUnits)], [name(MODEL_TRANSFER_LIMITS.maxNameUnits + 1)]]],
  display_name: [['x'.repeat(128), 'x'.repeat(129)], ['x', '']],
  licence: [['x'.repeat(4096), 'x'.repeat(4097)]], source_url: [['x'.repeat(512), 'x'.repeat(513)]], note: [['x'.repeat(1024), 'x'.repeat(1025)]],
  request_id: [['x'.repeat(64), 'x'.repeat(65)], ['x', '']],
  root_index: [[15, 16], [0, -1]], mb_per_second: [[1000, 1001], [0, -1]],
};
// A control character and a lone surrogate, refused in a display name and a file name.
const UNCLEAN = ['a\u0007b', 'a\ud800b', 'a\udc00', 'a\u007fb'];

test('the accepted edge passes beside each one-past value; a control character or a lone surrogate refuses', () => {
  for (const [method, good] of Object.entries(GOOD)) {
    for (const [field, pairs] of Object.entries(EDGES)) {
      if (!Object.hasOwn(good, field)) continue;
      for (const [edge, past] of pairs) {
        assert.equal(validatePayload(method, { ...good, [field]: edge }).ok, true, `${method}.${field} edge`);
        assert.equal(validatePayload(method, { ...good, [field]: past }).ok, false, `${method}.${field} one past`);
      }
    }
  }
  for (const value of UNCLEAN) {
    assert.equal(validatePayload('modelOffer', { ...GOOD.modelOffer, display_name: value }).ok, false, `display_name ${JSON.stringify(value)}`);
    assert.equal(validatePayload('modelOffer', { ...GOOD.modelOffer, files: [value] }).ok, false, `file name ${JSON.stringify(value)}`);
  }
  // A line feed and a tab may stand in the licence and the note, never in a display name.
  assert.equal(validatePayload('modelOffer', { ...GOOD.modelOffer, note: 'a\n\tb' }).ok, true);
  assert.equal(validatePayload('modelOffer', { ...GOOD.modelOffer, display_name: 'a\nb' }).ok, false);
});

test('the model roots follow the discovery rules: a local drive path only, no network or device path, no root twice', () => {
  const roots = teamModelRoots({ userDataPath: 'C:\\Users\\u\\AppData\\Roaming\\jenny', platform: 'win32',
    libraryRoots: ['D:\\Models', '\\\\server\\share\\models', '\\\\?\\C:\\x', '\\relative', 'd:\\models', ' E:/More ', 5, null] });
  assert.deepEqual(roots.map((root) => root.path), ['C:\\Users\\u\\AppData\\Roaming\\jenny\\models', 'D:\\Models', 'E:/More']);
  assert.ok(roots.every((root) => root.display === root.path));
  assert.deepEqual(teamModelRoots({ userDataPath: '/home/u/.config/jenny', platform: 'linux', libraryRoots: ['/srv/models', 'rel/x'] })
    .map((root) => root.path).slice(1), ['/srv/models']);
});

test('host answers are rebuilt field by field: a missing key or a wrong type drops the row, an extra field is dropped', () => {
  const summary = { offer_id: OFFER, sender_member_id: MEMBER, audience: 'team', display_name: 'Qwen', files: 2, total_bytes: 10, state: 'open' };
  const view = { transfer_id: TRANSFER, offer_id: OFFER, sender_member_id: MEMBER, receiver_member_id: MEMBER, state: 'flowing',
    queued: false, reason: null, display_name: 'Qwen', bytes_done: 4, bytes_total: 10, next: { index: 0, part: 1 } };
  assert.deepEqual(answers.offerSummary(summary), { ...summary, reason: null });
  assert.deepEqual(answers.transferView(view), view);
  for (const [build, good] of [[answers.offerSummary, summary], [answers.transferView, view]]) {
    for (const key of Object.keys(good).filter((name) => name !== 'reason' || build === answers.transferView)) {
      const { [key]: _dropped, ...missing } = good;
      assert.equal(build(missing), null, `missing ${key}`);
    }
    // An extra field (an event's event_type, cursor) is dropped, never passed on.
    assert.equal(Object.hasOwn(build({ ...good, extra: 'C:/models' }), 'extra'), false, 'extra field');
    assert.equal(build({ ...good, display_name: 5 }), null, 'wrong type');
  }
  assert.equal(answers.transferView({ ...view, bytes_done: 11 }), null);
  // A reason word this client does not know (a newer host's) keeps the row as team_unavailable; a non-word drops it.
  assert.equal(answers.offerSummary({ ...summary, reason: 'not_a_word' }).reason, 'team_unavailable');
  assert.equal(answers.transferView({ ...view, reason: 'paused_for_a_new_reason' }).reason, 'team_unavailable');
  assert.equal(answers.offerSummary({ ...summary, reason: 5 }), null);
  assert.equal(answers.offerSummary({ ...summary, reason: 'x'.repeat(65) }), null);
  assert.deepEqual(answers.offersList({ ok: true, offers: [summary, { ...summary, files: 0 }], transfers: [view, {}] }),
    { offers: [{ ...summary, reason: null }], transfers: [view] });
  assert.equal(answers.offersList({ ok: true, offers: 'x', transfers: [] }), null);
  assert.equal(answers.offerWithManifest({ ok: true, offer: summary, manifest: { request_id: 'x' } }), null);
  assert.deepEqual(answers.modelFailure({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'mystery', retryable: false } }).error.reason, 'team_unavailable');
  assert.deepEqual(modelRefusal('model_not_listed'), { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'model_not_listed' } });
  assert.equal(modelRefusal('C:\\x').error.reason, 'team_unavailable');
  assert.ok(MODEL_REASONS.every((word) => /^[a-z][a-z0-9_]*$/u.test(word)));
});

test('the kill switch: default on, =0 off; off answers team_model_sharing_off and loads, builds and reads nothing', async (t) => {
  const row = FEATURE_FLAG_TABLE.find((entry) => entry.key === 'team_model_sharing');
  assert.deepEqual(row, { key: 'team_model_sharing', env: 'TEAM_MODEL_SHARING', default: true, internal: true });
  assert.equal(buildFeatureFlags({}).team_model_sharing, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_TEAM_MODEL_SHARING: '0' }).team_model_sharing, false);
  const heavy = /services[\\/]team[\\/](team-models|model-team|model-send|model-send-[a-z]+|model-incoming|model-transport|model-hash|model-receive|model-offers-file)\.js$/u;
  for (const file of Object.keys(require.cache)) if (heavy.test(file)) delete require.cache[file];
  const loaded = () => Object.keys(require.cache).filter((file) => heavy.test(file));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-ipc-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  let enabled = false;
  const pushes = [];
  const { createTeamService } = require('../services/team/team-service');
  const service = createTeamService({ userDataPath: userData, getSecureStore: () => null, sendModel: (payload) => pushes.push(payload),
    modelOptions: { enabled: () => enabled, sources: { list: () => [], roots: () => [] } } });
  t.after(() => service.stopAll());
  assert.equal((await service.handle('status')).ok, true);
  assert.deepEqual(loaded(), [], 'nothing of model sharing before a model call');
  assert.equal(service.modelResources(), null);
  for (const [method, payload] of Object.entries(GOOD)) {
    assert.deepEqual(await service.handle(method, payload), { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_sharing_off' } }, method);
  }
  assert.deepEqual(loaded(), [], 'the switch off loads nothing');
  assert.equal((await service.handle('modelState', { team_id: TEAM, path: '/x' })).error.code, 'invalid_request', 'a bad payload sends nothing');
  enabled = true;
  assert.equal((await service.handle('modelState', GOOD.modelState)).error.reason, 'team_not_found');
  assert.equal(service.modelResources().teams, 0, 'no entry for a team with no manager');
  assert.equal(service.modelResources().workers, 0);
  assert.deepEqual(pushes, []);
});

test('the push kinds are closed and the member side imports no engine or settings-writing module (MI9)', () => {
  const files = ['team-models', 'model-team', 'model-send', 'model-send-source', 'model-send-push', 'model-incoming', 'model-transport',
    'model-offers-file', 'model-ipc', 'model-answers', 'model-reasons'].map((name) => path.join(ROOT, 'services', 'team', `${name}.js`));
  const forbidden = /require\(['"][^'"]*(engine|llama-server-manager|llama-server-process|backend-service|settings|shell-config|config-service|ollama)[^'"]*['"]\)/u;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(forbidden.test(text), false, `${path.basename(file)} imports an engine or settings module`);
    for (const kind of text.matchAll(/push\(\{ kind: '([a-z_]+)'/gu)) assert.ok(MODEL_PUSH_KINDS.includes(kind[1]), `${path.basename(file)} pushes ${kind[1]}`);
  }
});

test('every file the slice touched stays under 600 lines', () => {
  const touched = ['services/team/team-service.js', 'services/team/team-service-helpers.js', 'services/team/ipc-methods.js',
    'services/team/http-client.js', 'services/team/team-session.js', 'services/team/team-models.js', 'services/team/model-team.js',
    'services/team/model-send.js', 'services/team/model-send-source.js', 'services/team/model-send-push.js', 'services/team/model-incoming.js',
    'services/team/model-transport.js', 'services/team/model-offers-file.js', 'services/team/model-ipc.js', 'services/team/model-answers.js',
    'services/main/team-model-roots.js', 'tests/team-model-e2e-methods.test.js', 'tests/team-model-team.test.js',
    'tests/team-model-transport.test.js', 'tests/team-model-ipc.test.js', 'tests/team-http-client-abort.test.js',
    'services/team/model-reasons.js', 'services/ipc-contract/descriptors-team.js', 'services/main/team-registration.js',
    'services/main/ipc-handler-registration.js', 'services/main/ipc-registration/engines-ipc.js', 'tests/team-ipc-contract.test.js',
    'tests/team-http-client.test.js', 'tests/team-model-e2e.test.js', 'tests/team-model-send.test.js', 'tests/helpers/team-model-e2e.js'];
  for (const file of touched) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length - 1;
    assert.ok(lines < 600, `${file} has ${lines} lines`);
  }
  for (const file of touched.filter((name) => /model-send/u.test(name) && name.startsWith('services'))) {
    assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length - 1 < 500, `${file} passes 500 lines`);
  }
});
