// Jenny's checking layer for sketch blocks (plan section 5.4 of docs/plans/PROJECT_BOARD_2026-11-13.md).
//
// Upstream's parser turns any line it does not recognise into a node, and its builder throws on one bad
// reference and fails the whole drawing. Small local models make small, repeated mistakes, so Jenny checks and
// repairs on both sides of the parser, on plain data only (the source lines, then the parsed input object), and
// reports what it did. Nothing here calls a model, touches the DOM or edits a vendored file.
//
//   prepare(source)  bounds -> by-line rules -> upstream parse (with while-parsing rewrites) -> rules on the
//                    parsed object -> node bound -> quarter rule.
//
// `kind: 'scene'` means the input is safe to hand to buildScene for every mistake 5.4 lists; anything else the
// builder still refuses reaches the caller as a thrown SceneError and is reported there as reason 'error'.
import type { SketchInput } from "@sketchy/src/scene/fill.js";
import { checkScene } from "./check-scene";
import { isMermaidHeader, parseRepairing, rewriteLines } from "./check-source";

export type Problem = {
  code: "removed_line" | "missing_id" | "repointed_id" | "duplicate_id" | "figure_dropped" | "prose_node";
  /** 1-based line in the source as given, when known. */
  line: number | null;
  /** The id the problem is about. */
  id?: string;
  /** repointed_id: the declared id it now points at. */
  to?: string;
  /** The offending line or label, cut to 200 characters. */
  text?: string;
};

export type RefusedReason = "empty" | "too_long" | "too_many_lines" | "too_many_nodes" | "too_many_problems" | "error";
export type Counts = { elements: number; dropped: number; flagged: number; nodes: number };

export type Prepared =
  | { kind: "mermaid"; source: string }
  | { kind: "refused"; reason: RefusedReason; problems: Problem[]; message?: string }
  | { kind: "scene"; input: SketchInput; problems: Problem[]; counts: Counts };

/** Plan 5.2: the chat checks these before sending and the frame again. `nodes` counts parts of figures. */
export const SKETCH_BOUNDS = { chars: 16384, lines: 400, nodes: 120 } as const;

/** More problems than this are counted but not listed: the list is shown to a person and sent to a model. */
const MAX_PROBLEMS = 200;
const TEXT_MAX = 200;

/** What the two passes write to: the problem list plus the tallies the quarter rule needs. */
export type Sink = {
  problems: Problem[];
  /** Elements (lines, arrows, labels, figures...) removed from the drawing. */
  dropped: number;
  /** Nodes kept but flagged as prose. */
  flagged: number;
  add(code: Problem["code"], line: number | null, extra?: { id?: string; to?: string; text?: string }): void;
};

function createSink(): Sink {
  const sink: Sink = {
    problems: [],
    dropped: 0,
    flagged: 0,
    add(code, line, extra = {}) {
      if (sink.problems.length >= MAX_PROBLEMS) return;
      const problem: Problem = { code, line };
      if (extra.id !== undefined) problem.id = extra.id;
      if (extra.to !== undefined) problem.to = extra.to;
      if (extra.text !== undefined) problem.text = extra.text.length > TEXT_MAX ? extra.text.slice(0, TEXT_MAX) : extra.text;
      sink.problems.push(problem);
    },
  };
  return sink;
}

function refused(reason: RefusedReason, problems: Problem[] = [], message?: string): Prepared {
  return message === undefined ? { kind: "refused", reason, problems } : { kind: "refused", reason, problems, message };
}

/** Problems read best in source order; the ones with no known line go last. */
function inSourceOrder(problems: Problem[]): Problem[] {
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort((a, b) => (a.problem.line ?? Infinity) - (b.problem.line ?? Infinity) || a.index - b.index)
    .map((entry) => entry.problem);
}

function run(input: unknown): Prepared {
  const source = typeof input === "string" ? input : String(input ?? "");
  // The first bound is checked before the text is read at all: a 5 MB string costs one comparison.
  if (source.length > SKETCH_BOUNDS.chars) return refused("too_long");
  const raw = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let end = raw.length;
  while (end > 0 && raw[end - 1]!.trim() === "") end--;
  if (end === 0) return refused("empty");
  if (end > SKETCH_BOUNDS.lines) return refused("too_many_lines");
  const first = raw.find((line) => line.trim() !== "")!;
  if (isMermaidHeader(first)) return { kind: "mermaid", source };

  const sink = createSink();
  const work = rewriteLines(raw.slice(0, end), sink);
  const parsed = parseRepairing(work, sink);
  if (!parsed.scene) return refused("error", inSourceOrder(sink.problems), parsed.message);

  const checked = checkScene(parsed.scene, work, sink);
  const problems = inSourceOrder(sink.problems);
  if (checked.nodes > SKETCH_BOUNDS.nodes) return refused("too_many_nodes", problems);

  const elements = checked.kept + sink.dropped;
  const counts: Counts = { elements, dropped: sink.dropped, flagged: sink.flagged, nodes: checked.nodes };
  // A wrong drawing shown with confidence is worse than none: more than a quarter wrong shows the source instead.
  if (elements > 0 && (sink.dropped + sink.flagged) * 4 > elements) return refused("too_many_problems", problems);
  if (checked.drawable === 0) return refused("empty", problems);
  return { kind: "scene", input: checked.input, problems, counts };
}

/** Never throws: any failure inside the layer is a `refused` result with reason 'error'. */
export function prepare(source: string): Prepared {
  try {
    return run(source);
  } catch (error) {
    return refused("error", [], error instanceof Error ? error.message : String(error));
  }
}
