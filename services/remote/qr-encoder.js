'use strict';

  // Minimal byte-mode QR encoder derived from qrcode-generator by Kazuhiko
  // Arase (MIT). Remote Control needs only versions 1-10 and EC level M.
  const BLOCKS_M = Object.freeze([
    null,
    [[1, 26, 16]],
    [[1, 44, 28]],
    [[1, 70, 44]],
    [[2, 50, 32]],
    [[2, 67, 43]],
    [[4, 43, 27]],
    [[4, 49, 31]],
    [[2, 60, 38], [2, 61, 39]],
    [[3, 58, 36], [2, 59, 37]],
    [[4, 69, 43], [1, 70, 44]],
  ]);
  const ALIGNMENT = Object.freeze([
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ]);
  const EXP = new Array(512);
  const LOG = new Array(256).fill(0);
  let field = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = field;
    LOG[field] = index;
    field <<= 1;
    if (field & 0x100) field ^= 0x11d;
  }
  for (let index = 255; index < EXP.length; index += 1) EXP[index] = EXP[index - 255];

  function multiply(left, right) {
    return left && right ? EXP[LOG[left] + LOG[right]] : 0;
  }

  function utf8(text) {
    const bytes = [];
    for (const symbol of String(text)) {
      const point = symbol.codePointAt(0);
      if (point < 0x80) bytes.push(point);
      else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      else if (point < 0x10000) bytes.push(
        0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f),
      );
      else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
    return bytes;
  }

  function expandedBlocks(version) {
    return BLOCKS_M[version].flatMap(([count, total, data]) => (
      Array.from({ length: count }, () => ({ total, data }))
    ));
  }

  function appendBits(bits, value, length) {
    for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >>> shift) & 1);
  }

  function dataCodewords(bytes, version, capacity) {
    const bits = [];
    appendBits(bits, 4, 4);
    appendBits(bits, bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes) appendBits(bits, byte, 8);
    const bitCapacity = capacity * 8;
    appendBits(bits, 0, Math.min(4, bitCapacity - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let offset = 0; offset < bits.length; offset += 8) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[offset + bit];
      data.push(value);
    }
    for (let pad = 0; data.length < capacity; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
    return data;
  }

  function generator(degree) {
    let polynomial = [1];
    for (let exponent = 0; exponent < degree; exponent += 1) {
      const next = new Array(polynomial.length + 1).fill(0);
      for (let index = 0; index < polynomial.length; index += 1) {
        next[index] ^= polynomial[index];
        next[index + 1] ^= multiply(polynomial[index], EXP[exponent]);
      }
      polynomial = next;
    }
    return polynomial;
  }

  function errorCorrection(data, count) {
    const polynomial = generator(count);
    const remainder = [...data, ...new Array(count).fill(0)];
    for (let index = 0; index < data.length; index += 1) {
      const ratio = remainder[index];
      if (!ratio) continue;
      for (let term = 0; term < polynomial.length; term += 1) {
        remainder[index + term] ^= multiply(polynomial[term], ratio);
      }
    }
    return remainder.slice(data.length);
  }

  function interleave(data, blocks) {
    const dataBlocks = [];
    const correctionBlocks = [];
    let offset = 0;
    for (const block of blocks) {
      const part = data.slice(offset, offset + block.data);
      offset += block.data;
      dataBlocks.push(part);
      correctionBlocks.push(errorCorrection(part, block.total - block.data));
    }
    const result = [];
    const maxData = Math.max(...dataBlocks.map((part) => part.length));
    const maxCorrection = Math.max(...correctionBlocks.map((part) => part.length));
    for (let index = 0; index < maxData; index += 1) {
      for (const part of dataBlocks) if (index < part.length) result.push(part[index]);
    }
    for (let index = 0; index < maxCorrection; index += 1) {
      for (const part of correctionBlocks) if (index < part.length) result.push(part[index]);
    }
    return result;
  }

  function bch(value, polynomial) {
    let shifted = value;
    let top = 0;
    for (let n = polynomial; n; n >>>= 1) top += 1;
    while (true) {
      let bits = 0;
      for (let n = shifted; n; n >>>= 1) bits += 1;
      if (bits < top) break;
      shifted ^= polynomial << (bits - top);
    }
    return shifted;
  }

  function maskBit(mask, row, column) {
    const product = row * column;
    return [
      (row + column) % 2 === 0,
      row % 2 === 0,
      column % 3 === 0,
      (row + column) % 3 === 0,
      (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
      (product % 2) + (product % 3) === 0,
      ((product % 2) + (product % 3)) % 2 === 0,
      ((product % 3) + ((row + column) % 2)) % 2 === 0,
    ][mask];
  }

  function finder(matrix, row, column) {
    const size = matrix.length;
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const y = row + dy;
        const x = column + dx;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        matrix[y][x] = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6
          && (dy === 0 || dy === 6 || dx === 0 || dx === 6
            || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
      }
    }
  }

  function alignment(matrix, version) {
    const positions = ALIGNMENT[version];
    for (const row of positions) {
      for (const column of positions) {
        if (matrix[row][column] !== null) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            matrix[row + dy][column + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          }
        }
      }
    }
  }

  function versionInfo(matrix, version) {
    if (version < 7) return;
    const bits = (version << 12) | bch(version << 12, 0x1f25);
    const size = matrix.length;
    for (let index = 0; index < 18; index += 1) {
      const value = ((bits >> index) & 1) === 1;
      matrix[Math.floor(index / 3)][(index % 3) + size - 11] = value;
      matrix[(index % 3) + size - 11][Math.floor(index / 3)] = value;
    }
  }

  function formatInfo(matrix, mask) {
    const data = mask;
    const bits = ((data << 10) | bch(data << 10, 0x537)) ^ 0x5412;
    const size = matrix.length;
    for (let index = 0; index < 15; index += 1) {
      const value = ((bits >> index) & 1) === 1;
      if (index < 6) matrix[index][8] = value;
      else if (index < 8) matrix[index + 1][8] = value;
      else matrix[size - 15 + index][8] = value;
      if (index < 8) matrix[8][size - index - 1] = value;
      else if (index === 8) matrix[8][7] = value;
      else matrix[8][14 - index] = value;
    }
    matrix[size - 8][8] = true;
  }

  function placeCodewords(matrix, codewords, mask) {
    const size = matrix.length;
    let row = size - 1;
    let direction = -1;
    let byteIndex = 0;
    let bitIndex = 7;
    for (let column = size - 1; column > 0; column -= 2) {
      if (column === 6) column -= 1;
      while (true) {
        for (let lane = 0; lane < 2; lane += 1) {
          const x = column - lane;
          if (matrix[row][x] !== null) continue;
          const raw = byteIndex < codewords.length
            ? ((codewords[byteIndex] >>> bitIndex) & 1) === 1 : false;
          matrix[row][x] = maskBit(mask, row, x) ? !raw : raw;
          bitIndex -= 1;
          if (bitIndex < 0) { byteIndex += 1; bitIndex = 7; }
        }
        row += direction;
        if (row >= 0 && row < size) continue;
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }

  function makeMatrix(version, codewords, mask) {
    const size = version * 4 + 17;
    const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
    finder(matrix, 0, 0);
    finder(matrix, size - 7, 0);
    finder(matrix, 0, size - 7);
    alignment(matrix, version);
    for (let index = 8; index < size - 8; index += 1) {
      if (matrix[index][6] === null) matrix[index][6] = index % 2 === 0;
      if (matrix[6][index] === null) matrix[6][index] = index % 2 === 0;
    }
    versionInfo(matrix, version);
    formatInfo(matrix, mask);
    placeCodewords(matrix, codewords, mask);
    return matrix;
  }

  function penalty(matrix) {
    const size = matrix.length;
    let score = 0;
    let dark = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const value = matrix[row][column];
        if (value) dark += 1;
        let same = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if ((!dx && !dy) || row + dy < 0 || row + dy >= size
              || column + dx < 0 || column + dx >= size) continue;
            if (matrix[row + dy][column + dx] === value) same += 1;
          }
        }
        if (same > 5) score += 3 + same - 5;
        if (row < size - 1 && column < size - 1) {
          const count = [matrix[row + 1][column], matrix[row][column + 1],
            matrix[row + 1][column + 1]].filter((item) => item === value).length;
          if (count === 3) score += 3;
        }
        if (column + 6 < size && value && !matrix[row][column + 1]
          && matrix[row][column + 2] && matrix[row][column + 3]
          && matrix[row][column + 4] && !matrix[row][column + 5]
          && matrix[row][column + 6]) score += 40;
        if (row + 6 < size && value && !matrix[row + 1][column]
          && matrix[row + 2][column] && matrix[row + 3][column]
          && matrix[row + 4][column] && !matrix[row + 5][column]
          && matrix[row + 6][column]) score += 40;
      }
    }
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  function encode(text) {
    const bytes = utf8(text);
    let version = 1;
    let blocks;
    for (; version <= 10; version += 1) {
      blocks = expandedBlocks(version);
      const capacity = blocks.reduce((sum, block) => sum + block.data, 0);
      const countBits = version < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= capacity * 8) break;
    }
    if (version > 10) throw new RangeError('QR payload exceeds version 10 byte-mode capacity.');
    const capacity = blocks.reduce((sum, block) => sum + block.data, 0);
    const codewords = interleave(dataCodewords(bytes, version, capacity), blocks);
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      const matrix = makeMatrix(version, codewords, mask);
      const score = penalty(matrix);
      if (score < bestScore) { best = matrix; bestScore = score; }
    }
    return Object.freeze({ size: best.length, modules: best });
  }

module.exports = Object.freeze({ encode });
