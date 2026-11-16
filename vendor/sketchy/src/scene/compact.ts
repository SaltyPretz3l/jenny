import { SceneError } from "./builder.js";
import { parseTree, parseValues } from "../figures/data.js";
import { emptyDraw, parseDrawLine } from "../figures/draw.js";
import { emptyMap, MAP_REGIONS, parseMapLine, regionBox } from "../figures/map.js";
import { parseSmiles, SmilesError } from "../figures/molecule.js";
import { emptyTemplate, parseTemplateLine, TEMPLATE_KINDS } from "../figures/templates.js";
import { splitTop } from "../figures/expr.js";
import type {
  ChartSpec,
  ChartType,
  DataKind,
  PlotSpec,
  SceneFigure,
  SeqSpec,
  TemplateKind,
} from "../figures/types.js";

/**
 * A compact line syntax for whole scenes, about half the tokens of the JSON
 * form. It parses into the same input the `sketch` tool takes.
 *
 *   title How DNS works
 *   dir right
 *   group net The internet
 *   browser Browser @globe
 *   dns DNS @book-open in net !accent ~ The phone book of the internet
 *   db Database (cylinder) in net
 *   browser -> dns lookup
 *   dns --> db            (dashed; <-> for both ends)
 *   label db Postgres
 *   step Find the address: DNS turns the name into an IP | browser dns browser->dns
 */
export type CompactScene = {
  title?: string;
  subtitle?: string;
  direction?: "right" | "down";
  groups: { id: string; label: string; parent?: string }[];
  nodes: {
    id: string;
    label: string;
    icon?: string;
    group?: string;
    shape?: "box" | "rounded" | "circle" | "cylinder" | "note" | "person" | "text";
    tone?: "accent" | "muted";
    description?: string;
    file?: string;
  }[];
  edges: {
    from: string;
    to: string;
    label?: string;
    style?: "dashed";
    bidirectional?: boolean;
    tone?: "accent" | "muted";
  }[];
  labels: { target: string; anchor?: string; text: string }[];
  steps: { title: string; text?: string; highlight: string[]; set?: Record<string, string> }[];
  figures: SceneFigure[];
  parts: { id: string; type: string; label?: string; props?: Record<string, string> }[];
  wires: { from: string; to: string; color?: WireColor; label?: string }[];
  /** Photo ids from find_image. */
  images: string[];
};

type WireColor =
  "red" | "black" | "blue" | "green" | "yellow" | "orange" | "purple" | "gray" | "white";

const SHAPES = new Set(["box", "rounded", "circle", "cylinder", "note", "person", "text"]);
const COLORS = new Set([
  "red",
  "black",
  "blue",
  "green",
  "yellow",
  "orange",
  "purple",
  "gray",
  "white",
]);
const ID = "[A-Za-z0-9_-]+";
const EDGE = new RegExp(`^(${ID})\\s*(<->|-->|->)\\s*(${ID})(?:\\s+(.*))?$`);
const WIRE = new RegExp(
  `^wire\\s+(${ID}\\.\\S+)\\s*->\\s*(${ID}\\.\\S+)(?:\\s+(\\w+))?(?:\\s+(.*))?$`,
);

