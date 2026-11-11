/* renderer/features/renderer-ide-follow-draft-model.js - the Follow Jenny in-place draft text and its line bookkeeping, pure (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeFollowDraftModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The draft is the current file with, at each change, the replaced lines kept and the new
     text directly beneath them. Placement comes only from where oldText occurs in the base,
     so there is no diff: a placed edit covers whole lines of the base. */

  const NEWLINE = 10;

  function normalize(value) {
    if (typeof value !== 'string') return '';
    return value.indexOf('\r') === -1 ? value : value.replace(/\r\n?/g, '\n');
  }

  function countNewlines(text) {
    let count = 0;
    let at = text.indexOf('\n');
    while (at !== -1) {
      count += 1;
      at = text.indexOf('\n', at + 1);
    }
    return count;
  }

  function buildLineStarts(text) {
    const starts = new Int32Array(countNewlines(text) + 1);
    let k = 1;
    let at = text.indexOf('\n');
    while (at !== -1) {
      starts[k++] = at + 1;
      at = text.indexOf('\n', at + 1);
    }
    return starts;
  }

  /* Index of the line containing the offset (largest start at or before it). */
  function lineIndexOf(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /* First occurrence of old in base that overlaps none of the claimed ranges, or -1. */
  function findFree(base, old, claims) {
    let pos = base.indexOf(old);
    while (pos !== -1) {
      const end = pos + old.length;
      let blockedUntil = -1;
      for (let i = 0; i < claims.length; i += 1) {
        if (pos < claims[i].e && claims[i].s < end) {
          blockedUntil = claims[i].e;
          break;
        }
      }
      if (blockedUntil === -1) return pos;
      pos = base.indexOf(old, Math.max(blockedUntil, pos + 1));
    }
    return -1;
  }

  function readEdit(raw, slot) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const oldRaw = typeof src.oldText === 'string' ? src.oldText : '';
    return {
      oldRaw,
      oldText: slot.oldRaw === oldRaw ? slot.oldNorm : normalize(oldRaw),
      oldDone: !!src.oldDone,
      newText: normalize(src.newText),
      newStarted: !!src.newStarted,
      newDone: !!src.newDone,
    };
  }

  /* Number of view lines a replacement shows: empty is none, unless its trailing newline was dropped. */
  function blockLineCount(text, trimmed) {
    return text === '' && !trimmed ? 0 : countNewlines(text) + 1;
  }

  /* The position just after the first `offset` characters of a block that starts at `blockStart`. */
  function caretIn(block, offset, blockStart, lineTotal) {
    if (lineTotal === 0) return { line: blockStart, column: 1 };
    const before = block.slice(0, Math.min(offset, block.length));
    return {
      line: blockStart + countNewlines(before),
      column: before.length - (before.lastIndexOf('\n') + 1) + 1,
    };
  }

  function buildWriteView(content, done) {
    const text = normalize(content);
    const lineCount = countNewlines(text) + 1;
    return {
      text,
      regions: [],
      caret: done ? null : { line: lineCount, column: text.length - (text.lastIndexOf('\n') + 1) + 1 },
      lineCount,
    };
  }

  /* Merge placements that touch the same line into one group; input is in base order. */
  function groupPlacements(sorted) {
    const groups = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      if (g && p.firstLine <= g.lastLine) {
        g.members.push(p);
        g.lastLine = Math.max(g.lastLine, p.lastLine);
        g.rEnd = p.rEnd;
      } else {
        groups.push({ members: [p], ls: p.ls, firstLine: p.firstLine, lastLine: p.lastLine, rEnd: p.rEnd });
      }
    }
    return groups;
  }

  function createEditDraft(baseText) {
    const base = normalize(baseText);
    const starts = buildLineStarts(base);
    const slots = [];

    function place(parsed) {
      const claims = [];
      let claimKey = '';
      for (const ed of parsed) {
        const slot = slots[ed.index];
        slot.oldRaw = ed.oldRaw;
        slot.oldNorm = ed.oldText;
        if (!ed.oldDone || ed.oldText === '') {
          slot.found = null;
          continue;
        }
        let found = slot.found;
        if (!found || found.old !== ed.oldText || found.key !== claimKey) {
          found = slot.found = { old: ed.oldText, key: claimKey, s: findFree(base, ed.oldText, claims) };
        }
        if (found.s < 0) continue;
        const s = found.s;
        const e = s + ed.oldText.length;
        claims.push({ s, e, ed });
        claimKey += `${s}:${e},`;
      }
      return claims;
    }

    function describePlacement(p) {
      p.firstLine = lineIndexOf(starts, p.s);
      p.lastLine = lineIndexOf(starts, p.e - 1);
      p.ls = starts[p.firstLine];
      p.nlLast = base.charCodeAt(p.e - 1) === NEWLINE;
      if (p.nlLast) p.rEnd = p.e - 1;
      else p.rEnd = p.lastLine + 1 < starts.length ? starts[p.lastLine + 1] - 1 : base.length;
      return p;
    }

    function update(edits) {
      const list = Array.isArray(edits) ? edits : [];
      if (slots.length > list.length) slots.length = list.length;
      const parsed = [];
      let arriving = -1;
      for (let i = 0; i < list.length; i += 1) {
        const slot = slots[i] || (slots[i] = { oldRaw: null, oldNorm: '', found: null });
        const ed = readEdit(list[i], slot);
        ed.index = i;
        parsed.push(ed);
        if (ed.newStarted && !ed.newDone) arriving = i;
      }

      const claims = place(parsed);
      const placedIndex = new Set(claims.map((c) => c.ed.index));
      const groups = groupPlacements(claims.map(describePlacement).sort((a, b) => a.s - b.s));

      let text = '';
      let cursor = 0;
      let addedTotal = 0;
      let caret = null;
      const regions = [];

      for (const g of groups) {
        let replacement = '';
        let at = g.ls;
        let started = false;
        for (const m of g.members) {
          replacement += base.slice(at, m.s);
          replacement += m.ed.newStarted ? m.ed.newText : m.ed.oldText;
          started = started || m.ed.newStarted;
          m.replacementEnd = replacement.length;
          at = m.e;
        }
        const lastMember = g.members[g.members.length - 1];
        let trimmed = false;
        if (lastMember.nlLast) {
          if (replacement.charCodeAt(replacement.length - 1) === NEWLINE) {
            replacement = replacement.slice(0, -1);
            trimmed = true;
          }
        } else {
          replacement += base.slice(at, g.rEnd);
        }
        const addedCount = started ? blockLineCount(replacement, trimmed) : 0;
        const removedCount = g.lastLine - g.firstLine + 1;
        const removedStart = g.firstLine + 1 + addedTotal;
        const addedStart = removedStart + removedCount;
        text += base.slice(cursor, g.rEnd);
        cursor = g.rEnd;
        if (addedCount > 0) text += `\n${replacement}`;
        regions.push({ editIndex: g.members[0].ed.index, placed: true, removedStart, removedCount, addedStart, addedCount });
        addedTotal += addedCount;
        const arrivingMember = arriving >= 0 && g.members.find((m) => m.ed.index === arriving);
        if (arrivingMember) caret = caretIn(replacement, arrivingMember.replacementEnd, addedStart, addedCount);
      }
      text += base.slice(cursor);

      let lineCount = starts.length + addedTotal;
      for (const ed of parsed) {
        if (placedIndex.has(ed.index) || !ed.newStarted) continue;
        const trimmed = ed.newText.charCodeAt(ed.newText.length - 1) === NEWLINE;
        const block = trimmed ? ed.newText.slice(0, -1) : ed.newText;
        const count = blockLineCount(block, trimmed);
        if (count === 0) continue;
        const start = lineCount + 1;
        regions.push({ editIndex: ed.index, placed: false, removedStart: start, removedCount: 0, addedStart: start, addedCount: count });
        text += `\n${block}`;
        lineCount += count;
        if (ed.index === arriving) caret = caretIn(block, ed.newText.length, start, count);
      }

      return { text, regions, caret, lineCount };
    }

    return { update };
  }

  function describeLine(view, lineNumber) {
    const none = { kind: 'context', label: '' };
    if (!view || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > view.lineCount) return none;
    const regions = view.regions || [];
    let removedBefore = 0;
    let addedBefore = 0;
    for (let i = 0; i < regions.length; i += 1) {
      const r = regions[i];
      if (lineNumber < r.removedStart) break;
      if (lineNumber < r.removedStart + r.removedCount) return { kind: 'removed', label: String(lineNumber - addedBefore) };
      if (lineNumber < r.addedStart + r.addedCount) {
        return { kind: 'added', label: String(lineNumber - removedBefore - r.removedCount) };
      }
      removedBefore += r.removedCount;
      addedBefore += r.addedCount;
    }
    return { kind: 'context', label: String(lineNumber - removedBefore) };
  }

  const isHigh = (code) => code >= 0xD800 && code < 0xDC00;
  const isLow = (code) => code >= 0xDC00 && code < 0xE000;

  /* The smallest { start, end, text } with next === previous.slice(0, start) + text + previous.slice(end). */
  function spliceBetween(previousText, nextText) {
    const previous = typeof previousText === 'string' ? previousText : '';
    const next = typeof nextText === 'string' ? nextText : '';
    if (previous === next) return null;
    // Text arriving at the end, the common case: no scan from both ends of a large file.
    if (next.length > previous.length && next.startsWith(previous)
      && !(isHigh(previous.charCodeAt(previous.length - 1)) && isLow(next.charCodeAt(previous.length)))) {
      return { start: previous.length, end: previous.length, text: next.slice(previous.length) };
    }
    const shortest = Math.min(previous.length, next.length);
    let start = 0;
    while (start < shortest && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;
    let tail = 0;
    while (tail < shortest - start
      && previous.charCodeAt(previous.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail += 1;
    let end = previous.length - tail;
    let nextEnd = next.length - tail;
    if (start > 0 && isHigh(previous.charCodeAt(start - 1))
      && (isLow(previous.charCodeAt(start)) || isLow(next.charCodeAt(start)))) start -= 1;
    if (end < previous.length && isLow(previous.charCodeAt(end))
      && (isHigh(previous.charCodeAt(end - 1)) || isHigh(next.charCodeAt(nextEnd - 1)))) {
      end += 1;
      nextEnd += 1;
    }
    return { start, end, text: next.slice(start, nextEnd) };
  }

  return { createEditDraft, buildWriteView, describeLine, spliceBetween };
});
