/**
 * A small TeX math typesetter in the handwriting font: fractions, roots,
 * scripts, big operators, accents, Greek letters and common symbols. It
 * produces positioned glyphs and strokes without a DOM, so the server can
 * measure formulas for layout and every renderer draws the same result.
 *
 * Coordinates: x grows right from 0, y is relative to the baseline and grows
 * downward (negative is above the baseline).
 */
import { charWidthEm } from "../layout/text.js";

export type MathItem =
  | { k: "glyph"; x: number; y: number; text: string; size: number }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; width: number }
  | { k: "path"; points: [number, number][]; width: number };

export type MathBox = { w: number; asc: number; desc: number; items: MathItem[] };

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

const SYMBOLS: Record<string, string> = {
  cdot: "·",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  propto: "∝",
  infty: "∞",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  iff: "⇔",
  mapsto: "↦",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  partial: "∂",
  nabla: "∇",
  degree: "°",
  circ: "∘",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  prime: "′",
  hbar: "ħ",
  ell: "ℓ",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  vert: "|",
  mid: "|",
  setminus: "∖",
  angle: "∠",
  perp: "⊥",
  parallel: "∥",
  checkmark: "✓",
  "{": "{",
  "}": "}",
  "%": "%",
  "&": "&",
  "#": "#",
  $: "$",
};

/** Big operators drawn larger, with limits above and below (∫ keeps them at the side). */
const BIG: Record<string, string> = {
  sum: "∑",
  prod: "∏",
  int: "∫",
  iint: "∬",
  oint: "∮",
  bigcup: "⋃",
  bigcap: "⋂",
  lim: "lim",
  max: "max",
  min: "min",
};

/** Named functions set as words: \sin x. */
const WORDS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "ln",
  "log",
  "exp",
  "det",
  "gcd",
  "deg",
  "dim",
  "ker",
  "arg",
  "sup",
  "inf",
  "Pr",
]);

const SPACES: Record<string, number> = {
  ",": 0.17,
  ":": 0.22,
  ";": 0.28,
  " ": 0.25,
  quad: 1,
  qquad: 2,
  "!": -0.17,
};

const RELATIONS = new Set([..."=<>≤≥≠≈≡∼∝→←⇒⇐⇔↦∈∉⊂⊆"]);
const BINARY = new Set([..."+−-×·÷±∓∪∩∧∨"]);

export function glyphWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += /[\x20-\x7e]/.test(ch) ? charWidthEm(ch) : 0.62;
  return em * size;
}

// ------------------------------------------------------------------ parser

type Tok = { t: "cmd"; v: string } | { t: "char"; v: string } | { t: "{" } | { t: "}" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const word = /^[A-Za-z]+/.exec(src.slice(i + 1));
      if (word) {
        out.push({ t: "cmd", v: word[0] });
        i += word[0].length;
      } else if (i + 1 < src.length) {
        out.push({ t: "cmd", v: src[i + 1]! });
        i++;
      }
    } else if (c === "{") out.push({ t: "{" });
    else if (c === "}") out.push({ t: "}" });
    else out.push({ t: "char", v: c });
  }
  return out;
}

class Typesetter {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  /** A run of atoms until a closing brace, \right or the end. */
  list(size: number, stop?: (t: Tok) => boolean): MathBox {
    const parts: { box: MathBox; kind: "ord" | "rel" | "bin" }[] = [];
    while (this.pos < this.toks.length) {
      const t = this.toks[this.pos]!;
      if (t.t === "}" || (stop && stop(t))) break;
      const atom = this.atom(size);
      if (!atom) continue;
      parts.push({ box: this.scripts(atom.box, size, atom.limits), kind: atom.kind });
    }
    const boxes: MathBox[] = [];
    parts.forEach((p, i) => {
      const gap = p.kind === "rel" ? 0.28 : p.kind === "bin" && i > 0 ? 0.2 : 0;
      if (gap && i > 0) boxes.push(space(gap * size));
      boxes.push(p.box);
      if (gap && i < parts.length - 1) boxes.push(space(gap * size));
    });
    return hbox(boxes);
  }

