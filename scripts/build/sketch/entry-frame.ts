// Jenny's entry for the sandboxed frame (sketch-frame.bundle.js): the core plus the viewer, fonts and
// styles in one script. The bundle's one global is `jennySketch`; this file is its whole surface.
import { FONT_CSS } from "@sketchy/viewer/src/fonts.js";
import { toExcalidraw as upstreamToExcalidraw } from "@sketchy/viewer/src/excalidraw.js";
import { mountScene, type Host } from "@sketchy/viewer/src/scene-view.js";
import styles from "@sketchy/viewer/src/styles.css?inline";
import themeOverride from "./theme-override.css?inline";
import {
  buildScene, layout, prepare,
  type Counts, type LaidOutScene, type PreviousLayout, type Problem, type RefusedReason,
} from "./pipeline";

export { setPalette } from "./replace/palette";
export { buildScene, hasIcon, layout, parse, pickPrevious, prepare, previousLayout, SceneError, SKETCH_BOUNDS, version } from "./pipeline";
// Export of the drawing that is up. The frame script calls these when the page asks (the viewer's own
// export buttons are hidden with its toolbar); marks made in drawing mode are in the SVG and PNG only.
export { slug, toPngBase64, toSvgString } from "@sketchy/viewer/src/export.js";

// Sketchy is credited in Settings > About and NOTICE instead of upstream's watermark on every drawing (owner,
// 2026-11-16; MIT allows it). The vendored files stay unedited: the mark is taken off after upstream draws it.
// The SVG and PNG exports clone the drawn SVG, so removing it from the drawing covers them too.
const WATERMARK_ELEMENT_ID = "sketchy-watermark";

/** Upstream's Excalidraw export without its watermark text element. */
export function toExcalidraw(...args: Parameters<typeof upstreamToExcalidraw>): string {
  const file = JSON.parse(upstreamToExcalidraw(...args)) as { elements: Array<{ id: string }> };
  file.elements = file.elements.filter((element) => element.id !== WATERMARK_ELEMENT_ID);
  return JSON.stringify(file, null, 2);
}

export type RenderOptions = {
  /** Positions of an earlier drawing, so a follow-up keeps its nodes where they were. */
  previous?: PreviousLayout;
  /** Host callbacks for the viewer (openLink, openFile, download, toggleFullscreen, ask). Defaults to a no-op openLink. */
  host?: Partial<Host>;
};

function injectStyles(doc: Document): void {
  if (doc.getElementById("sketch-styles")) return;
  const style = doc.createElement("style");
  style.id = "sketch-styles";
  style.textContent = `${FONT_CSS}\n${styles}\n${themeOverride}`;
  doc.head.appendChild(style);
}

/**
 * What `render` resolves with. A model's mistake never rejects: the drawing is `drawn` (with the problems the
 * checking layer found and repaired), a Mermaid block is handed back, or the source is `refused` with why.
 */
export type RenderResult =
  | { kind: "drawn"; problems: Problem[]; counts: Counts; laidOut: LaidOutScene }
  | { kind: "mermaid"; source: string }
  | { kind: "refused"; reason: RefusedReason; problems: Problem[]; message?: string };

const MESSAGE_MAX = 400;

/**
 * Checks (`prepare`), builds, lays out and draws one source into `container`. A refused or Mermaid source
 * touches nothing. If the builder or the layout still throws for something the checking layer does not cover,
 * the result is `refused` with reason 'error' and the problems found so far. `laidOut`'s positions go through
 * `previousLayout` to become the `previous` of a follow-up.
 */
export async function render(container: HTMLElement, source: string, options: RenderOptions = {}): Promise<RenderResult> {
  const prepared = prepare(source);
  if (prepared.kind !== "scene") return prepared;
  try {
    injectStyles(container.ownerDocument);
    const scene = await buildScene(prepared.input);
    const laidOut = await layout(scene, options.previous);
    mountScene(container, laidOut, { openLink() {}, ...options.host });
    container.querySelectorAll("svg .watermark").forEach((mark) => mark.remove());
    return { kind: "drawn", problems: prepared.problems, counts: prepared.counts, laidOut };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "refused", reason: "error", problems: prepared.problems, message: message.slice(0, MESSAGE_MAX) };
  }
}
