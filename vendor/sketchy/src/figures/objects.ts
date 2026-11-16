/**
 * Ready-made things for free drawings, written in the draw syntax on a
 * canvas from -50 to 50 around their centre. Stored as text so an object is
 * made of the same hand-drawn shapes as everything else.
 */

const round = (n: number) => Math.round(n * 10) / 10;
const polar = (r: number, degrees: number) => {
  const a = (degrees * Math.PI) / 180;
  return `${round(Math.cos(a) * r)},${round(Math.sin(a) * r)}`;
};

function gear(): string[] {
  const teeth = 8;
  const points: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i * 360) / teeth;
    points.push(polar(34, a - 15), polar(46, a - 9), polar(46, a + 9), polar(34, a + 15));
  }
  return [`shape ${points.join(" ")} fill=gray`, "circle 0,0 13 fill=white"];
}

function sun(): string[] {
  const rays = Array.from(
    { length: 8 },
    (_, i) => `line ${polar(30, i * 45)} ${polar(46, i * 45)} width=2`,
  );
  return ["circle 0,0 23 fill=yellow", ...rays];
}

export const OBJECTS: Record<string, string[]> = {
  person: [
    "circle 0,-36 12",
    "line 0,-24 0,14",
    "line 0,-12 -22,4",
    "line 0,-12 22,4",
    "line 0,14 -16,48",
    "line 0,14 16,48",
  ],
  tree: [
    "rect -7,8 14 40 fill=orange",
    "blob 0,-48 30,-30 37,0 18,18 -18,18 -37,0 -30,-30 fill=green",
  ],
  cloud: ["blob -44,12 -34,-12 -14,-16 0,-32 22,-20 32,-8 47,4 36,20 -30,20 fill=white"],
  house: [
    "rect -32,-4 64 50 fill=white",
    "shape -42,-2 0,-42 42,-2 fill=red",
    "rect -9,18 18 28 fill=orange",
    "rect 13,6 12 12 fill=blue",
  ],
  car: [
    "shape -48,12 -48,-6 -30,-8 -14,-26 16,-26 30,-8 48,-4 48,12 fill=red",
    "shape -24,-9 -12,-21 0,-21 0,-9 fill=blue",
    "shape 5,-9 5,-21 15,-21 25,-9 fill=blue",
    "circle -26,14 11 fill=white",
    "circle 26,14 11 fill=white",
  ],
  bike: [
    "circle -30,18 22",
    "circle 30,18 22",
    "line -30,18 -8,-16 20,-16 -2,18 -30,18",
    "line 20,-16 30,18",
    "line -8,-16 -12,-26",
    "line -20,-26 -4,-26",
    "line 20,-16 18,-30 28,-32",
  ],
  gear: gear(),
  sun: sun(),
  bulb: [
    "circle 0,-14 28 fill=yellow",
    "rect -11,14 22 20 fill=gray",
    "line -11,21 11,21",
    "line -11,27 11,27",
    "curve -9,-8 -4,-20 0,-8 4,-20 9,-8",
  ],
  battery: [
    "rect -42,-21 76 42 fill=white",
    "rect 34,-9 8 18 fill=black",
    "rect -37,-16 42 32 fill=green",
  ],
  laptop: [
    "rect -34,-32 68 48 fill=white",
    "rect -28,-26 56 36 fill=blue",
    "shape -42,16 42,16 50,28 -50,28 fill=gray",
  ],
  phone: ["rect -20,-44 40 88 fill=white", "rect -15,-35 30 62 fill=blue", "circle 0,36 3"],
  server: [
    "rect -34,-44 68 26 fill=white",
    "rect -34,-13 68 26 fill=white",
    "rect -34,18 68 26 fill=white",
    "circle 22,-31 3 fill=green",
    "circle 22,0 3 fill=green",
    "circle 22,31 3 fill=green",
    "line -26,-31 4,-31",
    "line -26,0 4,0",
    "line -26,31 4,31",
  ],
  book: ["shape -46,-30 0,-20 0,34 -46,24 fill=white", "shape 46,-30 0,-20 0,34 46,24 fill=white"],
  heart: ["blob 0,44 -40,4 -36,-30 -12,-36 0,-18 12,-36 36,-30 40,4 fill=red"],
  drop: ["blob 0,-46 20,-10 26,18 0,42 -26,18 -20,-10 fill=blue"],
  flame: [
    "blob 0,-48 20,-20 30,10 14,42 -14,42 -30,10 -12,-12 fill=orange",
    "blob 0,-6 12,14 6,38 -6,38 -12,14 fill=yellow",
  ],
  mountain: ["shape -50,40 -14,-30 8,6 24,-16 50,40 fill=gray"],
  flask: [
    "shape -10,-44 10,-44 10,-12 36,40 -36,40 -10,-12 fill=white",
    "shape -22,12 22,12 36,40 -36,40 fill=green",
  ],
  rocket: [
    "shape -14,20 -32,42 -14,36 fill=red",
    "shape 14,20 32,42 14,36 fill=red",
    "blob 0,-48 15,-20 15,36 -15,36 -15,-20 fill=white",
    "circle 0,-10 7 fill=blue",
  ],
  lock: [
    "arc 0,-6 18 0 180 width=3",
    "line -18,-6 -18,4 width=3",
    "line 18,-6 18,4 width=3",
    "rect -27,2 54 40 fill=yellow",
  ],
  key: [
    "circle -28,0 16",
    "line -12,0 44,0 width=2.5",
    "line 32,0 32,12 width=2.5",
    "line 42,0 42,10 width=2.5",
  ],
};
