/**
 * A small, safe math expression compiler for plots: numbers, variables,
 * + - * / ^, implicit multiplication ("2x", "3sin(x)", "2pi"), comparison-free
 * functions and the constants pi, e and tau. No eval; unknown names fail.
 */

export type Env = Record<string, number>;
export type Compiled = { (env: Env): number; names: Set<string>; source: string };

export class ExprError extends Error {}

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  mod: (a, b) => ((a % b) + b) % b,
  /** 1 for x ≥ 0, else 0: lets piecewise functions be written as sums. */
  step: (x) => (x >= 0 ? 1 : 0),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** Names expressions already use for a function or constant. */
export const isReservedName = (name: string): boolean => name in FUNCTIONS || name in CONSTANTS;

type Token =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "("; v: "(" }
  | { t: ")"; v: ")" }
  | { t: ","; v: "," };

function tokenize(src: string, known: Set<string>): Token[] {
  const tokens: Token[] = [];
  const s = src.replace(/π/g, "pi").replace(/·|×/g, "*").replace(/−/g, "-").replace(/²/g, "^2");
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) {
      tokens.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i));
    if (name) {
      tokens.push(...splitName(name[0], known));
      i += name[0].length;
      continue;
    }
    if ("+-*/^".includes(c)) tokens.push({ t: "op", v: c });
    else if (c === "(" || c === "[") tokens.push({ t: "(", v: "(" });
    else if (c === ")" || c === "]") tokens.push({ t: ")", v: ")" });
    else if (c === ",") tokens.push({ t: ",", v: "," });
    else throw new ExprError(`Unexpected "${c}" in "${src}".`);
    i++;
  }
  return tokens;
}

/** "pix" → pi·x, "xsin" → x·sin: splits run-together names greedily from the left. */
function splitName(word: string, names: Set<string>): Token[] {
  if (
    word in FUNCTIONS ||
    word in CONSTANTS ||
    names.has(word) ||
    word.length === 1 ||
    /\d/.test(word)
  ) {
    return [{ t: "name", v: word }];
  }
  const out: Token[] = [];
  let rest = word;
  while (rest) {
    const known = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), ...names]
      .filter((k) => rest.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (known) {
      out.push({ t: "name", v: known });
      rest = rest.slice(known.length);
    } else {
      out.push({ t: "name", v: rest[0]! });
      rest = rest.slice(1);
    }
  }
  return out;
}

type Node =
  | { k: "num"; v: number }
  | { k: "var"; v: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; f: string; args: Node[] };

/** Recursive descent: sum → product → unary → power → atom (implicit products included). */
function parse(tokens: Token[], src: string): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = (why: string): never => {
    throw new ExprError(`${why} in "${src}".`);
  };
  const sum = (): Node => {
    let a = product();
    while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = String(tokens[pos++]!.v);
      a = { k: "bin", op, a, b: product() };
    }
    return a;
  };
  const startsAtom = (t: Token | undefined) => t?.t === "num" || t?.t === "name" || t?.t === "(";
  const product = (): Node => {
    let a = unary();
    for (;;) {
      const t = peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        pos++;
        a = { k: "bin", op: t.v, a, b: unary() };
      } else if (startsAtom(t)) {
        a = { k: "bin", op: "*", a, b: power() };
      } else return a;
    }
  };
  const unary = (): Node => {
    const t = peek();
    if (t?.t === "op" && (t.v === "-" || t.v === "+")) {
      pos++;
      const a = unary();
      return t.v === "-" ? { k: "neg", a } : a;
    }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (peek()?.t === "op" && peek()!.v === "^") {
      pos++;
      return { k: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  };
  const atom = (): Node => {
    const t = tokens[pos++];
    if (!t) return fail("Unexpected end");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "(") {
      const inner = sum();
      if (tokens[pos++]?.t !== ")") fail("Missing )");
      return inner;
    }
    if (t.t === "name") {
      if (t.v in FUNCTIONS) {
        if (peek()?.t !== "(") {
          // "sin x" → sin(x): a function applied to the next power term.
          return { k: "call", f: t.v, args: [power()] };
        }
        pos++;
        const args: Node[] = [];
        if (peek()?.t !== ")") {
          args.push(sum());
          while (peek()?.t === ",") {
            pos++;
            args.push(sum());
          }
        }
        if (tokens[pos++]?.t !== ")") fail("Missing )");
        return { k: "call", f: t.v, args };
      }
      if (t.v in CONSTANTS) return { k: "num", v: CONSTANTS[t.v]! };
      return { k: "var", v: t.v };
    }
    return fail(`Unexpected "${t.v}"`);
  };
  const tree = sum();
  if (pos < tokens.length) fail(`Unexpected "${tokens[pos]!.v}"`);
  return tree;
}

function build(node: Node, names: Set<string>): (env: Env) => number {
  switch (node.k) {
    case "num":
      return () => node.v;
    case "var": {
      names.add(node.v);
      const name = node.v;
      return (env) => env[name] ?? NaN;
    }
    case "neg": {
      const a = build(node.a, names);
      return (env) => -a(env);
    }
    case "bin": {
      const a = build(node.a, names);
      const b = build(node.b, names);
      switch (node.op) {
        case "+":
          return (env) => a(env) + b(env);
        case "-":
          return (env) => a(env) - b(env);
        case "*":
          return (env) => a(env) * b(env);
        case "/":
          return (env) => a(env) / b(env);
        default:
          return (env) => Math.pow(a(env), b(env));
      }
    }
    case "call": {
      const f = FUNCTIONS[node.f]!;
      const args = node.args.map((n) => build(n, names));
      return (env) => f(...args.map((g) => g(env)));
    }
  }
}

/** Compiles an expression; `allowed` lists the variable names it may use. */
export function compile(source: string, allowed?: Iterable<string>): Compiled {
  const cleaned = source
    .trim()
    .replace(/^(y|f\s*\(\s*x\s*\)|[a-z]\s*\(\s*x\s*\))\s*=\s*/i, "")
    .trim();
  if (!cleaned) throw new ExprError("Empty expression.");
  const names = new Set<string>();
  const fn = build(parse(tokenize(cleaned, new Set(allowed ?? [])), source), names);
  if (allowed) {
    const ok = new Set(allowed);
    const unknown = [...names].filter((n) => !ok.has(n));
    if (unknown.length) {
      throw new ExprError(
        `Unknown name${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")} in "${source}". Use x, slider names, pi, e and functions like sin, sqrt, ln.`,
      );
    }
  }
  const compiled = fn as Compiled;
  compiled.names = names;
  compiled.source = cleaned;
  return compiled;
}

/** A constant expression such as "2pi" or "-3/4". */
export function evaluate(source: string, env: Env = {}): number {
  const value = compile(source, Object.keys(env))(env);
  if (!Number.isFinite(value)) throw new ExprError(`"${source}" is not a finite number.`);
  return value;
}

/** Splits at commas outside parentheses: "max(a,b), 2" → ["max(a,b)", "2"]. */
export function splitTop(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}