export function parseCompact(source: string): CompactScene {
  const scene: CompactScene = {
    groups: [],
    nodes: [],
    edges: [],
    labels: [],
    steps: [],
    parts: [],
    wires: [],
    images: [],
    figures: [],
  };
  // The figure whose lines follow (plot, chart, seq, array…), until a blank
  // line, "end" or a line that does not belong to it.
  let block: SceneFigure | undefined;
  source.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line) {
      // Models space out their drawings; only a line that is no shape ends those.
      if (block?.spec.kind !== "draw") block = undefined;
      return;
    }
    const fail = (why: string): never => {
      throw new SceneError(`Line ${index + 1} ("${line}"): ${why}`);
    };
    if (block) {
      if (line === "end") {
        block = undefined;
        return;
      }
      if (figureLine(block, line, scene, fail)) return;
      block = undefined;
    }
    // Block closers some models add out of habit carry no meaning here.
    if (line.startsWith("#") || /^(end|\}|\{)$/.test(line)) return;
    const figure = figureHeader(line, fail);
    if (figure) {
      scene.figures.push(figure);
      block = figure;
      return;
    }
    const [head, ...rest] = line.split(/\s+/);
    const tail = rest.join(" ");
    switch (head) {
      case "title":
        scene.title = tail;
        return;
      case "subtitle":
        scene.subtitle = tail;
        return;
      case "dir":
        if (tail !== "right" && tail !== "down") fail('dir must be "right" or "down"');
        scene.direction = tail as "right" | "down";
        return;
      case "group": {
        const m = tail.match(new RegExp(`^(${ID})\\s+(.+?)(?:\\s+in\\s+(${ID}))?$`));
        if (!m) fail("expected: group <id> <label> [in <parent>]");
        scene.groups.push(strip({ id: m![1]!, label: m![2]!, parent: m![3] }));
        return;
      }
      case "image": {
        const m = tail.match(new RegExp(`^(${ID})$`));
        if (!m) fail("expected: image <id from find_image>");
        scene.images.push(m![1]!);
        return;
      }
      case "label": {
        // Photo regions may contain spaces: label <image>.<region>: <text>
        const region = tail.match(new RegExp(`^(${ID})\\.([^:]+):\\s+(.+)$`));
        if (region) {
          scene.labels.push({ target: region[1]!, anchor: region[2]!.trim(), text: region[3]! });
          return;
        }
        const m = tail.match(new RegExp(`^(${ID})(?:\\.(\\S+))?\\s+(.+)$`));
        if (!m) fail("expected: label <target>[.anchor] <text>");
        scene.labels.push(strip({ target: m![1]!, anchor: m![2], text: m![3]! }));
        return;
      }
      case "step": {
        const m = tail.match(/^([^:|]+?)(?::\s*([^|]*))?\|\s*(.+)$/);
        if (!m) fail("expected: step <title>: <text> | <ids>");
        const { highlight, set } = stepTargets(m![3]!);
        scene.steps.push(
          strip({
            title: m![1]!.trim(),
            text: m![2]?.trim() || undefined,
            highlight,
            set: Object.keys(set).length ? set : undefined,
          }),
        );
        return;
      }
      case "part": {
        const m = tail.match(new RegExp(`^(${ID})\\s+(${ID})(.*)$`));
        if (!m) fail("expected: part <id> <type> [key=value …] [label]");
        const props: Record<string, string> = {};
        const words: string[] = [];
        for (const w of m![3]!.trim().split(/\s+/).filter(Boolean)) {
          const kv = w.match(/^(\w+)=(\S+)$/);
          if (kv) props[kv[1]!] = kv[2]!;
          else words.push(w);
        }
        scene.parts.push(
          strip({
            id: m![1]!,
            type: m![2]!,
            label: words.join(" ") || undefined,
            props: Object.keys(props).length ? props : undefined,
          }),
        );
        return;
      }
    }
    const wire = line.match(WIRE);
    if (wire) {
      const color = wire[3] && COLORS.has(wire[3]) ? (wire[3] as WireColor) : undefined;
      const label = [color ? undefined : wire[3], wire[4]].filter(Boolean).join(" ") || undefined;
      scene.wires.push(strip({ from: wire[1]!, to: wire[2]!, color, label }));
      return;
    }
    const edge = line.match(EDGE);
    if (edge) {
      // Edges have no hover text; drop a "~ …" note rather than print it on the arrow.
      let label = splitOnce(edge[4] ?? "", " ~ ")[0].trim();
      let tone: "accent" | "muted" | undefined;
      const toneMatch = label?.match(/(?:^|\s)!(accent|muted)$/);
      if (toneMatch) {
        tone = toneMatch[1] as "accent" | "muted";
        label = label!.slice(0, toneMatch.index).trim();
      }
      scene.edges.push(
        strip({
          from: edge[1]!,
          to: edge[3]!,
          label: label || undefined,
          style: edge[2] === "-->" ? ("dashed" as const) : undefined,
          bidirectional: edge[2] === "<->" || undefined,
          tone,
        }),
      );
      return;
    }
    scene.nodes.push(parseNode(line, fail));
  });
  return scene;
}

// ------------------------------------------------------------------ figures

const RANGE = /^(\S+?)\.\.(\S+)$/;
const TONE = /(?:^|\s)!(accent|muted)(?=\s|$)/;
const CHART_TYPES = new Set(["bar", "hbar", "line", "area", "pie", "scatter"]);

