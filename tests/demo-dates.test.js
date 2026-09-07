'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { resolveDateTokens, hasDateTokens, localDateStamp, addLocalDays } = require('../scripts/demo/demo-dates');
const { REPLAY_SCRIPT_DIR } = require('../scripts/demo/demo-scenes');

const NOW = new Date(2026, 8, 7, 15, 0, 0).getTime(); // Monday 2026-09-07 15:00 local

test('date tokens resolve against the local calendar', () => {
  assert.strictEqual(resolveDateTokens('{{date+0}}|{{date+2}}|{{date-1}}', NOW), '2026-09-07|2026-09-09|2026-09-06');
  assert.strictEqual(resolveDateTokens('{{weekday+0}} {{weekday+2}} {{weekday+6}}', NOW), 'Monday Wednesday Sunday');
  assert.strictEqual(resolveDateTokens('{{md+0}}, {{md+24}}', NOW), 'Sep 7, Oct 1');
  assert.strictEqual(resolveDateTokens('{{date}} and {{weekday}}', NOW), '2026-09-07 and Monday');
  assert.strictEqual(resolveDateTokens('no tokens here', NOW), 'no tokens here');
  assert.strictEqual(resolveDateTokens('', NOW), '');
  assert.strictEqual(resolveDateTokens('{{unknown+1}}', NOW), '{{unknown+1}}', 'unknown tokens are left alone');
  assert.strictEqual(hasDateTokens('see you {{weekday+1}}'), true);
  assert.strictEqual(hasDateTokens('see you tomorrow'), false);
  assert.strictEqual(hasDateTokens(undefined), false);
});

test('day arithmetic stays on the local calendar across a month boundary and DST', () => {
  assert.strictEqual(localDateStamp(addLocalDays(new Date(2026, 9, 31, 23, 30), 1)), '2026-11-01');
  assert.strictEqual(localDateStamp(addLocalDays(new Date(2026, 2, 7, 0, 5), 1)), '2026-03-08');
  assert.strictEqual(localDateStamp(addLocalDays(new Date(2026, 0, 1), -1)), '2025-12-31');
});

test('every replay script still parses after its tokens resolve, and none carries a hard date', () => {
  for (const name of fs.readdirSync(REPLAY_SCRIPT_DIR).filter((entry) => entry.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(REPLAY_SCRIPT_DIR, name), 'utf8');
    assert.doesNotMatch(raw, /\b20\d\d-\d\d-\d\d\b/, `${name} uses tokens rather than a fixed date`);
    const resolved = resolveDateTokens(raw, NOW);
    assert.doesNotThrow(() => JSON.parse(resolved), `${name} resolves to valid JSON`);
    assert.strictEqual(hasDateTokens(resolved), false, `${name} has no unresolved tokens`);
  }
});
