// The source side of the checking layer: rules by line before upstream's parser, and the repair loop around it.
// Everything works on plain strings. Line lengths are bounded before any pattern runs on them.
import { parseCompact, type CompactScene } from "@sketchy/src/scene/compact.js";
import type { Sink } from "./check";

/** One line of the source being checked. `src` is its 1-based number in the source as given. */
export type WorkLine = { text: string; src: number };

/** A line longer than this is not a statement; no pattern below sees more than this many characters. */
const MAX_LINE = 2000;

// ---------------------------------------------------------------------------------------------- Mermaid

/**
 * The header list the app already has: `START_RE` in renderer/shared/markdown-mermaid-text.js, copied here
 * because the bundle cannot load a renderer script. tests/sketch-check.test.js compares the two.
 */
const MERMAID_START =
  /^\s*(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|(?:sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart|block-beta|sankey|packet)\b)/i;

/** Two Mermaid words are also Sketchy figure headers: `timeline t: Plan` has an id, Mermaid's header is the bare word. */
const ALSO_SKETCHY_FIGURE = new Set(["timeline", "mindmap"]);

export function isMermaidHeader(firstLine: string): boolean {
  const head = firstLine.trim().slice(0, MAX_LINE);
  if (!MERMAID_START.test(head)) return false;
  const words = head.split(/\s+/);
  return !(words.length > 1 && ALSO_SKETCHY_FIGURE.has(words[0]!.toLowerCase()));
}

// ---------------------------------------------------------------------------------------------- before parsing

const LEFT_OUT_HEADS = new Set(["part", "wire", "image"]);
/** Heads whose text is free: brackets there are text, not copied grammar notation. */
const NO_UNWRAP_HEADS = new Set(["title", "subtitle", "step", "label", "dir"]);

const ID_CHARS = "[A-Za-z0-9_-]+";
// Square brackets copied from the grammar's notation, taken off only when what is inside cannot be anything else.
const BRACKETED_MODIFIER =
  /(\s)\[(!accent|!muted|@[\w-]+|\((?:box|rounded|circle|cylinder|note|person|text)\)|in\s+[A-Za-z][\w-]*|~\s[^\]]*)\]/g;
const BRACKETED_ARROW_LABEL = new RegExp(`^(\\s*${ID_CHARS}\\s*(?:<->|-->|->)\\s*${ID_CHARS}\\s+)\\[([^\\[\\]]+)\\]\\s*$`);
const ARROW = /\s*(?:<->|-->|->)\s*/g;

function firstWord(line: string): string {
  const space = line.search(/\s/);
  return space < 0 ? line : line.slice(0, space);
}

// A step may name a run of a figure's parts, `a[1..3]`, and the parser writes the run out one part at a time
// with no limit of its own. No figure has more parts than this, so a wider run is not a statement.
const STEP_RUN = /\[(-?\d+)\.\.(-?\d+)\]/g;
const MAX_STEP_RUN = 200;

function hasWideRun(line: string): boolean {
  for (const run of line.matchAll(STEP_RUN)) {
    if (!(Math.abs(Number(run[2]) - Number(run[1])) <= MAX_STEP_RUN)) return true;
  }
  return false;
}

/**
 * Rules by line, before the parser. One work line comes out for each source line kept; a removed line is
 * reported and not passed on. Blank lines stay: they end a figure's body.
 */
export function rewriteLines(raw: string[], sink: Sink): WorkLine[] {
  const work: WorkLine[] = [];
  raw.forEach((original, index) => {
    const src = index + 1;
    const line = original.trim();
    if (line === "") {
      work.push({ text: "", src });
      return;
    }
    const head = firstWord(line);
    if (line.length > MAX_LINE || LEFT_OUT_HEADS.has(head) || (head === "step" && hasWideRun(line))) {
      sink.add("removed_line", src, { text: line });
      sink.dropped++;
      return;
    }
    let text = line;
    if (head === "step") {
      // Inside a step the ids are split on spaces, so `a -> b` would be three ids; the arrow's id is `a->b`.
      const bar = text.indexOf("|");
      if (bar >= 0) text = text.slice(0, bar + 1) + text.slice(bar + 1).replace(ARROW, "->");
    } else if (!NO_UNWRAP_HEADS.has(head)) {
      text = text.replace(BRACKETED_MODIFIER, "$1$2").replace(BRACKETED_ARROW_LABEL, "$1$2");
    }
    work.push({ text: text.trim(), src });
  });
  return work;
}

