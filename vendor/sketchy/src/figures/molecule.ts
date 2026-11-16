import { FIG_FONT, bounds, shift, titlePrims } from "./common.js";
import type { FigureLayout, Ink, MoleculeSpec, Primitive } from "./types.js";

/**
 * Structural formulas from SMILES, the line notation models know well:
 * "CCO" is ethanol, "c1ccccc1" benzene, "CC(=O)O" acetic acid. The model names
 * the molecule; rings, zigzag chains and bond angles are worked out here.
 *
 *   molecule eth CCO : Ethanol
 *   molecule water O full : Water
 */

type Atom = { el: string; aromatic: boolean; h?: number; charge: number };
type Bond = { a: number; b: number; order: number; ring?: true };
export type Molecule = { atoms: Atom[]; bonds: Bond[] };

export class SmilesError extends Error {}

const MAX_ATOMS = 80;
const VALENCE: Record<string, number[]> = {
  B: [3],
  C: [4],
  N: [3, 5],
  O: [2],
  P: [3, 5],
  S: [2, 4, 6],
  F: [1],
  Cl: [1],
  Br: [1],
  I: [1],
};

/** Reads the organic subset, bracket atoms, branches, ring closures and "." parts. */
export function parseSmiles(source: string): Molecule {
  const src = source.trim();
  const atoms: Atom[] = [];
  const bonds: Bond[] = [];
  const branches: number[] = [];
  const rings = new Map<number, { atom: number; order?: number }>();
  let prev = -1;
  let pending: number | undefined;
  const fail = (why: string): never => {
    throw new SmilesError(`SMILES "${src}": ${why}`);
  };
  const defaultOrder = (a: number, b: number) =>
    atoms[a]!.aromatic && atoms[b]!.aromatic ? 1.5 : 1;
  const add = (atom: Atom) => {
    const index = atoms.push(atom) - 1;
    if (index >= MAX_ATOMS) fail(`at most ${MAX_ATOMS} atoms fit a drawing`);
    if (prev >= 0) bonds.push({ a: prev, b: index, order: pending ?? defaultOrder(prev, index) });
    pending = undefined;
    prev = index;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "(") {
      if (prev < 0) fail("a branch needs an atom before it");
      branches.push(prev);
      i++;
    } else if (c === ")") {
      const back = branches.pop();
      if (back === undefined) fail('")" without "("');
      prev = back!;
      pending = undefined;
      i++;
    } else if ("-=#:/\\".includes(c)) {
      pending = c === "=" ? 2 : c === "#" ? 3 : c === ":" ? 1.5 : 1;
      i++;
    } else if (c === ".") {
      prev = -1;
      pending = undefined;
      i++;
    } else if (/[0-9%]/.test(c)) {
      if (prev < 0) fail("a ring number needs an atom before it");
      let number: number;
      if (c === "%") {
        number = Number(src.slice(i + 1, i + 3));
        if (!Number.isInteger(number)) fail("%nn needs two digits");
        i += 3;
      } else {
        number = Number(c);
        i++;
      }
      const open = rings.get(number);
      if (open) {
        if (open.atom === prev) fail("a ring cannot close on its own atom");
        bonds.push({
          a: open.atom,
          b: prev,
          order: pending ?? open.order ?? defaultOrder(open.atom, prev),
          ring: true,
        });
        rings.delete(number);
      } else rings.set(number, { atom: prev, order: pending });
      pending = undefined;
    } else if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) fail('"[" without "]"');
      const body = src.slice(i + 1, end);
      i = end + 1;
      const m = body.match(/^(\d*)([A-Z][a-z]?|[a-z][a-z]?|\*)(@*)(H\d*)?([+-]+\d*)?(?::\d+)?$/);
      if (!m) fail(`cannot read the atom [${body}]`);
      let el = m![2]!;
      const aromatic = el !== "*" && el === el.toLowerCase();
      if (aromatic) el = el[0]!.toUpperCase() + el.slice(1);
      const h = m![4] ? (m![4].length > 1 ? Number(m![4].slice(1)) : 1) : 0;
      let charge = 0;
      if (m![5]) {
        const sign = m![5][0] === "+" ? 1 : -1;
        const digits = m![5].replace(/[+-]/g, "");
        charge = sign * (digits ? Number(digits) : m![5].length);
      }
      add({ el, aromatic, h, charge });
    } else if (src.startsWith("Cl", i) || src.startsWith("Br", i)) {
      add({ el: src.slice(i, i + 2), aromatic: false, charge: 0 });
      i += 2;
    } else if ("BCNOPSFI*".includes(c)) {
      add({ el: c, aromatic: false, charge: 0 });
      i++;
    } else if ("bcnops".includes(c)) {
      add({ el: c.toUpperCase(), aromatic: true, charge: 0 });
      i++;
    } else fail(`unexpected "${c}" at position ${i + 1}`);
  }
  if (!atoms.length) fail("no atoms");
  if (rings.size) fail(`ring ${[...rings.keys()][0]} is never closed`);
  if (branches.length) fail('"(" without ")"');
  return { atoms, bonds };
}