  private group(size: number): MathBox {
    const t = this.toks[this.pos];
    if (t?.t === "{") {
      this.pos++;
      const box = this.list(size);
      if (this.toks[this.pos]?.t === "}") this.pos++;
      return box;
    }
    return this.atom(size)?.box ?? empty();
  }

  /** The raw text of a {…} group, for \text. */
  private rawGroup(): string {
    if (this.toks[this.pos]?.t !== "{") return "";
    this.pos++;
    let depth = 1;
    let text = "";
    while (this.pos < this.toks.length) {
      const t = this.toks[this.pos++]!;
      if (t.t === "{") depth++;
      if (t.t === "}" && --depth === 0) break;
      text += t.t === "char" ? t.v : t.t === "cmd" ? (SYMBOLS[t.v] ?? GREEK[t.v] ?? "") : "";
    }
    return text;
  }

  private atom(
    size: number,
  ): { box: MathBox; kind: "ord" | "rel" | "bin"; limits?: boolean } | undefined {
    const t = this.toks[this.pos++]!;
    if (t.t === "{") {
      this.pos--;
      return { box: this.group(size), kind: "ord" };
    }
    if (t.t === "char") {
      if (t.v === " ") return undefined;
      if (t.v === "^" || t.v === "_") return { box: empty(), kind: "ord" };
      const ch = t.v === "-" ? "−" : t.v === "*" ? "·" : t.v === "'" ? "′" : t.v;
      const kind = RELATIONS.has(ch) ? "rel" : BINARY.has(ch) ? "bin" : "ord";
      return { box: glyph(ch, size), kind };
    }
    if (t.t !== "cmd") return undefined;
    const name = t.v;
    if (name in SPACES) return { box: space(SPACES[name]! * size), kind: "ord" };
    if (name in GREEK) return { box: glyph(GREEK[name]!, size), kind: "ord" };
    if (name in SYMBOLS) {
      const ch = SYMBOLS[name]!;
      return {
        box: glyph(ch, size),
        kind: RELATIONS.has(ch) ? "rel" : BINARY.has(ch) ? "bin" : "ord",
      };
    }
    if (WORDS.has(name)) return { box: hbox([glyph(name, size), space(0.12 * size)]), kind: "ord" };
    if (name in BIG) {
      const symbol = BIG[name]!;
      const word = symbol.length > 1;
      const box = word ? glyph(symbol, size) : glyph(symbol, size * (name === "int" ? 1.45 : 1.3));
      if (!word) centerOnAxis(box, size);
      return {
        box: hbox([box, space(0.1 * size)]),
        kind: "ord",
        limits: name !== "int" && name !== "iint" && name !== "oint",
      };
    }
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac": {
        const num = this.group(size * 0.82);
        const den = this.group(size * 0.82);
        return { box: fraction(num, den, size), kind: "ord" };
      }
      case "sqrt": {
        let index: MathBox | undefined;
        if (this.toks[this.pos]?.t === "char" && (this.toks[this.pos] as { v: string }).v === "[") {
          this.pos++;
          index = this.list(size * 0.55, (x) => x.t === "char" && x.v === "]");
          this.pos++;
        }
        return { box: root(this.group(size), size, index), kind: "ord" };
      }
      case "text":
      case "mathrm":
      case "textrm":
      case "operatorname":
      case "mathbf":
      case "textbf":
        return { box: glyph(this.rawGroup(), size), kind: "ord" };
      case "vec":
      case "overrightarrow":
        return { box: accent(this.group(size), size, "arrow"), kind: "ord" };
      case "bar":
      case "overline":
        return { box: accent(this.group(size), size, "bar"), kind: "ord" };
      case "hat":
      case "widehat":
        return { box: accent(this.group(size), size, "hat"), kind: "ord" };
      case "dot":
        return { box: accent(this.group(size), size, "dot"), kind: "ord" };
      case "left":
      case "right":
      case "big":
      case "Big":
      case "bigg": {
        const next = this.toks[this.pos];
        if (!next) return undefined;
        this.pos++;
        if (name === "left") {
          const open = delimiter(next);
          const inner = this.list(size, (x) => x.t === "cmd" && x.v === "right");
          let close = "";
          if (this.toks[this.pos]?.t === "cmd") {
            this.pos++;
            const c = this.toks[this.pos++];
            if (c) close = delimiter(c);
          }
          return { box: fence(open, inner, close, size), kind: "ord" };
        }
        return { box: glyph(delimiter(next), size * 1.3), kind: "ord" };
      }
      default:
        // Unknown commands show as their name rather than failing the drawing.
        return { box: glyph(name, size), kind: "ord" };
    }
  }

  /** Superscripts and subscripts after an atom. */
  private scripts(base: MathBox, size: number, limits = false): MathBox {
    let sup: MathBox | undefined;
    let sub: MathBox | undefined;
    for (;;) {
      const t = this.toks[this.pos];
      if (t?.t !== "char" || (t.v !== "^" && t.v !== "_")) break;
      this.pos++;
      const small = Math.max(size * 0.7, 9);
      const box = this.group(small);
      if (t.v === "^") sup = box;
      else sub = box;
    }
    if (!sup && !sub) return base;
    if (limits) return withLimits(base, sup, sub, size);
    const items = [...base.items];
    const x = base.w + 0.04 * size;
    let w = base.w;
    let asc = base.asc;
    let desc = base.desc;
    if (sup) {
      const dy = -Math.max(base.asc - sup.asc * 0.55, 0.42 * size);
      items.push(...move(sup.items, x, dy));
      w = Math.max(w, x + sup.w);
      asc = Math.max(asc, -dy + sup.asc);
    }
    if (sub) {
      const dy = Math.max(0.24 * size, base.desc + sub.asc * 0.35);
      items.push(...move(sub.items, x, dy));
      w = Math.max(w, x + sub.w);
      desc = Math.max(desc, dy + sub.desc);
    }
    return { w: w + 0.04 * size, asc, desc, items };
  }
}

