const test = require('node:test');
const assert = require('node:assert/strict');

const {
  endpointOrigin,
  hostResolvesOnlyToLocalAddresses,
  isLocalAddress,
  validateProviderEndpoint,
} = require('../services/backend/api-provider-endpoint');

const publicLookup = async () => [{ address: '104.18.2.1', family: 4 }];
const privateLookup = async () => [{ address: '192.168.1.20', family: 4 }];
const mixedLookup = async () => [{ address: '192.168.1.20', family: 4 }, { address: '8.8.8.8', family: 4 }];
const failingLookup = async () => { throw new Error('ENOTFOUND'); };

test('https endpoints are admitted and lose their trailing slash', async () => {
  assert.equal(await validateProviderEndpoint('https://openrouter.ai/api/v1/', { lookup: publicLookup }), 'https://openrouter.ai/api/v1');
  assert.equal(endpointOrigin('https://openrouter.ai/api/v1'), 'https://openrouter.ai');
});

test('plain http is admitted only when every resolved address is local', async () => {
  assert.equal(await validateProviderEndpoint('http://lab-box:8000/v1', { lookup: privateLookup }), 'http://lab-box:8000/v1');
  for (const lookup of [publicLookup, mixedLookup, failingLookup]) {
    await assert.rejects(validateProviderEndpoint('http://lab-box:8000/v1', { lookup }), { code: 'invalid_endpoint', reason: 'insecure' });
  }
  assert.equal(await validateProviderEndpoint('http://127.0.0.1:9000/v1'), 'http://127.0.0.1:9000/v1');
  assert.equal(await validateProviderEndpoint('http://[::1]:9000/v1'), 'http://[::1]:9000/v1');
  await assert.rejects(validateProviderEndpoint('http://8.8.8.8/v1'), { code: 'invalid_endpoint' });
});

test('credentials, queries, fragments and odd shapes are refused without echoing the value', async () => {
  const secret = 'sk-test-SECRETKEYVALUE123456';
  const bad = [
    `https://${secret}@api.example.com/v1`,
    'https://user:pass@api.example.com/v1',
    `https://api.example.com/v1?key=${secret}`,
    'https://api.example.com/v1#x',
    'ftp://api.example.com/v1',
    'file:///etc/passwd',
    ' https://api.example.com/v1',
    'https://api.example.com/v1\n',
    `https://${'a'.repeat(2050)}.com`,
    '',
    null,
    42,
  ];
  for (const value of bad) {
    await assert.rejects(validateProviderEndpoint(value, { lookup: publicLookup }), (error) => {
      assert.equal(error.code, 'invalid_endpoint');
      assert.ok(!String(error.message).includes(secret));
      return true;
    });
  }
});

test('local address classification covers the private, loopback and link-local ranges only', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isLocalAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', 'example.com', '']) {
    assert.equal(isLocalAddress(address), false, address);
  }
  assert.equal(await hostResolvesOnlyToLocalAddresses('localhost'), true);
  assert.equal(await hostResolvesOnlyToLocalAddresses('box.localhost'), true);
  assert.equal(await hostResolvesOnlyToLocalAddresses('', { lookup: privateLookup }), false);
});