// ---------------------------------------------------------------------------------------------- while parsing

// Upstream's own messages, from vendor/sketchy/src/scene/compact.ts. A parser failure ends with its reason.
const NEEDS_LABEL = "a node needs a label";
const EXPECTED_GROUP = "expected: group <id> <label> [in <parent>]";
const EXPECTED_DIR = 'dir must be "right" or "down"';
const EXPECTED_NODE = "expected a node: <id> <label> [@icon] [(shape)] [in <group>] [!accent|!muted] [~ description]";

/** Mermaid's direction words, which a model writes from habit. Sketchy has no right-to-left or upward. */
const DIR_WORDS: Record<string, string> = { lr: "right", td: "down", tb: "down" };

const MERMAID_NODE = /^([A-Za-z0-9_-]+)[[{(]+\s*"?([^[\]{}()"]+?)"?\s*[\]})]+$/;

/**
 * A line the parser refused, rewritten in the cases where what the model meant is not in doubt. Not
 * reported: none of them changes what is drawn. Returns undefined for every other failure.
 */
function repairLine(text: string, message: string): string | undefined {
  if (message.endsWith(NEEDS_LABEL)) {
    // `paid (circle)`: the node takes its id as its label.
    const id = firstWord(text);
    return /^[A-Za-z0-9_-]+$/.test(id) ? `${id} ${id}${text.slice(id.length)}` : undefined;
  }
  if (message.endsWith(EXPECTED_GROUP)) {
    const m = /^group\s+([A-Za-z0-9_-]+)$/.exec(text);
    return m ? `group ${m[1]} ${m[1]}` : undefined;
  }
  if (message.endsWith(EXPECTED_DIR)) {
    const m = /^dir\s+(right|down|lr|td|tb)\b/i.exec(text);
    const word = m ? m[1]!.toLowerCase() : undefined;
    return word ? `dir ${DIR_WORDS[word] ?? word}` : undefined;
  }
  if (message.endsWith(EXPECTED_NODE)) {
    // Mermaid's node shapes inside a sketch block: `start[Bug report]`, `ok{Is it critical?}`.
    const m = MERMAID_NODE.exec(text);
    return m ? `${m[1]} ${m[2]!.trim()}` : undefined;
  }
  return undefined;
}

const TEMPLATE_HEADS = ["timeline", "cycle", "pyramid", "funnel", "venn", "matrix", "mindmap"];
/** The lines that start a figure (compact.ts `figureHeader`). */
const FIGURE_HEADS = new Set(["plot", "seq", "chart", "array", "list", "stack", "queue", "tree", "draw", "molecule", "map", ...TEMPLATE_HEADS]);
/** Figures written on one line; only pointer lines follow them. */
const ONE_LINE_FIGURES = new Set(["array", "list", "stack", "queue", "tree"]);
const EDGE_LINE = new RegExp(`^${ID_CHARS}\\s*(?:<->|-->|->)\\s*${ID_CHARS}(?:\\s|$)`);

/** A line that can only be a scene line, so it ends the body of a figure whose header failed. */
function endsFigureBody(text: string, head: string): boolean {
  return (
    /^(title|subtitle|dir|group)\s/.test(text)
    || /^label\s+\S+\s/.test(text)
    || (/^step\s/.test(text) && text.includes("|"))
    || (head !== "seq" && EDGE_LINE.test(text))
  );
}

/** The index after the last line of the body that goes with the figure header at `at`. */
function figureEnd(work: WorkLine[], at: number, head: string): number {
  if (head === "molecule") return at + 1;
  let end = at + 1;
  for (; end < work.length; end++) {
    const text = work[end]!.text;
    if (text === "" || text === "end") break;
    if (ONE_LINE_FIGURES.has(head) && !/^(ptr|pointer)\s/.test(text)) break;
    if (endsFigureBody(text, head)) break;
  }
  return end;
}

function tryParse(work: WorkLine[], upTo: number = work.length): { scene?: CompactScene; message?: string } {
  try {
    return { scene: parseCompact(work.slice(0, upTo).map((line) => line.text).join("\n")) };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The line a parse failure belongs to: upstream names it ("Line N"); a failure that does not is found by
 * halving, because parsing is sequential and a prefix that fails fails on its last line.
 */
function failingIndex(message: string, work: WorkLine[]): number {
  const named = /^Line (\d+) /.exec(message);
  if (named) {
    const index = Number(named[1]) - 1;
    if (index >= 0 && index < work.length) return index;
  }
  let low = 1;
  let high = work.length;
  if (tryParse(work).scene) return -1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tryParse(work, middle).scene) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * Upstream's parse, repeated until it succeeds: a failing line is rewritten once when a rule above covers it,
 * otherwise removed and reported (with its body, when it is a figure header). Edits `work` in place.
 */
export function parseRepairing(work: WorkLine[], sink: Sink): { scene?: CompactScene; message?: string } {
  const repaired = new Set<WorkLine>();
  for (let attempt = 0, limit = work.length * 2 + 8; attempt < limit; attempt++) {
    const parsed = tryParse(work);
    if (parsed.scene) return { scene: parsed.scene };
    const message = parsed.message ?? "";
    const at = failingIndex(message, work);
    if (at < 0) return { message };
    const entry = work[at]!;
    if (!repaired.has(entry)) {
      const fixed = repairLine(entry.text, message);
      if (fixed !== undefined) {
        repaired.add(entry);
        entry.text = fixed;
        continue;
      }
    }
    const head = firstWord(entry.text);
    if (FIGURE_HEADS.has(head)) {
      const end = figureEnd(work, at, head);
      sink.add("figure_dropped", entry.src, { text: entry.text });
      sink.dropped += end - at;
      work.splice(at, end - at);
    } else {
      sink.add("removed_line", entry.src, { text: entry.text });
      sink.dropped++;
      work.splice(at, 1);
    }
  }
  return { message: "Could not repair the source." };
}

// ---------------------------------------------------------------------------------------------- where an element came from

export type ElementKind = "groups" | "nodes" | "edges" | "labels" | "steps" | "figures";
export type Locate = (kind: ElementKind, index: number) => number | undefined;

const KINDS: ElementKind[] = ["groups", "nodes", "edges", "labels", "steps", "figures"];

/**
 * Finds, for an element of the parsed scene (the n-th group, node, arrow...), the index in `work` of the line
 * that produced it. Parsing is sequential and append-only, so the first prefix of the source whose scene holds
 * that element ends with its line: found by halving, with every prefix parse remembered, so a few lookups cost
 * a few parses and many lookups cost at most one parse per line.
 */
export function locator(work: WorkLine[]): Locate {
  const texts = work.map((line) => line.text);
  const counts = new Map<number, Record<ElementKind, number> | null>();
  const countsAt = (length: number): Record<ElementKind, number> | null => {
    let found = counts.get(length);
    if (found === undefined) {
      try {
        const scene = parseCompact(texts.slice(0, length).join("\n"));
        found = { groups: 0, nodes: 0, edges: 0, labels: 0, steps: 0, figures: 0 };
        for (const kind of KINDS) found[kind] = scene[kind].length;
      } catch {
        found = null; // cannot happen for a source that parsed whole, but a lookup must never throw
      }
      counts.set(length, found);
    }
    return found;
  };
  return (kind, index) => {
    const all = countsAt(texts.length);
    if (!all || all[kind] <= index) return undefined;
    let low = 1;
    let high = texts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const here = countsAt(middle);
      if (!here) return undefined;
      if (here[kind] > index) high = middle;
      else low = middle + 1;
    }
    return low - 1;
  };
}
