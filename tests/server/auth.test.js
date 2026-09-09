'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AuthService,
} = require('../../server/auth-service');
const {
  AuthStore,
  AuthStoreError,
  SCRYPT_PARAMS,
} = require('../../server/auth-store');
const { createRequestSecurity } = require('../../server/request-security');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-hosted-auth-'));
  return { dir, filePath: path.join(dir, 'auth.json') };
}

function deterministicHash(password) {
  return Promise.resolve({
    salt: Buffer.alloc(16, 7).toString('base64'),
    hash: crypto.createHash('sha512').update(password).digest().toString('base64'),
    params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, key_length: 64 },
  });
}

function deterministicVerify(password) {
  return Promise.resolve(password === 'correct horse battery staple');
}

test('auth initialization and login use real scrypt and never persist raw credentials', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const auth = new AuthService({ filePath: fixture.filePath });

  assert.equal((await auth.initializePassword('correct horse battery staple')).ok, true);
  const login = await auth.login({ password: 'correct horse battery staple' });
  assert.equal(login.ok, true);
  assert.match(login.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(login.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const persisted = fs.readFileSync(fixture.filePath, 'utf8');
  assert.doesNotMatch(persisted, /correct horse battery staple/);
  assert.doesNotMatch(persisted, new RegExp(login.token));
  assert.doesNotMatch(persisted, new RegExp(login.csrfToken));
  if (process.platform !== 'win32') assert.equal(fs.statSync(fixture.filePath).mode & 0o777, 0o600);
  assert.equal((await auth.initializePassword('another password')).code, 'AUTH_ALREADY_INITIALIZED');
});

test('auth store rejects malformed and future state without overwriting it', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  fs.mkdirSync(fixture.dir, { recursive: true });
  const malformed = '{"schema_version":1,"password":null,"sessions":"bad"}';
  fs.writeFileSync(fixture.filePath, malformed, { mode: 0o600 });
  const malformedStore = new AuthStore({ filePath: fixture.filePath });
  assert.throws(() => malformedStore.snapshot(), (error) => error.code === 'AUTH_STORE_INVALID');
  assert.equal(fs.readFileSync(fixture.filePath, 'utf8'), malformed);

  const future = '{"schema_version":99,"password":null,"sessions":[]}';
  fs.writeFileSync(fixture.filePath, future);
  const futureStore = new AuthStore({ filePath: fixture.filePath });
  assert.throws(() => futureStore.snapshot(), (error) => error.code === 'AUTH_STORE_INVALID');
  assert.equal(fs.readFileSync(fixture.filePath, 'utf8'), future);
});

test('serialized auth mutations and verify admission keep one password check active', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  let active = 0;
  let maxActive = 0;
  const auth = new AuthService({
    filePath: fixture.filePath,
    passwordHasher: deterministicHash,
    passwordVerifier: async (password) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return deterministicVerify(password);
    },
  });
  assert.equal((await auth.initializePassword('correct horse battery staple')).ok, true);
  const [first, second] = await Promise.all([
    auth.login({ password: 'correct horse battery staple', rateKey: 'test-a' }),
    auth.login({ password: 'correct horse battery staple', rateKey: 'test-b' }),
  ]);
  assert.equal(maxActive, 1);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
  assert.equal([first.code, second.code].includes('AUTH_RATE_LIMITED'), true);
});

test('persistence failure never returns a valid login', async () => {
  const store = {
    _state: { schema_version: 1, password: null, sessions: [] },
    snapshot() { return JSON.parse(JSON.stringify(this._state)); },
    isConfigured() { return this._state.password !== null; },
    async mutate() { throw new AuthStoreError('AUTH_STORE_WRITE_FAILED', 'failed'); },
  };
  const auth = new AuthService({
    store,
    passwordHasher: deterministicHash,
    passwordVerifier: deterministicVerify,
  });
  assert.equal((await auth.initializePassword('correct horse battery staple')).ok, false);
});

