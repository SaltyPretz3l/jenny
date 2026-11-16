'use strict';

// Tells a change in a page's picture from the page's own motion (a spinner, a
// game, a carousel). Works on the small bitmaps the browser session returns
// with every screenshot: four bytes a pixel.

// A colour channel has to move this far before a pixel counts as different,
// so resampling noise in the small bitmap is not read as motion.
const CHANNEL_TOLERANCE = 12;

function usable(thumb) {
  return Boolean(thumb) && Buffer.isBuffer(thumb.bitmap) && thumb.width > 0 && thumb.height > 0
    && thumb.bitmap.length >= thumb.width * thumb.height * 4;
}

function comparable(left, right) {
  return usable(left) && usable(right) && left.width === right.width && left.height === right.height;
}

function differsAt(left, right, offset) {
  return Math.abs(left[offset] - right[offset]) > CHANNEL_TOLERANCE
    || Math.abs(left[offset + 1] - right[offset + 1]) > CHANNEL_TOLERANCE
    || Math.abs(left[offset + 2] - right[offset + 2]) > CHANNEL_TOLERANCE;
}

// `before` and `after` are each { thumb, earlierThumb }: the picture that was
// kept and, for a page that never held still, the one taken just before it.
// -> { moving, changed }: pixels the pages change on their own, and pixels
//    that differ between Before and After where neither page moves.
// -> null when the bitmaps cannot be compared.
function measureChange(before, after) {
  if (!comparable(before?.thumb, after?.thumb)) return null;
  const motion = [before, after]
    .filter((side) => side.earlierThumb)
    .map((side) => (comparable(side.thumb, side.earlierThumb) ? [side.thumb.bitmap, side.earlierThumb.bitmap] : null));
  if (motion.includes(null)) return null;
  const left = before.thumb.bitmap;
  const right = after.thumb.bitmap;
  let moving = 0;
  let changed = 0;
  for (let offset = 0, end = before.thumb.width * before.thumb.height * 4; offset < end; offset += 4) {
    if (motion.some(([now, earlier]) => differsAt(now, earlier, offset))) moving += 1;
    else if (differsAt(left, right, offset)) changed += 1;
  }
  return { moving, changed };
}

// True when the change stands out from the pages' own motion. Motion alone
// leaves fewer changed pixels outside the moving area than inside it, so a
// real change has to beat that. In doubt the answer is no: a pair of pictures
// that differ for no reason the person asked for is worse than none.
function changeShowsThroughMotion(before, after) {
  const measured = measureChange(before, after);
  return Boolean(measured) && measured.changed > measured.moving;
}

module.exports = {
  changeShowsThroughMotion,
  measureChange,
};
