/**
 * Labels that mix text and $math$: splitting, measuring and laying out one
 * line, shared by the layout engine (sizes) and the renderers (drawing).
 */
import { textWidth } from "../layout/text.js";
import { texToText, typeset, type MathBox } from "./tex.js";

export type LabelRun =
  { k: "text"; x: number; text: string } | { k: "math"; x: number; box: MathBox };

/** "$x^2$ grows" → [{math:"x^2"}, {text:" grows"}]. "\$" is a literal dollar. */
export function splitMath(text: string): { math: boolean; text: string }[] {
  const out: { math: boolean; text: string }[] = [];
  let buf = "";
  let math = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && text[i + 1] === "$" && !math) {
      buf += "$";
      i++;
    } else if (c === "$") {
      if (buf) out.push({ math, text: buf });
      buf = "";
      math = !math;
    } else buf += c;
  }
  // An unclosed $ is text, so a price like "$5" still reads.
  if (buf) out.push({ math: false, text: math ? `$${buf}` : buf });
  return out;
}

export function hasMath(text: string): boolean {
  return splitMath(text).some((p) => p.math);
}

/** One line of text and formulas laid out from x = 0 at the given size. */
export function layoutLabel(
  text: string,
  size: number,
): { runs: LabelRun[]; width: number; asc: number; desc: number } {
  const runs: LabelRun[] = [];
  let x = 0;
  let asc = size * 0.78;
  let desc = size * 0.24;
  for (const part of splitMath(text)) {
    if (part.math) {
      const box = typeset(part.text, size);
      runs.push({ k: "math", x, box });
      x += box.w;
      asc = Math.max(asc, box.asc);
      desc = Math.max(desc, box.desc);
    } else {
      runs.push({ k: "text", x, text: part.text });
      x += textWidth(part.text, size);
    }
  }
  return { runs, width: x, asc, desc };
}

export function labelWidth(text: string, size: number): number {
  return layoutLabel(text, size).width;
}

/** Extra height a line needs beyond the normal line height for tall formulas. */
export function extraHeight(text: string, size: number): number {
  if (!text.includes("$")) return 0;
  const { asc, desc } = layoutLabel(text, size);
  return Math.max(0, Math.ceil(asc + desc - size * 1.12));
}

/** The label as plain Unicode text, for terminals and accessibility. */
export function plainLabel(text: string): string {
  return splitMath(text)
    .map((p) => (p.math ? texToText(p.text) : p.text))
    .join("");
}
