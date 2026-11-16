// The functions both of Jenny's bundles expose: upstream's own parse, build and layout, unchanged, plus
// Jenny's checking layer (check.ts), which runs on plain data on both sides of the parser.
import { parseCompact } from "@sketchy/src/scene/compact.js";
import { SceneBuilder, SceneError } from "@sketchy/src/scene/builder.js";
import { fillScene, type SketchInput } from "@sketchy/src/scene/fill.js";
import { layoutScene, previousLayout, type PreviousLayout } from "@sketchy/src/layout/index.js";
import type { LaidOutScene } from "@sketchy/src/scene/laid-out.js";
import type { Scene } from "@sketchy/src/scene/types.js";
import { hasIcon } from "./replace/icons";

/** The vendored upstream commit (vendor/sketchy/JENNY_VENDORING.md). */
export const version = "c246cd47";

export type { LaidOutScene, PreviousLayout, Scene, SketchInput };
export { SceneError, hasIcon, previousLayout };
export { prepare, SKETCH_BOUNDS } from "./check";
export { pickPrevious } from "./follow-up";
export type { EarlierDrawing } from "./follow-up";
export type { Counts, Prepared, Problem, RefusedReason } from "./check";

/** Parses the compact line syntax. Permissive: an unrecognised line becomes a node. */
export function parse(source: string): SketchInput {
  return parseCompact(source);
}

/** Builds the scene from parsed input. Strict and all-or-nothing: it throws a SceneError on a bad reference. */
export async function buildScene(parsed: SketchInput): Promise<Scene> {
  const builder = new SceneBuilder(undefined as never);
  await fillScene(builder, parsed);
  return builder.scene;
}

/** Lays a scene out. `previous` seeds a follow-up with the earlier positions. */
export function layout(scene: Scene, previous?: PreviousLayout): Promise<LaidOutScene> {
  if (!previous) return layoutScene(scene, undefined as never, {});
  // The engine looks each id up on `positions`. A node may be named `constructor`, so the map holds ids only.
  const positions: PreviousLayout["positions"] = Object.assign(Object.create(null), previous.positions);
  return layoutScene(scene, undefined as never, { previous: { direction: previous.direction, positions } });
}
