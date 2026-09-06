'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeDestination } = require('../../../services/plugins/network/destination-policy');
const {
  MAX_DNS_ANSWERS,
  normalizeAnswers,
  pinDestination,
  resolveAndPin,
} = require('../../../services/plugins/network/dns-pinning');

const INTERNET = { granted: true, allowed_scopes: ['internet'] };

test('DNS resolution pins one deterministic address and records all validated answers', async () => {
  const result = await resolveAndPin('example.test', {
    consent: INTERNET,
    resolve: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.selected.address, '1.1.1.1');
  assert.equal(result.answers.length, 2);
});

test('DNS pinning rejects mixed-scope rebinding and excessive answers', async () => {
  const consent = { granted: true, allowed_scopes: ['internet', 'lan'] };
  const mixed = await resolveAndPin('example.test', {
    consent,
    resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
  });
  assert.equal(mixed.reason, 'dns_mixed_scope_blocked');
  const many = Array.from({ length: MAX_DNS_ANSWERS + 1 }, (_, index) => ({
    address: `8.8.8.${index + 1}`, family: 4,
  }));
  assert.equal(normalizeAnswers(many).reason, 'dns_answer_limit_exceeded');
});

test('literal IP destinations are classified without DNS and still require consent', async () => {
  const destination = normalizeDestination('https://10.0.0.1/mcp');
  let resolveCalls = 0;
  const blocked = await pinDestination(destination, {
    consent: INTERNET,
    resolve: async () => { resolveCalls += 1; return []; },
  });
  assert.equal(blocked.reason, 'network_consent_required');
  assert.equal(resolveCalls, 0);
});