/** Figure headers: "plot p: Title", "chart c bar: Sales", "array a = 5 2 8". */
function figureHeader(line: string, fail: (why: string) => never): SceneFigure | undefined {
  const tail = `(?:\\s+in\\s+(${ID}))?\\s*(?::\\s*(.*))?`;
  let m = line.match(new RegExp(`^(plot|seq)\\s+(${ID})${tail}$`));
  if (m) {
    const base = strip({ id: m[2]!, group: m[3], title: m[4]?.trim() || undefined });
    if (m[1] === "plot") {
      const spec: PlotSpec = {
        kind: "plot",
        fns: [],
        curves: [],
        points: [],
        sliders: [],
        areas: [],
        vlines: [],
        hlines: [],
        arrows: [],
      };
      return { ...base, spec };
    }
    const spec: SeqSpec = { kind: "seq", actors: [], items: [] };
    return { ...base, spec };
  }
  m = line.match(new RegExp(`^(${TEMPLATE_KINDS.join("|")})\\s+(${ID})${tail}$`));
  if (m) {
    return {
      ...strip({ id: m[2]!, group: m[3], title: m[4]?.trim() || undefined }),
      spec: emptyTemplate(m[1] as TemplateKind),
    };
  }
  m = line.match(
    new RegExp(
      `^molecule\\s+(${ID})\\s+(\\S+?)(\\s+full)?(?:\\s+in\\s+(${ID}))?\\s*(?::\\s*(.*))?$`,
    ),
  );
  if (m) {
    try {
      parseSmiles(m[2]!);
    } catch (error) {
      if (error instanceof SmilesError) return fail(error.message);
      throw error;
    }
    return {
      ...strip({ id: m[1]!, group: m[4], title: m[5]?.trim() || undefined }),
      spec: { kind: "molecule", smiles: m[2]!, ...(m[3] ? { full: true } : {}) },
    };
  }
  m = line.match(new RegExp(`^map\\s+(${ID})(?:\\s+(?!in\\s)([^\\s:]+))?${tail}$`));
  if (m) {
    const region = m[2] ?? "world";
    if (!regionBox(region))
      return fail(
        `unknown map region "${region}"; use ${Object.keys(MAP_REGIONS).join(", ")}, a country, or west,south,east,north`,
      );
    return {
      ...strip({ id: m[1]!, group: m[3], title: m[4]?.trim() || undefined }),
      spec: emptyMap(region),
    };
  }
  m = line.match(
    new RegExp(`^draw\\s+(${ID})(?:\\s+(\\d+(?:\\.\\d+)?)x(\\d+(?:\\.\\d+)?))?${tail}$`),
  );
  if (m) {
    const [width, height] = [Number(m[2] ?? 100), Number(m[3] ?? 100)];
    if (!(width > 0 && height > 0)) return fail("a drawing needs a size above 0, like 100x60");
    return {
      ...strip({ id: m[1]!, group: m[4], title: m[5]?.trim() || undefined }),
      spec: emptyDraw(width, height),
    };
  }
  m = line.match(new RegExp(`^chart\\s+(${ID})\\s+(\\w+)${tail}$`));
  if (m && CHART_TYPES.has(m[2]!)) {
    const spec: ChartSpec = { kind: "chart", type: m[2] as ChartType, series: [], rows: [] };
    return { ...strip({ id: m[1]!, group: m[3], title: m[4]?.trim() || undefined }), spec };
  }
  m = line.match(
    new RegExp(
      `^(array|list|stack|queue|tree)\\s+(${ID})(?:\\s+in\\s+(${ID}))?\\s*(?::\\s*([^=]*?))?\\s*=\\s*(.*)$`,
    ),
  );
  if (m) {
    const base = strip({ id: m[2]!, group: m[3], title: m[4]?.trim() || undefined });
    if (m[1] === "tree") {
      try {
        return { ...base, spec: { kind: "tree", root: parseTree(m[5]!) } };
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    return { ...base, spec: { kind: m[1] as DataKind, values: parseValues(m[5]!), pointers: [] } };
  }
  return undefined;
}

const SCENE_LINE =
  /^(title|subtitle|dir|group|image|part|plot|seq|chart|array|list|stack|queue|tree|draw|molecule|map|timeline|cycle|pyramid|funnel|venn|matrix|mindmap)\s/;

/** Template entries are free text, so only unmistakable scene lines end the block. */
function endsTemplate(line: string): boolean {
  return (
    SCENE_LINE.test(line) ||
    /^label\s+\S+\s/.test(line) ||
    (/^step\s/.test(line) && line.includes("|")) ||
    /^wire\s/.test(line) ||
    EDGE.test(line)
  );
}

/** One line inside a figure block; false when the line does not belong to it. */
function figureLine(
  fig: SceneFigure,
  line: string,
  scene: CompactScene,
  fail: (why: string) => never,
): boolean {
  const s = fig.spec;
  if (s.kind === "draw") return parseDrawLine(s, line, fail);
  if (s.kind === "template") return !endsTemplate(line) && parseTemplateLine(s, line, fail);
  if (s.kind === "map") return !endsTemplate(line) && parseMapLine(s, line, fail);
  if (s.kind === "molecule") return false;
  const [head, ...rest] = line.split(/\s+/);
  const tail = rest.join(" ");
  const toneOf = (text: string) => {
    const t = text.match(TONE);
    return {
      tone: t?.[1] as "accent" | "muted" | undefined,
      text: t ? text.replace(TONE, " ").trim() : text,
    };
  };
  if (s.kind === "plot") {
    const [main, label] = splitOnce(line, " ~ ");
    const words = main.split(/\s+/);
    const body = words.slice(1).join(" ");
    switch (head) {
      case "x":
      case "y": {
        if (/^=/.test(tail)) break;
        const r = words[1]?.match(RANGE);
        if (!r) return fail(`expected: ${head} <min>..<max> [axis label]`);
        s[head] = { min: r[1]!, max: r[2]! };
        const axis = words.slice(2).join(" ") || undefined;
        if (axis) s[head === "x" ? "xLabel" : "yLabel"] = axis;
        return true;
      }
      case "equal":
        s.equal = true;
        return true;
      case "fn": {
        const { tone, text } = toneOf(body);
        const dashed = /(?:^|\s)--dashed$/.test(text) || undefined;
        s.fns.push(
          strip({ expr: text.replace(/\s--dashed$/, ""), label: label?.trim(), tone, dashed }),
        );
        return true;
      }
      case "curve": {
        const { tone, text } = toneOf(body);
        const tm = text.match(/\s+t\s+(\S+?)\.\.(\S+)$/);
        const exprs = splitTop(tm ? text.slice(0, tm.index) : text);
        if (exprs.length !== 2) return fail("expected: curve <x(t)>, <y(t)> [t <from>..<to>]");
        s.curves.push(
          strip({
            x: exprs[0]!,
            y: exprs[1]!,
            from: tm?.[1] ?? "0",
            to: tm?.[2] ?? "2pi",
            label: label?.trim(),
            tone,
          }),
        );
        return true;
      }
      case "point": {
        const { tone, text } = toneOf(body);
        const p = coords(text);
        if (!p) return fail("expected: point <x>, <y> [label]");
        s.points.push(strip({ x: p.x, y: p.y, label: p.rest || label?.trim() || undefined, tone }));
        return true;
      }
      case "slider": {
        const m = body.match(/^([A-Za-z]\w*)\s+(\S+?)\.\.(\S+?)(?:\s*=\s*(\S+))?$/);
        if (!m) return fail("expected: slider <name> <min>..<max> [= <value>]");
        const num = (v: string) => {
          const n =
            Number(v.replace(/pi$/, "").replace(/^$/, "1")) * (v.endsWith("pi") ? Math.PI : 1);
          if (!Number.isFinite(n)) fail(`"${v}" is not a number`);
          return n;
        };
        const min = num(m[2]!);
        const max = num(m[3]!);
        s.sliders.push({ name: m[1]!, min, max, value: m[4] !== undefined ? num(m[4]) : min });
        return true;
      }
      case "area": {
        const m = body.match(/^(.+?)\s+(\S+?)\.\.(\S+)$/);
        if (!m) return fail("expected: area <f(x)> <from>..<to>");
        s.areas.push(strip({ expr: m[1]!, from: m[2]!, to: m[3]!, label: label?.trim() }));
        return true;
      }
      case "vline":
      case "hline": {
        const target = head === "vline" ? s.vlines : s.hlines;
        target.push(
          strip({
            at: words[1] ?? "0",
            label: words.slice(2).join(" ") || label?.trim() || undefined,
          }),
        );
        return true;
      }
      case "arrow":
      case "vector": {
        const { tone, text } = toneOf(body);
        const [a, b] = text.split("->").map((x) => x.trim());
        const p = a ? coords(a) : undefined;
        const q = b ? coords(b) : undefined;
        if (!p || !q) return fail("expected: arrow <x1>,<y1> -> <x2>,<y2> [label]");
        s.arrows.push(
          strip({
            x1: p.x,
            y1: p.y,
            x2: q.x,
            y2: q.y,
            label: q.rest || label?.trim() || undefined,
            tone: tone === "accent" ? ("accent" as const) : undefined,
          }),
        );
        return true;
      }
    }
    // "y = x^2" and "f(x) = …" are function lines too.
    const fnLine = main.match(/^(?:y|[a-z]\s*\(\s*x\s*\))\s*=\s*(.+)$/);
    if (fnLine) {
      const { tone, text } = toneOf(fnLine[1]!);
      s.fns.push(strip({ expr: text, label: label?.trim(), tone }));
      return true;
    }
    return false;
  }
  if (s.kind === "chart") {
    switch (head) {
      case "series":
        s.series = tail
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        return true;
      case "x":
        s.xLabel = tail;
        return true;
      case "y":
        s.yLabel = tail;
        return true;
      case "unit":
        s.unit = tail;
        return true;
    }
    const { tone, text } = toneOf(line);
    const words = text.split(/\s+/);
    const isNum = (w: string) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(w);
    const num = (w: string) => Number(w.replace(/%$/, ""));
    let values: number[];
    let label: string;
    if (isNum(words[0]!)) {
      let k = 0;
      while (k < words.length && isNum(words[k]!)) k++;
      values = words.slice(0, k).map(num);
      label = words.slice(k).join(" ");
    } else {
      let k = words.length;
      while (k > 0 && isNum(words[k - 1]!)) k--;
      if (k === words.length) return false;
      values = words.slice(k).map(num);
      label = words.slice(0, k).join(" ").replace(/:$/, "");
    }
    s.rows.push(strip({ label, values, tone }));
    return true;
  }
  if (s.kind === "seq") {
    const actor = (id: string) => {
      if (!s.actors.some((a) => a.id === id)) s.actors.push({ id, label: id });
    };
    if (head === "actor" || head === "participant") {
      const m = tail.match(new RegExp(`^(${ID})(?:\\s+(.+))?$`));
      if (!m) return fail("expected: actor <id> [label] [(person)]");
      const person = /\(person\)/.test(m[2] ?? "");
      const label =
        (m[2] ?? m[1]!)
          .replace(/\(person\)/, "")
          .replace(/@\S+/, "")
          .trim() || m[1]!;
      const existing = s.actors.find((a) => a.id === m[1]);
      if (existing) Object.assign(existing, strip({ label, person: person || undefined }));
      else s.actors.push(strip({ id: m[1]!, label, person: person || undefined }));
      return true;
    }
    if (head === "note") {
      const m = tail.match(new RegExp(`^(?:over\\s+)?(${ID}(?:\\s*,\\s*${ID})*)\\s*:?\\s+(.+)$`));
      if (!m) return fail("expected: note <id>[,<id>] <text>");
      const over = m[1]!.split(",").map((x) => x.trim());
      over.forEach(actor);
      s.items.push({ t: "note", over, text: m[2]! });
      return true;
    }
    const msg = line.match(new RegExp(`^(${ID})\\s*(-->|->)\\s*(${ID})(?:\\s*:?\\s+(.*))?$`));
    if (!msg) return false;
    // An edge between nodes of the scene closes the block instead.
    const isNode = (id: string) =>
      scene.nodes.some((n) => n.id === id) || scene.groups.some((g) => g.id === id);
    const isActor = (id: string) => s.actors.some((a) => a.id === id);
    if ((isNode(msg[1]!) && !isActor(msg[1]!)) || (isNode(msg[3]!) && !isActor(msg[3]!)))
      return false;
    actor(msg[1]!);
    actor(msg[3]!);
    const { tone, text } = toneOf(msg[4] ?? "");
    s.items.push(
      strip({
        t: "msg" as const,
        from: msg[1]!,
        to: msg[3]!,
        text,
        dashed: msg[2] === "-->" || undefined,
        tone: tone === "accent" ? ("accent" as const) : undefined,
      }),
    );
    return true;
  }
  if ("pointers" in s && (head === "ptr" || head === "pointer")) {
    const m = tail.match(/^([A-Za-z]\w*)\s+(-?\d+)$/);
    if (!m) return fail("expected: ptr <name> <index>");
    s.pointers.push({ name: m[1]!, at: Number(m[2]) });
    return true;
  }
  return false;
}

/** "(1, 2) label", "1, 2 label" or "a, sin(a)" → x, y and what follows. */
function coords(text: string): { x: string; y: string; rest: string } | undefined {
  let inner = text.trim();
  let rest = "";
  if (inner.startsWith("(")) {
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "(") depth++;
      if (inner[i] === ")" && --depth === 0) {
        rest = inner.slice(i + 1).trim();
        inner = inner.slice(1, i);
        break;
      }
    }
  }
  const parts = splitTop(inner);
  if (parts.length < 2) return undefined;
  let y = parts.slice(1).join(",");
  if (!rest) {
    // "1, 2 label": y ends at the first space outside parentheses.
    let depth = 0;
    for (let i = 0; i < y.length; i++) {
      if (y[i] === "(") depth++;
      if (y[i] === ")") depth--;
      if (y[i] === " " && depth === 0) {
        rest = y.slice(i + 1).trim();
        y = y.slice(0, i);
        break;
      }
    }
  }
  return parts[0] && y ? { x: parts[0], y: y.trim(), rest } : undefined;
}