test('logout and revoke invalidate authentication immediately', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const auth = new AuthService({ filePath: fixture.filePath, passwordHasher: deterministicHash, passwordVerifier: deterministicVerify });
  await auth.initializePassword('correct horse battery staple');
  const one = await auth.login({ password: 'correct horse battery staple', rateKey: 'one' });
  const two = await auth.login({ password: 'correct horse battery staple', rateKey: 'two' });
  assert.equal((await auth.authenticateCookie(one.token)).ok, true);
  assert.equal((await auth.logout(one.token)).revoked, true);
  assert.equal((await auth.authenticateCookie(one.token)).ok, false);
  assert.equal((await auth.revokeSession(two.session.id)).revoked, true);
  assert.equal((await auth.authenticateCookie(two.token)).ok, false);
  assert.equal(auth.listSessions().sessions.length, 0);
});

test('concurrent tab bootstraps keep CSRF valid across reloads and server restart', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const auth = new AuthService({ filePath: fixture.filePath, passwordHasher: deterministicHash, passwordVerifier: deterministicVerify });
  await auth.initializePassword('correct horse battery staple');
  const login = await auth.login({ password: 'correct horse battery staple' });
  const [boot, secondTab] = await Promise.all([auth.bootstrap(login.token), auth.bootstrap(login.token)]);
  assert.equal(boot.ok, true);
  assert.equal(secondTab.ok, true);
  assert.equal(boot.csrfToken, login.csrfToken);
  assert.equal(secondTab.csrfToken, login.csrfToken);
  assert.equal(await auth.validateCsrf(login.token, login.csrfToken), true);
  assert.equal(await auth.validateCsrf(login.token, boot.csrfToken), true);
  assert.equal(Object.prototype.hasOwnProperty.call(boot, 'token'), false);
  assert.notEqual(boot.csrfToken, login.token);
  const restarted = new AuthService({ filePath: fixture.filePath });
  assert.equal((await restarted.bootstrap(login.token)).csrfToken, boot.csrfToken);
  assert.equal(await restarted.validateCsrf(login.token, boot.csrfToken), true);
  assert.equal(await restarted.validateCsrf(login.token, 'z'.repeat(43)), false);
  await restarted.logout(login.token);
  assert.equal(await restarted.validateCsrf(login.token, boot.csrfToken), false);
  assert.equal((await restarted.bootstrap(login.token)).ok, false);
});

test('bootstrap preserves legacy session tokens and keeps different sessions isolated', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  let now = Date.now();
  const auth = new AuthService({ filePath: fixture.filePath, now: () => now,
    passwordHasher: deterministicHash, passwordVerifier: deterministicVerify });
  await auth.initializePassword('correct horse battery staple');
  const one = await auth.login({ password: 'correct horse battery staple', rateKey: 'one' });
  const two = await auth.login({ password: 'correct horse battery staple', rateKey: 'two' });
  const legacyToken = crypto.randomBytes(32).toString('base64url');
  await auth.store.mutate((state) => {
    state.sessions.find((entry) => entry.id === one.session.id).csrf_hash =
      crypto.createHash('sha256').update(legacyToken).digest('hex');
    return state;
  });
  const boot = await auth.bootstrap(one.token);
  assert.equal(await auth.validateCsrf(one.token, legacyToken), true);
  assert.equal(await auth.validateCsrf(one.token, boot.csrfToken), true);
  assert.equal(await auth.validateCsrf(two.token, boot.csrfToken), false);
  assert.equal(await auth.validateCsrf(one.token, two.csrfToken), false);
  const persisted = fs.readFileSync(fixture.filePath, 'utf8');
  for (const secret of [one.token, boot.csrfToken, legacyToken]) assert.equal(persisted.includes(secret), false);
  assert.equal(JSON.parse(persisted).schema_version, 1);
  now = one.session.expiresAt;
  assert.equal(await auth.validateCsrf(one.token, legacyToken), false);
  assert.equal(await auth.validateCsrf(one.token, boot.csrfToken), false);
  assert.equal((await auth.bootstrap(one.token)).ok, false);
});

