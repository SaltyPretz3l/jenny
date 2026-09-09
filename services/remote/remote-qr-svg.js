'use strict';

const { encode } = require('./qr-encoder');

const COLOR_RE = /^(?:#[A-Fa-f0-9]{3,8}|[A-Za-z]+)$/;

function validInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function renderQrSvg(text, {
  moduleSize = 4,
  margin = 4,
  dark = '#000',
  light = '#fff',
} = {}) {
  if (typeof text !== 'string' || text.length === 0
    || !validInteger(moduleSize, 1) || !validInteger(margin, 0)
    || !COLOR_RE.test(dark) || !COLOR_RE.test(light)) {
    throw new TypeError('Invalid QR SVG input.');
  }

  let encoded;
  try {
    encoded = encode(text);
  } catch (error) {
    throw new TypeError('Invalid QR SVG input.', { cause: error });
  }

  const dimension = (encoded.size + (margin * 2)) * moduleSize;
  if (!Number.isSafeInteger(dimension)) throw new TypeError('Invalid QR SVG input.');
  const commands = [];
  for (let row = 0; row < encoded.size; row += 1) {
    for (let column = 0; column < encoded.size; column += 1) {
      if (!encoded.modules[row][column]) continue;
      const x = (column + margin) * moduleSize;
      const y = (row + margin) * moduleSize;
      commands.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="${dimension}" height="${dimension}" fill="${light}"/><path fill="${dark}" d="${commands.join('')}"/></svg>`;
}

module.exports = { renderQrSvg };
