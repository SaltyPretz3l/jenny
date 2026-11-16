import {
  geoBounds,
  geoInterpolate,
  geoMercator,
  geoNaturalEarth1,
  geoPath,
  type GeoProjection,
} from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import world from "world-atlas/countries-110m.json" with { type: "json" };
import { FIG_FONT, bounds, measure, shift, titlePrims } from "./common.js";
import type { FigureLayout, Ink, MapSpec, Primitive } from "./types.js";

/**
 * Maps from Natural Earth country outlines (via world-atlas): the model names
 * a region, the countries to colour and places by latitude and longitude;
 * projection, framing and label spots are worked out here.
 *
 *   map m europe: Where the trains run
 *   Germany !accent ~ Start
 *   France fill=blue
 *   place berlin 52.52,13.40 Berlin
 *   place paris 48.86,2.35 Paris
 *   route berlin -> paris --dashed ~ 8 h by train
 */

type Box = [west: number, south: number, east: number, north: number];

export const MAP_REGIONS: Record<string, Box> = {
  world: [-180, -58, 180, 84],
  europe: [-25, 34, 45, 71],
  africa: [-20, -36, 55, 38],
  asia: [25, -11, 150, 56],
  "middle-east": [24, 11, 64, 43],
  "north-america": [-170, 7, -50, 74],
  "south-america": [-84, -56, -33, 14],
  americas: [-170, -56, -33, 74],
  oceania: [110, -48, 180, 0],
};

const countries = feature(
  world as unknown as Topology,
  (world as unknown as Topology).objects.countries as GeometryCollection,
) as FeatureCollection<Geometry, { name: string }>;

/** "Dem. Rep. Congo" and "democratic republic of the congo" end up alike. */
function normal(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bdem\b\.?/g, "democratic")
    .replace(/\brep\b\.?/g, "republic")
    .replace(/\bis\b\.?/g, "islands")
    .replace(/\beq\b\.?/g, "equatorial")
    .replace(/\bherz\b\.?/g, "herzegovina")
    .replace(/\bfr\b\.?/g, "french")
    .replace(/\bs\b\.?/g, "south")
    .replace(/\bn\b\.?/g, "north")
    .replace(/\bw\b\.?/g, "western")
    .replace(/\b(the|of|and)\b/g, "")
    .replace(/[^a-z]/g, "");
}

const ALIASES: Record<string, string> = {
  usa: "United States of America",
  us: "United States of America",
  unitedstates: "United States of America",
  america: "United States of America",
  uk: "United Kingdom",
  britain: "United Kingdom",
  greatbritain: "United Kingdom",
  england: "United Kingdom",
  czechrepublic: "Czechia",
  ivorycoast: "Côte d'Ivoire",
  swaziland: "eSwatini",
  eswatini: "eSwatini",
  northmacedonia: "Macedonia",
  burma: "Myanmar",
  holland: "Netherlands",
  korea: "South Korea",
  republickorea: "South Korea",
  democraticrepubliccongo: "Dem. Rep. Congo",
  drc: "Dem. Rep. Congo",
  drcongo: "Dem. Rep. Congo",
  republiccongo: "Congo",
  uae: "United Arab Emirates",
  turkiye: "Turkey",
  easttimor: "Timor-Leste",
  westernsahara: "W. Sahara",
  centralafricanrepublic: "Central African Rep.",
  bosnia: "Bosnia and Herz.",
  southsudan: "S. Sudan",
  equatorialguinea: "Eq. Guinea",
  dominicanrepublic: "Dominican Rep.",
  cotedivoire: "Côte d'Ivoire",
};

const BY_NAME = new Map(countries.features.map((f) => [normal(f.properties.name), f]));

/** The country a model means, or undefined. */
export function findCountry(name: string): Feature<Geometry, { name: string }> | undefined {
  const key = normal(name);
  return BY_NAME.get(key) ?? (ALIASES[key] ? BY_NAME.get(normal(ALIASES[key]!)) : undefined);
}

/** A few known names that start like the unknown one, for the error message. */
export function suggestCountries(name: string): string[] {
  const start = normal(name).slice(0, 3);
  return countries.features
    .map((f) => f.properties.name)
    .filter((n) => normal(n).startsWith(start))
    .slice(0, 4);
}

