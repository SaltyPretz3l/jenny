'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatRenderSummary,
  summarizeRenderBitmap,
} = require('../services/browser-render-summary');

function solidBitmap(width, height, [red, green, blue], format = 'rgba') {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (format === 'rgba') {
      bitmap[offset] = red;
      bitmap[offset + 1] = green;
      bitmap[offset + 2] = blue;
    } else {
      bitmap[offset] = blue;
      bitmap[offset + 1] = green;
      bitmap[offset + 2] = red;
    }
    bitmap[offset + 3] = 255;
  }
  return bitmap;
}

describe('browser render summary', () => {
  test('solid bitmap is blank with one dominant color', () => {
    const summary = summarizeRenderBitmap({
      bitmap: solidBitmap(6, 3, [255, 0, 0]),
      width: 6,
      height: 3,
      format: 'rgba',
    });

    assert.deepEqual(Object.keys(summary), [
      'width',
      'height',
      'dominant_color',
      'dominant_share',
      'distinct_colors',
      'verdict',
      'grid',
    ]);
    assert.equal(summary.verdict, 'blank');
    assert.equal(summary.dominant_color, '#ff0000');
    assert.equal(summary.dominant_share, 1);
    assert.equal(summary.distinct_colors, 1);
  });

  test('half-and-half two-color bitmap is mixed and grid cells summarize locally', () => {
    const bitmap = Buffer.alloc(6 * 3 * 4);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const offset = (y * 6 + x) * 4;
        const red = x < 3;
        bitmap[offset] = red ? 255 : 0;
        bitmap[offset + 1] = 0;
        bitmap[offset + 2] = red ? 0 : 255;
        bitmap[offset + 3] = 255;
      }
    }

    const summary = summarizeRenderBitmap({ bitmap, width: 6, height: 3, format: 'rgba' });

    assert.equal(summary.verdict, 'mixed');
    assert.equal(summary.dominant_share, 0.5);
    assert.equal(summary.distinct_colors, 2);
    assert.equal(summary.grid[0].dominant_color, '#ff0000');
    assert.equal(summary.grid[2].dominant_color, '#0000ff');
  });

  test('deterministic noisy bitmap is mixed', () => {
    const width = 24;
    const height = 18;
    const bitmap = Buffer.alloc(width * height * 4);
    let state = 0x12345678;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bitmap[offset] = state & 0xff;
      bitmap[offset + 1] = (state >>> 8) & 0xff;
      bitmap[offset + 2] = (state >>> 16) & 0xff;
      bitmap[offset + 3] = 255;
    }

    const summary = summarizeRenderBitmap({ bitmap, width, height, format: 'rgba' });

    assert.equal(summary.verdict, 'mixed');
    assert.ok(summary.distinct_colors > 2);
    assert.ok(summary.dominant_share < 0.9);
  });

  test('a sparse page is near-uniform with a softer warning, not a blank verdict', () => {
    const width = 30;
    const height = 12;
    const bitmap = solidBitmap(width, height, [255, 255, 255]);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const offset = (y * width + x) * 4;
        bitmap[offset] = 0;
        bitmap[offset + 1] = 0;
        bitmap[offset + 2] = 0;
      }
    }

    const summary = summarizeRenderBitmap({ bitmap, width, height, format: 'rgba' });
    const formatted = formatRenderSummary(summary);

    assert.equal(summary.verdict, 'near-uniform');
    assert.equal(summary.distinct_colors, 2);
    assert.match(formatted, /^Warning: 93\.3% of pixels are one flat color/);
    assert.match(formatted, /may be mostly empty or covered by a single fill/);
    assert.doesNotMatch(formatted, /probably visually broken/);
    assert.match(formatted, /Render: near-uniform/);
  });

  test('undersized bitmap returns null', () => {
    assert.equal(
      summarizeRenderBitmap({ bitmap: Buffer.alloc(15), width: 2, height: 2 }),
      null
    );
  });

  test('rgba and bgra channel order produce the correct hex color', () => {
    const rgba = summarizeRenderBitmap({
      bitmap: solidBitmap(3, 3, [255, 0, 0], 'rgba'),
      width: 3,
      height: 3,
      format: 'rgba',
    });
    const bgra = summarizeRenderBitmap({
      bitmap: solidBitmap(3, 3, [255, 0, 0], 'bgra'),
      width: 3,
      height: 3,
      format: 'bgra',
    });

    assert.equal(rgba.dominant_color, '#ff0000');
    assert.equal(bgra.dominant_color, '#ff0000');
  });

  test('formatted blank summary warns that the page is probably broken', () => {
    const summary = summarizeRenderBitmap({
      bitmap: solidBitmap(3, 3, [0, 0, 0]),
      width: 3,
      height: 3,
      format: 'rgba',
    });
    const formatted = formatRenderSummary(summary);

    assert.match(formatted, /^Warning:/);
    assert.match(formatted, /single flat color/i);
    assert.match(formatted, /probably visually broken/i);
    assert.match(formatted, /Render: blank/);
  });
});
