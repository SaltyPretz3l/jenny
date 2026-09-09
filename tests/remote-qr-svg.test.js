'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encode } = require('../services/remote/qr-encoder');
const { renderQrSvg } = require('../services/remote/remote-qr-svg');

test('renders the known version-four matrix as one safe compact SVG path', () => {
  const value = 'https://remote.example/#p=1234567890123456789012345678901234';
  assert.equal(value.length, 60);
  const qr = encode(value);
  const svg = renderQrSvg(value);
  const darkModules = qr.modules.flat().filter(Boolean).length;

  assert.equal(qr.size, 33);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 164 164" shape-rendering="crispEdges">/);
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.equal((svg.match(/M/g) || []).length, darkModules);
  assert.equal(/[^A-Za-z0-9 #<>.="/:-]/.test(svg), false);
});

test('validates text, capacity, geometry, and colors before rendering', () => {
  assert.throws(() => renderQrSvg(), TypeError);
  assert.throws(() => renderQrSvg(''), TypeError);
  assert.throws(() => renderQrSvg('x'.repeat(1_000)), TypeError);
  assert.throws(() => renderQrSvg('ok', { moduleSize: 0 }), TypeError);
  assert.throws(() => renderQrSvg('ok', { margin: -1 }), TypeError);
  assert.throws(() => renderQrSvg('ok', { dark: 'red"/>' }), TypeError);
});