/** A region name, a country, or a box "west,south,east,north". */
export function regionBox(region: string): Box | undefined {
  const preset = MAP_REGIONS[region.toLowerCase()];
  if (preset) return preset;
  const box = region.split(",").map(Number);
  if (box.length === 4 && box.every(Number.isFinite)) return box as Box;
  const country = findCountry(region.replace(/-/g, " "));
  if (!country) return undefined;
  let [[w, s], [e, n]] = geoBounds(country);
  // Countries across the date line (Russia, Fiji) keep their main side.
  if (w > e) e = 180;
  const pad = Math.max(e - w, n - s) * 0.25 + 1;
  return [
    Math.max(-180, w - pad),
    Math.max(-85, s - pad),
    Math.min(180, e + pad),
    Math.min(85, n + pad),
  ];
}

/** Centre of mass of a ring in screen pixels. */
function centroid(ring: Pt[]): Pt {
  let [a, cx, cy] = [0, 0, 0];
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  });
  return a ? [cx / (3 * a), cy / (3 * a)] : ring[0]!;
}

type Pt = [number, number];
const WIDTH = 600;

/** Rings of a geometry in screen pixels, clipped to the frame. */
function rings(projection: GeoProjection, geometry: Geometry | Feature): Pt[][] {
  const out: Pt[][] = [];
  let current: Pt[] = [];
  const context = {
    moveTo(x: number, y: number) {
      if (current.length > 1) out.push(current);
      current = [[x, y]];
    },
    lineTo(x: number, y: number) {
      current.push([x, y]);
    },
    closePath() {
      if (current.length > 1) out.push(current);
      current = [];
    },
    arc() {},
    beginPath() {},
  };
  geoPath(projection, context as unknown as CanvasRenderingContext2D)(geometry as Feature);
  if (current.length > 1) out.push(current);
  return out;
}

