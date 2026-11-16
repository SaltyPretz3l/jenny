import type { LaidOutScene } from "../../src/scene/laid-out.js";
import { createAnnotator, describeMarks, type Annotator, type Tool } from "./annotate.js";
import { FONT_CSS } from "./fonts.js";
import { toExcalidraw } from "./excalidraw.js";
import { slug, toPngBase64, toSvgString } from "./export.js";
import { fitText, renderScene, type RenderedScene } from "./render.js";
import { applyStep, drawHighlights } from "./steps.js";
import { el, mathLine } from "./draw.js";
import { layoutLabel, splitMath } from "../../src/math/inline.js";
import { fmtValue } from "../../src/figures/plot.js";
import { INK } from "./palette.js";

/** What the view needs from its surroundings (the MCP host or a dev page). */
export interface Host {
  openLink(url: string): void;
  /**
   * Opens a source file shown in the drawing. Without it, the editor deep link
   * goes to openLink.
   */
  openFile?(file: { path: string; line?: number; link?: string }): void;
  /** Omitted where files cannot be saved; the export buttons are hidden then. */
  download?(file: {
    name: string;
    mimeType: string;
    text?: string;
    base64?: string;
  }): Promise<void>;
  toggleFullscreen?(): void;
  /**
   * Sends the user's question about their marks to the AI, with the marked-up
   * drawing as a PNG where the host accepts images. Omitted where the view
   * cannot post messages; the send box is hidden then.
   */
  ask?(message: { text: string; image?: string }): Promise<boolean>;
}

export function mountScene(root: HTMLElement, scene: LaidOutScene, host: Host): void {
  root.replaceChildren();
  const frame = div("frame");
  const canvas = div("canvas");
  const tooltip = div("tooltip");
  tooltip.hidden = true;
  const rendered = renderScene(scene, FONT_CSS);
  rendered.svg.style.maxWidth = `${scene.width}px`;
  // Wide screens: large scenes scroll sideways rather than shrinking text into illegibility.
  // Phones: fit the whole drawing to the width; a tap opens it fullscreen, where it can be panned.
  const fit = () => {
    const fullscreen = document.documentElement.classList.contains("fullscreen");
    const narrow = window.innerWidth < 600;
    const factor = narrow ? (fullscreen ? 0.75 : 0) : 0.62;
    rendered.svg.style.minWidth = factor ? `${Math.round(scene.width * factor)}px` : "0";
    frame.classList.toggle("tap-zoom", narrow && !fullscreen && Boolean(host.toggleFullscreen));
  };
  canvas.appendChild(rendered.svg);
  const annotator = createAnnotator(rendered.svg, frame);
  frame.append(toolbar(scene, rendered, host, annotator, frame), canvas);
  frame.appendChild(drawbar(scene, rendered, host, annotator, frame));
  const sliders = sliderPanel(scene, rendered);
  if (sliders) frame.appendChild(sliders.panel);
  if (scene.steps.length) frame.appendChild(stepper(scene, rendered, () => sliders?.sync()));
  frame.appendChild(tooltip);
  root.appendChild(frame);

  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("sketchy-context", fit);
  void document.fonts.ready.then(() => fitText(rendered.svg));
  wireInteractions(scene, rendered, host, tooltip, frame);
}

function toolbar(
  scene: LaidOutScene,
  rendered: RenderedScene,
  host: Host,
  annotator: Annotator,
  frame: HTMLElement,
): HTMLElement {
  const bar = div("toolbar");
  bar.append(button("✎ Draw", "Draw on the sketch", () => setDrawing(frame, true)));
  const name = slug(scene.title?.lines.join(" "));
  const download = host.download?.bind(host);
  if (download)
    bar.append(
      button("SVG", "Download as SVG", async () => {
        await download({
          name: `${name}.svg`,
          mimeType: "image/svg+xml",
          text: toSvgString(rendered.svg),
        });
      }),
      button("PNG", "Download as PNG", async () => {
        await download({
          name: `${name}.png`,
          mimeType: "image/png",
          base64: await toPngBase64(rendered.svg),
        });
      }),
      button("Excalidraw", "Download for Excalidraw", async () => {
        await download({
          name: `${name}.excalidraw`,
          mimeType: "application/json",
          text: toExcalidraw(scene, Date.now(), annotator.marks),
        });
      }),
    );
  if (host.toggleFullscreen) {
    bar.append(button("⤢", "Toggle fullscreen", () => host.toggleFullscreen!()));
  }
  return bar;
}

function setDrawing(frame: HTMLElement, on: boolean): void {
  frame.classList.toggle("drawing", on);
  frame.querySelector(".tooltip")?.setAttribute("hidden", "");
  if (!on) frame.querySelector<HTMLInputElement>(".note-input")?.blur();
}

