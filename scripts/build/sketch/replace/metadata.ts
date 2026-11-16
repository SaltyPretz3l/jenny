// Jenny's replacement for upstream src/parts/metadata.ts: circuits are not offered, so no part catalog.
export type PartMeta = { title: string; category: string; keywords: string[] };
export const PART_META: Record<string, PartMeta> = {};
export function partMeta(type: string): PartMeta {
  return { title: type, category: "", keywords: [] };
}
