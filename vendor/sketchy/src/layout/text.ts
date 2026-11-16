/**
 * Text metrics for the handwriting font, without a DOM.
 *
 * Widths are per-character estimates in em for Kalam, rounded up slightly so
 * boxes err on the roomy side; the viewer shrinks text that still overflows.
 */

import { extraHeight, labelWidth } from "../math/inline.js";

const NARROW = new Set([..."il.,:;'|!`()[]{}/\\ "]);
const WIDE = new Set([..."mwMW@%&"]);

export function charWidthEm(ch: string): number {
  if (NARROW.has(ch)) return 0.3;
  if (WIDE.has(ch)) return 0.82;
  if (/[A-Z]/.test(ch)) return 0.62;
  if (/[0-9]/.test(ch)) return 0.55;
  if (ch === "-" || ch === "_") return 0.45;
  return 0.52;
}

export function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += charWidthEm(ch);
  return em * fontSize;
}

/** Width of a line that may contain $math$. */
export function richWidth(text: string, fontSize: number): number {
  return text.includes("$") ? labelWidth(text, fontSize) : textWidth(text, fontSize);
}

/** Words of a paragraph; a $formula$ stays one word, spaces and all. */
function words(paragraph: string): string[] {
  const out: string[] = [];
  let word = "";
  let math = false;
  for (const c of paragraph) {
    if (c === "$") math = !math;
    if (/\s/.test(c) && !math) {
      if (word) out.push(word);
      word = "";
    } else word += c;
  }
  if (word) out.push(word);
  return out;
}

/** Greedy word wrap; words longer than the limit are broken by character. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of words(paragraph)) {
      const candidate = line ? `${line} ${word}` : word;
      if (richWidth(candidate, fontSize) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      // Formulas are never broken; one too wide simply overflows.
      if (word.includes("$")) {
        line = word;
        continue;
      }
      let rest = word;
      while (textWidth(rest, fontSize) > maxWidth) {
        let cut = 1;
        while (cut < rest.length && textWidth(rest.slice(0, cut + 1), fontSize) <= maxWidth) {
          cut++;
        }
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

export function lineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.3);
}

export type MeasuredText = { lines: string[]; width: number; height: number };

/** Top offsets of each line in a block, taller where formulas need room. */
export function lineTops(lines: string[], fontSize: number): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const line of lines) {
    const extra = extraHeight(line, fontSize);
    tops.push(y + extra / 2);
    y += lineHeight(fontSize) + extra;
  }
  return tops;
}

export function blockHeight(lines: string[], fontSize: number): number {
  return lines.reduce((h, l) => h + lineHeight(fontSize) + extraHeight(l, fontSize), 0);
}

export function measureText(text: string, fontSize: number, maxWidth: number): MeasuredText {
  const lines = wrapText(text, fontSize, maxWidth);
  const width = Math.max(0, ...lines.map((l) => richWidth(l, fontSize)));
  return { lines, width: Math.ceil(width), height: blockHeight(lines, fontSize) };
}
