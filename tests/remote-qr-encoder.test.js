'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encode } = require('../services/remote/qr-encoder');

const HELLO_MATRIX = Object.freeze([
  '111111101101001111111',
  '100000100110101000001',
  '101110100111101011101',
  '101110101001001011101',
  '101110101000101011101',
  '100000101011001000001',
  '111111101010101111111',
  '000000001111100000000',
  '100010111111011111001',
  '000111001011100101111',
  '101100101011001110010',
  '111001000100011010000',
  '001011100100111000110',
  '000000001110111001011',
  '111111101100110001010',
  '100000100001100100010',
  '101110101001001110101',
  '101110100001100001011',
  '101110100111001111000',
  '100000100100011000000',
  '111111101000111110101',
]);

function assertFinder(matrix, startRow, startColumn) {
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const expected = row === 0 || row === 6 || column === 0 || column === 6
        || (row >= 2 && row <= 4 && column >= 2 && column <= 4);
      assert.equal(matrix[startRow + row][startColumn + column], expected,
        `finder ${startRow},${startColumn} at ${row},${column}`);
    }
  }
}

function bch(value, polynomial) {
  let shifted = value;
  let top = 0;
  for (let n = polynomial; n; n >>>= 1) top += 1;
  while (true) {
    let bits = 0;
    for (let n = shifted; n; n >>>= 1) bits += 1;
    if (bits < top) return shifted;
    shifted ^= polynomial << (bits - top);
  }
}

test('HELLO produces the pinned version-1 M-level matrix', () => {
  const result = encode('HELLO');
  assert.equal(result.size, 21);
  assert.equal(result.modules.length, result.size);
  assert.equal(result.modules.every((row) => row.length === result.size), true);
  assert.deepEqual(result.modules.map((row) => (
    row.map((value) => (value ? '1' : '0')).join('')
  )), HELLO_MATRIX);
});

test('the matrix carries three finder patterns and valid M format bits', () => {
  const { size, modules } = encode('HELLO');
  assertFinder(modules, 0, 0);
  assertFinder(modules, size - 7, 0);
  assertFinder(modules, 0, size - 7);
  let encoded = 0;
  for (let index = 0; index < 15; index += 1) {
    const row = index < 6 ? index : (index < 8 ? index + 1 : size - 15 + index);
    if (modules[row][8]) encoded |= 1 << index;
  }
  const raw = encoded ^ 0x5412;
  assert.equal(bch(raw, 0x537), 0);
  assert.equal(raw >>> 13, 0, 'format EC bits are M');
});
