import type { SceneFigure } from "../figures/types.js";
import { SceneBuilder, SceneError } from "./builder.js";
import type { Direction, SceneImage } from "./types.js";

/** A whole scene in one value: what the `sketch` tool and the compact syntax produce. */
export type SketchInput = {
  title?: string;
  subtitle?: string;
  direction?: Direction;
  groups?: Parameters<SceneBuilder["addGroup"]>[0][];
  nodes?: Parameters<SceneBuilder["addNode"]>[0][];
  parts?: Parameters<SceneBuilder["addPart"]>[0][];
  figures?: SceneFigure[];
  images?: string[];
  edges?: Parameters<SceneBuilder["addEdge"]>[0][];
  wires?: Parameters<SceneBuilder["connect"]>[0][];
  labels?: Parameters<SceneBuilder["addLabel"]>[0][];
  steps?: Parameters<SceneBuilder["addStep"]>[0][];
};

/**
 * Replaces the builder's scene with `input`, in dependency order: groups
 * before members, elements before the edges, labels and steps naming them.
 */
export async function fillScene(
  builder: SceneBuilder,
  input: SketchInput,
  image?: (id: string) => Promise<SceneImage>,
): Promise<void> {
  builder.reset({ title: input.title, subtitle: input.subtitle, direction: input.direction });
  for (const g of input.groups ?? []) builder.addGroup(g);
  for (const n of input.nodes ?? []) builder.addNode(n);
  for (const p of input.parts ?? []) builder.addPart(p);
  for (const f of input.figures ?? []) builder.addFigure(f);
  for (const imageId of input.images ?? []) {
    if (!image) throw new SceneError("Photo features are not available on this server.");
    builder.addImage(await image(imageId));
  }
  for (const e of input.edges ?? []) builder.addEdge(e);
  for (const w of input.wires ?? []) builder.connect(w);
  for (const l of input.labels ?? []) builder.addLabel(l);
  for (const s of input.steps ?? []) builder.addStep(s);
}
