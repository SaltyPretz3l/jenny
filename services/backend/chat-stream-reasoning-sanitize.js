const REASONING_SANITIZE_OVERLAP_CHARS = 8;
const REASONING_MARKER_RE = /<\/?think>|<\|channel>thought|<channel\|>|^\s*_?thought[\s:>_-]*/gim;
const REASONING_FIXED_MARKERS = ['<think>', '</think>', '<|channel>thought', '<channel|>'];
const REASONING_MAX_MARKER_CHARS = Math.max(
  ...REASONING_FIXED_MARKERS.map((marker) => marker.length)
);
// Bounded suffix view for the per-delta trailing-edge inspections below. The
// raw tail grows to the persisted cap (up to 262,144 chars) while deltas stay
// tiny, so any full-tail scan here is O(n) per delta = O(n^2) per stream in
// the Electron MAIN process — the whole-app-lag class this file exists to
// prevent. Every check only concerns the trailing edge; the window is sized
// far past any marker/whitespace run a real stream produces, and the two
// ambiguous cases below fall back to an exact full scan rather than guess.
const REASONING_TAIL_SCAN_WINDOW_CHARS = 4096;
const TRAILING_THOUGHT_RE = /(?:^|\n)\s*_?thought[\s:>_-]*$/i;
const PARTIAL_THOUGHT_LINE_RE = /^\s*_?(?:t(?:h(?:o(?:u(?:g(?:h(?:t)?)?)?)?)?)?)[\s:>_-]*$/i;

function sanitizePersistedReasoningText(value) {
  let text = String(value || '')
    .replace(REASONING_MARKER_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) {
    return { text: '' };
  }
  return { text: text.trim() };
}

function trailingWhitespaceLength(text, endIndex) {
  let index = endIndex;
  while (index > 0 && /\s/.test(text[index - 1])) index -= 1;
  return endIndex - index;
}

function trailingMarkerPrefixLength(value) {
  // A marker PREFIX is strictly shorter than the marker, so the bounded
  // lowercase suffix answers every endsWith probe exactly.
  const suffix = String(value || '').slice(-REASONING_MAX_MARKER_CHARS).toLowerCase();
  let prefixLength = 0;
  for (const marker of REASONING_FIXED_MARKERS) {
    for (let length = 1; length < marker.length; length += 1) {
      if (suffix.endsWith(marker.slice(0, length))) prefixLength = Math.max(prefixLength, length);
    }
  }
  return prefixLength;
}

function boundarySanitizeState(rawTailText, sanitizedTailText) {
  const rawTail = String(rawTailText || '');
  let previousSanitized = String(sanitizedTailText || '');
  const markerSuffix = rawTail.slice(-REASONING_MAX_MARKER_CHARS).toLowerCase();
  const trailingMarker = REASONING_FIXED_MARKERS.find((marker) => markerSuffix.endsWith(marker));
  if (trailingMarker) {
    const markerStart = rawTail.length - trailingMarker.length;
    const whitespaceLength = trailingWhitespaceLength(rawTail, markerStart);
    return { previousSanitized, pendingRawText: rawTail.slice(markerStart - whitespaceLength) };
  }
  const tailWindow = rawTail.slice(-REASONING_TAIL_SCAN_WINDOW_CHARS);
  const windowIsPartial = rawTail.length > tailWindow.length;
  let trailingThoughtMarker = tailWindow.match(TRAILING_THOUGHT_RE);
  if (trailingThoughtMarker && windowIsPartial) {
    // The window's `^` is mid-string and `\s*` may extend left of the window;
    // resolve exactly. Only reached when the tail actually ends in a
    // thought-marker-shaped run, so the full scan stays rare.
    trailingThoughtMarker = rawTail.match(TRAILING_THOUGHT_RE);
  }
  if (trailingThoughtMarker) {
    return { previousSanitized, pendingRawText: trailingThoughtMarker[0] };
  }
  const windowNewline = tailWindow.lastIndexOf('\n');
  let lastLine;
  let lastLineStart;
  if (windowNewline !== -1) {
    lastLine = tailWindow.slice(windowNewline + 1);
    lastLineStart = rawTail.length - lastLine.length;
  } else if (!windowIsPartial) {
    lastLine = rawTail;
    lastLineStart = 0;
  } else if (PARTIAL_THOUGHT_LINE_RE.test(tailWindow)) {
    // A >window-sized line whose visible suffix is still entirely
    // marker-shaped — resolve the true line start exactly (rare).
    lastLineStart = rawTail.lastIndexOf('\n') + 1;
    lastLine = rawTail.slice(lastLineStart);
  } else {
    // The last line overflows the window and is provably not a partial
    // marker line: same outcome as the not-partial branch below.
    lastLine = null;
    lastLineStart = -1;
  }
  if (lastLine === null || !PARTIAL_THOUGHT_LINE_RE.test(lastLine)) {
    const whitespaceLength = trailingWhitespaceLength(rawTail, rawTail.length);
    return { previousSanitized, pendingRawText: rawTail.slice(rawTail.length - whitespaceLength) };
  }
  if (lastLine && previousSanitized.endsWith(lastLine)) {
    let boundaryStart = previousSanitized.length - lastLine.length;
    if (previousSanitized[boundaryStart - 1] === '\n') boundaryStart -= 1;
    previousSanitized = previousSanitized.slice(0, boundaryStart);
  }
  return { previousSanitized, pendingRawText: rawTail.slice(Math.max(0, lastLineStart - 1)) };
}

function sanitizeGrowingReasoningTail(rawTailText, incomingText, sanitizedTailText) {
  const rawTail = String(rawTailText || '');
  const { previousSanitized, pendingRawText } = boundarySanitizeState(rawTail, sanitizedTailText);
  const markerPrefixLength = trailingMarkerPrefixLength(rawTail);
  const overlapLength = Math.min(
    previousSanitized.length,
    Math.max(REASONING_SANITIZE_OVERLAP_CHARS, markerPrefixLength)
  );
  const stablePrefix = previousSanitized.slice(0, previousSanitized.length - overlapLength);
  const sanitizedOverlap = previousSanitized.slice(previousSanitized.length - overlapLength);
  const sentinel = stablePrefix ? '\u0000' : '';
  const boundaryInput = `${sentinel}${sanitizedOverlap}${pendingRawText}${incomingText}`;
  let boundaryText = sanitizePersistedReasoningText(boundaryInput).text;
  if (sentinel && boundaryText.startsWith(sentinel)) boundaryText = boundaryText.slice(sentinel.length);
  return `${stablePrefix}${boundaryText}`;
}

module.exports = {
  sanitizeGrowingReasoningTail,
  sanitizePersistedReasoningText,
};
