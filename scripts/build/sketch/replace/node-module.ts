// Shim for node:module. Upstream loads elkjs through createRequire; the bundle carries it instead.
// "sketch-elk-impl" is resolved by the build to the installed elkjs (0.12.1) bundled build.
import elk from "sketch-elk-impl";

export function createRequire() {
  return (id: string): unknown => {
    if (id === "elkjs/lib/elk.bundled.js") return elk;
    throw new Error(`sketch bundle: unexpected require of ${id}`);
  };
}