test('session retention stays bounded at sixteen records', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const auth = new AuthService({ filePath: fixture.filePath, passwordHasher: deterministicHash, passwordVerifier: deterministicVerify });
  await auth.initializePassword('correct horse battery staple');
  for (let index = 0; index < 17; index += 1) {
    assert.equal((await auth.login({ password: 'correct horse battery staple', rateKey: `session-${index}` })).ok, true);
  }
  assert.equal(auth.listSessions().sessions.length, 16);
  assert.equal(auth.store.snapshot().sessions.length, 16);
});

test('revocation notifies live connection owners even when persistence fails', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const invalidations = [];
  const auth = new AuthService({ filePath: fixture.filePath, passwordHasher: deterministicHash,
    passwordVerifier: deterministicVerify, onInvalidate: (id, reason) => invalidations.push({ id, reason }) });
  await auth.initializePassword('correct horse battery staple');
  const login = await auth.login({ password: 'correct horse battery staple' });
  auth.store._fileStore = { writeImmediate() { throw new Error('ENOSPC'); } };
  assert.equal((await auth.logout(login.token)).ok, false);
  assert.deepEqual(invalidations, [{ id: login.session.id, reason: 'logout' }]);
  assert.equal(auth.isSessionActive(login.session.id), false);
  assert.equal((await auth.authenticateCookie(login.token)).ok, false);
});

test('auth rejects future timestamps and tolerates a small backward clock adjustment', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  let now = 100_000;
  const auth = new AuthService({ filePath: fixture.filePath, now: () => now,
    passwordHasher: deterministicHash, passwordVerifier: deterministicVerify });
  await auth.initializePassword('correct horse battery staple');
  const login = await auth.login({ password: 'correct horse battery staple' });
  now -= 1000;
  assert.equal((await auth.authenticateCookie(login.token)).ok, true);
  assert.equal(auth.store.snapshot().sessions[0].last_seen_at, 100_000);
  const state = auth.store.snapshot();
  state.sessions[0].expires_at = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(fixture.filePath, JSON.stringify(state));
  const restarted = new AuthService({ filePath: fixture.filePath, now: () => now });
  assert.equal((await restarted.authenticateCookie(login.token)).ok, false);
});

test('CSRF-authorized mutations refresh the throttled session idle window', async (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  let now = 1_000_000;
  const auth = new AuthService({ filePath: fixture.filePath, now: () => now,
    passwordHasher: deterministicHash, passwordVerifier: deterministicVerify });
  await auth.initializePassword('correct horse battery staple');
  const login = await auth.login({ password: 'correct horse battery staple' });
  const security = createRequestSecurity({ canonicalOrigin: 'https://jenny.test' });
  const request = (csrfToken) => ({ method: 'POST', headers: {
    host: 'jenny.test', origin: 'https://jenny.test',
    cookie: `__Host-jenny=${login.token}`, 'x-csrf-token': csrfToken,
  } });

  now += 61_000;
  assert.equal((await security.authorizeMutation(auth, request('invalid'))).ok, false);
  assert.equal(auth.store.snapshot().sessions[0].last_seen_at, 1_000_000);
  assert.equal((await security.authorizeMutation(auth, request(login.csrfToken))).ok, true);
  assert.equal(auth.store.snapshot().sessions[0].last_seen_at, now);

  now += 30_000;
  assert.equal((await security.authorizeMutation(auth, request(login.csrfToken))).ok, true);
  assert.equal(auth.store.snapshot().sessions[0].last_seen_at, 1_061_000);
});

test('unsafe auth symlinks and permissions fail closed without changing the target', {
  skip: process.platform === 'win32' ? 'POSIX security qualification gate' : false,
}, (t) => {
  const fixture = tempFile();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const target = path.join(fixture.dir, 'target.json');
  fs.writeFileSync(target, '{"schema_version":1,"password":null,"sessions":[]}', { mode: 0o644 });
  fs.symlinkSync(target, fixture.filePath);
  assert.throws(() => new AuthStore({ filePath: fixture.filePath }).snapshot());
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.throws(() => new AuthStore({ filePath: target }).snapshot());
});