// -------------------------------------------------------------- box algebra

function empty(): MathBox {
  return { w: 0, asc: 0, desc: 0, items: [] };
}

function space(w: number): MathBox {
  return { w, asc: 0, desc: 0, items: [] };
}

function glyph(text: string, size: number): MathBox {
  if (!text) return empty();
  return {
    w: glyphWidth(text, size),
    asc: size * 0.78,
    desc: size * 0.24,
    items: [{ k: "glyph", x: 0, y: 0, text, size }],
  };
}

function move(items: MathItem[], dx: number, dy: number): MathItem[] {
  return items.map((it) => {
    switch (it.k) {
      case "glyph":
        return { ...it, x: it.x + dx, y: it.y + dy };
      case "line":
        return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
      case "path":
        return { ...it, points: it.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    }
  });
}

function hbox(boxes: MathBox[]): MathBox {
  const items: MathItem[] = [];
  let x = 0;
  let asc = 0;
  let desc = 0;
  for (const b of boxes) {
    items.push(...move(b.items, x, 0));
    x += b.w;
    asc = Math.max(asc, b.asc);
    desc = Math.max(desc, b.desc);
  }
  return { w: x, asc, desc, items };
}

/** Puts a big glyph's middle on the math axis. */
function centerOnAxis(box: MathBox, size: number): void {
  const glyphSize = (box.items[0] as { size: number }).size;
  const shift = (glyphSize - size) * 0.32;
  box.items = move(box.items, 0, shift);
  box.asc = glyphSize * 0.78 - shift;
  box.desc = glyphSize * 0.24 + shift;
}

function fraction(num: MathBox, den: MathBox, size: number): MathBox {
  const pad = 0.12 * size;
  const w = Math.max(num.w, den.w) + pad * 2;
  const axis = -0.3 * size;
  const gap = 0.14 * size;
  const numY = axis - gap - num.desc;
  const denY = axis + gap + den.asc;
  return {
    w,
    asc: -numY + num.asc,
    desc: denY + den.desc,
    items: [
      ...move(num.items, (w - num.w) / 2, numY),
      {
        k: "line",
        x1: pad * 0.4,
        y1: axis,
        x2: w - pad * 0.4,
        y2: axis,
        width: Math.max(1.2, size / 14),
      },
      ...move(den.items, (w - den.w) / 2, denY),
    ],
  };
}

function root(body: MathBox, size: number, index?: MathBox): MathBox {
  const top = -(body.asc + 0.14 * size);
  const bottom = body.desc + 0.04 * size;
  const h = bottom - top;
  const lead = index ? Math.max(0, index.w - 0.22 * size) : 0;
  const sign = 0.52 * size;
  const end = lead + sign + body.w + 0.1 * size;
  const items: MathItem[] = [
    {
      k: "path",
      points: [
        [lead, bottom - h * 0.42],
        [lead + 0.13 * size, bottom - h * 0.5],
        [lead + 0.27 * size, bottom],
        [lead + sign - 0.04 * size, top],
        [end, top],
      ],
      width: Math.max(1.2, size / 14),
    },
    ...move(body.items, lead + sign, 0),
  ];
  if (index) items.push(...move(index.items, 0, bottom - h * 0.55 - index.desc));
  return { w: end + 0.06 * size, asc: -top + 0.06 * size, desc: bottom, items };
}

function accent(body: MathBox, size: number, kind: "arrow" | "bar" | "hat" | "dot"): MathBox {
  const y = -(body.asc + 0.1 * size);
  const items = [...body.items];
  const width = Math.max(1.1, size / 15);
  const x2 = Math.max(body.w, 0.5 * size);
  if (kind === "bar") items.push({ k: "line", x1: 0, y1: y, x2, y2: y, width });
  if (kind === "arrow") {
    items.push({ k: "line", x1: 0, y1: y, x2, y2: y, width });
    items.push({
      k: "path",
      points: [
        [x2 - 0.18 * size, y - 0.1 * size],
        [x2, y],
        [x2 - 0.18 * size, y + 0.1 * size],
      ],
      width,
    });
  }
  if (kind === "hat")
    items.push({
      k: "path",
      points: [
        [x2 / 2 - 0.2 * size, y + 0.06 * size],
        [x2 / 2, y - 0.1 * size],
        [x2 / 2 + 0.2 * size, y + 0.06 * size],
      ],
      width,
    });
  if (kind === "dot")
    items.push({ k: "glyph", x: x2 / 2 - 0.1 * size, y: y + 0.25 * size, text: "·", size });
  return { w: body.w, asc: body.asc + 0.26 * size, desc: body.desc, items };
}

function withLimits(
  base: MathBox,
  sup: MathBox | undefined,
  sub: MathBox | undefined,
  size: number,
): MathBox {
  const w = Math.max(base.w, sup?.w ?? 0, sub?.w ?? 0);
  const items = move(base.items, (w - base.w) / 2, 0);
  let asc = base.asc;
  let desc = base.desc;
  if (sup) {
    const y = -base.asc - 0.08 * size - sup.desc;
    items.push(...move(sup.items, (w - sup.w) / 2, y));
    asc = -y + sup.asc;
  }
  if (sub) {
    const y = base.desc + 0.08 * size + sub.asc;
    items.push(...move(sub.items, (w - sub.w) / 2, y));
    desc = y + sub.desc;
  }
  return { w, asc, desc, items };
}

function delimiter(t: Tok): string {
  if (t.t === "char") return t.v === "." ? "" : t.v;
  if (t.t === "cmd") return SYMBOLS[t.v] ?? (t.v === "{" ? "{" : t.v === "}" ? "}" : "");
  return "";
}

/** \left( … \right): delimiters scaled to the content. */
function fence(open: string, inner: MathBox, close: string, size: number): MathBox {
  const h = inner.asc + inner.desc;
  const dsize = Math.max(size, h * 0.95);
  const boxes: MathBox[] = [];
  const delim = (ch: string) => {
    const g = glyph(ch, dsize);
    const center = (inner.desc - inner.asc) / 2;
    const shift = center - (dsize * 0.24 - dsize * 0.78) / 2;
    g.items = move(g.items, 0, shift);
    g.asc = dsize * 0.78 - shift;
    g.desc = dsize * 0.24 + shift;
    return g;
  };
  if (open) boxes.push(delim(open));
  boxes.push(inner);
  if (close) boxes.push(delim(close));
  return hbox(boxes);
}

/** Lays out a TeX math expression at the given font size. */
export function typeset(tex: string, size: number): MathBox {
  try {
    const t = new Typesetter(tokenize(tex));
    const box = t.list(size);
    return box.items.length ? box : glyph(tex, size);
  } catch {
    return glyph(tex, size);
  }
}

// --------------------------------------------------------------- plain text

const SUP: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
  x: "ˣ",
  T: "ᵀ",
};
const SUB: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  i: "ᵢ",
  j: "ⱼ",
  n: "ₙ",
  k: "ₖ",
  x: "ₓ",
  a: "ₐ",
  e: "ₑ",
  o: "ₒ",
  t: "ₜ",
};