const TOOLS: { tool: Tool; label: string; title: string }[] = [
  { tool: "pen", label: "Pen", title: "Red pen" },
  { tool: "marker", label: "Marker", title: "Highlighter" },
  { tool: "text", label: "Text", title: "Write a note: click where it goes" },
  { tool: "eraser", label: "Eraser", title: "Erase marks: click or drag over them" },
];

/** The drawing tools, shown while drawing mode is on. */
function drawbar(
  scene: LaidOutScene,
  rendered: RenderedScene,
  host: Host,
  annotator: Annotator,
  frame: HTMLElement,
): HTMLElement {
  const bar = div("drawbar");
  const tools = div("drawbar-tools");
  const toolButtons = TOOLS.map(({ tool, label, title }) => {
    const b = button(label, title, () => {
      annotator.tool = tool;
      sync();
    });
    b.dataset.tool = tool;
    return b;
  });
  const undo = button("Undo", "Undo (Ctrl+Z)", () => annotator.undo());
  const clear = button("Clear", "Remove all marks", () => annotator.clear());
  const done = button("Done", "Leave drawing mode", () => setDrawing(frame, false));
  tools.append(...toolButtons, undo, clear, done);
  bar.appendChild(tools);

  let input: HTMLInputElement | undefined;
  let send: HTMLButtonElement | undefined;
  if (host.ask) {
    const form = document.createElement("form");
    form.className = "drawbar-ask";
    input = document.createElement("input");
    input.placeholder = "Ask about your marks…";
    input.addEventListener("keydown", (e) => e.stopPropagation());
    send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Send to AI";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void ask();
    });
    bar.appendChild(form);
  }

  async function ask(): Promise<void> {
    if (!host.ask || !input || !send) return;
    const title = scene.title?.lines.join(" ");
    const summary = describeMarks(scene, annotator.marks);
    const question = input.value.trim() || "Look at what I marked and explain it.";
    const text = [
      `I marked up the Sketchy drawing${title ? ` "${title}"` : ""}.`,
      summary,
      question,
    ]
      .filter(Boolean)
      .join("\n");
    send.disabled = true;
    const image = await toPngBase64(rendered.svg, 1).catch(() => undefined);
    const sent = await host.ask({ text, image });
    send.disabled = false;
    if (sent) {
      input.value = "";
      setDrawing(frame, false);
    }
  }

  function sync(): void {
    for (const b of toolButtons)
      b.setAttribute("aria-pressed", String(b.dataset.tool === annotator.tool));
    frame.dataset.tool = annotator.tool;
    const empty = annotator.marks.length === 0;
    undo.disabled = empty;
    clear.disabled = empty;
    if (send) send.disabled = empty && !input?.value.trim();
  }
  annotator.onChange = sync;
  input?.addEventListener("input", sync);
  document.addEventListener("keydown", (e) => {
    if (!frame.classList.contains("drawing")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      annotator.undo();
    }
    if (e.key === "Escape") setDrawing(frame, false);
  });
  sync();
  return bar;
}

/**
 * Range inputs for every plot slider. Dragging redraws the plot live; a step
 * that sets a slider moves the input with it.
 */
function sliderPanel(
  scene: LaidOutScene,
  rendered: RenderedScene,
): { panel: HTMLElement; sync: () => void } | undefined {
  const rows: { sync: () => void; el: HTMLElement }[] = [];
  for (const view of rendered.figures.values()) {
    const spec = view.fig.spec;
    if (spec.kind !== "plot" && spec.kind !== "draw") continue;
    for (const s of spec.sliders) {
      if (s.hidden) continue;
      const row = div("slider");
      const name = document.createElement("span");
      name.className = "slider-name";
      name.textContent = s.name;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step ?? (s.max - s.min) / 200);
      const value = document.createElement("span");
      value.className = "slider-value";
      const sync = () => {
        const v = view.env()[s.name] ?? s.value;
        input.value = String(v);
        value.textContent = fmtValue(v);
      };
      input.oninput = () => {
        view.setLive(s.name, Number(input.value));
        // The red circles follow what the slider moves.
        if (rendered.step !== undefined) drawHighlights(scene, rendered, rendered.step);
        value.textContent = fmtValue(Number(input.value));
      };
      sync();
      row.append(name, input, value);
      rows.push({ sync, el: row });
    }
  }
  if (!rows.length) return undefined;
  const panel = div("sliders");
  panel.append(...rows.map((r) => r.el));
  return { panel, sync: () => rows.forEach((r) => r.sync()) };
}