const area = (ring: Pt[]) =>
  Math.abs(
    ring.reduce((s, p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;

export function layoutMap(id: string, spec: MapSpec, title: string | undefined): FigureLayout {
  const box = regionBox(spec.region) ?? MAP_REGIONS.world!;
  const [w, s, e, n] = box;
  const frame = {
    type: "MultiPoint" as const,
    coordinates: Array.from({ length: 9 }, (_, i) => w + ((e - w) * i) / 8).flatMap((lon) =>
      Array.from({ length: 9 }, (_, j) => [lon, s + ((n - s) * j) / 8]),
    ),
  };
  const projection = (
    spec.region.toLowerCase() === "world" ? geoNaturalEarth1() : geoMercator()
  ).fitWidth(WIDTH, frame);
  const [[, top], [, bottom]] = geoPath(projection).bounds(frame);
  const height = Math.min(WIDTH * 1.2, Math.ceil(bottom - top));
  projection.clipExtent([
    [0, 0],
    [WIDTH, height],
  ]);

  const prims: Primitive[] = [];
  const chosen = new Map(spec.countries.map((c) => [findCountry(c.name)?.properties.name, c]));
  const labels: { text: string; at: Pt; key?: string; size: number; tone?: "accent" | "muted" }[] =
    [];
  for (const country of countries.features) {
    const pick = chosen.get(country.properties.name);
    const shapes = rings(projection, country).filter((r) => area(r) > (pick ? 1 : 3));
    if (!shapes.length) continue;
    // Steps name a country without spaces: m[United-Kingdom].
    const key = pick ? `${id}[${pick.name.replace(/\s+/g, "-")}]` : undefined;
    for (const points of shapes)
      prims.push({
        t: "poly",
        points: points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as Pt),
        closed: true,
        stroke: pick ? "ink" : "soft",
        width: pick ? 1.4 : 0.9,
        fill: pick ? (pick.fill ?? "s0") : undefined,
        hatch: pick?.hatch || undefined,
        rough: pick ? 0.6 : 0.25,
        ...(key ? { key } : {}),
      });
    if (pick?.label) {
      // The label sits on the country's biggest piece.
      const biggest = shapes.reduce((a, b) => (area(b) > area(a) ? b : a));
      const [cx, cy] = centroid(biggest);
      const w = measure(pick.label, FIG_FONT.small + 1);
      labels.push({ text: pick.label, at: [cx - w / 2, cy], key, size: FIG_FONT.small + 1 });
    }
  }

  for (const place of spec.places) {
    const p = projection([place.lon, place.lat]);
    if (!p) continue;
    const key = place.name ? `${id}[${place.name}]` : undefined;
    const ink: Ink = place.tone === "accent" ? "accent" : place.tone === "muted" ? "muted" : "ink";
    prims.push({
      t: "ellipse",
      cx: p[0],
      cy: p[1],
      rx: 4.5,
      ry: 4.5,
      stroke: ink,
      fill: ink,
      ...(key ? { key } : {}),
    });
    if (place.label)
      labels.push({
        text: place.label,
        at: [p[0] + 8, p[1]],
        key,
        size: FIG_FONT.label,
        tone: place.tone,
      });
  }
  for (const route of spec.routes) {
    const ends = [route.from, route.to] as [number, number][];
    const along = geoInterpolate([ends[0]![1], ends[0]![0]], [ends[1]![1], ends[1]![0]]);
    const points = Array.from({ length: 33 }, (_, i) => projection(along(i / 32)))
      .filter((p): p is Pt => !!p)
      .map(([x, y]) => [x, y] as Pt);
    if (points.length < 2) continue;
    // A slight bow tells a route from a border.
    const [a, b] = [points[0]!, points[points.length - 1]!];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const bowed = points.map(([x, y], i) => {
      const t = i / (points.length - 1);
      const lift = Math.sin(Math.PI * t) * length * 0.12;
      return [x + ((b[1] - a[1]) / length) * lift, y - ((b[0] - a[0]) / length) * lift] as Pt;
    });
    const key = route.name ? `${id}[${route.name}]` : undefined;
    prims.push({
      t: "poly",
      points: bowed,
      stroke: "accent",
      width: 2.2,
      arrow: "end",
      dashed: route.dashed || undefined,
      rough: 0.5,
      ...(key ? { key } : {}),
    });
    if (route.label) {
      // Beside the top of the bow, on its outer side.
      const mid = bowed[Math.floor(bowed.length / 2)]!;
      const out: Pt = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
      const w = measure(route.label, FIG_FONT.small + 1);
      labels.push({
        text: route.label,
        at: [mid[0] + out[0] * 14 - (out[0] < 0 ? w : 0), mid[1] + out[1] * 14],
        key,
        size: FIG_FONT.small + 1,
      });
    }
  }

  // Labels keep out of each other's way and off dots and routes: right, left, above, below.
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  for (const p of prims) {
    if (p.t === "ellipse") taken.push({ x: p.cx - 6, y: p.cy - 6, w: 12, h: 12 });
    if (p.t === "poly" && p.stroke === "accent")
      for (const [x, y] of p.points) taken.push({ x: x - 3, y: y - 3, w: 6, h: 6 });
  }
  for (const label of labels) {
    const w = measure(label.text, label.size);
    const h = label.size * 1.3;
    const centred = label.at;
    const options: Pt[] = [
      [centred[0], centred[1] - h / 2],
      [centred[0] - w - 16, centred[1] - h / 2],
      [centred[0] - w / 2 - 8, centred[1] - h - 10],
      [centred[0] - w / 2 - 8, centred[1] + 10],
      [centred[0], centred[1] - h - 6],
      [centred[0], centred[1] + 6],
      [centred[0] - w - 16, centred[1] - h - 6],
      [centred[0] - w - 16, centred[1] + 6],
    ];
    const free = (x: number, y: number) =>
      !taken.some((t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h);
    const [x, y] = options.find(([x, y]) => free(x, y)) ?? options[0]!;
    taken.push({ x, y, w, h });
    prims.push({
      t: "text",
      x,
      y,
      text: label.text,
      size: label.size,
      baseline: "top",
      color: label.tone === "accent" ? "accent" : "ink",
      weight: label.tone === "accent" ? 700 : 600,
      ...(label.key ? { key: label.key } : {}),
    });
  }

  const titleOut: Primitive[] = [];
  const titleHeight = titlePrims(title, 0, titleOut);
  const frameBox = bounds([{ t: "rect", x: 0, y: 0, w: WIDTH, h: height }, ...prims]);
  return {
    width: Math.ceil(frameBox.w),
    height: Math.ceil(frameBox.h + titleHeight),
    prims: [...titleOut, ...shift(prims, -frameBox.x, titleHeight - frameBox.y)],
  };
}

const MAP_COLORS: Record<string, Ink> = {
  accent: "accent",
  yellow: "s0",
  blue: "s1",
  red: "s2",
  green: "s3",
  purple: "s4",
  orange: "s5",
  gray: "muted",
  grey: "muted",
  white: "card",
};

export const emptyMap = (region: string): MapSpec => ({
  kind: "map",
  region,
  countries: [],
  places: [],
  routes: [],
});

const LATLON = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

/** One line inside a map block: a country, "place …" or "route … -> …". */
export function parseMapLine(spec: MapSpec, line: string, fail: (why: string) => never): boolean {
  const separator = line.indexOf(" ~ ");
  const main = (separator < 0 ? line : line.slice(0, separator)).trim();
  const label = separator < 0 ? undefined : line.slice(separator + 3).trim() || undefined;
  const words = main.split(/\s+/);
  const latlon = (text: string): [number, number] | undefined => {
    const m = text.match(LATLON);
    if (!m) return undefined;
    const [lat, lon] = [Number(m[1]), Number(m[2])];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`"${text}" is no latitude,longitude`);
    return [lat, lon];
  };
  if (words[0] === "place") {
    let rest = words.slice(1);
    const tone = rest.find((w) => w === "!accent" || w === "!muted")?.slice(1) as
      "accent" | "muted" | undefined;
    rest = rest.filter((w) => w !== "!accent" && w !== "!muted");
    const at = rest.findIndex((w) => latlon(w));
    if (at < 0 || at > 1)
      return fail("expected: place [name] <latitude>,<longitude> [label] [!accent]");
    const [lat, lon] = latlon(rest[at]!)!;
    const name = at === 1 ? rest[0] : undefined;
    const text = rest.slice(at + 1).join(" ") || label;
    spec.places.push({
      ...(name ? { name } : {}),
      lat,
      lon,
      ...(text ? { label: text } : {}),
      ...(tone ? { tone } : {}),
    });
    return true;
  }
  if (words[0] === "route") {
    const m = main.match(
      /^route\s+(?:([A-Za-z_][\w-]*):\s*)?(\S+)\s*->\s*(\S+)((?:\s+--dashed)?)$/,
    );
    if (!m)
      return fail(
        "expected: route [name:] <place or lat,lon> -> <place or lat,lon> [--dashed] [~ label]",
      );
    const end = (text: string): [number, number] => {
      const point = latlon(text);
      if (point) return point;
      const place = spec.places.find((p) => p.name === text);
      if (!place)
        return fail(`no place "${text}"; add "place ${text} <lat>,<lon>" before the route`);
      return [place.lat, place.lon];
    };
    spec.routes.push({
      from: end(m[2]!),
      to: end(m[3]!),
      ...(m[1] ? { name: m[1] } : {}),
      ...(label ? { label } : {}),
      ...(m[4] ? { dashed: true } : {}),
    });
    return true;
  }
  let fill: Ink | undefined;
  let hatch = false;
  const nameWords: string[] = [];
  for (const word of words) {
    const option = word.match(/^(fill|hatch)=(\w+)$/);
    if (option) {
      fill = MAP_COLORS[option[2]!];
      if (!fill)
        return fail(`unknown color "${option[2]}"; use ${Object.keys(MAP_COLORS).join(", ")}`);
      hatch = option[1] === "hatch";
    } else if (word === "!accent") fill = "accent";
    else if (word === "!muted") fill = "muted";
    else nameWords.push(word);
  }
  const name = nameWords.join(" ");
  if (!findCountry(name)) {
    const close = suggestCountries(name);
    return fail(
      `unknown country "${name}"${close.length ? `; did you mean ${close.join(", ")}?` : ""} Use English names; mark small places with "place".`,
    );
  }
  spec.countries.push({
    name,
    ...(fill ? { fill } : {}),
    ...(hatch ? { hatch } : {}),
    ...(label ? { label } : {}),
  });
  return true;
}