/**
 * Step targets: ids to highlight, figure parts ("a[2]", "a[1..3]") and
 * assignments ("a=2", "arr=1,5,3", "t=8(3,10)").
 */
function stepTargets(text: string): { highlight: string[]; set: Record<string, string> } {
  const highlight: string[] = [];
  const set: Record<string, string> = {};
  let i = 0;
  const readValue = () => {
    let depth = 0;
    let out = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === "(" || c === "[") depth++;
      if (c === ")" || c === "]") depth--;
      if (/\s/.test(c) && depth <= 0) break;
      out += c;
      i++;
    }
    return out;
  };
  while (i < text.length) {
    if (/[\s,]/.test(text[i]!)) {
      i++;
      continue;
    }
    const assign = /^([A-Za-z][\w-]*)=/.exec(text.slice(i));
    if (assign) {
      i += assign[0].length;
      set[assign[1]!] = readValue().replace(/^\[|\]$/g, "");
      continue;
    }
    let token = "";
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "[") depth++;
      if (c === "]") depth--;
      if ((/\s/.test(c) || c === ",") && depth <= 0) break;
      token += c;
      i++;
    }
    const range = /^([A-Za-z][\w-]*)\[(-?\d+)\.\.(-?\d+)\]$/.exec(token);
    if (range) {
      const [a, b] = [Number(range[2]), Number(range[3])];
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) highlight.push(`${range[1]}[${k}]`);
    } else if (token) highlight.push(token);
  }
  return { highlight, set };
}