/** Hydrogens an atom carries without writing them: what its usual valence leaves. */
function hydrogens(mol: Molecule, index: number): number {
  const atom = mol.atoms[index]!;
  if (atom.h !== undefined) return atom.h;
  const valences = VALENCE[atom.el];
  if (!valences) return 0;
  const used = mol.bonds.reduce(
    (sum, b) => sum + (b.a === index || b.b === index ? b.order : 0),
    0,
  );
  if (atom.aromatic) return Math.max(0, Math.floor(valences[0]! - used + 0.01));
  const valence = valences.find((v) => v >= used - 0.01) ?? valences[valences.length - 1]!;
  return Math.max(0, Math.round(valence - used));
}

type Pt = [number, number];

/** Rings from the ring-closure bonds: the tree path between the two ends. */
function findRings(mol: Molecule, closures: Bond[]): number[][] {
  const tree = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    tree.set(a, [...(tree.get(a) ?? []), b]);
    tree.set(b, [...(tree.get(b) ?? []), a]);
  };
  for (const b of mol.bonds) if (!closures.includes(b)) link(b.a, b.b);
  const rings: number[][] = [];
  for (const closure of closures) {
    const from = new Map<number, number>([[closure.a, -1]]);
    const queue = [closure.a];
    while (queue.length) {
      const u = queue.shift()!;
      if (u === closure.b) break;
      for (const v of tree.get(u) ?? []) if (!from.has(v)) (from.set(v, u), queue.push(v));
    }
    const path: number[] = [];
    for (let u = closure.b; u !== -1 && u !== undefined; u = from.get(u)!) path.push(u);
    if (path.length >= 3) rings.push(path);
    // Later rings may run through this one's closure.
    link(closure.a, closure.b);
  }
  return rings;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const angleOf = (from: Pt, to: Pt) =>
  (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
const step = (p: Pt, deg: number, length = 1): Pt => [
  p[0] + Math.cos(rad(deg)) * length,
  p[1] + Math.sin(rad(deg)) * length,
];

/** 2D positions with bond length 1, y up. */
export function layoutMolecule(mol: Molecule): { pos: Pt[]; rings: number[][] } {
  const n = mol.atoms.length;
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (const b of mol.bonds) (neighbours[b.a]!.push(b.b), neighbours[b.b]!.push(b.a));
  const closures = mol.bonds.filter((b) => b.ring);
  const rings = findRings(mol, closures);
  const pos: (Pt | undefined)[] = new Array(n);
  const incoming: number[] = new Array(n).fill(30);
  const turn: number[] = new Array(n).fill(1);
  const placedRings = new Set<number>();
  const centre = (ring: number[]): Pt => {
    const pts = ring.map((a) => pos[a]!);
    return [
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ];
  };
  const linear = (a: number) => {
    const orders = mol.bonds.filter((b) => b.a === a || b.b === a).map((b) => b.order);
    return orders.includes(3) || orders.filter((o) => o === 2).length >= 2;
  };

  /** Lays a ring out as a regular polygon from one placed atom or a placed edge. */
  const placeRing = (index: number, queue: number[], seed?: number) => {
    const ring = rings[index]!;
    const k = ring.length;
    const radius = 1 / (2 * Math.sin(Math.PI / k));
    const placed = ring.map((a) => pos[a] !== undefined);
    let start = placed.findIndex((p, i) => p && placed[(i + 1) % k]);
    let c: Pt;
    let first: number;
    if (start >= 0) {
      // Fused: share the edge, sit on the side away from what is drawn already.
      const [p, q] = [pos[ring[start]!]!, pos[ring[(start + 1) % k]!]!];
      const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const others = ring.filter(
        (a, i) => placed[i] && a !== ring[start] && a !== ring[(start + 1) % k],
      );
      const near = rings
        .filter(
          (r, ri) =>
            placedRings.has(ri) && r.includes(ring[start]!) && r.includes(ring[(start + 1) % k]!),
        )
        .map(centre);
      const away = near[0] ?? (others.length ? pos[others[0]!]! : [mid[0] + 1e-3, mid[1]]);
      const normal = angleOf(p, q) + 90;
      const apothem = radius * Math.cos(Math.PI / k);
      const a1 = step(mid, normal, apothem);
      const a2 = step(mid, normal + 180, apothem);
      const d = (x: Pt) => Math.hypot(x[0] - away[0], x[1] - away[1]);
      c = d(a1) > d(a2) ? a1 : a2;
      first = start;
    } else {
      start = placed.findIndex(Boolean);
      const anchor =
        start >= 0 ? ring[start]! : seed !== undefined && ring.includes(seed) ? seed : ring[0]!;
      if (start < 0) {
        pos[anchor] = [0, 0];
        start = ring.indexOf(anchor);
      }
      const at = pos[anchor]!;
      const from = neighbours[anchor]!.filter((v) => pos[v] !== undefined && !ring.includes(v));
      const outward = from.length ? angleOf(pos[from[0]!]!, at) : 90 + 180 / k;
      c = step(at, outward, radius);
      first = start;
    }
    // Walk the ring from the shared atom, in the direction that matches what is placed.
    const base = angleOf(c, pos[ring[first]!]!);
    const next = pos[ring[(first + 1) % k]!];
    const direction =
      next && Math.abs(((angleOf(c, next) - base + 540) % 360) - 180) > 1e-6
        ? Math.sign(((angleOf(c, next) - base + 540) % 360) - 180)
        : 1;
    ring.forEach((atom, i) => {
      if (pos[atom] !== undefined) return;
      const offset = (i - first + k) % k;
      pos[atom] = step(c, base + (direction * 360 * offset) / k, radius);
      queue.push(atom);
    });
    placedRings.add(index);
  };

  let shiftX = 0;
  for (let root = 0; root < n; root++) {
    if (pos[root] !== undefined) continue;
    const queue: number[] = [];
    const ringOfRoot = rings.findIndex((r) => r.includes(root));
    if (ringOfRoot >= 0) placeRing(ringOfRoot, queue, root);
    else pos[root] = [0, 0];
    queue.unshift(root);
    const component: number[] = [];
    while (queue.length) {
      const u = queue.shift()!;
      component.push(u);
      for (let ri = 0; ri < rings.length; ri++)
        if (!placedRings.has(ri) && rings[ri]!.includes(u)) placeRing(ri, queue);
      const fresh = neighbours[u]!.filter((v) => pos[v] === undefined);
      if (!fresh.length) continue;
      const here = pos[u]!;
      const placedAround = neighbours[u]!.filter((v) => pos[v] !== undefined).map((v) =>
        angleOf(here, pos[v]!),
      );
      const inRings = rings.filter((r, ri) => placedRings.has(ri) && r.includes(u));
      let directions: number[];
      if (inRings.length) {
        // Substituents point out of the ring.
        const cs = inRings.map(centre);
        const away = angleOf(
          [
            cs.reduce((s, p) => s + p[0], 0) / cs.length,
            cs.reduce((s, p) => s + p[1], 0) / cs.length,
          ],
          here,
        );
        directions =
          fresh.length === 1
            ? [away]
            : fresh.map((_, i) => away + (i - (fresh.length - 1) / 2) * 60);
      } else if (!placedAround.length) {
        directions = fresh.map((_, i) => 30 + (i * 360) / fresh.length);
      } else if (placedAround.length === 1) {
        const dirIn = incoming[u]!;
        if (fresh.length === 1) directions = [linear(u) ? dirIn : dirIn + 60 * turn[u]!];
        else if (fresh.length === 2) directions = [dirIn + 60 * turn[u]!, dirIn - 60 * turn[u]!];
        else directions = fresh.map((_, i) => dirIn - 90 + (i * 180) / (fresh.length - 1));
      } else {
        // Spread the rest over the widest free gap.
        const sorted = [...placedAround].map((a) => (a + 360) % 360).sort((a, b) => a - b);
        let gapStart = sorted[sorted.length - 1]!;
        let gap = sorted[0]! + 360 - gapStart;
        for (let i = 1; i < sorted.length; i++)
          if (sorted[i]! - sorted[i - 1]! > gap)
            ((gap = sorted[i]! - sorted[i - 1]!), (gapStart = sorted[i - 1]!));
        directions = fresh.map((_, i) => gapStart + (gap * (i + 1)) / (fresh.length + 1));
      }
      fresh.forEach((v, i) => {
        pos[v] = step(here, directions[i]!);
        incoming[v] = directions[i]!;
        turn[v] = -turn[u]!;
        queue.push(v);
      });
    }
    // Chains lie flat: turn the part so its long axis runs across.
    if (!rings.some((r) => component.includes(r[0]!)) && component.length > 1) {
      const mx = component.reduce((s, a) => s + pos[a]![0], 0) / component.length;
      const my = component.reduce((s, a) => s + pos[a]![1], 0) / component.length;
      let [sxx, syy, sxy] = [0, 0, 0];
      for (const a of component) {
        const [dx, dy] = [pos[a]![0] - mx, pos[a]![1] - my];
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
      const angle = -0.5 * Math.atan2(2 * sxy, sxx - syy);
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      for (const a of component) {
        const [dx, dy] = [pos[a]![0] - mx, pos[a]![1] - my];
        pos[a] = [mx + dx * cos - dy * sin, my + dx * sin + dy * cos];
      }
    }
    // Separate parts ("." in SMILES) sit side by side.
    const xs = component.map((a) => pos[a]![0]);
    const dx = shiftX - Math.min(...xs);
    for (const a of component) pos[a] = [pos[a]![0] + dx, pos[a]![1]];
    shiftX = Math.max(...component.map((a) => pos[a]![0])) + 1.6;
  }
  return { pos: pos as Pt[], rings };
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const digits = (n: number, set: string) => String(n).replace(/\d/g, (d) => set[Number(d)]!);
const BOND = 44;
const ATOM_INK: Record<string, Ink> = {
  O: "s2",
  N: "s1",
  S: "s5",
  F: "s3",
  Cl: "s3",
  Br: "s5",
  I: "s4",
  P: "s5",
};

export function layoutMoleculeFigure(
  id: string,
  spec: MoleculeSpec,
  title: string | undefined,
): FigureLayout {
  const mol = parseSmiles(spec.smiles);
  const { pos, rings } = layoutMolecule(mol);
  // Screen coordinates run down.
  const at = pos.map(([x, y]) => [x * BOND, -y * BOND] as Pt);
  const degree = mol.atoms.map((_, i) => mol.bonds.filter((b) => b.a === i || b.b === i).length);
  const shown = mol.atoms.map(
    (a, i) => a.el !== "C" || spec.full || degree[i] === 0 || a.charge !== 0,
  );
  const prims: Primitive[] = [];
  const size = FIG_FONT.value;

  for (const bond of mol.bonds) {
    let [p, q] = [at[bond.a]!, at[bond.b]!];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const u: Pt = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    const normal: Pt = [-u[1], u[0]];
    // Bonds stop short of written atoms.
    const gap = size * 0.62;
    if (shown[bond.a]) p = [p[0] + u[0] * gap, p[1] + u[1] * gap];
    if (shown[bond.b]) q = [q[0] - u[0] * gap, q[1] - u[1] * gap];
    const segment = (offset: number, inset = 0) => {
      const [ox, oy] = [normal[0] * offset, normal[1] * offset];
      const [ix, iy] = [u[0] * inset, u[1] * inset];
      prims.push({
        t: "line",
        x1: p[0] + ox + ix,
        y1: p[1] + oy + iy,
        x2: q[0] + ox - ix,
        y2: q[1] + oy - iy,
        stroke: "ink",
        width: 1.8,
      });
    };
    if (bond.order === 2) {
      const ring = rings.find((r) => r.includes(bond.a) && r.includes(bond.b));
      if (ring) {
        // In a ring the second line runs inside it.
        const c = ring.reduce<Pt>(
          (s, a) => [s[0] + at[a]![0] / ring.length, s[1] + at[a]![1] / ring.length],
          [0, 0],
        );
        const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const side = (c[0] - mid[0]) * normal[0] + (c[1] - mid[1]) * normal[1] > 0 ? 1 : -1;
        segment(0);
        segment(6 * side, length * 0.14);
      } else {
        segment(3);
        segment(-3);
      }
    } else if (bond.order === 3) {
      segment(0);
      segment(4.5);
      segment(-4.5);
    } else segment(0);
  }
  // Aromatic rings carry a circle instead of alternating double bonds.
  for (const ring of rings) {
    const aromatic = ring.every((a, i) => {
      const b = ring[(i + 1) % ring.length]!;
      return mol.bonds.some(
        (x) => ((x.a === a && x.b === b) || (x.a === b && x.b === a)) && x.order === 1.5,
      );
    });
    if (!aromatic) continue;
    const c = ring.reduce<Pt>(
      (s, a) => [s[0] + at[a]![0] / ring.length, s[1] + at[a]![1] / ring.length],
      [0, 0],
    );
    const r = (BOND / (2 * Math.tan(Math.PI / ring.length))) * 0.62;
    prims.push({ t: "ellipse", cx: c[0], cy: c[1], rx: r, ry: r, stroke: "ink", width: 1.5 });
  }
  mol.atoms.forEach((atom, i) => {
    const [x, y] = at[i]!;
    const key = `${id}[${i + 1}]`;
    if (!shown[i]) {
      prims.push({ t: "rect", x: x - 7, y: y - 7, w: 14, h: 14, stroke: "none", key });
      return;
    }
    const h = hydrogens(mol, i);
    const hText = h ? `H${h > 1 ? digits(h, SUB) : ""}` : "";
    const charge = atom.charge
      ? `${Math.abs(atom.charge) > 1 ? digits(Math.abs(atom.charge), SUP) : ""}${atom.charge > 0 ? "⁺" : "⁻"}`
      : "";
    // Hydrogens go on the free side: "HO–" at a left end, "–OH" at a right end.
    const pull = mol.bonds
      .filter((b) => b.a === i || b.b === i)
      .reduce((s, b) => s + at[b.a === i ? b.b : b.a]![0] - x, 0);
    // On its own the usual order holds: H₂O, HCl but NH₃, CH₄.
    const before = degree[i] === 0 ? ["O", "S", "F", "Cl", "Br", "I"].includes(atom.el) : pull > 1;
    const text = before ? `${hText}${atom.el}${charge}` : `${atom.el}${hText}${charge}`;
    prims.push({
      t: "text",
      x,
      y,
      text,
      size,
      anchor: "middle",
      baseline: "middle",
      color: ATOM_INK[atom.el] ?? "ink",
      weight: 600,
      key,
    });
  });

  const titleOut: Primitive[] = [];
  const titleHeight = titlePrims(title, 0, titleOut);
  const box = bounds(prims);
  const pad = 10;
  return {
    width: Math.ceil(Math.max(box.w + pad * 2, titleOut.length ? bounds(titleOut).w : 0)),
    height: Math.ceil(box.h + pad * 2 + titleHeight),
    prims: [...titleOut, ...shift(prims, pad - box.x, titleHeight + pad - box.y)],
  };
}