/** A one-line Unicode rendering for terminals and plain text: \frac{a}{b} → a/b, x^2 → x². */
export function texToText(tex: string): string {
  let pos = 0;
  const toks = tokenize(tex);
  const groupText = (): string => {
    const t = toks[pos];
    if (t?.t === "{") {
      pos++;
      const s = listText(true);
      pos++;
      return s;
    }
    pos++;
    return t ? tokText(t) : "";
  };
  const wrap = (s: string) => (/^[\p{L}\p{N}.]+$/u.test(s) || s.length <= 1 ? s : `(${s})`);
  const script = (s: string, map: Record<string, string>, mark: string) =>
    [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : `${mark}${wrap(s)}`;
  const tokText = (t: Tok): string => {
    if (t.t === "char") return t.v === "*" ? "·" : t.v;
    if (t.t !== "cmd") return "";
    const n = t.v;
    if (n === "frac" || n === "dfrac" || n === "tfrac") {
      const a = groupText();
      const b = groupText();
      return `${wrap(a)}/${wrap(b)}`;
    }
    if (n === "sqrt") return `√${wrap(groupText())}`;
    if (["text", "mathrm", "textrm", "operatorname", "mathbf", "textbf"].includes(n))
      return groupText();
    if (["vec", "overrightarrow"].includes(n)) return `${groupText()}⃗`;
    if (["bar", "overline", "hat", "dot"].includes(n)) return groupText();
    if (n === "left" || n === "right") {
      const d = toks[pos++];
      return d ? delimiter(d) : "";
    }
    if (n in SPACES) return " ";
    return GREEK[n] ?? SYMBOLS[n] ?? BIG[n] ?? n;
  };
  const listText = (inGroup = false): string => {
    let out = "";
    while (pos < toks.length) {
      const t = toks[pos]!;
      if (t.t === "}" && inGroup) break;
      pos++;
      if (t.t === "char" && (t.v === "^" || t.v === "_")) {
        const s = groupText();
        out += t.v === "^" ? script(s, SUP, "^") : script(s, SUB, "_");
      } else if (t.t === "{") {
        out += listText(true);
        pos++;
      } else out += tokText(t);
    }
    return out;
  };
  try {
    return listText().replace(/\s+/g, " ").trim();
  } catch {
    return tex;
  }
}