function parseNode(line: string, fail: (why: string) => never): CompactScene["nodes"][number] {
  const [main, description] = splitOnce(line, " ~ ");
  const m = main.match(new RegExp(`^(${ID})\\s+(.+)$`));
  if (!m)
    fail(
      "expected a node: <id> <label> [@icon] [(shape)] [in <group>] [!accent|!muted] [~ description]",
    );
  const node: CompactScene["nodes"][number] = { id: m![1]!, label: "" };
  const words: string[] = [];
  const tokens = m![2]!.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("@") && t.length > 1)
      node.icon = t.includes(":") ? t.slice(1) : `lucide:${t.slice(1)}`;
    else if (/^\(\w+\)$/.test(t) && SHAPES.has(t.slice(1, -1)))
      node.shape = t.slice(1, -1) as typeof node.shape;
    else if (t === "!accent" || t === "!muted") node.tone = t.slice(1) as "accent" | "muted";
    else if (t === "in" && tokens[i + 1] && new RegExp(`^${ID}$`).test(tokens[i + 1]!))
      node.group = tokens[++i];
    else if (t.startsWith("file=")) node.file = t.slice(5);
    else words.push(t);
  }
  node.label = words.join(" ");
  if (!node.label) fail("a node needs a label");
  if (description) node.description = description.trim();
  return node;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}

function strip<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}
