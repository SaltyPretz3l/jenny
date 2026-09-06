'use strict';

/* S4 (COMPOSER_RUN_MODE_SPEC §3.2): new sessions are seeded with the global
 * defaultRunMode from the shell config when the caller supplies no explicit
 * run_mode/plan_mode. Asserted at the session-store boundary so the seeding
 * seam inside createSession stays mechanism-free. An explicit caller mode
 * always wins; existing sessions are untouched (no store rewrite here).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSession } = require('../services/backend/backend-sessions');

function buildService({ defaultRunMode = 'auto', configService } = {}) {
  const captured = { preferences: null };
  const service = {
    _normalizeManagedSessionPreferencePatch: (preferences) => ({ ...(preferences || {}) }),
    configService: configService !== undefined
      ? configService
      : { getState: () => ({ defaultRunMode }) },
    sessionStore: {
      createSession({ preferences }) {
        captured.preferences = preferences;
        return { id: 'session-1', title: 'seeded', ...preferences };
      },
    },
  };
  return { service, captured };
}

test('a new session with no caller mode is seeded from the config default', async () => {
  const { service, captured } = buildService({ defaultRunMode: 'auto' });
  await createSession(service, { title: 'fresh' });
  assert.equal(captured.preferences.run_mode, 'auto');
});

test('the shipped default (ask) seeds explicitly too', async () => {
  const { service, captured } = buildService({ defaultRunMode: 'ask' });
  await createSession(service, { title: 'fresh' });
  assert.equal(captured.preferences.run_mode, 'ask');
});

test('an explicit caller run_mode always wins over the config default', async () => {
  const { service, captured } = buildService({ defaultRunMode: 'auto' });
  await createSession(service, { title: 'fresh', preferences: { run_mode: 'ask' } });
  assert.equal(captured.preferences.run_mode, 'ask');
});

test('a legacy caller plan_mode suppresses seeding (the store maps it)', async () => {
  const { service, captured } = buildService({ defaultRunMode: 'auto' });
  await createSession(service, { title: 'fresh', preferences: { plan_mode: true } });
  assert.equal(Object.prototype.hasOwnProperty.call(captured.preferences, 'run_mode'), false);
  assert.equal(captured.preferences.plan_mode, true);
});

test('null caller preferences pass the real normalizer untouched and still seed', async () => {
  // backend-managed-reasoning's normalizeManagedSessionPreferencePatch returns a
  // falsy `preferences` AS-IS (its `= {}` default only catches undefined), so the
  // seeding seam must tolerate null without throwing - and a null-preferences
  // session carries no explicit mode, so it seeds.
  const { service, captured } = buildService({ defaultRunMode: 'auto' });
  service._normalizeManagedSessionPreferencePatch = (preferences) => preferences;
  await createSession(service, { title: 'fresh', preferences: null });
  assert.equal(captured.preferences.run_mode, 'auto');
});

test('a missing config service neither throws nor seeds', async () => {
  const { service, captured } = buildService({ configService: null });
  await createSession(service, { title: 'fresh' });
  assert.equal(Object.prototype.hasOwnProperty.call(captured.preferences, 'run_mode'), false);
});

test('an invalid config value seeds nothing rather than an invalid mode', async () => {
  const { service, captured } = buildService({ defaultRunMode: 'garbage' });
  await createSession(service, { title: 'fresh' });
  const seeded = captured.preferences.run_mode;
  assert.ok(
    seeded === undefined || seeded === 'ask',
    `an invalid default may seed only the shipped default, got ${JSON.stringify(seeded)}`
  );
});