/** Text with $math$ as HTML: formulas become small inline SVGs. */
function richText(parent: HTMLElement, content: string, size: number): void {
  for (const part of splitMath(content)) {
    if (!part.math) {
      parent.append(part.text);
      continue;
    }
    const tex = `$${part.text}$`;
    const { width, asc, desc } = layoutLabel(tex, size);
    const w = Math.ceil(width + 2);
    const h = Math.ceil(asc + desc + 2);
    const svg = el("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: "inline-math" });
    svg.style.verticalAlign = `${-Math.round(desc)}px`;
    svg.appendChild(
      mathLine({ x: 1, baseline: asc + 1, text: tex, size, color: INK, anchor: "start" }),
    );
    parent.appendChild(svg);
  }
}

function stepper(
  scene: LaidOutScene,
  rendered: RenderedScene,
  onChange: () => void = () => {},
): HTMLElement {
  const panel = div("stepper");
  const prev = button("‹", "Previous step", () => go(-1));
  const next = button("›", "Next step", () => go(1));
  const body = div("step-body");
  const dots = div("step-dots");
  panel.append(prev, body, next);
  panel.appendChild(dots);
  let index: number | undefined;

  let first = true;
  const show = () => {
    applyStep(scene, rendered, index, !first);
    first = false;
    onChange();
    prev.disabled = index === undefined;
    next.disabled = index === scene.steps.length - 1;
    body.replaceChildren();
    if (index === undefined) {
      const start = document.createElement("button");
      start.className = "start";
      start.textContent = `Walk through ${scene.steps.length} steps  ›`;
      start.onclick = () => go(1);
      body.appendChild(start);
    } else {
      const step = scene.steps[index]!;
      const head = document.createElement("div");
      head.className = "step-title";
      head.innerHTML = `<span class="step-count">${index + 1}/${scene.steps.length}</span>`;
      richText(head, step.title, 16);
      body.appendChild(head);
      if (step.text) {
        const p = document.createElement("p");
        richText(p, step.text, 15);
        body.appendChild(p);
      }
    }
    dots.replaceChildren(
      ...scene.steps.map((_, i) => {
        const dot = document.createElement("button");
        dot.className = `dot${i === index ? " on" : ""}`;
        dot.title = scene.steps[i]!.title;
        dot.onclick = () => {
          index = i;
          show();
        };
        return dot;
      }),
    );
  };
  const go = (delta: number) => {
    const target = (index ?? -1) + delta;
    index = target < 0 ? undefined : Math.min(target, scene.steps.length - 1);
    show();
  };
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "Escape") {
      index = undefined;
      show();
    }
  });
  show();
  return panel;
}

function wireInteractions(
  scene: LaidOutScene,
  rendered: RenderedScene,
  host: Host,
  tooltip: HTMLElement,
  frame: HTMLElement,
): void {
  const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
  const groups = new Map(scene.groups.map((g) => [g.id, g]));
  const wires = new Map(scene.wires.map((w) => [w.id, w]));
  const svg = rendered.svg;

  const show = (html: string, event: MouseEvent) => {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const box = frame.getBoundingClientRect();
    const x = Math.min(event.clientX - box.left + 14, box.width - tooltip.offsetWidth - 8);
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${event.clientY - box.top + 16}px`;
  };
  const hide = () => (tooltip.hidden = true);

  svg.addEventListener("mousemove", (event) => {
    if (frame.classList.contains("drawing")) return;
    const target = event.target as Element;
    const pin = target.closest(".pin");
    if (pin) {
      const signals = pin.getAttribute("data-signals");
      return show(
        `<b>${esc(pin.getAttribute("data-pin") ?? "")}</b>${signals ? `<br>${esc(signals)}` : ""}`,
        event,
      );
    }
    const g = target.closest<SVGGElement>(".element");
    const id = g?.getAttribute("data-id") ?? "";
    const node = nodes.get(id);
    if (node && (node.description || node.file)) {
      return show(
        `<b>${esc(node.label)}</b>` +
          (node.description ? `<br>${esc(node.description)}` : "") +
          (node.file
            ? `<div class="file">${esc(shortPath(node.file))}${node.line ? `:${node.line}` : ""}<br><i>click to open</i></div>`
            : ""),
        event,
      );
    }
    const group = groups.get(id);
    if (group?.description)
      return show(`<b>${esc(group.label)}</b><br>${esc(group.description)}`, event);
    const wire = wires.get(id);
    if (wire) {
      return show(
        `${esc(wire.from.part)}.${esc(wire.from.pin)} → ${esc(wire.to.part)}.${esc(wire.to.pin)}${wire.label ? `<br>${esc(wire.label)}` : ""}`,
        event,
      );
    }
    hide();
  });
  svg.addEventListener("mouseleave", hide);
  svg.addEventListener("click", (event) => {
    if (frame.classList.contains("drawing")) return;
    const target = event.target as Element;
    const credit = target.closest(".attribution");
    if (credit) return host.openLink(credit.getAttribute("data-href") ?? "");
    const id = target.closest(".element")?.getAttribute("data-id");
    const node = id ? nodes.get(id) : undefined;
    if (frame.classList.contains("tap-zoom") && !node?.link && !node?.file)
      return host.toggleFullscreen?.();
    if (node?.file && host.openFile)
      return host.openFile({ path: node.file, line: node.line, link: node.link });
    if (node?.link) host.openLink(node.link);
  });
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

function div(className: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  return d;
}

function button(label: string, title: string, onClick: () => unknown): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = () => void onClick();
  return b;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
