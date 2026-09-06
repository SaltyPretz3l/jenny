'use strict';

function increment(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function quantizedColor(key) {
  const red = ((key >>> 8) & 0xf) * 17;
  const green = ((key >>> 4) & 0xf) * 17;
  const blue = (key & 0xf) * 17;
  return `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
}

function summarizeCounts(counts, total) {
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of counts) {
    if (count > dominantCount) {
      dominantKey = key;
      dominantCount = count;
    }
  }
  return {
    dominant_color: quantizedColor(dominantKey),
    dominant_share: total > 0 ? Math.round((dominantCount / total) * 1000) / 1000 : 0,
  };
}

function summarizeRenderBitmap({ bitmap, width, height, format = 'bgra' } = {}) {
  if (
    !Buffer.isBuffer(bitmap)
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width <= 0
    || height <= 0
    || !['bgra', 'rgba'].includes(format)
  ) {
    return null;
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || bitmap.length < pixelCount * 4) {
    return null;
  }

  const counts = new Map();
  const gridCounts = Array.from({ length: 9 }, () => new Map());
  const gridTotals = new Uint32Array(9);
  const firstColumnEnd = Math.floor(width / 3);
  const secondColumnEnd = Math.floor((width * 2) / 3);
  const firstRowEnd = Math.floor(height / 3);
  const secondRowEnd = Math.floor((height * 2) / 3);
  const redOffset = format === 'rgba' ? 0 : 2;
  const blueOffset = format === 'rgba' ? 2 : 0;

  for (let y = 0; y < height; y += 1) {
    const gridRow = y < firstRowEnd ? 0 : y < secondRowEnd ? 1 : 2;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const key = ((bitmap[offset + redOffset] >>> 4) << 8)
        | ((bitmap[offset + 1] >>> 4) << 4)
        | (bitmap[offset + blueOffset] >>> 4);
      const gridColumn = x < firstColumnEnd ? 0 : x < secondColumnEnd ? 1 : 2;
      const gridIndex = gridRow * 3 + gridColumn;
      increment(counts, key);
      increment(gridCounts[gridIndex], key);
      gridTotals[gridIndex] += 1;
    }
  }

  const dominant = summarizeCounts(counts, pixelCount);
  const distinctColors = counts.size;
  // Verdicts key off the dominant share alone: a two-colour split page is a
  // legitimate layout, while >=90% of one quantized colour is what a
  // full-viewport fill or an empty page looks like.
  const verdict = dominant.dominant_share >= 0.995
    ? 'blank'
    : dominant.dominant_share >= 0.9
      ? 'near-uniform'
      : 'mixed';
  return {
    width,
    height,
    dominant_color: dominant.dominant_color,
    dominant_share: dominant.dominant_share,
    distinct_colors: distinctColors,
    verdict,
    grid: gridCounts.map((cellCounts, index) => summarizeCounts(cellCounts, gridTotals[index])),
  };
}

function formatPercent(share) {
  return `${Number((share * 100).toFixed(1))}%`;
}

function formatRenderSummary(summary) {
  if (!summary) {
    return 'Render: unavailable (no pixel capture)';
  }
  const grid = summary.grid
    .map((cell) => `${cell.dominant_color} ${formatPercent(cell.dominant_share)}`)
    .join(' | ');
  const renderLine = `Render: ${summary.verdict} — dominant ${summary.dominant_color} ${formatPercent(summary.dominant_share)} of pixels, ${summary.distinct_colors} distinct colors (3x3 grid: ${grid})`;
  if (summary.verdict === 'blank') {
    return `Warning: the page rendered as a single flat color (${formatPercent(summary.dominant_share)} of pixels are ${summary.dominant_color}) and is probably visually broken even though no errors were reported.\n${renderLine}`;
  }
  if (summary.verdict === 'near-uniform') {
    return `Warning: ${formatPercent(summary.dominant_share)} of pixels are one flat color (${summary.dominant_color}); the page may be mostly empty or covered by a single fill. Check the grid or request a screenshot before assuming it rendered correctly.\n${renderLine}`;
  }
  return renderLine;
}

module.exports = {
  formatRenderSummary,
  summarizeRenderBitmap,
};
