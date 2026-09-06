'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyIpAddress,
  normalizeDestination,
  validateScopeConsent,
} = require('../../../services/plugins/network/destination-policy');

test('destination policy classifies IPv4, IPv6, and mapped loopback/private ranges', () => {
  assert.equal(classifyIpAddress('127.0.0.1').scope, 'loopback');
  assert.equal(classifyIpAddress('192.168.2.1').scope, 'lan');
  assert.equal(classifyIpAddress('100.64.1.1').scope, 'lan');
  assert.equal(classifyIpAddress('8.8.8.8').scope, 'internet');
  assert.equal(classifyIpAddress('::1').scope, 'loopback');
  assert.equal(classifyIpAddress('fd00::1').scope, 'lan');
  assert.equal(classifyIpAddress('::ffff:127.0.0.1').scope, 'loopback');
  assert.equal(classifyIpAddress('0.0.0.0').reason, 'special_address_blocked');
  assert.equal(classifyIpAddress('ff02::1').reason, 'special_address_blocked');
  assert.equal(classifyIpAddress('2001:db8::1').reason, 'special_address_blocked');
});

test('documentation, benchmarking, transition, and alternate IPv6 spellings fail closed', () => {
  for (const address of [
    '192.0.2.1', '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '64:ff9b::c000:201', '2001:2::1', '2001:001f::1', '2001:db8::1', '2002:c000:0201::1',
  ]) {
    assert.equal(classifyIpAddress(address).reason, 'special_address_blocked', address);
  }
  assert.equal(classifyIpAddress('0:0:0:0:0:ffff:127.0.0.1').scope, 'loopback');
});

test('URL normalization rejects credentials, fragments, and insecure non-literal development hosts', () => {
  assert.equal(normalizeDestination('https://user:pass@example.test/mcp').reason,
    'embedded_credentials_blocked');
  assert.equal(normalizeDestination('https://example.test/mcp#secret').reason, 'url_fragment_blocked');
  assert.equal(normalizeDestination('file:///tmp/plugin').reason, 'scheme_blocked');
  assert.equal(normalizeDestination('http://localhost:8080/mcp', { allowLoopbackHttp: true }).reason,
    'https_required');
  assert.equal(normalizeDestination('http://127.0.0.1:8080/mcp', { allowLoopbackHttp: true }).ok, true);
  assert.equal(normalizeDestination('http://127.0.0.1:8080/mcp').reason, 'https_required');
});

test('scope consent is explicit and closed', () => {
  const consent = { granted: true, allowed_scopes: ['internet'] };
  assert.equal(validateScopeConsent(consent, 'internet').ok, true);
  assert.equal(validateScopeConsent(consent, 'lan').reason, 'network_consent_required');
  assert.equal(validateScopeConsent({ granted: false, allowed_scopes: ['internet'] }, 'internet').ok, false);
});
